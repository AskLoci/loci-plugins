import { pathToFileURL } from "node:url";
// Public MCP contract: retain app schemas/results and add setup discovery only.
export const VERSION = "0.1.8";
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
  "Loci’s saved connection belongs to an earlier or different app session. Check Agent Access in the intended Loci app, then run loci_setup again. A development or test app may use separate connection settings. No access token was sent.";
export const INSPECTION_FAILED =
  "Loci’s saved connection could not be verified. Check that the intended Loci direct-download app is open with Settings → Advanced → Agent Access enabled, then run loci_setup again. No access token was sent.";
export const AUTHENTICATION_FAILED =
  "Loci refused the saved connection. In the intended Loci app, turn Settings → Advanced → Agent Access off and on when no work is running, then run loci_setup again. Re-reading the same settings or registering the plugin again will not repair them.";
export const INCOMPATIBLE_APP =
  "Loci answered but did not expose its model tools. Open the intended Loci direct-download app and check for an update, then run loci_setup again.";
export const CONNECTION_FAILED =
  "The connection to Loci could not be completed. Check Agent Access in the intended Loci app, then run loci_setup again.";
export const INSTRUCTIONS =
  "Loci runs models on this Mac alongside your assistant. If Loci is not connected, call loci_setup for the Mac download link and connection instructions. After connecting, call loci_status and choose a model suited to the task. Honor explicit model choices and prefer suitable installed models; recommendation flags are optional. Use only advertised tools and arguments. Preserve active work and the app default; authorize new downloads. Only use authorized file paths and output destinations. Inputs and results returned to the calling assistant follow that client’s data policies.";
export const CORE_TOOLS = [
  "loci_status",
  "loci_generate",
  "loci_map",
  "loci_pull",
  "loci_warm",
];
export class ConnectorError extends Error {
  constructor(message, connectionState = "connection_failed") {
    super(message);
    this.connectionState = connectionState;
  }
}
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

export function setupReport(request, connected, detail, connectionState) {
  const state = connected
    ? "connected"
    : (connectionState ??
      (detail === STALE
        ? "stale_connection"
        : detail === INSPECTION_FAILED
          ? "connection_unverified"
          : detail === UNAVAILABLE
            ? "unavailable"
            : "connection_failed"));
  const status = {
    connected,
    connector_version: VERSION,
    connection_state: state,
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
      : state === "unavailable"
        ? "install_or_open_loci"
        : ["invalid_connection", "authentication_failed"].includes(state)
          ? "repair_loci_connection"
          : state === "incompatible_app"
            ? "update_loci"
            : "check_loci_connection",
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
    // Earlier apps described local inference as an absolute data boundary.
    // Correct those known claims while retaining the tool's other contracts.
    const description = (typeof tool.description === "string" ? tool.description : tool.name)
      .replaceAll("Nothing leaves the Mac.", "Model inference runs locally.")
      .replaceAll("Nothing sent here leaves this Mac.", "Model inference runs locally.");
    tool.description = `${description}. Inputs and returned results are visible to the calling assistant and follow its data policies.`;
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
  test("legacy privacy claims are corrected without losing tool contracts", () => {
    for (const claim of ["Nothing leaves the Mac.", "Nothing sent here leaves this Mac."]) {
      const schema = { type: "object", additionalProperties: false };
      const reply = { result: { tools: [{
        name: "loci_generate",
        description: `Retain continuation and schema limits. ${claim}`,
        inputSchema: schema,
      }] } };
      describeTools(reply);
      const tool = reply.result.tools[0];
      assert.equal(tool.inputSchema, schema);
      assert.match(tool.description, /Retain continuation and schema limits/);
      assert.equal(tool.description.includes(claim), false);
      assert.match(tool.description, /Model inference runs locally/);
      assert.match(tool.description, /visible to the calling assistant/);
    }
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
