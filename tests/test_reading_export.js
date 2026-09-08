const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
class TFile { constructor(path) { this.path = path; } }
const { createReadingSession, addReadingNode, addReadingBranch } = loadReading("reading/session.ts");
const { exportReading, readingExportContent, safeReadingMarkdown, reviewReadingExport, readingExportHash } = loadReading("reading/export.ts", { obsidian: { TFile } });
const { contentHash } = loadReading("retrieval/chunks.ts");
(async () => {
	const session = createReadingSession({ kind: "article", path: "papers/a/article.md", fingerprint: "a".repeat(64), title: "学习论文" });
	const main = addReadingNode(session, null); main.status = "done"; main.content = "主线结论 [text-0-0]。[[papers/a/article]] ![外部图](https://example.com/track.png)";
	main.evidence = [{ id: "text-0-0", kind: "paper", path: "papers/a/article.md", text: "source", label: "原文", page: 2 }];
	const branch = addReadingBranch(session, main.id); const node = addReadingNode(session, branch.id, "支线问题"); node.status = "done"; node.content = "支线内容";
	const exported = readingExportContent(session, "branch", node.id); assert.match(exported, /支线内容/); assert.ok(!exported.includes("主线结论"));
	const all = readingExportContent(session, "session", node.id); assert.ok(!all.includes("[[papers/")); assert.match(all, /papers\/a\/article.md/);
	assert.ok(!safeReadingMarkdown("<script>alert(1)</script>\n```dataviewjs\napp.vault.delete(x)\n```\n![[papers/a]]").includes("```dataviewjs"));
	const files = new Map(); const app = { vault: { getAbstractFileByPath: (name) => files.has(name) ? new TFile(name) : null,
		getMarkdownFiles: () => [...files.keys()].filter(name => name.endsWith(".md")).map(name => new TFile(name)), cachedRead: async file => files.get(file.path),
		createFolder: async (name) => files.set(name, "folder"), create: async (name, text) => { assert.ok(!files.has(name)); files.set(name, text); return new TFile(name); },
		process: async (file, transform) => files.set(file.path, transform(files.get(file.path))) } };
	const [one, two] = await Promise.all([exportReading(app, session, "session", node.id), exportReading(app, session, "session", node.id)]);
	assert.equal(one.path, two.path); assert.equal(two.reused, true); assert.ok(files.get("wiki/log.md").includes(one.path.slice(0, -3))); assert.ok(!files.has("papers/a/article.md"));
	const original = files.get(one.path); files.set(one.path, original + "\n手工补充应保留\n");
	const again = await exportReading(app, session, "session", node.id); assert(again.reused); assert(files.get(one.path).includes("手工补充"));
	const reviewed = await reviewReadingExport(app, session, "session", node.id); assert.equal(reviewed.duplicate.path, one.path);
	main.content += "\n新增结论。";
	await assert.rejects(exportReading(app, session, "session", node.id, { expectedHash: reviewed.hash }), /变化/);
	const revision = await exportReading(app, session, "session", node.id); assert.notEqual(revision.path, one.path); assert(files.get(revision.path).includes("reading_revision_of:")); assert(files.get(one.path).includes("手工补充"));
	const current = await reviewReadingExport(app, session, "session", node.id); assert.equal(current.history.length, 2);
	const linked = "wiki/sources/related.md"; files.set(linked, "相关来源正文");
	const options = { related: [linked, "papers/a/article.md", "wiki/sources/../wrong.md", "wiki/sources/bad|link.md"], relatedHashes: { [linked]: contentHash("相关来源正文") } };
	const associated = await exportReading(app, session, "session", node.id, options);
	assert(files.get(associated.path).includes("[[wiki/sources/related]]")); assert(!files.get(associated.path).includes("[[papers/")); assert(!files.get(associated.path).includes("[[wiki/sources/../"));
	files.set(linked, "关联已修改"); await assert.rejects(exportReading(app, session, "session", node.id, options), /关联笔记已变化/);
	const hash = readingExportHash(session, "session", node.id); session.ui.zoom = 2; assert.equal(readingExportHash(session, "session", node.id), hash);
	const beforeFailure = files.size; const oldCreate = app.vault.create; app.vault.create = async () => { throw new Error("disk full"); }; node.content += "changed";
	await assert.rejects(exportReading(app, session, "session", node.id), /disk full/); assert.equal(files.size, beforeFailure); app.vault.create = oldCreate;
	await assert.rejects(exportReading(app, session, "session", node.id, {}, async () => { throw new Error("receipt failed"); }), /receipt failed/); assert.equal(files.size, beforeFailure);
	let receipt; const tracked = await exportReading(app, session, "session", node.id, {}, async value => { assert(!files.has(value.path)); receipt = value; });
	assert.equal(receipt.path, tracked.path); assert.equal(receipt.hash, contentHash(files.get(tracked.path)));
	await exportReading(app, session, "session", node.id, {}, async value => { assert.equal(value.reused, true); assert.equal(value.hash, contentHash(files.get(value.path))); });
	console.log("READING_EXPORT_OK");
})().catch((e) => { console.error(e); process.exitCode = 1; });
