/* Explicit Obsidian UI stress test. Retains one labelled synthetic session. */
module.exports = async function readingLongScenario(app) {
	const check = (ok, message) => { if (!ok) throw new Error(message); };
	const pause = (ms) => new Promise((resolve) => require("node:timers").setTimeout(resolve, ms));
	const plugin = app.plugins.plugins["research-agent-reader"]; const workspace = plugin.getReadingWorkspace();
	const id = await workspace.demo(); const uuid = () => "r-" + require("node:crypto").randomUUID();
	await workspace.repository.transact(id, (s) => {
		s.title = "长会话验收 · 300 节点（合成示例）"; s.nodes = []; s.branches = []; s.mainIds = [];
		s.ui.windows = []; s.ui.pendingQuote = undefined;
		const add = (branchId, parentId, title) => {
			const n = { id: uuid(), branchId, parentId, title, question: branchId ? "合成示例问题" : "", content: "合成验收内容，不代表论文结论。\n\n".repeat(12), status: "done", error: "", evidence: [], createdAt: new Date().toISOString() };
			s.nodes.push(n); return n.id;
		};
		for (let i = 0; i < 30; i++) s.mainIds.push(add(null, s.mainIds.at(-1) || null, "主线单元 " + (i + 1)));
		for (let i = 0; i < 27; i++) {
			const branch = { id: uuid(), parentNodeId: s.mainIds[i], nodeIds: [], mainSnapshot: "合成背景", mainHeadId: s.mainIds.at(-1), ancestorContext: "", summary: "", summarizedCount: 0 };
			s.branches.push(branch);
			for (let turn = 0; turn < 10; turn++) branch.nodeIds.push(add(branch.id, branch.nodeIds.at(-1) || branch.parentNodeId, "支线 " + (i + 1) + " · 第 " + (turn + 1) + " 轮"));
		}
		s.ui.selectedId = s.mainIds[0]; s.ui.mainFocusId = s.mainIds[0];
	});
	await plugin.activateReadingWorkspace(); let leaf = app.workspace.getLeavesOfType("research-interactive-reading")[0]; let view = leaf.view;
	const before = performance.now(); await view.setState({ sessionId: id }); const renderMs = performance.now() - before;
	await pause(500); check(view.contentEl.querySelectorAll(".reading-map-node").length === 300, "300 cards");
	const map = view.contentEl.querySelector(".reading-map-scroll"); map.scrollTop = 1200;
		const main = view.contentEl.querySelector(".reading-main-chat .reading-messages"); main.style.scrollBehavior = "auto"; main.scrollTop = 600;
	map.dispatchEvent(new Event("scroll")); main.dispatchEvent(new Event("scroll"));
	await pause(800); await workspace.repository.flush();
	check(workspace.repository.get(id).ui.scrollY > 1000, "map scroll saved"); check(workspace.repository.get(id).ui.mainScroll > 500, "main scroll saved");
	const branchId = workspace.repository.get(id).branches[0].id;
	await workspace.repository.transact(id, (s) => { s.ui.collapsed.push(branchId); });
	await pause(300); check(view.contentEl.querySelectorAll(".reading-map-node").length === 291, "collapse nine turns");
	const preservedY = view.contentEl.querySelector(".reading-map-scroll").scrollTop; check(preservedY > 1000, "collapse preserves viewport");
	leaf.detach(); await pause(500); await plugin.activateReadingWorkspace();
	leaf = app.workspace.getLeavesOfType("research-interactive-reading")[0]; view = leaf.view; await view.setState({ sessionId: id }); await pause(800);
	check(view.contentEl.querySelectorAll(".reading-map-node").length === 291, "collapsed state restored");
	check(view.contentEl.querySelector(".reading-map-scroll").scrollTop > 1000, "map scroll restored");
	check(view.contentEl.querySelector(".reading-main-chat .reading-messages").scrollTop > 500, "main scroll restored");
	return { status: "passed", sessionId: id, nodes: 300, visibleAfterCollapse: 291, renderMs: Math.round(renderMs), checks: ["scroll", "collapse", "view close/reopen", "viewport recovery"] };
};
