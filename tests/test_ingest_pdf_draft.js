const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { loadReading } = require("./reading-test-helpers");
const { createBoundPdfReadTool, pdfDraftKey } = loadReading("agent/pdf-draft.ts");
const { readAuthorizedPdfText } = loadReading("agent/pdf-identity.ts");
const { evaluateDraftPhase, validateDraftReceipts } = loadReading("agent/paper-ingest-flow.ts");
(async () => {
	const bytes = Buffer.from("synthetic PDF");
	const snapshot = { path: "bound.pdf", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	const controller = new AbortController(); const pages = []; let destroyed = 0;
	const deps = { readFile: async () => bytes, loadPdfJs: async () => ({ getDocument: () => ({ destroy: async () => { destroyed++; }, promise: Promise.resolve({ numPages: 6,
		getPage: async number => { pages.push(number); return { getViewport: () => ({ width: 600, height: 800 }), getTextContent: async () => ({ items: [{ str: "Actual original page text", transform: [12, 0, 0, 12, 20, 700], width: 240, height: 12 }] }) }; }
	}) }) }) };
	const read = (s, signal, page) => readAuthorizedPdfText(s, signal, page, deps);
	const tool = createBoundPdfReadTool(snapshot, "Confirmed title", read);
	const receipt = await tool.execute({}, { signal: controller.signal });
	assert.deepEqual(pages, [1, 2, 3]); assert.equal(destroyed, 1);
	assert.match(receipt.output, /PDF 第 3 页/);
	assert.deepEqual(validateDraftReceipts(pdfDraftKey(snapshot), "Confirmed title", [{ tool: "pdf_read", ok: true, data: receipt.receiptData }]), []);
	assert.ok(validateDraftReceipts(pdfDraftKey(snapshot), "Other", [{ tool: "pdf_read", ok: true, data: receipt.receiptData }]).length);
	assert.ok(validateDraftReceipts(pdfDraftKey(snapshot), "Confirmed title", [{ tool: "article_read", ok: true, data: receipt.receiptData }]).length);
	await assert.rejects(tool.execute({ mode: "page", page: 7 }, { signal: controller.signal }), /页码/);
	await assert.rejects(read({ ...snapshot, sha256: "b".repeat(64) }, controller.signal), /快照/);
	controller.abort(); await assert.rejects(read(snapshot, controller.signal), /取消/);
	assert.equal(evaluateDraftPhase({ createArticleWiki: true, articleWikiSource: "pdf" }, "", false, true).run, true);
	assert.equal(evaluateDraftPhase({ createArticleWiki: true, articleWikiSource: "article" }, "", false, true).run, false);
	assert.equal(evaluateDraftPhase({ createArticleWiki: true, createArticleMarkdown: true, articleWikiSource: "auto" }, "", false, true).run, false);
	const scanned = { ...deps, loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), getTextContent: async () => ({ items: [] }) }) }) }) }) };
	await assert.rejects(readAuthorizedPdfText(snapshot, new AbortController().signal, undefined, scanned), /OCR/);
	console.log("INGEST_PDF_DRAFT_OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
