// Newline-delimited JSON-RPC only on stdout. Bound both unfinished input and
// queued output; cancel active local work on EOF, a broken pipe or termination.
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Bridge } from "./bridge.mjs";
import {
  ConnectorError,
  VERSION,
  MAX_BYTES,
  hasModelTools,
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

export async function check({ deadlineMs = 15000, ...options } = {}) {
  const replies = [];
  const bridge = new Bridge({
    ...options,
    send: (reply) => replies.push(reply),
  });
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ConnectorError(
            "Loci did not finish its connection check in time. Check Agent Access in the intended Loci app before trying again.",
            "connection_failed",
          ),
        ),
      deadlineMs,
    );
  });
  const work = async () => {
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
        method: "tools/call",
        params: { name: "loci_setup", arguments: {} },
      }),
    );
    const setup = replies.find((reply) => reply.id === 2)?.result
      ?.structuredContent;
    if (!setup?.connected)
      throw new ConnectorError(
        setup?.message ??
          "Loci’s connection could not be checked. Open the intended Loci app and check Agent Access.",
      );
    await bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      }),
    );
    const listed = replies.find((reply) => reply.id === 3);
    if (!hasModelTools(listed))
      throw new ConnectorError(
        "Loci’s tools changed during the connection check. Check Agent Access in the intended Loci app and try again.",
      );
    return `Connected to Loci with connector ${VERSION}. Available tools: ${listed.result.tools.map((tool) => tool.name).join(", ")}`;
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    bridge.close();
  }
}

async function main(args, nodeVersion = process.versions.node) {
  if (Number(nodeVersion.split(".")[0]) < 22)
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
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
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
    test("manifest launches bundled JavaScript directly from a path with spaces", async () => {
      const { mkdtemp, cp, readFile, mkdir, symlink, rm } = await import(
        "node:fs/promises"
      );
      const { tmpdir } = await import("node:os");
      const { join, dirname } = await import("node:path");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const directory = await mkdtemp(
        join(tmpdir(), "Loci Plugin With Spaces Café "),
      );
      const source = dirname(dirname(fileURLToPath(import.meta.url)));
      const root = join(directory, "plugin");
      const bin = join(directory, "bin");
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      try {
        await cp(source, root, { recursive: true });
        await mkdir(bin);
        await symlink(process.execPath, join(bin, "node"));
        const manifest = JSON.parse(
          await readFile(join(root, ".mcp.json"), "utf8"),
        );
        const server = manifest.mcpServers.loci;
        assert.deepEqual(server, {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/connector/stdio.mjs"],
        });
        const plugin = JSON.parse(
          await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"),
        );
        const marketplace = JSON.parse(
          await readFile(
            join(source, "../.claude-plugin/marketplace.json"),
            "utf8",
          ),
        );
        assert.equal(plugin.version, VERSION);
        assert.equal(
          marketplace.plugins.find((plugin) => plugin.name === "loci").version,
          VERSION,
        );
        const args = server.args.map((arg) =>
          arg.replace("${CLAUDE_PLUGIN_ROOT}", root),
        );
        assert.deepEqual(args, [join(root, "connector/stdio.mjs")]);
        assert.equal(
          (
            await run(server.command, [...args, "--version"], {
              env: { ...env, PATH: bin },
              timeout: 10000,
            })
          ).stdout.trim(),
          VERSION,
        );
        await assert.rejects(
          run(server.command, args, {
            env: { ...env, PATH: join(directory, "missing") },
            timeout: 10000,
          }),
          (error) => error.code === "ENOENT",
        );
        for (const path of ["README.md", "skills/setup/SKILL.md"]) {
          const guidance = await readFile(join(root, path), "utf8");
          assert.match(guidance, /ENOENT/);
          assert.match(guidance, /node --version/);
          assert.match(guidance, /PATH/);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    test("unsupported Node fails before MCP work with secret-safe runtime guidance", async () => {
      for (const version of ["18.20.8", "20.20.0", "21.7.3"]) {
        await assert.rejects(
          main(["PRIVATE_ARGUMENT"], version),
          (error) => {
            assert.ok(error instanceof ConnectorError);
            assert.match(error.message, /Node.js 22 or later/);
            assert.match(error.message, /https:\/\/nodejs.org/);
            assert.match(error.message, /restart Claude Code/);
            assert.doesNotMatch(error.message, /PRIVATE_ARGUMENT/);
            return true;
          },
        );
      }
    });
    test("output overflow and termination cancel active requests and remove listeners", async () => {
      const f = await fixture();
      await f.write();
      f.result = {
        content: [{ type: "text", text: "x".repeat(6 * 1024 * 1024) }],
      };
      const input = new PassThrough();
      const output = new Writable({
        highWaterMark: 1,
        write(chunk, encoding, callback) {},
      });
      const task = serve(input, output, { path: f.path, read: f.read });
      const rejected = assert.rejects(task, /not reading replies/);
      try {
        for (let id = 0; id < 5; id++)
          input.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "loci_generate" },
            }) + "\n",
          );
        await rejected;
        assert.equal(input.listenerCount("data"), 0);
        assert.equal(output.listenerCount("drain"), 0);
      } finally {
        input.end();
        output.destroy();
        await f.close();
      }
      for (const before of [false, true]) {
        const controller = new AbortController();
        if (before) controller.abort();
        const input = new PassThrough(),
          output = new PassThrough();
        const task = serve(input, output, {
          path: "/nonexistent",
          signal: controller.signal,
        });
        if (!before) controller.abort();
        await task;
        assert.equal(input.listenerCount("data"), 0);
        assert.equal(output.listenerCount("error"), 0);
      }
    });
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
    test("the whole connection check bounds initialization and both tool checks without retries", { timeout: 5000 }, async (context) => {
      for (const blockedId of [1, 2, 3]) {
        const f = await fixture();
        let reachedResolve, closedResolve;
        const reached = new Promise((resolve) => {
          reachedResolve = resolve;
        });
        const closed = new Promise((resolve) => {
          closedResolve = resolve;
        });
        try {
          f.respond = (message, request, response) => {
            if (message.id !== blockedId) return false;
            response.once("close", closedResolve);
            reachedResolve();
            return true;
          };
          context.mock.timers.enable({ apis: ["setTimeout"] });
          const pending = assert.rejects(
            check({
              path: f.path,
              read: async () => ({
                url: new URL(f.url),
                token: f.token,
                pid: process.pid,
              }),
              deadlineMs: 1000,
              limits: { total: 5000, idle: 5000, setup: 5000 },
            }),
            (error) =>
              error instanceof ConnectorError &&
              error.connectionState === "connection_failed" &&
              /connection check in time/.test(error.message) &&
              !error.message.includes(f.token),
          );
          await reached;
          context.mock.timers.tick(1000);
          await pending;
          await closed;
          assert.deepEqual(
            f.requests.map(({ message }) => message.method),
            blockedId === 1
              ? ["initialize"]
              : [
                  "initialize",
                  "notifications/initialized",
                  ...Array(blockedId - 1).fill("tools/list"),
                ],
          );
        } finally {
          context.mock.timers.reset();
          await f.close();
        }
      }
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
        f.token = "b".repeat(64);
        const refused = await run(["--check"]);
        assert.equal(refused.code, 1);
        assert.equal(refused.stdout, "");
        assert.match(refused.stderr, /Agent Access off and on/);
        assert.equal(refused.stderr.includes(f.token), false);
        await f.write();
        assert.equal((await run(["--check"])).code, 0);
      } finally {
        await f.close();
      }
    });
  }
}
