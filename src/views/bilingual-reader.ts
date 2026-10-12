import { Component, MarkdownRenderer, Modal, type App } from "obsidian";
import type { BilingualBlock, BilingualDocument, BilingualFile, BilingualLanguage } from "../reader/bilingual-document";

/** Markers affect rendering only. Source offsets remain those of the unmodified files. */
export function bilingualRenderMarkdown(file: BilingualFile): string {
	let cursor = file.bodyStart, result = "";
	for (const block of file.blocks) {
		if (block.kind === "footnote" || block.kind === "reference") continue;
		result += file.text.slice(cursor, block.start) + `\n\n<span data-bilingual-anchor="${block.id}"></span>\n\n`;
		cursor = block.start;
	}
	return result + file.text.slice(cursor);
}
export interface BilingualPane { language: BilingualLanguage; scroller: HTMLElement; article: HTMLElement; anchors: Map<string, HTMLElement>; }
export interface BilingualReaderOptions { app: App; host: HTMLElement; document: BilingualDocument; signal: AbortSignal; ordinary(): void; ratio?: number; onRatio?(ratio: number): void; }
const STATUS: Record<string, string> = { "not-started": "尚未翻译", "in-progress": "翻译中", "needs-review": "译文待复核", reviewed: "记录标为已审阅", failed: "翻译记录失败", unknown: "译文状态未确认" };

