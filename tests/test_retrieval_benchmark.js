"use strict";
// Synthetic data, an in-memory filesystem and a fake HTTPS transport only.
// No credentials, network requests, disk writes or cleanup.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const benchmark = require("../scripts/retrieval-benchmark.cjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const doc = (name, text) => ({ path: "wiki/methods/" + name + ".md", basename: name, text, hash: hash(text), metadata: { frontmatter: { title: name } }, mtime: 100 });

async function main() {
	const source = doc("alpha", "---\ntitle: private-metadata\n---\n# Alpha\n正文🙂 " + "重要证据 long passage。".repeat(300) + "\n\n## Limits\n短结论\n\n### Evidence\n本文依据。\n");
	const chunks = benchmark.chunksFor(source);
	assert(chunks.length > 2);
	assert(chunks.every((chunk) => chunk.end - chunk.start <= benchmark.CONFIG.chunkChars));
	assert(chunks.every((chunk) => source.text.slice(chunk.start, chunk.end).includes(chunk.text)));
	assert(chunks.every((chunk) => !chunk.input.includes("private-metadata")));
	assert(chunks.some((chunk) => chunk.text === "短结论" && chunk.heading === "Alpha / Limits"));
	assert(chunks.some((chunk) => chunk.heading === "Alpha / Limits / Evidence"));
	assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);
	assert.deepEqual(benchmark.chunksFor(source), chunks);
	const coverage = new Set(chunks.flatMap((chunk) => Array.from({ length: chunk.end - chunk.start }, (_, i) => i + chunk.start)));
	const firstBody = source.text.indexOf("正文"); const lastBody = source.text.indexOf("\n\n## Limits");
	for (let i = firstBody; i < lastBody; i++) assert(coverage.has(i), "Lost body at " + i);
	assert(benchmark.scoped("wiki/sources/paper.md"));
	for (const excluded of ["wiki/qa/answer.md", "wiki/annotations/a.md", "papers/key/article.md", "wiki/sources-else/a.md", "wiki/sources/.hidden/a.md"]) assert(!benchmark.scoped(excluded));

	const questions = [{ id: "Q1", split: "dev", family: "alpha", query: "alpha", noAnswer: false, evidence: [{ path: source.path, quote: "短结论" }] },
		{ id: "Q2", split: "heldout", family: "absent", query: "absent", noAnswer: true, evidence: [], absenceReason: "No measured values" }];
	benchmark.validateQuestions(questions, [source]);
	assert.throws(() => benchmark.validateQuestions([...questions, questions[0]], [source]), /duplicate/);
	assert.throws(() => benchmark.validateQuestions([{ ...questions[0], evidence: [{ path: source.path, quote: "invented fact" }] }], [source]), /Unverified/);
	assert.throws(() => benchmark.validateQuestions([{ ...questions[1], absenceReason: "" }], [source]), /rationale/);
	assert.throws(() => benchmark.validateQuestions([{ ...questions[0], evidence: [{ path: source.path, quote: "" }] }], [source]), /Unverified/);
	assert.throws(() => benchmark.validateQuestions([questions[0], { ...questions[1], family: "alpha" }], [source]), /crosses/);
	const rankings = { Q1: [{ path: "other" }, { path: "other" }, { path: source.path }], Q2: [{ path: "other" }] };
	assert.deepEqual(benchmark.metrics(questions, rankings, 2), { questions: 1, hit: 1, referenceRecall: 1, mrr: 0.5 });
	assert.equal(benchmark.metrics(questions, {}, 5).hit, 0);
	assert.equal(benchmark.metrics([questions[1]], rankings, 5).hit, null);
	const fused = benchmark.fuse([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]]);
	assert.equal(fused[0].id, "b"); assert.equal(fused.length, 3);
	assert.equal(benchmark.fuse([[{ id: "a" }, { id: "a" }]])[0].score, 1 / 61);
	assert.throws(() => benchmark.normalize([1, 2]), /dimensions/);
	assert.throws(() => benchmark.normalize(Array(1024).fill(0)), /Zero/);
	assert.throws(() => benchmark.normalize(Array(1024).fill(NaN)), /values/);
	const normalized = benchmark.normalize([3, 4, ...Array(1022).fill(0)]);
	assert.equal(normalized[0], 0.6); assert.equal(normalized[1], 0.8);
	const candidates = [{ id: "a", path: "a.md" }, { id: "b", path: "a.md" }, { id: "c", path: "c.md" }];
	const results = [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }, { index: 2, relevance_score: 0.5 }];
	assert.deepEqual(benchmark.docRanking(results, candidates).map((r) => [r.path, r.score]), [["a.md", 0.9], ["c.md", 0.5]]);
	assert.throws(() => benchmark.docRanking([results[0], results[0], results[2]], candidates), /duplicate/);
	assert.throws(() => benchmark.docRanking([{ index: 0.5, relevance_score: 1 }], [candidates[0]]), /Invalid/);
	assert.throws(() => benchmark.docRanking([{ index: 0, relevance_score: NaN }], [candidates[0]]), /Invalid/);

	const entry = path.resolve(__dirname, "../scripts/retrieval-benchmark.cjs");
	const out = path.join(os.tmpdir(), "retrieval-memory-output"); const vaultRoot = path.join(os.tmpdir(), "retrieval-memory-vault");
	const store = new Map(); const writes = []; const requests = []; let badEmbedding = false; let httpStatus = 200;
	const fakeFs = {
		async mkdir() {},
		async readFile(filename, encoding) {
			if (store.has(filename)) return encoding ? store.get(filename) : Buffer.from(store.get(filename));
			if (filename.startsWith(out) || filename.startsWith(vaultRoot)) { const error = new Error("Missing memory fixture"); error.code = "ENOENT"; throw error; }
			return fs.readFile(filename, encoding);
		},
		async writeFile(filename, value, options) {
			assert(filename.startsWith(out + path.sep), "Unexpected source write");
			if (options?.flag === "wx" && store.has(filename)) { const error = new Error("Already exists"); error.code = "EEXIST"; throw error; }
			writes.push(filename); store.set(filename, String(value));
		},
		async rename(from, to) { assert(store.has(from)); store.set(to, store.get(from)); store.delete(from); },
	};
	const fakeHttps = { request(url, options, callback) {
		assert(url.startsWith("https://api.siliconflow.cn/v1/")); assert.equal(options.headers.Authorization, "Bearer synthetic-credential");
		const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = (error) => req.emit("error", error);
		req.end = (text) => queueMicrotask(() => {
			const body = JSON.parse(text); requests.push(body);
			const response = new EventEmitter(); response.setEncoding = () => {}; response.statusCode = httpStatus; callback(response);
			let value;
			if (url.endsWith("/embeddings")) {
				assert.equal(body.model, "BAAI/bge-m3"); assert(!Object.hasOwn(body, "dimensions"));
				value = { model: body.model, data: body.input.map((input, index) => ({ index: badEmbedding ? 0 : index, embedding: [1, ...Array(1023).fill(0)] })) };
			} else {
				assert.equal(body.model, "BAAI/bge-reranker-v2-m3");
				value = { results: body.documents.map((document, index) => ({ index, relevance_score: 1 / (index + 1) })) };
			}
			response.emit("data", JSON.stringify(value)); response.emit("end");
		}); return req;
	} };
	const loaded = new Module(entry, module); loaded.filename = entry; loaded.paths = Module._nodeModulePaths(path.dirname(entry)); const original = loaded.require.bind(loaded);
	loaded.require = (name) => name === "node:fs/promises" ? fakeFs : name === "node:https" ? fakeHttps : name === "node:timers/promises" ? { setTimeout: async () => {} } : original(name);
	loaded._compile(await fs.readFile(entry, "utf8"), entry); const runner = loaded.exports;
	const docs = [doc("alpha", "# alpha\n短结论及来源。 Alpha facts are recorded here."), doc("beta", "# beta\nBeta has different measured values.")];
	for (const d of docs) store.set(path.join(vaultRoot, d.path), d.text);
	const app = { vault: { adapter: { getBasePath: () => vaultRoot }, getMarkdownFiles: () => docs.map((d) => ({ path: d.path, basename: d.basename, stat: { mtime: d.mtime } })), read: async (file) => docs.find((d) => d.path === file.path).text }, metadataCache: { getFileCache: (file) => docs.find((d) => d.path === file.path).metadata } };
	await assert.rejects(runner.capture(app, vaultRoot), /outside/);
	await runner.capture(app, out); store.set(path.join(out, "questions.json"), JSON.stringify(questions));
	await runner.prepare(out);
	const frozen = store.get(path.join(out, "protocol.json"));
	const baseline = JSON.parse(store.get(path.join(out, "baseline.json")));
	assert.equal(baseline.runs.Q1[0].path, docs[0].path);
	await assert.rejects(runner.prepare(out), /Already exists/);
	await assert.rejects(runner.runOnline(out, ""), /Missing/);
	httpStatus = 401; await assert.rejects(runner.runOnline(out, "synthetic-credential"), /HTTP 401/); httpStatus = 200;
	assert.equal(JSON.parse(store.get(path.join(out, "online.json"))).status, "incomplete");
	badEmbedding = true; await assert.rejects(runner.runOnline(out, "synthetic-credential"), /index mismatch/); badEmbedding = false;
	const completed = await runner.runOnline(out, "synthetic-credential");
	assert.equal(completed.status, "complete"); assert.equal(completed.integrity.unchanged, true);
	const callCount = requests.length; await runner.runOnline(out, "synthetic-credential"); assert.equal(requests.length, callCount, "Resume should reuse completed results");
	const online = JSON.parse(store.get(path.join(out, "online.json"))); assert.equal(Object.keys(online.hybridRerank).length, questions.length);
	assert.equal(store.get(path.join(out, "protocol.json")), frozen);
	assert([...store.values()].every((value) => !value.includes("synthetic-credential")), "Credential leaked into artifacts");
	const chunkFile = path.join(out, "chunks.json"); const originalChunks = store.get(chunkFile); store.set(chunkFile, originalChunks.replace("Alpha facts", "Altered facts"));
	await assert.rejects(runner.runOnline(out, "synthetic-credential"), /Frozen protocol/); store.set(chunkFile, originalChunks);
	store.set(path.join(vaultRoot, docs[0].path), "modified elsewhere");
	assert.equal((await runner.writeReport(out)).integrity.unchanged, false);
	assert(writes.length > 0); console.log("RETRIEVAL_BENCHMARK_OK (chunking, scope, labels, metrics, ranking, offline/online, credentials, failures, resume, integrity)");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
