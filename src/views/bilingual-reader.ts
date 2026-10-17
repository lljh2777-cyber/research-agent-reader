import { Component, MarkdownRenderer, Modal, type App } from "obsidian";
import { bindBilingualSelection } from "../annotations/bilingual";
import type { AnnotationRecord } from "../annotations/types";
import { annotationDisplayText, revealMarkdownRange } from "../annotations/markdown-selection";
import type { BilingualBlock, BilingualDocument, BilingualFile, BilingualLanguage } from "../reader/bilingual-document";
import { bilingualPositionAt, bilingualScrollTarget, correspondingBilingualPosition, normalizeBilingualState, type BilingualGeometry, type BilingualReadingState } from "../reader/bilingual-position";
import { applySplitLayout, sourceSplitRatio } from "./split-layout";

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
export interface BilingualReaderOptions { app: App; host: HTMLElement; document: BilingualDocument; signal: AbortSignal; ordinary(): void; hideOrdinary?: boolean; annotate?(): Promise<void>; ratio?: number; reversed?: boolean; onRatio?(ratio: number): void; defaultLinked?: boolean; state?: unknown; onState?(state: BilingualReadingState): void; }
const STATUS: Record<string, string> = { "not-started": "尚未翻译", "in-progress": "翻译中", "needs-review": "译文待复核", reviewed: "记录标为已审阅", failed: "翻译记录失败", unknown: "译文状态未确认" };

