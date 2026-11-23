"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
// The timestamp test also reads a checked-in v1 fixture. No filesystem cleanup.
for (const name of ["sessions", "timestamps", "quotes", "load_issues", "source_picker", "domains", "entry", "quality", "web", "progress", "teaching", "planning", "catalog", "documents", "layout", "navigation", "paper_map", "inline_guide", "presentation", "engine", "generation_failures", "paper_agent", "usage", "outcomes", "backends", "branches", "export", "export_review", "integration"]) {
	const result = spawnSync(process.execPath, ["tests/test_reading_" + name + ".js"], {
		cwd: path.resolve(__dirname, ".."), stdio: "inherit", windowsHide: true,
	});
	if (result.error || result.status !== 0) { if (result.error) console.error(result.error); process.exit(result.status || 1); }
}
console.log("READING_ALL_TESTS_OK");
