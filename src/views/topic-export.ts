import { Component, MarkdownRenderer, Modal, type App } from "obsidian";
import { safeLearningMarkdown } from "../learning/presentation";
import { type TopicExportReview, type TopicExportScope, type TopicStudyExports } from "../topic-learning/export";

export class TopicExportModal extends Modal {
	private exportScope: TopicExportScope = "node"; private serial = 0; private closed = false; private saving = false;
	private renderer = new Component(); private abort = new AbortController(); private review?: TopicExportReview;
	private status!: HTMLElement; private preview!: HTMLElement; private saveButton!: HTMLButtonElement; private copyButton!: HTMLButtonElement; private scopeSelect!: HTMLSelectElement; private refreshButton!: HTMLButtonElement;
	constructor(app: App, private exports: TopicStudyExports, private topicId: string, private route: string, private nodeId: string, private opened: (path: string) => Promise<void>) { super(app); }
	onOpen(): void {
		this.renderer.load(); this.titleEl.setText("导出主题学习记录"); this.modalEl.addClass("rar-topic-export");
		this.contentEl.createEl("p", { text: "保存到 wiki/qa/topic-learning/。内容标为模型一般知识，理解标记来自用户自评。不会作为已核验的论文依据。" });
		const tools = this.contentEl.createDiv("rar-study-tools"), label = tools.createEl("label", { text: "导出范围", cls: "rar-study-field" });
		this.scopeSelect = label.createEl("select", { attr: { "aria-label": "主题导出范围" } });
		for (const [value, text] of [["node", "选中节点"], ["branch", "当前主线／支线"], ["session", "完整学习记录"]]) this.scopeSelect.createEl("option", { value, text });
		this.scopeSelect.onchange = () => { this.exportScope = this.scopeSelect.value as TopicExportScope; void this.refresh(); };
		this.refreshButton = tools.createEl("button", { text: "刷新预览", attr: { "data-topic-export": "refresh" } }); this.refreshButton.onclick = () => { void this.refresh(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.preview = this.contentEl.createDiv("rar-topic-export-preview markdown-rendered");
		const footer = this.contentEl.createDiv("rar-study-tools");
		this.saveButton = footer.createEl("button", { text: "保存学习记录", cls: "mod-cta", attr: { "data-topic-export": "save" } }); this.saveButton.onclick = () => { void this.save(false); };
		this.copyButton = footer.createEl("button", { text: "保留原文件，另存副本", attr: { "data-topic-export": "copy" } }); this.copyButton.onclick = () => { void this.save(true); };
		void this.refresh();
	}
	private async refresh(): Promise<void> {
		if (this.closed || this.saving) return;
		const serial = ++this.serial; this.review = undefined; this.saveButton.disabled = this.copyButton.disabled = true; this.copyButton.hidden = true; this.status.setText("正在准备预览…");
		try {
			const study = await this.exports.service.get(this.topicId, this.route), review = await this.exports.review(this.topicId, this.route, study.head, this.exportScope, this.nodeId);
			if (this.closed || serial !== this.serial) return;
			this.renderer.unload(); this.renderer = new Component(); this.renderer.load(); this.preview.empty();
			const target = this.preview.createDiv();
			await MarkdownRenderer.render(this.app, safeLearningMarkdown(review.text.replace(/^---\n[\s\S]*?\n---\n/, "")), target, "", this.renderer);
			if (this.closed || serial !== this.serial) return;
			this.review = review; this.status.setText(`预览 ${review.count} 条讲解，跳过 ${review.omitted} 条未完成节点。` + (review.existing === "same" ? "已保存相同内容，可打开原记录。" : review.existing === "changed" ? "原导出已被编辑或保存不完整；保留原文件，可另存副本。" : "保存将创建新文件。"));
			this.saveButton.textContent = review.existing === "same" ? "打开已有记录" : "保存学习记录"; this.saveButton.disabled = review.existing === "changed";
			this.copyButton.hidden = review.existing !== "changed"; this.copyButton.disabled = false;
		} catch (e) { if (!this.closed && serial === this.serial) this.status.setText(String(e)); }
	}
	private async save(copy: boolean): Promise<void> {
		if (!this.review || this.saving || this.closed) return; this.saving = true;
		this.saveButton.disabled = this.copyButton.disabled = this.scopeSelect.disabled = this.refreshButton.disabled = true;
		try {
			const result = await this.exports.save(this.review, copy, this.abort.signal);
			if (this.closed) return; this.status.setText("已保存：" + result.path);
			try { await this.opened(result.path); this.close(); } catch { this.status.setText("文件已保存，但自动打开失败：" + result.path); }
		} catch (e) { if (!this.closed) { this.status.setText(String(e) + "；请刷新预览后再操作。"); this.review = undefined; } }
		finally { this.saving = false; if (!this.closed) { this.scopeSelect.disabled = this.refreshButton.disabled = false; this.saveButton.disabled = this.copyButton.disabled = true; } }
	}
	onClose(): void { this.closed = true; this.serial++; this.abort.abort(); this.renderer.unload(); this.contentEl.empty(); }
}
