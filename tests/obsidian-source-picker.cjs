/* Native Obsidian directory picker UI. Read-only: no models, new sessions or file cleanup.
 * System-dialog options/cancellation are covered by the offline adapter test. */
module.exports = async function sourcePickerScenario(app) {
	const path = require("node:path"); const plugin = app.plugins.plugins["research-agent-reader"];
	await plugin.activateReadingWorkspace(); const view = app.workspace.getLeavesOfType("research-interactive-reading")[0].view;
	const original = new Set(view.modals), count = plugin.getReadingWorkspace().repository.sessions.size, checks = [];
	const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
	const waitFor = async predicate => { for (let i = 0; i < 40; i++) { const value = predicate(); if (value) return value; await new Promise(r => require("node:timers").setTimeout(r, 50)); } throw new Error("UI did not become ready"); };
	const click = (root, text) => { const button = [...root.querySelectorAll("button")].find(b => b.textContent === text); if (!button) throw new Error("Missing button: " + text); button.click(); return button; };
	const rootPath = app.vault.adapter.getBasePath(); const files = app.vault.getFiles();
	try {
		view.openSource({ source: { kind: "code", path: "unchanged.py" } });
		const modal = [...view.modals].find(m => !original.has(m)), el = modal.contentEl, input = el.querySelector('[aria-label="原文位置"]'), kind = el.querySelector("select");
		check(input.value === "unchanged.py", "manual path preserved");
		check([...el.querySelectorAll("button")].some(b => b.textContent === "本机文件夹" && !b.hidden), "folder picker available for code");
		click(el, "从 Vault 选择"); let picker = await waitFor(() => document.querySelector(".reading-vault-source-modal"));
		click(picker, "选为项目"); check(input.value === "unchanged.py", "selection waits for confirmation"); click(picker, "使用所选来源");
		check(input.value === rootPath && !document.querySelector(".reading-vault-source-modal"), "vault project path filled");
		for (const [type, candidate] of [["pdf", files.find(f => f.extension.toLowerCase() === "pdf")], ["article", files.find(f => f.name.toLowerCase() === "article.md")]]) {
			if (!candidate) throw new Error("Test vault has no " + type + " fixture");
			kind.value = type; kind.dispatchEvent(new Event("change")); check([...el.querySelectorAll("button")].find(b => b.textContent === "本机文件夹").hidden, type + " hides folder action");
			click(el, "从 Vault 选择"); picker = await waitFor(() => document.querySelector(".reading-vault-source-modal"));
			let folder = ""; for (const segment of candidate.path.split("/").slice(0, -1)) { folder = folder ? folder + "/" + segment : segment; const target = folder; const dir = await waitFor(() => [...picker.querySelectorAll("details")].find(d => d.dataset.sourceDirectory === target)); dir.open = true; }
			const file = await waitFor(() => [...picker.querySelectorAll(".reading-source-file")].find(f => f.dataset.sourcePath === candidate.path));
			check(!picker.querySelector(".reading-source-pick-folder"), type + " directory selection disabled"); file.click(); click(picker, "使用所选来源");
			check(input.value === path.resolve(rootPath, candidate.path), type + " file path filled");
		}
		const before = input.value; click(el, "从 Vault 选择"); await waitFor(() => document.querySelector(".reading-vault-source-modal")); kind.value = "code"; kind.dispatchEvent(new Event("change"));
		check(!document.querySelector(".reading-vault-source-modal") && input.value === before, "kind switch closes stale picker and keeps path");
		click(el, "从 Vault 选择"); await waitFor(() => document.querySelector(".reading-vault-source-modal")); modal.close();
		check(!document.querySelector(".reading-vault-source-modal"), "parent close disposes child picker");
		view.openRelocate(); const relocate = [...view.modals].find(m => !original.has(m)); check(relocate?.contentEl.querySelector('[aria-label="原文新位置"]') && relocate.contentEl.textContent.includes("从 Vault 选择"), "relocation shares picker"); relocate.close();
		check(plugin.getReadingWorkspace().repository.sessions.size === count, "selection creates no sessions");
		return { status: "passed", checks: checks.length, details: checks };
	} finally { for (const modal of view.modals) if (!original.has(modal)) modal.close(); }
};
