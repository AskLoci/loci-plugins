import { pathToFileURL } from "node:url";
// Read only the owner-only discovery file. Verify its PID, UID and exact listener
// before authentication. Never resolve DNS, follow redirects, or use a proxy.
import { open, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  ConnectorError,
  INSPECTION_FAILED,
  STALE,
  UNAVAILABLE,
  object,
} from "./protocol.mjs";

const LIMIT = 16 * 1024;
const INVALID =
  "Invalid Loci connection file. Quit and reopen Loci to refresh it, then run loci_setup again.";
export function endpointPath(env = process.env) {
  if (env.LOCI_AGENT_API_FILE) return env.LOCI_AGENT_API_FILE;
  if (!env.HOME) throw new ConnectorError("The home directory is unavailable.");
  return join(env.HOME, "Library/Application Support/LociRust/agent-api.json");
}

export function parseEndpoint(bytes) {
  let file;
  try {
    file = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ConnectorError(INVALID);
  }
  if (!object(file)) throw new ConnectorError(INVALID);
  if (!Number.isInteger(file.pid) || file.pid <= 0 || file.pid > 0xffffffff)
    throw new ConnectorError(STALE);
  if (typeof file.token !== "string" || !/^[a-f\d]{64}$/i.test(file.token))
    throw new ConnectorError(
      "Invalid Loci access token. Reopen Loci to refresh it.",
    );
  let url;
  try {
    url = new URL(file.mcp_url);
  } catch {
    throw new ConnectorError("Invalid Loci MCP address.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/mcp" ||
    url.port === "0"
  ) {
    throw new ConnectorError(
      "The Loci connector accepts only a local loopback MCP address.",
    );
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return { url, token: file.token, pid: file.pid };
}

function fields(record) {
  if (!record.endsWith("\0")) throw new ConnectorError(INSPECTION_FAILED);
  const values = record.slice(0, -1).split("\0");
  if (values.some((value) => !value))
    throw new ConnectorError(INSPECTION_FAILED);
  return values;
}

export function verifyInspection(endpoint, uid, code, output) {
  if (code === 1 && output.length === 0) throw new ConnectorError(STALE);
  if (code !== 0 || output.length > LIMIT)
    throw new ConnectorError(INSPECTION_FAILED);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new ConnectorError(INSPECTION_FAILED);
  }
  if (!text.endsWith("\n")) throw new ConnectorError(INSPECTION_FAILED);
  const records = text.slice(0, -1).split("\n");
  const processFields = fields(records.shift());
  if (
    processFields.length !== 2 ||
    !/^p\d+$/.test(processFields[0]) ||
    !/^u\d+$/.test(processFields[1])
  )
    throw new ConnectorError(INSPECTION_FAILED);
  const expected = `${endpoint.url.hostname}:${endpoint.url.port || "80"}`;
  let matched = false;
  if (!records.length) throw new ConnectorError(INSPECTION_FAILED);
  for (const record of records) {
    const values = fields(record);
    const data = new Map(values.map((value) => [value[0], value.slice(1)]));
    if (
      values.length !== 4 ||
      data.size !== 4 ||
      !/^\d+$/.test(data.get("f") ?? "") ||
      data.get("T") !== "ST=LISTEN" ||
      !["IPv4", "IPv6"].includes(data.get("t"))
    )
      throw new ConnectorError(INSPECTION_FAILED);
    const address = data.get("n");
    if (
      !address ||
      !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(address) ||
      (address.startsWith("[") ? "IPv6" : "IPv4") !== data.get("t")
    )
      throw new ConnectorError(INSPECTION_FAILED);
    matched ||= address === expected;
  }
  if (
    Number(processFields[0].slice(1)) !== endpoint.pid ||
    Number(processFields[1].slice(1)) !== uid ||
    !matched
  )
    throw new ConnectorError(STALE);
}

export function inspectListener(endpoint, uid, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/lsof",
      [
        "-nP",
        "-l",
        "-a",
        "-p",
        String(endpoint.pid),
        `-iTCP:${endpoint.url.port || "80"}`,
        "-sTCP:LISTEN",
        "-F0puftnT",
        "-Ts",
      ],
      {
        encoding: "buffer",
        timeout: 5000,
        maxBuffer: LIMIT,
        env: { LC_ALL: "C" },
        signal,
      },
      (error, stdout) => {
        try {
          verifyInspection(endpoint, uid, error ? error.code : 0, stdout);
          resolve();
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });
}

export async function readEndpoint(path, signal, inspect = inspectListener) {
  let file;
  try {
    signal?.throwIfAborted();
    // Nonblocking open prevents an invalid FIFO from hanging setup. No symlinks.
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new ConnectorError(
      error.code === "ENOENT"
        ? UNAVAILABLE
        : "Cannot read Loci’s connection file. Open Loci and check Settings → Advanced → Agent Access.",
    );
  }
  let endpoint, uid;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > LIMIT) throw new ConnectorError(INVALID);
    if (
      (info.mode & 0o077) !== 0 ||
      typeof process.getuid !== "function" ||
      info.uid !== process.getuid()
    ) {
      throw new ConnectorError(
        "Loci’s connection file must be readable only by its owner. Reopen Loci to refresh it.",
      );
    }
    const bytes = Buffer.alloc(LIMIT + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > LIMIT) throw new ConnectorError(INVALID);
    endpoint = parseEndpoint(bytes.subarray(0, total));
    uid = info.uid;
  } catch (error) {
    throw error instanceof ConnectorError
      ? error
      : new ConnectorError("Cannot read Loci’s connection file.");
  } finally {
    await file.close();
  }
  signal?.throwIfAborted();
  await inspect(endpoint, uid, signal);
  signal?.throwIfAborted();
  return endpoint;
}

