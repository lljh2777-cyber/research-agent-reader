// Explicit allowlist of memory-only tests, with no recursive cleanup.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
for (const name of ["test_learning_library.js", "test_curation_service.js", "test_curation_writer.js", "test_curation_context.js", "test_curation_selection.js", "test_production_retrieval_check.js"]) execFileSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit", windowsHide: true });
console.log("CURATION_ALL_TESTS_OK");
