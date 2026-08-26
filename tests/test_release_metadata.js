"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));
const versions = JSON.parse(read("versions.json"));

assert.equal(manifest.id, "research-agent-reader");
assert.equal(manifest.name, "Research Agent Reader");
assert.match(manifest.id, /^[a-z0-9-]+$/);
assert.equal(manifest.version, pkg.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(manifest.isDesktopOnly, true);
assert.ok(manifest.description.length <= 250);
assert.ok(manifest.description.endsWith("."));
for (const required of ["README.md", "LICENSE", "SECURITY.md", "manifest.json", "versions.json"]) {
	assert.ok(fs.existsSync(path.join(root, required)), `${required} is required`);
}
const gitignore = read(".gitignore");
assert.match(gitignore, /^main\.js$/m);
assert.match(gitignore, /^data\.json$/m);
const releaseWorkflow = read(".github/workflows/release.yml");
assert.match(releaseWorkflow, /main\.js manifest\.json styles\.css/);
assert.match(releaseWorkflow, /Tag must equal manifest version/);

console.log("AGENT_DASHBOARD_RELEASE_METADATA_TEST_OK");
