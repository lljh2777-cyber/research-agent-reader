"use strict";
// Native views + real previously fetched public XML/media; all new packages,
// sessions, model answers and exports remain in memory. No cleanup or network.
module.exports = async function(app, fixtureRoot, apiPath, keepOpen = false) {
	const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { setTimeout } = require("node:timers");
	const f = require("./jats-fixtures.cjs"), Module = require("node:module");
	// The helper exercises only JATS/DOM and pure session APIs. Obsidian's public
	// module is injected only into plugin bundles, not external Node helpers.
	// Deny unrelated PDF/MinerU/vault-export API use; native views use the plugin.
	const helper = new Module(apiPath, module); helper.filename = apiPath; helper.paths = Module._nodeModulePaths(path.dirname(apiPath));
	const nativeRequire = helper.require.bind(helper); helper.require = name => name === "obsidian" ? new Proxy({}, { get() { throw new Error("External QA helper must not use the Obsidian module"); } }) : nativeRequire(name);
	helper._compile(fs.readFileSync(apiPath, "utf8"), apiPath); const api = helper.exports;
	const plugin = app.plugins.plugins["research-agent-reader"], acq = plugin.getAcquisitionService(); await acq.ready();
	if (plugin.isActionRunning("paper-ingest") || plugin.acquisitionDialogs.size || plugin.getReadingWorkspace().repository.sessions.size && [...plugin.getReadingWorkspace().repository.sessions.values()].some(s => s.nodes.some(n => n.status === "running" || n.status === "pending"))) throw new Error("Finish active work before native QA");
	const original = { workspace: plugin.getReadingWorkspace, engine: plugin.getReadingEngine, profiles: plugin.getVerifiedProviderProfiles, activate: plugin.activateReadingWorkspace, openEvidence: plugin.openReadingEvidence, active: app.workspace.activeLeaf, settings: JSON.stringify(plugin.settings) };
	const snapshot = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "snapshot.json"), "utf8")), cache = f.storage(), content = new Map();
	for (const file of snapshot.artifact.files) { const bytes = fs.readFileSync(path.join(fixtureRoot, file.path)); cache.files.set(file.path, bytes); content.set(file.ref, bytes); }
	const deny = async () => { throw new Error("Native JATS reading QA cannot call network, models or MinerU"); };
	const provider = new acq.backend.jats.constructor({ metadata: deny, download: deny }, cache);
	snapshot.validation = provider.project(content.get("article.xml"), snapshot.identity, snapshot.artifact, content).validation;
	const acquired = { snapshot, ...await provider.read(snapshot) }, catalog = new (plugin.getSourceCatalog().constructor)(f.storage()), sourceService = plugin.getJatsIntakeService();
	const intake = new sourceService.constructor({ ...sourceService.deps, catalog, journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
	const root = app.vault.adapter.getBasePath(), files = new Map(), storage = { list: async () => [...files.keys()], read: async id => files.get(id), write: async (id, text) => { files.set(id, text); } };
	const service = new api.ReadingWorkspaceService(app, root, path.join(root, ".obsidian/plugins/research-agent-reader"));
	service.repository = new api.ReadingRepository(storage); service.ready = async () => {};
	service.loader = { open: async (kind, filename) => { if (kind !== "structured") throw new Error("Wrong source kind"); return api.openStructuredDocument(root, filename, catalog.storage); } };
	let leaf, ordinary, sourcePath, requests = [], entry; const checks = [];
	const check = (value, label) => { assert.ok(value, label); checks.push(label); };
	const wait = async (fn, label) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error("Timeout: " + label); };
	const cleanup = async () => {
		leaf?.detach(); ordinary?.detach();
		plugin.getReadingWorkspace = original.workspace; plugin.getReadingEngine = original.engine; plugin.getVerifiedProviderProfiles = original.profiles; plugin.activateReadingWorkspace = original.activate; plugin.openReadingEvidence = original.openEvidence;
		await service.dispose(); await intake.dispose(); if (original.active) await app.workspace.revealLeaf(original.active);
		const window = require("electron").remote.getCurrentWindow(); window.setSkipTaskbar(false); if (window.isMinimized()) window.restore(); window.show();
	};
	try {
		const plan = await intake.prepare(snapshot.jobId), saved = await intake.save(plan.requestId, plan.evidenceDigest, true); assert.equal(saved.phase, "saved", saved.error); sourcePath = `papers/${plan.packageKey}/article.md`;
		const opened = await service.open("structured", sourcePath, "fixture", "synthetic"), sessionId = opened.id, doc = await service.document(sessionId);
		check(opened.created && !(await service.open("structured", sourcePath, "fixture", "synthetic")).created, "same pinned source reuses a reading session");
		await service.repository.transact(sessionId, s => { s.title = "M6 交互验收 · 模拟回答"; });
		const image = doc.evidence.find(e => e.asset), text = doc.evidence.find(e => !e.asset && e.structured.xmlPath.includes("/body["));
		check(image && doc.evidence.every(e => e.page === undefined), "real source uses blocks/resources without invented pages");
		const backend = { name: "native-fixture", model: "synthetic", images: true, complete: async request => {
			const p = JSON.parse(request.prompt); requests.push(p);
			if (p.action === "规划全文路线") return JSON.stringify({ modules: [{ title: "正文定位测试", question: "验证正文定位", evidenceIds: [text.id] }, { title: "图像定位测试", question: "验证图像定位", evidenceIds: [image.id] }] });
			if (p.catalog) return JSON.stringify({ ids: [image.id, text.id], query: "source evidence", needsVisual: true });
			check(request.images.length === 1 && request.images[0].dataUrl.startsWith("data:image/png;base64,"), "real same-version image decoded before simulated answer");
			return JSON.stringify({ title: "模拟讲解", content: `这是界面验收用的模拟回答，不包含论文结论。${p.currentUnit || p.question}\n\n正文位置引用：[${text.id}]\n\n图像资源引用：[${image.id}]`, evidenceIds: [text.id, image.id], mainSummary: "仅为验收主线记忆" });
		} };
		const engine = new api.ReadingEngine(service, () => backend);
		plugin.getReadingWorkspace = () => service; plugin.getReadingEngine = () => engine; plugin.getVerifiedProviderProfiles = () => [];
		await service.advance(sessionId); let first = service.repository.get(sessionId).mainIds[0];
		const branch = await service.ask(sessionId, first, "图片与正文怎样对应？"); await wait(() => service.repository.get(sessionId).nodes.find(n => n.id === branch).status === "done", "branch answer");
		await service.advance(sessionId); check(service.repository.get(sessionId).completed, "main path and branch finish through the existing engine");
		const restored = new api.ReadingRepository(storage); await restored.load(); check(restored.errors.length === 0 && restored.get(sessionId).branches.length === 1, "session and branch resume from serialized structured snapshot");
		leaf = app.workspace.getLeaf("tab"); await leaf.setViewState({ type: "research-interactive-reading", active: true, state: { sessionId, domain: "paper" } }); await app.workspace.revealLeaf(leaf);
		const view = leaf.view; await wait(() => view.contentEl.querySelectorAll("[data-reading-citation]").length >= 2, "clickable JATS citations");
		check(view.getReadingDomain() === "paper" && view.contentEl.textContent.includes("JATS 原文"), "structured reading remains in the paper workspace");
		check(!view.contentEl.querySelector('[aria-label="整理进知识库"]'), "formal Wiki action remains unavailable until next stage");
		view.openSource({ source: { kind: "structured", path: sourcePath } });
		const sourceModal = [...view.modals].find(m => m.contentEl.querySelector('[aria-label="原文位置"]'));
		check(sourceModal && [...sourceModal.contentEl.querySelectorAll("select")].some(s => s.value === "structured") && sourceModal.contentEl.querySelector('[aria-label="原文位置"]').value === sourcePath, "source picker explicitly selects JATS"); sourceModal.close();
		view.showEvidence(first, image.id); await wait(() => [...view.modals].some(m => [...m.contentEl.querySelectorAll("img")].some(i => i.naturalWidth > 100)), "evidence dialog actual image");
		const evidenceModal = [...view.modals].find(m => m.contentEl.querySelector("img")); check(evidenceModal.contentEl.textContent.includes("无 PDF 页码"), "image dialog reports block location");
		evidenceModal.close(); await service.repository.transact(sessionId, s => api.visitReadingEvidence(s, first, image.id));
		await wait(() => [...view.contentEl.querySelectorAll(".reading-evidence-panel img")].some(i => i.naturalWidth > 100), "pinned evidence panel");
		const panel = view.contentEl.querySelector(".reading-evidence-panel"); check(panel.textContent.includes("JATS 块") && !panel.textContent.includes("页码未唯一定位"), "pinned evidence panel uses truthful JATS location");
		const checked = panel.querySelector('input[type="checkbox"]'); checked.checked = true; checked.dispatchEvent(new Event("change"));
		await wait(() => service.repository.get(sessionId).nodes[0].reviewedEvidence?.includes(image.id), "personal evidence review mark");
		check(!("analysis_depth" in service.repository.get(sessionId)), "learning and visual review never upgrade X-Ray depth");
		await service.repository.transact(sessionId, s => { s.ui.evidenceView = undefined; });
		ordinary = app.workspace.getLeaf("tab"); await ordinary.setViewState({ type: "agent-dashboard-mineru-reader", active: true, state: {} }); ordinary.view.loader.load = () => api.loadJatsDocument(catalog.storage, plan.packageKey); await ordinary.view.setArticlePath(sourcePath); await app.workspace.revealLeaf(ordinary);
		ordinary.view.revealReadingBlock(image.structured.blockId); check(!!ordinary.view.contentEl.querySelector(`[data-jats-block="${image.structured.blockId}"]`), "source navigation reaches the actual structured block");
		plugin.activateReadingWorkspace = async value => { entry = value; }; ordinary.view.contentEl.querySelector('[data-jats-action="interactive"]').click();
		check(entry?.source?.kind === "structured" && entry.source.path === sourcePath, "ordinary reader starts explicit structured reading");
		const session = structuredClone(service.repository.get(sessionId)), exported = api.readingExportContent(session, "session", "", { created: "2026-09-10" });
		check(exported.includes("reading_source_snapshot:") && exported.includes(image.structured.resourceId) && exported.includes(image.text), "offline export keeps manifest, resource and historical evidence");
		const originalBytes = catalog.storage.files.get(sourcePath); catalog.storage.files.set(sourcePath, Buffer.from("modified source"));
		await assert.rejects(doc.verify(), /修改|缺失/); const hash = api.readingExportHash(session, "session", ""); check(hash === api.readingExportHash(restored.get(sessionId), "session", ""), "changed source cannot rewrite historical export");
		catalog.storage.files.set(sourcePath, originalBytes); await doc.verify();
		check(JSON.stringify(plugin.settings) === original.settings, "plugin settings remain unchanged");
		ordinary.detach(); ordinary = undefined; await app.workspace.revealLeaf(leaf);
		if (keepOpen) globalThis.__jatsReadingQa = { cleanup, leaf, service, sessionId };
		return { ok: true, version: plugin.manifest.version, checks, blocks: acquired.projection.blocks.length, evidence: doc.evidence.length, realModelCalls: 0, realNetworkCalls: 0, formalWrites: "memory-only", viewsRetained: keepOpen };
	} finally { if (!keepOpen || !globalThis.__jatsReadingQa) await cleanup(); }
};
