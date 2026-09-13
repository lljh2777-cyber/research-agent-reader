/** Animate the existing panels; never clone answers, map nodes or floating windows. */
import { setTimeout, clearTimeout } from "node:timers";

export class ReadingModeMotion {
	private finish?: () => void;
	constructor(private readonly root: HTMLElement) {}
	stop(): void { this.finish?.(); }
	change(mode: "map" | "split", update: () => void, animate: boolean): void {
		const root = this.root; const win = root.ownerDocument.defaultView!;
		const chat = root.querySelector<HTMLElement>(".reading-main-chat")!;
		const inner = root.querySelector<HTMLElement>(".reading-main-chat-inner")!;
		const divider = root.querySelector<HTMLElement>(".reading-divider")!;
		const extent = root.querySelector<HTMLElement>(".reading-map-extent")!;
		const composer = root.querySelector<HTMLElement>(".reading-map-composer")!;
		const media = win.matchMedia("(prefers-reduced-motion: reduce)");
		// Sample before stopping: a quick reversal starts at the current visual position.
		const before = { width: chat.getBoundingClientRect().width, innerWidth: inner.getBoundingClientRect().width, opacity: win.getComputedStyle(chat).opacity,
			divider: divider.getBoundingClientRect().width, margin: win.getComputedStyle(extent).marginLeft,
			composer: composer.getBoundingClientRect().height };
		this.stop(); update();
		root.dataset.mode = mode;
		const split = mode === "split";
		chat.inert = !split; chat.setAttribute("aria-hidden", String(!split));
		divider.inert = !split; divider.setAttribute("aria-hidden", String(!split));
		root.querySelectorAll<HTMLElement>("[data-reading-mode]").forEach(control => control.setAttribute("aria-pressed", String(control.dataset.readingMode === mode)));
		if (!animate || media.matches || root.ownerDocument.visibilityState === "hidden" || !root.isConnected || !root.clientWidth || typeof chat.animate !== "function") return;
		const width = chat.getBoundingClientRect().width;
		const margin = win.getComputedStyle(extent).marginLeft;
		const height = composer.getBoundingClientRect().height;
		// Keep prose at its reading width while the panel opens, avoiding line reflow each frame.
		inner.style.width = (split ? width : before.innerWidth) + "px";
		chat.style.minWidth = "0px";
		const options: KeyframeAnimationOptions = { duration: 360, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "both" };
		const animations = [
			chat.animate([{ flexBasis: before.width + "px", opacity: before.opacity }, { flexBasis: width + "px", opacity: split ? 1 : 0 }], options),
			divider.animate([{ flexBasis: before.divider + "px" }, { flexBasis: split ? "5px" : "0px" }], options),
			extent.animate([{ marginLeft: before.margin }, { marginLeft: margin }], options),
			composer.animate([{ height: before.composer + "px", opacity: split ? 1 : 0 }, { height: height + "px", opacity: split ? 0 : 1 }], options),
		];
		root.classList.add("is-mode-transitioning");
		let finished = false;
		const resize = new ResizeObserver(() => { if (Math.abs(root.clientWidth - initialWidth) > 1) finish(); });
		const initialWidth = root.clientWidth;
		const finish = (): void => {
			if (finished) return; finished = true;
			clearTimeout(deadline);
			animations.forEach(animation => animation.cancel());
			inner.style.width = ""; chat.style.minWidth = "";
			root.classList.remove("is-mode-transitioning"); resize.disconnect(); media.removeEventListener("change", finish);
			root.ownerDocument.removeEventListener("visibilitychange", visibility);
			this.finish = undefined;
		};
		const visibility = (): void => { if (root.ownerDocument.visibilityState === "hidden") finish(); };
		// Chromium may defer animation-finished notifications in an occluded window.
		const deadline = setTimeout(finish, 500);
		this.finish = finish; resize.observe(root); media.addEventListener("change", finish);
		root.ownerDocument.addEventListener("visibilitychange", visibility);
		void Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
	}
}
