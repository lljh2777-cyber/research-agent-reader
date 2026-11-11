import { ItemView, type WorkspaceLeaf } from "obsidian";
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
	private picker?: HTMLSelectElement;
	private list?: HTMLElement;

	getViewType(): string { return SPLIT_OUTLINE_VIEW_TYPE; }
	getDisplayText(): string { return "双栏大纲"; }
	getIcon(): string { return "list-tree"; }

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("agent-split-outline");
		this.picker = this.contentEl.createEl("select", { attr: { "aria-label": "大纲语言" } });
		for (const [value, label] of [["follow", "跟随正文栏"], ["zh-CN", "中文"], ["en", "English"]]) {
			this.picker.createEl("option", { value, text: label });
		}
		this.registerDomEvent(this.picker, "change", () => {
			if (!this.source) return;
			const value = this.picker!.value;
			if (value === "en" || value === "zh-CN") this.preferred.set(this.source, value);
			else this.preferred.delete(this.source);
			this.refresh();
		});
		this.list = this.contentEl.createDiv({ cls: "agent-split-outline-list" });
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
		this.refresh();
	}

	refresh(): void {
		if (!this.list || !this.picker) return;
		const reader = this.app.workspace.getMostRecentLeaf();
		const source = reader ? sources.get(reader) : undefined;
		const preferred = source && this.preferred.get(source);
		const language = preferred ?? source?.active;
		this.picker.hidden = !language || language === "markdown";
		this.picker.value = preferred ?? "follow";
		this.picker.options[0].textContent = preferred || !language || language === "markdown"
			? "跟随正文栏" : "跟随正文栏 · " + (language === "en" ? "English" : "中文");
		if (source === this.source && language === this.language && this.list.childElementCount) return;
		this.source = source; this.language = language;
		this.list.empty();
		if (!reader || !source || !language) {
			this.list.createDiv({ cls: "agent-split-outline-empty", text: "打开双栏阅读后查看大纲" });
			return;
		}
		const headings = source.headings[language];
		if (!headings?.length) {
			this.list.createDiv({ cls: "agent-split-outline-empty", text: "本栏没有标题" });
			return;
		}
		const list = this.list.createEl("ul");
		const base = headings.reduce((level, heading) => Math.min(level, heading.level), 6);
		for (const heading of headings) {
			const item = list.createEl("li");
			item.style.setProperty("--agent-outline-depth", String(heading.level - base));
			const button = item.createEl("button", { text: heading.title, attr: { type: "button", title: heading.title, "data-outline-heading": heading.id } });
			button.addEventListener("click", () => {
				if (reader === this.app.workspace.getMostRecentLeaf() && sources.get(reader) === source) source.jump(language, heading.id);
			});
		}
	}
}
