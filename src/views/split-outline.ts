import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { BilingualLanguage } from "../reader/bilingual-document";

export const SPLIT_OUTLINE_VIEW_TYPE = "research-agent-reader-split-outline";
export type OutlineLanguage = BilingualLanguage | "markdown";
export interface OutlineHeading {
	id: string;
	level: number;
	title: string;
	element: HTMLElement;
	blockId?: string;
}
export interface SplitOutlineSource {
	readonly active: OutlineLanguage;
	readonly headings: Readonly<Partial<Record<OutlineLanguage, readonly OutlineHeading[]>>>;
	jump(language: OutlineLanguage, id: string): void;
}

const headingSelector = "h1, h2, h3, h4, h5, h6";
const sources = new WeakMap<WorkspaceLeaf, SplitOutlineSource>();
const outlineModes = [["follow", "跟随"], ["zh-CN", "中文"], ["en", "English"]] as const;
type OutlineMode = typeof outlineModes[number][0];

export function splitOutlineHeadings(article: HTMLElement, headingAnchors?: ReadonlyMap<HTMLElement, string>): OutlineHeading[] {
	const headings: OutlineHeading[] = [];
	let blockId: string | undefined;
	const selector = headingAnchors ? "[data-bilingual-anchor], " + headingSelector : headingSelector;
	for (const element of article.querySelectorAll<HTMLElement>(selector)) {
		if (element.closest(".internal-embed, .markdown-embed, .footnotes")) continue;
		if (element.hasAttribute("data-bilingual-anchor")) {
			blockId = headingAnchors?.get(element);
			continue;
		}
		const title = element.textContent?.trim();
		if (title) headings.push({ id: "heading-" + headings.length, level: Number(element.tagName[1]), title, element, blockId });
		blockId = undefined;
	}
	return headings;
}

export function scrollWithinReadingPane(scroller: HTMLElement, target: HTMLElement, align: "start" | "center" = "start"): void {
	const bounds = target.getBoundingClientRect();
	const top = scroller.scrollTop + bounds.top - scroller.getBoundingClientRect().top - scroller.clientTop;
	const offset = align === "center" ? (scroller.clientHeight - bounds.height) / 2 : 0;
	// Scrolling ancestors can move the reader's toolbar out of view under some themes.
	scroller.scrollTop = Math.max(0, Math.min(Math.max(0, scroller.scrollHeight - scroller.clientHeight), top - offset));
}

export function refreshSplitOutline(reader: WorkspaceLeaf): void {
	for (const leaf of reader.view.app.workspace.getLeavesOfType(SPLIT_OUTLINE_VIEW_TYPE)) {
		if (leaf.view instanceof SplitOutlineView) leaf.view.refresh();
	}
}

export function bindSplitOutline(reader: WorkspaceLeaf, source: SplitOutlineSource, signal: AbortSignal): () => void {
	const detach = (): void => {
		if (sources.get(reader) !== source) return;
		sources.delete(reader);
		refreshSplitOutline(reader);
	};
	sources.set(reader, source);
	signal.addEventListener("abort", detach, { once: true });
	refreshSplitOutline(reader);
	return detach;
}

export function createSplitOutlineButton(toolbar: HTMLElement, reader: WorkspaceLeaf, signal: AbortSignal): HTMLButtonElement {
	const button = toolbar.createEl("button", { text: "双栏大纲", attr: { type: "button", "aria-label": "打开双栏大纲" } });
	button.disabled = true;
	button.addEventListener("click", async () => {
		const workspace = reader.view.app.workspace;
		const leaf = workspace.getLeavesOfType(SPLIT_OUTLINE_VIEW_TYPE)[0] ?? workspace.getLeftLeaf(false);
		if (!leaf) return;
		if (leaf.getViewState().type !== SPLIT_OUTLINE_VIEW_TYPE) await leaf.setViewState({ type: SPLIT_OUTLINE_VIEW_TYPE });
		if (!signal.aborted) await workspace.revealLeaf(leaf);
	}, { signal });
	return button;
}

