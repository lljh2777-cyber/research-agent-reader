const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
let bytes = Buffer.from("%PDF synthetic immutable bytes"); let destroyed = 0; let renderCancelled = false;
let figureBytes = Buffer.from("original");
let figureReadError;
const clipper = {
	paper: async () => ({ title: "Fixture" }),
	text: async () => "# Results\n\n![Figure 2](images/example.webp)",
	read: async () => { if (figureReadError) throw figureReadError; return figureBytes; },
};
const mocks = {
	"../library/clipper": { isClipperPath: (p) => p.startsWith("@paper-clipper/"), requireClipper: () => clipper },
	"obsidian": { TFile: class {}, loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 3,
		getPage: async (n) => ({ getTextContent: async () => ({ items: n === 3 ? [] : [{ str: n === 1 ? "Introduction study rationale" : "Results sample size comparison", hasEOL: true }] }),
			getViewport: ({ scale }) => ({ width: 800 * scale, height: 1200 * scale }), render: (options) => {
				assert.equal(options.intent, "print"); let reject;
				return { promise: new Promise((_, fail) => { reject = fail; }), cancel: () => { renderCancelled = true; reject(new Error("cancelled render")); } };
			} }), destroy: async () => { destroyed++; } }) }) }) },
	"node:fs/promises": { open: async () => ({ stat: async () => ({ isFile: () => true, size: bytes.length }), readFile: async () => bytes, close: async () => {} }) },
};
const { ReadingDocumentLoader, textEvidence, selectReadingEvidence, readingHash, uniqueEvidencePage } = loadReading("reading/document.ts", mocks);
(async () => {
	const text = "# Intro\n" + "a".repeat(9500) + "\n# Results\nImportant result";
	const parts = textEvidence(text, "papers/a/article.md");
	assert.equal(parts.map((p) => p.text).join(""), text);
	for (const p of parts) assert.equal(text.slice(p.start, p.end), p.text);
	assert.equal(parts.at(-1).label, "Results");
	assert.equal(uniqueEvidencePage({ start: 0, end: 100 }, [{ page: 1, start: 20, end: 50 }]), 1);
	assert.equal(uniqueEvidencePage({ start: 0, end: 100 }, [{ page: 1, start: 20, end: 50 }, { page: 2, start: 50, end: 90 }]), undefined);
	const document = await new ReadingDocumentLoader({}, "E:/vault").open("pdf", "a.pdf");
	assert.equal(document.source.fingerprint, readingHash(bytes));
	assert.ok(document.evidence.some((e) => e.id === "page-3" && /视觉/.test(e.text)));
	const selected = selectReadingEvidence(document, "sample size", 0);
	assert.equal(selected[0].page, 2); await document.verify();
	global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
	const controller = new AbortController(); const rendering = document.image(document.evidence.find((e) => e.id === "page-3"), controller.signal);
	await Promise.resolve(); controller.abort(); await assert.rejects(rendering, /cancelled render/); assert.equal(renderCancelled, true);
	global.document = undefined;
	bytes = Buffer.from("%PDF changed"); await assert.rejects(document.verify(), /已变化/);
	await document.destroy(); assert.equal(destroyed, 1);
	await assert.rejects(new ReadingDocumentLoader({}, "E:/vault").open("article", "../other.md"), /已验证/);
	const loader = new ReadingDocumentLoader({}, "E:/vault");
	const paperPath = "@paper-clipper/fixture/paper.md";
	const clipped = await loader.open("article", paperPath);
	const figure = clipped.evidence.find(e => e.asset);
	assert.equal((await clipped.image(figure)).evidenceId, figure.id);
	figureBytes = null;
	await assert.rejects(clipped.image(figure), /缺少原图/);
	const initiallyMissing = await loader.open("article", paperPath);
	assert.ok(initiallyMissing.evidence.some(e => e.id === figure.id && e.asset === figure.asset));
	await assert.rejects(initiallyMissing.image(figure), /缺少原图/);
	figureReadError = Object.assign(new Error("open failed"), { code: "ENOENT" });
	await assert.rejects(clipped.image(figure), /缺少原图/);
	figureReadError.code = "EACCES";
	await assert.rejects(clipped.image(figure), err => err === figureReadError);
	figureReadError = undefined;
	figureBytes = Buffer.from("original");
	assert.deepEqual(await initiallyMissing.image(figure), await clipped.image(figure));
	figureBytes = Buffer.from("modified");
	await assert.rejects(clipped.image(figure), /配图已更新/);
	await assert.rejects(initiallyMissing.image(figure), /配图已更新/);
	console.log("READING_DOCUMENTS_OK");
})().catch((e) => { console.error(e); process.exitCode = 1; });
