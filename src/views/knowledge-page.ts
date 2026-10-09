import { App, Modal } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { PAGE_FOLDERS, pagePath, type PagePlan, type PageRecord } from "../curation/page";
import type { DraftRevision } from "../curation/draft-store";

export class KnowledgePageModal extends Modal {
	private closed = true; private action?: AbortController; private preview?: PagePlan; private record?: PageRecord; private draft?: DraftRevision;
	private status!: HTMLElement; private area!: HTMLElement; private result!: HTMLElement;
	constructor(app: App, private plugin: AgentDashboardPlugin, private id: string) { super(app); }
	onOpen(): void {
		this.closed = false; this.setTitle("从草稿创建知识页"); this.modalEl.addClass("curation-modal", "rar-knowledge-page");
		this.contentEl.createEl("p", { text: "选择文件名，预览页面、索引和日志后再确认。每份草稿只创建一页；后续草稿编辑不会同步覆盖页面。正文与材料按待审阅内容保存，不作为论文证据。" });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } }); this.area = this.contentEl.createDiv();
		const footer = this.contentEl.createDiv("rar-excerpt-actions");
		this.button(footer, "重新读取建页记录", () => void this.run(signal => this.load(signal)));
		const cancel = this.button(footer, "取消当前操作", () => this.action?.abort()); cancel.dataset.busy = "cancel";
		const close = this.button(footer, "关闭", () => this.close()); close.dataset.busy = "allow";
		void this.run(signal => this.load(signal));
	}
	onClose(): void { this.closed = true; this.action?.abort(); this.contentEl.empty(); }
	private button(el: HTMLElement, text: string, run: () => void): HTMLButtonElement { const b = el.createEl("button", { text, attr: { type: "button" } }); b.onclick = () => { try { run(); } catch (error) { this.status.setText(String(error)); } }; return b; }
	private controls(): void { for (const el of this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) el.disabled = el.dataset.busy === "allow" ? false : el.dataset.busy === "cancel" ? !this.action : !!this.action; }
	private async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.closed || this.action) return; const action = this.action = new AbortController(); this.controls(); this.status.setText("正在核对草稿与建页记录…");
		try { await work(action.signal); } catch (error) { if (!this.closed) this.status.setText(action.signal.aborted ? "操作已取消。已写入内容保留，请重新读取建页记录后核对。" : String(error) + "；如曾确认保存，可重新读取建页记录查看是否需要恢复。"); }
		finally { if (this.action === action) { this.action = undefined; if (!this.closed) this.controls(); } }
	}
	private async load(signal: AbortSignal): Promise<void> {
		const pages = this.plugin.getKnowledgePages(), record = await pages.record(this.id, signal), history = await this.plugin.getKnowledgeDrafts().read(this.id, signal); signal.throwIfAborted();
		this.record = record || undefined; this.draft = history.current; this.preview = undefined; this.area.empty();
		if (record) {
			this.area.createEl("p", { text: (record.complete ? "已完成创建：" : "建页尚未完成：") + record.plan.path });
			this.area.createEl("p", { text: "创建依据是记录中的固定草稿版本。原页面和索引若有后续编辑，恢复会停止；不会回写新草稿。" });
			if (record.complete) this.button(this.area, "打开已创建页面", () => this.plugin.openVaultFile(record.plan.path));
			this.result = this.area.createDiv(); this.show(record.plan, !record.complete);
			this.status.setText(record.complete ? "创建已完成。下方是当时确认的内容，当前页面可能已有后续编辑。" : "请核对已保存计划，再确认继续未完成写入。");
		} else {
			if (!history.current || history.pending.length || history.issues.length) throw new Error("请先保存并核对草稿，处理未完成保存或冲突");
			this.area.createEl("p", { text: "草稿：" + history.current.draft.title });
			this.area.createEl("p", { text: "目标目录：" + PAGE_FOLDERS[history.current.draft.kind] });
			let suggested = history.current.draft.id + ".md"; try { suggested = pagePath(history.current.draft).split("/").pop()!; } catch { /* Invalid title-derived names remain editable. */ }
			const filename = this.area.createEl("input", { type: "text", value: suggested, attr: { "aria-label": "新知识页文件名", maxlength: "103" } });
			filename.oninput = () => { this.preview = undefined; this.result.empty(); this.status.setText("文件名已修改，请重新预览。"); };
			this.button(this.area, "查重并预览创建", () => void this.run(async s => { this.preview = undefined; this.result.empty(); const plan = await pages.preview(this.id, this.draft!.digest, filename.value, s); s.throwIfAborted(); this.preview = plan; this.show(plan, true); this.status.setText("请逐项查看页面、索引和日志内容，再确认创建。尚未写入文件。"); }));
			this.result = this.area.createDiv(); this.status.setText("已读取保存草稿；当前步骤尚未创建文件。");
		}
		this.controls();
	}
	private show(plan: PagePlan, confirm: boolean): void {
		this.result.empty();
		this.result.createEl("p", { text: plan.directories.length ? "将创建目录：" + plan.directories.join("、") : "使用已有目录。" });
		this.result.createEl("p", { text: "附带材料保留草稿中的历史快照；创建页面不核验当前原文。正文以原样文本块保存，Markdown、HTML 和链接不执行，本插件不将这些块纳入正式证据检索。" });
		for (const write of plan.writes) {
			const section = this.result.createEl("details"); section.open = write.role === "page";
			section.createEl("summary", { text: ({ page: "新建页面", index: "索引", log: "日志" })[write.role] + " · " + write.path });
			if (write.before !== null) { section.createEl("p", { text: "修改前" }); section.createEl("pre", { cls: "curation-text", text: write.before }); }
			section.createEl("p", { text: write.before === null ? "将新建" : "修改后" }); section.createEl("pre", { cls: "curation-text", text: write.after });
		}
		if (confirm) this.button(this.result, this.record ? "确认继续建页" : "确认创建知识页", () => void this.run(async signal => {
			if (!this.record && this.preview !== plan) throw new Error("预览已变化，请重新核对");
			await this.plugin.getKnowledgePages().apply(plan, signal); signal.throwIfAborted(); await this.load(signal);
		})).addClass("mod-cta");
	}
}
