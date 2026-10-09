// Run through Obsidian CLI eval in the test vault after installing the build.
// UI navigation and temporary element styles only. No model calls or file cleanup.
(async () => {
	const plugin = app.plugins.plugins["research-agent-reader"];
	await plugin.activateDashboardView(); await plugin.getReadingWorkspace().ready();
	const view = app.workspace.getLeavesOfType("agent-dashboard-research-vault")[0].view;
	await view.loadAndRender();
	const el = view.contentEl, win = el.ownerDocument.defaultView, body = el.ownerDocument.body;
	const before = { style: el.style.cssText, theme: body.className, settings: JSON.stringify(plugin.settings), runs: view.runsFilter, expanded: view.runsExpanded, maintenance: view.maintenanceExpanded, scroll: el.scrollTop };
	const checks = [], q = selector => el.querySelector(selector), tick = () => new Promise(resolve => win.setTimeout(resolve, 60));
	const check = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
	try {
		check(el.querySelectorAll("[data-action-id]").length === 8, "all eight actions available");
		check(el.querySelectorAll(".agent-dashboard-primary-actions button").length === 3, "three main actions");
		check(el.querySelectorAll(".agent-dashboard-secondary-actions button").length === 5, "five secondary tools");
		check(q(".agent-dashboard-local-pill").tagName === "SPAN", "local status is not a fake button");
		check(!q(".agent-dashboard-action-rail").textContent.includes("空闲"), "idle labels replaced with purposes");
		check(el.querySelectorAll(".agent-dashboard-tasks .agent-dashboard-data-row").length <= 5, "default task list bounded to five");
		const more = q(".agent-dashboard-more-runs");
		if (more) { more.click(); check(el.querySelectorAll(".agent-dashboard-tasks .agent-dashboard-data-row").length === view.currentData.agentRuns.length, "history expands to all records"); q(".agent-dashboard-more-runs").click(); }
		[...el.querySelectorAll(".agent-dashboard-tasks .agent-dashboard-filter-button")].find(b => b.textContent === "已完成").click();
		check([...el.querySelectorAll(".agent-dashboard-tasks .agent-dashboard-status-badge")].every(b => b.textContent === "已完成"), "done filter excludes unfinished tasks");
		[...el.querySelectorAll(".agent-dashboard-tasks .agent-dashboard-filter-button")].find(b => b.textContent === "全部").click();
		const resultRow = q(".agent-dashboard-run-row");
		if (resultRow) {
			resultRow.click(); await tick();
			const result = el.ownerDocument.querySelector(".agent-dashboard-result-modal");
			check(Boolean(result), "task row opens its saved result");
			result.closest(".modal").querySelector(".modal-header-button:has(.lucide-x)").click();
		}
		const maintenance = q(".agent-dashboard-maintenance"); check(!maintenance.open, "maintenance starts collapsed"); maintenance.open = true; await tick(); view.renderDashboard();
		check(q(".agent-dashboard-maintenance").open, "maintenance stays open during rerender");
		for (const width of [1180, 800, 540, 360]) {
			el.style.width = width + "px"; el.style.maxWidth = width + "px"; el.style.flex = "none"; await tick();
			check(el.scrollWidth <= el.clientWidth + 2, "no horizontal overflow at " + width);
			const columns = win.getComputedStyle(q(".agent-dashboard-primary-actions")).gridTemplateColumns.split(" ").length;
			check(columns === (width <= 620 ? 1 : 3), "primary layout at " + width);
			const graph = q(".agent-dashboard-heatmap-scroll"); check(graph.scrollWidth <= graph.clientWidth + 2, "heatmap fits at " + width);
			const stage = q(".agent-dashboard-heatmap-stage"), weeks = Math.ceil(view.currentData.activity.days.length / 7);
			check(Number(stage.style.getPropertyValue("--dashboard-weeks")) === weeks, "actual calendar width at " + width);
			const otherReading = q(".agent-dashboard-recent-more");
			if (otherReading && width === 360) {
				check([...el.querySelectorAll(".agent-dashboard-recent-item")].filter(item => win.getComputedStyle(item).display !== "none").length === 1, "narrow view starts with one recent paper");
				otherReading.click(); check([...el.querySelectorAll(".agent-dashboard-recent-item")].every(item => win.getComputedStyle(item).display !== "none"), "other recent papers remain accessible"); otherReading.click();
			}
		}
		body.classList.remove("theme-dark"); body.classList.add("theme-light"); await tick();
		check(win.getComputedStyle(el).getPropertyValue("--dashboard-accent").trim() === "#28765c", "light theme accent");
		check(JSON.stringify(plugin.settings) === before.settings, "UI checks preserve settings");
		return JSON.stringify({ ok: true, checks: checks.length, details: checks });
	} finally {
		el.style.cssText = before.style; body.className = before.theme; view.runsFilter = before.runs; view.runsExpanded = before.expanded; view.maintenanceExpanded = before.maintenance;
		view.renderDashboard(); el.scrollTop = before.scroll;
	}
})();
