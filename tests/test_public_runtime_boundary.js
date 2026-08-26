"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const plugin = read("src/plugin.ts");
const settings = read("src/runtime/settings.ts");
const settingsTab = read("src/settings/settings-tab.ts");
const actions = read("src/actions.ts");

assert.match(
	plugin,
	/fs\.existsSync\(path\.join\(candidate, "tool-library", "scripts", "run_vault_action\.py"\)\)/,
	"project-root inference must require an actual optional toolkit",
);
assert.match(plugin, /if \(action\?\.id === "vault-lint"\)/);
assert.match(plugin, /内置知识库体检可用；不需要 Research Vault Toolkit/);
assert.match(plugin, /内置阅读器、批注和知识库体检不受影响/);
assert.match(settingsTab, /内置核心功能/);
assert.match(settingsTab, /留空不会影响核心阅读功能/);
assert.match(settings, /process\.platform !== "win32"/);
assert.match(settings, /\/opt\/homebrew\/bin/);
assert.match(settings, /process\.env\.USERPROFILE \|\| process\.env\.HOME/);
assert.doesNotMatch(actions, /D:\\\\/);
assert.doesNotMatch(actions, /knowledge-base\/papers\/example\/article\.md/);

console.log("AGENT_DASHBOARD_PUBLIC_RUNTIME_BOUNDARY_TEST_OK");
