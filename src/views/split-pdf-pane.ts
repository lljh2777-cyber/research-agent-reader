import { Component, TFile, loadPdfJs, type App } from "obsidian";
import { bindEmbeddedPdfSelection, readPdfBytes, type PdfDocument } from "../annotations/native-pdf-excerpt";
import { PDF_EXCERPT_MAX_PAGES, pdfPageText } from "../annotations/pdf-excerpt";
import { splitProgress } from "../reader/manual-split";

/** One fitted page at a time keeps canvas and text-layer memory bounded. */
export class SplitPdfPane extends Component {
	private doc: any;
	private pdfjs: any;
	private task: any;
	private textLayer: any;
	private loading: any;
	private generation = 0;
	zoom = 1;
	private canvas?: HTMLCanvasElement;
	private resize?: ResizeObserver;
	private resizeTimer = 0;
	private restoreProgress = 0;
	private disposed = false;
	page = 1;
	get count(): number { return this.doc?.numPages || 0; }
	constructor(private readonly app: App, readonly file: TFile, readonly heading: HTMLElement, readonly scroller: HTMLElement,
		private readonly signal: AbortSignal, private readonly onPosition: () => void) { super(); }
	async render(page: number, progress: number, zoom = 1): Promise<void> {
		this.zoom = Math.max(0.4, Math.min(4, zoom));
		const bytes = await readPdfBytes(this.app, this.file.path, this.signal);
		this.pdfjs = await loadPdfJs(); this.signal.throwIfAborted();
		this.loading = this.pdfjs.getDocument({ data: bytes, isEvalSupported: false });
		this.signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.doc = await this.loading.promise; this.signal.throwIfAborted();
		if (!Number.isSafeInteger(this.doc.numPages) || this.doc.numPages < 1 || this.doc.numPages > PDF_EXCERPT_MAX_PAGES) throw new Error("PDF 页数超出阅读上限");
		bindEmbeddedPdfSelection(this.scroller, () => this.disposed ? undefined : { file: this.file, document: this.doc as PdfDocument, isCurrent: () => !this.signal.aborted && this.app.vault.getAbstractFileByPath(this.file.path) === this.file });
		const previous = this.heading.createEl("button", { text: "上一页", attr: { type: "button", "aria-label": "PDF 上一页" } });
		const input = this.heading.createEl("input", { cls: "agent-split-pdf-page-input", attr: { type: "number", min: "1", max: String(this.count), "aria-label": "PDF 页码" } });
		this.heading.createSpan({ text: "/ " + this.count });
		const next = this.heading.createEl("button", { text: "下一页", attr: { type: "button", "aria-label": "PDF 下一页" } });
		const change = async (number: number): Promise<void> => { await this.showPage(number, 0); this.onPosition(); };
		previous.addEventListener("click", () => void change(this.page - 1), { signal: this.signal });
		next.addEventListener("click", () => void change(this.page + 1), { signal: this.signal });
		input.addEventListener("change", () => void change(Number(input.value)), { signal: this.signal });
		const smaller = this.heading.createEl("button", { text: "−", attr: { type: "button", "aria-label": "缩小 PDF" } });
		const zoomLabel = this.heading.createSpan({ text: Math.round(this.zoom * 100) + "%", attr: { "aria-label": "PDF 缩放" } });
		const larger = this.heading.createEl("button", { text: "+", attr: { type: "button", "aria-label": "放大 PDF" } });
		const magnify = async (delta: number): Promise<void> => { const progress = this.progress; this.zoom = Math.max(0.4, Math.min(4, Math.round((this.zoom + delta) * 10) / 10)); zoomLabel.setText(Math.round(this.zoom * 100) + "%"); await this.showPage(this.page, progress); this.onPosition(); };
		smaller.addEventListener("click", () => void magnify(-0.2), { signal: this.signal }); larger.addEventListener("click", () => void magnify(0.2), { signal: this.signal });
		this.register(() => this.dispose());
		await this.showPage(page, progress);
		this.resize = new ResizeObserver(() => { window.clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(() => { if (!this.signal.aborted) void this.showPage(this.page, this.progress); }, 150); });
		this.resize.observe(this.scroller);
	}
	get progress(): number { if (this.canvas && this.scroller.clientHeight > 0 && this.scroller.scrollHeight > this.scroller.clientHeight) this.restoreProgress = splitProgress(this.scroller.scrollTop / (this.scroller.scrollHeight - this.scroller.clientHeight)); return this.restoreProgress; }
	get documentProgress(): number { return this.count ? ((this.page - 1) + this.progress) / this.count : 0; }
	async showDocumentProgress(progress: number): Promise<void> { const position = splitProgress(progress) * this.count; await this.showPage(Math.min(this.count, Math.floor(position) + 1), position >= this.count ? 1 : position % 1); }
	async showPage(page: number, progress: number): Promise<void> {
		if (!this.doc || this.signal.aborted) return;
		page = Number.isFinite(page) ? Math.max(1, Math.min(this.count, Math.floor(page))) : this.page;
		this.restoreProgress = splitProgress(progress);
		if (page === this.page && this.canvas && this.canvas.clientWidth === Math.floor(Math.max(160, this.scroller.clientWidth - 24) * this.zoom)) { this.scroller.scrollTop = this.restoreProgress * Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight); return; }
		const generation = ++this.generation;
		this.task?.cancel(); this.textLayer?.cancel();
		try {
			const source = await this.doc.getPage(page); if (generation !== this.generation || this.signal.aborted) return;
			const width = Math.max(160, this.scroller.clientWidth - 24), base = source.getViewport({ scale: 1 }), viewport = source.getViewport({ scale: width / base.width * this.zoom });
			const density = Math.min(2, window.devicePixelRatio || 1);
			if (!Number.isFinite(viewport.height) || viewport.width * viewport.height * density * density > 16 * 1024 * 1024) throw new Error("PDF 单页渲染尺寸过大，请缩小栏宽或在原生视图打开");
			this.releaseCanvas(); this.scroller.empty();
			const pageEl = this.scroller.createDiv({ cls: "page agent-split-pdf-page", attr: { "data-page-number": String(page) } });
			pageEl.style.width = viewport.width + "px"; pageEl.style.height = viewport.height + "px"; pageEl.style.setProperty("--scale-factor", String(viewport.scale));
			const canvas = this.canvas = pageEl.createEl("canvas"); canvas.width = Math.ceil(viewport.width * density); canvas.height = Math.ceil(viewport.height * density); canvas.style.width = Math.floor(viewport.width) + "px"; canvas.style.height = viewport.height + "px";
			this.task = source.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, transform: [density, 0, 0, density, 0, 0], background: "#fff" });
			await this.task.promise; if (generation !== this.generation || this.signal.aborted) return;
			const content = await source.getTextContent({ disableNormalization: true }); if (generation !== this.generation || this.signal.aborted) return;
			if (this.pdfjs.TextLayer && content.items.some((i: { str?: string }) => i.str?.trim())) {
				const text = pdfPageText(content.items), layer = pageEl.createDiv({ cls: "textLayer" });
				this.textLayer = new this.pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
				await this.textLayer.render(); if (generation !== this.generation || this.signal.aborted) return;
				let index = 0;
				for (const span of this.textLayer.textDivs as HTMLElement[]) { while (index < text.items.length && !text.items[index].str && span.textContent !== "") index++; if (!text.items[index] || span.textContent !== text.items[index].str) throw new Error("PDF 文字层未能对应原页，不能划选批注"); span.dataset.idx = String(index++); }
			} else pageEl.createDiv({ text: "此页没有可批注的文字层，可继续阅读或打开原文件。", cls: "agent-split-message" });
			this.page = page; this.heading.querySelector<HTMLInputElement>("input")!.value = String(page);
			this.scroller.scrollTop = this.restoreProgress * Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
		} catch (error) { if (generation === this.generation && !this.signal.aborted && !/cancel|abort/i.test(String(error))) this.scroller.createEl("p", { text: String(error instanceof Error ? error.message : error), cls: "agent-split-message" }); }
	}
	private releaseCanvas(): void { if (this.canvas) { this.canvas.width = this.canvas.height = 0; this.canvas = undefined; } }
	private dispose(): void { if (this.disposed) return; this.disposed = true; this.generation++; window.clearTimeout(this.resizeTimer); this.resize?.disconnect(); this.task?.cancel(); this.textLayer?.cancel(); this.releaseCanvas(); void Promise.resolve(this.loading?.destroy()).catch(() => {}); }
}
