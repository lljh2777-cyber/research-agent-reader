"use strict";
// All fixtures and persistence are in memory. No filesystem cleanup or live API calls.
const assert = require("node:assert/strict");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { createReadingSession, addReadingNode, addReadingBranch } = loadReading("reading/session.ts");
const { ReadingAssistantService } = loadReading("assistant/service.ts");
const { AssistantTools, assistantContext } = loadReading("assistant/tools.ts");
const { validateAssistantRun } = loadReading("assistant/store.ts");
const { ASSISTANT_CAPABILITIES, parseAssistantStep } = loadReading("assistant/capabilities.ts");
const { contentHash } = loadReading("retrieval/chunks.ts");
const step = (tool, args) => JSON.stringify({ step: { tool, arguments: args } });
function fixture() {
	const s = createReadingSession({ kind: "pdf", path: "a.pdf", fingerprint: "a".repeat(64), title: "Paper" }, "p", "m");
	const n = addReadingNode(s, null); Object.assign(n, { status: "done", title: "Method", content: "Explanation", learningState: "revisit" });
	n.evidence = [{ id: "text-1-0", kind: "paper", path: "a.pdf", label: "Page 1", text: "observed", page: 1 }];
	const raw = "Original formal note"; const path = "wiki/sources/a.md";
	const hit = { id: "chunk", path, title: "A", text: raw, start: 0, end: raw.length, hash: contentHash(raw), heading: "", role: "evidence", depth: "abstract-level" };
	let calls = 0; let impl = async () => step("final", { answer: "完成", citations: [] });
	const backend = { name: "mock", model: "m", images: false, complete: async request => { calls++; request.onUsage?.({ input: 200, output: 50 }); return impl(request, calls); } };
	const deps = { workspace: { ready: async () => {}, repository: { get: id => { assert.equal(id, s.id); return s; } }, document: async () => ({ source: s.source, evidence: n.evidence, verify: async () => {} }) }, backend: () => backend,
		search: async () => ({ mode: "hybrid", warnings: [], hits: [hit] }), readFile: async p => { assert.equal(p, path); return raw; }, learning: async () => ({ matches: [], warnings: [] }), outcomes: async () => new Map([[n.id, [{ label: "已导出", path: "wiki/qa/a.md" }]]]) };
	const storage = memoryStorage(); const service = new ReadingAssistantService(deps, storage);
	return { s, n, deps, storage, service, path, backend, set: f => { impl = f; calls = 0; }, calls: () => calls };
}
async function toolsFor(f) {
	const run = await f.service.start(f.s.id, f.n.id, "p", "查看状态");
	return { run, tools: new AssistantTools(f.deps, structuredClone(f.s), run, new AbortController().signal) };
}
(async () => {
	assert.equal(new Set(ASSISTANT_CAPABILITIES.map(c => c.name)).size, 8);
	assert.throws(() => parseAssistantStep(step("delete_file", {})), /未知/);
	assert.throws(() => parseAssistantStep(step("read_node", { nodeId: "x", path: "secret" })), /未授权/);
	assert.throws(() => parseAssistantStep(step("read_node", {})), /参数/);
	assert.throws(() => parseAssistantStep("bad"), /JSON/);
	const f = fixture();
	f.s.mainSummary = "frozen background"; const branch = addReadingBranch(f.s, f.n.id); const bn = addReadingNode(f.s, branch.id, "branch question"); bn.status = "done";
	f.s.mainSummary = "new unrelated background"; const sibling = addReadingBranch(f.s, f.n.id); const sn = addReadingNode(f.s, sibling.id); sn.status = "done"; sn.content = "sibling private conversation";
	const context = assistantContext(f.s, bn.id); assert.match(context.background, /frozen background/); assert.doesNotMatch(JSON.stringify(context), /new unrelated|sibling private/);
	branch.summary = "long dialogue".repeat(3000); const longContext = assistantContext(f.s, bn.id); assert.match(longContext.background, /frozen background/); assert.ok(longContext.background.length < 7000); branch.summary = "";
	const { run, tools } = await toolsFor(f);
	assert.equal(run.calls[0].input, 200); assert.ok(run.calls[0].estimatedInput > 0); assert.equal(run.state, "done");
	assert.equal(validateAssistantRun(JSON.parse(f.storage.files.get(run.id))).id, run.id);
	for (const patch of [{ actions: [null] }, { sources: [{}] }, { citations: ["S9"] }, { calls: [{ state: "done", estimatedInput: -1 }] }]) assert.throws(() => validateAssistantRun({ ...run, ...patch }));
	assert.equal(JSON.parse((await tools.execute("reading_context", { state: "revisit", offset: 0 })).output).total, 1);
	assert.equal((await tools.execute("reading_context", { state: "revisit", offset: 0 })).cached, true);
	await assert.rejects(tools.execute("read_node", { nodeId: "another-session" }), /不属于/);
	await assert.rejects(tools.execute("read_evidence", { ids: ["forged"] }), /未由/);
	const refs = JSON.parse((await tools.execute("read_node", { nodeId: f.n.id })).output).references;
	await assert.rejects(tools.execute("read_evidence", { ids: [refs[0].id, "forged"] })); assert.equal(run.sources.length, 0, "failed evidence read is atomic");
	const original = JSON.parse((await tools.execute("read_evidence", { ids: [refs[0].id] })).output).sources[0]; assert.equal(original.text, "observed"); assert.equal(original.page, 1);
	assert.equal((await tools.execute("read_evidence", { ids: [refs[0].id] })).cached, false); assert.equal(run.sources.length, 1);
	assert.match((await tools.execute("search_learning", { nodeId: f.n.id })).output, /不能作为/);
	assert.match((await tools.execute("outcomes", { nodeId: f.n.id })).output, /已导出/);
	const args = { kind: "curation", nodeIds: [f.n.id], target: f.path, scope: "node" };
	await assert.rejects(tools.execute("prepare_action", args), /检索/);
	const hits = JSON.parse((await tools.execute("search_knowledge", { query: "Method" })).output).candidates;
	const action = await tools.execute("prepare_action", args); assert.match(action.output, /尚未执行/);
	await tools.execute("prepare_action", args); assert.equal(run.actions.length, 1);
	await tools.execute("read_evidence", { ids: [hits[0].id] }); assert.equal(run.sources[1].kind, "knowledge");
	f.deps.readFile = async () => "modified"; await assert.rejects(tools.execute("read_evidence", { ids: [hits[0].id] }), /变化/);
	await assert.rejects(tools.execute("prepare_action", { ...args, target: "wiki/qa/a.md" }), /正式/);
	const g = fixture(); let candidate;
	g.set(async (request, count) => {
		const history = JSON.parse(request.prompt).history;
		if (count === 1) return step("read_node", { nodeId: g.n.id });
		if (count === 2) { candidate = JSON.parse(history[0].data.result).references[0].id; return step("read_evidence", { ids: [candidate] }); }
		return step("final", { answer: "原文 [S1]", citations: ["S1"] });
	});
	const result = await g.service.start(g.s.id, g.n.id, "p", "核对依据"); assert.equal(result.calls.length, 3); assert.equal(result.sources.length, 1); assert.equal(result.steps.length, 2);
	g.set(async () => step("final", { answer: "假的 [S99]", citations: ["S99"] })); await assert.rejects(g.service.start(g.s.id, g.n.id, "p", "test"), /未读取/);
	g.set(async () => "invalid"); await assert.rejects(g.service.start(g.s.id, g.n.id, "p", "test"), /JSON/); assert.equal(g.calls(), 1);
	g.storage.fail = true; const prior = g.calls(); await assert.rejects(g.service.start(g.s.id, g.n.id, "p", "test"), /disk full/); assert.equal(g.calls(), prior); g.storage.fail = false;
	let entered; const entering = new Promise(r => entered = r);
	g.set(request => new Promise((resolve, reject) => { entered(); request.signal.addEventListener("abort", () => reject(new Error("abort"))); }));
	const pending = g.service.start(g.s.id, g.n.id, "p", "wait"); await entering;
	await assert.rejects(g.service.start(g.s.id, g.n.id, "p", "duplicate"), /仍在运行/); g.service.stop(g.s.id); await assert.rejects(pending);
	assert.equal([...g.service.runs.values()].slice(-1)[0].state, "interrupted"); assert.equal(g.service.isRunning(g.s.id), false);
	const restored = { ...result, state: "running", calls: [{ state: "running", estimatedInput: 1 }] }; const restartStore = memoryStorage(); restartStore.files.set(restored.id, JSON.stringify(restored));
	const restart = new ReadingAssistantService(g.deps, restartStore); await restart.ready(); assert.equal(restart.runs.get(restored.id).state, "interrupted"); assert.equal(restart.runs.get(restored.id).calls[0].state, "interrupted");
	g.set(async () => step("reading_context", { state: "all", offset: 0 })); await assert.rejects(g.service.start(g.s.id, g.n.id, "p", "loop"), /上限|预算/); assert.ok(g.calls() <= 8);
	g.deps.workspace.document = async () => { throw new Error("source missing"); }; g.set(async () => "unused"); await assert.rejects(g.service.start(g.s.id, g.n.id, "p", "read"), /source missing/); assert.equal(g.calls(), 0);
	const h = fixture(); h.set(async (request, count) => count === 1 ? step("prepare_action", { kind: "advance", nodeIds: [h.n.id], target: "", scope: "node" }) : step("final", { answer: "已准备继续主线操作卡，尚未生成", citations: [] }));
	const ar = await h.service.start(h.s.id, h.n.id, "p", "continue"); let handoffs = 0;
	h.storage.fail = true; await assert.rejects(h.service.dispatch(ar.id, ar.actions[0].id, () => { handoffs++; })); assert.equal(handoffs, 0); h.storage.fail = false;
	await h.service.dispatch(ar.id, ar.actions[0].id, () => { handoffs++; }); assert.equal(handoffs, 1);
	await assert.rejects(h.service.dispatch(ar.id, ar.actions[0].id, () => { handoffs++; }), /已交接/); assert.equal(handoffs, 1);
	const restoredActions = new ReadingAssistantService(h.deps, h.storage); await restoredActions.ready(); await assert.rejects(restoredActions.dispatch(ar.id, ar.actions[0].id, () => {}), /已交接/);
	h.set(async (request, count) => count === 1 ? step("prepare_action", { kind: "export", nodeIds: [h.n.id], target: "", scope: "session" }) : step("final", { answer: "请查看导出预览", citations: [] }));
	const er = await h.service.start(h.s.id, h.n.id, "p", "export"); const actionId = er.actions[0].id;
	await h.service.dispatch(er.id, actionId, a => { assert.equal(a.scope, "session"); handoffs++; }); await h.service.dispatch(er.id, actionId, () => { handoffs++; }); assert.equal(handoffs, 3, "previews can reopen");
	const newBranch = addReadingBranch(h.s, h.n.id); const newNode = addReadingNode(h.s, newBranch.id, "new content"); newNode.status = "done";
	await assert.rejects(h.service.dispatch(er.id, actionId, () => { handoffs++; }), /变化/); assert.equal(handoffs, 3);
	await h.service.dispose(); await restoredActions.dispose();
	await Promise.all([f.service.dispose(), g.service.dispose(), restart.dispose()]);
	console.log("READING_ASSISTANT_OK: registry, frozen context, evidence, learning boundaries, actions, persistence, cancellation, budgets");
})().catch(e => { console.error(e); process.exitCode = 1; });