export class BilingualReader extends Component {
	readonly panes = new Map<BilingualLanguage, BilingualPane>();
	state: BilingualReadingState;
	private readonly programmatic = new Set<BilingualLanguage>();
	private frame = 0;
	private resizeFrame = 0;
	private readyFrame = 0;
	private restoring = true;
	private linkedInput?: HTMLInputElement;
	private message?: HTMLElement;
	private invalidated = false;
	private reversed: boolean;
	private applyLayout?: () => void;
	constructor(readonly options: BilingualReaderOptions) { super(); this.state = normalizeBilingualState(options.state, options.document, options.defaultLinked); this.reversed = options.reversed === true; }
	setReversed(reversed: boolean): void { if (this.options.signal.aborted) return; this.snapshot(); this.reversed = reversed; this.applyLayout?.(); }
	async render(): Promise<void> {
		const { app, host, document: doc, signal } = this.options;
		host.classList.add("agent-bilingual-shell");
		const toolbar = host.createDiv({ cls: "agent-bilingual-toolbar" });
		const progressSync = !!doc.selectedFiles && !doc.syncAvailable;
		const canSync = doc.syncAvailable || progressSync;
		toolbar.createEl("span", { text: progressSync ? "双语阅读 · 按阅读进度同步，段落对应未确认" : "双语对照 · 结构对应，语义仍需核对" });
		const linkedLabel = toolbar.createEl("label", { cls: "agent-bilingual-linked" });
		this.linkedInput = linkedLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "双栏联动" } });
		linkedLabel.createSpan({ text: "双栏联动" }); this.linkedInput.checked = this.state.linked; this.linkedInput.disabled = !canSync;
		this.linkedInput.addEventListener("change", () => { this.state.linked = this.linkedInput!.checked && canSync && !this.invalidated; if (this.state.linked) this.synchronize(this.state.active); this.publish(); }, { signal });
		this.message = toolbar.createSpan({ cls: "agent-bilingual-sync-message", attr: { role: "status" } });
		const status = toolbar.createEl("span", { text: STATUS[doc.status] + (doc.humanReview === "reviewed" ? " · 人工审阅记录已存在" : " · 人工审阅未确认"), cls: "agent-bilingual-status" });
		status.setAttribute("title", doc.stale ? "译文英语来源已过期" : "结构对应不代表译文含义已经核验");
		if (!this.options.hideOrdinary) { const ordinary = toolbar.createEl("button", { text: "返回单语图文", attr: { type: "button" } }); ordinary.addEventListener("click", this.options.ordinary, { signal }); }
		if (doc.issues.length) host.createEl("p", { text: doc.issues.join("；"), cls: "agent-bilingual-issues", attr: { role: "status" } });
		const workspace = host.createDiv({ cls: "agent-bilingual-workspace" });
		let ratio = Math.max(0.3, Math.min(0.7, this.options.ratio ?? 0.5));
		const applyRatio = this.applyLayout = (): void => applySplitLayout(workspace, ratio, this.reversed);
		applyRatio();
		for (const language of ["en", "zh-CN"] as const) {
			if (signal.aborted) return;
			const file = doc.files[language], pane = workspace.createEl("section", { cls: "agent-bilingual-pane", attr: { "aria-label": language === "en" ? "英文原文" : "中文译文", "data-bilingual-language": language, "data-split-side": language === "en" ? "left" : "right" } });
			const heading = pane.createDiv({ cls: "agent-bilingual-pane-heading" }); heading.createEl("strong", { text: language === "en" ? "英文原文" : "中文译文", attr: { title: file.path } });
			heading.createSpan({ text: file.path.split("/").pop(), cls: "agent-split-file-name", attr: { title: file.path } });
			const sync = heading.createEl("button", { text: "以本栏同步另一栏", attr: { type: "button", "data-bilingual-sync": language } }); sync.disabled = !canSync;
			sync.addEventListener("click", () => { this.activate(language); this.synchronize(language); }, { signal });
			const annotate = heading.createEl("button", { text: "批注", attr: { type: "button", "data-bilingual-annotate": language } });
			annotate.disabled = !this.options.annotate;
			annotate.addEventListener("mousedown", event => event.preventDefault(), { signal });
			annotate.addEventListener("click", () => { this.activate(language); const selection = window.getSelection(); if (!selection?.anchorNode || !article.contains(selection.anchorNode) || !selection.focusNode || !article.contains(selection.focusNode)) { this.message?.setText("请先在本栏选择文字"); return; } void this.options.annotate?.(); }, { signal });
			const scroller = pane.createDiv({ cls: "agent-bilingual-scroll markdown-reading-view", attr: { tabindex: "0" } });
			const article = scroller.createEl("article", { cls: "markdown-rendered agent-bilingual-article", attr: { "data-bilingual-document": doc.root } });
			await MarkdownRenderer.render(app, bilingualRenderMarkdown(file), article, file.path, this);
			if (signal.aborted || !article.isConnected) return;
			// Discard offsets supplied by rendering transformed Markdown; bind the raw source below.
			article.querySelectorAll("[data-agent-annotation-source]").forEach(el => el.removeAttribute("data-agent-annotation-source"));
			article.dataset.agentAnnotationSource = file.path;
			bindBilingualSelection(article, element => { if (this.invalidated || signal.aborted) throw new Error("双语资料已变化或关闭，请重新打开划选"); const block = this.blockForElement(language, element); if (!block) throw new Error("无法确定本栏选区段落"); return { document: doc, language, block }; });
			const anchors = this.bindAnchors(article, file); this.scopeLinks(article, language);
			article.addEventListener("click", event => {
				const target = event.target instanceof Element ? event.target.closest("img") as HTMLImageElement | null : null;
				if (!target || !target.src) return;
				event.preventDefault(); const modal = new Modal(app); modal.titleEl.setText(language === "en" ? "英文原文图片" : "中文译文图片");
				const image = modal.contentEl.createEl("img", { attr: { src: target.src, alt: target.alt } }); image.style.maxWidth = "100%"; modal.open();
				signal.addEventListener("abort", () => modal.close(), { once: true });
			}, { signal });
			this.panes.set(language, { language, scroller, article, anchors });
			for (const type of ["wheel", "pointerdown", "touchstart", "keydown", "focusin"] as const) pane.addEventListener(type, () => this.activate(language), { signal, passive: type === "wheel" || type === "touchstart" });
			scroller.addEventListener("scroll", () => {
				if (this.restoring || this.programmatic.has(language) || this.options.signal.aborted) return;
				this.capture(language);
				if (this.frame) cancelAnimationFrame(this.frame);
				this.frame = requestAnimationFrame(() => { this.frame = 0; this.capture(language); if (this.state.linked && this.state.active === language) this.synchronize(language); else this.publish(); });
			}, { signal, passive: true });
			if (language === "en") {
				const splitter = workspace.createDiv({ cls: "agent-bilingual-splitter", attr: { role: "separator", tabindex: "0", "aria-label": "调整英文与中文栏宽", "aria-orientation": "vertical", "aria-valuemin": "30", "aria-valuemax": "70", "aria-valuenow": String(Math.round(ratio * 100)) } });
				const change = (next: number): void => { for (const l of ["en", "zh-CN"] as const) this.capture(l); ratio = Math.max(0.3, Math.min(0.7, next)); applyRatio(); this.options.onRatio?.(ratio); };
				let dragging = false;
				splitter.addEventListener("pointerdown", event => { event.preventDefault(); dragging = true; splitter.setPointerCapture(event.pointerId); }, { signal });
				splitter.addEventListener("pointermove", event => { if (!dragging) return; const rect = workspace.getBoundingClientRect(); if (rect.width) change(sourceSplitRatio((event.clientX - rect.left) / rect.width, this.reversed)); }, { signal });
				for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) splitter.addEventListener(event, () => { dragging = false; }, { signal });
				splitter.addEventListener("keydown", event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); change(ratio + (event.key === "ArrowLeft" ? -0.02 : 0.02) * (this.reversed ? -1 : 1)); }, { signal });
			}
		}
		applyRatio();
		for (const language of ["en", "zh-CN"] as const) this.restore(language);
		const resize = new ResizeObserver(() => {
			if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
			this.resizeFrame = requestAnimationFrame(() => { this.resizeFrame = 0; if (signal.aborted) return; for (const language of ["en", "zh-CN"] as const) this.restore(language); });
		});
		for (const pane of this.panes.values()) { resize.observe(pane.article); resize.observe(pane.scroller); }
		// Obsidian requests view state while rendering/visibility is still settling.
		// Keep saved anchors until the mounted layout can actually restore them.
		const ready = (): void => { if (signal.aborted) return; if ([...this.panes.values()].some(p => !p.article.isConnected || p.scroller.clientHeight <= 0 || p.article.getBoundingClientRect().height <= 0)) { this.readyFrame = requestAnimationFrame(ready); return; } for (const language of ["en", "zh-CN"] as const) this.restore(language); this.readyFrame = requestAnimationFrame(() => { if (signal.aborted) return; this.restoring = false; this.publish(); }); };
		this.readyFrame = requestAnimationFrame(ready);
		signal.addEventListener("abort", () => { resize.disconnect(); cancelAnimationFrame(this.frame); cancelAnimationFrame(this.resizeFrame); cancelAnimationFrame(this.readyFrame); }, { once: true });
		const changed = (path: string): void => {
			if (signal.aborted) return;
			if (![doc.files.en.path, doc.files["zh-CN"].path, doc.metadataPath].includes(path)) return;
			this.invalidated = true; this.state.linked = false; this.linkedInput!.checked = false; this.linkedInput!.disabled = true;
			for (const button of host.querySelectorAll<HTMLButtonElement>("[data-bilingual-sync]")) button.disabled = true;
			this.message!.setText("双语资料已变化，请重新打开核对；历史内容仍保留"); this.publish();
		};
		this.registerEvent(app.vault.on("modify", file => changed(file.path)));
		this.registerEvent(app.vault.on("delete", file => changed(file.path)));
		this.registerEvent(app.vault.on("rename", (file, old) => { changed(file.path); changed(old); }));
	}
	private activate(language: BilingualLanguage): void { this.state.active = language; this.programmatic.delete(language); }
	private geometry(language: BilingualLanguage): BilingualGeometry[] {
		const pane = this.panes.get(language); if (!pane) return [];
		const top = pane.scroller.getBoundingClientRect().top;
		return [...pane.anchors].map(([blockId, element]) => ({ blockId, top: pane.scroller.scrollTop + element.getBoundingClientRect().top - top }));
	}
	private capture(language: BilingualLanguage): void {
		const pane = this.panes.get(language); if (!pane || this.restoring || this.options.signal.aborted || !pane.article.isConnected || pane.scroller.clientHeight <= 0 || pane.scroller.scrollHeight <= pane.scroller.clientHeight || pane.article.getBoundingClientRect().height <= 0) return;
		const position = bilingualPositionAt(this.geometry(language), pane.scroller.scrollTop, pane.scroller.scrollHeight); if (position) this.state.positions[language] = position;
	}
	private restore(language: BilingualLanguage): void {
		const pane = this.panes.get(language); if (!pane) return;
		const top = bilingualScrollTarget(this.geometry(language), this.state.positions[language], pane.scroller.scrollHeight, Math.max(0, pane.scroller.scrollHeight - pane.scroller.clientHeight));
		if (top === null || Math.abs(pane.scroller.scrollTop - top) < 0.5) return;
		this.programmatic.add(language); pane.scroller.scrollTop = top;
	}
	synchronize(from: BilingualLanguage): void {
		if (this.invalidated || this.options.signal.aborted) return;
		if (this.options.document.selectedFiles && !this.options.document.syncAvailable) {
			const source = this.panes.get(from), to = from === "en" ? "zh-CN" : "en", target = this.panes.get(to);
			if (!source || !target) return;
			const progress = source.scroller.scrollTop / Math.max(1, source.scroller.scrollHeight - source.scroller.clientHeight);
			this.programmatic.add(to); target.scroller.scrollTop = progress * Math.max(0, target.scroller.scrollHeight - target.scroller.clientHeight);
			this.capture(from); this.capture(to); this.message?.setText("已按阅读进度同步；对应段落仍需核对"); this.publish(); return;
		}
		if (!this.options.document.syncAvailable) return;
		this.capture(from); const target = from === "en" ? "zh-CN" : "en", position = correspondingBilingualPosition(this.options.document, from, this.state.positions[from]);
		if (!position || !this.panes.get(target)?.anchors.has(position.blockId)) { this.message?.setText("此处没有可定位的对应段落"); return; }
		this.state.positions[target] = position; this.restore(target); this.capture(target); this.message?.setText(""); this.publish();
	}
	private publish(): void { this.options.onState?.(structuredClone(this.state)); }
	snapshot(): BilingualReadingState { for (const language of ["en", "zh-CN"] as const) this.capture(language); return structuredClone(this.state); }
	reveal(record: AnnotationRecord): void {
		const proof = record.bilingual; if (!proof || this.invalidated || this.options.signal.aborted) throw new Error("双语定位已失效");
		const pane = this.panes.get(proof.language), block = this.options.document.files[proof.language].blocks.find(b => b.id === proof.block.id);
		if (!pane || !block) throw new Error("双语段落不存在");
		this.activate(proof.language); this.state.positions[proof.language] = { blockId: block.id, progress: 0 }; this.restore(proof.language);
		// Search only inside this raw block's rendered paragraph, never elsewhere in the article.
		const elements = [...pane.article.querySelectorAll<HTMLElement>("p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6")].filter(el => this.blockForElement(proof.language, el)?.id === block.id);
		const file = this.options.document.files[proof.language], anchor = record.sourceAnchor;
		if (!anchor) throw new Error("保存的原文位置缺失");
		const matches = elements.map(el => ({ el, range: revealMarkdownRange(el, file.text, block.start, block.end, anchor.start, anchor.end) })).filter(item => item.range && !elements.some(other => other !== item.el && item.el.contains(other) && revealMarkdownRange(other, file.text, block.start, block.end, anchor.start, anchor.end)));
		if (matches.length !== 1) throw new Error("对应段落已打开，渲染选区无法唯一确认；请核对保存的文字");
		const { el, range } = matches[0];
		window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range!);
		el.classList.add("agent-bilingual-excerpt-target"); this.scrollToElement(proof.language, el, "center");
		const position = bilingualPositionAt(this.geometry(proof.language), pane.scroller.scrollTop, pane.scroller.scrollHeight); if (position) this.state.positions[proof.language] = position;
		this.capture(proof.language);
		if (this.state.linked) this.synchronize(proof.language); else this.publish();
		this.message?.setText(quoteLanguage(proof.language) + "已定位保存时的选句所在段落：" + annotationDisplayText(record.selectedText).slice(0, 80));
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
	private scrollToElement(language: BilingualLanguage, element: HTMLElement, align: "start" | "center" = "start"): void {
		const pane = this.panes.get(language); if (!pane || !pane.article.contains(element)) return;
		const scroller = pane.scroller, bounds = element.getBoundingClientRect();
		const top = scroller.scrollTop + bounds.top - scroller.getBoundingClientRect().top - scroller.clientTop;
		const offset = align === "center" ? (scroller.clientHeight - bounds.height) / 2 : 0;
		// scrollIntoView also scrolls hidden ancestors; themes can then lose the reader's headers.
		scroller.scrollTop = Math.max(0, Math.min(Math.max(0, scroller.scrollHeight - scroller.clientHeight), top - offset));
	}
	private scopeLinks(article: HTMLElement, language: BilingualLanguage): void {
		const ids = new Map<string, string>(), targets = new Map<string, HTMLElement>();
		for (const element of article.querySelectorAll<HTMLElement>("[id]")) { const old = element.id, id = "bilingual-" + language + "-" + old; ids.set(old, id); targets.set(id, element); element.id = id; }
		for (const link of article.querySelectorAll<HTMLAnchorElement>("a")) {
			const href = link.getAttribute("href") || ""; if (!href.startsWith("#")) continue;
			let target = href.slice(1); try { target = decodeURIComponent(target); } catch { /* Keep literal identifier. */ }
			const id = ids.get(target); if (id) link.setAttribute("href", "#" + id);
		}
		// Capture before MarkdownRenderer's footnote handlers, which may scroll/focus outer containers.
		article.addEventListener("click", event => {
			const link = (event.target as Element | null)?.closest?.("a[href]"); if (!link || !article.contains(link)) return;
			const href = link.getAttribute("href") || ""; if (!href.startsWith("#")) return;
			event.preventDefault(); event.stopImmediatePropagation();
			if (this.invalidated || this.options.signal.aborted) return;
			let id = href.slice(1); try { id = decodeURIComponent(id); } catch { /* Match literal malformed escapes only inside this article. */ }
			const target = targets.get(id);
			if (!target) { this.message?.setText("当前文档未找到该引用位置"); return; }
			this.activate(language); this.scrollToElement(language, target); this.capture(language);
			if (this.state.linked) this.synchronize(language); else this.publish();
		}, { capture: true, signal: this.options.signal });
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
const quoteLanguage = (language: BilingualLanguage): string => language === "en" ? "英文来源" : "中文译文";
