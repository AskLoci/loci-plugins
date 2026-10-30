import { pathToFileURL } from "node:url";
// One client message maps to one local HTTP request. No retries or persistence:
// a failed file-writing or generation request must never be silently repeated.
import { request as httpRequest } from "node:http";
import { readEndpoint, endpointPath } from "./endpoint.mjs";
import { SseReader } from "./sse.mjs";
import {
  ConnectorError,
  VERSION,
  MAX_BYTES,
  META_VERSION,
  META_CLIENT,
  INSTRUCTIONS,
  UNAVAILABLE,
  object,
  own,
  validRequest,
  failure,
  offlineReply,
  setupReport,
  protocolError,
  hasModelTools,
  describeTools,
  headerValue,
} from "./protocol.mjs";

const INVALID_REPLY = "Loci sent an invalid MCP response.";
const TIMEOUT =
  "Loci did not finish this request in time. Check Loci before retrying.";
export class Bridge {
  /**
   * @param {{path?: string, send: (reply: object) => void,
   *   read?: typeof readEndpoint, limits?: {connect?: number, idle?: number,
   *   total?: number, setup?: number, bytes?: number, concurrent?: number}}} options
   */
  constructor({
    path = endpointPath(),
    send,
    read = readEndpoint,
    limits = {},
  }) {
    this.path = path;
    this.send = send;
    this.read = read;
    this.limits = {
      connect: 3000,
      idle: 90000,
      total: 600000,
      setup: 10000,
      bytes: MAX_BYTES,
      concurrent: 64,
      ...limits,
    };
    this.pending = new Map();
    this.active = new Set();
    this.closed = false;
    this.version = undefined;
    this.client = "mcp-client";
    this.catalog = undefined;
  }
  close() {
    this.closed = true;
    for (const entry of this.active) entry.controller.abort();
  }
  emit(message, entry) {
    if (!this.closed && !entry?.controller.signal.aborted) this.send(message);
  }

