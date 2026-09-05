const assert = require("node:assert/strict");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { createReadingSession, addReadingNode, validateReadingSession } = loadReading("reading/session.ts");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { readingCatalog } = loadReading("reading/document.ts");
(async () => {
	const storage = memoryStorage(); const repo = new ReadingRepository(storage);
	const create = () => { const s = createReadingSession({ kind: "pdf", path: "a.pdf", fingerprint: "a".repeat(64), title: "test" }); addReadingNode(s, null); return s; };
	const a = create(); const b = create(); await repo.add(a); await repo.add(b);
	const evidence = [{ id: "text-1-0", kind: "paper", path: "a.pdf", label: "Intro", text: "Evidence" }];
	let changed = false; let answerCalls = 0;
	const document = { evidence, catalog: readingCatalog(evidence), verify: async () => { if (changed) throw new Error("source changed"); }, image: async () => null };
	const backend = { images: false, name: "mock", model: "test", complete: async (r) => {
		const input = JSON.parse(r.prompt);
		if (input.catalog) return JSON.stringify({ ids: ["text-1-0"], needsVisual: false });
		answerCalls++; if (input.context === "change") changed = true;
		return JSON.stringify({ title: "unit", content: "Evidence [text-1-0]", evidenceIds: ["text-1-0"], outline: ["Intro"], mainSummary: "completed", completed: true });
	} };
	const workspace = { repository: repo, document: async () => document };
	const engine = new ReadingEngine(workspace, () => backend);
	await repo.transact(a.id, (s) => { s.mainSummary = "change"; });
	await assert.rejects(engine.generate(a.id, a.nodes[0].id), /source changed/);
	assert.equal(repo.get(a.id).nodes[0].status, "failed"); assert.equal(repo.get(b.id).nodes[0].status, "pending");
	changed = false; await engine.generate(b.id, b.nodes[0].id); assert.equal(repo.get(b.id).nodes[0].status, "done");
	assert.equal(answerCalls, 2);
	await repo.transact(a.id, (s) => { s.nodes[0].status = "running"; s.ui.mode = "map"; s.ui.drafts["main:" + s.nodes[0].id] = "draft"; s.ui.scrollY = 900; });
	storage.fail = true; const restored = new ReadingRepository(storage); await restored.load();
	assert.equal(restored.get(a.id).nodes[0].status, "interrupted"); assert.equal(restored.get(a.id).ui.scrollY, 900);
	assert.ok(restored.errors.some((error) => error.includes("disk full")));
	const invalid = structuredClone(b); invalid.ui.windows = null; assert.throws(() => validateReadingSession(invalid), /格式/);
	const catalog = readingCatalog(Array.from({ length: 300 }, (_, i) => ({ ...evidence[0], id: "text-" + i, text: "long evidence ".repeat(100) })));
	assert.ok(catalog.length <= 48000); assert.ok(catalog.includes("text-299 "));
	// A selected image cannot be silently treated as text evidence.
	changed = false; storage.fail = false; document.evidence = [{ ...evidence[0], asset: "page" }];
	await assert.rejects(engine.generate(a.id, a.nodes[0].id), /视觉能力/);
	console.log("READING_INTEGRATION_OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
