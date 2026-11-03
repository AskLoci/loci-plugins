import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../loci");
const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const run = promisify(execFile);

test("Codex can resolve the bundled connector under the Agent Plugins executable contract", async () => {
  // JSON Schema alone does not validate command resolution semantics:
  // https://agent-plugins.org/specification#721-stdio-servers
  const portable = (await json("mcp.json")).mcpServers.loci;
  assert.equal(portable.type, "stdio");
  assert.ok(portable.command.startsWith("./"), "bundled commands need a contained ./ path");
  assert.ok(!portable.command.includes("${"), "command placeholders are not expanded");
  const executable = await realpath(resolve(root, portable.command));
  assert.ok(executable.startsWith(`${await realpath(root)}${sep}`), "executable must stay in the plugin");
  assert.ok((await stat(executable)).isFile());
  await access(executable, constants.X_OK);

  const legacy = (await json(".mcp.json")).mcpServers.loci;
  const expand = (value) => value.replaceAll("${PLUGIN_ROOT}", root);
  assert.equal(await realpath(resolve(root, expand(legacy.command))), executable);
  assert.equal(await realpath(resolve(root, expand(portable.cwd))), await realpath(root));
  assert.equal(await realpath(resolve(root, expand(legacy.cwd))), await realpath(root));
  assert.deepEqual(legacy.args, portable.args);

  const manifest = await json("plugin.json");
  const compatibility = await json(".codex-plugin/plugin.json");
  assert.equal(compatibility.name, manifest.name);
  assert.equal(compatibility.version, manifest.version);
});

test("Cursor resolves the same signed runtime while package versions remain independent", async () => {
  const cursorRoot = resolve(root, "../loci-cursor");
  const server = (await json("../loci-cursor/mcp.json")).mcpServers.loci;
  assert.equal(server.command, "${CURSOR_PLUGIN_ROOT}/bin/loci-connector");
  assert.deepEqual(server.args, []);
  const cursorExecutable = await realpath(server.command.replace("${CURSOR_PLUGIN_ROOT}", cursorRoot));
  assert.ok(cursorExecutable.startsWith(`${await realpath(cursorRoot)}${sep}`));
  await access(cursorExecutable, constants.X_OK);
  const codex = (await json("mcp.json")).mcpServers.loci;
  const codexExecutable = await realpath(resolve(root, codex.command));
  assert.deepEqual(await readFile(cursorExecutable), await readFile(codexExecutable));

  const cursor = await json("../loci-cursor/.cursor-plugin/plugin.json");
  const marketplace = await json("../.cursor-plugin/marketplace.json");
  assert.equal(marketplace.plugins.find((plugin) => plugin.name === "loci").version, cursor.version);
  for (const manifest of [cursor, await json("plugin.json")]) {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    for (const executable of [codexExecutable, cursorExecutable]) {
      assert.equal((await run(executable, ["--version"], { timeout: 10000 })).stdout.trim(), "0.1.7");
    }
  }
});

test("Gemini resolves the bundled stdio connector without trusting tool calls automatically", async () => {
  const extensionRoot = resolve(root, "..");
  const manifest = await json("../gemini-extension.json");
  assert.equal(manifest.name, "loci");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const server = manifest.mcpServers.loci;
  assert.equal(server.command, "node");
  assert.equal(server.trust, undefined);
  assert.deepEqual(server.args, ["${extensionPath}/loci-claude/connector/stdio.mjs"]);
  const args = server.args.map((arg) => arg.replace("${extensionPath}", extensionRoot));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(server.command, [...args, "--version"], { env, timeout: 10000 });
  const runtime = await json("../loci-claude/.claude-plugin/plugin.json");
  assert.equal(stdout.trim(), runtime.version);
});

test("Antigravity installs the shared connector and can read its marketplace assets", async () => {
  const pluginRoot = resolve(root, "..");
  const manifest = await json("../.antigravity-plugin/plugin.json");
  assert.equal(manifest.name, "loci");
  assert.equal(manifest.displayName, "Loci");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const logo = await realpath(resolve(pluginRoot, manifest.logo));
  assert.ok(logo.startsWith(pluginRoot + sep));
  assert.ok((await stat(logo)).isFile());
  const server = (await json("../mcp_config.json")).mcpServers.loci;
  assert.deepEqual(server, {
    command: "node",
    args: ["${PLUGIN_ROOT}/loci-claude/connector/stdio.mjs"],
  });
  const entry = server.args[0].replace("${PLUGIN_ROOT}", pluginRoot);
  await access(entry, constants.R_OK);
  await access(resolve(pluginRoot, ".antigravity-plugin/README.md"), constants.R_OK);
});
