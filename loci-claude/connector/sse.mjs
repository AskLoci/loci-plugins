import { pathToFileURL } from "node:url";
// Incremental UTF-8 / SSE decoder. Limit each unfinished line and event, while
// allowing long streams of bounded progress notifications. Stop at the result.
import { ConnectorError, MAX_BYTES } from "./protocol.mjs";

export class SseReader {
  constructor(deliver, limit = MAX_BYTES) {
    this.deliver = deliver;
    this.limit = limit;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.buffer = "";
    this.data = [];
    this.bytes = 0;
    this.stopped = false;
  }
  dispatch() {
    if (this.data.length)
      this.stopped = this.deliver(this.data.join("\n")) === true;
    this.data = [];
    this.bytes = 0;
  }
  line(text) {
    if (!text) return this.dispatch();
    if (text.startsWith("data:") || text === "data") {
      const value = text === "data" ? "" : text.slice(text[5] === " " ? 6 : 5);
      this.bytes += Buffer.byteLength(value) + 1;
      if (this.bytes > this.limit)
        throw new ConnectorError("Loci’s event is too large.");
      this.data.push(value);
    }
  }
  push(bytes, end = false) {
    if (this.stopped) return;
    try {
      this.buffer += this.decoder.decode(bytes, { stream: !end });
    } catch {
      throw new ConnectorError("Loci sent invalid UTF-8.");
    }
    let offset = 0;
    for (let i = 0; i < this.buffer.length && !this.stopped; i++) {
      if (this.buffer[i] !== "\n" && this.buffer[i] !== "\r") continue;
      if (this.buffer[i] === "\r" && i + 1 === this.buffer.length && !end)
        break;
      const line = this.buffer.slice(offset, i);
      if (Buffer.byteLength(line) > this.limit)
        throw new ConnectorError("Loci’s event is too large.");
      this.line(line);
      if (this.buffer[i] === "\r" && this.buffer[i + 1] === "\n") i++;
      offset = i + 1;
    }
    this.buffer = this.buffer.slice(offset);
    if (this.stopped) {
      this.buffer = "";
      return;
    }
    if (Buffer.byteLength(this.buffer) > this.limit)
      throw new ConnectorError("Loci’s event is too large.");
    if (end) {
      if (this.buffer) this.line(this.buffer);
      this.buffer = "";
      if (!this.stopped) this.dispatch();
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
  test("all byte boundaries, UTF-8, CRLF, BOM, comments and multiline events", () => {
    const bytes = Buffer.from(
      "\ufeff:keepalive\r\nevent: message\r\ndata: café\r\ndata: 🍐\r\n\r\ndata: tail",
    );
    for (let split = 0; split <= bytes.length; split++) {
      const events = [];
      const reader = new SseReader((text) => {
        events.push(text);
      });
      reader.push(bytes.subarray(0, split));
      reader.push(bytes.subarray(split));
      reader.push(new Uint8Array(), true);
      assert.deepEqual(events, ["café\n🍐", "tail"]);
    }
  });
  test("memory bounds, malformed UTF-8 and final response close", () => {
    assert.throws(() =>
      new SseReader(() => {}, 8).push(Buffer.from("x".repeat(9))),
    );
    assert.throws(() =>
      new SseReader(() => {}, 16).push(
        Buffer.from("data: 12345678\ndata: 12345678\n"),
      ),
    );
    assert.throws(() => new SseReader(() => {}).push(Buffer.from([255])));
    const events = [];
    const reader = new SseReader((text) => {
      events.push(text);
      return true;
    });
    reader.push(Buffer.from("data: result\n\ndata: ignored\n\n"));
    reader.push(Buffer.from("data: later\n\n"));
    assert.deepEqual(events, ["result"]);
  });
}
