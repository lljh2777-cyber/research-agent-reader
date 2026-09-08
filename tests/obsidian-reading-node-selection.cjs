/* Native DOM regression. Reuses a labelled test session and restores its UI.
 * No model calls, real-paper changes, note exports, or file deletion. */
module.exports = async function readingNodeSelectionScenario(app) {
	const checks = []; const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
	const pause = (ms = 100) => new Promise(resolve => require("node:timers").setTimeout(resolve, ms));
	const plugin = app.plugins.plugins["research-agent-reader"]; const service = plugin.getReadingWorkspace(); await service.ready();
	const fixture = [...service.repository.sessions.values()].find(s => s.demo && s.purpose === "test" && s.mainIds.length >= 3 && s.branches.length && s.nodes.length < 30);
	if (!fixture) throw new Error("Open an existing small development test session before this check");
	await plugin.activateReadingWorkspace(); const view = app.workspace.getLeavesOfType("research-interactive-reading")[0].view;
	const previousId = view.getState().sessionId; const originalUI = structuredClone(fixture.ui); const originalDrafts = new Map(view.localDrafts);
	const id = fixture.id; const root = view.contentEl; const session = () => service.repository.get(id);
	const [first, second] = fixture.mainIds; const branch = fixture.branches[0]; const branchNode = branch.nodeIds[0];
	const nodeButton = nodeId => root.querySelector('[data-node-id="' + nodeId + '"] .reading-node-open');
	const settle = async () => { await service.repository.flush(); await pause(); };
	const click = async nodeId => { const button = nodeButton(nodeId); button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await settle(); return button; };
	const doubleClick = async nodeId => {
		const button = await click(nodeId);
		check(button.isConnected && button === nodeButton(nodeId), "first click retains double-click target " + nodeId);
		button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
		button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })); await settle();
	};
	const floating = key => [...root.querySelectorAll(".reading-float")].find(w => w.dataset.windowKey === key);
	const originalAdvance = service.advance;
	try {
		await view.setState({ sessionId: id });
		for (const mode of ["split", "map"]) {
			await service.repository.transact(id, s => { Object.assign(s.ui, { mode, windows: [], collapsed: [], selectedId: first, mainFocusId: first, pendingQuote: undefined, mainComposerExpanded: true }); });
			view.quote = undefined; view.render(true); await settle();
			const messages = root.querySelector(".reading-main-chat .reading-messages"); const scrollTop = messages.scrollTop;
			await click(second);
			check(session().ui.selectedId === second && session().ui.mainFocusId === second, mode + " single click selects main/input target");
			check(!session().ui.windows.length && !root.querySelector(".reading-float"), mode + " single click does not open a window");
			check(messages.isConnected && messages.scrollTop === scrollTop, mode + " single click preserves transcript position");
			check(nodeButton(second).getAttribute("aria-current") === "true" && !nodeButton(first).closest(".reading-map-node").classList.contains("is-selected"), mode + " selection highlight moves");
			let input = root.querySelector("textarea[data-composer^='main:']"); input.value = "selection-regression-draft"; input.dispatchEvent(new Event("input", { bubbles: true }));
			await click(first); await click(second);
			check(root.querySelector("textarea[data-composer^='main:']").value === "selection-regression-draft", mode + " main drafts stay isolated");
			await doubleClick(first);
			check(session().ui.selectedId === first && floating(first)?.querySelector('[data-answer-id="' + first + '"]'), mode + " main double click opens its answer");
			await service.repository.transact(id, s => { s.ui.windows[0].pinned = true; s.ui.windows[0].minimized = true; }); await settle();
			const pinned = floating(first); const geometry = JSON.stringify(session().ui.windows[0]);
			await click(branchNode);
			check(session().ui.selectedId === branchNode && session().ui.mainFocusId === first, mode + " branch selection keeps main input target");
			check(floating(first) === pinned && JSON.stringify(session().ui.windows[0]) === geometry && session().ui.windows.length === 1, mode + " selection preserves pinned/minimized window");
			await doubleClick(branchNode);
			check(floating(branch.id)?.querySelector('[data-answer-id="' + branchNode + '"]') && session().ui.windows.length === 2, mode + " branch double click opens alongside pinned window");
			await click(first); check(session().ui.windows.find(w => w.key === first).minimized, mode + " single click does not restore minimized window");
			await doubleClick(first); check(!session().ui.windows.find(w => w.key === first).minimized, mode + " double click restores minimized window");
			nodeButton(second).focus(); nodeButton(second).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await settle();
			check(floating(second) && session().ui.selectedId === second, mode + " Enter opens selected answer");
			await click(first); await pause(500); await service.repository.flush();
			const saved = JSON.parse(await service.repository.storage.read(id));
			check(saved.ui.selectedId === first && saved.ui.mainFocusId === first, mode + " selection saved");
			for (const nodeId of [second, branchNode]) {
				for (const region of [".reading-node-meta", ".reading-node-meta > span:not(.reading-icon)", ".reading-node-meta svg path", "padding", "lower edge"]) {
					await service.repository.transact(id, s => { s.ui.windows = []; s.ui.selectedId = first; s.ui.zoom = 1; }); await settle();
					const card = nodeButton(nodeId).closest(".reading-map-node");
					card.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); await pause();
					const rect = card.getBoundingClientRect();
					const target = region === "padding" ? card : region === "lower edge" ? root.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 2) : card.querySelector(region);
					check(target && target.closest(".reading-map-node") === card && !target.closest("button"), mode + " lower hit region " + region);
					target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); await settle();
					check(session().ui.selectedId === nodeId && !session().ui.windows.length && target.isConnected, mode + " lower single click " + region);
					target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
					target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })); await settle();
					check(session().ui.windows.length === 1 && session().ui.windows[0].nodeId === nodeId, mode + " lower double click " + region);
				}
			}
			await service.repository.transact(id, s => { s.ui.windows = []; s.ui.selectedId = first; s.ui.collapsed = []; }); await settle();
			const fold = nodeButton(branchNode).closest(".reading-map-node").querySelector(".reading-node-meta button");
			fold.querySelector("svg").dispatchEvent(new MouseEvent("click", { bubbles: true })); await settle();
			check(session().ui.collapsed.includes(branch.id) && session().ui.selectedId === first && !session().ui.windows.length, mode + " fold button does not select or open parent");
			const expand = nodeButton(branchNode).closest(".reading-map-node").querySelector(".reading-node-meta button");
			expand.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })); await settle();
			check(!session().ui.windows.length && session().ui.selectedId === first, mode + " nested button double click does not open parent");
			let advances = 0; service.advance = async () => { advances++; };
			const advance = root.querySelector(".reading-advance"); check(advance, mode + " next-step button available");
			advance.querySelector("svg").dispatchEvent(new MouseEvent("click", { bubbles: true })); await settle();
			check(advances === 1 && session().ui.selectedId === first && !session().ui.windows.length, mode + " next-step button keeps its own action");
			service.advance = originalAdvance;
		}
		await view.setState({ sessionId: id }); await settle();
		check(nodeButton(first).getAttribute("aria-current") === "true", "selection restored on view reload");
		return { status: "passed", checks: checks.length, details: checks };
	} finally {
		service.advance = originalAdvance;
		await pause(650); await service.repository.flush(); view.localDrafts = originalDrafts;
		await service.repository.transact(id, s => { s.ui = originalUI; });
		if (previousId) await view.setState({ sessionId: previousId });
	}
};
