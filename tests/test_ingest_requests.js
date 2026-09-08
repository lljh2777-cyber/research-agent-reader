const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { validateIngestRequest } = loadReading("agent/ingest-records.ts");
const request = { version: 1, runId: "r", profileId: "p", options: { sourcePdfPath: "C:/papers/a.pdf", requestNotes: "", identityCandidateTitle: "", identityCandidateDoi: "", createArticleMarkdown: false, createArticleWiki: true, articleWikiSource: "pdf", mineruModel: "vlm", mineruLanguage: "en", mineruOcr: false, mineruFormula: true, mineruTable: true, mineruPages: "", mineruTimeoutSeconds: 600, mineruIncludeSourcePdf: false, remoteUploadConfirmed: false } };
assert.deepEqual(validateIngestRequest(request, "r"), request);
assert.throws(() => validateIngestRequest(request, "other"), /参数/);
for (const [field, value] of [["sourcePdfPath", "evil.exe"], ["mineruTimeoutSeconds", -1], ["articleWikiSource", "any"], ["createArticleWiki", "true"]]) assert.throws(() => validateIngestRequest({ ...request, options: { ...request.options, [field]: value } }, "r"));
console.log("INGEST_REQUESTS_OK");
