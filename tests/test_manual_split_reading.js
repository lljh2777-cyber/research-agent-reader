"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
class TFile { constructor(p) { this.path = p; this.extension = p.split(".").pop(); this.basename = p.split("/").pop().replace(/\.md$/, ""); this.stat = { size: 0 }; } }
let fixture;
class FileSourceStorage { async read(p, limit) { const text = fixture.files.get(p)?.text; if (text === undefined) return null; const b = Buffer.from(text); assert.ok(b.length <= limit); return b; } }
const api = loadReading("../tests/bilingual-annotation-api.ts", { obsidian: { TFile, MarkdownView: class {}, Notice: class {}, normalizePath: p => p, parseYaml: () => ({}) }, "../sources/storage": { FileSourceStorage } });
const { normalizeManualSplit } = loadReading("reader/manual-split.ts");
const { supportsPdfExcerpt } = loadReading("annotations/pdf-excerpt.ts");
async function make(enPath = "Research/English original.md", zhPath = "Notes/中文解释.md", metadata) {
	const en = "---\ntitle: Source\n---\n# Study\n\nRepeated selected words.\n\nSecond paragraph.\n", zh = "# 研究\n\n重复的所选文字。\n\n第二段。\n";
	const files = new Map(), writes = [], calls = [];
	for (const [p, text] of [[enPath, en], [zhPath, zh], ...(metadata ? [[enPath.slice(0, enPath.lastIndexOf("/") + 1) + "translation.json", metadata(en, enPath, zhPath)]] : [])]) files.set(p, { file: new TFile(p), text });
	const app = { vault: { adapter: { getBasePath: () => "/memory" }, getAbstractFileByPath: p => files.get(p)?.file, getFileByPath: p => files.get(p)?.file, getMarkdownFiles: () => [...files.values()].map(v => v.file).filter(f => f instanceof TFile && f.extension === "md"), read: async f => files.get(f.path).text,
		createFolder: async p => files.set(p, { file: { path: p } }), create: async (p, text) => { assert.ok(!files.has(p)); const file = new TFile(p); files.set(p, { file, text }); writes.push(p); return file; }, process: async (f, fn) => { files.get(f.path).text = fn(files.get(f.path).text); writes.push(f.path); } } };
	const profile = { id: "mock", name: "Mock", model: "mock", timeoutSeconds: 1, lastTest: { ok: true } };
	const plugin = { settings: { annotationBackendId: "mock", annotationWebSearchEnabled: false, annotationMaxTokens: 600 }, getProviderProfile: () => profile, createLLMProvider: () => ({ complete: async request => { calls.push(request); return { text: "英文依据：author-reported. 一般知识／解释性推断：background.", model: "mock" }; } }) };
	fixture = { files, writes, calls, en, zh, enPath, zhPath, app, service: new api.AnnotationService(app, plugin) };
	fixture.doc = await api.loadSelectedBilingualDocument(new FileSourceStorage(), { en: enPath, zh: zhPath }); return fixture;
}
function selection(f, language) {
	const file = f.doc.files[language], selectedText = language === "en" ? "selected words" : "所选文字", start = file.text.indexOf(selectedText), end = start + selectedText.length, block = file.blocks.find(b => start >= b.start && end <= b.end);
	return { sourcePath: file.path, selectedText, sourceStart: start, sourceEnd: end, sourceRevision: api.excerptRevision(file.text), prefix: file.text.slice(Math.max(0, start - 80), start), suffix: file.text.slice(end, end + 80), section: block.chapter, context: file.text.slice(block.start, block.end), isTableCell: false, anchorRect: {}, bilingual: api.bilingualReceipt(f.doc, language, block, start, end) };
}
let count = 0; async function check(name, fn) { await fn(); count++; console.log("OK " + name); }
(async () => {
	await check("arbitrary folders and names preserve roles without invented English correspondence", async () => {
		const f = await make(); assert.equal(f.doc.syncAvailable, false); assert.equal(f.doc.pairs.length, 0); assert.equal(selection(f, "zh-CN").bilingual.english, undefined); assert.equal(selection(f, "en").bilingual.english.text, "Repeated selected words.\n");
		assert.deepEqual(f.doc.selectedFiles, { en: f.enPath, zh: f.zhPath }); assert.equal(f.writes.length, 0);
	});
	await check("both languages save independently; receipts survive serialization and detached note edits", async () => {
		const f = await make(), zh = await f.service.createExcerpt(selection(f, "zh-CN"), "personal"), en = await f.service.createExcerpt(selection(f, "en"));
		assert.notEqual(zh.id, en.id); const parsed = api.readAnnotationRecords(f.files.get(zh.annotationPath).text, zh.annotationPath); assert.deepEqual(parsed.errors, []); assert.deepEqual(parsed.records[0].bilingual.files, f.doc.selectedFiles);
		assert.deepEqual(api.readLibraryAnnotations(f.files.get(zh.annotationPath).text, zh.annotationPath, () => ({})).records[0].roles, ["translation_quote", "personal_note"]);
		await f.service.createAnnotation(selection(f, "zh-CN"), { manualText: "detached annotation" });
		assert.equal(f.files.get(f.enPath).text, f.en); assert.equal(f.files.get(f.zhPath).text, f.zh); assert.ok(f.writes.every(p => p.startsWith("wiki/annotations/")));
	});
	await check("unmapped Chinese AI stops before provider; English uses its actual source and separate knowledge", async () => {
		const f = await make(); await assert.rejects(f.service.generateExplanation(selection(f, "zh-CN"), () => {}), /尚未确认对应英文/); assert.equal(f.calls.length, 0);
		await f.service.generateExplanation(selection(f, "en"), () => {}); assert.equal(f.calls.length, 1); assert.match(f.calls[0].messages[0].content, /手动双栏未确认/); assert.match(f.calls[0].messages[0].content, /一般知识／解释性推断/); assert.ok(!f.calls[0].messages[1].content.includes(f.zh));
	});
	await check("either file mutation and forged pairing prevent saving or evidence navigation", async () => {
		const f = await make(), s = selection(f, "zh-CN"), r = await f.service.createExcerpt(s);
		f.files.get(f.enPath).text += "\nchanged"; await assert.rejects(f.service.createExcerpt(s), /版本已变化/); await assert.rejects(new api.ExcerptLibraryService(f.app).openSource(r), /版本已变化/);
		f.files.get(f.enPath).text = f.en; const forged = structuredClone(s); forged.bilingual.files.en = "Research/Other.md"; await assert.rejects(f.service.createExcerpt(forged), /缺失|变化/);
	});
	await check("library reads chosen paths outside catalog roots without promoting paper verification", async () => {
		const f = await make(), r = await f.service.createExcerpt(selection(f, "zh-CN"));
		const io = { read: async p => f.files.get(p)?.text === undefined ? null : Buffer.from(f.files.get(p).text), list: async root => { const entries = new Map(); for (const p of f.files.keys()) { if (!p.startsWith(root + "/")) continue; const rest = p.slice(root.length + 1), name = rest.split("/")[0]; entries.set(name, { name, directory: rest.includes("/") || f.files.get(p)?.text === undefined }); } return [...entries.values()]; } };
		const scan = () => api.readPaperLibrary(io, { read: async () => null, list: async () => [] }, { vaultRoot: path.resolve("manual-memory"), parseYaml: () => ({}) });
		const before = (await scan()).papers.flatMap(p => p.objects).find(o => o.kind === "annotation" && o.annotationPath === r.annotationPath); assert.ok(before); assert.equal(before.binding.state, "unresolved"); assert.match(before.binding.reason, /手动配对/);
		f.files.get(f.zhPath).text += "\nchanged"; const after = (await scan()).papers.flatMap(p => p.objects).find(o => o.kind === "annotation" && o.annotationPath === r.annotationPath); assert.equal(after.binding.state, "changed");
	});
	await check("renamed same-directory metadata enables structure only when names, version and blocks match", async () => {
		const metadata = (en, e, z) => JSON.stringify({ schemaVersion: 1, sourceFile: e.split("/").pop(), translationFile: z.split("/").pop(), sourceVersion: { algorithm: "sha256", value: hash(en) }, status: "needs-review", humanReview: "not-reviewed" });
		const f = await make("Study/original.md", "Study/translation.md", metadata); assert.equal(f.doc.syncAvailable, true); assert.ok(selection(f, "zh-CN").bilingual.english); assert.equal(f.doc.humanReview, "not-reviewed");
		await f.service.createExcerpt(selection(f, "zh-CN")); f.files.get("Study/translation.json").text += "\n"; await assert.rejects(f.service.createExcerpt(selection(f, "zh-CN")), /变化/);
	});
	await check("unrelated metadata cannot retarget selected files; root files and damaged records remain readable", async () => {
		const f = await make("english.md", "中文.md", () => JSON.stringify({ schemaVersion: 1, sourceFile: "../outside.md", translationFile: "中文.md" })); assert.equal(f.doc.syncAvailable, false); assert.deepEqual(f.doc.selectedFiles, { en: "english.md", zh: "中文.md" });
		f.files.get("translation.json").text = "invalid"; assert.equal((await api.loadSelectedBilingualDocument(new FileSourceStorage(), f.doc.selectedFiles)).pairs.length, 0);
		await assert.rejects(api.loadSelectedBilingualDocument(new FileSourceStorage(), { en: "../outside.md", zh: "中文.md" }), /请选择/);
	});
	await check("manual layout restores validated pairs and progress; invalid combinations never open", async () => {
		const state = normalizeManualSplit({ mode: "md-pdf", left: "Notes/body.md", right: "Attachments/source.pdf", entry: "Attachments/source.pdf", ratio: 0.9, linked: true, pdfPage: 7, markdownProgress: 0.4, pdfProgress: 0.6 });
		assert.equal(state.ratio, 0.7); assert.equal(state.pdfPage, 7); assert.equal(state.markdownProgress, 0.4); assert.equal(state.entry, state.right);
		for (const r of [{ left: "same.md", right: "same.md", mode: "bilingual" }, { left: "../outside.md", right: "file.pdf" }, { left: "a.md", right: "C:/source.pdf" }, { left: "a.md", right: "file.md" }]) assert.throws(() => normalizeManualSplit(r), /组合无效/);
		assert.ok(supportsPdfExcerpt("Attachments/paper.pdf")); assert.ok(supportsPdfExcerpt("paper.pdf")); assert.ok(!supportsPdfExcerpt("../paper.pdf"));
	});
	await check("PDF position survives CSS teardown during plugin reload", async () => {
		const { SplitPdfPane } = loadReading("views/split-pdf-pane.ts", { obsidian: { Component: class {}, TFile } });
		const scroller = { scrollTop: 270, clientHeight: 100, scrollHeight: 1000 }, pane = new SplitPdfPane({}, {}, {}, scroller, new AbortController().signal, () => {}); pane.canvas = {};
		assert.equal(pane.progress, 0.3); scroller.clientHeight = scroller.scrollHeight; scroller.scrollTop = 0; assert.equal(pane.progress, 0.3);
	});
	console.log(`MANUAL_SPLIT_READING_OK (${count} groups; memory IO, no cleanup or real model calls)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
