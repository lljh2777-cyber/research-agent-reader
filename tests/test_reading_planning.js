// Memory fixtures only; no filesystem writes, provider requests or cleanup.
const assert = require("node:assert/strict");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { createReadingSession, addReadingNode, addReadingBranch, validateReadingSession } = loadReading("reading/session.ts");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { validateModulePlan, currentReadingModule } = loadReading("reading/planning.ts");
const { readingCatalog } = loadReading("reading/document.ts");
const evidence = ["Introduction", "Methods", "Limitations"].map((label, i) => ({ id: `text-${i + 1}-0`, kind: "paper", path: "a.pdf", label, text: label + " original material" }));
const modules = [
	{ title: "全文总览", question: "本文解决什么问题，如何展开？", evidenceIds: [evidence[0].id, evidence[2].id] },
	{ title: "方法设计", question: "方法为什么能检验研究问题？", evidenceIds: [evidence[1].id] },
	{ title: "总结与边界", question: "证据支持到哪里，还有什么缺口？", evidenceIds: [evidence[2].id] },
];
const plan = { version: 1, modules };
async function fixture(kind = "pdf") {
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const s = createReadingSession({ kind, title: "paper", path: kind === "pdf" ? "a.pdf" : "papers/a/article.md", fingerprint: "a".repeat(64) });
	const n = addReadingNode(s, null); await repo.add(s);
	const document = { evidence, catalog: readingCatalog(evidence), verify: async () => {}, image: async () => null };
	const workspace = { repository: repo, document: async () => document };
	const requests = [];
	const backend = { name: "mock", model: "test", images: false, complete: async request => {
		const input = JSON.parse(request.prompt); requests.push({ input, schema: request.schema });
		if (input.action === "规划全文路线") {
			assert(input.catalog.includes("Limitations")); assert(input.catalog.includes("Methods"));
			return JSON.stringify({ modules });
		}
		if (input.catalog) {
			assert(repo.get(s.id).modulePlan, "plan must be durably saved before selection");
			return JSON.stringify({ ids: [input.currentModule?.evidenceIds[0] || evidence[0].id], query: input.currentUnit || "question", needsVisual: false });
		}
		assert(!("outline" in input.output)); assert(!("completed" in input.output));
		const index = input.currentModule?.number || 0;
		return JSON.stringify({ title: "model title", content: `Unit ${index} [text-1-0]`, evidenceIds: ["text-1-0"], mainSummary: `summary ${index}`, outline: ["forged"], completed: true });
	} };
	return { storage, repo, s, n, document, workspace, requests, backend, engine: new ReadingEngine(workspace, () => backend) };
}
(async () => {
	assert.deepEqual(validateModulePlan(plan, modules.map(m => m.title), new Set(evidence.map(e => e.id))), plan);
	for (const bad of [{ ...plan, modules: [] }, { ...plan, modules: [modules[0], modules[0]] }, { ...plan, modules: [{ ...modules[0], question: "" }, modules[1]] }, { ...plan, modules: [{ ...modules[0], evidenceIds: ["fake"] }, modules[1]] }]) assert.throws(() => validateModulePlan(bad, undefined, new Set(evidence.map(e => e.id))));
	assert.throws(() => validateModulePlan(plan, ["changed"]), /不一致/);
	for (const kind of ["pdf", "article"]) {
		const f = await fixture(kind);
		const complete = f.backend.complete; let fail = true;
		f.backend.complete = async r => { if (JSON.parse(r.prompt).action === "讲解当前主线单元" && fail) { fail = false; throw new Error("answer failed"); } return complete(r); };
		await assert.rejects(f.engine.generate(f.s.id, f.n.id), /answer failed/);
		assert.equal(f.repo.get(f.s.id).mainIds.length, 1); assert.equal(f.repo.get(f.s.id).nodes[0].status, "failed");
		assert.deepEqual(f.repo.get(f.s.id).modulePlan, plan); assert.equal(currentReadingModule(f.repo.get(f.s.id)).purpose, "overview");
		const reloaded = new ReadingRepository(f.storage); await reloaded.load(); f.workspace.repository = reloaded; f.repo = reloaded;
		const engine = new ReadingEngine(f.workspace, () => f.backend);
		await Promise.all([engine.generate(f.s.id, f.n.id), engine.generate(f.s.id, f.n.id)]);
		assert.equal(f.requests.filter(r => r.input.action === "规划全文路线").length, 1);
		assert.equal(reloaded.get(f.s.id).nodes[0].title, modules[0].title); assert.equal(reloaded.get(f.s.id).completed, false);
		assert.equal(reloaded.get(f.s.id).nodes[0].usage.filter(u => u.stage === "planning").length, 1);
		for (let i = 1; i < modules.length; i++) {
			const n = await reloaded.transact(f.s.id, s => addReadingNode(s, null));
			await engine.generate(f.s.id, n.id);
		}
		assert.equal(reloaded.get(f.s.id).completed, true);
		assert.deepEqual(f.requests.filter(r => r.input.action === "讲解当前主线单元").map(r => r.input.currentModule.purpose), ["overview", "module", "synthesis"]);
		const before = structuredClone(reloaded.get(f.s.id).outline);
		const branchNode = await reloaded.transact(f.s.id, s => addReadingNode(s, addReadingBranch(s, s.mainIds[0]).id, "再解释一下"));
		await engine.generate(f.s.id, branchNode.id);
		const branchInput = f.requests.at(-1).input;
		assert.equal(branchInput.currentModule, undefined); assert.equal(branchInput.outline, undefined); assert.equal(branchInput.completedUnits, undefined);
		assert.deepEqual(reloaded.get(f.s.id).outline, before);
		const corrupt = structuredClone(reloaded.get(f.s.id)); corrupt.outline[0] = "changed"; assert.throws(() => validateReadingSession(corrupt), /不一致/);
	}
	// No plan or progression can survive failed validation, source checks or cancellation.
	for (const mode of ["unknown", "source", "cancel", "storage"]) {
		const f = await fixture(); let calls = 0;
		f.backend.complete = async () => {
			calls++;
			if (mode === "source") f.document.verify = async () => { throw new Error("source changed"); };
			if (mode === "cancel") f.workspace.stopHandler(f.s.id, f.n.id);
			return JSON.stringify({ modules: mode === "unknown" ? [{ ...modules[0], evidenceIds: ["fake"] }, modules[1]] : modules });
		};
		if (mode === "storage") { const write = f.storage.write.bind(f.storage); f.storage.write = async (id, text) => { if (JSON.parse(text).modulePlan) throw new Error("plan save failed"); return write(id, text); }; }
		await assert.rejects(f.engine.generate(f.s.id, f.n.id));
		assert.equal(calls, 1); assert.equal(f.repo.get(f.s.id).modulePlan, undefined); assert.equal(f.repo.get(f.s.id).outline.length, 0); assert.equal(f.repo.get(f.s.id).mainIds.length, 1);
	}
	// Missing inline citations fail visibly; an explicit retry reuses the saved plan/selection.
	{
		const f = await fixture(); const complete = f.backend.complete; let attempts = 0;
		f.backend.complete = async r => {
			const input = JSON.parse(r.prompt); const raw = await complete(r);
			if (input.action !== "讲解当前主线单元") return raw;
			if (++attempts === 1) { assert.equal(input.validationFeedback, undefined); return JSON.stringify({ ...JSON.parse(raw), content: "缺少正文引用" }); }
			assert.match(input.validationFeedback, /证据标记/); return raw;
		};
		await assert.rejects(f.engine.generate(f.s.id, f.n.id), /正文缺少/);
		assert.equal(f.repo.get(f.s.id).nodes[0].status, "failed"); assert.equal(f.repo.get(f.s.id).completed, false); assert.equal(f.repo.get(f.s.id).mainSummary, "");
		await f.engine.generate(f.s.id, f.n.id);
		assert.equal(f.requests.filter(r => r.input.action === "规划全文路线").length, 1);
		assert.equal(f.requests.filter(r => r.input.catalog && r.input.action !== "规划全文路线").length, 1);
		assert.equal(f.repo.get(f.s.id).nodes[0].status, "done");
	}
	// Fully scanned sources require actual image input; never plan from page labels alone.
	for (const [count, vision, expected] of [[2, true, "planning reached"], [2, false, "视觉模型"], [4, true, "3 张图像"]]) {
		const f = await fixture(); let calls = 0;
		f.document.evidence = Array.from({ length: count }, (_, i) => ({ ...evidence[0], id: `page-${i + 1}`, asset: "pdf-page", text: "此页无可用文本层" }));
		f.document.catalog = readingCatalog(f.document.evidence); f.document.image = async e => ({ evidenceId: e.id, dataUrl: "data:image/png;base64,AA==" });
		f.backend.images = vision; f.backend.complete = async r => { calls++; assert.equal(r.images.length, count); assert.deepEqual(JSON.parse(r.prompt).images.map(i => i.evidenceId), ["page-1", "page-2"]); throw new Error("planning reached"); };
		await assert.rejects(f.engine.generate(f.s.id, f.n.id), new RegExp(expected)); assert.equal(calls, vision && count <= 3 ? 1 : 0);
	}
	console.log("READING_PLANNING_OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
