import { Modal, type App } from "obsidian";
import { answerExcerptText, type AnswerExcerptFile, type AnswerExcerptList, type AnswerExcerptService } from "../learning/answer-excerpts";
import type { AnswerSnapshot } from "../learning/answer-snapshot";

export class AnswerExcerptBrowser extends Modal {
	private data: AnswerExcerptList = { entries: [], issues: [] }; private selected?: AnswerExcerptFile; private draft = ""; private query = "";
	private busy = false; private closed = true; private abort = new AbortController(); private check?: AbortController; private limit = 25;
	private list!: HTMLElement; private detail!: HTMLElement; private status!: HTMLElement;
	private get dirty(): boolean { return Boolean(this.selected && this.draft !== this.selected.record.note); }
	constructor(app: App, private service: AnswerExcerptService, private openDocument: (path: string) => Promise<void>, private openAnswer: (answer: AnswerSnapshot, signal: AbortSignal) => Promise<void>, private initial?: string, private didClose?: () => void) { super(app); }
	onOpen(): void {
		this.closed = false; this.setTitle("学习回答摘录"); this.modalEl.addClass("rar-excerpt-modal", "rar-answer-excerpt");
		this.contentEl.createEl("p", { text: "回看已保存的 AI 回答与个人备注。这里的片段不属于论文原句，也不代表核验通过。" });
		const tools = this.contentEl.createDiv("rar-excerpt-actions"), search = tools.createEl("input", { type: "search", placeholder: "搜索回答、主题或个人备注", attr: { "aria-label": "搜索学习摘录", maxlength: "500" } });
		search.oninput = () => { this.query = search.value; this.limit = 25; this.renderList(); }; this.button(tools, "刷新学习摘录", () => void this.refresh(), true);
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const grid = this.contentEl.createDiv("rar-excerpt-grid"); this.list = grid.createDiv("rar-excerpt-list"); this.detail = grid.createDiv("rar-excerpt-detail"); void this.refresh();
	}
	close(): void { if (this.busy || this.dirty) { this.status.setText("请先保存或放弃备注草稿，并等待操作结束后关闭。"); return; } super.close(); }
	dispose(): void { super.close(); }
	onClose(): void { this.closed = true; this.abort.abort(); this.check?.abort(); this.contentEl.empty(); this.didClose?.(); }
	private button(root: HTMLElement, text: string, run: () => void, clean = false): HTMLButtonElement {
		const button = root.createEl("button", { text, attr: { type: "button" } }); if (clean) button.dataset.clean = "true"; button.onclick = () => { if (!this.busy && (!clean || !this.dirty)) run(); }; return button;
	}
	private sync(): void { for (const input of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button,textarea"))) input.disabled = this.busy || input.dataset.clean === "true" && this.dirty; }
	private async run(work: () => Promise<void>): Promise<void> {
		if (this.closed || this.busy) return; this.busy = true; this.sync();
		try { await work(); } catch (e) { if (!this.closed && !this.abort.signal.aborted) this.status.setText(String(e)); } finally { this.busy = false; if (!this.closed) this.sync(); }
	}
	private async refresh(): Promise<void> {
		if (this.dirty) return;
		await this.run(async () => { this.status.setText("正在读取学习摘录…"); this.data = await this.service.list(this.abort.signal); this.abort.signal.throwIfAborted();
			this.selected = this.data.entries.find(e => e.path === (this.selected?.path || this.initial)); this.draft = this.selected?.record.note || "";
			this.status.setText(`${this.data.entries.length} 份学习摘录。`); this.renderList(); this.renderDetail(); });
	}
	private renderList(): void {
		this.list.empty(); const query = this.query.trim().toLocaleLowerCase(), matches = this.data.entries.filter(e => [answerExcerptText(e.record), e.record.answer.title, e.record.answer.context.location, e.record.note].join("\n").toLocaleLowerCase().includes(query));
		this.list.createEl("p", { text: `${matches.length} 条匹配记录` });
		if (this.data.issues.length) { const details = this.list.createEl("details"); details.createEl("summary", { text: `${this.data.issues.length} 条读取提示` }); for (const issue of this.data.issues.slice(0, 30)) details.createEl("p", { text: issue }); }
		for (const entry of matches.slice(0, this.limit)) {
			const b = this.button(this.list, entry.record.answer.title, () => void this.run(async () => { this.selected = await this.service.load(entry.path, this.abort.signal); this.draft = this.selected.record.note; this.renderList(); this.renderDetail(); }), true);
			b.addClass("rar-excerpt-row"); b.dataset.answerExcerpt = entry.path; b.setAttribute("aria-pressed", String(this.selected?.path === entry.path)); b.createEl("small", { text: entry.record.answer.ref.kind === "topic" ? "主题学习 · AI 回答" : "资料阅读 · AI 回答" });
		}
		if (!matches.length) this.list.createEl("p", { text: this.data.entries.length ? "没有匹配的学习摘录。" : "从主题学习或资料阅读的已完成回答点击“保存回答摘录”。" });
		if (matches.length > this.limit) this.button(this.list, "显示更多", () => { this.limit += 25; this.renderList(); }); this.sync();
	}
	private renderDetail(): void {
		this.check?.abort(); this.detail.empty(); const entry = this.selected; if (!entry) { this.detail.createEl("p", { text: "选择一份摘录，查看 AI 回答与个人备注。" }); return; }
		const record = entry.record, a = record.answer, check = this.check = new AbortController();
		this.detail.createEl("h3", { text: "AI 回答片段" }); this.detail.createEl("pre", { text: answerExcerptText(record) });
		this.detail.createEl("p", { text: a.context.location }); this.detail.createEl("p", { text: (a.provider || "供应商未记录") + " · " + (a.model || "模型未记录") });
		const status = this.detail.createEl("p", { text: "正在核对已保存回答版本…" });
		void this.service.verify(a, check.signal).then(() => { if (!check.signal.aborted && status.isConnected) status.setText("与已保存的回答版本一致；未据此核验原文或科学结论。"); }, e => { if (!check.signal.aborted && status.isConnected) status.setText("保留历史摘录，需复查：" + String(e)); });
		const info = this.detail.createEl("details"); info.createEl("summary", { text: "保存时的完整回答与版本" }); info.createEl("code", { text: a.digest }); info.createEl("p", { text: "问题：" + a.question }); info.createEl("pre", { text: a.content });
		this.detail.createEl("p", { text: "已保存的个人备注" }); this.detail.createEl("pre", { text: record.note || "未填写" });
		const input = this.detail.createEl("textarea", { attr: { rows: "4", maxlength: "10000", "aria-label": "编辑学习摘录备注" } }); input.value = this.draft; input.oninput = () => { this.draft = input.value; this.sync(); };
		const tools = this.detail.createDiv("rar-excerpt-actions");
		this.button(tools, "保存个人备注", () => void this.run(async () => { this.selected = await this.service.saveNote(entry, this.draft, this.abort.signal); this.abort.signal.throwIfAborted(); this.draft = this.selected.record.note; this.data.entries = this.data.entries.map(e => e.path === entry.path ? this.selected! : e); this.status.setText("个人备注已保存，AI 回答快照保持不变。"); this.renderList(); this.renderDetail(); }));
		this.button(tools, "重新读取（保留草稿）", () => void this.run(async () => { this.selected = await this.service.load(entry.path, this.abort.signal); this.abort.signal.throwIfAborted(); this.data.entries = this.data.entries.map(e => e.path === entry.path ? this.selected! : e); this.status.setText("已重新读取，请核对最新备注与草稿后保存。"); this.renderList(); this.renderDetail(); }));
		this.button(tools, "放弃修改", () => { this.draft = record.note; this.renderDetail(); });
		const nav = this.detail.createDiv("rar-excerpt-actions");
		this.button(nav, "回到回答节点", () => void this.run(async () => { const latest = await this.service.load(entry.path, this.abort.signal); if (latest.digest !== entry.digest) throw new Error("摘录已变化，请重新读取"); await this.service.verify(a, this.abort.signal); await this.openAnswer(a, this.abort.signal); this.abort.signal.throwIfAborted(); this.dispose(); }), true);
		this.button(nav, "打开学习摘录文档", () => void this.run(async () => { await this.service.load(entry.path, this.abort.signal); await this.openDocument(entry.path); this.abort.signal.throwIfAborted(); this.dispose(); }), true);
		this.detail.createEl("code", { text: entry.path }); this.sync();
	}
}
