import { Modal, type App } from "obsidian";
import { answerExcerptCompleted, answerExcerptText, type AnswerExcerptFile, type AnswerExcerptList, type AnswerExcerptService } from "../learning/answer-excerpts";
import type { AnswerSnapshot } from "../learning/answer-snapshot";

export class AnswerExcerptBrowser extends Modal {
	private data: AnswerExcerptList = { entries: [], issues: [] }; private selected?: AnswerExcerptFile; private draft = ""; private query = "";
	private humanDraft = ""; private humanPreview?: { digest: string; text: string }; private filter = "all";
	private busy = false; private closed = true; private abort = new AbortController(); private check?: AbortController; private limit = 25;
	private list!: HTMLElement; private detail!: HTMLElement; private status!: HTMLElement;
	private get dirty(): boolean { return Boolean(this.selected && (this.draft !== this.selected.record.note || this.humanDraft !== (this.selected.record.humanRevision?.text || ""))); }
	constructor(app: App, private service: AnswerExcerptService, private openDocument: (path: string) => Promise<void>, private openAnswer: (answer: AnswerSnapshot, signal: AbortSignal) => Promise<void>, private initial?: string, private didClose?: () => void, private curate?: (path: string) => void, private knowledgeDraft?: (path: string) => void) { super(app); }
	onOpen(): void {
		this.closed = false; this.setTitle("学习回答摘录"); this.modalEl.addClass("rar-excerpt-modal", "rar-answer-excerpt");
		this.contentEl.createEl("p", { text: "分别保留原始 AI 回答、人工修订稿与个人备注。人工修订和整理完成不代表原文、科学或教学核验通过。" });
		const tools = this.contentEl.createDiv("rar-excerpt-actions"), search = tools.createEl("input", { type: "search", placeholder: "搜索回答、修订稿或备注", attr: { "aria-label": "搜索学习摘录", maxlength: "500" } });
		search.oninput = () => { this.query = search.value; this.limit = 25; this.renderList(); }; this.button(tools, "刷新学习摘录", () => void this.refresh(), true);
		const filter = tools.createEl("select", { attr: { "aria-label": "学习摘录整理状态" } });
		for (const [value, text] of [["all", "全部状态"], ["pending", "待整理"], ["completed", "整理完成"]]) filter.createEl("option", { value, text });
		filter.onchange = () => { this.filter = filter.value; this.limit = 25; this.renderList(); };
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const grid = this.contentEl.createDiv("rar-excerpt-grid"); this.list = grid.createDiv("rar-excerpt-list"); this.detail = grid.createDiv("rar-excerpt-detail"); void this.refresh();
	}
	close(): void { if (this.busy || this.dirty) { this.status.setText("请先保存或放弃修订稿与备注草稿，并等待操作结束后关闭。"); return; } super.close(); }
	dispose(): void { super.close(); }
	onClose(): void { this.closed = true; this.abort.abort(); this.check?.abort(); this.contentEl.empty(); this.didClose?.(); }
	private button(root: HTMLElement, text: string, run: () => void, clean = false): HTMLButtonElement {
		const button = root.createEl("button", { text, attr: { type: "button" } }); if (clean) button.dataset.clean = "true"; button.onclick = () => { if (!this.busy && (!clean || !this.dirty)) run(); }; return button;
	}
	private sync(): void { for (const input of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button,textarea"))) {
		input.disabled = this.busy || input.dataset.clean === "true" && this.dirty;
		if (input.dataset.saveHuman === "true") input.disabled ||= !this.humanPreview || this.humanPreview.digest !== this.selected?.digest || this.humanPreview.text !== this.humanDraft;
	} }
	private accept(file: AnswerExcerptFile, reset: "all" | "note" | "human" | "none"): void {
		this.selected = file; this.humanPreview = undefined;
		if (reset === "all" || reset === "note") this.draft = file.record.note;
		if (reset === "all" || reset === "human") this.humanDraft = file.record.humanRevision?.text || "";
		this.data.entries = this.data.entries.map(e => e.path === file.path ? file : e); this.renderList(); this.renderDetail();
	}
	private async run(work: () => Promise<void>): Promise<void> {
		if (this.closed || this.busy) return; this.busy = true; this.sync();
		try { await work(); } catch (e) { if (!this.closed && !this.abort.signal.aborted) this.status.setText(String(e)); } finally { this.busy = false; if (!this.closed) this.sync(); }
	}
	private async refresh(): Promise<void> {
		if (this.dirty) return;
		await this.run(async () => { this.status.setText("正在读取学习摘录…"); this.data = await this.service.list(this.abort.signal); this.abort.signal.throwIfAborted();
			this.selected = this.data.entries.find(e => e.path === (this.selected?.path || this.initial)); this.draft = this.selected?.record.note || ""; this.humanDraft = this.selected?.record.humanRevision?.text || ""; this.humanPreview = undefined;
			this.status.setText(`${this.data.entries.length} 份学习摘录。`); this.renderList(); this.renderDetail(); });
	}
	private renderList(): void {
		this.list.empty(); const query = this.query.trim().toLocaleLowerCase(), matches = this.data.entries.filter(e => (this.filter === "all" || (this.filter === "completed") === answerExcerptCompleted(e.record)) && [answerExcerptText(e.record), e.record.answer.title, e.record.answer.context.location, e.record.note, e.record.humanRevision?.text || ""].join("\n").toLocaleLowerCase().includes(query));
		this.list.createEl("p", { text: `${matches.length} 条匹配记录` });
		if (this.data.issues.length) { const details = this.list.createEl("details"); details.createEl("summary", { text: `${this.data.issues.length} 条读取提示` }); for (const issue of this.data.issues.slice(0, 30)) details.createEl("p", { text: issue }); }
		for (const entry of matches.slice(0, this.limit)) {
			const b = this.button(this.list, entry.record.answer.title, () => void this.run(async () => { const file = await this.service.load(entry.path, this.abort.signal); this.abort.signal.throwIfAborted(); this.accept(file, "all"); }), true);
			b.addClass("rar-excerpt-row"); b.dataset.answerExcerpt = entry.path; b.setAttribute("aria-pressed", String(this.selected?.path === entry.path)); b.createEl("small", { text: (entry.record.answer.ref.kind === "topic" ? "主题学习 · AI 回答" : "资料阅读 · AI 回答") + (entry.record.humanRevision ? " · 有人工修订" : "") + (answerExcerptCompleted(entry.record) ? " · 整理完成" : " · 待整理") });
		}
		if (!matches.length) this.list.createEl("p", { text: this.data.entries.length ? "没有匹配的学习摘录。" : "从主题学习或资料阅读的已完成回答点击“保存回答摘录”。" });
		if (matches.length > this.limit) this.button(this.list, "显示更多", () => { this.limit += 25; this.renderList(); }); this.sync();
	}
	private renderDetail(): void {
		this.check?.abort(); this.detail.empty(); const entry = this.selected; if (!entry) { this.detail.createEl("p", { text: "选择一份摘录，查看 AI 回答与个人备注。" }); return; }
		const record = entry.record, a = record.answer, check = this.check = new AbortController();
		this.detail.createEl("h3", { text: "原始 AI 回答片段" }); this.detail.createEl("pre", { text: answerExcerptText(record) });
		this.detail.createEl("p", { text: a.context.location }); this.detail.createEl("p", { text: (a.provider || "供应商未记录") + " · " + (a.model || "模型未记录") });
		const status = this.detail.createEl("p", { text: "正在核对已保存回答版本…" });
		void this.service.sourceStatus(a, check.signal).then(result => { if (!check.signal.aborted && status.isConnected) status.setText(result.message); }, e => { if (!check.signal.aborted && status.isConnected) status.setText("保留历史摘录，需复查：" + String(e)); });
		const info = this.detail.createEl("details"); info.createEl("summary", { text: "保存时的完整回答与版本" }); info.createEl("code", { text: a.digest }); info.createEl("p", { text: "问题：" + a.question }); info.createEl("pre", { text: a.content });
		const organization = this.detail.createDiv("rar-excerpt-actions"); organization.createSpan({ text: answerExcerptCompleted(record) ? "用户标记：整理完成" : "用户标记：待整理" });
		this.button(organization, answerExcerptCompleted(record) ? "重新待整理" : "标记整理完成", () => void this.run(async () => {
			const file = await this.service.setCompleted(entry, !answerExcerptCompleted(record), this.abort.signal); this.abort.signal.throwIfAborted();
			this.status.setText("整理状态已保存；回答变化或无法核对时，待处理中心仍保留复查项。"); this.accept(file, "none");
		}), true);
		this.renderHuman(entry);
		this.detail.createEl("h3", { text: "个人备注" }); this.detail.createEl("pre", { text: record.note || "未填写" });
		const input = this.detail.createEl("textarea", { attr: { rows: "4", maxlength: "10000", "aria-label": "编辑学习摘录备注" } }); input.value = this.draft; input.oninput = () => { this.draft = input.value; this.sync(); };
		const tools = this.detail.createDiv("rar-excerpt-actions");
		this.button(tools, "保存个人备注", () => void this.run(async () => { const file = await this.service.saveNote(entry, this.draft, this.abort.signal); this.abort.signal.throwIfAborted(); this.status.setText("个人备注已保存，AI 回答快照保持不变。"); this.accept(file, "note"); }));
		this.button(tools, "重新读取（保留草稿）", () => void this.run(async () => { const file = await this.service.load(entry.path, this.abort.signal); this.abort.signal.throwIfAborted(); this.status.setText("已重新读取，两个草稿均保留；请核对最新内容后再预览保存。"); this.accept(file, "none"); }));
		this.button(tools, "放弃修改", () => { this.draft = record.note; this.renderDetail(); });
		const nav = this.detail.createDiv("rar-excerpt-actions");
		if (this.curate) this.button(nav, "补充学习内容到已有笔记", () => { this.dispose(); this.curate!(entry.path); }, true);
		if (this.knowledgeDraft) this.button(nav, "以此学习摘录起草新知识页", () => { this.dispose(); this.knowledgeDraft!(entry.path); }, true);
		this.button(nav, "回到回答节点", () => void this.run(async () => { const latest = await this.service.load(entry.path, this.abort.signal); if (latest.digest !== entry.digest) throw new Error("摘录已变化，请重新读取"); await this.service.verify(a, this.abort.signal); await this.openAnswer(a, this.abort.signal); this.abort.signal.throwIfAborted(); this.dispose(); }), true);
		this.button(nav, "打开学习摘录文档", () => void this.run(async () => { await this.service.load(entry.path, this.abort.signal); await this.openDocument(entry.path); this.abort.signal.throwIfAborted(); this.dispose(); }), true);
		this.detail.createEl("code", { text: entry.path }); this.sync();
	}
	private renderHuman(entry: AnswerExcerptFile): void {
		const record = entry.record;
		this.detail.createEl("h3", { text: "人工修订稿（基于 AI 回答）" });
		this.detail.createEl("p", { text: "在这里保存自己的改写，不改动原始回答。内容或备注保存后重新待整理；修订稿仍不进入知识检索。" });
		const saved = this.detail.createEl("details"); saved.createEl("summary", { text: "查看已保存修订稿" }); saved.createEl("pre", { text: record.humanRevision?.text || "尚未保存人工修订稿" });
		const input = this.detail.createEl("textarea", { attr: { rows: "6", maxlength: "20000", "aria-label": "编辑人工修订稿" } }); input.value = this.humanDraft;
		const preview = this.detail.createDiv("rar-answer-human-preview");
		input.oninput = () => { this.humanDraft = input.value; this.humanPreview = undefined; preview.empty(); this.sync(); };
		if (this.humanPreview) { preview.createEl("h4", { text: "人工修订预览" }); preview.createEl("p", { text: "确认后保存下方人工内容，原始 AI 回答保持不变。" }); preview.createEl("pre", { text: this.humanPreview.text.trim() ? this.humanPreview.text : "清空已保存的人工修订稿" }); }
		const tools = this.detail.createDiv("rar-excerpt-actions");
		this.button(tools, "以 AI 片段起草", () => {
			if (this.humanDraft.trim()) { this.status.setText("修订框已有内容，请自行编辑或先放弃草稿；未覆盖。"); return; }
			this.humanDraft = answerExcerptText(record); this.humanPreview = undefined; this.renderDetail();
		});
		this.button(tools, "预览人工修订", () => void this.run(async () => {
			const text = this.humanDraft, latest = await this.service.load(entry.path, this.abort.signal); this.abort.signal.throwIfAborted();
			if (latest.digest !== entry.digest) throw new Error("学习摘录已被其他窗口修改，请重新读取；两个草稿仍保留");
			if (text.length > 20000) throw new Error("人工修订稿超过两万字符"); this.humanPreview = { digest: entry.digest, text }; this.renderDetail();
		}));
		const save = this.button(tools, "确认保存人工修订", () => {
			if (!this.humanPreview || this.humanPreview.digest !== entry.digest || this.humanPreview.text !== this.humanDraft) return;
			const text = this.humanPreview.text; void this.run(async () => { const file = await this.service.saveHumanRevision(entry, text, this.abort.signal); this.abort.signal.throwIfAborted(); this.status.setText("人工修订已保存；原始 AI 回答与个人备注保持不变。"); this.accept(file, "human"); });
		}); save.dataset.saveHuman = "true";
		this.button(tools, "放弃修订草稿", () => { this.humanDraft = record.humanRevision?.text || ""; this.humanPreview = undefined; this.renderDetail(); });
	}
}
