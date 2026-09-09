import { Modal, type App } from "obsidian";
import { setTimeout, clearTimeout } from "node:timers";
import { openBoundedPdf } from "./file-validator";
import type { PdfSnapshot } from "./contracts";
import { abortable } from "./transport";

/** Passive local canvas preview: no model session, PDF actions, external links or remote resources. */
export class AcquiredPdfPreview extends Modal {
	private controller = new AbortController();
	private opened?: Awaited<ReturnType<typeof openBoundedPdf>>;
	private rendering?: {promise: Promise<void>; cancel(): void};
	private generation = 0;
	private page = 1;
	private canvas?: HTMLCanvasElement;
	private status?: HTMLElement;
	constructor(app: App, private bytes: Uint8Array, private snapshot: PdfSnapshot, private afterClose: () => void) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("rar-fulltext-preview"); this.setTitle("PDF 原文预览");
		this.contentEl.createEl("h3", { text: this.snapshot.identity.title });
		this.contentEl.createEl("p", { text: (this.snapshot.validation.identityCheck === "verified" ? "首页身份线索匹配" : "身份待核对，请对照标题与标识") + " · " + this.snapshot.candidate.pmc!.sourceVersionId + " · 来源：NLM / PMC", cls: "rar-fulltext-muted" });
		const nav = this.contentEl.createDiv("rar-fulltext-pager");
		const previous = nav.createEl("button", { text: "上一页", attr: { "aria-label": "PDF 上一页" } });
		this.status = nav.createEl("span", {text: "正在打开本地 PDF…", attr: {"aria-live":"polite"}});
		const next = nav.createEl("button", { text: "下一页", attr: { "aria-label": "PDF 下一页" } }); previous.disabled = next.disabled = true;
		const host = this.contentEl.createDiv("rar-fulltext-page"); this.canvas = host.createEl("canvas", { attr: { "aria-label": "PDF 原文页面" } });
		const show = async (number: number) => {
			if (!this.opened || number < 1 || number > this.opened.pdf.numPages || this.controller.signal.aborted) return;
			this.page = number; const generation = ++this.generation; this.rendering?.cancel(); previous.disabled = next.disabled = true;
			this.status!.setText(`第 ${number} / ${this.opened.pdf.numPages} 页 · 正在绘制`);
			const timer = setTimeout(() => this.controller.abort(), 20000);
			try {
				const page = await abortable(this.opened.pdf.getPage(number), this.controller.signal);
				try {
					if (generation !== this.generation || this.controller.signal.aborted) return;
					const original = page.getViewport({scale: 1});
					if (!Number.isFinite(original.width * original.height) || original.width <= 0 || original.height <= 0 || Math.max(original.width/original.height, original.height/original.width) > 20) throw new Error("PDF 页面尺寸超出预览范围");
					const viewport = page.getViewport({scale: Math.min(2, 1600 / Math.max(original.width, original.height))});
					const canvas = this.canvas!; canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
					const context = canvas.getContext("2d"); if (!context) throw new Error("页面绘制不可用");
					this.rendering = page.render({ canvasContext: context, viewport, background: "white", intent: "print" });
					await abortable(this.rendering.promise, this.controller.signal);
					if (generation === this.generation) { this.status!.setText(`第 ${number} / ${this.opened.pdf.numPages} 页`); previous.disabled = number === 1; next.disabled = number === this.opened.pdf.numPages; }
				} finally { page.cleanup?.(); }
			} catch { if (!this.controller.signal.aborted && generation === this.generation) this.status!.setText("此页无法绘制，请关闭后重开预览"); else if (this.contentEl.isConnected) this.status!.setText("预览已停止或超时"); }
			finally { clearTimeout(timer); if (this.controller.signal.aborted) { this.rendering?.cancel(); void this.opened?.destroy().catch(() => undefined); } }
		};
		previous.addEventListener("click", () => { void show(this.page - 1); }); next.addEventListener("click", () => { void show(this.page + 1); });
		const timer = setTimeout(() => this.controller.abort(), 20000);
		void openBoundedPdf(this.bytes, this.controller.signal).then(async opened => {
			clearTimeout(timer); this.bytes = new Uint8Array();
			if (this.controller.signal.aborted) { await opened.destroy(); return; }
			this.opened = opened; await show(1);
		}).catch(() => { if (this.contentEl.isConnected) this.status!.setText("PDF 预览无法打开或已超时"); }).finally(() => clearTimeout(timer));
	}
	onClose(): void {
		this.controller.abort(); this.rendering?.cancel(); void this.opened?.destroy().catch(() => undefined); this.bytes = new Uint8Array();
		if (this.canvas) this.canvas.width = this.canvas.height = 0; this.contentEl.empty(); this.afterClose();
	}
}
