"use strict";
// In-memory fixtures; no HTTP, files, credentials or deletion.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { chunkDocument, contentHash, paperScope, inKnowledgeScope, retrievalTerms } = loadReading("retrieval/chunks.ts");
const { encodeIndex, decodeIndex } = loadReading("retrieval/store.ts");
const { KnowledgeRetrievalService } = loadReading("retrieval/service.ts");
const { BgeModels } = loadReading("retrieval/models.ts");
const { EMBEDDING_MODEL } = loadReading("retrieval/types.ts");
const makeDoc = (file, title, text, extras = {}) => ({ path: file, title, text, hash: contentHash(text), aliases: [], doi: "", year: "", authors: "", origins: [file], depth: "abstract-level", basis: "vault", ...extras });
const vector = () => Float32Array.from([1, ...Array(1023).fill(0)]);
async function main() {
	const paper = makeDoc("wiki/sources/alpha_work_2020.md", "Alpha paper", "---\nprivate: ignored\n---\n# Alpha\n## 方法\n采用 alpha 测量细胞。\n```python\n# not a heading\nprint('alpha')\n```\n## 发散思考\nalpha 可以尝试新课题。\n", { year: "2020", authors: "First Alpha", doi: "10.1234/example" });
	const other = makeDoc("wiki/sources/beta_work_2021.md", "Beta", "# Beta\n## 方法\n另一篇 alpha 数据表。", { year: "2021", authors: "Beta" });
	const parts = chunkDocument(paper);
	assert(!parts.some((part) => part.input.includes("private:")));
	assert(parts.find((part) => part.heading.endsWith("方法")).text.includes("# not a heading"));
	assert.equal(parts.find((part) => part.heading.endsWith("发散思考")).role, "speculation");
	assert.deepEqual(paperScope("Alpha 2020 的表格", [paper, other]), [paper.path]);
	assert.deepEqual(paperScope("compare Alpha 2020 and Beta 2021", [paper, other]), [paper.path, other.path]);
	assert.deepEqual(paperScope("Gamma 2019 的数据", [paper, other]), []);
	assert.deepEqual(paperScope("10.1234/example", [paper, other]), [paper.path]);
	assert.equal(paperScope("什么是细胞", [paper, other]), null);
	assert.equal(paperScope("papers published in 2020", [paper, other]), null);
	assert(!inKnowledgeScope("wiki/qa/generated.md")); assert(!inKnowledgeScope("papers/key/article.md"));
	assert(!retrievalTerms("Which assay measures the amount of RNA?").includes("the"));
	const snapshot = { version: 1, model: EMBEDDING_MODEL, updated: "now", vectors: new Map([[parts[0].vectorKey, vector()]]), documentHashes: { [paper.path]: paper.hash } };
	const encoded = encodeIndex(snapshot); const decoded = decodeIndex(encoded);
	assert.equal(decoded.vectors.get(parts[0].vectorKey)[0], 1); assert.equal(encoded.length < 6000, true);
	assert.throws(() => decodeIndex(encoded.subarray(0, encoded.length - 1)), /结构/);
	const corrupt = Buffer.from(encoded); corrupt.writeFloatLE(NaN, corrupt.length - 4); assert.throws(() => decodeIndex(corrupt), /损坏/);

	let docs = [paper, other]; let saved = null; let failSave = false; let embeddings = 0; let failModels = false; const sent = [];
	const store = { async read() { return saved; }, async write(value) { if (failSave) throw new Error("disk full"); saved = { ...value, vectors: new Map(value.vectors) }; } };
	const models = { async embed(input) { if (failModels) throw new Error("offline"); embeddings += input.length; return input.map(vector); }, async rerank(query, input) { if (failModels) throw new Error("offline"); sent.push(input); return input.map((_, index) => ({ index, score: 1 - index / 100 })); } };
	const service = new KnowledgeRetrievalService(async () => docs, store, models, () => "hybrid");
	const first = service.update(); assert.equal(service.update(), first); await first;
	assert.equal(service.status.state, "ready"); const count = embeddings; await service.update(); assert.equal(embeddings, count, "Unchanged content must reuse vectors");
	const scoped = await service.search("alpha 数据表", { identityQuery: "Alpha 2020 的数据表" });
	assert(scoped.hits.length); assert(scoped.hits.every((hit) => hit.path === paper.path));
	assert(scoped.hits.every((hit) => hit.role !== "speculation")); assert(sent.at(-1).every((input) => !input.includes("另一篇")));
	const missing = await service.search("alpha", { paperPaths: [] }); assert.equal(missing.hits.length, 0);
	docs = [makeDoc(paper.path, paper.title, "# Alpha\n## 方法\nalpha 新测量结果。", { year: "2020" }), other];
	const changed = await service.inspect(); assert.equal(changed.changed, 1); assert(changed.done < changed.total);
	const fresh = await service.search("alpha"); assert(fresh.hits.some((hit) => hit.text.includes("新测量"))); assert(!fresh.hits.some((hit) => hit.text.includes("print(")));
	const before = embeddings; await service.update(); assert.equal(embeddings - before, 1, "Only changed chunk should be embedded");
	failModels = true; const fallback = await service.search("alpha"); assert.equal(fallback.mode, "lexical"); assert(fallback.warnings.some((line) => line.includes("回退"))); failModels = false;
	const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(service.search("alpha", { signal: cancelled.signal }), /abort/i);
	failSave = true; await assert.rejects(service.update(), /disk full/); assert.equal(service.status.state, "error"); failSave = false;
	// Changes while the model is running must not return old evidence.
	const racing = new KnowledgeRetrievalService(async () => docs, store, { ...models, async rerank(query, input) { const result = await models.rerank(query, input); docs = []; return result; } }, () => "rerank");
	const raced = await racing.search("alpha"); assert.equal(raced.hits.length, 0); assert(raced.warnings.some((warning) => warning.includes("发生变化")));
	service.dispose(); racing.dispose();
	// Stop after the first saved batch; resume must only send the remaining inputs.
	const long = makeDoc("wiki/sources/long.md", "Long", Array.from({ length: 20 }, (_, i) => "## Section " + i + "\nContent " + i + "\n").join("\n"));
	let checkpoint = null; const batches = [];
	const resumable = new KnowledgeRetrievalService(async () => [long], { read: async () => checkpoint, write: async value => { checkpoint = { ...value, vectors: new Map(value.vectors) }; } }, { ...models, embed: async inputs => { batches.push(inputs.length); return inputs.map(vector); } }, () => "hybrid");
	const unsubscribe = resumable.subscribe(() => { if (resumable.status.done === 16) resumable.stop(); }); await resumable.update(); unsubscribe();
	assert.equal(resumable.status.state, "interrupted"); assert.equal(checkpoint.vectors.size, 16);
	await resumable.update(); assert.equal(resumable.status.state, "ready"); assert.deepEqual(batches, [16, 4]); resumable.dispose();

	const requests = []; let response = null;
	const adapter = new BgeModels(() => "synthetic", { async request(options) { requests.push(options); return { json: response }; } });
	response = { model: EMBEDDING_MODEL, data: [{ index: 0, embedding: Array.from(vector()) }] };
	assert.equal((await adapter.embed(["alpha"]))[0].length, 1024);
	assert.equal(requests[0].url, "https://api.siliconflow.cn/v1/embeddings"); assert(!("dimensions" in requests[0].body));
	response = { results: [{ index: 0, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }] };
	await assert.rejects(adapter.rerank("alpha", ["alpha", "beta"]), /索引/);
	response = { data: [{ index: 0, embedding: [1, 2] }] }; await assert.rejects(adapter.embed(["alpha"]), /维度/);
	console.log("KNOWLEDGE_RETRIEVAL_OK");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
