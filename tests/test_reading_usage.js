const assert = require("node:assert/strict");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { createReadingSession, addReadingNode, validateReadingSession } = loadReading("reading/session.ts");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { measuredReadingCall, readingUsageTotals, readingUsageSummary } = loadReading("reading/usage.ts");
(async () => {
	const storage = memoryStorage(); const repo = new ReadingRepository(storage);
	const s = createReadingSession({ kind: "pdf", path: "a.pdf", fingerprint: "a".repeat(64), title: "paper" }); const n = addReadingNode(s, null); await repo.add(s);
	const request = { system: "rules", prompt: "question", images: [], signal: new AbortController().signal };
	const backend = { name: "mock", model: "test", images: false, complete: async r => { r.onUsage({ input: 0, output: 12, cachedInput: 0 }); return "answer"; } };
	await measuredReadingCall(repo, s.id, n.id, "answer", backend, request);
	assert.equal(readingUsageTotals(repo.get(s.id).nodes).unknownInput, 0); assert.equal(repo.get(s.id).nodes[0].usage[0].input, 0);
	backend.complete = async r => { r.onUsage({ input: -1, output: NaN }); throw new Error("offline"); };
	await assert.rejects(measuredReadingCall(repo, s.id, n.id, "selection", backend, request), /offline/);
	assert.equal(repo.get(s.id).nodes[0].usage[1].state, "failed"); assert.equal(readingUsageTotals(repo.get(s.id).nodes).unknownInput, 1);
	const abort = new AbortController(); backend.complete = async () => { abort.abort(); throw new Error("aborted"); };
	await assert.rejects(measuredReadingCall(repo, s.id, n.id, "memory", backend, { ...request, signal: abort.signal }));
	assert.equal(repo.get(s.id).nodes[0].usage[2].state, "interrupted");
	await repo.transact(s.id, d => { d.nodes[0].usage[0].state = "running"; });
	const restored = new ReadingRepository(storage); await restored.load(); assert.equal(restored.get(s.id).nodes[0].usage[0].state, "interrupted");
	const invalid = structuredClone(restored.get(s.id)); delete invalid.nodes[0].usage[0].estimatedInput; assert.throws(() => validateReadingSession(invalid), /用量/);
	assert.match(readingUsageSummary({ nodes: [{ status: "done" }] }), /1 个旧回答/);
	storage.fail = true; let sent = false; backend.complete = async () => { sent = true; return "x"; };
	await assert.rejects(measuredReadingCall(repo, s.id, n.id, "answer", backend, request), /disk full/); assert.equal(sent, false); storage.fail = false;

	// An answer failure reuses only validated selection; model/context/source changes invalidate it.
	await repo.transact(s.id, d => { d.outline = ["问题", "方法"]; });
	const evidence = [{ id: "text-1-0", kind: "paper", path: "a.pdf", label: "Page one", text: "Evidence", page: 1 }];
	let verified = 0; let selections = 0; let answers = 0; let failAnswer = true;
	const workspace = { repository: repo, document: async () => ({ evidence, catalog: "text-1-0 Page one", verify: async () => { verified++; }, image: async () => null }) };
	backend.complete = async r => {
		if (!JSON.parse(r.prompt).output) { selections++; return JSON.stringify({ ids: ["text-1-0"], query: "question", needsVisual: false }); }
		answers++; r.onUsage({ input: 200, output: 30 }); if (failAnswer) throw new Error("answer interrupted");
		return JSON.stringify({ title: "问题", content: "证据解释 [text-1-0]", evidenceIds: ["text-1-0"], outline: ["问题", "方法"], mainSummary: "问题", completed: false });
	};
	const engine = new ReadingEngine(workspace, () => backend);
	await assert.rejects(engine.generate(s.id, n.id)); await assert.rejects(engine.generate(s.id, n.id));
	assert.equal(selections, 1); assert.equal(answers, 2); assert.equal(verified, 2); assert.equal(readingUsageTotals(repo.get(s.id).nodes).cacheHits, 1);
	backend.model = "changed"; await assert.rejects(engine.generate(s.id, n.id)); assert.equal(selections, 2);
	await repo.transact(s.id, d => { d.teachingStyle = "methods"; }); await assert.rejects(engine.generate(s.id, n.id)); assert.equal(selections, 3);
	await repo.transact(s.id, d => { d.source.fingerprint = "b".repeat(64); }); await assert.rejects(engine.generate(s.id, n.id)); assert.equal(selections, 4);
	failAnswer = false; await engine.generate(s.id, n.id); assert.equal(selections, 4); assert.equal(repo.get(s.id).nodes[0].status, "done");
	assert.equal(readingUsageTotals(repo.get(s.id).nodes).cacheHits, 2);
	const other = createReadingSession(s.source); other.outline = ["问题", "方法"]; const otherNode = addReadingNode(other, null); await repo.add(other); await engine.generate(other.id, otherNode.id);
	assert.equal(selections, 5); assert.equal(repo.get(other.id).nodes[0].usage.length, 2);
	console.log("READING_USAGE_OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
