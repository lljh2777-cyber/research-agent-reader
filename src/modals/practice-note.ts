import { App, Modal, Notice } from "obsidian";

export interface PracticeNoteForm {
	title: string;
	goal: string;
	notes: string;
}

export class PracticeNoteModal extends Modal {
	private readonly defaultTitle: string;
	private readonly onSubmit: (form: PracticeNoteForm) => void | Promise<void>;

	constructor(
		app: App,
		defaultTitle: string,
		onSubmit: (form: PracticeNoteForm) => void | Promise<void>,
	) {
		super(app);
		this.defaultTitle = defaultTitle;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("agent-dashboard-modal", "code-practice-save-modal");
		this.setTitle("保存练习笔记");
		const title = this.createField(contentEl, "标题", "text", this.defaultTitle);
		const goal = this.createField(contentEl, "目标", "textarea", "");
		const notes = this.createField(contentEl, "补充说明", "textarea", "");
		const footer = contentEl.createDiv({ cls: "agent-dashboard-modal-actions" });
		const cancel = footer.createEl("button", { text: "取消" });
		const save = footer.createEl("button", { cls: "mod-cta", text: "保存" });
		cancel.type = "button";
		save.type = "button";
		const submit = () => {
			const value = title.value.trim();
			if (!value) {
				new Notice("请输入练习标题");
				return;
			}
			this.close();
			void this.onSubmit({ title: value, goal: goal.value.trim(), notes: notes.value.trim() });
		};
		cancel.addEventListener("click", () => this.close());
		save.addEventListener("click", submit);
		title.addEventListener("keydown", (event) => {
			if ((event as KeyboardEvent).key === "Enter") submit();
		});
		window.setTimeout(() => title.focus(), 0);
	}

	createField(
		parent: HTMLElement,
		labelText: string,
		type: "text" | "textarea",
		value: string,
	): HTMLInputElement | HTMLTextAreaElement {
		const field = parent.createEl("label", { cls: "code-practice-modal-field" });
		field.createSpan({ text: labelText });
		if (type === "textarea") {
			const textarea = field.createEl("textarea", { attr: { rows: "4" } });
			textarea.value = value;
			return textarea;
		}
		const input = field.createEl("input", { attr: { type: "text" } });
		input.value = value;
		return input;
	}

	onClose() {
		this.contentEl.empty();
	}
}
