"use strict";
// Pure in-memory packages, sessions and model responses. No disk cleanup or model calls.
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading, memoryStorage } = require("./reading-test-helpers"), f = require("./jats-fixtures.cjs");
const { JatsIntakeService } = loadReading("jats/intake.ts"), { SourceCatalog } = loadReading("papers/catalog.ts");
const { openStructuredDocument, structuredSourcePath } = loadReading("reading/structured-document.ts");
const { createReadingSession, addReadingNode, addReadingBranch, validateReadingSession } = loadReading("reading/session.ts");
const { ReadingRepository } = loadReading("reading/store.ts"), { ReadingEngine, validateReadingResult } = loadReading("reading/engine.ts");
const { ReadingWorkspaceService } = loadReading("reading/workspace.ts"), { selectReadingEvidence } = loadReading("reading/document.ts");
const { readingExportContent, readingExportHash } = loadReading("reading/export.ts"), { sourceReadingDomain } = loadReading("reading/catalog.ts");
const { acceptsSourceFile, sourceDialogOptions } = loadReading("reading/source-picker.ts");
async function fixture() {
	const input = f.fixture(), acquired = await input.acquire(), storage = f.storage();
	const service = new JatsIntakeService({ deviceId: f.sha("device"), catalog: new SourceCatalog(storage), journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
	try { const p = await service.prepare(acquired.snapshot.jobId); const saved = await service.save(p.requestId, p.evidenceDigest, false); assert.equal(saved.phase, "saved", saved.error); return { storage, key: p.packageKey, acquired, input }; }
	finally { await service.dispose(); }
}
(async () => {
	const { storage, key, acquired } = await fixture(), root = path.resolve("synthetic-vault"), sourcePath = `papers/${key}/article.md`;
	let renders = 0;
	const render = async (bytes, mime) => { renders++; assert.ok(bytes.length); assert.equal(mime, "image/png"); return "data:image/png;base64,TEST"; };
	const doc = await openStructuredDocument(root, sourcePath, storage, render);
	assert.equal(doc.source.kind, "structured"); assert.equal(sourceReadingDomain(doc.source), "paper");
	assert.equal(doc.source.structured.manifest.projectionId, acquired.projection.projectionId);
	assert.equal(structuredSourcePath(root, path.join(root, sourcePath)), sourcePath);
	assert.throws(() => structuredSourcePath(root, path.join(root, "..", sourcePath)), /Vault/);
	await assert.rejects(openStructuredDocument(root, "papers/legacy/article.md", storage), /JATS/);
	assert.ok(acceptsSourceFile("structured", "article.md")); assert.ok(!acceptsSourceFile("structured", "source.pdf")); assert.deepEqual(sourceDialogOptions("structured", false, "", root).filters[0].extensions, ["md"]);
	for (const e of doc.evidence) { assert.equal(e.page, undefined); assert.equal(e.text, acquired.projection.markdown.slice(e.start, e.end)); assert.ok(e.structured.xmlEnd > e.structured.xmlStart); }
	const image = doc.evidence.find(e => e.asset), text = doc.evidence.find(e => e.text.includes("Figure 1") && !e.asset && e.structured.blockId !== image.structured.blockId);
	assert.ok(text.relatedIds.includes(image.id)); assert.ok(image.relatedIds.some(id => doc.evidence.find(e => e.id === id).structured.blockId === image.structured.blockId));
	assert.ok(selectReadingEvidence(doc, "Methods", 0, [text.id]).some(e => e.id === image.id));
	assert.equal((await doc.image(image)).evidenceId, image.id); assert.equal(renders, 1);
	await assert.rejects(doc.image({ ...image, asset: "images/forged.png" }), /不一致/);
	await assert.rejects(doc.image({ ...image, structured: { ...image.structured, blockId: text.structured.blockId } }), /不一致/);
	const badDecoder = await openStructuredDocument(root, sourcePath, storage, async () => { throw Error("decode failed"); });
	await assert.rejects(badDecoder.image(image), /decode failed/); await badDecoder.destroy();
	const stop = new AbortController(); stop.abort(); await assert.rejects(doc.image(image, stop.signal));
	const saved = memoryStorage(), repository = new ReadingRepository(saved), session = createReadingSession(doc.source, "mock", "test");
	const main = addReadingNode(session, null); await repository.add(session);
	let requests = [], visual = true;
	const backend = { name: "fixture", model: "test", images: true, complete: async request => {
		const p = JSON.parse(request.prompt); requests.push(p);
		if (p.action === "规划全文路线") return JSON.stringify({ modules: [{ title: "研究问题", question: "问题", evidenceIds: [text.id] }, { title: "图像证据", question: "图像", evidenceIds: [image.id] }] });
		if (p.catalog) return JSON.stringify({ ids: [visual ? image.id : text.id], query: "Figure 1", needsVisual: visual });
		assert.ok(request.system.includes("没有 PDF 页码")); assert.ok(p.evidence.every(e => e.kind !== "paper" || e.structured));
		const id = visual ? image.id : text.id;
		return JSON.stringify({ title: "合成测试", content: `仅为模拟回答：${p.currentUnit || p.question}。[${id}]`, evidenceIds: [id], mainSummary: "模拟主线记忆" });
	} };
	const workspace = { repository, document: async () => doc }, engine = new ReadingEngine(workspace, () => backend);
	await engine.generate(session.id, main.id);
	assert.equal(repository.get(session.id).nodes[0].status, "done"); assert.equal(repository.get(session.id).nodes[0].evidence[0].visualInspected, true);
	assert.deepEqual(repository.get(session.id).nodes[0].providedImageIds, [image.id]); assert.equal(requests.length, 3);
	let branchId; await repository.transact(session.id, s => { const branch = addReadingBranch(s, main.id); branchId = addReadingNode(s, branch.id, "图像是什么意思？").id; });
	await engine.generate(session.id, branchId); assert.equal(repository.get(session.id).nodes[1].status, "done");
	assert.ok(requests.at(-1).context.includes("模拟主线记忆"));
	let next; await repository.transact(session.id, s => { next = addReadingNode(s, null).id; });
	backend.images = false; await assert.rejects(engine.generate(session.id, next), /视觉能力/);
	assert.equal(repository.get(session.id).nodes.at(-1).status, "failed"); backend.images = true; await engine.generate(session.id, next);
	assert.equal(repository.get(session.id).completed, true);
	const restored = new ReadingRepository(saved); await restored.load(); assert.deepEqual(restored.errors, []); assert.equal(restored.get(session.id).source.structured.manifest.packageKey, key);
	const stable = structuredClone(restored.get(session.id)), exported = readingExportContent(stable, "session", "", { created: "2026-09-10" }), exportHash = readingExportHash(stable, "session", "");
	assert.ok(exported.includes("reading_source_snapshot:")); assert.ok(exported.includes(image.structured.resourceId)); assert.ok(exported.includes(image.text)); assert.ok(!exported.includes("[[papers/")); assert.ok(!exported.includes("analysis_depth: x-ray"));
	for (const corrupt of [s => s.source.structured.manifest.projectionId = "0".repeat(64), s => s.source.kind = "article", s => s.nodes[0].evidence[0].page = 1, s => s.nodes[0].evidence[0].structured.packageKey = "other", s => s.nodes[0].evidence[0].end++, s => s.nodes[0].evidence[0].structured.resourceId = "images/missing.png", s => s.nodes[0].evidence[0].structured.xmlPath += "/fake[1]"]) {
		const changed = structuredClone(stable); corrupt(changed); assert.throws(() => validateReadingSession(changed));
	}
	const validResult = { title: "T", content: `[${image.id}] [jats-forged]`, evidenceIds: [image.id] };
	assert.throws(() => validateReadingResult(JSON.stringify(validResult), [image], false), /不一致/);
	// Reopening and source relocation use a new loader; unchanged manifests recover, changed fingerprints cannot rebind history.
	const service = new ReadingWorkspaceService({}, root, root); service.repository = restored; service.ready = async () => {};
	service.loader = { open: async () => openStructuredDocument(root, sourcePath, storage, render) };
	assert.equal((await service.document(session.id)).source.fingerprint, stable.source.fingerprint);
	service.loader = { open: async () => ({ ...doc, source: { ...doc.source, fingerprint: "f".repeat(64) }, destroy: async () => {} }) };
	await assert.rejects(service.relocate(session.id, sourcePath), /内容不同/);
	const bytes = storage.files.get(sourcePath); storage.files.set(sourcePath, Buffer.from("modified source"));
	await assert.rejects(doc.verify(), /修改|缺失/); await assert.rejects(doc.image(image), /修改|缺失/);
	const changedView = new ReadingWorkspaceService({}, root, root); changedView.repository = restored; changedView.loader = { open: async () => openStructuredDocument(root, sourcePath, storage, render) };
	await assert.rejects(changedView.document(session.id), /修改|缺失/);
	assert.equal(readingExportHash(stable, "session", ""), exportHash); assert.equal(readingExportContent(stable, "session", "", { created: "2026-09-10" }), exported);
	storage.files.set(sourcePath, bytes); await doc.verify();
	const marker = `papers/${key}/_source/manifest.json`, originalManifest = storage.files.get(marker), manifest = JSON.parse(originalManifest);
	manifest.createdAt = "2026-09-10T00:00:00.000Z";
	const { digest, ...manifestBody } = manifest; manifest.digest = loadReading("papers/identity.ts").objectDigest(manifestBody);
	storage.files.set(marker, Buffer.from(JSON.stringify(manifest)));
	await assert.rejects(doc.verify(), /版本已变化/);
	const rebound = await openStructuredDocument(root, sourcePath, storage, render); assert.notEqual(rebound.source.fingerprint, stable.source.fingerprint); await rebound.destroy();
	storage.files.set(marker, originalManifest); await doc.verify();
	await doc.destroy(); await assert.rejects(doc.verify(), /关闭/);
	await service.dispose(); await changedView.dispose();
	console.log("JATS_READING_OK: pinned manifest, real block/resource relationships, main/branch/image flow, vision gating, retry, session reload, changed source denial and offline historical export; memory fixtures only");
})().catch(error => { console.error(error); process.exitCode = 1; });
