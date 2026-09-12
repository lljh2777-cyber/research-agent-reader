import { App, Modal } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { ExcerptLibraryService, type ExcerptRef, type ExcerptSnapshot } from "../annotations/excerpt-library";
import { curationParagraphs, curationTarget } from "../curation/policy";
import { prepareExcerptCuration, validateExcerptContext } from "../curation/excerpt";
import type { CurationReview, CurationRevision } from "../curation/types";
import { curationChangeWindow } from "./knowledge-curation";

/** One saved excerpt -> explicit target/paragraph -> full file preview -> guarded existing writer. */
export class ExcerptCurationModal extends Modal {
	private closed = true; private action?: AbortController; private snapshot?: ExcerptSnapshot;
	private review?: CurationReview; private preview?: CurationRevision; private selected = false; private includeManual = false;
	private status!: HTMLElement; private sourceEl!: HTMLElement; private choices!: HTMLElement; private result!: HTMLElement;
	private target!: HTMLSelectElement; private paragraph!: HTMLSelectElement; private paragraphText!: HTMLElement;
	constructor(app: App, private plugin: AgentDashboardPlugin, private ref: ExcerptRef, private initial?: CurationReview) { super(app); }
	onOpen(): void {
		this.closed = false; this.setTitle("将摘录补充到已有笔记"); this.modalEl.addClass("curation-modal", "rar-excerpt-curation");
		this.contentEl.createEl("p", { text: "选择已有笔记和插入位置，核对原句与可选个人备注。预览不改写笔记，确认后保存修订；不调用模型。" });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.sourceEl = this.contentEl.createDiv(); this.choices = this.contentEl.createDiv("rar-excerpt-curation-choices"); this.result = this.contentEl.createDiv();
		const footer = this.contentEl.createDiv("rar-excerpt-actions");
		this.button(footer, "查看整理与修订记录", () => { this.plugin.openKnowledgeMaintenance({ tab: "activity" }); this.close(); });
		const cancel = this.button(footer, "取消当前操作", () => this.action?.abort()); cancel.dataset.allowBusy = "true"; cancel.dataset.cancelOperation = "true";
		const close = this.button(footer, "关闭", () => this.close()); close.dataset.allowBusy = "true";
		void this.run(async signal => {
			if (this.initial) { validateExcerptContext(this.initial.context); this.review = structuredClone(this.initial); this.snapshot = this.review.context.excerpt!.snapshot; this.includeManual = this.review.context.excerpt!.includeManual; }
			else this.snapshot = await new ExcerptLibraryService(this.app).load(this.ref, signal);
			signal.throwIfAborted(); this.renderSource(); this.renderChoices();
		});
	}
	onClose(): void { this.closed = true; this.action?.abort(); this.contentEl.empty(); }
	private button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement { const b = parent.createEl("button", { text, attr: { type: "button" } }); b.onclick = run; return b; }
	private controls(): void {
		this.contentEl.setAttribute("aria-busy", String(!!this.action));
		for (const control of Array.from(this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button,input,select"))) control.disabled = control.dataset.cancelOperation === "true" ? !this.action : !!this.action && control.dataset.allowBusy !== "true";
	}
	private async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.closed || this.action) return; const action = this.action = new AbortController(); this.controls(); this.status.setText("正在核对记录…");
		try { await work(action.signal); }
		catch (error) { if (!this.closed) this.status.setText(action.signal.aborted ? "已取消。若确认写入后中断，请从修订记录核对或恢复。" : String(error)); }
		finally { if (!this.closed && this.action === action) { this.action = undefined; this.controls(); } }
	}
	private renderSource(): void {
		this.sourceEl.empty(); const r = this.snapshot!.record;
		this.sourceEl.createEl("h3", { text: "所选原句" }); this.sourceEl.createEl("blockquote", { text: r.selectedText }); this.sourceEl.createEl("p", { text: r.sourcePath });
		const context = this.sourceEl.createEl("details"); context.createEl("summary", { text: "保存时的上下文" }); context.createEl("pre", { text: r.excerpt!.context, cls: "curation-text" });
		this.sourceEl.createEl("p", { text: "个人备注（不作为论文证据）" }); this.sourceEl.createEl("pre", { text: r.manualText || "尚无个人备注", cls: "curation-text" });
	}
	private renderChoices(): void {
		this.choices.empty(); const r = this.snapshot!.record;
		if (this.initial) {
			this.choices.createEl("p", { text: "已保存整理批次：" + this.initial.id + " · " + this.initial.context.target.path });
			this.choices.createEl("p", { text: this.includeManual ? "该批次包含原句和当时的个人备注。" : "该批次只包含原句。" });
			if (this.initial.suggestions.some(s => s.decision === "applied")) {
				this.status.setText("本批已有修订记录，请在历史中核对应用或撤销状态。");
				const revision = [...this.plugin.getCurationService().revisions.values()].find(r => r.reviewId === this.initial!.id && !r.undoOf);
				this.button(this.choices, "查看已保存修订", () => { this.plugin.openKnowledgeMaintenance({ tab: "history", ...(revision ? { revisionId: revision.id } : {}) }); this.close(); }); return;
			}
			if (this.initial.state !== "ready") {
				this.status.setText("该批次需要重新核对。" + this.initial.error);
				this.button(this.choices, "回到当前摘录", () => { this.plugin.openExcerptBrowser(this.ref); this.close(); }); return;
			}
		} else {
			const filter = this.choices.createEl("input", { type: "search", attr: { "aria-label": "搜索目标笔记", placeholder: "按完整路径搜索笔记" } });
			this.target = this.choices.createEl("select", { attr: { "aria-label": "摘录目标笔记" } });
			const targets = () => { const selected = this.target.value; this.target.empty(); this.target.createEl("option", { value: "", text: "选择已有笔记" });
				for (const file of this.app.vault.getMarkdownFiles().filter(f => curationTarget(f.path) && (f.path === selected || f.path.toLowerCase().includes(filter.value.toLowerCase()))).sort((a, b) => a.path.localeCompare(b.path))) this.target.createEl("option", { value: file.path, text: file.path }); this.target.value = selected; };
			targets(); filter.oninput = targets;
			this.paragraph = this.choices.createEl("select", { attr: { "aria-label": "摘录插入位置" } }); this.paragraph.createEl("option", { value: "", text: "先选择目标笔记" });
			this.paragraphText = this.choices.createEl("pre", { cls: "curation-text" });
			this.target.onchange = () => { this.resetPreview(); void this.run(async signal => {
				this.paragraph.empty(); this.paragraph.createEl("option", { value: "", text: "选择在此段后补充" }); this.paragraphText.empty();
				const path = this.target.value, file = this.app.vault.getFileByPath(path); if (!file || file.stat?.size > 160000) throw new Error("目标缺失或超过读取上限");
				const text = await this.app.vault.read(file); signal.throwIfAborted(); const paragraphs = curationParagraphs(text);
				for (const p of paragraphs) this.paragraph.createEl("option", { value: p.id, text: p.heading + " · " + p.text.slice(0, 100) });
				this.paragraph.onchange = () => { this.paragraphText.setText(paragraphs.find(p => p.id === this.paragraph.value)?.text || ""); this.resetPreview(); };
				this.status.setText(paragraphs.length ? "请选择插入位置，再勾选要补充的摘录。" : "此笔记没有可补充的正文段落。");
			}); };
			if (r.manualText.trim()) { const label = this.choices.createEl("label"); const check = label.createEl("input", { type: "checkbox", attr: { "aria-label": "同时补充个人备注" } }); label.appendText("同时补充个人备注（默认不选）"); check.onchange = () => { this.includeManual = check.checked; this.resetPreview(); }; }
		}
		const choice = this.choices.createEl("label"); const check = choice.createEl("input", { type: "checkbox", attr: { "aria-label": "选择这条摘录" } }); choice.appendText("选择这条摘录用于本次补充");
		check.onchange = () => { this.selected = check.checked; this.resetPreview(); };
		this.button(this.choices, "预览选中补充", () => void this.run(async signal => {
			if (!this.selected) throw new Error("请先明确勾选这条摘录");
			if (!this.initial) {
				const context = await prepareExcerptCuration(this.app, this.ref, this.target.value, this.paragraph.value, this.includeManual, signal);
				if (context.excerpt!.snapshot.digest !== this.snapshot!.digest) throw new Error("摘录或备注已变化，请关闭并重新打开后核对");
				this.review = await this.plugin.getCurationService().saveExcerpt(context, signal);
			}
			signal.throwIfAborted(); const preview = await this.plugin.getCurationWriter().preview(this.review!.id, ["s-0"]); signal.throwIfAborted();
			this.preview = preview; this.renderPreview(); this.status.setText("预览已准备；请核对所有文件变化后确认。关闭会保留整理批次，可从知识整理返回。");
		}));
		this.status.setText("原句与个人备注已读取；尚未选择补充内容。");
	}
	private resetPreview(): void { this.preview = undefined; this.result.empty(); }
	private renderPreview(): void {
		this.result.empty(); const preview = this.preview!;
		this.result.createEl("h3", { text: "确认前核对文件变化" });
		for (const write of preview.writes) {
			const row = this.result.createEl("details"); row.open = write.role === "target"; row.createEl("summary", { text: write.path });
			const window = curationChangeWindow(write.before || "", write.after);
			row.createEl("p", { text: "修改前 · 变化位置" }); row.createEl("pre", { text: window.before || "（新增）", cls: "curation-text" });
			row.createEl("p", { text: "修改后 · 变化位置" }); row.createEl("pre", { text: window.after, cls: "curation-text" });
			for (const [label, text] of [["完整修改前文件", write.before || "（新文件）"], ["完整修改后文件", write.after]]) { const full = row.createEl("details"); full.createEl("summary", { text: label }); full.createEl("pre", { text, cls: "curation-text" }); }
		}
		this.button(this.result, "确认补充到笔记", () => void this.run(async signal => {
			if (this.preview !== preview || !this.selected) throw new Error("预览已变化，请重新核对");
			const revision = await this.plugin.getCurationWriter().apply(preview, signal); signal.throwIfAborted();
			this.preview = undefined; this.result.empty(); this.choices.empty(); this.status.setText("摘录已补充，修订已保存。原始摘录保留；可从修订记录预览撤销。");
			this.button(this.result, "打开目标笔记", () => { this.plugin.openVaultFile(this.review!.context.target.path); this.close(); });
			this.button(this.result, "查看本次修订", () => { this.plugin.openKnowledgeMaintenance({ tab: "history", revisionId: revision.id }); this.close(); });
		})).addClass("mod-cta");
	}
}
