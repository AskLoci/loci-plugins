// Newline-delimited JSON-RPC only on stdout. Bound both unfinished input and
// queued output; cancel active local work on EOF, a broken pipe or termination.
import { pathToFileURL, fileURLToPath } from "node:url";
import { Bridge } from "./bridge.mjs";
import {
  ConnectorError,
  VERSION,
  MAX_BYTES,
  hasModelTools,
  DOWNLOAD,
} from "./protocol.mjs";

export async function serve(input, output, options = {}) {
  let queued = [],
    queuedBytes = 0,
    blocked = false,
    ended = false;
  let chunks = [],
    inputBytes = 0;
  const active = new Set();
  let rejectRun, resolveRun;
  const done = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  const bridge = new Bridge({
    ...options,
    send: (message) => {
      if (ended) return;
      const line = JSON.stringify(message) + "\n";
      if (queuedBytes + Buffer.byteLength(line) > MAX_BYTES * 2) {
        stop(new ConnectorError("The MCP client is not reading replies."));
        return;
      }
      queued.push(line);
      queuedBytes += Buffer.byteLength(line);
      flush();
    },
  });
  function flush() {
    while (!blocked && queued.length && !ended) {
      const line = queued.shift();
      queuedBytes -= Buffer.byteLength(line);
      blocked = !output.write(line);
    }
  }
  function stop(error) {
    if (ended) return;
    ended = true;
    bridge.close();
    input.pause();
    chunks = [];
    queued = [];
    queuedBytes = 0;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onInputError);
    output.off("drain", onDrain);
    output.off("error", onOutputError);
    output.off("close", onOutputClose);
    options.signal?.removeEventListener("abort", onAbort);
    Promise.allSettled([...active]).then(() =>
      error ? rejectRun(error) : resolveRun(),
    );
  }
  function line(bytes) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConnectorError("The MCP client sent invalid UTF-8.");
    }
    const task = bridge.receive(text);
    active.add(task);
    task.then(
      () => active.delete(task),
      () => {
        active.delete(task);
        stop(new ConnectorError("The MCP connection failed."));
      },
    );
  }
  function onData(chunk) {
    try {
      let start = 0;
      for (let i = 0; i < chunk.length && !ended; i++) {
        if (chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i);
        inputBytes += part.length;
        if (inputBytes > MAX_BYTES)
          throw new ConnectorError("The MCP request is too large.");
        chunks.push(part);
        line(Buffer.concat(chunks, inputBytes));
        chunks = [];
        inputBytes = 0;
        start = i + 1;
      }
      if (ended) return;
      if (start < chunk.length) {
        const part = chunk.subarray(start);
        chunks.push(part);
        inputBytes += part.length;
      }
      if (inputBytes > MAX_BYTES)
        throw new ConnectorError("The MCP request is too large.");
    } catch (error) {
      stop(
        error instanceof ConnectorError
          ? error
          : new ConnectorError("Cannot read MCP client input."),
      );
    }
  }
  const onEnd = () => stop(); // Partial lines at EOF are not valid stdio messages.
  const onInputError = () =>
    stop(new ConnectorError("Cannot read MCP client input."));
  const onOutputError = () => stop();
  const onOutputClose = () => stop();
  const onDrain = () => {
    blocked = false;
    flush();
  };
  const onAbort = () => stop();
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onInputError);
  output.on("drain", onDrain);
  output.once("error", onOutputError);
  output.once("close", onOutputClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) stop();
  return done;
}

export async function check(options = {}) {
  const replies = [];
  const bridge = new Bridge({
    ...options,
    send: (reply) => replies.push(reply),
  });
  try {
    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "loci-connector-check", version: VERSION },
        },
      }),
    );
    await bridge.receive(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );
    const listed = replies.find((reply) => reply.id === 2);
    if (!hasModelTools(listed))
      throw new ConnectorError(
        `Loci is not connected or needs an update. Download Loci from ${DOWNLOAD}, open it, and enable Settings → Advanced → Agent Access.`,
      );
    return `Connected to Loci. Available tools: ${listed.result.tools.map((tool) => tool.name).join(", ")}`;
  } finally {
    bridge.close();
  }
}

