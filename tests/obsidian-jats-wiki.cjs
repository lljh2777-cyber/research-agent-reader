"use strict";
// Actual plugin UI, bounded agent loop and registration controller. Previously
// fetched public XML is read locally; simulated prose and every write stay in memory.
module.exports = async function(app, fixtureRoot, keepOpen = false) {
	const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { setTimeout } = require("node:timers"), f = require("./jats-fixtures.cjs");
	const plugin = app.plugins.plugins["research-agent-reader"], acquisition = plugin.getAcquisitionService(); await acquisition.ready();
	if (plugin.acquisitionDialogs.size || plugin.getTaskRuns().some(r => r.status === "running")) throw new Error("Finish active tasks before native QA");
	const original = { wiki: plugin.getJatsWikiService(), registration: plugin.ingestRegistration, records: plugin.getIngestRecords, profiles: plugin.getVerifiedProviderProfiles, provider: plugin.createLLMProvider, open: plugin.openVaultFile, active: app.workspace.activeLeaf, settings: JSON.stringify(plugin.settings) };
	const snapshot = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "snapshot.json"), "utf8")), cache = f.storage(), content = new Map(); snapshot.artifact.converter = "rar-jats-2";
	for (const file of snapshot.artifact.files) { const bytes = fs.readFileSync(path.join(fixtureRoot, file.path)); cache.files.set(file.path, bytes); content.set(file.ref, bytes); }
	const deny = async () => { throw new Error("Native JATS Wiki QA must not call network or MinerU"); }, provider = new acquisition.backend.jats.constructor({ metadata: deny, download: deny }, cache);
	snapshot.validation = provider.project(content.get("article.xml"), snapshot.identity, snapshot.artifact, content).validation;
	const acquired = { snapshot, ...await provider.read(snapshot) }, catalog = new (plugin.getSourceCatalog().constructor)(f.storage()), intakeOriginal = plugin.getJatsIntakeService();
	const intake = new intakeOriginal.constructor({ ...intakeOriginal.deps, catalog, journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
	const journal = f.storage(), notes = new Map(), writes = [], registry = new Map(), checks = []; let service, registration, registryEl, modal, requestId, key, opened, gate, release, modelCalls = 0, failModel = true;
	const check = (condition, name) => { assert.ok(condition, name); checks.push(name); };
	const wait = async (fn, name) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error("Timeout: " + name); };
	const dialog = () => [...plugin.acquisitionDialogs].find(m => m.modalEl.matches(".rar-jats-wiki-modal"));
	const button = name => modal.contentEl.querySelector(`[data-jats-wiki="${name}"]`);
	const close = () => { modal?.close(); modal = undefined; };
	const cleanup = async () => {
		if (registryEl?.isConnected) registryEl.querySelector(".modal-header-button")?.click(); close();
		plugin.jatsWikiService = original.wiki; plugin.ingestRegistration = original.registration; plugin.getIngestRecords = original.records; plugin.getVerifiedProviderProfiles = original.profiles; plugin.createLLMProvider = original.provider; plugin.openVaultFile = original.open;
		await service?.dispose(); await intake.dispose(); if (original.active) await app.workspace.revealLeaf(original.active);
		const window = require("electron").remote.getCurrentWindow(); window.setSkipTaskbar(false); if (window.isMinimized()) window.restore(); window.show(); window.focus();
	};
	try {
		const plan = await intake.prepare(snapshot.jobId); assert.equal((await intake.save(plan.requestId, plan.evidenceDigest, true)).phase, "saved"); key = plan.packageKey;
		const deps = { ...original.wiki.deps, catalog, journal, readNote: async p => notes.get(p) ?? null,
			commit: async (citekey, fields, text, created, verify) => { await verify(); const p = `wiki/sources/${citekey}.md`; assert.ok(!notes.has(p)); notes.set(p, text); writes.push(p); } };
		service = new original.wiki.constructor(deps); plugin.jatsWikiService = service;
		plugin.getVerifiedProviderProfiles = () => [{ id: "native-jats-wiki", name: "界面验收模拟模型", model: "synthetic", timeoutSeconds: 60 }];
		plugin.createLLMProvider = () => ({ complete: async req => {
			modelCalls++; if (failModel) throw Error("Synthetic model failure"); if (gate) await gate;
			const last = req.messages.at(-1).content;
			if (!last.startsWith("<tool_result")) return { text: JSON.stringify({ action: "tool", tool: "jats_read", arguments: { mode: "overview" } }) };
			const read = JSON.parse(last.slice(last.indexOf("\n") + 1, last.lastIndexOf("\n"))), id = read.evidence[0].id;
			return { text: JSON.stringify({ action: "final", result: { status: "completed", title: read.title, title_zh: "界面验收模拟译名", researchQuestion: `仅验证研究问题字段和引用。[${id}]`, conclusion: `仅为界面测试，不代表真实科研结论。[${id}]`, motivation: `仅验证研究动机字段。[${id}]`, evidenceGaps: "图表与完整方法尚未逐项核验。", evidenceIds: [id], notes: [] } }) };
		} });
		plugin.openVaultFile = async p => { opened = p; };
		await plugin.getIngestRegistrationAvailability("wiki/sources/native-jats-wiki-absent.md");
		registration = new plugin.ingestRegistration.constructor(plugin); plugin.ingestRegistration = registration;
		plugin.getIngestRecords = () => ({ read: async (kind, id) => registry.get(kind + "/" + id) ?? null, write: async (kind, id, value) => { registry.set(kind + "/" + id, structuredClone(value)); } });
		registration.read = async p => notes.get(p) ?? null;
		registration.write = async (p, before, after) => { assert.equal(notes.get(p) ?? null, before); notes.set(p, after); writes.push(p); };
		// Source validation uses the memory package. Production guard itself is covered by Node tests.
		registration.writer.io.verify = async () => { await service.preview(requestId); };
		await plugin.openJatsWiki(key); modal = dialog(); check(!!modal && !writes.length && !journal.writes.length, "opening source and Wiki preview performs no writes");
		check(modal.contentEl.textContent.includes("PMC10009416.1") && modal.contentEl.textContent.includes("abstract-level"), "UI shows fixed source version and initial depth");
		await button("generate").onclick(); check(service.list()[0].phase === "failed" && modal.contentEl.textContent.includes("Synthetic model failure"), "model failure stays visible without a Wiki");
		failModel = false; gate = new Promise(resolve => { release = resolve; }); const pending = button("generate").onclick();
		await wait(() => modelCalls === 2 && service.list().some(r => r.phase === "generating"), "generation pending");
		requestId = service.list().find(r => r.phase === "generating").request.id; close(); await plugin.openJatsWikiTask(requestId); modal = dialog(); release(); await pending;
		await wait(() => button("save") && !button("save").disabled, "background draft becomes reviewable");
		check(service.get(requestId).phase === "draft", "reopened running task displays its completed draft without reopening again");
		const record = service.get(requestId);
		check(!!record && modelCalls === 3 && writes.length === 0, "retry uses actual bounded read protocol and preserves failed history");
		check(record.draft.receipts[0].data.paths[0].startsWith("jats-sha256:") && record.draft.evidence[0].xmlPath.includes("/abstract["), "actual source read and XML evidence bind the draft");
		check(modal.contentEl.querySelector("pre").textContent === record.draft.content && record.draft.content.includes('source_kind: "jats"'), "complete preview equals eventual note content");
		for (const width of [360, 680]) { modal.modalEl.style.width = width + "px"; await new Promise(r => setTimeout(r, 50)); check(modal.contentEl.scrollWidth <= modal.contentEl.clientWidth + 2, "Wiki dialog fits width " + width); }
		check(plugin.getTaskRun(requestId)?.actionId === "jats-wiki", "draft appears in existing task history");
		close(); await service.dispose(); service = new original.wiki.constructor(deps); plugin.jatsWikiService = service; plugin.getVerifiedProviderProfiles = () => [];
		await plugin.openJatsWikiTask(requestId); modal = dialog(); check(button("generate").disabled && !button("save").disabled && modelCalls === 3, "task resume without a model retains preview and save");
		journal.before = async p => { if (p.endsWith("/saved.json")) throw Error("Synthetic receipt failure"); };
		await button("save").onclick(); check(writes.length === 1 && modal.contentEl.textContent.includes("Synthetic receipt failure") && !button("save").disabled, "saved note with failed receipt offers recovery");
		close(); await service.dispose(); journal.before = undefined; service = new original.wiki.constructor(deps); plugin.jatsWikiService = service;
		await plugin.openJatsWikiTask(requestId); modal = dialog(); await button("save").onclick(); await wait(() => button("register") && !button("register").disabled, "registration available");
		check(writes.length === 1 && modelCalls === 3 && button("save").disabled, "receipt recovery creates no duplicate and calls no model");
		button("open").click(); check(opened === service.get(requestId).notePath, "open action uses canonical saved Wiki path");
		const notePath = opened;
		button("register").click(); await wait(() => [...document.querySelectorAll(".modal")].some(m => m.querySelector(".modal-title")?.textContent === "入库登记预览"), "existing registration modal");
		registryEl = [...document.querySelectorAll(".modal")].find(m => m.querySelector(".modal-title")?.textContent === "入库登记预览");
		check(registryEl.textContent.includes("修改前") && registryEl.textContent.includes("修改后") && registryEl.textContent.includes("indexed"), "existing registration UI previews standalone before/after changes");
		const apply = [...registryEl.querySelectorAll("button")].find(b => b.textContent === "确认登记"); await apply.onclick();
		check(notes.has("文献索引.md") && notes.has("wiki/log.md") && notes.has("papers/index.md") && notes.get(notePath).includes('registry_status: "indexed"'), "existing registration controller updates only memory indexes and log");
		check(!notes.has("tool-library/metadata/papers.csv") && modelCalls === 3, "standalone registration uses neither external bibliography nor model");
		registryEl.querySelector(".modal-header-button").click();
		notes.set(notePath, notes.get(notePath) + "\n用户编辑的测试文本。\n"); const before = writes.length; await service.save(requestId, record.draft.digest);
		check(writes.length === before && notes.get(notePath).endsWith("用户编辑的测试文本。\n"), "repeat save preserves user edits after registration");
		const sourcePath = `papers/${key}/article.md`, sourceBytes = catalog.storage.files.get(sourcePath); catalog.storage.files.set(sourcePath, Buffer.from("changed"));
		await assert.rejects(service.preview(requestId), /修改|缺失/); catalog.storage.files.set(sourcePath, sourceBytes);
		check(JSON.stringify(plugin.settings) === original.settings, "plugin configuration remains unchanged");
		if (keepOpen) globalThis.__jatsWikiQa = { cleanup, service, requestId, modal };
		return { ok: true, version: plugin.manifest.version, checks, simulatedProviderCalls: modelCalls, realModelCalls: 0, realNetworkCalls: 0, formalWrites: "memory-only", retained: keepOpen };
	} finally { if (!keepOpen || !globalThis.__jatsWikiQa) await cleanup(); }
};