export class SplitOutlineView extends ItemView {
	private readonly preferred = new WeakMap<SplitOutlineSource, BilingualLanguage>();
	private source?: SplitOutlineSource;
	private language?: OutlineLanguage;
	private modeGroup?: HTMLElement;
	private followLanguage?: HTMLElement;
	private readonly modeButtons = new Map<OutlineMode, HTMLButtonElement>();
	private list?: HTMLElement;

	getViewType(): string { return SPLIT_OUTLINE_VIEW_TYPE; }
	getDisplayText(): string { return "双栏大纲"; }
	getIcon(): string { return "list-tree"; }

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("agent-split-outline");
		const header = this.contentEl.createDiv({ cls: "agent-split-outline-header" });
		const heading = header.createDiv({ cls: "agent-split-outline-heading" });
		const icon = heading.createSpan({ cls: "agent-split-outline-icon", attr: { "aria-hidden": "true" } });
		setIcon(icon, "list-tree");
		heading.createSpan({ text: "双栏大纲" });
		this.followLanguage = heading.createSpan({ cls: "agent-split-outline-language", attr: { hidden: "" } });
		this.modeGroup = header.createDiv({ cls: "agent-split-outline-modes", attr: { role: "group", "aria-label": "大纲语言", hidden: "" } });
		this.modeButtons.clear();
		for (const [mode, label] of outlineModes) {
			const button = this.modeGroup.createEl("button", {
				cls: "agent-split-outline-mode", text: label,
				attr: { type: "button", "aria-pressed": "false", "data-outline-mode": mode, ...(mode === "follow" ? { "aria-label": "跟随最近操作的正文栏" } : {}) },
			});
			this.modeButtons.set(mode, button);
			this.registerDomEvent(button, "click", () => {
				if (!this.source) return;
				if (mode === "follow") this.preferred.delete(this.source);
				else this.preferred.set(this.source, mode);
				this.refresh();
			});
		}
		this.list = this.contentEl.createDiv({ cls: "agent-split-outline-list" });
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
		this.refresh();
	}

	refresh(): void {
		if (!this.list || !this.modeGroup || !this.followLanguage) return;
		const reader = this.app.workspace.getMostRecentLeaf();
		const source = reader ? sources.get(reader) : undefined;
		const preferred = source && this.preferred.get(source);
		const language = preferred ?? source?.active;
		const bilingual = language === "en" || language === "zh-CN";
		this.modeGroup.hidden = !bilingual;
		this.followLanguage.hidden = !bilingual || !!preferred;
		this.followLanguage.setText(this.followLanguage.hidden ? "" : language === "en" ? "English" : "中文");
		for (const [mode, button] of this.modeButtons) button.setAttribute("aria-pressed", String(mode === (preferred ?? "follow")));
		if (source === this.source && language === this.language && this.list.childElementCount) return;
		this.source = source; this.language = language;
		this.list.empty();
		this.list.scrollTop = 0;
		if (!reader || !source || !language) {
			this.list.createDiv({ cls: "agent-split-outline-empty", text: "打开双栏阅读后查看大纲" });
			return;
		}
		const headings = source.headings[language];
		if (!headings?.length) {
			this.list.createDiv({ cls: "agent-split-outline-empty", text: "本栏没有标题" });
			return;
		}
		const root = this.list.createDiv({ attr: { role: "list", "aria-label": "章节标题" } });
		const parents: { level: number; item: HTMLElement; branch?: HTMLElement }[] = [];
		for (const heading of headings) {
			while (parents.length && parents[parents.length - 1].level >= heading.level) parents.pop();
			const parent = parents[parents.length - 1];
			const list = parent ? parent.branch ??= parent.item.createDiv({ cls: "agent-split-outline-branch", attr: { role: "list" } }) : root;
			const item = list.createDiv({ attr: { role: "listitem" } });
			const button = item.createEl("button", {
				cls: "agent-split-outline-row", text: heading.title,
				attr: { type: "button", title: heading.title, "data-outline-heading": heading.id },
			});
			button.addEventListener("click", () => {
				if (reader === this.app.workspace.getMostRecentLeaf() && sources.get(reader) === source) source.jump(language, heading.id);
			});
			parents.push({ level: heading.level, item });
		}
	}
}
