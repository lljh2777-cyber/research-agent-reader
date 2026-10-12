import { Component, ItemView, MarkdownRenderer, Menu, TFile, type App, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { BILINGUAL_MARKDOWN_LIMIT, loadSelectedBilingualDocument } from "../reader/bilingual-document";
import { normalizeManualSplit, splitProgress, type ManualSplitState } from "../reader/manual-split";
import { FileSourceStorage } from "../sources/storage";
import { bytesDigest } from "../papers/identity";
import { readPdfBytes } from "../annotations/native-pdf-excerpt";
import { bindDetachedMarkdownSource } from "../annotations/manual-source";
import { verifyBilingual } from "../annotations/bilingual";
import type { AnnotationRecord } from "../annotations/types";
import { BilingualReader } from "./bilingual-reader";
import { SplitPdfPane } from "./split-pdf-pane";
import { chooseReadingFile } from "./reading-mode-picker";

export const MANUAL_SPLIT_VIEW_TYPE = "research-agent-reader-split";
interface SplitHost {
	app: App; openSelectionAnnotation(): Promise<void>;
	chooseSplitReading(path: string, leaf?: WorkspaceLeaf): void;
	openSplitSource(path: string, leaf: WorkspaceLeaf): Promise<void>;
}
export class ManualSplitReaderView extends ItemView {
	private state?: ManualSplitState;
	private controller?: AbortController;
	private renderer?: Component;
	private bilingual?: BilingualReader;
	private pdf?: SplitPdfPane;
	private markdown?: HTMLElement;
	private opened = false;
	private restoring = true;
	private invalidated = false;
	private syncing = false;
	private active: "left" | "right" = "left";
	private frame = 0;
	constructor(leaf: WorkspaceLeaf, private readonly host: SplitHost) { super(leaf); this.navigation = true; }
	getViewType(): string { return MANUAL_SPLIT_VIEW_TYPE; }
	getIcon(): string { return "columns-2"; }
	getDisplayText(): string { return this.state ? [this.state.left, this.state.right].map(p => p.split("/").pop()).join(" ⇄ ") : "双栏阅读"; }
	getState(): Record<string, unknown> { this.capture(); return this.state ? { ...this.state, ...(this.bilingual ? { bilingualState: this.bilingual.snapshot() } : {}) } : {}; }
	async setState(value: unknown, _result: ViewStateResult): Promise<void> { this.state = normalizeManualSplit(value); if (this.opened) await this.render(); }
	async onOpen(): Promise<void> { this.opened = true; if (this.state) await this.render(); }
	async onClose(): Promise<void> { this.capture(); this.opened = false; this.stop(); }
	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		if (!this.state) return;
		menu.addItem(item => item.setTitle("选择阅读方式…").setIcon("columns-2").onClick(() => this.host.chooseSplitReading(this.state!.entry, this.leaf)));
		menu.addItem(item => item.setTitle("退出双栏阅读").setIcon("panel-left-close").onClick(() => void this.host.openSplitSource(this.state!.entry, this.leaf)));
	}
	async revealExcerpt(record: AnnotationRecord): Promise<void> {
		const reader = this.bilingual, signal = this.controller?.signal; if (!reader) throw new Error("双语阅读器未就绪");
		await verifyBilingual(this.app, record, signal); signal?.throwIfAborted();
		const proof = record.bilingual!, doc = reader.options.document;
		if (reader !== this.bilingual || proof.digests.en !== doc.files.en.digest || proof.digests["zh-CN"] !== doc.files["zh-CN"].digest || proof.digests.metadata !== doc.metadataDigest) throw new Error("当前双栏与保存时的文件版本不一致，请重新核对");
		reader.reveal(record); this.save();
	}
	private save(): void { this.app.workspace.requestSaveLayout(); }
	private capture(): void {
		if (!this.state || this.restoring || this.controller?.signal.aborted) return;
		if (this.markdown?.isConnected && this.markdown.clientHeight > 0 && this.markdown.scrollHeight > this.markdown.clientHeight) this.state.markdownProgress = splitProgress(this.markdown.scrollTop / (this.markdown.scrollHeight - this.markdown.clientHeight));
		if (this.pdf) { this.state.pdfPage = this.pdf.page; this.state.pdfProgress = this.pdf.progress; this.state.pdfZoom = this.pdf.zoom; }
	}
	private stop(): void { this.controller?.abort(); this.renderer?.unload(); this.bilingual?.unload(); this.pdf?.unload(); cancelAnimationFrame(this.frame); this.renderer = undefined; this.bilingual = undefined; this.pdf = undefined; this.markdown = undefined; }
	private async render(): Promise<void> {
		this.stop(); this.restoring = true; this.invalidated = false;
		const state = this.state!; const controller = this.controller = new AbortController(), signal = controller.signal;
		this.contentEl.empty(); this.contentEl.addClass("agent-manual-split-reader");
		const bar = this.contentEl.createDiv({ cls: "agent-split-tabs" });
		for (const side of ["left", "right"] as const) {
			const group = bar.createDiv({ cls: "agent-split-tab" });
			const label = state.mode === "bilingual" ? side === "left" ? "英文原文" : "中文译文" : side === "left" ? "Markdown" : "PDF";
			group.createSpan({ text: label });
			const change = group.createEl("button", { text: state[side].split("/").pop(), cls: "agent-split-file-name", attr: { type: "button", title: "更换" + label + "：" + state[side], "aria-label": "更换" + label } });
			change.addEventListener("click", () => void this.replace(side), { signal });
		}
		const exit = bar.createEl("button", { text: "退出双栏", attr: { type: "button" } });
		exit.addEventListener("click", () => void this.host.openSplitSource(state.entry, this.leaf), { signal });
		const message = this.contentEl.createDiv({ cls: "agent-split-message", attr: { role: "status" } });
		const workspace = this.contentEl.createDiv({ cls: "agent-split-content" });
		try {
			if (state.mode === "bilingual") {
				const adapter = this.app.vault.adapter as { getBasePath?: () => string }; if (!adapter.getBasePath) throw new Error("双栏阅读需要桌面本地知识库");
				const doc = await loadSelectedBilingualDocument(new FileSourceStorage(adapter.getBasePath()), { en: state.left, zh: state.right }, signal); signal.throwIfAborted();
				this.bilingual = new BilingualReader({ app: this.app, host: workspace, document: doc, signal, ordinary: () => void this.host.openSplitSource(state.entry, this.leaf), hideOrdinary: true, annotate: () => this.host.openSelectionAnnotation(), ratio: state.ratio, defaultLinked: state.linked, state: state.bilingualState, onRatio: ratio => { state.ratio = ratio; this.save(); }, onState: snapshot => { state.bilingualState = snapshot; state.linked = snapshot.linked; this.save(); } });
				this.bilingual.load(); await this.bilingual.render();
			} else await this.renderMarkdownPdf(workspace, message, state, signal);
			if (signal.aborted) return;
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		} catch (error) { if (!signal.aborted) message.setText(String(error instanceof Error ? error.message : error) + "；可更换文件或退出双栏，原文件保持不变。"); }
	}
	private async replace(side: "left" | "right"): Promise<void> {
		const signal = this.controller?.signal, before = this.state!;
		const title = before.mode === "bilingual" ? "选择" + (side === "left" ? "英文原文" : "中文译文") : "选择" + (side === "left" ? "左栏 Markdown" : "右栏 PDF");
		const file = await chooseReadingFile(this.app, before.mode === "md-pdf" && side === "right" ? "pdf" : "md", before[side === "left" ? "right" : "left"], title);
		if (!file || signal?.aborted || this.state !== before) return;
		if (file.path === before[side]) return;
		const next = normalizeManualSplit({ ...before, [side]: file.path, entry: before.entry === before[side] ? file.path : before.entry, bilingualState: undefined, digests: undefined, markdownProgress: 0, pdfPage: 1, pdfProgress: 0 });
		await this.setState(next, { history: false }); this.save();
	}
	private async renderMarkdownPdf(workspace: HTMLElement, message: HTMLElement, state: ManualSplitState, signal: AbortSignal): Promise<void> {
		const markdownFile = this.app.vault.getAbstractFileByPath(state.left), pdfFile = this.app.vault.getAbstractFileByPath(state.right);
		if (!(markdownFile instanceof TFile) || !(pdfFile instanceof TFile)) throw new Error("所选文件已移动或缺失，请重新选择");
		if (markdownFile.stat.size > BILINGUAL_MARKDOWN_LIMIT) throw new Error("Markdown 超过 16 MiB 阅读上限");
		const text = await this.app.vault.read(markdownFile), bytes = await readPdfBytes(this.app, state.right, signal); signal.throwIfAborted();
		const digests = { left: bytesDigest(new TextEncoder().encode(text)), right: bytesDigest(bytes) };
		if (!state.digests || state.digests.left !== digests.left || state.digests.right !== digests.right) { state.markdownProgress = 0; state.pdfPage = 1; state.pdfProgress = 0; }
		state.digests = digests;
		const linkedLabel = workspace.createEl("label", { cls: "agent-bilingual-linked" });
		const linked = linkedLabel.createEl("input", { attr: { type: "checkbox", "aria-label": "双栏联动" } }); linked.checked = state.linked;
		linkedLabel.createSpan({ text: "双栏联动 · 按阅读进度，内容对应需核对" });
		linked.addEventListener("change", () => { state.linked = linked.checked; if (state.linked) void synchronize(this.active); this.save(); }, { signal });
		const panes = workspace.createDiv({ cls: "agent-bilingual-workspace agent-split-md-pdf" });
		const apply = (): void => { panes.style.setProperty("--bilingual-left", state.ratio + "fr"); panes.style.setProperty("--bilingual-right", (1 - state.ratio) + "fr"); }; apply();
		let rightScroller: HTMLElement;
		const synchronize = async (from: "left" | "right"): Promise<void> => {
			if (this.restoring || this.invalidated || signal.aborted || !this.pdf || this.syncing) return;
			this.syncing = true;
			try { if (from === "left") await this.pdf.showDocumentProgress(splitProgress(this.markdown!.scrollTop / Math.max(1, this.markdown!.scrollHeight - this.markdown!.clientHeight))); else this.markdown!.scrollTop = this.pdf.documentProgress * Math.max(0, this.markdown!.scrollHeight - this.markdown!.clientHeight); this.capture(); this.save(); }
			finally { this.frame = requestAnimationFrame(() => { this.syncing = false; }); }
		};
		let pdfHeading: HTMLElement | undefined;
		for (const side of ["left", "right"] as const) {
			const pane = panes.createEl("section", { cls: "agent-bilingual-pane", attr: { "aria-label": side === "left" ? "Markdown 正文" : "PDF 原文件" } });
			const heading = pane.createDiv({ cls: "agent-bilingual-pane-heading" });
			heading.createEl("strong", { text: side === "left" ? "Markdown 正文" : "PDF 原文件" });
			const sync = heading.createEl("button", { text: "以本栏同步另一栏", attr: { type: "button", "data-split-sync": side } }); sync.addEventListener("click", () => { this.active = side; void synchronize(side); }, { signal });
			const annotate = heading.createEl("button", { text: "批注", attr: { type: "button", "data-split-annotate": side } }); annotate.addEventListener("mousedown", e => e.preventDefault(), { signal });
			annotate.addEventListener("click", () => { const selection = document.defaultView?.getSelection(); if (!selection?.anchorNode || !scroller.contains(selection.anchorNode) || !selection.focusNode || !scroller.contains(selection.focusNode)) { message.setText("请先在本栏选择文字"); return; } void this.host.openSelectionAnnotation(); }, { signal });
			const scroller = pane.createDiv({ cls: side === "left" ? "agent-bilingual-scroll markdown-reading-view" : "agent-bilingual-scroll agent-split-pdf-scroll", attr: { tabindex: "0" } });
			for (const type of ["pointerdown", "wheel", "touchstart", "focusin", "keydown"] as const) scroller.addEventListener(type, () => { this.active = side; }, { signal, passive: true });
			scroller.addEventListener("scroll", () => { if (this.restoring || this.syncing) return; this.capture(); if (state.linked && this.active === side) void synchronize(side); else this.save(); }, { signal, passive: true });
			if (side === "left") {
				this.markdown = scroller; const article = scroller.createEl("article", { cls: "markdown-rendered agent-bilingual-article" });
				const renderer = this.renderer = new Component(); renderer.load(); await MarkdownRenderer.render(this.app, text, article, state.left, renderer); signal.throwIfAborted(); article.dataset.agentAnnotationSource = state.left; bindDetachedMarkdownSource(article);
				const splitter = panes.createDiv({ cls: "agent-bilingual-splitter", attr: { role: "separator", tabindex: "0", "aria-label": "调整双栏宽度", "aria-orientation": "vertical", "aria-valuemin": "30", "aria-valuemax": "70", "aria-valuenow": String(Math.round(state.ratio * 100)) } });
				let dragging = false; const change = (ratio: number): void => { state.ratio = Math.max(0.3, Math.min(0.7, ratio)); apply(); splitter.setAttribute("aria-valuenow", String(Math.round(state.ratio * 100))); this.save(); };
				splitter.addEventListener("pointerdown", e => { e.preventDefault(); dragging = true; splitter.setPointerCapture(e.pointerId); }, { signal });
				splitter.addEventListener("pointermove", e => { if (dragging) { const rect = panes.getBoundingClientRect(); if (rect.width) change((e.clientX - rect.left) / rect.width); } }, { signal });
				for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) splitter.addEventListener(event, () => { dragging = false; }, { signal });
				splitter.addEventListener("keydown", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); change(state.ratio + (e.key === "ArrowLeft" ? -0.02 : 0.02)); } }, { signal });
			} else { rightScroller = scroller; pdfHeading = heading; }
		}
		this.pdf = new SplitPdfPane(this.app, pdfFile, pdfHeading!, rightScroller!, signal, () => { this.capture(); if (state.linked) void synchronize("right"); else this.save(); }); this.pdf.load(); await this.pdf.render(state.pdfPage, state.pdfProgress, state.pdfZoom); signal.throwIfAborted();
		if (await this.app.vault.read(markdownFile) !== text || bytesDigest(await readPdfBytes(this.app, state.right, signal)) !== digests.right) throw new Error("文件在打开期间变化，请重新选择或重开");
		const changed = (path: string): void => { if (![state.left, state.right].includes(path) || signal.aborted) return; this.invalidated = true; state.linked = false; linked.checked = false; linked.disabled = true; message.setText("文件已变化，请重开核对；保存的历史批注仍保留"); for (const button of workspace.querySelectorAll<HTMLButtonElement>("[data-split-sync]")) button.disabled = true; this.save(); };
		const renderer = this.renderer!; renderer.registerEvent(this.app.vault.on("modify", f => changed(f.path))); renderer.registerEvent(this.app.vault.on("delete", f => changed(f.path))); renderer.registerEvent(this.app.vault.on("rename", (f, old) => { changed(f.path); changed(old); }));
		this.frame = requestAnimationFrame(() => { if (signal.aborted) return; this.markdown!.scrollTop = state.markdownProgress * Math.max(0, this.markdown!.scrollHeight - this.markdown!.clientHeight); this.frame = requestAnimationFrame(() => { if (!signal.aborted) { this.restoring = false; this.save(); } }); });
	}
}
