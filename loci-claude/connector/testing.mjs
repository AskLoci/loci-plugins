// Synthetic local service for connector boundary tests; never reads user data.
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CORE_TOOLS } from "./protocol.mjs";
import { readEndpoint, verifyInspection } from "./endpoint.mjs";

export async function waitUntil(predicate) {
  const until = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Test condition did not complete");
    await delay(10);
  }
}
let nextId = 1;
export async function ask(bridge, replies, method, params = {}) {
  const id = nextId++;
  await bridge.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return replies.find((reply) => reply.id === id);
}
export async function fixture(host = "127.0.0.1") {
  const directory = await mkdtemp(join(tmpdir(), "loci-readable-test-"));
  const f = {
    path: join(directory, "agent-api.json"),
    token: "a".repeat(64),
    requests: [],
    closed: [],
    tools: [
      ...CORE_TOOLS,
      "loci_files",
      "loci_extract",
      "loci_choose",
      "loci_index",
      "loci_search",
      "loci_transcribe",
    ].map((name) => ({
      name,
      description: "Synthetic test tool.",
      inputSchema: { type: "object" },
    })),
  };
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      f.requests.push({ message, headers: req.headers });
      if (f.respond && (await f.respond(message, req, res))) return;
      const answer = (result) => ({ jsonrpc: "2.0", id: message.id, result });
      const json = (value) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const mode = message.params?.arguments?.mode;
      if (
        req.headers.authorization !== `Bearer ${f.token}` ||
        mode === "auth"
      ) {
        res.writeHead(401);
        res.end("PRIVATE_TOKEN");
        return;
      }
      if (mode === "redirect") {
        res.writeHead(302, { Location: "http://127.0.0.1:1/private" });
        res.end();
        return;
      }
      if (!Object.hasOwn(message, "id")) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (mode === "bad-json") {
        res.end("PRIVATE_BAD_JSON");
        return;
      }
      if (mode === "wrong-id") {
        json({ ...answer({}), id: "wrong" });
        return;
      }
      if (mode === "double-result") {
        json({ ...answer({}), error: { code: 1, message: "invalid" } });
        return;
      }
      if (mode === "oversized") {
        res.end("x".repeat(4096));
        return;
      }
      if (
        [
          "hang",
          "heartbeat",
          "truncated",
          "oversized-sse",
          "stream",
          "keep-open",
        ].includes(mode)
      ) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": keepalive\n\n");
        res.once("close", () => f.closed.push(message.id));
        if (mode === "hang") return;
        if (mode === "heartbeat") {
          const timer = setInterval(() => res.write(": keepalive\n\n"), 20);
          res.once("close", () => clearInterval(timer));
          return;
        }
        if (mode === "truncated") {
          res.end();
          return;
        }
        if (mode === "oversized-sse") {
          res.end("data: " + "x".repeat(4096));
          return;
        }
        const progress = {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: message.params?._meta?.progressToken ?? "test",
            progress: 1,
          },
        };
        const content = answer({
          content: [{ type: "text", text: "café 🍐" }],
          structuredContent: message.params.arguments,
        });
        const bytes = Buffer.from(
          `data: ${JSON.stringify(progress)}\r\n\r\ndata: ${JSON.stringify(content)}\r\n\r\n`,
        );
        for (let i = 0; i < bytes.length; i += 3)
          res.write(bytes.subarray(i, i + 3));
        if (mode !== "keep-open") res.end();
        return;
      }
      if (message.method === "initialize")
        json(
          answer({
            protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "loci", version: "test" },
          }),
        );
      else if (message.method === "tools/list")
        json(answer({ tools: f.tools }));
      else
        json(
          answer(
            f.result ?? {
              content: [{ type: "text", text: "Test answer" }],
              structuredContent: { ready: true },
            },
          ),
        );
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  f.url = `http://${host === "::1" ? "[::1]" : host}:${server.address().port}/mcp`;
  // Mock the OS inspection in unit tests, keeping file validation and the full
  // HTTP boundary real. Separate endpoint/CLI tests run the system inspector.
  f.read = (path, signal) =>
    readEndpoint(path, signal, async (endpoint, uid) => {
      const address = `${endpoint.url.hostname}:${endpoint.url.port || "80"}`;
      const record = `p${process.pid}\0u${process.getuid()}\0\nf9\0t${host === "::1" ? "IPv6" : "IPv4"}\0n${address}\0TST=LISTEN\0\n`;
      verifyInspection(endpoint, uid, 0, Buffer.from(record));
    });
  f.write = async (path = f.path) =>
    writeFile(
      path,
      JSON.stringify({ mcp_url: f.url, token: f.token, pid: process.pid }),
      { mode: 0o600 },
    );
  f.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  return f;
}
