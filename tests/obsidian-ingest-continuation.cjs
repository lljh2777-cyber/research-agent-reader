// Native UI regression with in-memory task persistence and a deferred fake backend.
// No real PDF/model/MinerU requests, no settings/history writes, no file cleanup.
module.exports = async function (app) {
	const plugin = app.plugins.plugins["research-agent-reader"];
	if (plugin.isActionRunning("paper-ingest")) throw new Error("请在真实入库任务结束后运行验收");
	await plugin.activateDashboardView();
	const view = app.workspace.getLeavesOfType("agent-dashboard-research-vault")[0].view;
	const doc = view.contentEl.ownerDocument, win = doc.defaultView;
	const prefix = "continuation-ui-" + Date.now(), ids = new Set(), checks = [];
	const profile = { id: prefix, name: "入库续办界面验收", model: "deterministic", lastTest: { ok: true } };
	const before = { settings: JSON.stringify(plugin.settings), history: JSON.stringify(plugin.taskRuns), filter: view.runsFilter, scroll: view.contentEl.scrollTop, modals: new Set(doc.querySelectorAll(".modal-container")) };
	const original = new Map(), pending = new Map(), operations = []; let backendCalls = 0;
	const patch = (name, fn) => { original.set(name, { own: Object.hasOwn(plugin, name), value: plugin[name] }); plugin[name] = fn; };
	const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
	const wait = async condition => { for (let n = 0; n < 100; n++) { if (condition()) return; await new Promise(r => win.setTimeout(r, 20)); } throw new Error("UI condition timed out"); };
	const button = () => view.contentEl.querySelector('[data-action-id="paper-ingest"]');
	const closeModals = () => { for (const el of doc.querySelectorAll(".modal-container")) if (!before.modals.has(el)) el.querySelector(".modal-close-button, .modal-header-button:has(.lucide-x)")?.click(); };
	const outcome = (status = "failed") => ({ exitCode: status === "done" ? 0 : status === "interrupted" ? 130 : 1, stdout: "续办验收固定输出", stderr: "", loopStatus: status === "interrupted" ? "cancelled" : "completed", artifacts: { articlePath: "", wikiPath: "", filesWritten: [] }, result: { status: status === "done" ? "completed" : "failed", errors: ["验收：重复判定与检索回执冲突"], conflicts: [] } });
	const request = { version: 1, runId: prefix, profileId: prefix, options: { sourcePdfPath: "E:/" + prefix + ".pdf", requestNotes: "", identityCandidateTitle: "", identityCandidateDoi: "", createArticleMarkdown: false, createArticleWiki: true, articleWikiSource: "pdf", mineruModel: "vlm", mineruLanguage: "en", mineruOcr: false, mineruFormula: true, mineruTable: true, mineruPages: "", mineruTimeoutSeconds: 600, mineruIncludeSourcePdf: false, remoteUploadConfirmed: false } };
	const old = { id: prefix, actionId: "paper-ingest", label: "文献入库", status: "failed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: request.options.sourcePdfPath, error: "验收旧任务失败", output: "验收旧任务失败", executionConfig: { backend: "direct-api", providerId: prefix, model: "deterministic" } };
	const continuation = async previous => {
		await plugin.continuePaperIngest(previous);
		const modal = [...doc.querySelectorAll(".modal-container")].find(el => !before.modals.has(el) && el.querySelector('[aria-label="续办模型"]'));
		check(Boolean(modal), "continuation dialog opens");
		return [...modal.querySelectorAll("button")].find(b => b.textContent === "核对并继续");
	};
	try {
		patch("persistTaskRunRetention", async candidates => {
			for (const run of candidates) if (run.summary?.includes(prefix)) ids.add(run.id);
			if (candidates.some(r => ids.has(r.id))) { plugin.taskRuns = candidates; return; }
			return original.get("persistTaskRunRetention").value.call(plugin, candidates, plugin.settings.taskHistoryLimit);
		});
		patch("persistTaskRunOutput", async run => ids.has(run.id) ? "" : original.get("persistTaskRunOutput").value.call(plugin, run));
		patch("getIngestRecords", () => ({ read: async (kind, id) => id === prefix || ids.has(id) ? { ...request, runId: id } : original.get("getIngestRecords").value.call(plugin).read(kind, id) }));
		patch("getVerifiedProviderProfiles", () => [profile]);
		patch("getProviderProfile", id => id === prefix ? profile : original.get("getProviderProfile").value.call(plugin, id));
		patch("runLightPaperIngest", async id => {
			if (!ids.has(id)) throw new Error("验收不调用真实入库");
			backendCalls++;
			return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
		});
		patch("stopTaskRun", id => {
			if (!pending.has(id)) return original.get("stopTaskRun").value.call(plugin, id);
			pending.get(id).resolve(outcome("interrupted")); pending.delete(id); return true;
		});
		ids.add(old.id); plugin.taskRuns = [old, ...plugin.taskRuns]; view.runsFilter = "all"; await view.loadAndRender();
		const idleButton = button(), start = await continuation(old);
		const first = start.onclick(new win.MouseEvent("click"));
		operations.push(first);
		await wait(() => pending.size === 1);
		await start.onclick(new win.MouseEvent("click")); check(backendCalls === 1, "double click starts one backend");
		const running = plugin.getRunningTaskRun("paper-ingest");
		await wait(() => button().classList.contains("is-running") && view.currentData.agentRuns.some(r => r.runId === running.id && r.status === "running"));
		check(true, "new running task and stop button refresh without vault events");
		check(view.currentData.agentRuns.some(r => r.runId === old.id && r.status === "failed"), "previous failure stays separate from continuation");
		pending.get(running.id).resolve(outcome()); pending.delete(running.id); await first;
		await wait(() => !button().classList.contains("is-running"));
		check(!plugin.isActionRunning("paper-ingest"), "failed continuation releases intake entry");
		check(plugin.getTaskRun(running.id).error.includes("检索回执冲突"), "structured failure is retained when stderr is empty");
		closeModals();
		const secondStart = await continuation(plugin.getTaskRun(running.id));
		const second = secondStart.onclick(new win.MouseEvent("click")); operations.push(second); await wait(() => pending.size === 1);
		idleButton.click(); await second;
		check(plugin.getTaskRuns().find(r => ids.has(r.id) && r.status === "interrupted"), "stale idle button stops the live task");
		await wait(() => !button().classList.contains("is-running")); closeModals();
		const thirdStart = await continuation(old), third = thirdStart.onclick(new win.MouseEvent("click")); operations.push(third); await wait(() => pending.size === 1);
		const exceptionRun = plugin.getRunningTaskRun("paper-ingest");
		pending.get(exceptionRun.id).reject(new Error("验收：请求超时")); pending.delete(exceptionRun.id); await third;
		await wait(() => !button().classList.contains("is-running"));
		check(plugin.getTaskRun(exceptionRun.id).status === "failed", "thrown request error terminates task");
		check(doc.querySelector(".agent-dashboard-result-output")?.textContent.includes("请求超时"), "exception opens readable failed result");
		closeModals(); button().click();
		check([...doc.querySelectorAll(".modal-container")].some(el => !before.modals.has(el)), "intake entry opens the next request after failure");
		check(JSON.stringify(plugin.settings) === before.settings, "settings unchanged");
		check(JSON.stringify(plugin.taskRuns.filter(r => !ids.has(r.id))) === before.history, "user task history unchanged");
		return { ok: true, checks: checks.length, details: checks, backendCalls, realModelCalls: 0 };
	} finally {
		for (const value of pending.values()) value.resolve(outcome("interrupted"));
		await Promise.allSettled(operations);
		closeModals();
		for (const [name, saved] of original) { if (saved.own) plugin[name] = saved.value; else delete plugin[name]; }
		plugin.taskRuns = plugin.taskRuns.filter(r => !ids.has(r.id));
		view.runsFilter = before.filter; await view.loadAndRender(); view.contentEl.scrollTop = before.scroll;
	}
};