export class BilingualReader extends Component {
	readonly panes = new Map<BilingualLanguage, BilingualPane>();
	constructor(readonly options: BilingualReaderOptions) { super(); }
	async render(): Promise<void> {
		const { app, host, document: doc, signal } = this.options;
		host.classList.add("agent-bilingual-shell");
		const toolbar = host.createDiv({ cls: "agent-bilingual-toolbar" });
		toolbar.createEl("span", { text: "双语对照 · 结构对应，语义仍需核对" });
		const status = toolbar.createEl("span", { text: STATUS[doc.status] + (doc.humanReview === "reviewed" ? " · 人工审阅记录已存在" : " · 人工审阅未确认"), cls: "agent-bilingual-status" });
		status.setAttribute("title", doc.stale ? "译文英语来源已过期" : "结构对应不代表译文含义已经核验");
		const ordinary = toolbar.createEl("button", { text: "返回单语图文", attr: { type: "button" } }); ordinary.addEventListener("click", this.options.ordinary, { signal });
		if (doc.issues.length) host.createEl("p", { text: doc.issues.join("；"), cls: "agent-bilingual-issues", attr: { role: "status" } });
		const workspace = host.createDiv({ cls: "agent-bilingual-workspace" });
		let ratio = Math.max(0.3, Math.min(0.7, this.options.ratio ?? 0.5));
		const applyRatio = (): void => { workspace.style.setProperty("--bilingual-left", ratio + "fr"); workspace.style.setProperty("--bilingual-right", (1 - ratio) + "fr"); };
		applyRatio();
		for (const language of ["en", "zh-CN"] as const) {
			if (signal.aborted) return;
			const file = doc.files[language], pane = workspace.createEl("section", { cls: "agent-bilingual-pane", attr: { "aria-label": language === "en" ? "英文原文" : "中文译文", "data-bilingual-language": language } });
			const heading = pane.createDiv({ cls: "agent-bilingual-pane-heading" }); heading.createEl("strong", { text: language === "en" ? "英文原文" : "中文译文" });
			heading.createSpan({ text: "批注适配开发中", cls: "agent-bilingual-pending" });
			const scroller = pane.createDiv({ cls: "agent-bilingual-scroll markdown-reading-view", attr: { tabindex: "0" } });
			const article = scroller.createEl("article", { cls: "markdown-rendered agent-bilingual-article", attr: { "data-bilingual-document": doc.root } });
			await MarkdownRenderer.render(app, bilingualRenderMarkdown(file), article, file.path, this);
			if (signal.aborted || !article.isConnected) return;
			// Until role propagation is delivered, this preview has no ordinary-source annotation outlet.
			article.querySelectorAll("[data-agent-annotation-source]").forEach(el => el.removeAttribute("data-agent-annotation-source"));
			const anchors = this.bindAnchors(article, file); this.scopeLinks(article, language);
			article.addEventListener("click", event => {
				const target = event.target instanceof Element ? event.target.closest("img") as HTMLImageElement | null : null;
				if (!target || !target.src) return;
				event.preventDefault(); const modal = new Modal(app); modal.titleEl.setText(language === "en" ? "英文原文图片" : "中文译文图片");
				const image = modal.contentEl.createEl("img", { attr: { src: target.src, alt: target.alt } }); image.style.maxWidth = "100%"; modal.open();
				signal.addEventListener("abort", () => modal.close(), { once: true });
			}, { signal });
			this.panes.set(language, { language, scroller, article, anchors });
			if (language === "en") {
				const splitter = workspace.createDiv({ cls: "agent-bilingual-splitter", attr: { role: "separator", tabindex: "0", "aria-label": "调整英文与中文栏宽", "aria-orientation": "vertical", "aria-valuemin": "30", "aria-valuemax": "70", "aria-valuenow": String(Math.round(ratio * 100)) } });
				const change = (next: number): void => { ratio = Math.max(0.3, Math.min(0.7, next)); applyRatio(); splitter.setAttribute("aria-valuenow", String(Math.round(ratio * 100))); this.options.onRatio?.(ratio); };
				let dragging = false;
				splitter.addEventListener("pointerdown", event => { event.preventDefault(); dragging = true; splitter.setPointerCapture(event.pointerId); }, { signal });
				splitter.addEventListener("pointermove", event => { if (!dragging) return; const rect = workspace.getBoundingClientRect(); if (rect.width) change((event.clientX - rect.left) / rect.width); }, { signal });
				for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) splitter.addEventListener(event, () => { dragging = false; }, { signal });
				splitter.addEventListener("keydown", event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); change(ratio + (event.key === "ArrowLeft" ? -0.02 : 0.02)); }, { signal });
			}
		}
	}
	private bindAnchors(article: HTMLElement, file: BilingualFile): Map<string, HTMLElement> {
		const anchors = new Map<string, HTMLElement>();
		for (const marker of article.querySelectorAll<HTMLElement>("[data-bilingual-anchor]")) {
			const block = file.blocks.find(b => b.id === marker.dataset.bilingualAnchor); if (!block) continue;
			marker.closest("p")?.classList.add("agent-bilingual-marker"); anchors.set(block.id, marker);
		}
		for (const block of file.blocks.filter(b => b.kind === "footnote")) {
			const id = /^\s{0,3}\[\^([^\]]+)\]:/.exec(file.text.slice(block.start, block.end))?.[1];
			const reference = id ? article.querySelector<HTMLAnchorElement>(`a[data-footref="${CSS.escape(id)}"]`) : null;
			const target = reference?.getAttribute("href")?.replace(/^#/, "");
			const footnote = target ? article.querySelector<HTMLElement>(`[id="${CSS.escape(target)}"]`) : id ? article.querySelector<HTMLElement>(`[id="fn-${CSS.escape(id)}"], [id^="fn-${CSS.escape(id)}-"], [data-footnote-id="${CSS.escape(id)}"]`) : null;
			if (footnote) { footnote.dataset.bilingualAnchor = block.id; anchors.set(block.id, footnote); }
		}
		return anchors;
	}
	private scopeLinks(article: HTMLElement, language: BilingualLanguage): void {
		const ids = new Map<string, string>();
		for (const element of article.querySelectorAll<HTMLElement>("[id]")) { const old = element.id, id = "bilingual-" + language + "-" + old; ids.set(old, id); element.id = id; }
		for (const link of article.querySelectorAll<HTMLAnchorElement>("a")) {
			const href = link.getAttribute("href") || ""; if (!href.startsWith("#")) continue;
			let target = href.slice(1); try { target = decodeURIComponent(target); } catch { /* Keep literal identifier. */ }
			const id = ids.get(target); if (!id) continue; link.setAttribute("href", "#" + id);
			link.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); article.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" }); }, { signal: this.options.signal });
		}
	}
	blockForElement(language: BilingualLanguage, element: Element): BilingualBlock | undefined {
		const pane = this.panes.get(language); if (!pane || !pane.article.contains(element)) return undefined;
		const footnote = element.closest<HTMLElement>("[data-bilingual-anchor]");
		if (footnote?.dataset.bilingualAnchor) return this.options.document.files[language].blocks.find(b => b.id === footnote.dataset.bilingualAnchor);
		let result: BilingualBlock | undefined;
		for (const block of this.options.document.files[language].blocks) {
			const anchor = pane.anchors.get(block.id); if (!anchor) continue;
			if (anchor === element || anchor.contains(element) || anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) result = block;
		}
		return result;
	}
}
