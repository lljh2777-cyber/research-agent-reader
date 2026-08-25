"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const pluginRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");

const settings = read("src/runtime/settings.ts");
const service = read("src/runtime/obsidian-cli.ts");
const settingsTab = read("src/settings/settings-tab.ts");
const plugin = read("src/plugin.ts");
const wrapper = read("scripts/obsidian-cli.mjs");
const pkg = JSON.parse(read("package.json"));

assert.match(settings, /OBSIDIAN_CLI_PATH/);
assert.match(settings, /path\.join\(path\.dirname\(process\.execPath\), "Obsidian\.com"\)/);
assert.match(settings, /obsidianCliExecutable/);
assert.match(settingsTab, /title: "Obsidian CLI"/);
assert.match(settingsTab, /renderObsidianCliSettings/);
assert.match(settingsTab, /version、vaults verbose/);
assert.match(settingsTab, /不开放任意 eval/);
assert.match(plugin, /probeObsidianCliConnection/);
assert.match(plugin, /describe\("Obsidian CLI", "obsidian"/);

for (const command of ["version", "vaults", "plugin"]) {
	assert.ok(service.includes(`"${command}"`), `connection probe should whitelist ${command}`);
}
assert.ok(!service.includes('"eval"'), "production CLI service must not expose eval");
assert.ok(!service.includes('"restart"'), "production CLI service must not expose restart");
assert.ok(!service.includes('"delete"'), "production CLI service must not expose delete");
assert.match(wrapper, /仅支持 check、reload、qa/);
assert.ok(!wrapper.includes('run(["eval"'), "development wrapper must not expose eval");
assert.match(wrapper, /dev:dom/);
assert.match(wrapper, /dev:screenshot/);
assert.strictEqual(pkg.scripts["obsidian:check"], "node scripts/obsidian-cli.mjs check");
assert.strictEqual(pkg.scripts["obsidian:reload"], "node scripts/obsidian-cli.mjs reload");
assert.strictEqual(pkg.scripts["obsidian:qa"], "node scripts/obsidian-cli.mjs qa");
assert.strictEqual(pkg.scripts["verify:obsidian"], "pnpm verify && node scripts/obsidian-cli.mjs qa");

console.log("DASHBOARD_OBSIDIAN_CLI_TESTS_OK");
