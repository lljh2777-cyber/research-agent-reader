// In-memory protocol and corpus; no HTTP, file writes or cleanup.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");
const hash = value => require("node:crypto").createHash("sha256").update(value).digest("hex");
const entry = path.resolve(__dirname, "../scripts/production-retrieval-check.cjs");
const root = path.join(os.tmpdir(), "curation-vault-memory"); const frozen = path.join(os.tmpdir(), "curation-frozen-memory"); const out = path.join(os.tmpdir(), "curation-output-memory");
const doc = { path: "wiki/sources/paper.md", text: "Known evidence", hash: hash("Known evidence") };
const questions = [{ id: "Q1", query: "evidence?", split: "heldout", noAnswer: false, evidence: [{ path: doc.path, quote: doc.text }] }, { id: "Q2", query: "absent?", split: "heldout", noAnswer: true, evidence: [] }];
const files = new Map([[path.join(frozen, "corpus.json"), JSON.stringify({ docs: [doc] })], [path.join(frozen, "questions.json"), JSON.stringify(questions)], [path.join(frozen, "protocol.json"), JSON.stringify({ questionHash: hash(JSON.stringify(questions)) })]]);
const fakeFs = { mkdir: async () => {}, realpath: async name => path.resolve(name), readFile: async name => files.get(name) || Buffer.from("synthetic bundle"), writeFile: async (name, text, options) => { assert(name.startsWith(out + path.sep)); if (options?.flag === "wx" && files.has(name)) throw new Error("exists"); files.set(name, text); } };
const loaded = new Module(entry, module); loaded.filename = entry; loaded.paths = Module._nodeModulePaths(path.dirname(entry)); const original = loaded.require.bind(loaded);
loaded.require = name => name === "node:fs/promises" ? fakeFs : original(name); loaded._compile(fs.readFileSync(entry, "utf8"), entry);
const app = { vault: { adapter: { getBasePath: () => root }, getFileByPath: () => doc, cachedRead: async () => doc.text }, plugins: { plugins: { "research-agent-reader": { settings: { knowledgeRetrievalMode: "hybrid" }, manifest: { version: "test", dir: ".obsidian/plugins/test" }, getKnowledgeService: () => ({ inspect: async () => ({ documents: 1, total: 1, done: 1, changed: 0 }), search: async () => ({ mode: "hybrid", scope: [doc.path], hits: [{ path: doc.path, text: doc.text }] }) }) } } } };
(async () => {
	await assert.rejects(loaded.exports(app, frozen, path.join(root, "forbidden")), /outside/);
	const result = await loaded.exports(app, frozen, out); assert.equal(result.heldout.hit, 1); assert.equal(result.noAnswerCases, 1); assert.equal(result.strictQuoteHits, 1);
	assert(files.has(path.join(out, "report.md"))); assert.equal(JSON.parse(files.get(path.join(out, "progress.json"))).done, 2);
	const fixtures = require("./fixtures/curation-counterexamples.json"); assert(fixtures.length >= 12); assert.equal(new Set(fixtures.map(f => f.id)).size, fixtures.length); assert(fixtures.every(f => f.existing && f.proposed && f.evidence && f.expected));
	console.log("PRODUCTION_RETRIEVAL_CHECK_OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
