import { pathToFileURL } from "node:url";
// Public MCP contract: retain app schemas/results and add setup discovery only.
export const VERSION = "0.1.5";
export const MAX_BYTES = 8 * 1024 * 1024;
export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT = "io.modelcontextprotocol/clientInfo";
export const VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
export const DOWNLOAD = "https://askloci.ai/api/mac-download";
export const GUIDE = "https://askloci.ai/agents/";
export const UNAVAILABLE = `Loci is not connected. Download the Mac app from ${DOWNLOAD} if needed. Open Loci and enable Settings → Advanced → Agent Access, then run loci_setup again.`;
export const STALE =
  "No active Loci app matches the saved connection. Open the intended Loci direct-download app, then run loci_setup again.";
export const INSPECTION_FAILED =
  "Loci’s saved connection could not be verified. Check that the intended Loci direct-download app is open with Settings → Advanced → Agent Access enabled, then run loci_setup again. No access token was sent.";
export const INSTRUCTIONS =
  "Loci runs models on this Mac alongside your assistant. If Loci is not connected, call loci_setup for the Mac download link and connection instructions. After connecting, call loci_status to choose an installed model or a recommended compatible download. Use the tools the connected app advertises. Only use authorized file paths and output destinations. Inputs and results returned to the calling assistant follow that client’s data policies.";
export const CORE_TOOLS = [
  "loci_status",
  "loci_generate",
  "loci_map",
  "loci_pull",
  "loci_warm",
];
export class ConnectorError extends Error {}
export const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const own = (value, key) => Object.hasOwn(value, key);
export const validId = (id) =>
  id === null || typeof id === "string" || Number.isSafeInteger(id);
export const validRequest = (value) =>
  object(value) &&
  value.jsonrpc === "2.0" &&
  typeof value.method === "string" &&
  (!own(value, "id") || validId(value.id)) &&
  (!own(value, "params") || object(value.params));
export const failure = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
export const hasModelTools = (reply) =>
  Array.isArray(reply?.result?.tools) &&
  CORE_TOOLS.every((name) =>
    reply.result.tools.some((tool) => tool?.name === name),
  );

export function result(request, body) {
  if (request.params?._meta?.[META_VERSION] === VERSIONS[0]) {
    body._meta = {
      ...body._meta,
      "io.modelcontextprotocol/serverInfo": {
        name: "loci-connector",
        version: VERSION,
      },
    };
  }
  return { jsonrpc: "2.0", id: request.id, result: body };
}

export function protocolError(request) {
  const meta = request.params?._meta;
  if (
    object(meta) &&
    own(meta, META_VERSION) &&
    !VERSIONS.includes(meta[META_VERSION])
  ) {
    return failure(request.id, -32022, "Unsupported MCP protocol version.");
  }
  if (
    meta?.[META_VERSION] === VERSIONS[0] &&
    ["initialize", "ping"].includes(request.method)
  ) {
    return failure(
      request.id,
      -32601,
      "This method is unavailable in the requested MCP protocol.",
    );
  }
}

