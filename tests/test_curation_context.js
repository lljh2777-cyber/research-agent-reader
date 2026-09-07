// In-memory PDF identity and large-session navigation checks. No files or models executed.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { prepareCuration } = loadReading("curation/context.ts");
const { curationChangeWindow, curationBatch } = loadReading("views/knowledge-curation.ts", { obsidian: { Modal: class {}, Notice: class {} } });
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
async function main() {
	const title = "A graph foundation model for spatial transcriptomics"; const file = { path: "wiki/sources/paper.md", basename: "paper" }; let metadataTitle = title;
	const source = { kind: "pdf", path: "papers/paper/_extraction/source.pdf", fingerprint: "a".repeat(64), title: "source" }; const session = createReadingSession(source, "fake", "fake");
	const node = addReadingNode(session, null); Object.assign(node, { title: "模型", content: "模型适用范围", status: "done" });
	const evidence = [{ id: "page-1", kind: "paper", path: source.path, page: 1, label: "第 1 页", text: "A graph foundation model\nfor spatial transcriptomics\nMethods were evaluated on paired samples." }];
	const app = { vault: { getFileByPath: p => p === file.path ? file : null, cachedRead: async () => "# Paper\n\n已有的有依据研究概述。\n" }, metadataCache: { getFileCache: () => ({ frontmatter: { title: metadataTitle } }) } };
	const workspace = { ready: async () => {}, repository: { get: () => session }, document: async () => ({ source, evidence, verify: async () => {} }) }; const backend = () => ({ name: "Fake", model: "fake", images: false });
	const context = await prepareCuration(app, workspace, backend, session.id, [node.id], file.path); assert(context.sourceCompatible, "first-page title supports PDF identity, not its generic basename");
	metadataTitle = "Another foundation model unrelated to the selected paper"; assert(!(await prepareCuration(app, workspace, backend, session.id, [node.id], file.path)).sourceCompatible);
	await assert.rejects(prepareCuration(app, workspace, backend, session.id, [node.id, "2", "3", "4"], file.path), /一至三个/);
	const long = structuredClone(session); long.nodes = Array.from({ length: 300 }, (_, i) => ({ ...node, id: "n-" + i, branchId: i < 150 ? null : "branch" }));
	assert.equal(curationBatch(long, "n-299").length, 150); assert(curationBatch(long, "n-299").every(n => n.branchId === "branch"));
	const before = "---\ntitle: Preserve\n---\n# Title\n\nContext\n\nParagraph\n\nFooter\n"; const after = before.replace("Paragraph", "Paragraph\n\nNew evidence");
	const changed = curationChangeWindow(before, after); assert(!changed.after.includes("title: Preserve")); assert(changed.after.includes("New evidence")); assert(!changed.before.includes("New evidence")); assert.equal(before.split("title: Preserve").length, 2);
	console.log("CURATION_CONTEXT_OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