  async receive(line) {
    if (this.closed || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit(failure(null, -32700, "Parse error"));
      return;
    }
    if (!validRequest(message)) {
      this.emit(failure(null, -32600, "Invalid Request"));
      return;
    }
    const hasId = own(message, "id");
    const key = hasId ? JSON.stringify(message.id) : undefined;
    if (message.method === "notifications/cancelled" && !hasId) {
      this.pending
        .get(JSON.stringify(message.params?.requestId))
        ?.controller.abort();
      return;
    }
    if (hasId && this.pending.has(key)) {
      this.emit(
        failure(message.id, -32600, "This request ID is already in use."),
      );
      return;
    }
    if (this.active.size >= this.limits.concurrent) {
      if (hasId)
        this.emit(
          failure(
            message.id,
            -32000,
            "Too many requests are waiting for Loci.",
          ),
        );
      return;
    }
    const entry = { controller: new AbortController(), answered: false };
    this.active.add(entry);
    if (hasId) this.pending.set(key, entry);
    const info =
      message.method === "initialize"
        ? message.params?.clientInfo
        : message.params?._meta?.[META_CLIENT];
    if (typeof info?.name === "string") {
      const clean = (text) =>
        String(text)
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 80);
      this.client = `${clean(info.name)}/${clean(info.version ?? "unknown")}`;
    }
    try {
      if (
        hasId &&
        message.method === "tools/call" &&
        message.params?.name === "loci_setup"
      ) {
        const error = protocolError(message);
        if (error) this.emit(error, entry);
        else if (
          own(message.params, "arguments") &&
          (!object(message.params.arguments) ||
            Object.keys(message.params.arguments).length)
        ) {
          this.emit(
            failure(message.id, -32602, "loci_setup takes no arguments."),
            entry,
          );
        } else await this.setup(message, entry);
      } else {
        await this.forward(message, entry, (reply) => this.emit(reply, entry));
      }
    } catch (error) {
      if (
        !hasId ||
        entry.answered ||
        entry.controller.signal.aborted ||
        this.closed
      )
        return;
      const reply = offlineReply(message);
      if (reply)
        this.deliver(reply, message, entry, (value) => this.emit(value, entry));
      else
        this.emit(
          failure(
            message.id,
            -32000,
            error instanceof ConnectorError
              ? error.message
              : "The Loci connection failed. Check Loci before retrying.",
          ),
          entry,
        );
    } finally {
      this.active.delete(entry);
      if (hasId && this.pending.get(key) === entry) this.pending.delete(key);
    }
  }

  async setup(message, entry) {
    const before = this.catalog;
    const probe = {
      jsonrpc: "2.0",
      id: message.id,
      method: "tools/list",
      params: {},
    };
    if (message.params?._meta) probe.params._meta = message.params._meta;
    let connected = false,
      detail = UNAVAILABLE;
    const probeEntry = { controller: entry.controller, answered: false };
    try {
      await this.forward(
        probe,
        probeEntry,
        (reply) => {
          if (own(reply, "id")) connected = hasModelTools(reply);
        },
        this.limits.setup,
      );
      detail = connected
        ? "Loci is connected. Call loci_status to check model readiness and any download already in progress."
        : "Loci answered but did not expose its model tools. Open Loci and check for an update.";
    } catch (error) {
      detail = error instanceof ConnectorError ? error.message : UNAVAILABLE;
    }
    if (!connected) this.catalog = undefined;
    this.emit(setupReport(message, connected, detail), entry);
    if (before !== this.catalog)
      this.emit(
        { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
        entry,
      );
  }

  headers(message, endpoint, length) {
    const headers = {
      Authorization: `Bearer ${endpoint.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Content-Length": String(length),
      "User-Agent": `${this.client} loci-connector/${VERSION}`,
    };
    const version = message.params?._meta?.[META_VERSION];
    if (typeof version === "string") {
      headers["MCP-Protocol-Version"] = headerValue(version);
      headers["Mcp-Method"] = headerValue(message.method);
      const name = ["tools/call", "prompts/get"].includes(message.method)
        ? (message.params?.name ?? "")
        : message.method === "resources/read"
          ? message.params?.uri
          : undefined;
      if (typeof name === "string") headers["Mcp-Name"] = headerValue(name);
    } else if (message.method !== "initialize" && this.version)
      headers["MCP-Protocol-Version"] = headerValue(this.version);
    return headers;
  }

  deliver(reply, message, entry, send) {
    if (entry.controller.signal.aborted || this.closed || entry.answered)
      return false;
    if (!object(reply) || reply.jsonrpc !== "2.0")
      throw new ConnectorError(INVALID_REPLY);
    const answer =
      own(message, "id") &&
      own(reply, "id") &&
      reply.id === message.id &&
      !own(reply, "method") &&
      own(reply, "result") !== own(reply, "error");
    const notification =
      !own(reply, "id") &&
      typeof reply.method === "string" &&
      (!own(reply, "params") || object(reply.params));
    if (!answer && !notification)
      throw new ConnectorError("Loci sent a response for a different request.");
    if (
      answer &&
      own(reply, "error") &&
      (!object(reply.error) ||
        !Number.isInteger(reply.error.code) ||
        typeof reply.error.message !== "string")
    )
      throw new ConnectorError(INVALID_REPLY);
    if (
      answer &&
      message.method === "initialize" &&
      typeof reply.result?.protocolVersion === "string"
    )
      this.version = reply.result.protocolVersion;
    if (answer && message.method === "tools/list") {
      if (
        own(reply, "result") &&
        (!object(reply.result) ||
          !Array.isArray(reply.result.tools) ||
          reply.result.tools.some(
            (tool) =>
              !object(tool) ||
              typeof tool.name !== "string" ||
              !object(tool.inputSchema),
          ))
      )
        throw new ConnectorError(INVALID_REPLY);
      this.catalog = hasModelTools(reply)
        ? JSON.stringify(reply.result.tools)
        : undefined;
      describeTools(reply);
    }
    if (
      answer &&
      object(reply.result) &&
      ["initialize", "server/discover"].includes(message.method)
    ) {
      const capabilities = object(reply.result.capabilities)
        ? reply.result.capabilities
        : {};
      reply.result.capabilities = {
        ...capabilities,
        tools: {
          ...(object(capabilities.tools) ? capabilities.tools : {}),
          listChanged: true,
        },
      };
      reply.result.instructions = INSTRUCTIONS;
    }
    send(reply);
    if (answer) entry.answered = true;
    return answer;
  }

  async forward(message, entry, send, duration = this.limits.total) {
    const timed = new AbortController();
    const timer = setTimeout(() => timed.abort(), duration);
    const signal = AbortSignal.any([entry.controller.signal, timed.signal]);
    let request;
    try {
      const endpoint = await this.read(this.path, signal);
      signal.throwIfAborted();
      const body = Buffer.from(JSON.stringify(message));
      if (body.length > this.limits.bytes)
        throw new ConnectorError("The MCP request is too large.");
      // node:http does not follow redirects or read HTTP_PROXY. No pooled sockets.
      const response = await new Promise((resolve, reject) => {
        request = httpRequest(endpoint.url, {
          method: "POST",
          headers: this.headers(message, endpoint, body.length),
          agent: false,
          signal,
        });
        let connectTimer;
        request.once("socket", (socket) => {
          connectTimer = setTimeout(
            () => request.destroy(new ConnectorError(TIMEOUT)),
            this.limits.connect,
          );
          socket.once("connect", () => clearTimeout(connectTimer));
        });
        request.once("close", () => clearTimeout(connectTimer));
        request.setTimeout(this.limits.idle, () =>
          request.destroy(new ConnectorError(TIMEOUT)),
        );
        request.once("error", reject);
        request.once("response", resolve);
        request.end(body);
      });
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400)
        throw new ConnectorError(
          "The Loci connector does not follow redirects.",
        );
      if ([401, 403, 413, 421].includes(status)) {
        const messages = {
          401: "Loci refused its access token. Reopen Loci to refresh the connection.",
          403: "Loci refused the request origin.",
          413: "The request is too large. Send fewer or smaller items.",
          421: "Loci refused the local host address.",
        };
        throw new ConnectorError(messages[status]);
      }
      if (status === 202 && !own(message, "id")) return;
      const parse = (text) => {
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          throw new ConnectorError(INVALID_REPLY);
        }
        return this.deliver(value, message, entry, send);
      };
      const streaming =
        String(response.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase() === "text/event-stream";
      if (streaming) {
        const reader = new SseReader(parse, this.limits.bytes);
        for await (const chunk of response) {
          reader.push(chunk);
          if (entry.answered) return;
        }
        reader.push(new Uint8Array(), true);
      } else {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > this.limits.bytes)
            throw new ConnectorError("Loci’s reply is too large.");
          chunks.push(chunk);
        }
        if (bytes) {
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            );
          } catch {
            throw new ConnectorError(INVALID_REPLY);
          }
          parse(text);
        }
      }
      if (!entry.answered && own(message, "id"))
        throw new ConnectorError(
          "Loci ended the connection without answering.",
        );
      if (status < 200 || status >= 300) {
        if (!entry.answered)
          throw new ConnectorError("Loci could not complete this request.");
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(timed.signal.aborted ? TIMEOUT : UNAVAILABLE);
    } finally {
      clearTimeout(timer);
      request?.destroy();
    }
  }
}

if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { fixture, waitUntil, ask } = await import("./testing.mjs");
  const { writeFile, chmod } = await import("node:fs/promises");
  test("missing app, damaged settings and new tools recover without restarting", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      for (const bad of [
        "PRIVATE_BROKEN",
        JSON.stringify({
          pid: process.pid,
          token: "PRIVATE_TOKEN",
          mcp_url: f.url,
        }),
        JSON.stringify({ pid: 0xffffffff, token: f.token, mcp_url: f.url }),
      ]) {
        await writeFile(f.path, bad, { mode: 0o600 });
        const listed = await ask(bridge, replies, "tools/list");
        assert.deepEqual(
          listed.result.tools.map((tool) => tool.name),
          ["loci_setup"],
        );
        assert.equal(
          (await ask(bridge, replies, "tools/call", { name: "loci_setup" }))
            .result.structuredContent.connected,
          false,
        );
        assert.equal(
          (await ask(bridge, replies, "tools/call", { name: "loci_generate" }))
            .error.code,
          -32000,
        );
        assert.equal(JSON.stringify(replies).includes("PRIVATE"), false);
      }
      assert.equal(f.requests.length, 0);
      await f.write();
      assert.equal(
        (await ask(bridge, replies, "tools/call", { name: "loci_setup" }))
          .result.structuredContent.connected,
        true,
      );
      assert.equal(replies.at(-1).method, "notifications/tools/list_changed");
      f.tools.push({
        name: "loci_future",
        description: "Preserve me",
        inputSchema: { type: "object", required: ["cursor"] },
      });
      assert.equal(
        (await ask(bridge, replies, "tools/call", { name: "loci_setup" }))
          .result.structuredContent.connected,
        true,
      );
      const listed = await ask(bridge, replies, "tools/list");
      assert.deepEqual(
        listed.result.tools.find((tool) => tool.name === "loci_future"),
        f.tools.at(-1),
      );
      await chmod(f.path, 0o644);
      const count = f.requests.length;
      assert.equal(
        (await ask(bridge, replies, "tools/call", { name: "loci_setup" }))
          .result.structuredContent.connected,
        false,
      );
      assert.equal(f.requests.length, count);
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("negotiation, all current tools, Unicode and progress retain exact payloads", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      await ask(bridge, replies, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "claude", version: "1.2" },
      });
      await bridge.receive(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      );
      for (const tool of f.tools) {
        const payload = {
          name: tool.name,
          arguments: { prompt: "café 🍐", cursor: "next", mode: "stream" },
          _meta: { progressToken: "progress" },
        };
        const reply = await ask(bridge, replies, "tools/call", payload);
        assert.deepEqual(reply.result.structuredContent, payload.arguments);
        assert.deepEqual(f.requests.at(-1).message.params, payload);
        assert.equal(
          f.requests.at(-1).headers["mcp-protocol-version"],
          "2025-06-18",
        );
        assert.match(
          f.requests.at(-1).headers["user-agent"],
          /claude\/12 loci-connector/,
        );
      }
      await ask(bridge, replies, "tools/call", {
        name: "loci_generate",
        _meta: { [META_VERSION]: "2026-07-28" },
      });
      assert.equal(f.requests.at(-1).headers["mcp-method"], "tools/call");
      assert.equal(f.requests.at(-1).headers["mcp-name"], "loci_generate");
      assert.ok(
        replies.some((value) => value.method === "notifications/progress"),
      );
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("redirects, errors, invalid replies, size limits, timeouts and truncated streams never retry", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
      limits: { bytes: 2048, idle: 80, total: 600, setup: 600 },
    });
    try {
      await f.write();
      for (const mode of [
        "redirect",
        "auth",
        "bad-json",
        "wrong-id",
        "double-result",
        "oversized",
        "oversized-sse",
        "truncated",
        "hang",
        "heartbeat",
      ]) {
        const count = f.requests.length;
        const reply = await ask(bridge, replies, "tools/call", {
          name: "loci_generate",
          arguments: { mode },
        });
        assert.equal(reply.error?.code, -32000, mode);
        assert.equal(f.requests.length, count + 1, mode);
        assert.equal(JSON.stringify(reply).includes("PRIVATE"), false);
      }
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("cancellation, EOF, duplicate IDs, concurrency and retained-open result streams", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
      limits: { concurrent: 1 },
    });
    try {
      await f.write();
      const held = bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "held",
          method: "tools/call",
          params: { name: "loci_generate", arguments: { mode: "hang" } },
        }),
      );
      await waitUntil(() => f.requests.length === 1);
      await bridge.receive(
        JSON.stringify({ jsonrpc: "2.0", id: "held", method: "ping" }),
      );
      assert.equal(replies.at(-1).error.code, -32600);
      await bridge.receive(
        JSON.stringify({ jsonrpc: "2.0", id: "full", method: "ping" }),
      );
      assert.equal(replies.at(-1).error.code, -32000);
      await bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "held" },
        }),
      );
      await held;
      await waitUntil(() => f.closed.length === 1);
      assert.equal(replies.filter((reply) => reply.id === "held").length, 1);
      const answer = await ask(bridge, replies, "tools/call", {
        name: "loci_generate",
        arguments: { mode: "keep-open" },
      });
      assert.ok(answer.result);
      await waitUntil(() => f.closed.length === 2);
      const final = bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "eof",
          method: "tools/call",
          params: { name: "loci_generate", arguments: { mode: "hang" } },
        }),
      );
      await waitUntil(() => f.requests.length === 3);
      bridge.close();
      await final;
      await waitUntil(() => f.closed.length === 3);
      assert.equal(
        replies.some((reply) => reply.id === "eof"),
        false,
      );
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("rotated address/token is reread and setup validates its arguments", async () => {
    const f = await fixture();
    const second = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      await ask(bridge, replies, "tools/list");
      second.token = "b".repeat(64);
      await second.write(f.path);
      await ask(bridge, replies, "tools/call", { name: "loci_status" });
      assert.equal(
        second.requests.at(-1).headers.authorization,
        `Bearer ${second.token}`,
      );
      for (const args of [null, [], { prompt: "PRIVATE" }])
        assert.equal(
          (
            await ask(bridge, replies, "tools/call", {
              name: "loci_setup",
              arguments: args,
            })
          ).error.code,
          -32602,
        );
      assert.equal(
        (
          await ask(bridge, replies, "tools/call", {
            name: "loci_setup",
            _meta: { [META_VERSION]: "bad" },
          })
        ).error.code,
        -32022,
      );
      assert.equal(JSON.stringify(replies).includes("PRIVATE"), false);
    } finally {
      bridge.close();
      await f.close();
      await second.close();
    }
  });
  test("download states, batch partial failures and application errors are preserved", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      for (const state of [
        "queued",
        "downloading",
        "stalled",
        "paused",
        "installing",
        "failed",
        "ready",
      ]) {
        f.result = {
          content: [{ type: "text", text: state }],
          structuredContent: {
            state,
            downloaded_bytes: 4321,
            total_bytes: null,
            progress: null,
          },
          isError: state === "failed",
        };
        assert.deepEqual(
          (await ask(bridge, replies, "tools/call", { name: "loci_pull" }))
            .result,
          f.result,
        );
      }
      f.result = {
        content: [{ type: "text", text: "partial" }],
        structuredContent: {
          items: [
            { index: 0, result: "ok" },
            { index: 1, error: "Not enough memory" },
          ],
          next_cursor: "next",
        },
        isError: false,
      };
      assert.deepEqual(
        (await ask(bridge, replies, "tools/call", { name: "loci_map" })).result,
        f.result,
      );
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("cancellation while inspecting sends no token and proxy settings are ignored", async () => {
    const f = await fixture();
    const replies = [];
    const previous = process.env.HTTP_PROXY;
    let inspecting = false;
    const bridge = new Bridge({
      path: f.path,
      send: (value) => replies.push(value),
      read: async (path, signal) => {
        inspecting = true;
        await new Promise((resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    });
    try {
      await f.write();
      const pending = bridge.receive(
        '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      );
      await waitUntil(() => inspecting);
      await bridge.receive(
        '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}',
      );
      await pending;
      assert.equal(f.requests.length, 0);
      assert.equal(replies.length, 0);
      process.env.HTTP_PROXY = "http://127.0.0.1:1";
      const direct = new Bridge({
        path: f.path,
        read: f.read,
        send: (value) => replies.push(value),
      });
      try {
        assert.ok(
          (await ask(direct, replies, "tools/call", { name: "loci_status" }))
            .result,
        );
      } finally {
        direct.close();
      }
    } finally {
      if (previous === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previous;
      bridge.close();
      await f.close();
    }
  });
}
