const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
class TFile { constructor(path) { this.path = path; } }
const { createReadingSession, addReadingNode, addReadingBranch } = loadReading("reading/session.ts");
const { exportReading, readingExportContent, safeReadingMarkdown } = loadReading("reading/export.ts", { obsidian: { TFile } });
(async () => {
	const session = createReadingSession({ kind: "article", path: "papers/a/article.md", fingerprint: "a".repeat(64), title: "学习论文" });
	const main = addReadingNode(session, null); main.status = "done"; main.content = "主线结论 [text-0-0]。[[papers/a/article]] ![外部图](https://example.com/track.png)";
	main.evidence = [{ id: "text-0-0", kind: "paper", path: "papers/a/article.md", text: "source", label: "原文", page: 2 }];
	const branch = addReadingBranch(session, main.id); const node = addReadingNode(session, branch.id, "支线问题"); node.status = "done"; node.content = "支线内容";
	const exported = readingExportContent(session, "branch", node.id); assert.match(exported, /支线内容/); assert.ok(!exported.includes("主线结论"));
	const all = readingExportContent(session, "session", node.id); assert.ok(!all.includes("[[papers/")); assert.match(all, /papers\/a\/article.md/);
	assert.ok(!safeReadingMarkdown("<script>alert(1)</script>\n```dataviewjs\napp.vault.delete(x)\n```\n![[papers/a]]").includes("```dataviewjs"));
	const files = new Map(); const app = { vault: { getAbstractFileByPath: (name) => files.has(name) ? new TFile(name) : null,
		createFolder: async (name) => files.set(name, "folder"), create: async (name, text) => { assert.ok(!files.has(name)); files.set(name, text); return new TFile(name); },
		process: async (file, transform) => files.set(file.path, transform(files.get(file.path))) } };
	const [one, two] = await Promise.all([exportReading(app, session, "session", node.id), exportReading(app, session, "session", node.id)]);
	assert.notEqual(one.path, two.path); assert.ok(files.get("wiki/log.md").includes(one.path.slice(0, -3))); assert.ok(!files.has("papers/a/article.md"));
	console.log("READING_EXPORT_OK");
})().catch((e) => { console.error(e); process.exitCode = 1; });
