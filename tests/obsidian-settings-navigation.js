// Run with Obsidian CLI eval after installing the development build in a test vault.
// Only navigates UI and changes temporary DOM layout. No model requests or cleanup.
(async () => {
	app.setting.open(); app.setting.openTabById("research-agent-reader");
	const tab = app.setting.pluginTabs.find(t => t.id === "research-agent-reader");
	const el = tab.containerEl, win = el.ownerDocument.defaultView;
	const settingsBefore = JSON.stringify(tab.plugin.settings);
	const styleBefore = el.style.cssText;
	const body = el.ownerDocument.body, classesBefore = body.className;
	const checks = [];
	const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
	const query = selector => el.querySelector(selector);
	const tick = () => new Promise(resolve => setTimeout(resolve, 30));
	const search = value => { const input = query('[aria-label="搜索全部设置"]'); input.value = value; input.dispatchEvent(new win.Event("input", { bubbles: true })); };
	const jump = page => { const select = query('[aria-label="切换设置页面"]'); select.value = page; select.dispatchEvent(new win.Event("change", { bubbles: true })); };
	try {
		tab.homeFilter = "common"; tab.homeQuery = ""; tab.homeExpanded = false; tab.navigateSettings("home");
		check(!query(".rar-settings-more").open && query(".rar-settings-grid").children.length === 6, "six common entries, optional tools collapsed");
		query('[data-filter="reading"]').click(); search("BGE");
		check(query(".rar-settings-grid").children.length === 1 && query('[data-settings-target="retrieval"]'), "global search reaches another category");
		query('[data-settings-target="retrieval"]').click();
		check(el.dataset.settingsPage === "retrieval" && query('[aria-label="返回设置首页"]'), "retrieval page has back navigation");
		query('[aria-label="返回设置首页"]').click();
		check(query('[aria-label="搜索全部设置"]').value === "BGE", "search survives returning from detail");
		check(el.ownerDocument.activeElement?.dataset.settingsTarget === "retrieval", "keyboard focus returns to originating card");
		search("no-such-option-xyz"); check(query(".rar-settings-empty"), "empty search is explained");
		query('[aria-label="清除设置搜索"]').click();
		check(query('[data-filter="reading"]').getAttribute("aria-pressed") === "true", "clearing search restores selected category");
		query('[data-filter="all"]').click();
		const pages = [...el.querySelectorAll("[data-settings-target]")].map(e => e.dataset.settingsTarget);
		check(pages.length === 12, "all twelve settings pages discoverable");
		el.style.height = "480px"; el.style.flex = "none"; el.scrollTop = 180; const homeScroll = el.scrollTop;
		query('[data-settings-target="direct-api"]').click();
		check(el.scrollTop === 0, "new detail page starts at top");
		const profile = query(".agent-dashboard-provider-form"), advanced = query('[data-disclosure="api-web"]');
		check(!profile || Boolean(profile.compareDocumentPosition(advanced) & win.Node.DOCUMENT_POSITION_FOLLOWING), "model configuration precedes optional networking");
		check([...el.querySelectorAll(".rar-settings-disclosure")].every(d => !d.open), "API advanced sections initially collapsed");
		advanced.open = true; tab.display();
		check(query('[data-disclosure="api-web"]').open, "advanced section survives immediate rerender");
		el.scrollTop = 160; const detailScroll = el.scrollTop; tab.display();
		check(Math.abs(el.scrollTop - detailScroll) < 2, "same-page rerender preserves scroll");
		query('[aria-label="返回设置首页"]').click();
		check(homeScroll > 0 && Math.abs(el.scrollTop - homeScroll) < 2, "back restores home scroll");
		query('[data-settings-target="data"]').click();
		check(!query('[data-disclosure="data-cleanup"]').open, "cleanup stays collapsed");
		check(el.textContent.includes("不影响 PDF 交互深读会话"), "query history scope distinguished from reading sessions");
		for (const page of pages) {
			jump(page); await tick();
			check(el.dataset.settingsPage === page && query("h2") && query('[aria-label="返回设置首页"]'), `page available: ${page}`);
		}
		for (const width of [980, 540, 360]) {
			el.style.width = `${width}px`; el.style.maxWidth = `${width}px`; el.style.padding = "16px";
			for (const page of ["home", ...pages]) {
				tab.navigateSettings(page); await tick();
				check(el.scrollWidth <= el.clientWidth + 2, `no horizontal overflow: ${page} at ${width}`);
			}
			tab.navigateSettings("home");
			const columns = win.getComputedStyle(query(".rar-settings-grid")).gridTemplateColumns.split(" ").length;
			check(columns === (width <= 650 ? 1 : 2), `responsive card columns at ${width}`);
		}
		body.classList.remove("theme-dark"); body.classList.add("theme-light");
		tab.navigateSettings("home");
		check(win.getComputedStyle(el).getPropertyValue("--rar-settings-accent").trim() === "#32745f", "light theme uses readable accent");
		check(JSON.stringify(tab.plugin.settings) === settingsBefore, "navigation and layout checks do not change saved settings");
		return JSON.stringify({ ok: true, checks: checks.length, details: checks });
	} finally {
		el.style.cssText = styleBefore; body.className = classesBefore;
		tab.homeFilter = "common"; tab.homeQuery = ""; tab.homeExpanded = false;
		tab.disclosureState.clear(); tab.pageScroll.clear(); tab.navigateSettings("home"); el.scrollTop = 0;
	}
})()
