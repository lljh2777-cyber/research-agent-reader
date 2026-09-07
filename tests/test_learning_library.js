const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { sessionLearningDocuments, LearningLibrary, learningTextHash } = loadReading("curation/learning.ts");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
const source = { kind: "article", path: "papers/a/article.md", fingerprint: "a".repeat(64), title: "Paper" };
const a = createReadingSession(source); const n = addReadingNode(a, null); n.status = "done"; n.title = "Topic"; n.content = "Exact learning answer";
const b = structuredClone(a); b.id = "other"; const demo = structuredClone(a); demo.id = "demo"; demo.purpose = "test";
(async () => {
	assert.equal(sessionLearningDocuments(demo).length, 0); assert.equal(sessionLearningDocuments({ ...a, demo: true }).length, 0);
	assert.equal(learningTextHash("a\n b"), learningTextHash("a b")); assert.notEqual(learningTextHash("5 mg"), learningTextHash("5 μg"));
	const app = { vault: { getMarkdownFiles: () => [{ path: "wiki/qa/old.md", basename: "old" }, { path: "wiki/qa/demo.md", basename: "demo" }, { path: "wiki/sources/paper.md" }], cachedRead: async () => "# Prior learning\nTopic explanation" }, metadataCache: { getFileCache: f => ({ frontmatter: f.basename === "demo" ? { reading_session: "demo" } : {} }) } };
	const library = new LearningLibrary(app, { ready: async () => {}, repository: { sessions: new Map([[a.id, a], [b.id, b], [demo.id, demo]]) } }, { read: async () => null, write: async () => {} }, { embed: async () => { throw new Error("no network"); }, rerank: async () => { throw new Error("no network"); } }, () => "lexical");
	const docs = await library.documents(); assert.equal(docs.length, 3); assert(!docs.some(doc => doc.path.startsWith("wiki/sources/"))); assert(!docs.some(doc => doc.path.includes("demo")));
	const result = await library.find(a, [n.id]); assert(result.matches.some(hit => hit.relation === "exact-text" && hit.sessionId === b.id)); assert(result.matches.every(hit => hit.sessionId !== a.id));
	b.nodes[0].content = "Changed answer"; const updated = await library.find(a, [n.id]); assert(!updated.matches.some(hit => hit.relation === "exact-text"));
	library.dispose(); console.log("LEARNING_LIBRARY_OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
