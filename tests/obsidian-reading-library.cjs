/* UI fixtures stay in reading-test-sessions. Never delete or call models. */
module.exports = async function readingLibraryScenario(app) {
	const check = (ok, text) => { if (!ok) throw new Error(text); };
	const pause = () => new Promise(resolve => require("node:timers").setTimeout(resolve, 200));
	const p = app.plugins.plugins["research-agent-reader"]; await p.activateReadingWorkspace(); const service = p.getReadingWorkspace();
	const view = app.workspace.getLeavesOfType("research-interactive-reading")[0].view; const original = view.sessionId;
	const id = await service.demo("test");
	const click = (root, label) => { const button = [...root.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === label); check(button, label); button.click(); };
	try {
		// Temporarily expose this explicitly isolated fixture to exercise normal-session actions.
		await service.repository.transact(id, s => { s.purpose = "reading"; s.demo = false; s.title = "会话管理验收（示例）"; });
		await view.setState({ sessionId: id }); view.openSessionLibrary(); await pause();
		const modal = document.querySelector(".reading-library-modal"); const row = () => modal.querySelector('[data-session-id="' + id + '"]');
		check(row(), "regular fixture visible");
		check([...modal.querySelectorAll("[data-session-id]")].every(r => service.repository.get(r.dataset.sessionId).purpose === "reading"), "tests hidden from normal list");
		click(row(), "置顶"); await pause(); check(service.repository.get(id).pinned, "pin saved");
		click(row(), "重命名"); await pause(); const rename = [...view.modals].find(m => m.titleEl.textContent === "重命名阅读会话");
		rename.contentEl.querySelector("input").value = "可搜索的学习会话"; click(rename.contentEl, "保存名称"); await pause(); check(service.repository.get(id).title === "可搜索的学习会话", "rename saved");
		const search = modal.querySelector("input[type=search]"); search.value = "可搜索"; search.dispatchEvent(new Event("input")); check(modal.querySelectorAll("[data-session-id]").length === 1, "search filters sessions");
		click(row(), "归档"); await pause(); check(service.repository.get(id).archived && !row(), "archive keeps history but hides row");
		click(modal, "已归档"); await pause(); check(row(), "archive tab"); click(row(), "恢复会话"); await pause(); check(!service.repository.get(id).archived, "unarchive saved");
		search.value = ""; search.dispatchEvent(new Event("input")); click(modal, "开发测试"); await pause();
		check([...modal.querySelectorAll("[data-session-id]")].every(r => service.repository.get(r.dataset.sessionId).purpose === "test"), "test category isolated");
		await service.repository.flush();
		return { status: "passed", sessionId: id, checks: ["default filter", "search", "pin", "rename", "archive", "restore", "test category", "save"] };
	} finally {
		for (const modal of view.modals) modal.close();
		await service.repository.transact(id, s => { s.purpose = "test"; s.demo = true; s.archived = false; s.title = "会话管理验收（示例）"; });
		await view.setState({ sessionId: original });
	}
};
