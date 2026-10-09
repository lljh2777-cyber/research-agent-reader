"use strict";
// Memory regressions plus a retained isolated disk fixture across fresh processes. No provider calls or cleanup.
const {execFileSync}=require("node:child_process"),path=require("node:path");
const tests=["test_excerpts.js","test_pdf_excerpts.js","test_pdf_excerpt_curation.js","test_knowledge_drafts.js","test_knowledge_pages.js","test_excerpt_library.js","test_excerpt_curation.js","test_excerpt_history.js","test_answer_excerpts.js","test_answer_revisions.js","test_answer_revision_history.js","test_answer_excerpt_curation.js","test_pending_center.js","test_annotation_source_integrity.js","test_annotation_web_search.js","test_dashboard_annotations.js"];
tests.push("test_r3_persistence.js");
for(const name of tests)execFileSync(process.execPath,[path.join(__dirname,name)],{stdio:"inherit",windowsHide:true});
console.log(`R3_REGRESSION_OK (${tests.length} suites; simulated host and retained disk persistence)`);
