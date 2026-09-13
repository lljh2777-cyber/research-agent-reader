/* Native navigation/layout tests. Uses existing labelled fixtures, never real models.
 * Keeps one labelled branch as a test record; no deletion, export or source execution. */
module.exports = async function readingDomains(app) {
	const plugin = app.plugins.plugins["research-agent-reader"], service = plugin.getReadingWorkspace(); await service.ready();
	const type = "research-interactive-reading", leaves = () => app.workspace.getLeavesOfType(type), domainView = domain => leaves().find(l => l.view.getReadingDomain() === domain)?.view;
	const original = leaves().map(l => ({ leaf: l, state: structuredClone(l.view.getState()) }));
	const originalModals = new Set(original.flatMap(x => [...x.leaf.view.modals]));
	const checks = [], check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
	const pause = ms => new Promise(r => require("node:timers").setTimeout(r, ms));
	const until = async predicate => { for (let i = 0; i < 80; i++) { if (predicate()) return; await pause(50); } throw new Error("Timed out waiting for test generation"); };
	const paper = [...service.repository.sessions.values()].find(s => s.source.kind !== "code" && s.purpose === "test" && s.nodes.some(n => n.status === "done"));
	const code = [...service.repository.sessions.values()].find(s => s.source.kind === "code" && s.purpose === "test" && s.nodes.some(n => n.status === "done") && s.mainIds.length);
	if (!paper || !code) throw new Error("Existing labelled paper/code fixtures are required");
	const originalUi = new Map([paper, code].map(s => [s.id, structuredClone(s.ui)]));
	const engine = plugin.getReadingEngine(), backendFor = engine.backendFor; let release;
	try {
		await Promise.all([plugin.activateReadingWorkspace({ domain: "paper" }), plugin.activateReadingWorkspace({ domain: "code" }), plugin.activateReadingWorkspace({ domain: "code" })]);
		const pv = domainView("paper"), cv = domainView("code"); check(pv && cv && pv !== cv, "paper and code have separate views");
		const number = leaves().length; await plugin.activateReadingWorkspace({ domain: "code" }); check(leaves().length === number, "repeated entry does not create duplicate tabs");
		await plugin.activateReadingWorkspace({ sessionId: paper.id }); await plugin.activateReadingWorkspace({ sessionId: code.id });
		check(pv.getState().sessionId === paper.id && cv.getState().sessionId === code.id, "session routing respects source domain");
		for (const [view, domain, expected] of [[pv, "paper", ["pdf", "article"]], [cv, "code", ["code"]]]) {
			const previous = new Set(view.modals); view.openSource(); const modal = [...view.modals].find(m => !previous.has(m));
			check(JSON.stringify([...modal.contentEl.querySelector("select").options].map(o => o.value)) === JSON.stringify(expected), domain + " has only matching source types"); modal.close();
			view.openSessionLibrary(); const library = [...view.modals].find(m => !previous.has(m));
			[...library.contentEl.querySelectorAll("button")].find(b => b.textContent === "开发测试").click();
			const rows = [...library.contentEl.querySelectorAll(".reading-library-row")]; check(rows.length && rows.every(row => (service.repository.get(row.dataset.sessionId).source.kind === "code" ? "code" : "paper") === domain), domain + " library excludes other domain"); library.close();
			check(view.getDisplayText().includes(domain === "code" ? "代码分析" : "PDF 深读"), domain + " tab label");
		}
		await service.repository.transact(code.id, s => { s.ui.mode = "map"; s.ui.mainComposerExpanded = true; });
		await service.repository.transact(paper.id, s => { s.ui.mode = "split"; });
		for (const [view, text] of [[pv, "论文草稿独立保留"], [cv, "代码草稿独立保留"]]) { const input = view.contentEl.querySelector("textarea[data-composer^='main:']"); if (!input) throw new Error("Missing test composer"); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); }
		await pause(400); await plugin.activateReadingWorkspace({ domain: "paper" }); await plugin.activateReadingWorkspace({ domain: "code" });
		check(pv.contentEl.querySelector("textarea[data-composer^='main:']").value === "论文草稿独立保留" && cv.contentEl.querySelector("textarea[data-composer^='main:']").value === "代码草稿独立保留", "switch preserves separate drafts");
		check(pv.contentEl.dataset.mode === "split" && cv.contentEl.dataset.mode === "map", "switch preserves separate modes");
		const doc = await service.document(code.id), evidence = doc.evidence[0];
		engine.backendFor = session => session.id !== code.id ? backendFor(session) : { name: "domain-test", model: "fixed", images: false, complete: async request => {
			if (request.system.includes("代码证据选择器")) return JSON.stringify({ ids: [evidence.id], query: "fixture", needsVisual: false });
			return new Promise(resolve => { release = () => resolve(JSON.stringify({ title: "入口隔离验收", content: "固定回复，仅验证切换不打断任务。[" + evidence.id + "]", evidenceIds: [evidence.id] })); });
		} };
		const id = await service.ask(code.id, code.mainIds[0], "入口隔离验收：切换到论文时保留生成任务"); await until(() => !!release);
		await plugin.activateReadingWorkspace({ domain: "paper" }); check(service.repository.get(code.id).nodes.find(n => n.id === id).status === "running" && cv.getState().sessionId === code.id, "switch keeps code generation alive");
		release(); await until(() => service.repository.get(code.id).nodes.find(n => n.id === id).status === "done");
		await plugin.openLearningRecord(code.id, id); check(cv.getState().sessionId === code.id && pv.getState().sessionId === paper.id && cv.contentEl.querySelector(".reading-float"), "evidence jump targets code branch without replacing paper");
		const restoredState = cv.getState(); await cv.setState({ sessionId: code.id }); check(cv.getReadingDomain() === "code", "legacy state infers code domain"); await cv.setState(restoredState);
		await service.repository.flush(); await app.workspace.requestSaveLayout();
		window.__readingDomainRestore = { original: original.map(x => ({ domain: x.leaf.view.getReadingDomain(), state: x.state })), ui: [...originalUi], expected: [pv.getState(), cv.getState()] };
		return { status: "passed", checks: checks.length, details: checks, restoredStates: window.__readingDomainRestore.expected };
	} finally { release?.(); engine.backendFor = backendFor; for (const l of leaves()) for (const modal of l.view.modals) if (!originalModals.has(modal)) modal.close(); }
};
// Pass the saved checkpoint after a vault reload. Plugin disable/enable clears the
// active plugin tab in Obsidian and is not an application layout-restore test.
module.exports.verifyReload = async function verifyDomainReload(app, saved = window.__readingDomainRestore) {
	const plugin = app.plugins.plugins["research-agent-reader"], service = plugin.getReadingWorkspace(); await service.ready();
	if (!saved) throw new Error("Run the domain scenario before reloading"); const leaves = app.workspace.getLeavesOfType("research-interactive-reading");
	for (const leaf of leaves) await leaf.loadIfDeferred(); const views = leaves.map(l => l.view);
	for (const expected of saved.expected) if (!views.some(v => v.getState().domain === expected.domain && v.getState().sessionId === expected.sessionId)) throw new Error("Domain/session not restored: " + expected.domain);
	if (service.repository.errors.length) throw new Error("Reading repository reported restore errors");
	for (const [id, ui] of saved.ui) await service.repository.transact(id, s => { s.ui = ui; });
	for (const view of views) { const previous = saved.original.find(x => x.domain === view.getReadingDomain()); if (previous) await view.setState(previous.state); else view.selectSession(""); }
	return { status: "passed", domainsRestored: saved.expected.map(s => s.domain), restoredOriginalUI: true };
};
