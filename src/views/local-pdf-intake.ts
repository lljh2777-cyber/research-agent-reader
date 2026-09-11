import { Modal, type App } from "obsidian";
import * as path from "node:path";
import { parseAcquisitionInput } from "../fulltext/contracts";
import type { LocalPdfIntakeService } from "../papers/local-pdf-intake";
import type { SourceSavePlan } from "../papers/source-intake";
import { pdfSourceVersionLabel, type LocalPdfSnapshot } from "../sources/pdf-snapshot";
import { chooseSystemSource } from "../reading/source-picker";
import { renderBibliography } from "./bibliography";

export class LocalPdfIntakeModal extends Modal {
	private closed = false;
	private generation = 0;
	private request?: AbortController;
	private busy = false;
	private saving = false;
	private plan?: SourceSavePlan;
	private digest = "";
	private file!: HTMLInputElement;
	private identifier!: HTMLInputElement;
	private version!: HTMLSelectElement;
	private choose!: HTMLButtonElement;
	private query!: HTMLButtonElement;
	private cancel!: HTMLButtonElement;
	private status!: HTMLElement;
	private result!: HTMLElement;
	private records!: HTMLElement;
	constructor(app: App, private readonly service: LocalPdfIntakeService, private readonly vaultRoot: string,
		private readonly openPaper: (paperId: string) => Promise<void>,
		private readonly picker = (current: string) => chooseSystemSource("pdf", false, current, vaultRoot)) { super(app); }
	onOpen(): void {
		this.closed = false; this.contentEl.empty(); this.contentEl.addClass("rar-local-pdf-intake");
		this.contentEl.createEl("h2", { text: "添加本地 PDF" });
		this.contentEl.createEl("p", { text: "查询书目信息并核对原文后保存。PDF 在本机读取，不上传；文献标识会发送至 Europe PMC / Crossref。无需模型。" });
		const files = this.contentEl.createDiv("rar-local-pdf-fields");
		files.createEl("label", { text: "本地 PDF（最多 64 MiB）" });
		this.file = files.createEl("input", { type: "text", placeholder: "选择文件，或输入 PDF 绝对路径", attr: { "aria-label": "本地 PDF 路径", maxlength: "4096" } });
		this.choose = files.createEl("button", { text: "选择 PDF 文件" });
		this.choose.onclick = () => { void this.run(async () => { const selected = await this.picker(this.file.value); if (!this.closed && selected) this.file.value = selected; }, "正在选择文件…"); };
		files.createEl("label", { text: "文献标识" });
		this.identifier = files.createEl("input", { type: "text", placeholder: "DOI、PMID、PMCID 或支持的论文链接", attr: { "aria-label": "本地 PDF 文献标识", maxlength: "1024" } });
		files.createEl("label", { text: "版本声明" });
		this.version = files.createEl("select", { attr: { "aria-label": "本地 PDF 版本声明" } });
		for (const [value, text] of [["unknown", "版本未核验（默认）"], ["version_of_record", "我确认这是出版版本"], ["accepted_manuscript", "我确认这是作者接受稿"]]) this.version.createEl("option", { value, text });
		this.file.oninput = this.identifier.oninput = this.version.onchange = () => { this.reset(); this.status.setText(""); this.controls(); };
		const actions = this.contentEl.createDiv("rar-library-actions");
		this.query = actions.createEl("button", { text: "查询并核对 PDF" });
		this.query.onclick = () => { if (!this.query.disabled) void this.run(async signal => {
			const plan = await this.service.prepare(this.file.value.trim(), this.identifier.value, this.version.value as LocalPdfSnapshot["version"], signal);
			await this.preview(plan, signal);
		}, "正在查询书目信息并检查 PDF…"); };
		this.cancel = actions.createEl("button", { text: "取消核对" });
		this.cancel.onclick = () => { this.reset(); this.status.setText("核对已取消，尚未保存"); this.controls(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.result = this.contentEl.createDiv();
		const history = this.contentEl.createEl("details"); history.createEl("summary", { text: "本地 PDF 添加记录与恢复" });
		history.createEl("p", { text: "点击保存后才保留记录。未完成的添加可继续；文件移动后可重新选择相同内容。记录仅限当前设备，完成状态代表当时登记成功，继续时会重新校验。" });
		this.records = history.createDiv(); this.controls(); void this.history();
	}
	onClose(): void { this.closed = true; this.reset(); this.contentEl.empty(); }
	private reset(): void {
		this.generation++; this.request?.abort(); this.request = undefined;
		if (this.plan) this.service.cancel(this.plan.requestId);
		this.plan = undefined; this.digest = ""; this.result?.empty(); this.busy = false;
	}
	private controls(): void {
		let valid = false; try { parseAcquisitionInput(this.identifier.value); valid = path.isAbsolute(this.file.value.trim()) && /\.pdf$/i.test(this.file.value.trim()); } catch { /* Wait for a valid selection and identifier. */ }
		for (const input of [this.file, this.identifier, this.version, this.choose]) input.disabled = this.busy || this.saving;
		this.query.disabled = !valid || this.busy || this.saving;
		this.cancel.hidden = !this.busy || this.saving;
		for (const button of Array.from(this.records.querySelectorAll("button"))) button.disabled = this.busy || this.saving || button.dataset.unavailable === "true";
	}
	private async run(work: (signal: AbortSignal) => Promise<void>, status: string): Promise<void> {
		if (this.busy || this.saving || this.closed) return;
		this.reset(); const generation = this.generation, controller = new AbortController(); this.request = controller; this.busy = true; this.controls(); this.status.setText(status);
		try { await work(controller.signal); if (!this.closed && generation === this.generation && !this.plan) this.status.setText(""); }
		catch (error) { if (!this.closed && generation === this.generation) this.status.setText(error instanceof Error ? error.message : String(error)); }
		finally { if (!this.closed && generation === this.generation) { this.busy = false; this.request = undefined; this.controls(); } }
	}
	private async preview(plan: SourceSavePlan, signal: AbortSignal): Promise<void> {
		if (this.closed || signal.aborted) { this.service.cancel(plan.requestId); return; }
		this.plan = plan; this.result.empty(); this.result.createEl("h3", { text: plan.snapshot.identity.title });
		this.result.createEl("p", { text: Object.entries(plan.snapshot.identity.identifiers).map(([k, v]) => `${k.toUpperCase()}：${v}`).join(" · ") });
		renderBibliography(this.result, plan.snapshot.identity);
		this.result.createEl("p", { text: pdfSourceVersionLabel(plan.snapshot) + " · 仅保存 PDF 原文，不生成 Wiki 或标记已读" });
		for (const warning of plan.warnings) this.result.createEl("p", { text: warning, cls: "rar-library-warning" });
		if (plan.existing) {
			this.status.setText("找到相同内容和版本的本地 PDF 包，确认后复用并补齐登记。"); this.saveButton(true); return;
		}
		this.result.createEl("p", { text: plan.recovering ? "恢复上次保存时核对的页面，请再次确认。" : "请核对下方页面中的标题、作者和 DOI 与上方书目信息一致。自动检查不代表已完成全文阅读。" });
		const pageControls = this.result.createDiv("rar-library-actions"), page = pageControls.createEl("input", { type: "number", attr: { min: "1", max: String(plan.snapshot.validation.pageCount), "aria-label": "身份核对页码" } }); page.value = "1";
		const show = pageControls.createEl("button", { text: "显示此页" }); page.disabled = show.disabled = plan.recovering;
		const image = this.result.createEl("img", { cls: "rar-local-pdf-page", attr: { alt: "用于核对论文身份的 PDF 页面" } });
		const save = this.saveButton(false); save.disabled = true;
		let rendering = 0;
		const display = async () => {
			const current = ++rendering; this.digest = ""; save.disabled = true; show.disabled = true;
			try {
				const n = Number(page.value); if (!Number.isInteger(n) || n < 1 || n > plan.snapshot.validation.pageCount) throw new Error("页码超出 PDF 范围");
				const shown = await this.service.present(plan.requestId, n);
				if (this.closed || signal.aborted || this.plan !== plan || current !== rendering) return;
				image.src = shown.dataUrl; await image.decode();
				if (this.closed || signal.aborted || this.plan !== plan || current !== rendering) return;
				this.digest = shown.digest; save.disabled = false; this.status.setText("页面已显示，核对一致后可保存原文。");
			} catch (error) { if (!this.closed && this.plan === plan) this.status.setText("页面显示失败：" + String(error)); }
			finally { if (!this.closed && this.plan === plan && current === rendering) show.disabled = plan.recovering; }
		};
		page.oninput = () => { rendering++; this.digest = ""; save.disabled = true; show.disabled = plan.recovering; };
		show.onclick = () => { if (!this.saving) void display(); }; await display();
	}
	private saveButton(existing: boolean): HTMLButtonElement {
		const button = this.result.createEl("button", { text: existing ? "确认复用并登记原文" : "身份一致，保存 PDF 原文", cls: "mod-cta" });
		button.onclick = () => { if (!button.disabled && this.plan && !this.saving && !this.busy) void this.commit(this.plan, button); }; return button;
	}
	private async commit(plan: SourceSavePlan, button: HTMLButtonElement): Promise<void> {
		this.saving = true; button.disabled = true; this.controls();
		for (const control of Array.from(this.result.querySelectorAll("input, button"))) (control as HTMLInputElement).disabled = true;
		this.status.setText("正在保存原文并登记…");
		try {
			const saved = await this.service.save(plan.requestId, this.digest);
			if (this.closed) return;
			if (saved.phase !== "saved") {
				this.status.setText((saved.phase === "registration_pending" ? "PDF 原文已保存，登记未完成：" : "保存未完成：") + (saved.error || "操作中断") + "。可重试或从下方添加记录继续。");
				button.disabled = false; return;
			}
			this.status.setText("PDF 原文已保存并登记，未标记为已读。"); button.setText("已保存");
			const open = this.result.createEl("button", { text: "在文献库中查看" });
			open.onclick = () => { open.disabled = true; void this.openPaper(saved.paperId).then(() => this.close()).catch(error => { if (!this.closed) { this.status.setText("已保存，打开失败：" + String(error)); open.disabled = false; } }); };
		} catch (error) { if (!this.closed) { this.status.setText("保存未完成：" + String(error) + "。可重试或从下方添加记录继续。"); button.disabled = false; } }
		finally { this.saving = false; if (!this.closed) { this.controls(); await this.history(); } }
	}
	private async history(): Promise<void> {
		try {
			const records = await this.service.history(); if (this.closed) return;
			this.records.empty(); if (!records.length) this.records.createEl("p", { text: "尚无本地 PDF 添加记录。" });
			for (const record of records) {
				const row = this.records.createDiv("rar-local-pdf-record");
				row.createEl("p", { text: `${record.state === "saved" ? "已完成登记" : record.state === "pending" ? "待继续" : "无法恢复"} · ${record.title}` });
				row.createEl("p", { text: record.error || `${record.fileName} · ${record.createdAt}` });
				if (record.state === "unavailable") continue;
				const actions = row.createDiv("rar-library-actions");
				for (const reselect of [false, true]) {
					const button = actions.createEl("button", { text: reselect ? "重新选择相同 PDF" : "继续核对与登记" });
					button.onclick = () => { void this.run(async signal => {
						const selected = reselect ? await this.picker("") : undefined; if (signal.aborted || reselect && !selected) return;
						const plan = await this.service.resume(record.id, signal, selected); await this.preview(plan, signal);
					}, "正在恢复并核验原文件…"); };
				}
			} this.controls();
		} catch (error) { if (!this.closed) this.records.setText("添加记录读取失败：" + String(error)); }
	}
}
