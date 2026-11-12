import { pathToFileURL } from "node:url";
// Incremental UTF-8 / SSE decoder. Limit each unfinished line and event, while
// allowing long streams of bounded progress notifications. Stop at the result.
import { ConnectorError, MAX_BYTES } from "./protocol.mjs";

// A line may carry "data: " in front of a value as large as the event limit.
const PREFIX = "data: ".length;

export class SseReader {
  constructor(deliver, limit = MAX_BYTES) {
    this.deliver = deliver;
    this.limit = limit;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.parts = [];
    this.lineBytes = 0;
    this.afterCR = false;
    this.data = [];
    this.bytes = 0;
    this.stopped = false;
  }
  dispatch() {
    const text = this.data.join("\n");
    if (text.length) this.stopped = this.deliver(text) === true;
    this.data = [];
    this.bytes = 0;
  }
  line(text) {
    if (!text) return this.dispatch();
    if (text.startsWith("data:") || text === "data") {
      const value = text === "data" ? "" : text.slice(text[5] === " " ? 6 : 5);
      this.bytes += Buffer.byteLength(value) + (this.data.length ? 1 : 0);
      if (this.bytes > this.limit)
        throw new ConnectorError("Loci’s event is too large.");
      this.data.push(value);
    }
  }
  append(piece) {
    if (!piece) return;
    this.lineBytes += Buffer.byteLength(piece);
    if (this.lineBytes > this.limit + PREFIX)
      throw new ConnectorError("Loci’s event is too large.");
    this.parts.push(piece);
  }
  clear() {
    this.parts = [];
    this.lineBytes = 0;
    this.afterCR = false;
    this.data = [];
    this.bytes = 0;
  }
  push(bytes, end = false) {
    if (this.stopped) return;
    let text;
    try {
      text = this.decoder.decode(bytes, { stream: !end });
    } catch {
      throw new ConnectorError("Loci sent invalid UTF-8.");
    }
    let start = 0;
    if (this.afterCR && text.length) {
      this.afterCR = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length && !this.stopped; i++) {
      const code = text.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      this.append(text.slice(start, i));
      const line = this.parts.join("");
      this.parts = [];
      this.lineBytes = 0;
      if (code === 13) {
        if (i + 1 === text.length) this.afterCR = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
      this.line(line);
    }
    if (this.stopped) return this.clear();
    this.append(text.slice(start));
    // Only a blank line commits an SSE event; EOF discards unfinished data.
    if (end) this.clear();
  }
}

if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("empty priming events and unfinished events do not become messages", () => {
    const events = [];
    const reader = new SseReader((text) => {
      events.push(text);
    });
    reader.push(
      Buffer.from("id: 1\ndata:\n\ndata: answer\n\ndata: unfinished\n"),
    );
    reader.push(new Uint8Array(), true);
    assert.deepEqual(events, ["answer"]);
  });
  test("random chunk boundaries preserve long Unicode progress streams", () => {
    const expected = Array.from(
      { length: 500 },
      (_, i) => `progress ${i} café 🍐 漢字`,
    );
    const bytes = Buffer.from(
      expected.map((value) => `data: ${value}\r\n\r\n`).join(""),
    );
    for (let seed = 1; seed <= 20; seed++) {
      let state = seed;
      const events = [];
      const reader = new SseReader((value) => {
        events.push(value);
      }, 128);
      for (let offset = 0; offset < bytes.length; ) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const next = offset + 1 + (state % 97);
        reader.push(bytes.subarray(offset, next));
        offset = next;
      }
      reader.push(new Uint8Array(), true);
      assert.deepEqual(events, expected);
    }
  });
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
      assert.deepEqual(events, ["café\n🍐"]);
    }
  });
  test("LF, CR and CRLF endings agree at every chunk boundary", () => {
    for (const ending of ["\n", "\r", "\r\n"]) {
      const bytes = Buffer.from(
        [
          "﻿:keepalive",
          "event: message",
          "data: café",
          "data: 🍐 漢字",
          "",
          "data: second",
          "",
          "data: tail",
        ].join(ending),
      );
      for (let split = 0; split <= bytes.length; split++) {
        const events = [];
        const reader = new SseReader((text) => {
          events.push(text);
        });
        reader.push(bytes.subarray(0, split));
        reader.push(new Uint8Array());
        reader.push(bytes.subarray(split));
        reader.push(new Uint8Array(), true);
        assert.deepEqual(events, ["café\n🍐 漢字", "second"], JSON.stringify(ending));
      }
      const events = [];
      const reader = new SseReader((text) => {
        events.push(text);
      });
      for (const byte of bytes) reader.push(Buffer.from([byte]));
      reader.push(new Uint8Array(), true);
      assert.deepEqual(events, ["café\n🍐 漢字", "second"], JSON.stringify(ending));
    }
    const events = [];
    const reader = new SseReader((text) => {
      events.push(text);
    });
    reader.push(Buffer.from("data: a\r"));
    reader.push(new Uint8Array());
    reader.push(Buffer.from("\ndata: b\n\n"));
    reader.push(new Uint8Array(), true);
    assert.deepEqual(events, ["a\nb"]);
    const mixed = Buffer.from(
      ":x\rdata: a\rdata: b\n\r\ndata: c\r\r\ndata: d\n",
    );
    for (let split = 0; split <= mixed.length; split++) {
      const events = [];
      const reader = new SseReader((text) => {
        events.push(text);
      });
      reader.push(mixed.subarray(0, split));
      reader.push(new Uint8Array());
      reader.push(mixed.subarray(split));
      reader.push(new Uint8Array(), true);
      assert.deepEqual(events, ["a\nb", "c"]);
    }
  });
  test("large events parse in linear time", { timeout: 10000 }, () => {
    for (const size of [4 * 1024 * 1024, MAX_BYTES]) {
      const bytes = Buffer.from(`data: ${"x".repeat(size)}\n\n`);
      const delivered = [];
      const reader = new SseReader((text) => {
        delivered.push(text.length);
        return true;
      });
      const cpu = process.cpuUsage();
      for (let offset = 0; offset < bytes.length; offset += 16384)
        reader.push(bytes.subarray(offset, offset + 16384));
      reader.push(new Uint8Array(), true);
      const used = process.cpuUsage(cpu);
      const ms = (used.user + used.system) / 1000;
      assert.deepEqual(delivered, [size]);
      assert.ok(ms < 1000, `${size} bytes took ${Math.round(ms)} ms of CPU`);
    }
    const bytes = Buffer.from(`data: ${"x".repeat(MAX_BYTES + 1)}\n\n`);
    const reader = new SseReader(() => true);
    assert.throws(() => {
      for (let offset = 0; offset < bytes.length; offset += 16384)
        reader.push(bytes.subarray(offset, offset + 16384));
    }, /too large/);
  });
  test("event limit matches the JSON body limit", () => {
    const limit = 1024;
    const parse = (text, chunk) => {
      const events = [];
      const reader = new SseReader((value) => {
        events.push(value);
      }, limit);
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length; offset += chunk)
        reader.push(bytes.subarray(offset, offset + chunk));
      reader.push(new Uint8Array(), true);
      return events;
    };
    const x = (count) => "x".repeat(count);
    for (const chunk of [Infinity, 7]) {
      for (const prefix of ["data: ", "data:"]) {
        assert.deepEqual(parse(`${prefix}${x(limit)}\n\n`, chunk), [x(limit)]);
        assert.throws(
          () => parse(`${prefix}${x(limit + 1)}\n\n`, chunk),
          /too large/,
        );
      }
      assert.deepEqual(parse(`data: ${x(511)}\ndata: ${x(512)}\n\n`, chunk), [
        `${x(511)}\n${x(512)}`,
      ]);
      assert.throws(
        () => parse(`data: ${x(511)}\ndata: ${x(513)}\n\n`, chunk),
        /too large/,
      );
      assert.deepEqual(parse(`:${x(limit + 5)}\ndata: ok\n\n`, chunk), ["ok"]);
      assert.throws(() => parse(`:${x(limit + 6)}\n`, chunk), /too large/);
    }
  });
  test("memory bounds, malformed UTF-8 and final response close", () => {
    new SseReader(() => {}, 8).push(Buffer.from("x".repeat(14)));
    assert.throws(() =>
      new SseReader(() => {}, 8).push(Buffer.from("x".repeat(15))),
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
