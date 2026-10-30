import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../loci");
const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));

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
