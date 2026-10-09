"use strict";
// Reuses the native memory reading scenario. Actual UI/services and cached public
// XML/image bytes; every assistant record, revision and note write stays in memory.
module.exports = async function(app, fixtureRoot, apiPath, keepOpen = false) {
	const assert = require("node:assert/strict"), { setTimeout } = require("node:timers"), { createHash } = require("node:crypto");
	const plugin = app.plugins.plugins["research-agent-reader"];
	if (plugin.curationModals.size || plugin.getTaskRuns().some(r => r.status === "running")) throw new Error("Close review dialogs and finish tasks before QA");
	const realAssistant = plugin.getReadingAssistant(), realCuration = plugin.getCurationService(), realWriter = plugin.getCurationWriter();
	const original = { assistant: plugin.getReadingAssistant, curation: plugin.getCurationService, writer: plugin.getCurationWriter, profile: plugin.getProviderProfile, profiles: plugin.getVerifiedProviderProfiles, markdownFiles: app.vault.getMarkdownFiles, openEvidence: plugin.openReadingEvidence, settings: JSON.stringify(plugin.settings) };
	let reading, service, assistant, writer, request, review, snapshot, opened; const checks = [], files = new Map(), records = new Map(), asstFiles = new Map(); let models = 0, writes = 0;
	const check = (condition, name) => { assert.ok(condition, name); checks.push(name); };
	const wait = async (fn, name) => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error("Timeout: " + name); };
	const modal = selector => [...plugin.curationModals].find(m => m.modalEl.matches(selector));
	const click = (m, label) => { const b = [...m.contentEl.querySelectorAll("button")].find(b => b.textContent === label); assert.ok(b && !b.disabled, label); b.click(); };
	const closeDialogs = () => { for (const m of [...plugin.curationModals].reverse()) m.close(); };
	const cleanup = async () => {
		closeDialogs(); await assistant?.dispose(); await service?.dispose();
		plugin.getReadingAssistant = original.assistant; plugin.getCurationService = original.curation; plugin.getCurationWriter = original.writer; plugin.getProviderProfile = original.profile; plugin.getVerifiedProviderProfiles = original.profiles; plugin.openReadingEvidence = original.openEvidence; app.vault.getMarkdownFiles = original.markdownFiles;
		await reading?.cleanup(); delete globalThis.__jatsReadingQa;
	};
	try {
		const base = require.resolve("./obsidian-jats-reading.cjs"); delete require.cache[base]; const readingResult = await require(base)(app, fixtureRoot, apiPath, true); reading = globalThis.__jatsReadingQa;
		const workspace = reading.service, session = workspace.repository.get(reading.sessionId), node = session.nodes.find(n => n.status === "done"), manifest = session.source.structured.manifest, target = `wiki/sources/${manifest.citekey}.md`;
		const meta = { title: manifest.identity.title, title_zh: "仅为界面测试的标题", citekey: manifest.citekey, doi: manifest.identity.identifiers.doi, type: "source", depth: "abstract-level" };
		snapshot = "---\n" + Object.entries(meta).map(([k, v]) => k + ": " + JSON.stringify(v)).join("\n") + "\n---\n# " + manifest.identity.title + "\n\n## 研究问题\n\n这是内存测试笔记，用于核对已有 Wiki 修订界面，不代表论文结论。\n";
		files.set(target, snapshot); files.set("文献索引.md", "# 文献索引\n"); files.set("wiki/log.md", "# 日志\n");
		const file = p => files.has(p) ? { path: p, basename: p.split("/").pop().slice(0, -3) } : null;
		const memoryApp = { vault: { getFileByPath: file, cachedRead: async f => files.get(f.path), create: async (p, text) => { assert.ok(!files.has(p)); files.set(p, text); writes++; }, process: async (f, update) => { const before = files.get(f.path), after = update(before); files.set(f.path, after); if (after !== before) writes++; } }, metadataCache: { getFileCache: () => ({ frontmatter: meta }) } };
		const store = { list: async kind => [...records.keys()].filter(k => k.startsWith(kind + "/")).map(k => k.split("/")[1]), read: async (kind, id) => structuredClone(records.get(kind + "/" + id)), write: async (kind, value) => records.set(kind + "/" + value.id, structuredClone(value)) };
		service = new realCuration.constructor(memoryApp, workspace, store, () => ({ name: "native-fixture", model: "synthetic", images: true, complete: async req => {
			models++; check(req.images.length === 1 && req.images[0].dataUrl.startsWith("data:image/png;base64,"), "curation model receives the decoded same-version image");
			const p = JSON.parse(req.prompt), e = p.evidence.find(e => e.id.startsWith("P")); return JSON.stringify({ suggestions: [{ kind: "add", paragraphId: p.target.paragraphs[0].id, claim: "合成验收补充", text: "这是用于验收修订流程的模拟补充，不代表真实科研结论。", reason: "核对原文引用与编辑边界。", citations: [{ id: e.id, quoteId: e.quotes[0].id }] }] });
		} })); writer = new realWriter.constructor(service);
		plugin.getCurationService = () => service; plugin.getCurationWriter = () => writer;
		app.vault.getMarkdownFiles = () => [...original.markdownFiles.call(app.vault), file(target)];
		const step = (tool, args) => JSON.stringify({ step: { tool, arguments: args } });
		assistant = new realAssistant.constructor({ ...realAssistant.deps, workspace, search: async () => ({ mode: "lexical", warnings: [], hits: [{ path: target, title: meta.title, text: snapshot, start: 0, end: snapshot.length, hash: createHash("sha256").update(snapshot).digest("hex"), heading: "", role: "论文依据", depth: "abstract-level" }] }), readFile: async p => files.get(p), learning: async () => ({ matches: [], warnings: [] }), outcomes: async () => new Map(), backend: () => ({ name: "native-fixture", model: "synthetic", images: false, complete: async req => {
			models++; assert.equal(req.images.length, 0); const h = JSON.parse(req.prompt).history, last = h.at(-1);
			if (!last) return step("read_node", { nodeId: node.id });
			if (last.data.request.tool === "read_node") return step("read_evidence", { ids: JSON.parse(last.data.result).references.slice(0, 2).map(e => e.id) });
			if (last.data.request.tool === "read_evidence") return step("search_knowledge", { query: "当前测试笔记" });
			if (last.data.request.tool === "search_knowledge") return step("prepare_action", { kind: "curation", nodeIds: [node.id], target: JSON.parse(last.data.result).candidates[0].id, scope: "node" });
			return step("final", { answer: "模拟回答：已读取文字依据 [S1]，图像仍需人工对照。已准备修订操作卡，尚未写入笔记。", citations: ["S1"] });
		} }) }, { list: async () => [...asstFiles.keys()], read: async id => asstFiles.get(id), write: async (id, text) => { asstFiles.set(id, text); } });
		plugin.getReadingAssistant = () => assistant; plugin.getVerifiedProviderProfiles = () => [{ id: "fixture", name: "界面模拟模型", model: "synthetic" }]; plugin.getProviderProfile = () => ({ id: "fixture", name: "界面模拟模型", model: "synthetic", baseUrl: "https://example.invalid" });
		plugin.openReadingEvidence = async (p, page, block) => { opened = { p, page, block }; };
		plugin.openReadingAssistant(session.id, node.id); await wait(() => modal(".reading-assistant-modal"), "assistant opens"); const assistantModal = modal(".reading-assistant-modal");
		check(!!assistantModal && models === 0 && writes === 0, "JATS assistant opens through the production host without a model call");
		assistantModal.input.value = "核对来源并准备整理"; await assistantModal.send(); request = [...assistant.runs.values()].at(-1);
		check(request.state === "done" && request.sources.every(s => s.structured && s.page === undefined), "assistant retains actual JATS block references and source snapshot");
		check(assistantModal.contentEl.querySelector(".assistant-action")?.textContent.includes("准备整理建议") && writes === 0, "assistant displays a prepared action without writing notes");
		await plugin.openAssistantEvidence(request.id, "S1"); let evidenceModal = [...plugin.curationModals].at(-1);
		check(evidenceModal.contentEl.textContent.includes("无 PDF 页码") && evidenceModal.contentEl.textContent.includes("文字快照"), "assistant evidence UI distinguishes historical text and live verification");
		click(evidenceModal, "前往原文块"); await wait(() => opened, "source navigation"); check(opened.page === undefined && opened.block === request.sources[0].structured.blockId, "assistant citation navigates to the exact original block"); evidenceModal.close(); assistantModal.close();
		await plugin.dispatchAssistantAction(request.id, request.actions[0].id); await wait(() => modal(".curation-modal")?.context, "curation handoff prepares context"); const curation = modal(".curation-modal");
		check(curation.context.sourceCompatible && writes === 0, "action card prepares a source-compatible revision without changing the note");
		await curation.generate(); review = [...service.reviews.values()].at(-1);
		check(review.state === "ready" && review.suggestions[0].applicable, "existing Wiki receives a reviewable source-bound suggestion");
		await new Promise(r => setTimeout(r, 80)); const side = curation.contentEl.querySelector(".curation-side"); assert.ok(side.scrollWidth <= side.clientWidth + 2, "evidence column overflow: " + JSON.stringify([...side.querySelectorAll("*")].filter(e => e.getBoundingClientRect().right > side.getBoundingClientRect().right).map(e => ({ tag: e.tagName, cls: e.className, text: e.textContent.slice(0, 80) })).slice(0, 6))); checks.push("long XML locations wrap within the evidence column");
		check(!curation.contentEl.querySelector(".curation-suggestion input:checked"), "suggestions require explicit selection");
		const visual = review.context.evidence.find(e => e.visual); await plugin.openCurationEvidence(review.context, visual.id); evidenceModal = [...plugin.curationModals].at(-1);
		await wait(() => evidenceModal.contentEl.querySelector("img")?.naturalWidth > 100, "real image preview"); check(evidenceModal.contentEl.textContent.includes("JATS 块"), "curation evidence displays the verified image with block location"); evidenceModal.close();
		const checkbox = curation.contentEl.querySelector(".curation-suggestion input"); checkbox.checked = true; checkbox.dispatchEvent(new Event("change")); click(curation, "预览选中修改");
		await wait(() => modal(".curation-revision-modal"), "revision preview"); const preview = modal(".curation-revision-modal"), Preview = preview.constructor;
		check(preview.contentEl.textContent.includes("完整修改前文件") && preview.contentEl.textContent.includes("完整修改后文件") && writes === 0, "complete before/after preview remains read-only");
		click(preview, "应用选中修改"); await wait(() => [...service.revisions.values()].some(r => r.state === "applied"), "apply revision"); const revision = [...service.revisions.values()].find(r => r.state === "applied");
		check(files.get(target).includes("JATS PMC10009416.1") && files.get(target).split("---")[1] === snapshot.split("---")[1], "applied revision preserves metadata/depth and records JATS provenance");
		await assistant.refreshActions(); check(assistant.runs.get(request.id).actions[0].execution.state === "succeeded", "assistant action reflects the actual completed revision");
		const edited = files.get(target); files.set(target, edited + "\n用户编辑\n"); await assert.rejects(writer.previewUndo(revision.id), /后续编辑/); files.set(target, edited);
		check(true, "undo refuses later user edits");
		const undo = await writer.previewUndo(revision.id); plugin.showCurationModal(new Preview(app, undo, () => writer.applyUndo(undo))); click(modal(".curation-revision-modal"), "确认撤销");
		await wait(() => files.get(target) === snapshot, "undo restores note"); await assistant.refreshActions(); check(assistant.runs.get(request.id).actions[0].execution.state === "needs-review", "undo restores original note and updates assistant outcome");
		closeDialogs(); const sourcePath = session.source.path, originalBytes = reading.catalog.storage.files.get(sourcePath); reading.catalog.storage.files.set(sourcePath, Buffer.from("changed"));
		await plugin.openAssistantEvidence(request.id, "S1"); evidenceModal = [...plugin.curationModals].at(-1);
		check(evidenceModal.contentEl.textContent.includes("保留历史快照") && evidenceModal.contentEl.querySelector("button").disabled, "changed source leaves historical evidence readable and blocks navigation"); evidenceModal.close(); reading.catalog.storage.files.set(sourcePath, originalBytes);
		check(models === 6 && JSON.stringify(plugin.settings) === original.settings, "review, apply and undo use six simulated calls and preserve settings");
		if (keepOpen) { plugin.openKnowledgeCuration(session.id, node.id, review); globalThis.__jatsCurationQa = { cleanup, service, assistant, reading, review }; }
		return { ok: true, version: plugin.manifest.version, checks, readingChecks: readingResult.checks.length, simulatedCalls: models, realModelCalls: 0, realNetworkCalls: 0, writes: "memory-only", retained: keepOpen };
	} finally { if (!keepOpen || !globalThis.__jatsCurationQa) await cleanup(); }
};
