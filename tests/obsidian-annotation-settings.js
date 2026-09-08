// Read-only UI regression: temporary settings clone, no saved preferences or API calls.
(async () => {
	app.setting.open(); app.setting.openTabById("research-agent-reader");
	const actual = app.setting.pluginTabs.find(t => t.id === "research-agent-reader");
	const p = actual.plugin, before = JSON.stringify(p.settings);
	const settings = structuredClone(p.settings);
	const profile = settings.providerProfiles.find(profile => profile.lastTest?.ok);
	if (!profile) throw new Error("UI fixture requires an existing verified profile");
	settings.annotationBackendId = profile.id; settings.annotationWebSearchEnabled = true;
	let saves = 0;
	const shim = Object.assign(Object.create(p), { settings, saveSettings: async () => { saves++; }, getTavilySecretValue: () => "test-only-placeholder" });
	const mount = actual.containerEl.createDiv();
	const tab = new actual.constructor(app, shim); tab.containerEl = mount; tab.activePage = "annotations";
	const win = mount.ownerDocument.defaultView;
	const check = (condition, label) => { if (!condition) throw new Error(label); };
	const setting = name => [...mount.querySelectorAll(".setting-item")].find(el => el.querySelector(".setting-item-name")?.textContent === name);
	try {
		tab.display();
		const dropdown = setting("执行后端").querySelector("select");
		check(dropdown.value === profile.id && ![...dropdown.options].find(o => o.value === profile.id).disabled, "Direct API must be selectable while web is enabled");
		check(!mount.textContent.includes("启用后仅使用 Agent"), "obsolete CLI-only copy removed");
		const toggle = setting("浅层联网解释").querySelector(".checkbox-container");
		toggle.click(); await new Promise(resolve => win.setTimeout(resolve, 10));
		check(!settings.annotationWebSearchEnabled && settings.annotationBackendId === profile.id, "turning web off preserves API selection");
		setting("浅层联网解释").querySelector(".checkbox-container").click(); await new Promise(resolve => win.setTimeout(resolve, 10));
		check(settings.annotationWebSearchEnabled && settings.annotationBackendId === profile.id, "turning web on preserves API selection");
		profile.webSearch = "tavily"; tab.display();
		check(setting("联网方式").textContent.includes("Tavily 搜索"), "explicit Tavily choice reflected in UI");
		shim.getTavilySecretValue = () => ""; tab.display();
		check(setting("联网方式").textContent.includes("联网未就绪") && settings.annotationBackendId === profile.id, "missing key is explained without switching backend");
		const select = setting("执行后端").querySelector("select"); select.value = "auto"; select.dispatchEvent(new win.Event("change")); await new Promise(resolve => win.setTimeout(resolve, 10));
		check(setting("自动选择顺序").textContent.includes("当前使用 Codex CLI"), "automatic fallback described accurately");
		shim.getTavilySecretValue = () => "test-only-placeholder"; tab.display();
		check(setting("自动选择顺序").textContent.includes("通过Tavily 搜索"), "automatic mode can use Tavily");
		check(saves === 3, "only cloned settings received simulated saves");
		check(before === JSON.stringify(p.settings), "real plugin settings remain unchanged");
		return "ANNOTATION_NATIVE_SETTINGS_UI_OK (selection, toggles, Tavily, missing credentials, automatic fallback, unchanged preferences)";
	} finally { tab.hide(); mount.remove(); }
})()
