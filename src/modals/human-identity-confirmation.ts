import { App, Modal } from "obsidian";

import type {
	HumanIdentityConfirmationRequest,
} from "../agent/agent-loop-service";
import type { HumanIdentityConfirmationReceipt } from "../agent/paper-ingest-flow";
import type { AuthorizedPdfPageRaster } from "../agent/pdf-identity";

/**
 * Security authority for PDF identity binding. Extracted PDF text and metadata
 * are displayed only as hints; the user confirms the final rendered pixels
 * from the immutable snapshot against the plugin-bound Crossref record.
 */
export class HumanIdentityConfirmationModal extends Modal {
	private readonly request: HumanIdentityConfirmationRequest;
	private readonly finish: (receipt: HumanIdentityConfirmationReceipt | null) => void;
	private settled = false;
	private loadGeneration = 0;
	private activeRaster: AuthorizedPdfPageRaster | null = null;
	private preview?: HTMLImageElement;
	private status?: HTMLElement;
	private confirmButton?: HTMLButtonElement;

	constructor(
		app: App,
		request: HumanIdentityConfirmationRequest,
		finish: (receipt: HumanIdentityConfirmationReceipt | null) => void,
	) {
		super(app);
		this.request = request;
		this.finish = finish;
	}

	onOpen(): void {
		this.modalEl.addClass("agent-dashboard-identity-confirmation-modal");
		this.titleEl.setText("确认 PDF 文献身份");
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			cls: "agent-dashboard-identity-confirmation-warning",
			text: "请亲眼核对页面中的文献标题与右侧 Crossref 记录。PDF 文本层、文件名和元数据仅供定位，不能自动放行。",
		});

		const layout = this.contentEl.createDiv({ cls: "agent-dashboard-identity-confirmation-layout" });
		const visual = layout.createDiv({ cls: "agent-dashboard-identity-confirmation-visual" });
		const pageControl = visual.createDiv({ cls: "agent-dashboard-identity-confirmation-page-control" });
		pageControl.createEl("label", { text: "标题页" });
		const select = pageControl.createEl("select", { attr: { "aria-label": "选择 PDF 标题页" } });
		const selectablePages = Math.max(1, Math.min(3, this.request.pageCount || 1));
		for (let page = 1; page <= selectablePages; page += 1) {
			select.createEl("option", { text: `第 ${page} 页`, attr: { value: String(page) } });
		}
		select.addEventListener("change", () => { void this.loadPage(Number(select.value)); });
		this.status = visual.createDiv({ cls: "agent-dashboard-identity-confirmation-status", text: "正在渲染授权快照…" });
		this.preview = visual.createEl("img", {
			cls: "agent-dashboard-identity-confirmation-preview",
			attr: { alt: "授权 PDF 最终渲染标题页" },
		});

		const record = layout.createDiv({ cls: "agent-dashboard-identity-confirmation-record" });
		record.createEl("h3", { text: "待确认的 Crossref 记录" });
		this.addField(record, "原文标题", this.request.identity.title);
		this.addField(record, "DOI", this.request.identity.doi || "（无 DOI）");
		this.addField(record, "作者", this.request.identity.authors || "（未知）");
		this.addField(record, "年份", this.request.identity.year || "（未知）");
		const hints = record.createEl("details", { cls: "agent-dashboard-identity-confirmation-hints" });
		hints.createEl("summary", { text: "查看非权威 PDF 检索提示" });
		this.addField(hints, "文本层标题候选", this.request.localEvidence.firstPageTitleCandidates.join("；") || "（无）");
		this.addField(hints, "PDF 元数据标题", this.request.localEvidence.metadataTitle || "（无）");
		this.addField(hints, "DOI 候选", this.request.localEvidence.doiCandidates.join("；") || "（无）");

		const actions = this.contentEl.createDiv({ cls: "agent-dashboard-identity-confirmation-actions" });
		const cancel = actions.createEl("button", { text: "无法确认，停止入库" });
		cancel.addEventListener("click", () => this.complete(null));
		this.confirmButton = actions.createEl("button", {
			cls: "mod-cta",
			text: "确认：页面就是这条 Crossref 记录",
			attr: { disabled: "true" },
		});
		this.confirmButton.addEventListener("click", () => {
			const raster = this.activeRaster;
			if (!raster) return;
			this.complete({
				schemaVersion: 1,
				taskId: this.request.taskId,
				snapshotSha256: this.request.snapshotSha256,
				snapshotSize: this.request.snapshotSize,
				pageNumber: raster.pageNumber,
				rasterSha256: raster.rasterSha256,
				renderEngine: raster.renderEngine,
				renderEngineVersion: raster.renderEngineVersion,
				viewportWidth: raster.viewportWidth,
				viewportHeight: raster.viewportHeight,
				scale: raster.scale,
				confirmedTitle: this.request.identity.title,
				confirmedDoi: this.request.identity.doi || null,
				crossrefRecordHash: this.request.crossrefRecordHash,
				confirmationMode: "human-visual",
			});
		});
		void this.loadPage(1);
	}

	onClose(): void {
		this.loadGeneration += 1;
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.finish(null);
		}
	}

	private addField(parent: HTMLElement, label: string, value: string): void {
		const field = parent.createDiv({ cls: "agent-dashboard-identity-confirmation-field" });
		field.createEl("strong", { text: label });
		field.createDiv({ text: value });
	}

	private async loadPage(pageNumber: number): Promise<void> {
		const generation = ++this.loadGeneration;
		this.activeRaster = null;
		this.confirmButton?.setAttribute("disabled", "true");
		if (this.status) this.status.setText(`正在渲染第 ${pageNumber} 页…`);
		if (this.preview) this.preview.removeAttribute("src");
		try {
			const raster = await this.request.renderPage(pageNumber);
			if (generation !== this.loadGeneration || this.settled) return;
			this.activeRaster = raster;
			if (this.preview) this.preview.src = raster.rasterDataUrl;
			if (this.status) {
				this.status.setText(`授权快照第 ${raster.pageNumber}/${raster.pageCount} 页 · 栅格 ${raster.viewportWidth}×${raster.viewportHeight}`);
			}
			this.confirmButton?.removeAttribute("disabled");
		} catch (error) {
			if (generation !== this.loadGeneration || this.settled) return;
			if (this.status) this.status.setText(`页面渲染失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private complete(receipt: HumanIdentityConfirmationReceipt | null): void {
		if (this.settled) return;
		this.settled = true;
		this.finish(receipt);
		this.close();
	}
}

export function requestHumanIdentityConfirmation(
	app: App,
	request: HumanIdentityConfirmationRequest,
): Promise<HumanIdentityConfirmationReceipt | null> {
	if (request.signal.aborted) return Promise.resolve(null);
	return new Promise((resolve) => {
		let modal: HumanIdentityConfirmationModal;
		const onAbort = (): void => modal.close();
		const finish = (receipt: HumanIdentityConfirmationReceipt | null): void => {
			request.signal.removeEventListener("abort", onAbort);
			resolve(receipt);
		};
		modal = new HumanIdentityConfirmationModal(app, request, finish);
		request.signal.addEventListener("abort", onAbort, { once: true });
		modal.open();
	});
}
