import { Modal, type App } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import type { AnswerExcerptFile } from "../learning/answer-excerpts";
import { ANSWER_CONTENT_ROLES, answerCurationTarget, answerRoleText, prepareAnswerExcerptCuration, validateAnswerExcerptContext, type AnswerContentRole } from "../curation/answer-excerpt";
import { curationParagraphs } from "../curation/policy";
import type { CurationReview, CurationRevision } from "../curation/types";
import { curationChangeWindow } from "./knowledge-curation";

/** Explicit role selection -> durable review -> existing guarded writer. No generation. */
export class AnswerExcerptCurationModal extends Modal {
	private closed = true; private action?: AbortController; private snapshot?: AnswerExcerptFile;
	private roles = new Set<AnswerContentRole>(); private review?: CurationReview; private preview?: CurationRevision;
	private status!: HTMLElement; private body!: HTMLElement; private result!: HTMLElement;
	constructor(app: App, private plugin: AgentDashboardPlugin, private path: string, private initial?: CurationReview) { super(app); }
	onOpen(): void {
		this.closed = false; this.setTitle("将学习摘录补充到已有笔记"); this.modalEl.addClass("curation-modal", "rar-excerpt-curation");
		this.contentEl.createEl("p", { text: "选择内容角色、已有笔记和插入位置。保存为学习背景与个人理解，排除正式证据检索；不调用模型，不自动标记整理完成。" });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } }); this.body = this.contentEl.createDiv(); this.result = this.contentEl.createDiv();
		const footer = this.contentEl.createDiv("rar-excerpt-actions");
		this.button(footer, "查看整理与修订记录", () => { this.close(); this.plugin.openKnowledgeMaintenance({ tab: "activity" }); });
		const cancel = this.button(footer, "取消当前操作", () => this.action?.abort()); cancel.dataset.cancelOperation = "true";
		const close = this.button(footer, "关闭", () => this.close()); close.dataset.allowBusy = "true";
		void this.run(async signal => {
			if (this.initial) { validateAnswerExcerptContext(this.initial.context); this.review = structuredClone(this.initial); this.snapshot = this.review.context.answerExcerpt!.snapshot; }
			else this.snapshot = await this.plugin.getAnswerExcerpts().load(this.path, signal);
			signal.throwIfAborted(); this.render();
		});
	}
	onClose(): void { this.closed = true; this.action?.abort(); this.contentEl.empty(); }
	private button(root: HTMLElement, text: string, run: () => void): HTMLButtonElement { const b = root.createEl("button", { text, attr: { type: "button" } }); b.onclick = run; return b; }
	private controls(): void {
		this.contentEl.setAttribute("aria-busy", String(!!this.action));
		for (const c of Array.from(this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button,input,select"))) c.disabled = c.dataset.cancelOperation === "true" ? !this.action : !!this.action && c.dataset.allowBusy !== "true";
	}
	private async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.closed || this.action) return; const action = this.action = new AbortController(); this.controls();
		try { await work(action.signal); } catch (error) { if (!this.closed) this.status.setText(action.signal.aborted ? "操作已取消。确认写入后中断可从修订记录核对或恢复。" : String(error)); }
		finally { if (!this.closed && this.action === action) { this.action = undefined; this.controls(); } }
	}
	private resetPreview(): void { this.preview = undefined; this.result.empty(); }
	private render(): void {
		const file = this.snapshot!; this.body.empty();
		this.body.createEl("p", { text: file.record.answer.title + " · " + file.record.answer.context.location });
		this.body.createEl("p", { text: "只核对已保存回答与摘录版本，未核验原始 PDF、代码或科学主张。" });
		for (const role of Object.keys(ANSWER_CONTENT_ROLES) as AnswerContentRole[]) {
			const text = answerRoleText(file, role); if (!text.trim()) continue;
			const row = this.body.createEl("details"); row.createEl("summary", { text: ANSWER_CONTENT_ROLES[role] }); row.createEl("pre", { text, cls: "curation-text" });
			if (!this.initial) { const label = this.body.createEl("label"), check = label.createEl("input", { type: "checkbox", attr: { "aria-label": "补充" + ANSWER_CONTENT_ROLES[role] } }); label.appendText("补充" + ANSWER_CONTENT_ROLES[role] + "（默认不选）"); check.onchange = () => { if (check.checked) this.roles.add(role); else this.roles.delete(role); this.resetPreview(); }; }
		}
		let target: HTMLSelectElement, paragraph: HTMLSelectElement;
		if (this.initial) {
			this.body.createEl("p", { text: "已保存批次：" + this.initial.id + " · " + this.initial.context.target.path });
			this.body.createEl("p", { text: "本批选择：" + this.initial.context.answerExcerpt!.roles.map(role => ANSWER_CONTENT_ROLES[role]).join("、") });
			const revisions = [...this.plugin.getCurationService().revisions.values()].filter(r => r.reviewId === this.initial!.id);
			if (revisions.length) { this.status.setText("本批已有修订，请从历史核对、恢复或预览撤销。"); this.button(this.body, "查看本批修订", () => { this.close(); this.plugin.openKnowledgeMaintenance({ tab: "history", revisionId: revisions[0].id }); }); return; }
			if (this.initial.state !== "ready") { this.status.setText("该批次需重新核对：" + this.initial.error); this.button(this.body, "返回当前学习摘录", () => { this.close(); this.plugin.openAnswerExcerptBrowser(this.path); }); return; }
		} else {
			const filter = this.body.createEl("input", { type: "search", attr: { "aria-label": "搜索学习整理目标", placeholder: "按完整路径搜索笔记" } });
			target = this.body.createEl("select", { attr: { "aria-label": "学习整理目标笔记" } });
			const targets = () => { const previous = target.value; target.empty(); target.createEl("option", { value: "", text: "选择已有概念、方法或综合笔记" });
				for (const f of this.app.vault.getMarkdownFiles().filter(f => answerCurationTarget(f.path) && (f.path === previous || f.path.toLowerCase().includes(filter.value.toLowerCase()))).sort((a, b) => a.path.localeCompare(b.path))) target.createEl("option", { value: f.path, text: f.path }); target.value = previous; };
			targets(); filter.oninput = targets;
			paragraph = this.body.createEl("select", { attr: { "aria-label": "学习整理插入位置" } }); paragraph.createEl("option", { value: "", text: "先选择目标笔记" });
			const current = this.body.createEl("pre", { cls: "curation-text" });
			target.onchange = () => { this.resetPreview(); void this.run(async signal => {
				paragraph.empty(); current.empty(); paragraph.createEl("option", { value: "", text: "选择在此段后补充" });
				const f = this.app.vault.getFileByPath(target.value); if (!f || f.stat.size > 160000) throw new Error("目标缺失或超过读取上限");
				const text = await this.app.vault.read(f); signal.throwIfAborted(); const paragraphs = curationParagraphs(text);
				for (const p of paragraphs) paragraph.createEl("option", { value: p.id, text: p.heading + " · " + p.text.slice(0, 100) });
				paragraph.onchange = () => { current.setText(paragraphs.find(p => p.id === paragraph.value)?.text || ""); this.resetPreview(); };
				this.status.setText(paragraphs.length ? "请选择插入位置和内容角色后预览。" : "目标没有可补充的正文段落。");
			}); };
		}
		this.button(this.body, "预览所选学习内容", () => void this.run(async signal => {
			this.resetPreview();
			if (!this.initial) {
				const roles = (Object.keys(ANSWER_CONTENT_ROLES) as AnswerContentRole[]).filter(role => this.roles.has(role)); if (!roles.length) throw new Error("请先明确勾选要补充的内容角色");
				const context = await prepareAnswerExcerptCuration(this.app, this.plugin.getAnswerExcerpts(), this.path, target.value, paragraph.value, roles, signal);
				if (context.answerExcerpt!.snapshot.digest !== file.digest) throw new Error("学习摘录已变化，请重新打开核对");
				this.review = await this.plugin.getCurationService().saveAnswerExcerpt(context, signal);
			}
			signal.throwIfAborted(); const preview = await this.plugin.getCurationWriter().preview(this.review!.id, ["s-0"]); signal.throwIfAborted();
			this.preview = preview; this.renderPreview(preview); this.status.setText("预览已保存为整理批次；关闭后可从整理记录返回。尚未改写笔记。");
		}));
		this.status.setText("请选择内容角色；已有批次需重新预览后确认。");
	}
	private renderPreview(preview: CurationRevision): void {
		this.result.empty(); this.result.createEl("h3", { text: "确认前核对文件变化" });
		for (const write of preview.writes) {
			const row = this.result.createEl("details"); row.open = write.role === "target"; row.createEl("summary", { text: write.path }); const window = curationChangeWindow(write.before || "", write.after);
			row.createEl("p", { text: "修改前" }); row.createEl("pre", { text: window.before || "（新增）", cls: "curation-text" }); row.createEl("p", { text: "修改后" }); row.createEl("pre", { text: window.after, cls: "curation-text" });
			for (const [label, text] of [["完整修改前文件", write.before || "（新增）"], ["完整修改后文件", write.after]]) { const full = row.createEl("details"); full.createEl("summary", { text: label }); full.createEl("pre", { text, cls: "curation-text" }); }
		}
		this.button(this.result, "确认补充学习内容", () => void this.run(async signal => {
			if (this.preview !== preview) throw new Error("请重新预览");
			const revision = await this.plugin.getCurationWriter().apply(preview, signal); signal.throwIfAborted(); this.resetPreview(); this.body.empty();
			this.status.setText("学习内容已补充，修订记录已保存；原始摘录和整理状态保留。可在修订记录中预览撤销。");
			this.button(this.result, "打开目标笔记", () => { this.close(); this.plugin.openVaultFile(this.review!.context.target.path); });
			this.button(this.result, "查看本次修订", () => { this.close(); this.plugin.openKnowledgeMaintenance({ tab: "history", revisionId: revision.id }); });
		})).addClass("mod-cta");
	}
}