async function main(args) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new ConnectorError(
      "Loci requires Node.js 22 or later. Install an LTS version from https://nodejs.org and restart Claude Code.",
    );
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(
      "Loci local MCP connector\nUsage: node stdio.mjs [--check | --version | --help]\nSetup: https://askloci.ai/agents/\n",
    );
    return;
  }
  if (args.length === 1 && args[0] === "--check") {
    process.stdout.write((await check()) + "\n");
    return;
  }
  if (args.length) throw new ConnectorError("Unknown arguments. Use --help.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await serve(process.stdin, process.stdout, { signal: controller.signal });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  if (!process.env.NODE_TEST_CONTEXT) {
    try {
      await main(process.argv.slice(2));
    } catch (error) {
      process.stderr.write(
        (error instanceof ConnectorError
          ? error.message
          : "The Loci connector could not start. Check the connection and try again.") +
          "\n",
      );
      process.exitCode = 1;
    }
  } else {
    const { test } = await import("node:test");
    const { default: assert } = await import("node:assert/strict");
    const { PassThrough, Writable } = await import("node:stream");
    const { spawn } = await import("node:child_process");
    const { fixture, waitUntil } = await import("./testing.mjs");
    test("stdio handles malformed lines, fragmented UTF-8 and EOF cancellation", async () => {
      const f = await fixture();
      await f.write();
      const input = new PassThrough();
      const output = new PassThrough();
      let text = "";
      output.on("data", (chunk) => {
        text += chunk;
      });
      const task = serve(input, output, { path: f.path, read: f.read });
      try {
        input.write("bad\n{}\n");
        await waitUntil(() => text.split("\n").length >= 3);
        const errors = text.trim().split("\n").map(JSON.parse);
        assert.deepEqual(
          errors.map((reply) => reply.error.code),
          [-32700, -32600],
        );
        const message = Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "café",
            method: "tools/call",
            params: { name: "loci_generate", arguments: { mode: "hang" } },
          }) + "\n",
        );
        for (const byte of message) input.write(Buffer.from([byte]));
        await waitUntil(() => f.requests.length === 1);
        input.end();
        await task;
        await waitUntil(() => f.closed.length === 1);
        assert.equal(text.includes("café"), false);
      } finally {
        input.end();
        await task;
        await f.close();
      }
    });
    test("oversized unterminated input and invalid UTF-8 stop without leaking input", async () => {
      for (const inputBytes of [
        Buffer.alloc(MAX_BYTES + 1, 120),
        Buffer.from([255, 10]),
      ]) {
        const input = new PassThrough();
        const output = new PassThrough();
        const task = serve(input, output, { path: "/nonexistent" });
        input.write(inputBytes);
        await assert.rejects(task, ConnectorError);
      }
    });
    test("output backpressure drains in order and broken output cancels local work", async () => {
      const input = new PassThrough();
      const replies = [];
      const output = new Writable({
        highWaterMark: 1,
        write(chunk, encoding, callback) {
          replies.push(JSON.parse(chunk));
          setTimeout(callback, 5);
        },
      });
      const task = serve(input, output, { path: "/nonexistent" });
      input.write("bad\n{}\nbad\n");
      await waitUntil(() => replies.length === 3);
      assert.deepEqual(
        replies.map((reply) => reply.error.code),
        [-32700, -32600, -32700],
      );
      output.destroy();
      await task;
    });
    test("real CLI exits, keeps stdout protocol-only and distinguishes offline --check", async () => {
      const f = await fixture();
      const run = (args, data) =>
        new Promise((resolve, reject) => {
          const env = { ...process.env, LOCI_AGENT_API_FILE: f.path };
          delete env.NODE_TEST_CONTEXT;
          const child = spawn(
            process.execPath,
            [fileURLToPath(import.meta.url), ...args],
            { env, stdio: ["pipe", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("CLI timed out"));
          }, 20000);
          child.on("error", reject);
          child.stdout.on("data", (part) => {
            stdout += part;
          });
          child.stderr.on("data", (part) => {
            stderr += part;
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
          if (data) {
            child.stdin.write(data);
            child.stdout.once("data", () => child.stdin.end());
          } else child.stdin.end();
        });
      try {
        assert.equal((await run(["--version"])).stdout.trim(), VERSION);
        const offline = await run(["--check"]);
        assert.equal(offline.code, 1);
        assert.equal(offline.stdout, "");
        const unknown = await run(["PRIVATE_ARGUMENT"]);
        assert.equal(unknown.code, 1);
        assert.equal(unknown.stderr.includes("PRIVATE"), false);
        const setup = await run(
          [],
          '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        );
        assert.equal(
          JSON.parse(setup.stdout).result.tools[0].name,
          "loci_setup",
        );
        assert.equal(setup.stderr, "");
        await f.write();
        const connected = await run(["--check"]);
        assert.equal(connected.code, 0);
        assert.match(connected.stdout, /loci_transcribe/);
      } finally {
        await f.close();
      }
    });
  }
}
