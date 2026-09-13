"use strict";
// Explicit allowlist: memory tests and retained isolated compatibility fixtures, no bulk cleanup.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const tests = [
 "test_library_projection.js", "test_library_reader.js", "test_library_compatibility.js",
 "test_library_browser.js", "test_library_reading_state.js", "test_library_primary_note.js",
 "test_library_code_links.js", "test_dashboard_workbench.js", "test_dashboard_paper_actions.js",
 "test_dashboard_summary.js", "test_reading_domains.js", "test_reading_entry.js",
 "test_reader_tab_title.js",
];
for (const name of tests) execFileSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit", windowsHide: true });
console.log(`R1_REGRESSION_OK (${tests.length} suites; no model/network requests)`);
