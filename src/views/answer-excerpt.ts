import { Modal, type App } from "obsidian";
import { answerExcerptText, prepareAnswerExcerpt, type AnswerExcerpt, type AnswerExcerptService } from "../learning/answer-excerpts";
import { validateAnswerSnapshot, type AnswerSnapshot } from "../learning/answer-snapshot";

/** Preview a frozen AI answer. Selecting raw text avoids guessing Markdown offsets. */
export class AnswerExcerptModal extends Modal {
	private answer: AnswerSnapshot; private start: number; private end: number;
	private prepared?: AnswerExcerpt; private busy = false; private closed = true; private abort = new AbortController();
	private status!: HTMLElement; private preview!: HTMLElement; private note!: HTMLTextAreaElement; private saveButton!: HTMLButtonElement;
	constructor(app: App, private service: AnswerExcerptService, answer: AnswerSnapshot, private browse: (path?: string) => void, range?: { start: number; end: number }) {
		super(app); this.answer = validateAnswerSnapshot(answer); this.start = range?.start ?? 0; this.end = range?.end ?? answer.content.length;
	}
	onOpen(): void {
		this.closed = false; this.setTitle("保存 AI 回答摘录"); this.modalEl.addClass("rar-answer-excerpt");
		this.contentEl.createEl("p", { text: "保存已返回的回答片段与个人备注，无需再次调用模型。它保留 AI 内容身份，不作为论文原句。" });
		this.contentEl.createEl("p", { text: this.answer.title + " · " + (this.answer.provider || "供应商未记录") + " · " + (this.answer.model || "模型未记录") });
		const label = this.contentEl.createEl("label", { text: "已保存回答（可在下框选取部分文字）" });
		const text = label.createEl("textarea", { attr: { rows: "7", readonly: "true", "aria-label": "已保存回答" } }); text.value = this.answer.content;
		text.setSelectionRange(this.start, this.end);
		const tools = this.contentEl.createDiv("rar-excerpt-actions");
		this.button(tools, "使用所选文字", () => { if (this.busy) return; this.start = text.selectionStart; this.end = text.selectionEnd; this.invalidate(); void this.prepare(); });
		this.button(tools, "使用整条回答", () => { if (this.busy) return; this.start = 0; this.end = this.answer.content.length; this.invalidate(); void this.prepare(); });
		this.contentEl.createEl("h3", { text: "将保存的 AI 回答片段" }); this.preview = this.contentEl.createEl("pre");
		const memo = this.contentEl.createEl("label", { text: "个人备注（单独保存）" }); this.note = memo.createEl("textarea", { attr: { rows: "3", maxlength: "10000", "aria-label": "学习摘录个人备注" } }); this.note.oninput = () => this.invalidate();
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const actions = this.contentEl.createDiv("rar-excerpt-actions"); this.button(actions, "核对保存预览", () => void this.prepare());
		this.saveButton = this.button(actions, "确认保存学习摘录", () => void this.save()); this.saveButton.addClass("mod-cta"); this.saveButton.disabled = true;
		void this.prepare();
	}
	private button(root: HTMLElement, text: string, run: () => void): HTMLButtonElement { const button = root.createEl("button", { text, attr: { type: "button" } }); button.onclick = run; return button; }
	private invalidate(): void { this.prepared = undefined; this.saveButton.disabled = true; this.status.setText("内容选择或备注已变化，请核对保存预览。"); }
	private async prepare(): Promise<void> {
		if (this.busy || this.closed) return;
		this.prepared = undefined; await this.run(async () => {
			const record = prepareAnswerExcerpt(this.answer, this.start, this.end, this.note.value);
			this.preview.setText(answerExcerptText(record)); this.status.setText("正在核对已保存回答版本…");
			await this.service.verify(this.answer, this.abort.signal); this.abort.signal.throwIfAborted(); this.prepared = record;
			this.status.setText(`将保存 ${record.end - record.start} 个字符；回答版本 ${record.answer.digest.slice(0, 12)}。同一版本与位置将复用已有摘录及备注。`);
		});
	}
	private async save(): Promise<void> {
		if (!this.prepared || this.busy || this.closed) return; const record = this.prepared;
		await this.run(async () => {
			const result = await this.service.save(record, this.abort.signal); if (this.closed) return;
			this.prepared = undefined; this.status.setText((result.reused ? "已复用已有学习摘录，保留其个人备注：" : "已保存学习摘录：") + result.file.path + (result.warning ? "；" + result.warning : ""));
			const open = this.button(this.contentEl, "在学习摘录中查看", () => { this.browse(result.file.path); this.close(); }); open.addClass("mod-cta");
		});
	}
	private async run(work: () => Promise<void>): Promise<void> {
		this.busy = true;
		for (const input of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button,textarea"))) input.disabled = true;
		try { await work(); } catch (e) { if (!this.closed && !this.abort.signal.aborted) this.status.setText(String(e)); }
		finally { this.busy = false; if (!this.closed) { for (const input of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button,textarea"))) input.disabled = false; this.saveButton.disabled = !this.prepared; } }
	}
	onClose(): void { this.closed = true; this.abort.abort(); this.contentEl.empty(); }
}
