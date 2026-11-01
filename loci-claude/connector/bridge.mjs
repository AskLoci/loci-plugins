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
  AUTHENTICATION_FAILED,
  INCOMPATIBLE_APP,
  CONNECTION_FAILED,
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
// setTimeout runs any longer delay, Infinity included, after 1 ms.
const bounded = (ms) => Math.min(ms, 2 ** 31 - 1);
// Answered without waiting behind model work; their own cap keeps them bounded.
const CONTROL = new Set(["initialize", "ping", "server/discover", "tools/list"]);
const BUSY = "Too many requests are waiting for Loci.";
export class Bridge {
  /**
   * @param {{path?: string, send: (reply: object) => void,
   *   read?: typeof readEndpoint, limits?: {connect?: number, idle?: number,
   *   total?: number, work?: number, setup?: number, bytes?: number,
   *   concurrent?: number, waiting?: number, waitingBytes?: number,
   *   control?: number}}} options
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
      work: 86400000,
      setup: 10000,
      bytes: MAX_BYTES,
      concurrent: 64,
      waiting: 1024,
      waitingBytes: 4 * MAX_BYTES,
      control: 64,
      ...limits,
    };
    this.pending = new Map();
    this.active = new Set();
    this.running = 0;
    this.controls = 0;
    this.waiting = [];
    this.waitingBytes = 0;
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
    const work =
      hasId &&
      !CONTROL.has(message.method) &&
      !(message.method === "tools/call" && message.params?.name === "loci_setup");
    const bytes = Buffer.byteLength(line);
    const full = work
      ? this.running >= this.limits.concurrent &&
        (this.waiting.length >= this.limits.waiting ||
          this.waitingBytes + bytes > this.limits.waitingBytes)
      : this.controls >= this.limits.control;
    if (full) {
      if (hasId) this.emit(failure(message.id, -32000, BUSY));
      return;
    }
    if (!work) this.controls++;
    let slot = false;
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
          .replace(/[^a-z0-9._-]/gi, "")
          .slice(0, 80);
      this.client = `${clean(info.name)}/${clean(info.version ?? "unknown")}`;
    }
    try {
      if (work) {
        slot = await this.acquire(entry, bytes);
        if (!slot || entry.controller.signal.aborted || this.closed) return;
      }
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
      if (!work) this.controls--;
      else if (slot) this.release();
      this.active.delete(entry);
      if (hasId && this.pending.get(key) === entry) this.pending.delete(key);
    }
  }

  /** Waits in arrival order for a model-work slot; false if cancelled first. */
  acquire(entry, bytes) {
    if (this.running < this.limits.concurrent) {
      this.running++;
      return true;
    }
    const signal = entry.controller.signal;
    if (signal.aborted) return false;
    return new Promise((resolve) => {
      const waiter = {
        bytes,
        grant: () => {
          signal.removeEventListener("abort", leave);
          resolve(true);
        },
      };
      const leave = () => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        this.waitingBytes -= bytes;
        resolve(false);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.waiting.push(waiter);
      this.waitingBytes += bytes;
    });
  }
  /** Hands a finished request's slot straight to the oldest waiter. */
  release() {
    const next = this.waiting.shift();
    if (!next) {
      this.running--;
      return;
    }
    this.waitingBytes -= next.bytes;
    next.grant();
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
      detail = UNAVAILABLE,
      connectionState = "unavailable";
    let answer;
    const probeEntry = { controller: entry.controller, answered: false };
    try {
      await this.forward(
        probe,
        probeEntry,
        (reply) => {
          if (own(reply, "id") && reply.id === probe.id) answer = reply;
        },
        this.limits.setup,
      );
      connected = hasModelTools(answer);
      const failed = !answer || own(answer, "error");
      detail = connected
        ? "Loci is connected. Call loci_status to check model readiness and any download or model check already in progress."
        : failed ? CONNECTION_FAILED : INCOMPATIBLE_APP;
      connectionState = connected
        ? "connected" : failed ? "connection_failed" : "incompatible_app";
    } catch (error) {
      detail =
        error instanceof ConnectorError ? error.message : CONNECTION_FAILED;
      connectionState =
        error instanceof ConnectorError
          ? error.connectionState
          : "connection_failed";
    }
    if (!connected) this.catalog = undefined;
    this.emit(setupReport(message, connected, detail, connectionState), entry);
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
      !own(reply, "result") &&
      !own(reply, "error") &&
      typeof reply.method === "string" &&
      (!own(reply, "params") || object(reply.params));
    if (!answer && !notification)
      throw new ConnectorError("Loci sent a response for a different request.");
    if (answer && own(reply, "result") && !object(reply.result))
      throw new ConnectorError(INVALID_REPLY);
    if (answer && own(reply, "result") && message.method === "tools/call") {
      const value = reply.result;
      if (
        !Array.isArray(value.content) ||
        value.content.some(
          (item) =>
            !object(item) ||
            typeof item.type !== "string" ||
            (item.type === "text" && typeof item.text !== "string"),
        ) ||
        (own(value, "isError") && typeof value.isError !== "boolean") ||
        (own(value, "structuredContent") && !object(value.structuredContent))
      )
        throw new ConnectorError(INVALID_REPLY);
    }
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

  async forward(
    message,
    entry,
    send,
    duration = message.method === "tools/call"
      ? this.limits.work
      : this.limits.total,
  ) {
    const timed = new AbortController();
    const timer = setTimeout(() => timed.abort(), bounded(duration));
    const signal = AbortSignal.any([entry.controller.signal, timed.signal]);
    let request,
      stalled = false;
    const expire = () => {
      stalled = true;
      request.destroy(new ConnectorError(TIMEOUT));
    };
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
          connectTimer = setTimeout(expire, bounded(this.limits.connect));
          socket.once("connect", () => clearTimeout(connectTimer));
        });
        request.once("close", () => clearTimeout(connectTimer));
        request.setTimeout(bounded(this.limits.idle), expire);
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
          401: AUTHENTICATION_FAILED,
          403: "Loci refused the request origin.",
          413: "The request is too large. Send fewer or smaller items.",
          421: "Loci refused the local host address.",
        };
        throw new ConnectorError(
          messages[status],
          status === 401 ? "authentication_failed" : "connection_failed",
        );
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
      if (stalled) throw new ConnectorError(TIMEOUT);
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        timed.signal.aborted ? TIMEOUT : CONNECTION_FAILED,
      );
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
  test("setup distinguishes missing, damaged, stale and refused connections and recovers without retries", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    const setup = async () =>
      (await ask(bridge, replies, "tools/call", { name: "loci_setup" })).result
        .structuredContent;
    try {
      let report = await setup();
      assert.equal(report.connection_state, "unavailable");
      assert.equal(report.next_step, "install_or_open_loci");
      assert.equal(report.connector_version, VERSION);
      await writeFile(f.path, "PRIVATE_BROKEN", { mode: 0o600 });
      report = await setup();
      assert.equal(report.connection_state, "invalid_connection");
      assert.equal(report.next_step, "repair_loci_connection");
      await writeFile(
        f.path,
        JSON.stringify({ pid: 0xffffffff, token: f.token, mcp_url: f.url }),
      );
      report = await setup();
      assert.equal(report.connection_state, "stale_connection");
      assert.equal(report.next_step, "check_loci_connection");
      assert.equal(f.requests.length, 0);
      await f.write();
      f.token = "b".repeat(64);
      report = await setup();
      assert.equal(report.connected, false);
      assert.equal(report.connection_state, "authentication_failed");
      assert.equal(report.next_step, "repair_loci_connection");
      assert.equal(f.requests.length, 1);
      await f.write();
      report = await setup();
      assert.equal(report.connected, true);
      assert.equal(report.connection_state, "connected");
      assert.equal(report.next_step, "check_models");
      f.tools.length = 0;
      report = await setup();
      assert.equal(report.connection_state, "incompatible_app");
      assert.equal(report.next_step, "update_loci");
      for (const status of [200, 503]) {
        f.respond = (message, req, res) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            error: { code: -32603, message: "PRIVATE_TRANSIENT_ERROR" } }));
          return true;
        };
        report = await setup();
        assert.equal(report.connected, false);
        assert.equal(report.connection_state, "connection_failed");
        assert.equal(report.next_step, "check_loci_connection");
      }
      assert.equal(JSON.stringify(replies).includes("PRIVATE"), false);
      assert.equal(JSON.stringify(replies).includes(f.token), false);
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("real IPv6 listener and future content types preserve the app response", async () => {
    const f = await fixture("::1");
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      f.result = {
        content: [
          { type: "text", text: "résumé" },
          { type: "image", mimeType: "image/png", data: "AA==" },
          {
            type: "resource_link",
            uri: "file:///synthetic.txt",
            name: "synthetic",
          },
          { type: "future-extension", value: { keep: true } },
        ],
        structuredContent: { items: [null, false, 0, "", { nested: [1, 2] }] },
        _meta: { trace: "preserved" },
        isError: false,
      };
      assert.deepEqual(
        (await ask(bridge, replies, "tools/call", { name: "loci_future" }))
          .result,
        f.result,
      );
      assert.equal(f.requests.length, 1);
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("optional model checks pass through without inventing readiness or starting work", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      const states = [
        { ready: true, models: { installed: [], downloading: [] } },
        { ready: false, models: { installed: [], checking: ["pending"] } },
        { ready: true, models: { installed: [], checking: ["pending", "active"] } },
        { ready: true, models: { installed: [{ id: "active" }], checking: ["active"] } },
        { ready: true, models: { installed: [{ id: "active" }], checking: [] } },
        { ready: true, models: { installed: [], checking: [] } },
      ];
      for (const status of states) {
        f.result = {
          content: [{ type: "text", text: JSON.stringify(status) }],
          structuredContent: status,
          isError: false,
        };
        assert.deepEqual(
          (await ask(bridge, replies, "tools/call", { name: "loci_status" })).result,
          f.result,
        );
      }
      assert.equal(f.requests.length, states.length);
      assert.ok(f.requests.every(({ message }) => message.params.name === "loci_status"));
    } finally {
      bridge.close();
      await f.close();
    }
  });

  test("invalid result envelopes fail safely and the next valid call recovers", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      for (const result of [
        null,
        [],
        "PRIVATE_INVALID",
        42,
        {},
        { content: "PRIVATE_INVALID" },
        { content: [null] },
        { content: [{ type: "text", text: 42 }] },
        { content: [], isError: "false" },
        { content: [], structuredContent: [] },
      ]) {
        f.result = result;
        f.respond = (message, req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          return true;
        };
        const reply = await ask(bridge, replies, "tools/call", {
          name: "loci_status",
        });
        assert.equal(reply.error?.code, -32000, JSON.stringify(result));
        assert.equal(JSON.stringify(reply).includes("PRIVATE"), false);
      }
      f.respond = undefined;
      f.result = undefined;
      assert.ok(
        (await ask(bridge, replies, "tools/call", { name: "loci_status" }))
          .result,
      );
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("SSE priming, interrupted final events and invalid notifications", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      for (const mode of ["primed", "unfinished", "bad-notification"]) {
        f.respond = (message, req, res) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (mode === "primed") res.write("id: 1\ndata:\n\n");
          if (mode === "bad-notification")
            res.write(
              'data: {"jsonrpc":"2.0","method":"notifications/progress","result":{}}\n\n',
            );
          res.end(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [] } })}${mode === "unfinished" ? "\n" : "\n\n"}`,
          );
          return true;
        };
        const reply = await ask(bridge, replies, "tools/call", {
          name: "loci_generate",
        });
        if (mode === "primed") assert.ok(reply.result, mode);
        else assert.equal(reply.error?.code, -32000, mode);
      }
      assert.equal(
        replies.some((r) => r.method && r.result),
        false,
      );
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("simultaneous requests retain IDs and release every slot across repeated bursts", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
    });
    try {
      await f.write();
      f.respond = async (message, req, res) => {
        await new Promise((resolve) =>
          setTimeout(resolve, (message.id % 7) * 2),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: String(message.id) }] },
          }),
        );
        return true;
      };
      for (let round = 0; round < 10; round++) {
        const results = await Promise.all(
          Array.from({ length: 64 }, () =>
            ask(bridge, replies, "tools/call", { name: "loci_generate" }),
          ),
        );
        for (const reply of results)
          assert.equal(reply.result.content[0].text, String(reply.id));
        assert.equal(bridge.pending.size, 0);
        assert.equal(bridge.active.size, 0);
      }
      assert.equal(new Set(replies.map((r) => r.id)).size, 640);
      assert.equal(f.requests.length, 640);
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("each HTTP refusal, reset and invalid byte sequence fails once without credentials in errors", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
      limits: { idle: 100, total: 1000 },
    });
    try {
      await f.write();
      for (const mode of [
        301,
        307,
        308,
        401,
        403,
        413,
        421,
        429,
        500,
        503,
        "reset",
        "utf8",
        "empty",
        "error-shape",
      ]) {
        f.respond = (message, req, res) => {
          if (mode === "reset") res.destroy();
          else if (mode === "utf8") res.end(Buffer.from([255]));
          else if (mode === "empty") res.end();
          else if (mode === "error-shape")
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: "PRIVATE", message: 42 },
              }),
            );
          else {
            res.writeHead(mode);
            res.end("PRIVATE_TOKEN");
          }
          return true;
        };
        const count = f.requests.length;
        const reply = await ask(bridge, replies, "tools/call", {
          name: "loci_generate",
        });
        assert.equal(reply.error?.code, -32000, String(mode));
        assert.equal(f.requests.length, count + 1);
        assert.equal(JSON.stringify(reply).includes("PRIVATE"), false);
      }
    } finally {
      bridge.close();
      await f.close();
    }
  });
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
          /claude\/1\.2 loci-connector/,
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
      limits: { bytes: 2048, idle: 80, total: 600, work: 600, setup: 600 },
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
        if (["hang", "heartbeat"].includes(mode))
          assert.equal(reply.error.message, TIMEOUT, mode);
        assert.equal(f.requests.length, count + 1, mode);
        assert.equal(JSON.stringify(reply).includes("PRIVATE"), false);
      }
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("a reply that stops after it starts reports the timeout, not a connection failure", async () => {
    const f = await fixture();
    const replies = [];
    const send = (value) => replies.push(value);
    const quick = new Bridge({
      path: f.path,
      read: f.read,
      send,
      limits: { idle: 100 },
    });
    const steady = new Bridge({ path: f.path, read: f.read, send });
    const generate = async (bridge, respond) => {
      f.respond = respond;
      return (
        await ask(bridge, replies, "tools/call", {
          name: "loci_generate",
          arguments: { mode: "hang" },
        })
      ).error?.message;
    };
    const started = (res, type = "text/event-stream") =>
      res.writeHead(200, { "Content-Type": type });
    try {
      await f.write();
      assert.equal(await generate(quick, undefined), TIMEOUT);
      assert.equal(
        await generate(quick, (message, req, res) => {
          started(res, "application/json");
          res.write("{");
          return true;
        }),
        TIMEOUT,
      );
      assert.equal(await generate(quick, () => true), TIMEOUT);
      assert.equal(
        await generate(steady, (message, req, res) => {
          started(res);
          res.write(": keepalive\n\n", () => res.destroy());
          return true;
        }),
        CONNECTION_FAILED,
      );
      f.respond = (message, req, res) => {
        started(res);
        res.write(": keepalive\n\n");
        return true;
      };
      const report = (
        await ask(quick, replies, "tools/call", { name: "loci_setup" })
      ).result.structuredContent;
      assert.equal(report.connected, false);
      assert.equal(report.message, TIMEOUT);
      assert.equal(report.connection_state, "connection_failed");
      assert.equal(report.next_step, "check_loci_connection");
      assert.equal(f.requests.length, 5);
      assert.equal(JSON.stringify(replies).includes(f.token), false);
    } finally {
      quick.close();
      steady.close();
      await f.close();
    }
  });
  test("a tool call outlives the total limit, ends at one limit for the whole call that events do not extend, and still ends on cancellation or close", { timeout: 30000 }, async () => {
    const f = await fixture();
    const replies = [];
    const send = (value) => replies.push(value);
    const steady = new Bridge({
      path: f.path,
      read: f.read,
      send,
      limits: { total: 1000, setup: 1500 },
    });
    const brief = new Bridge({
      path: f.path,
      read: f.read,
      send,
      limits: { total: 1000, work: 2000 },
    });
    const timed = async (bridge, method, params) => {
      const started = Date.now();
      const reply = await ask(bridge, replies, method, params);
      return { reply, ms: Date.now() - started };
    };
    const generate = (bridge, mode) =>
      timed(bridge, "tools/call", {
        name: "loci_generate",
        arguments: { mode },
      });
    // Timers count from the event loop's cached clock, which can trail
    // Date.now() a little, and a loaded machine can fire them late.
    const near = (ms, limit) =>
      assert.ok(
        ms > limit - 200 && ms < limit + 4000,
        `${ms} ms for ${limit} ms`,
      );
    try {
      await f.write();
      f.respond = (message, req, res) => {
        const mode = message.params?.arguments?.mode;
        if (message.method !== "tools/call") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const timer = setInterval(() => res.write(": keep-alive\n\n"), 20);
          res.once("close", () => clearInterval(timer));
          return true;
        }
        if (!["progress", "endless"].includes(mode)) return false;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        let sent = 0;
        const timer = setInterval(() => {
          const progress = {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: mode, progress: ++sent },
          };
          res.write(`data: ${JSON.stringify(progress)}\n\n`);
          if (mode === "endless" || sent < 60) return;
          clearInterval(timer);
          const result = { content: [{ type: "text", text: "done" }] };
          res.end(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
          );
        }, 50);
        res.once("close", () => {
          clearInterval(timer);
          f.closed.push(message.id);
        });
        return true;
      };
      assert.ok(
        (await ask(steady, replies, "tools/call", { name: "loci_status" }))
          .result,
      );
      const [progress, endless, heartbeat, prompt, setup] = await Promise.all([
        generate(steady, "progress"),
        generate(brief, "endless"),
        generate(brief, "heartbeat"),
        timed(steady, "prompts/get", { name: "summary" }),
        timed(steady, "tools/call", { name: "loci_setup" }),
      ]);
      assert.equal(progress.reply.result?.content[0].text, "done");
      assert.ok(progress.ms >= 3000, String(progress.ms));
      for (const { reply, ms } of [endless, heartbeat]) {
        assert.equal(reply.error?.message, TIMEOUT);
        near(ms, 2000);
        await waitUntil(() => f.closed.includes(reply.id));
      }
      assert.ok(
        replies.some((value) => value.params?.progressToken === "endless"),
      );
      assert.equal(prompt.reply.error?.message, TIMEOUT);
      near(prompt.ms, 1000);
      assert.equal(setup.reply.result?.structuredContent.connected, false);
      assert.equal(setup.reply.result.structuredContent.message, TIMEOUT);
      near(setup.ms, 1500);
      for (const [id, end] of [
        [
          "cancelled",
          () =>
            steady.receive(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId: "cancelled" },
              }),
            ),
        ],
        ["closed", () => steady.close()],
      ]) {
        const count = f.requests.length;
        const pending = steady.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "loci_generate", arguments: { mode: "heartbeat" } },
          }),
        );
        await waitUntil(() => f.requests.length === count + 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await end();
        await pending;
        await waitUntil(() => f.closed.includes(id));
        assert.equal(replies.some((value) => value.id === id), false);
      }
      assert.equal(f.requests.length, 8);
      assert.equal(JSON.stringify(replies).includes(f.token), false);
    } finally {
      steady.close();
      brief.close();
      await f.close();
    }
  });
  test("very long or unlimited limits are not treated as immediate timeouts", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
      limits: { connect: 2 ** 40, idle: Infinity, total: 2 ** 40, work: Infinity },
    });
    try {
      await f.write();
      assert.ok(
        (await ask(bridge, replies, "tools/call", { name: "loci_status" }))
          .result,
      );
      const pending = bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "long",
          method: "tools/call",
          params: { name: "loci_generate", arguments: { mode: "heartbeat" } },
        }),
      );
      await waitUntil(() => f.requests.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(replies.some((value) => value.id === "long"), false);
      assert.equal(f.closed.includes("long"), false);
      await bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "long" },
        }),
      );
      await pending;
      await waitUntil(() => f.closed.includes("long"));
      assert.equal(replies.some((value) => value.id === "long"), false);
    } finally {
      bridge.close();
      await f.close();
    }
  });
  test("model calls beyond the slot limit wait in order while control messages answer at once", async () => {
    const f = await fixture();
    const replies = [];
    const bridge = new Bridge({
      path: f.path,
      read: f.read,
      send: (value) => replies.push(value),
      limits: { concurrent: 2, waiting: 3, control: 2 },
    });
    const release = [];
    const started = [];
    const call = (id, name = "loci_generate") =>
      bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name },
        }),
      );
    try {
      await f.write();
      f.respond = async (message, req, res) => {
        if (message.method === "tools/call") {
          started.push(message.id);
          await new Promise((resolve) => release.push(resolve));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "tools/call"
                ? { content: [{ type: "text", text: String(message.id) }] }
                : {},
          }),
        );
        return true;
      };
      const calls = [1, 2, 3, 4, 5].map((id) => call(id));
      await waitUntil(() => release.length === 2);
      assert.equal(bridge.waiting.length, 3);
      await call(6);
      assert.equal(replies.at(-1).id, 6);
      assert.equal(replies.at(-1).error.code, -32000);
      assert.equal((await ask(bridge, replies, "ping")).error, undefined);
      await bridge.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 4 },
        }),
      );
      assert.equal(bridge.waiting.length, 2);
      for (const arrived of [3, 4]) {
        release.shift()();
        await waitUntil(() => started.length === arrived);
      }
      for (const next of release.splice(0)) next();
      await Promise.all(calls);
      assert.deepEqual(
        [...started.slice(0, 2).sort(), ...started.slice(2)],
        [1, 2, 3, 5],
      );
      assert.deepEqual(
        replies
          .filter((reply) => reply.result?.content)
          .map((reply) => reply.id)
          .sort(),
        [1, 2, 3, 5],
      );
      assert.equal(replies.some((reply) => reply.id === 4), false);

      assert.equal(bridge.running, 0);
      assert.equal(bridge.waitingBytes, 0);
      f.respond = async (message, req, res) => {
        await new Promise((resolve) => release.push(resolve));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return true;
      };
      const pings = ["p1", "p2"].map((id) =>
        bridge.receive(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })),
      );
      await waitUntil(() => release.length === 2);
      await bridge.receive(
        JSON.stringify({ jsonrpc: "2.0", id: "p3", method: "ping" }),
      );
      assert.equal(replies.at(-1).id, "p3");
      assert.equal(replies.at(-1).error.code, -32000);
      for (const next of release.splice(0)) next();
      await Promise.all(pings);
      const queued = [7, 8, 9].map((id) => call(id));
      await waitUntil(() => release.length === 2);
      bridge.close();
      for (const next of release.splice(0)) next();
      await Promise.all(queued);
      assert.equal(replies.some((reply) => reply.id === 9), false);
      assert.equal(started.includes(9), false);
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
      limits: { concurrent: 1, waiting: 0 },
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
        JSON.stringify({
          jsonrpc: "2.0",
          id: "full",
          method: "tools/call",
          params: { name: "loci_generate" },
        }),
      );
      assert.equal(replies.at(-1).error.code, -32000);
      const ping = await ask(bridge, replies, "ping");
      assert.equal(ping.error, undefined);
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
      await waitUntil(() => f.requests.length === 4);
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
