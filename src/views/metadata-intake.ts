import { Modal, type App } from "obsidian";
import { parseAcquisitionInput } from "../fulltext/contracts";
import type { MetadataIntakeService, MetadataPreview, MetadataSaved } from "../library/metadata-intake";
import { renderBibliography } from "./bibliography";

export class MetadataIntakeModal extends Modal {
	private closed = false;
	private generation = 0;
	private request?: AbortController;
	private saving = false;
	private preview?: MetadataPreview;
	private saved?: MetadataSaved;
	private input!: HTMLInputElement;
	private query!: HTMLButtonElement;
	private cancel!: HTMLButtonElement;
	private status!: HTMLElement;
	private result!: HTMLElement;
	constructor(app: App, private readonly service: MetadataIntakeService, private readonly openPaper: (paperId: string) => Promise<void>) { super(app); }
	onOpen(): void {
		this.closed = false; this.contentEl.empty(); this.contentEl.addClass("rar-metadata-intake");
		this.contentEl.createEl("h2", { text: "添加文献信息" });
		this.contentEl.createEl("p", { text: "向 Europe PMC / Crossref 查询书目信息，核对后保存。不需要配置模型。" });
		this.input = this.contentEl.createEl("input", { type: "text", placeholder: "DOI、PMID、PMCID 或支持的论文链接", attr: { "aria-label": "查询文献标识", maxlength: "1024" } });
		this.input.oninput = () => { this.invalidate(); this.status.setText(""); this.validate(); };
		const actions = this.contentEl.createDiv("rar-library-actions");
		this.query = actions.createEl("button", { text: "查询书目信息" }); this.query.onclick = () => { void this.lookup(); };
		this.cancel = actions.createEl("button", { text: "取消查询" }); this.cancel.onclick = () => { this.invalidate(); this.status.setText("查询已取消"); this.validateButtons(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.result = this.contentEl.createDiv(); this.validate();
	}
	onClose(): void { this.closed = true; this.invalidate(); this.contentEl.empty(); }
	private invalidate(): void { this.generation++; this.request?.abort(); this.request = undefined; this.preview = undefined; this.saved = undefined; this.result?.empty(); }
	private validate(): void {
		let valid = false; try { const input = parseAcquisitionInput(this.input.value); valid = true; if (!this.request && !this.saving && !this.preview) this.status.setText(`${input.kind.toUpperCase()} · ${input.value}`); }
		catch (error) { if (this.input.value.trim()) this.status.setText(error instanceof Error ? error.message : String(error)); }
		this.input.disabled = this.saving; this.query.disabled = !valid || Boolean(this.request) || this.saving;
		this.cancel.hidden = !this.request || this.saving;
	}
	private async lookup(): Promise<void> {
		if (this.query.disabled || this.closed) return;
		this.invalidate(); const generation = this.generation, controller = new AbortController(); this.request = controller;
		this.validate(); this.status.setText("正在查询并核对现有记录…");
		try {
			const preview = await this.service.prepare(this.input.value, controller.signal);
			if (this.closed || generation !== this.generation) return;
			this.preview = preview; this.renderPreview(); this.status.setText("请核对标题、作者与标识后保存。");
		} catch (error) { if (!this.closed && generation === this.generation) this.status.setText(error instanceof Error ? error.message : String(error)); }
		finally { if (!this.closed && generation === this.generation) { this.request = undefined; this.validateButtons(); } }
	}
	private validateButtons(): void { const message = this.status.textContent; this.validate(); this.status.setText(message || ""); }
	private renderPreview(): void {
		this.result.empty(); const preview = this.preview; if (!preview) return;
		this.result.createEl("h3", { text: preview.identity.title });
		this.result.createEl("p", { text: Object.entries(preview.identity.identifiers).map(([key, value]) => `${key.toUpperCase()}：${value}`).join(" · ") });
		renderBibliography(this.result, preview.identity);
		for (const warning of preview.warnings) this.result.createEl("p", { text: warning, cls: "rar-library-warning" });
		this.result.createEl("p", { text: "仅保存书目信息，不下载全文或生成论文笔记；已有文献记录会直接复用。" });
		const save = this.result.createEl("button", { text: preview.existing ? "保存或复用已有记录" : "核对无误，仅保存书目信息", cls: "mod-cta" });
		save.onclick = () => { if (!this.saving && !this.saved) { save.disabled = true; void this.commit(preview, save); } };
	}
	private async commit(preview: MetadataPreview, button: HTMLButtonElement): Promise<void> {
		if (this.closed || preview !== this.preview) return;
		const controller = new AbortController(); this.request = controller; this.saving = true; this.validateButtons(); this.status.setText("正在保存书目信息…");
		try {
			const saved = await this.service.save(preview, controller.signal); this.saved = saved;
			if (this.closed) return;
			this.status.setText(saved.reused ? "已复用现有文献，原有信息和人工状态保持不变。" : "书目信息已保存，尚未进行全文阅读或科学审阅。");
			button.setText("已保存");
			const open = this.result.createEl("button", { text: "在文献库中查看" });
			open.onclick = () => { open.disabled = true; void this.openPaper(saved.paperId).then(() => this.close()).catch(error => { if (!this.closed) { this.status.setText("记录已保存，打开失败：" + String(error)); open.disabled = false; } }); };
		} catch (error) { if (!this.closed) { this.status.setText("保存未完成：" + (error instanceof Error ? error.message : String(error)) + "。可重试，已提交的记录会复用。"); button.disabled = false; } }
		finally { this.saving = false; this.request = undefined; if (!this.closed) this.validateButtons(); }
	}
}
