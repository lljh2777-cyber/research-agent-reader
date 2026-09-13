"use strict";
// Explicit allowlist: memory tests and retained local fixtures, no external calls or bulk cleanup.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const tests = [
 "test_metadata_intake.js", "test_manual_metadata.js",
 "test_local_pdf_source.js", "test_local_pdf_intake.js", "test_local_pdf_intake_view.js",
 "test_paper_intake.js", "test_paper_continuation.js", "test_saved_pdf_processing.js",
 "test_source_agent.js", "test_fulltext_intake_safety.js",
 "test_ingest_pdf_draft.js", "test_ingest_requests.js", "test_ingest_task_lifecycle.js",
 "test_ingest_registration.js", "test_jats_wiki.js", "test_trusted_note_create.js", "test_library_mineru_origin.js",
];
for (const name of tests) execFileSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit", windowsHide: true });
console.log(`R2_REGRESSION_OK (${tests.length} suites; simulated services, no external requests)`);
