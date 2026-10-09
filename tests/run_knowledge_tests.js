"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
// All fixtures use memory; there are no network calls or cleanup operations.
for (const name of ["test_knowledge_retrieval.js", "test_knowledge_evidence.js"]) {
	const result = spawnSync(process.execPath, [path.join(__dirname, name)], { cwd: path.resolve(__dirname, ".."), stdio: "inherit", windowsHide: true });
	if (result.error || result.status !== 0) { if (result.error) console.error(result.error); process.exit(result.status || 1); }
}
console.log("KNOWLEDGE_ALL_TESTS_OK");
