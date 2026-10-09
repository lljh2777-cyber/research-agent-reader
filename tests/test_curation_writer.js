// Memory-only vault and journals: no deletion, network, or real note writes.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { CurationService } = loadReading("curation/service.ts");
const { CurationWriter, curationNoteText } = loadReading("curation/writer.ts");
const { contentHash } = loadReading("retrieval/chunks.ts");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
async function fixture() {
	const source = { kind: "article", path: "papers/a/article.md", fingerprint: "a".repeat(64), title: "Paper A" };
	const session = createReadingSession(source, "fake", "model"); const node = addReadingNode(session, null); Object.assign(node, { status: "done", title: "范围", content: "配对样本" });
	node.evidence = [{ id: "text-a", kind: "paper", path: source.path, text: "该方法仅在配对样本上验证。", label: "原文" }];
	const targetPath = "wiki/concepts/a.md"; const original = "---\ntitle: Paper A\ntitle_zh: 论文甲\nstatus: abstract-level\n---\n# Paper A\n\n## 方法\n已有概述。\n\n## 链接\n[[wiki/methods/a]]\n";
	const files = new Map([[targetPath, original], ["研究主题索引.md", "# 主题\n"], ["wiki/log.md", "# 日志\n"]]); const events = []; let failure = ""; let race = false;
	const app = { vault: { getFileByPath: path => files.has(path) ? { path, basename: path.split("/").at(-1).slice(0, -3) } : null, cachedRead: async f => files.get(f.path),
		process: async (f, fn) => { if (failure === f.path) throw new Error("write failed"); if (race && f.path === targetPath) files.set(f.path, files.get(f.path) + "manual"); const next = fn(files.get(f.path)); files.set(f.path, next); events.push(f.path); },
		create: async (path, text) => { if (files.has(path)) throw new Error("exists"); files.set(path, text); events.push(path); } }, metadataCache: { getFileCache: () => ({ frontmatter: { title: "Paper A" } }) } };
	const workspace = { ready: async () => {}, repository: { get: () => session }, document: async () => ({ source, evidence: node.evidence, verify: async () => {} }) };
	const records = new Map(); let failJournal = false; let failDecisions = false;
	const store = { list: async kind => [...records.keys()].filter(k => k.startsWith(kind + ":")).map(k => k.split(":")[1]), read: async (kind, id) => structuredClone(records.get(kind + ":" + id)), write: async (kind, record) => { if ((failJournal && kind === "revisions") || (failDecisions && kind === "reviews" && record.suggestions.some(s => s.decision === "applied"))) throw new Error("disk full"); records.set(kind + ":" + record.id, structuredClone(record)); } };
	const backend = { name: "Fake", model: "model", images: false, complete: async req => { const body = JSON.parse(req.prompt); return JSON.stringify({ suggestions: [{ kind: "add", claim: "适用范围", reason: "核对原文", text: node.evidence[0].text, paragraphId: body.target.paragraphs[0].id, citations: [{ id: "P1", quote: node.evidence[0].text }] }] }); } };
	const service = new CurationService(app, workspace, store, () => backend); const review = await service.generate(await service.prepare(session.id, [node.id], targetPath)); const writer = new CurationWriter(service);
	return { service, writer, review, files, events, targetPath, original, app, workspace, store, backend, setFailure: v => { failure = v; }, setJournal: v => { failJournal = v; }, setDecisions: v => { failDecisions = v; }, setRace: () => { race = true; } };
}
async function main() {
	let f = await fixture(); let preview = await f.writer.preview(f.review.id, ["s-0"]); assert.equal(f.events.length, 0); assert.equal(preview.writes.length, 3);
	const text = preview.writes[0].after; assert(text.startsWith(f.original.split("## 方法")[0])); assert(text.includes("[[wiki/methods/a]]")); assert(!text.includes("[[papers/")); assert(text.includes("` papers/a/article.md `"));
	await f.writer.apply(preview); await f.writer.apply(preview); assert.equal(f.events.filter(p => p === f.targetPath).length, 1); assert.equal(f.service.reviews.get(f.review.id).suggestions[0].decision, "applied");
	await assert.rejects(f.writer.preview(f.review.id, ["s-0"]), /修订记录/);
	const undo = await f.writer.previewUndo(preview.id); await f.writer.applyUndo(undo); assert.equal(f.files.get(f.targetPath), f.original); assert(f.files.get("研究主题索引.md").includes("[[wiki/concepts/a]]")); assert(f.files.get("wiki/log.md").includes("撤销"));
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); f.files.set(f.targetPath, f.original + "用户修改"); await assert.rejects(f.writer.apply(preview), /变化/); assert.equal(f.events.length, 0);
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); f.files.set("wiki/log.md", "new log"); await assert.rejects(f.writer.apply(preview), /变化/); assert.equal(f.events.length, 0);
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); f.setJournal(true); await assert.rejects(f.writer.apply(preview), /disk full/); assert.equal(f.events.length, 0);
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); f.setFailure("wiki/log.md"); await assert.rejects(f.writer.apply(preview), /write failed/); assert.equal(f.service.revisions.get(preview.id).state, "recovery"); const after = f.files.get(f.targetPath);
	f.setFailure(""); const reload = new CurationService(f.app, f.workspace, f.store, () => f.backend); await reload.ready(); await new CurationWriter(reload).resume(preview.id); assert.equal(f.files.get(f.targetPath), after); assert.equal(after.split("依据：").length, 2); assert.equal(reload.revisions.get(preview.id).state, "applied");
	f.files.set(f.targetPath, after + "手工补充"); await assert.rejects(new CurationWriter(reload).previewUndo(preview.id), /后续编辑/);
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); f.setDecisions(true); await assert.rejects(f.writer.apply(preview), /disk full/); assert.equal(f.service.revisions.get(preview.id).state, "applied"); f.setDecisions(false); await f.writer.resume(preview.id); assert.equal(f.service.reviews.get(f.review.id).suggestions[0].decision, "applied");
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); f.setRace(); await assert.rejects(f.writer.apply(preview), /写入前文件已变化/); assert.equal(f.events.length, 0);
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); const log = preview.writes.find(w => w.role === "log"); log.after = "overwrite log"; log.afterHash = contentHash(log.after); await f.service.saveRevision(preview); await assert.rejects(f.writer.resume(preview.id), /日志修改/); assert.equal(f.events.length, 0);
	f = await fixture(); preview = await f.writer.preview(f.review.id, ["s-0"]); preview.writes[0].path = "papers/a/article.md"; await f.service.saveRevision(preview); await assert.rejects(f.writer.resume(preview.id), /路径越界/); assert.equal(f.events.length, 0);
	f = await fixture(); f.files.set("研究主题索引.md", "[[wiki/concepts/a]]"); f.files.delete("wiki/log.md"); preview = await f.writer.preview(f.review.id, ["s-0"]); assert.equal(preview.writes.length, 2); await f.writer.apply(preview); assert(f.files.get("wiki/log.md").startsWith("# 知识库维护日志"));
	assert.throws(() => curationNoteText(f.review, ["s-0", "s-0"]), /请选择/);
	console.log("CURATION_WRITER_OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