if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { mkdtemp, writeFile, chmod, symlink, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const data = (url, pid = 42) =>
    Buffer.from(JSON.stringify({ mcp_url: url, pid, token: "a".repeat(64) }));
  test("endpoint accepts only authenticated numeric loopback", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"])
      assert.notEqual(
        parseEndpoint(data(`http://${host}:1234/mcp`)).url.hostname,
        "localhost",
      );
    for (const url of [
      "https://127.0.0.1/mcp",
      "http://example.com/mcp",
      "http://u:p@127.0.0.1/mcp",
      "http://127.0.0.1/mcp?x",
      "http://127.0.0.1/mcp#x",
      "http://127.0.0.1/private",
      "http://127.0.0.1:0/mcp",
    ])
      assert.throws(() => parseEndpoint(data(url)), ConnectorError);
    for (const pid of [0, -1, 1.1, "42", null, 0x100000000])
      assert.throws(() => parseEndpoint(data("http://127.0.0.1:12/mcp", pid)));
    for (const bytes of [
      Buffer.from("PRIVATE_CONTENT"),
      Buffer.from("null"),
      Buffer.from([255]),
    ])
      assert.throws(
        () => parseEndpoint(bytes),
        (error) => !error.message.includes("PRIVATE"),
      );
  });
  test("ownership inspection rejects stale, truncated, duplicate and wrong owner records", () => {
    const endpoint = parseEndpoint(data("http://127.0.0.1:1234/mcp"));
    const good = "p42\0u501\0\nf9\0tIPv4\0n127.0.0.1:1234\0TST=LISTEN\0\n";
    verifyInspection(endpoint, 501, 0, Buffer.from(good));
    for (const bad of [
      "",
      good.slice(0, -1),
      good.replace("p42", "p43"),
      good.replace("u501", "u502"),
      good.replace(":1234", ":1235"),
      good.replace("f9\0", "f9\0f10\0"),
      good.replace("IPv4", "IPv6"),
      good.replace("ST=LISTEN", "ST=CLOSED"),
      good.replace("n127.0.0.1", "n*"),
    ])
      assert.throws(() => verifyInspection(endpoint, 501, 0, Buffer.from(bad)));
    assert.throws(() => verifyInspection(endpoint, 501, 1, Buffer.alloc(0)), {
      message: STALE,
    });
    assert.throws(() => verifyInspection(endpoint, 501, 2, Buffer.alloc(0)), {
      message: INSPECTION_FAILED,
    });
  });
  test("file permissions, size, type and symlinks are checked before inspection", async () => {
    const folder = await mkdtemp(join(tmpdir(), "loci-endpoint-"));
    const path = join(folder, "agent-api.json");
    let count = 0;
    const inspect = async () => {
      count++;
    };
    try {
      await assert.rejects(readEndpoint(path, undefined, inspect));
      await writeFile(path, data("http://127.0.0.1:1234/mcp"), { mode: 0o600 });
      await readEndpoint(path, undefined, inspect);
      assert.equal(count, 1);
      await chmod(path, 0o644);
      await assert.rejects(readEndpoint(path, undefined, inspect));
      await chmod(path, 0o600);
      await symlink(path, join(folder, "link"));
      await assert.rejects(
        readEndpoint(join(folder, "link"), undefined, inspect),
      );
      await writeFile(path, "x".repeat(LIMIT + 1));
      await assert.rejects(readEndpoint(path, undefined, inspect));
      await assert.rejects(readEndpoint(folder, undefined, inspect));
      assert.equal(count, 1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  test("real system inspector accepts the owner and refuses a stale PID", async () => {
    const { fixture } = await import("./testing.mjs");
    const f = await fixture();
    try {
      await f.write();
      assert.equal((await readEndpoint(f.path)).pid, process.pid);
      await writeFile(f.path, data(f.url, 0xffffffff));
      await assert.rejects(readEndpoint(f.path), ConnectorError);
      assert.equal(f.requests.length, 0);
    } finally {
      await f.close();
    }
  });
}
