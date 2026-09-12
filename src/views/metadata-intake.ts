import { Modal, type App } from "obsidian";
import { parseAcquisitionInput } from "../fulltext/contracts";
import type { MetadataIntakeService, MetadataPreview, MetadataSaved, MetadataSource, PaperIntakeContext, ManualMetadataPreview } from "../library/metadata-intake";
import type { ManualPaperInput } from "../library/manual-record";
import { renderBibliography } from "./bibliography";
import { renderManualBibliography } from "./manual-bibliography";

export interface PaperIntakeActions {
	local(context?: PaperIntakeContext): void | Promise<void>;
	fulltext(context: PaperIntakeContext): void | Promise<void>;
	source(source: MetadataSource, signal: AbortSignal): Promise<void>;
}

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
	private localStart?: HTMLButtonElement;
	private manualStart?: HTMLButtonElement;
	private manualMode = false;
	constructor(app: App, private readonly service: MetadataIntakeService, private readonly openPaper: (paperId: string) => Promise<void>, private readonly actions?: PaperIntakeActions, private readonly initial?: { title: string; reference: string }) { super(app); }
	onOpen(): void {
		this.closed = false; this.contentEl.empty(); this.contentEl.addClass("rar-metadata-intake");
		this.contentEl.createEl("h2", { text: this.actions ? "添加文献" : "添加文献信息" });
		this.contentEl.createEl("p", { text: this.actions ? "向 Europe PMC / Crossref 查询并核对书目信息，保存后继续查找全文或添加本地 PDF。无需模型，后续原文操作各自确认。" : "向 Europe PMC / Crossref 查询书目信息，核对后保存。不需要配置模型。" });
		if (this.initial) this.contentEl.createEl("p", { text: `来自人工条目：${this.initial.title}。原条目保留；查询结果需另行核对保存，不自动合并或改为已核验。` });
		if (this.actions) {
			this.localStart = this.contentEl.createEl("button", { text: "从本地 PDF 开始 / 恢复添加" });
			this.localStart.onclick = () => { void this.runAction(undefined, () => this.actions!.local()); };
		}
		this.input = this.contentEl.createEl("input", { type: "text", placeholder: "DOI、PMID、PMCID 或支持的论文链接", attr: { "aria-label": "查询文献标识", maxlength: "1024" } });
		this.input.value = this.initial?.reference || "";
		this.input.oninput = () => { this.invalidate(); this.status.setText(""); this.validate(); };
		const actions = this.contentEl.createDiv("rar-library-actions");
		this.query = actions.createEl("button", { text: "查询书目信息" }); this.query.onclick = () => { void this.lookup(); };
		this.cancel = actions.createEl("button", { text: "取消查询" }); this.cancel.onclick = () => { this.invalidate(); this.status.setText("查询已取消"); this.validateButtons(); };
		this.manualStart = actions.createEl("button", { text: "手工登记（未核验）" }); this.manualStart.onclick = () => this.beginManual();
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.result = this.contentEl.createDiv(); this.validate();
	}
	onClose(): void { this.closed = true; this.invalidate(); this.contentEl.empty(); }
	private invalidate(): void { this.generation++; this.request?.abort(); this.request = undefined; this.preview = undefined; this.saved = undefined; this.manualMode = false; this.result?.empty(); }
	private validate(): void {
		let valid = false; try { const input = parseAcquisitionInput(this.input.value); valid = true; if (!this.request && !this.saving && !this.preview && !this.manualMode) this.status.setText(`${input.kind.toUpperCase()} · ${input.value}`); }
		catch (error) { if (this.input.value.trim()) this.status.setText(error instanceof Error ? error.message : String(error)); }
		this.input.disabled = this.saving || this.manualMode; this.query.disabled = !valid || Boolean(this.request) || this.saving || this.manualMode;
		this.input.hidden = this.query.hidden = this.manualMode;
		this.cancel.hidden = !this.request || this.saving;
		if (this.localStart) { this.localStart.disabled = this.saving || Boolean(this.request) || this.manualMode; this.localStart.hidden = this.manualMode; }
		if (this.manualStart) { this.manualStart.disabled = this.saving || Boolean(this.request) || this.manualMode; this.manualStart.hidden = this.manualMode; }
		for (const button of Array.from(this.result.querySelectorAll?.("button[data-intake-action]") || [])) (button as HTMLButtonElement).disabled = this.saving || Boolean(this.request);
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
	private beginManual(): void {
		if (this.closed || this.saving || this.request || this.manualMode) return;
		const reference = this.input.value; this.invalidate(); this.manualMode = true; const generation = this.generation;
		this.status.setText("手工登记只保存你填写的内容，不联网、不调用模型，也不表示查询已确认文献身份。");
		const heading = this.result.createEl("h3", { text: "填写未核验人工条目" }), editor = this.result.createDiv();
		editor.createEl("p", { text: "标题必填，其余可留空。标识或链接仅作为待核对线索保存；不会自动下载、关联同名文献或生成笔记。" });
		const fields = {} as Record<keyof ManualPaperInput, HTMLInputElement | HTMLTextAreaElement>;
		for (const [key, label, max, multiline] of [["title", "文献标题（必填）", 2000, false], ["authors", "作者（每行一位，可留空）", 21000, true], ["year", "年份（四位数字，可留空）", 4, false], ["reference", "待核对标识或线索（可留空）", 1024, false], ["notes", "个人备注（可留空）", 4000, true]] as const) {
			const row = editor.createEl("label", { text: label, cls: "rar-manual-field" });
			fields[key] = multiline ? row.createEl("textarea", { attr: { "aria-label": label, maxlength: String(max) } }) : row.createEl("input", { type: "text", attr: { "aria-label": label, maxlength: String(max) } });
		}
		fields.reference.value = reference;
		const previewButton = this.result.createEl("button", { text: "预览手工条目", cls: "mod-cta" }), back = this.result.createEl("button", { text: "返回查询", attr: { "data-intake-action": "back" } });
		const previewBox = this.result.createDiv(); let preview: ManualMetadataPreview | undefined;
		const fresh = () => !this.closed && generation === this.generation && this.manualMode;
		const reset = () => { preview = undefined; previewBox.empty(); previewButton.disabled = !fields.title.value.trim(); };
		for (const field of Object.values(fields)) field.oninput = reset;
		reset();
		back.onclick = () => { if (this.saving || this.request) return; this.invalidate(); this.status.setText(""); this.validate(); };
		previewButton.onclick = () => {
			if (!fresh() || this.saving || previewButton.disabled) return;
			previewBox.empty();
			try {
				preview = this.service.prepareManual(Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el.value])) as unknown as ManualPaperInput);
				const selected = preview; previewBox.createEl("h3", { text: selected.title }); renderManualBibliography(previewBox, selected.manualBibliography);
				editor.hidden = previewButton.hidden = true; heading.setText("预览未核验人工条目");
				this.status.setText("请核对手工内容。保存后仍为未核验，同名或相同线索的另一次登记不会自动合并。");
				const edit = previewBox.createEl("button", { text: "返回修改" }); edit.onclick = () => {
					if (!fresh() || this.saving || this.saved) return; editor.hidden = previewButton.hidden = false; heading.setText("填写未核验人工条目"); reset(); fields.title.focus();
				};
				const save = previewBox.createEl("button", { text: "保存未核验人工条目", cls: "mod-cta" });
				save.onclick = async () => {
					if (!fresh() || this.saving || this.saved || preview !== selected) return;
					const controller = new AbortController(); this.request = controller; this.saving = true; edit.disabled = save.disabled = previewButton.disabled = true;
					for (const field of Object.values(fields)) field.disabled = true; this.validateButtons(); this.status.setText("正在保存人工条目…");
					try {
						const saved = await this.service.saveManual(selected, controller.signal); if (!fresh()) return; this.saved = saved;
						this.status.setText("人工条目已保存，仍未核验。可在文献库中查看，并在取得有效标识后重新查询书目。"); save.setText("已保存（未核验）");
						const open = previewBox.createEl("button", { text: "在文献库中查看", attr: { "data-intake-action": "library" } }); open.onclick = () => { void this.runAction(undefined, () => this.openPaper(saved.paperId)); };
					} catch (error) { if (fresh()) { this.status.setText("保存未完成：" + String(error) + "。当前输入保留，可重试。"); save.disabled = false; } }
					finally { this.saving = false; this.request = undefined; if (fresh()) { for (const field of Object.values(fields)) field.disabled = !!this.saved; edit.disabled = previewButton.disabled = !!this.saved; this.validateButtons(); } }
				};
				this.contentEl.scrollTop = 0;
			} catch (error) { preview = undefined; this.status.setText(error instanceof Error ? error.message : String(error)); }
		};
		this.validateButtons();
	}
	private renderPreview(): void {
		this.result.empty(); const preview = this.preview; if (!preview) return;
		this.result.createEl("h3", { text: preview.identity.title });
		this.result.createEl("p", { text: Object.entries(preview.identity.identifiers).map(([key, value]) => `${key.toUpperCase()}：${value}`).join(" · ") });
		renderBibliography(this.result, preview.identity);
		for (const warning of preview.warnings) this.result.createEl("p", { text: warning, cls: "rar-library-warning" });
		if (this.actions && preview.sources.length) {
			const sources = this.result.createEl("section"); sources.createEl("h3", { text: "已有原文" });
			for (const source of preview.sources) {
				const row = sources.createDiv(); row.createEl("p", { text: source.label });
				const button = row.createEl("button", { text: "打开此原文", attr: { "data-intake-action": "source", "data-package-key": source.packageKey } });
				button.onclick = () => { void this.runAction(preview, async signal => this.actions!.source(await this.service.source(preview, source.packageKey, signal), signal)); };
			}
		}
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
			const open = this.result.createEl("button", { text: "在文献库中查看", attr: { "data-intake-action": "library" } });
			open.onclick = () => { void this.runAction(preview, () => this.openPaper(saved.paperId)); };
			if (this.actions) {
				this.result.createEl("p", { text: "书目信息已保存。可选择下一步；取消后续操作不会撤回这条文献记录。" });
				for (const [label, action] of [["查找这篇文献的全文", this.actions.fulltext], ["为这篇文献添加本地 PDF", this.actions.local]] as const) {
					const next = this.result.createEl("button", { text: label, attr: { "data-intake-action": "continue" } });
					next.onclick = () => { void this.runAction(preview, async signal => { const context = await this.service.context(preview, signal, saved.paperId); signal.throwIfAborted(); if (!this.closed) await action(context); }); };
				}
			}
		} catch (error) { if (!this.closed) { this.status.setText("保存未完成：" + (error instanceof Error ? error.message : String(error)) + "。可重试，已提交的记录会复用。"); button.disabled = false; } }
		finally { this.saving = false; this.request = undefined; if (!this.closed) this.validateButtons(); }
	}
	private async runAction(preview: MetadataPreview | undefined, work: (signal: AbortSignal) => void | Promise<void>): Promise<void> {
		if (this.closed || this.saving || this.request || preview && preview !== this.preview) return;
		const generation = this.generation, controller = new AbortController(); this.request = controller; this.saving = true; this.validateButtons();
		this.status.setText("正在核对并打开下一步…");
		try { await work(controller.signal); if (!this.closed && generation === this.generation && !controller.signal.aborted) this.close(); }
		catch (error) { if (!this.closed && generation === this.generation) this.status.setText("未能继续：" + String(error) + (this.saved ? "。书目信息已保留，可重试。" : "")); }
		finally { if (!this.closed && generation === this.generation) { this.saving = false; this.request = undefined; this.validateButtons(); } }
	}
}
