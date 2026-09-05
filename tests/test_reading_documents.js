const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
let bytes = Buffer.from("%PDF synthetic immutable bytes"); let destroyed = 0;
const mocks = {
	"obsidian": { TFile: class {}, loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 3,
		getPage: async (n) => ({ getTextContent: async () => ({ items: n === 3 ? [] : [{ str: n === 1 ? "Introduction study rationale" : "Results sample size comparison", hasEOL: true }] }) }), destroy: async () => { destroyed++; } }) }) }) },
	"node:fs/promises": { open: async () => ({ stat: async () => ({ isFile: () => true, size: bytes.length }), readFile: async () => bytes, close: async () => {} }) },
};
const { ReadingDocumentLoader, textEvidence, selectReadingEvidence, readingHash } = loadReading("reading/document.ts", mocks);
(async () => {
	const text = "# Intro\n" + "a".repeat(9500) + "\n# Results\nImportant result";
	const parts = textEvidence(text, "papers/a/article.md");
	assert.equal(parts.map((p) => p.text).join(""), text);
	for (const p of parts) assert.equal(text.slice(p.start, p.end), p.text);
	assert.equal(parts.at(-1).label, "Results");
	const document = await new ReadingDocumentLoader({}, "E:/vault").open("pdf", "a.pdf");
	assert.equal(document.source.fingerprint, readingHash(bytes));
	assert.ok(document.evidence.some((e) => e.id === "page-3" && /视觉/.test(e.text)));
	const selected = selectReadingEvidence(document, "sample size", 0);
	assert.equal(selected[0].page, 2); await document.verify();
	bytes = Buffer.from("%PDF changed"); await assert.rejects(document.verify(), /已变化/);
	await document.destroy(); assert.equal(destroyed, 1);
	await assert.rejects(new ReadingDocumentLoader({}, "E:/vault").open("article", "../other.md"), /已验证/);
	console.log("READING_DOCUMENTS_OK");
})().catch((e) => { console.error(e); process.exitCode = 1; });
