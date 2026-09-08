/* Native Obsidian regression; reuses a labelled test session, restores its UI, no model calls or deletion. */
module.exports = async function readingMotionScenario(app) {
	const check = (ok, label) => { if (!ok) throw new Error(label); };
	const pause = ms => new Promise(resolve => require("node:timers").setTimeout(resolve, ms));
	const plugin = app.plugins.plugins["research-agent-reader"]; const workspace = plugin.getReadingWorkspace();
	await workspace.ready();
	let session = [...workspace.repository.sessions.values()].find(s => s.demo && s.nodes.length === 300);
	if (!session) { const id = await workspace.demo("test"); session = workspace.repository.get(id); }
	await plugin.activateReadingWorkspace(); const view = app.workspace.getLeavesOfType("research-interactive-reading")[0].view;
	const previousId = view.getState().sessionId; const originalUI = JSON.parse(JSON.stringify(session.ui));
	const id = session.id; const root = view.contentEl; const win = root.ownerDocument.defaultView;
	const originalMatchMedia = win.matchMedia;
	const originalWidth = root.style.width;
	const clickMode = mode => root.querySelector(`[data-reading-mode="${mode}"]`).click();
	const readMode = async mode => { await workspace.repository.flush(); check(root.dataset.mode === mode, "persisted mode " + mode); };
	const checks = [];
	const settled = async () => {
		for (let i = 0; i < 100 && root.classList.contains("is-mode-transitioning"); i++) await pause(25);
		check(!root.classList.contains("is-mode-transitioning"), "transition completes within 2.5s: " + JSON.stringify(root.getAnimations({ subtree: true }).map(a => ({ target: a.effect.target.className, time: a.currentTime, state: a.playState }))));
	};
	try {
		await workspace.repository.transact(id, s => { s.ui.mode = "split"; s.ui.split = .5; s.ui.collapsed = []; s.ui.windows = [];
			s.ui.mainComposerExpanded = true; s.ui.pendingQuote = undefined; s.ui.mainFocusId = s.mainIds[0]; s.ui.selectedId = s.mainIds[0]; });
		await view.setState({ sessionId: id }); await pause(200);
		const first = workspace.repository.get(id).mainIds[0];
		await workspace.repository.transact(id, s => { s.ui.windows = [{ key: first, nodeId: first, pinned: true, minimized: true, x: 32, y: 130, width: 480, height: 440 }]; });
		await pause(100);
		const map = root.querySelector(".reading-map-canvas"); const card = map.firstElementChild.nextElementSibling;
		const floating = root.querySelector(".reading-float"); const scroll = root.querySelector(".reading-map-scroll");
		const input = root.querySelector("textarea[data-composer^='main:']"); input.value = "模式切换草稿验证";
		const messages = root.querySelector(".reading-main-chat .reading-messages"); messages.style.scrollBehavior = "auto"; messages.scrollTop = messages.scrollHeight;
		const transcriptY = messages.scrollTop;
		input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); input.setSelectionRange(2, 5);
		scroll.scrollTop = 500; await pause(500);
		const oldY = scroll.scrollTop; const initialX = map.getBoundingClientRect().left;
		const width = root.querySelector(".reading-main-chat").getBoundingClientRect().width;
		clickMode("map"); await readMode("map");
		const animations = root.querySelector(".reading-main-chat").getAnimations();
		check(animations.length === 1, "layout animation starts");
		for (const animation of root.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 120; }
		await pause(30);
		const middleWidth = root.querySelector(".reading-main-chat").getBoundingClientRect().width;
		check(middleWidth > 0 && middleWidth < width, "intermediate panel width");
		check(map === root.querySelector(".reading-map-canvas") && card.isConnected, "same map and nodes");
		check(floating === root.querySelector(".reading-float"), "pinned window retained");
		check(root.querySelector(".reading-main-chat").inert, "closing panel cannot receive focus");
		const replacement = root.querySelector("textarea[data-composer^='main:']");
		check(replacement.value === input.value && replacement.selectionStart === 2 && replacement.selectionEnd === 5, "draft and cursor preserved");
		for (const animation of root.getAnimations({ subtree: true })) animation.play(); await settled();
		check(root.querySelector(".reading-main-chat").getBoundingClientRect().width < 1, "chat fully collapsed");
		check(Math.abs(scroll.scrollTop - oldY) < 2, "map scroll preserved");
		check(map.getBoundingClientRect().left !== initialX, "map moved with layout");
		checks.push("intermediate frame", "map/node identity", "pinned window identity", "draft/cursor", "inert chat", "scroll position");
		clickMode("split"); await readMode("split");
		for (const animation of root.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 100; }
		const beforeReverse = root.querySelector(".reading-main-chat").getBoundingClientRect().width;
		clickMode("map"); await readMode("map");
		const afterReverse = root.querySelector(".reading-main-chat").getBoundingClientRect().width;
		check(Math.abs(afterReverse - beforeReverse) < 2, "reversal starts from visible position: " + beforeReverse + " -> " + afterReverse);
		clickMode("split"); await readMode("split"); await settled();
		check(Math.abs(root.querySelector(".reading-main-chat").getBoundingClientRect().width - width) < 2, "rapid switch final width");
		check(root.querySelectorAll("textarea[data-composer^='main:']").length === 1, "single main composer");
		check(Math.abs(messages.scrollTop - transcriptY) < 2, "transcript scroll restored after hidden composer resize");
		checks.push("rapid reversal", "settled panel width", "single composer", "transcript scroll");
		clickMode("map"); await readMode("map"); root.style.width = "620px"; await pause(120);
		check(!root.classList.contains("is-mode-transitioning"), "resize settles transition");
		// Themes may reserve a scrollbar gutter inside the requested 620px border box.
		check(Math.abs(root.getBoundingClientRect().width - 620) < 1 && root.querySelector(".reading-map-area").clientWidth === root.clientWidth, "compact map fills viewport");
		clickMode("split"); await readMode("split"); await settled();
		check(Math.abs(root.querySelector(".reading-main-chat").getBoundingClientRect().width - root.clientWidth / 2) < 2, "compact split width");
		root.style.width = originalWidth; await pause(120); checks.push("resize cleanup", "620px layout");
		// Respect reduced motion without modifying the user's operating-system preference.
		win.matchMedia = query => query.includes("prefers-reduced-motion") ? { matches: true } : originalMatchMedia.call(win, query);
		clickMode("map"); await readMode("map");
		check(!root.classList.contains("is-mode-transitioning") && root.querySelector(".reading-main-chat").getAnimations().length === 0, "reduced motion skips layout animation");
		check(root.querySelector(".reading-main-chat").getBoundingClientRect().width < 1, "reduced motion final layout");
		win.matchMedia = originalMatchMedia; checks.push("reduced motion");
		clickMode("split"); await readMode("split");
		const visibility = Object.getOwnPropertyDescriptor(root.ownerDocument, "visibilityState");
		try {
			Object.defineProperty(root.ownerDocument, "visibilityState", { configurable: true, value: "hidden" });
			root.ownerDocument.dispatchEvent(new Event("visibilitychange"));
			check(!root.classList.contains("is-mode-transitioning"), "background transition settled");
			clickMode("map"); await readMode("map");
			check(root.querySelector(".reading-main-chat").getAnimations().length === 0, "background mode changes skip animation");
		} finally {
			if (visibility) Object.defineProperty(root.ownerDocument, "visibilityState", visibility);
			else delete root.ownerDocument.visibilityState;
		}
		checks.push("background cleanup");
		clickMode("split"); await readMode("split");
		await view.setState({ sessionId: id }); await pause(420);
		check(!root.classList.contains("is-mode-transitioning") && root.querySelector(".reading-main-chat").getAnimations().length === 0, "reload cancels old animation");
		check(workspace.repository.get(id).ui.mode === "split", "mode persisted"); checks.push("reload cleanup", "mode persistence");
		return { status: "passed", nodes: session.nodes.length, width: root.clientWidth, height: root.clientHeight, middleWidth, checks };
	} finally {
		win.matchMedia = originalMatchMedia; root.style.width = originalWidth; await pause(650); await workspace.repository.flush();
		await workspace.repository.transact(id, s => { s.ui = originalUI; });
		if (previousId) await view.setState({ sessionId: previousId });
	}
};
