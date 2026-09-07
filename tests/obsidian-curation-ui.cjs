// Explicit Obsidian UI check with an already-generated review. No model calls, note writes or deletion.
module.exports = async function curationUIScenario(app, reviewId) {
	const plugin = app.plugins.plugins["research-agent-reader"]; const service = plugin.getCurationService(); await service.ready(); const record = service.reviews.get(reviewId);
	if (!record || record.state !== "ready") throw new Error("A completed review is required");
	const pause = () => new Promise(resolve => require("node:timers").setTimeout(resolve, 80));
	const until = async test => { for (let i = 0; i < 150; i++) { if (test()) return; await pause(); } throw new Error("UI timeout"); };
	const check = (value, name) => { if (!value) throw new Error(name); };
	const hash = text => require("node:crypto").createHash("sha256").update(text).digest("hex");
	const snapshot = async () => Object.fromEntries(await Promise.all(app.vault.getMarkdownFiles().filter(f => f.path.startsWith("wiki/")).map(async f => [f.path, hash(await app.vault.cachedRead(f))])));
	const before = await snapshot(); const count = () => [...service.reviews.values()].filter(r => r.context.key === record.context.key).reduce((sum, review) => sum + review.usage.calls, 0); const calls = count(); const doc = document;
	const current = () => [...doc.querySelectorAll(".curation-modal")].at(-1);
	const closeAll = async () => { for (const modal of [...doc.querySelectorAll(".curation-modal")].reverse()) modal.querySelector(".modal-close-button, .modal-header-button")?.click(); await until(() => !doc.querySelector(".curation-modal")); };
	const click = (root, text) => { const button = [...root.querySelectorAll("button")].find(b => b.textContent === text); check(button && !button.disabled, "enabled button: " + text); button.click(); };
	await closeAll(); window.dispatchEvent(new Event("focus")); plugin.openKnowledgeCuration(record.context.sessionId, record.context.nodeIds[0], record); await pause();
	try {
		let modal = current(); check(modal, "curation opens"); check(modal.querySelector(".curation-status").textContent.includes("未调用模型"), "saved review is explicit");
		check(!modal.querySelector(".curation-suggestion input:checked"), "no automatic acceptance"); check(getComputedStyle(modal).resize === "both", "resizable workbench");
		const enabled = [...modal.querySelectorAll(".curation-suggestion input[type=checkbox]")].filter(c => !c.disabled); check(enabled.length, "applicable suggestion is available");
		enabled[0].checked = true; enabled[0].dispatchEvent(new Event("change")); click(modal, "预览选中修改"); await until(() => !!doc.querySelector(".curation-revision-modal"));
		const preview = current(); check(preview.querySelectorAll(".curation-revision-file").length >= 2, "note and log are both previewed");
		check(preview.querySelector(".curation-diff-columns").textContent.includes("变化位置"), "changes shown before full file"); check(!preview.querySelector(".curation-diff-columns").textContent.includes("title_zh:"), "unchanged metadata does not crowd the initial diff");
		preview.style.width = "760px"; preview.style.height = "500px"; await pause(); check(preview.querySelector(".curation-footer").getBoundingClientRect().bottom <= preview.getBoundingClientRect().bottom, "apply remains visible after resize");
		click(preview, "关闭"); await pause(); modal = current();
		const checkboxes = modal.querySelectorAll(".curation-nodes input"); checkboxes[0].checked = false; checkboxes[0].dispatchEvent(new Event("change")); check(!modal.querySelector(".curation-suggestion"), "changed scope clears stale results");
		check([...modal.querySelectorAll("button")].find(b => b.textContent === "预览选中修改").disabled, "scope change clears apply selection"); await closeAll();
		await service.generate(record.context); check(count() === calls, "reloaded cache makes no model call");
		window.dispatchEvent(new Event("focus")); plugin.openKnowledgeMaintenance(); await pause(); modal = current(); check(modal.textContent.includes("待审阅"), "maintenance opens");
		for (const tab of ["需复查", "修订记录", "索引", "待审阅"]) { click(modal, tab); await pause(); }
		check(JSON.stringify(await snapshot()) === JSON.stringify(before), "all wiki contents preserved");
		return { status: "passed", checks: ["saved review", "no automatic acceptance", "selected diff", "full file expansion", "resizable footer", "scope isolation", "cache reuse", "maintenance navigation", "all wiki hashes unchanged"] };
	} finally { await closeAll(); }
};
