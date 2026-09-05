"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
// All tests in this runner use in-memory fixtures. No filesystem cleanup.
for (const name of ["sessions", "documents", "layout", "engine", "backends", "branches", "export", "integration"]) {
	const result = spawnSync(process.execPath, ["tests/test_reading_" + name + ".js"], {
		cwd: path.resolve(__dirname, ".."), stdio: "inherit", windowsHide: true,
	});
	if (result.error || result.status !== 0) { if (result.error) console.error(result.error); process.exit(result.status || 1); }
}
console.log("READING_ALL_TESTS_OK");
