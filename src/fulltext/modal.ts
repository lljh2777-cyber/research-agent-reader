import { Modal, Notice, type App } from "obsidian";
import { acquisitionActive, acquisitionRetryable, parseAcquisitionInput, PHASE_LABELS, type DemoScenario } from "./contracts";
import type { AcquisitionService } from "./service";

export class FulltextAcquisitionModal extends Modal {
	private unsubscribe?: () => void;
	private jobsEl?: HTMLElement;
	private closed = false;
	private busy = false;
	constructor(app: App, readonly service: AcquisitionService, private selectedId?: string, private afterClose?: () => void) { super(app); }
	onOpen(): void {
		this.closed = false; this.modalEl.addClass("rar-fulltext-modal");
		this.setTitle(this.service.mode === "demo" ? "全文获取 · 流程演示" : "获取论文全文");
		const intro = this.service.mode === "demo" ? "开发演示使用虚构论文和模拟进度。仅保存演示记录，不下载文件、不调用模型，也不写入文献库。" : "输入论文标识或官方链接，先识别论文，再获取可用全文。此功能不需要模型配置。";
		this.contentEl.createEl("p", { text: intro, cls: "rar-fulltext-intro" });
		const label = this.contentEl.createEl("label", { text: "DOI、PMID 或 PMCID", cls: "rar-fulltext-input-label" });
		const input = label.createEl("input", { type: "text", attr: { placeholder: "10.xxxx/…、PMID:… 或 PMC…", "aria-label": "论文标识", maxlength: "1024" } });
		if (this.service.mode === "demo") input.value = "10.0000/fulltext-demo";
		const parsedEl = this.contentEl.createEl("p", { cls: "rar-fulltext-parsed", attr: { "aria-live": "polite" } });
		let scenario: DemoScenario = "success";
		if (this.service.mode === "demo") {
			const selectLabel = this.contentEl.createEl("label", { text: "演示场景", cls: "rar-fulltext-input-label" });
			const select = selectLabel.createEl("select", { attr: { "aria-label": "演示场景" } });
			for (const [value, text] of [["success", "顺利完成"], ["selection", "选择候选来源"], ["failure", "来源失败"], ["conflict", "论文身份冲突"], ["no_match", "无匹配全文"]]) select.createEl("option", { value, text });
			select.addEventListener("change", () => { scenario = select.value as DemoScenario; });
		} else this.contentEl.createEl("p", { text: "真实全文来源尚未接入。当前版本可识别输入；下载将在后续版本开放。", cls: "rar-fulltext-unavailable" });
		const start = this.contentEl.createEl("button", { text: this.service.mode === "demo" ? "开始演示" : "获取全文（尚未开放）", cls: "mod-cta", attr: { "data-fulltext-action": "start" } });
		const validate = () => {
			try { const parsed = parseAcquisitionInput(input.value); parsedEl.setText(`${parsed.kind.toUpperCase()} · ${parsed.value}`); start.disabled = this.busy || !this.service.available; }
			catch { parsedEl.setText(input.value.trim() ? "请输入有效 DOI、PMID、PMCID 或官方论文链接" : "支持 DOI、PubMed 和 PMC 官方论文链接"); start.disabled = true; }
		};
		input.addEventListener("input", validate); validate();
		start.addEventListener("click", () => {
			if (this.busy || start.disabled) return; this.busy = true; validate();
			void this.service.start({ input: parseAcquisitionInput(input.value), goal: "pdf", versionPolicy: "record_only", ...(this.service.mode === "demo" ? { scenario } : {}) }).then(job => { this.selectedId = job.id; this.renderJobs(); }).catch(() => new Notice("无法创建获取任务，请检查插件存储目录")).finally(() => { this.busy = false; if (!this.closed) validate(); });
		});
		this.jobsEl = this.contentEl.createDiv("rar-fulltext-jobs"); this.jobsEl.setText("正在读取获取记录…");
		this.unsubscribe = this.service.subscribe(() => this.renderJobs());
		void this.service.ready().then(() => this.renderJobs()).catch(() => { if (!this.closed) this.jobsEl?.setText("获取记录读取失败，请检查插件存储目录后重新打开插件"); start.disabled = true; });
	}
	private renderJobs(): void {
		if (this.closed || !this.jobsEl) return;
		const focus = this.jobsEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.fulltextKey : undefined;
		this.jobsEl.empty();
		for (const error of this.service.diagnostics) this.jobsEl.createEl("p", { text: error, cls: "rar-fulltext-error" });
		const jobs = this.service.list();
		this.jobsEl.createEl("h3", { text: this.service.mode === "demo" ? "演示记录" : "获取记录" });
		if (!jobs.length) this.jobsEl.createEl("p", { text: "暂无获取记录", cls: "rar-fulltext-muted" });
		for (const job of jobs.slice(0, 50)) {
			const card = this.jobsEl.createDiv({ cls: "rar-fulltext-job", attr: { "data-job-id": job.id, "data-phase": job.phase } });
			if (job.id === this.selectedId) card.addClass("is-selected");
			card.createEl("strong", { text: job.request.input.value });
			card.createEl("span", { text: job.phase === "acquired" && job.mode === "demo" ? "演示完成" : PHASE_LABELS[job.phase], cls: "rar-fulltext-phase" });
			card.createEl("p", { text: job.detail });
			if (job.receivedBytes !== undefined) {
				const progress = card.createEl("progress", { attr: { "aria-label": "模拟获取进度" } }); progress.max = job.totalBytes || Math.max(1, job.receivedBytes); progress.value = job.receivedBytes;
				card.createEl("small", { text: `${job.receivedBytes} / ${job.totalBytes ?? "未知"} 字节（模拟）` });
			}
			if (job.error) card.createEl("p", { text: job.error, cls: "rar-fulltext-error" });
			if (job.storageWarning) card.createEl("p", { text: job.storageWarning, cls: "rar-fulltext-error", attr: { role: "alert" } });
			if (!this.service.owned(job)) { card.createEl("p", { text: "其他设备的记录，仅供查看", cls: "rar-fulltext-muted" }); continue; }
			const button = (text: string, key: string, work: () => void | Promise<void>) => {
				const el = card.createEl("button", { text, attr: { "data-fulltext-action": key, "data-fulltext-key": job.id + ":" + key } });
				el.addEventListener("click", () => { el.disabled = true; void Promise.resolve().then(work).catch(() => new Notice("操作未完成，请检查任务状态")).finally(() => { el.disabled = false; }); });
			};
			if (job.phase === "awaiting_selection") for (const candidate of job.candidates) button("选择 " + candidate.title, candidate.id, () => this.service.choose(job.id, candidate.id));
			if (acquisitionActive(job.phase)) button("停止", "stop", () => { if (!this.service.stop(job.id)) new Notice("结果正在保存，稍后可查看完成状态"); });
			if (acquisitionRetryable(job.phase)) button("重试", "retry", () => this.service.retry(job.id));
		}
		if (jobs.length > 50) this.jobsEl.createEl("p", { text: "显示最近 50 条记录，完整记录仍保存在插件目录。" });
		if (focus) [...this.jobsEl.querySelectorAll<HTMLElement>("[data-fulltext-key]")].find(el => el.dataset.fulltextKey === focus)?.focus({ preventScroll: true });
	}
	onClose(): void { this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined; this.contentEl.empty(); this.afterClose?.(); }
}
