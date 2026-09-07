/* Explicit Obsidian regression. Keeps one labelled demo; no model calls or file cleanup. */
module.exports = async function readingWindowScenario(app) {
	const check = (ok, label) => { if (!ok) throw new Error(label); };
	const pause = () => new Promise((resolve) => require("node:timers").setTimeout(resolve, 180));
	const plugin = app.plugins.plugins["research-agent-reader"]; const service = plugin.getReadingWorkspace();
	await plugin.activateReadingWorkspace(); const view = app.workspace.getLeavesOfType("research-interactive-reading")[0].view;
	const id = await service.demo("test"); await view.setState({ sessionId: id });
	await service.repository.transact(id, (s) => { s.title = "小窗验收 · 缩放与正文（示例）"; s.ui.mode = "map"; });
	view.selectNode(service.repository.get(id).mainIds[0]); await pause();
	const root = view.contentEl; check(root.clientWidth >= 800 && root.clientHeight >= 650, "use a desktop-size reading pane");
	const floating = () => root.querySelector(".reading-float"); const geometry = () => service.repository.get(id).ui.windows[0];
	const reset = async () => { await service.repository.transact(id, (s) => Object.assign(s.ui.windows[0], { x: 160, y: 100, width: 420, height: 480 })); await pause(); };
	const finish = async () => { await pause(); await service.repository.flush(); };
	const resize = async (edge, dx, dy, cancel = false) => {
		const handle = floating().querySelector('[data-resize-edge="' + edge + '"]'); const rect = handle.getBoundingClientRect();
		const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2; const initial = floating().getBoundingClientRect();
		handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
		check(Math.abs(floating().getBoundingClientRect().width - initial.width) < 1, "press does not jump window size");
		document.dispatchEvent(new PointerEvent("pointermove", { clientX: x + dx, clientY: y + dy }));
		document.dispatchEvent(new PointerEvent(cancel ? "pointercancel" : "pointerup")); await finish();
	};
	await reset(); check(floating().querySelectorAll(".reading-resize-handle").length === 8, "eight resize directions");
	check(floating().querySelector(".reading-messages").clientHeight / floating().clientHeight > .7, "body occupies most of window");
	const a = floating().querySelector(".reading-send").getBoundingClientRect(); const b = floating().querySelector(".reading-resize").getBoundingClientRect();
	check(a.right <= b.left || a.bottom <= b.top || a.left >= b.right || a.top >= b.bottom, "resize handle does not cover send");
	for (const [edge, dx, dy] of [["e",40,0],["w",-40,0],["s",0,40],["n",0,-40],["se",40,40],["sw",-40,40],["ne",40,-40],["nw",-40,-40]]) {
		await reset(); await resize(edge, dx, dy); const saved = geometry();
		check(Math.abs(saved.width - (edge.includes("e") || edge.includes("w") ? 460 : 420)) < 1, "width " + edge);
		check(Math.abs(saved.height - (edge.includes("n") || edge.includes("s") ? 520 : 480)) < 1, "height " + edge);
		check(Math.abs(saved.x - (edge.includes("w") ? 120 : 160)) < 1 && Math.abs(saved.y - (edge.includes("n") ? 60 : 100)) < 1, "opposite edge anchored " + edge);
	}
	await reset(); await resize("nw", -10000, -10000); check(geometry().x === 8 && geometry().y === 40, "top and left bounds");
	await resize("se", 10000, 10000); check(Math.abs(geometry().x + geometry().width - (root.clientWidth - 12)) < 1 && Math.abs(geometry().y + geometry().height - (root.clientHeight - 12)) < 1, "right and bottom bounds");
	await resize("se", -10000, -10000); check(geometry().width === 280 && geometry().height === 220, "minimum size");
	await reset(); await resize("e", 40, 0, true); const width = geometry().width;
	check(Math.abs(width - 460) < 1, "cancel retains current visible size");
	document.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, clientY: 20 })); await pause(); check(geometry().width === width, "cancel removes drag listener");
	const handle = floating().querySelector(".reading-resize"); handle.focus(); handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await finish();
	check(Math.abs(geometry().width - width - 24) < 1 && document.activeElement === floating().querySelector(".reading-resize"), "keyboard resize and focus");
	floating().querySelector(".reading-resize").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true })); await finish(); check(geometry().height === 484, "fine keyboard resize");
	const input = floating().querySelector("textarea"); const emptyHeight = input.clientHeight;
	input.value = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行"; input.dispatchEvent(new Event("input", { bubbles: true }));
	check(input.clientHeight > emptyHeight && input.clientHeight <= 96, "long draft grows within limit");
	view.render(true); await pause(); check(floating().querySelector("textarea").value.startsWith("第一行"), "draft survives resize render");
	const restored = floating().querySelector("textarea"); restored.value = ""; restored.dispatchEvent(new Event("input", { bubbles: true })); check(restored.clientHeight === emptyHeight, "empty draft shrinks");
	await finish(); const saved = JSON.parse(await service.repository.storage.read(id));
	check(saved.ui.windows[0].width === geometry().width && saved.ui.windows[0].height === geometry().height, "geometry persisted on disk");
	return { status: "passed", sessionId: id, geometry: saved.ui.windows[0], checks: ["8 directions", "body ratio", "send hit target", "no press jump", "opposite edge", "bounds", "minimum", "pointer cancel", "keyboard", "auto-grow draft", "persistence"] };
};
