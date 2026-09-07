import { Component, MarkdownRenderer, Modal, Notice, type App } from "obsidian";
import { exportReading, readingExportHash, reviewReadingExport, safeReadingMarkdown, type ReadingExportReview, type ReadingExportScope } from "../reading/export";
import { exportBodyText, readingAssociations, readingExportDiff, type AssociationSearch, type ReadingAssociation } from "../reading/export-review";
import type { ReadingSession } from "../reading/types";

export class ReadingExportModal extends Modal {
	private exportScope: ReadingExportScope = "node"; private generation = 0; private closed = false; private sending = false;
	private controller?: AbortController; private renderer = new Component(); private review?: ReadingExportReview;
	private candidates: ReadingAssociation[] = []; private selected = new Set<string>();
	private status!: HTMLElement; private suggestions!: HTMLElement; private history!: HTMLElement; private preview!: HTMLElement;
	private submit!: HTMLButtonElement; private discover!: HTMLButtonElement; private scopeSelect!: HTMLSelectElement;
	constructor(app: App, private getSession: () => ReadingSession, private nodeId: string, private search: AssociationSearch, private openFile: (path: string) => void, private curate?: () => void, initialScope: ReadingExportScope = "node") { super(app); this.exportScope = initialScope; }
	onOpen(): void {
		this.renderer.load(); this.titleEl.setText("整理为学习笔记"); this.modalEl.classList.add("reading-modal", "reading-export-modal");
		this.contentEl.createEl("p", { cls: "reading-export-intro", text: "检查内容，选择关联，然后保存。每次修订保留前一版，学习记录保存到 wiki/qa/。" });
		const grid = this.contentEl.createDiv("reading-export-grid"); const side = grid.createDiv("reading-export-sidebar");
		const label = side.createEl("label", { cls: "reading-field", text: "导出范围" }); this.scopeSelect = label.createEl("select"); this.scopeSelect.setAttribute("aria-label", "导出范围");
		for (const [value, title] of [["node", "选中节点"], ["branch", "选中支线"], ["session", "完整会话"]]) this.scopeSelect.createEl("option", { value, text: title });
		this.scopeSelect.value = this.exportScope;
		this.scopeSelect.onchange = () => { this.exportScope = this.scopeSelect.value as ReadingExportScope; this.controller?.abort(); this.candidates = []; this.selected.clear(); this.renderCandidates(); void this.refresh(); };
		this.status = side.createEl("p", { cls: "reading-export-status", attr: { role: "status", "aria-live": "polite" } });
		const controls = side.createDiv("reading-export-controls"); this.discover = controls.createEl("button", { text: "查找关联笔记" }); this.discover.onclick = () => void this.findAssociations();
		const refresh = controls.createEl("button", { text: "刷新预览" }); refresh.onclick = () => void this.refresh();
		if (this.curate && !this.getSession().demo) { const organize = controls.createEl("button", { text: "整理到已有笔记" }); organize.onclick = () => { this.close(); this.curate?.(); }; }
		this.suggestions = side.createDiv("reading-export-associations"); this.history = side.createDiv("reading-export-history");
		const paper = grid.createDiv("reading-export-paper"); paper.createEl("small", { text: "学习笔记预览" }); this.preview = paper.createDiv("markdown-rendered reading-export-preview");
		const footer = this.contentEl.createDiv("reading-export-footer"); footer.createEl("span", { text: "相似内容仅作关联候选；正式论文笔记的深读状态独立保留。" });
		this.submit = footer.createEl("button", { text: "保存学习笔记", cls: "mod-cta" }); this.submit.onclick = () => void this.save();
		this.renderCandidates(); void this.refresh();
	}
	onClose(): void { this.closed = true; this.generation++; this.controller?.abort(); this.renderer.unload(); this.contentEl.empty(); }
	private async refresh(): Promise<void> {
		const token = ++this.generation; this.submit.disabled = true; this.review = undefined;
		try {
			const session = structuredClone(this.getSession()); const review = await reviewReadingExport(this.app, session, this.exportScope, this.nodeId, { related: [...this.selected] });
			if (this.closed || token !== this.generation) return; this.review = review;
			this.status.textContent = review.duplicate ? "此范围和内容已导出。可打开原笔记，保留其中的手工编辑。" : review.revisionOf ? "检测到上一版。本次将新增修订，保留上一版及其手工编辑。" : "首次导出此范围，将创建独立学习笔记。";
			this.submit.textContent = review.duplicate ? "打开已有笔记" : review.revisionOf ? "保存新修订" : "保存学习笔记";
			this.history.empty();
			if (review.history.length) {
				const latest = review.duplicate || review.history[0]; const diff = readingExportDiff(latest.text, review.text);
				const compare = this.history.createEl("details"); compare.createEl("summary", { text: "与已有笔记比较" });
				compare.createEl("p", { text: latest.path }); const open = compare.createEl("button", { text: "打开已有内容" }); open.onclick = () => this.openFile(latest.path);
				compare.createEl("p", { text: diff.added || diff.removed ? `变化区段：删除 ${diff.removed} 行、新增 ${diff.added} 行。` : "正文内容一致。" });
				if (diff.lines) compare.createEl("pre", { cls: "reading-export-diff", text: diff.lines });
				if (diff.omitted) compare.createEl("small", { text: "变化区段较长，各展示前 100 行；完整新内容见右侧预览。" });
				const versions = this.history.createEl("details"); versions.createEl("summary", { text: "修订记录（" + review.history.length + "）" });
				for (const record of review.history) { const item = versions.createEl("button", { text: record.created + " · " + record.path }); item.onclick = () => this.openFile(record.path); }
			}
			this.preview.empty(); const target = this.preview.createDiv(); await MarkdownRenderer.render(this.app, safeReadingMarkdown(exportBodyText(review.text)), target, "wiki/qa/", this.renderer);
			if (!this.closed && token === this.generation && !this.sending) this.submit.disabled = false;
		} catch (error) { if (!this.closed && token === this.generation) this.status.textContent = error instanceof Error ? error.message : "预览失败，请重试"; }
	}
	private renderCandidates(): void {
		this.suggestions.empty();
		if (!this.candidates.length) { this.suggestions.createEl("p", { text: "可查找主题相近的来源和方法笔记，核对片段后选择关联。", cls: "reading-export-hint" }); return; }
		for (const candidate of this.candidates) {
			const item = this.suggestions.createDiv("reading-association"); const label = item.createEl("label"); const checkbox = label.createEl("input", { type: "checkbox" }); checkbox.checked = this.selected.has(candidate.path);
			checkbox.onchange = () => { if (checkbox.checked) this.selected.add(candidate.path); else this.selected.delete(candidate.path); void this.refresh(); };
			label.createEl("span", { text: candidate.title }); item.createEl("small", { text: candidate.reason + " · " + candidate.role });
			const detail = item.createEl("details"); detail.createEl("summary", { text: "查看依据片段" }); detail.createEl("p", { text: candidate.path + (candidate.heading ? " · " + candidate.heading : "") });
			detail.createEl("p", { text: "原始来源：" + (candidate.origins.join("、") || "未标注") }); detail.createEl("pre", { text: candidate.excerpt });
			const open = detail.createEl("button", { text: "打开来源" }); open.onclick = () => this.openFile(candidate.path);
		}
	}
	private async findAssociations(): Promise<void> {
		this.controller?.abort(); const controller = new AbortController(); this.controller = controller; this.discover.disabled = true;
		this.status.textContent = "正在查找关联片段…";
		try {
			const result = await readingAssociations(this.app, structuredClone(this.getSession()), this.exportScope, this.nodeId, this.search, controller.signal);
			if (this.closed || controller.signal.aborted) return;
			this.candidates = result.candidates; this.selected.clear(); this.renderCandidates(); await this.refresh();
			if (!this.closed && !controller.signal.aborted) this.status.textContent += (result.candidates.length ? " 已找到 " + result.candidates.length + " 条关联候选。" : " 未找到可用关联，仍可独立导出。") + " " + result.warnings.join("；");
		} catch (error) { if (!this.closed && !controller.signal.aborted) this.status.textContent = error instanceof Error ? error.message : "关联检索失败，可独立导出"; }
		finally { if (this.controller === controller && !this.closed) this.discover.disabled = false; }
	}
	private async save(): Promise<void> {
		if (!this.review || this.sending) return; this.sending = true; this.submit.disabled = true; this.scopeSelect.disabled = true;
		const controls = Array.from(this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"));
		const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
		try {
			const session = this.getSession(); const related = [...this.selected];
			if (readingExportHash(session, this.exportScope, this.nodeId, { related }) !== this.review.hash) throw new Error("阅读内容已变化，请刷新预览后保存");
			const result = await exportReading(this.app, session, this.exportScope, this.nodeId, { related, expectedHash: this.review.hash, relatedHashes: Object.fromEntries(this.candidates.map(candidate => [candidate.path, candidate.hash])) });
			this.close(); new Notice(result.warning || (result.reused ? "已打开已有学习笔记" : "已保存学习笔记")); this.openFile(result.path);
		} catch (error) { if (!this.closed) this.status.textContent = error instanceof Error ? error.message : "导出失败，请重试"; }
		finally { this.sending = false; if (!this.closed) { controls.forEach((control, index) => { control.disabled = disabled[index]; }); this.submit.disabled = false; this.scopeSelect.disabled = false; } }
	}
}
