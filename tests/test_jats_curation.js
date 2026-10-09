"use strict";
// Production assistant/curation/writer over source-bound JATS, memory vault and simulated models.
const assert = require("node:assert/strict"), path = require("node:path"), { loadReading, memoryStorage } = require("./reading-test-helpers"), f = require("./jats-wiki-fixtures.cjs");
const { openStructuredDocument } = loadReading("reading/structured-document.ts");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
const { ReadingAssistantService } = loadReading("assistant/service.ts"), { validateAssistantRun } = loadReading("assistant/store.ts");
const { CurationService, validatedReview } = loadReading("curation/service.ts", { obsidian: f.obsidian });
const { CurationWriter } = loadReading("curation/writer.ts", { obsidian: f.obsidian });
const { verifyCurationContext } = loadReading("curation/context.ts", { obsidian: f.obsidian });
const { structuredTargetCompatible } = loadReading("reading/structured-reference.ts");
const { contentHash } = loadReading("retrieval/chunks.ts");
const step = (tool, args) => JSON.stringify({ step: { tool, arguments: args } });
(async () => {
	const x = await f.fixture(), draft = await x.generate(), saved = await x.service.save(draft.request.id, draft.draft.digest), target = saved.notePath, originalNote = x.notes.get(target);
	let decoded = 0, calls = 0, writeCalls = 0, failLog = false, afterWrite;
	const doc = await openStructuredDocument(path.resolve("synthetic-vault"), `papers/${x.key}/article.md`, x.source, async () => { decoded++; return "data:image/png;base64,TEST"; });
	const s = createReadingSession(doc.source, "fixture", "synthetic"), n = addReadingNode(s, null), text = doc.evidence.find(e => e.text.includes("This synthetic abstract") && !e.asset), image = doc.evidence.find(e => e.asset);
	Object.assign(n, { status: "done", title: "合成方法验证", question: "核对已读来源", content: "模拟学习回答，不代表真实科学结论。", evidence: [text, { ...image, visualInspected: true }] });
	x.notes.set("文献索引.md", "# 文献索引\n"); x.notes.set("wiki/log.md", "# 日志\n");
	const file = p => x.notes.has(p) ? { path: p, basename: p.split("/").pop().slice(0, -3) } : null;
	const app = { vault: { getFileByPath: file, cachedRead: async f => x.notes.get(f.path), create: async (p, text) => { assert.ok(!x.notes.has(p)); x.notes.set(p, text); writeCalls++; await afterWrite?.(p); },
		process: async (f, update) => { if (failLog && f.path === "wiki/log.md") throw Error("disk full"); const before = x.notes.get(f.path), after = update(before); x.notes.set(f.path, after); if (after !== before) writeCalls++; await afterWrite?.(f.path); } },
		metadataCache: { getFileCache: f0 => ({ frontmatter: f.obsidian.parseYaml(/^---\n([\s\S]*?)\n---/.exec(x.notes.get(f0.path))?.[1] || "") }) } };
	const workspace = { ready: async () => {}, repository: { get: () => s }, document: async () => doc };
	const metadata = app.metadataCache.getFileCache(file(target)).frontmatter;
	assert.ok(structuredTargetCompatible(s.source, target, metadata));
	for (const patch of [{ doi: "10.9999/different" }, { pmid: "987654321" }, { source_version: "PMC123.2" }, { source_projection_id: "f".repeat(64) }, { source_manifest_digest: "f".repeat(64) }]) assert.ok(!structuredTargetCompatible(s.source, target, { ...metadata, ...patch }));
	assert.ok(structuredTargetCompatible(s.source, target, { title: metadata.title, doi: metadata.doi }));
	assert.ok(!structuredTargetCompatible(s.source, "wiki/sources/unrelated.md", { title: metadata.title }));
	const storage = memoryStorage(); let assistantCalls = 0;
	const deps = { workspace, backend: () => ({ name: "synthetic", model: "synthetic", images: false, complete: async req => {
		assistantCalls++; assert.equal(req.images.length, 0); const p = JSON.parse(req.prompt), last = p.history.at(-1);
		if (!last) return step("read_node", { nodeId: n.id });
		if (last.data.request.tool === "read_node") return step("read_evidence", { ids: JSON.parse(last.data.result).references.map(e => e.id) });
		if (last.data.request.tool === "read_evidence") return step("search_knowledge", { query: "合成方法" });
		if (last.data.request.tool === "search_knowledge") return step("prepare_action", { kind: "curation", nodeIds: [n.id], scope: "node", target: JSON.parse(last.data.result).candidates[0].id });
		return step("final", { answer: "仅为验收回答，已读文字 [S1]，图注仍需人工看图核对 [S2]；准备了操作卡，未改写 Wiki。", citations: ["S1", "S2"] });
	} }), search: async () => ({ mode: "lexical", warnings: [], hits: [{ path: target, title: metadata.title, text: originalNote, start: 0, end: originalNote.length, hash: contentHash(originalNote), heading: "", role: "论文依据", depth: "abstract-level" }] }), readFile: async p => x.notes.get(p), learning: async () => ({ matches: [], warnings: [] }), outcomes: async () => new Map() };
	const assistant = new ReadingAssistantService(deps, storage), run = await assistant.start(s.id, n.id, "fixture", "核对来源后准备整理");
	assert.equal(run.state, "done"); assert.equal(decoded, 0); assert.equal(run.source.kind, "structured"); assert.equal(run.sources.length, 2); assert.ok(run.sources[1].structured.resourceId); assert.equal(run.sources[0].page, undefined); assert.equal(writeCalls, 0);
	const restored = new ReadingAssistantService(deps, storage); await restored.ready(); assert.equal(restored.errors.length, 0); assert.deepEqual(restored.runs.get(run.id).sources, JSON.parse(JSON.stringify(run.sources))); assert.equal(assistantCalls, 5);
	for (const corrupt of [r => delete r.source, r => r.sources[0].page = 1, r => r.sources[0].end++, r => r.sources[0].structured.xmlPath += "/bad[1]", r => r.sources[1].structured.resourceId = "images/forged.png", r => r.source.fingerprint = "f".repeat(64)]) { const r = structuredClone(run); corrupt(r); assert.throws(() => validateAssistantRun(r)); }
	let handoffs = 0; await restored.dispatch(run.id, run.actions[0].id, a => { assert.equal(a.target, target); handoffs++; }); assert.equal(handoffs, 1); assert.equal(writeCalls, 0);
	const records = new Map(), store = { list: async kind => [...records.keys()].filter(k => k.startsWith(kind + "/")).map(k => k.split("/")[1]), read: async (kind, id) => structuredClone(records.get(kind + "/" + id)), write: async (kind, record) => records.set(kind + "/" + record.id, structuredClone(record)) };
	const backend = { name: "synthetic", model: "synthetic", images: true, complete: async req => { calls++; assert.equal(req.images.length, 1); const p = JSON.parse(req.prompt), e = p.evidence.find(e => e.id.startsWith("P"));
		return JSON.stringify({ suggestions: [{ kind: "add", paragraphId: p.target.paragraphs[0].id, claim: "测试补充", text: "此处为合成验收补充，不表示真实科研发现。", reason: "仅验证编辑流程。", citations: [{ id: e.id, quoteId: e.quotes[0].id }] }] }); } };
	let service = new CurationService(app, workspace, store, () => backend), writer = new CurationWriter(service);
	const context = await service.prepare(s.id, [n.id], target); assert.ok(context.sourceCompatible); assert.ok(context.evidence.every(e => e.structured && e.evidenceId && e.page === undefined));
	x.notes.set(target, originalNote.replace(metadata.doi, "10.9999/unrelated")); const mismatch = await service.prepare(s.id, [n.id], target); assert.equal(mismatch.sourceCompatible, false); await assert.rejects(service.generate(mismatch), /不一致|匹配/); assert.equal(calls, 0); x.notes.set(target, originalNote);
	assert.ok(context.evidence.find(e => e.visual).structured.resourceId); assert.ok(context.prompt.includes("无 PDF 页码"));
	const review = await service.generate(context); assert.equal(review.state, "ready"); assert.equal(calls, 1); assert.equal(decoded, 1); assert.ok(review.suggestions[0].applicable); assert.equal((await service.generate(context)).id, review.id); assert.equal(calls, 1);
	for (const corrupt of [r => delete r.context.evidence[0].structured, r => r.context.evidence[0].page = 1, r => r.context.evidence[0].end++, r => r.context.evidence[0].structured.projectionId = "a".repeat(64), r => r.context.evidence.find(e => e.visual).visual = false]) { const r = structuredClone(review); corrupt(r); assert.throws(() => validatedReview(r)); }
	const forged = structuredClone(context); forged.evidence[0].text = "x".repeat(forged.evidence[0].text.length); await assert.rejects(verifyCurationContext(app, workspace, forged), /不一致/);
	const preview = await writer.preview(review.id, [review.suggestions[0].id]); assert.equal(writeCalls, 0); assert.ok(preview.writes[0].after.includes("JATS PMC123.1")); assert.ok(!preview.writes[0].after.includes("[[papers/"));
	x.notes.set(target, originalNote + "\n用户编辑\n"); await assert.rejects(writer.apply(preview), /变化/); assert.equal(writeCalls, 0); x.notes.set(target, originalNote);
	failLog = true; await assert.rejects(writer.apply(preview), /disk full/); assert.equal(service.revisions.get(preview.id).state, "recovery"); const appliedNote = x.notes.get(target); assert.equal(appliedNote.split("---")[1], originalNote.split("---")[1]);
	await service.dispose(); failLog = false; service = new CurationService(app, workspace, store, () => backend); writer = new CurationWriter(service); await service.ready(); assert.equal(service.errors.length, 0);
	await writer.resume(preview.id); const count = writeCalls; await writer.resume(preview.id); assert.equal(writeCalls, count); assert.equal(calls, 1); assert.equal(x.notes.get(target), appliedNote);
	const xmlPath = `papers/${x.key}/_source/article.xml`, xml = x.source.files.get(xmlPath); x.source.files.set(xmlPath, Buffer.from("changed")); service.noteChange(xmlPath); assert.equal(service.changesPending, true);
	await service.inspect(); assert.ok(service.revisions.get(preview.id).needsReview); await assert.rejects(restored.dispatch(run.id, run.actions[0].id, () => { handoffs++; }), /修改|缺失/); assert.equal(handoffs, 1);
	// History remains readable while live source checks block new actions. Undo restores owned text, even if source is unavailable.
	assert.equal(validateAssistantRun(JSON.parse(storage.files.get(run.id))).sources[0].text, text.text);
	x.notes.set(target, appliedNote + "\n用户后续编辑\n"); await assert.rejects(writer.previewUndo(preview.id), /后续编辑/); x.notes.set(target, appliedNote);
	const undo = await writer.previewUndo(preview.id); await writer.applyUndo(undo); assert.equal(x.notes.get(target), originalNote); assert.equal(calls, 1); x.source.files.set(xmlPath, xml);
	// A source change after the target write stops the remaining batch; restoring exact source permits recovery.
	const freshContext = await service.prepare(s.id, [n.id], target), fresh = await service.generate(freshContext, true), next = await writer.preview(fresh.id, [fresh.suggestions[0].id]);
	afterWrite = async p => { if (p === target) x.source.files.set(xmlPath, Buffer.from("late edit")); }; await assert.rejects(writer.apply(next), /修改|缺失/); assert.equal(service.revisions.get(next.id).state, "recovery");
	afterWrite = undefined; x.source.files.set(xmlPath, xml); await writer.resume(next.id); assert.equal(service.revisions.get(next.id).state, "applied"); assert.equal(calls, 2);
	await writer.applyUndo(await writer.previewUndo(next.id));
	const finalContext = await service.prepare(s.id, [n.id], target), finalReview = await service.generate(finalContext, true), finalPlan = await writer.preview(finalReview.id, [finalReview.suggestions[0].id]);
	afterWrite = async p => { if (p === target) x.notes.set(p, x.notes.get(p) + "\n用户在写入批次中编辑\n"); };
	await assert.rejects(writer.apply(finalPlan), /后续编辑/); assert.ok(x.notes.get(target).endsWith("用户在写入批次中编辑\n")); assert.equal(service.revisions.get(finalPlan.id).state, "recovery");
	await service.dispose(); await restored.dispose(); await assistant.dispose(); await x.service.dispose(); await doc.destroy();
	console.log("JATS_CURATION_OK: assistant snapshot/tool/action/reload, source identity/version conflicts, text/image provenance, cached review, edit refusal, per-write validation, recovery and undo; all writes memory-only");
})().catch(error => { console.error(error); process.exitCode = 1; });
