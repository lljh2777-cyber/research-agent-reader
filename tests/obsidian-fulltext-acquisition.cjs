// Native DOM and plugin integration, using isolated in-memory acquisition records.
// No real providers, model calls, settings/history writes, or file deletion.
module.exports = async function(app) {
	const assert = require("node:assert/strict");
	// Obsidian can keep its renderer hidden during CLI QA; use timers that are not page-throttled.
	const { setTimeout } = require("node:timers");
	const { memory, controlledBackend, waitFor } = require("./fulltext-fixtures.cjs");
	const plugin = app.plugins.plugins["research-agent-reader"], checks = [];
	const before = { settings: JSON.stringify(plugin.settings), history: JSON.stringify(plugin.taskRuns), modals: new Set(plugin.acquisitionModals) };
	const production = plugin.getAcquisitionService(), previousDemo = plugin.acquisitionServices.get("demo");
	const storage = memory(), backend = controlledBackend();
	const service = new production.constructor(new production.repository.constructor(storage, "demo"), "native-ui-test", backend);
	const close = () => { for (const modal of [...plugin.acquisitionModals]) if (!before.modals.has(modal)) modal.close(); };
	const modal = () => [...plugin.acquisitionModals].find(item => !before.modals.has(item));
	const element = () => modal().contentEl;
	const click = action => { const button = element().querySelector(`[data-fulltext-action="${action}"]`); assert.ok(button, action); button.click(); };
	const check = (value, label) => { assert.ok(value, label); checks.push(label); };
	const phase = value => waitFor(() => element().querySelector(`[data-phase="${value}"]`));
	try {
		plugin.acquisitionServices.set("demo", service);
		await plugin.activateDashboardView();
		const dashboard = app.workspace.getLeavesOfType("agent-dashboard-research-vault")[0].view;
		await waitFor(() => dashboard.contentEl.querySelector('[data-action-id="fulltext-acquisition"]'));
		dashboard.contentEl.querySelector('[data-action-id="fulltext-acquisition"]').click(); await production.ready();
		check(Boolean(modal()), "dashboard opens the acquisition panel");
		check(element().querySelector('[data-fulltext-action="start"]').disabled, "formal query requires a valid identifier");
		const input = element().querySelector("input"); input.value = "https://pubmed.ncbi.nlm.nih.gov/123/"; input.dispatchEvent(new Event("input", { bubbles: true }));
		check(element().querySelector(".rar-fulltext-parsed").textContent.includes("PMID · 123") && !element().querySelector('[data-fulltext-action="start"]').disabled, "formal query available after normalization without model configuration");
		input.value = "https://www.nature.com/articles/s41592-026-03217-4"; input.dispatchEvent(new Event("input", { bubbles: true }));
		check(element().querySelector(".rar-fulltext-parsed").textContent === "DOI · 10.1038/s41592-026-03217-4" && !element().querySelector('[data-fulltext-action="start"]').disabled, "reported Nature URL enables the fulltext button with the canonical DOI");
		const originalStart = production.start; let submitted;
		try {
			production.start = async request => { submitted = structuredClone(request); return { id: "native-input-check" }; };
			click("start"); await waitFor(() => submitted && !element().querySelector('[data-fulltext-action="start"]').disabled);
			check(submitted.input.kind === "doi" && submitted.input.value === "10.1038/s41592-026-03217-4" && submitted.goal === "pdf", "click forwards the normalized Nature DOI (submission intercepted; no production task or network)");
		} finally { production.start = originalStart; }
		input.value = "https://example.org/article"; input.dispatchEvent(new Event("input", { bubbles: true }));
		check(element().querySelector('[data-fulltext-action="start"]').disabled && /暂不支持.*请粘贴.*DOI/.test(element().querySelector(".rar-fulltext-parsed").textContent), "unsupported URLs explain the reason and DOI workaround");
		input.value = "https://doi.org/10.1038/s41592-026-03217-4"; input.dispatchEvent(new Event("input", { bubbles: true }));
		check(!element().querySelector('[data-fulltext-action="start"]').disabled, "replacing an unsupported URL with its DOI restores the button"); close();
		plugin.openFulltextAcquisition("demo"); await service.ready();
		click("start"); click("start"); await phase("downloading");
		check(backend.calls === 1 && service.list().length === 1, "double click produces one attempt");
		const job = service.list()[0]; backend.downloads[0].progress(512, 1024);
		check(element().querySelector("progress").value === 512, "progress updates in open panel");
		const initialModal = modal(); close(); plugin.openFulltextAcquisition("demo", job.id); await phase("downloading");
		check(!plugin.acquisitionModals.has(initialModal) && element().querySelector("progress").value === 512, "closing and reopening keeps the active task and detaches old view");
		click("stop"); await phase("cancelled"); click("retry"); await waitFor(() => backend.downloads.length === 2);
		backend.downloads[0].progress(1024, 1024); backend.downloads[0].resolve(); await new Promise(resolve => setTimeout(resolve, 20));
		check(service.get(job.id).phase === "downloading" && service.get(job.id).receivedBytes === undefined, "cancelled attempt cannot update retry");
		backend.downloads[1].resolve(); await phase("acquired");
		check(element().textContent.includes("演示完成") && !element().textContent.includes("文件已获取"), "completion is explicitly simulated");
		check(!plugin.getTaskRuns().some(run => run.id === job.id), "demo is absent from formal TaskRun history");
		const select = element().querySelector("select"); select.value = "selection"; select.dispatchEvent(new Event("change", { bubbles: true })); click("start"); await phase("awaiting_selection");
		click("c-two"); await waitFor(() => backend.downloads.length === 3); check(backend.downloads[2].candidate.id === "c-two", "selected candidate determines continuation");
		storage.failSnapshot = true; backend.downloads[2].resolve(); await phase("failed");
		check(element().textContent.includes("快照保存失败"), "snapshot save failure never appears completed");
		const box = modal().modalEl, style = box.style.cssText;
		for (const width of [360, 680]) { box.style.width = width + "px"; await new Promise(r => setTimeout(r, 30)); check(element().scrollWidth <= element().clientWidth + 2, "panel fits width " + width); }
		box.style.cssText = style;
		check(JSON.stringify(plugin.settings) === before.settings && JSON.stringify(plugin.taskRuns) === before.history, "settings and existing task history preserved");
		return { ok: true, checks };
	} finally {
		close(); await service.dispose();
		if (previousDemo) plugin.acquisitionServices.set("demo", previousDemo); else plugin.acquisitionServices.delete("demo");
	}
};