export function setupTool() {
  return {
    name: "loci_setup",
    description:
      "Get the official Loci Mac download link and check the connection. Works before Loci is installed. Does not install software, change settings, or download models. Run again after opening Loci and enabling Agent Access.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

export function offlineReply(request) {
  const error = protocolError(request);
  if (error) return error;
  let body;
  switch (request.method) {
    case "initialize":
      body = {
        protocolVersion: VERSIONS.slice(1).includes(
          request.params?.protocolVersion,
        )
          ? request.params.protocolVersion
          : "2025-11-25",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "loci-connector", version: VERSION },
        instructions: INSTRUCTIONS,
      };
      break;
    case "server/discover":
      body = {
        supportedVersions: VERSIONS,
        capabilities: { tools: { listChanged: true } },
        instructions: INSTRUCTIONS,
        ttlMs: 0,
        cacheScope: "private",
      };
      break;
    case "tools/list":
      body = { tools: [setupTool()], ttlMs: 0, cacheScope: "private" };
      break;
    case "ping":
      body = {};
      break;
    default:
      return undefined;
  }
  return result(request, body);
}

export function setupReport(request, connected, detail) {
  const status = {
    connected,
    download_url: DOWNLOAD,
    guide_url: GUIDE,
    requirements: {
      platform: "macos-arm64",
      minimum_macos: "26.2",
      app_channel: "direct",
    },
    message: detail,
    next_step: connected
      ? "check_models"
      : [STALE, INSPECTION_FAILED].includes(detail)
        ? "check_loci_connection"
        : "install_or_open_loci",
  };
  return result(request, {
    content: [{ type: "text", text: JSON.stringify(status) }],
    structuredContent: status,
    isError: false,
  });
}

export function describeTools(reply) {
  const tools = reply.result?.tools;
  if (!Array.isArray(tools)) return;
  const names = [
    ...CORE_TOOLS,
    "loci_files",
    "loci_extract",
    "loci_choose",
    "loci_index",
    "loci_search",
    "loci_transcribe",
  ];
  for (const tool of tools) {
    if (!object(tool) || !names.includes(tool.name)) continue;
    const readOnly = ["loci_status", "loci_choose"].includes(tool.name);
    tool.description = `${typeof tool.description === "string" ? tool.description : tool.name}. Inputs and returned results are visible to the calling assistant and follow its data policies.`;
    tool.annotations = {
      ...tool.annotations,
      readOnlyHint: readOnly,
      destructiveHint: ["loci_extract", "loci_index"].includes(tool.name),
      idempotentHint:
        readOnly || ["loci_pull", "loci_warm"].includes(tool.name),
      openWorldHint: tool.name === "loci_pull",
    };
  }
  // The connector owns this reserved name, even if a future app advertises it.
  reply.result.tools = tools
    .filter((tool) => tool?.name !== "loci_setup")
    .concat(setupTool());
}

export function headerValue(text) {
  return text.length && text.trim() === text && /^[\x20-\x7e]+$/.test(text)
    ? text
    : `=?base64?${Buffer.from(text).toString("base64")}?=`;
}

if (
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("request shapes, unsafe numeric IDs and unsupported versions fail closed", () => {
    for (const value of [
      null,
      [],
      {},
      { jsonrpc: "2.0", method: 4 },
      { jsonrpc: "2.0", method: "x", params: [] },
      ...[{}, 1.5, Number.MAX_SAFE_INTEGER + 1].map((id) => ({
        jsonrpc: "2.0",
        method: "x",
        id,
      })),
    ])
      assert.equal(validRequest(value), false);
    for (const id of [null, 0, "one"])
      assert.equal(validRequest({ jsonrpc: "2.0", method: "x", id }), true);
    for (const version of [null, 34, "unknown"])
      assert.equal(
        protocolError({ id: 1, params: { _meta: { [META_VERSION]: version } } })
          .error.code,
        -32022,
      );
  });
  test("offline discovery never claims model readiness", () => {
    for (const method of [
      "initialize",
      "server/discover",
      "tools/list",
      "ping",
    ]) {
      const reply = offlineReply({ id: 1, method });
      assert.equal(hasModelTools(reply), false);
      assert.equal(reply.id, 1);
    }
    assert.equal(offlineReply({ id: 1, method: "tools/call" }), undefined);
    assert.equal(
      offlineReply({
        id: 1,
        method: "ping",
        params: { _meta: { [META_VERSION]: VERSIONS[0] } },
      }).error.code,
      -32601,
    );
    assert.equal(
      setupReport({ id: 1 }, false, STALE).result.structuredContent.next_step,
      "check_loci_connection",
    );
  });
  test("schemas, unknown tools and per-tool contracts survive decoration", () => {
    const extra = {
      name: "future",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: false },
    };
    const reply = {
      result: {
        tools: CORE_TOOLS.map((name) => ({
          name,
          description: "Keep continuation cursor",
          inputSchema: { type: "object" },
        })).concat(extra),
      },
    };
    const before = structuredClone(reply);
    assert.equal(hasModelTools(reply), true);
    describeTools(reply);
    assert.deepEqual(reply.result.tools[5], extra);
    assert.deepEqual(
      reply.result.tools[3].inputSchema,
      before.result.tools[3].inputSchema,
    );
    assert.match(reply.result.tools[3].description, /continuation cursor/);
    assert.equal(reply.result.tools[3].annotations.openWorldHint, true);
    assert.equal(reply.result.tools.at(-1).name, "loci_setup");
    for (const text of ["", " café", "x\r\nAuthorization: secret"])
      assert.match(headerValue(text), /^=\?base64\?/);
    assert.equal(headerValue("loci_generate"), "loci_generate");
  });
}
