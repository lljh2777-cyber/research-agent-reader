import { FuzzySuggestModal, Modal, TFile, type App } from "obsidian";

export type ReadingChoice = "md-pdf" | "english" | "chinese" | "figures";
export class ReadingModePicker extends Modal {
	constructor(app: App, private readonly file: TFile, private readonly choose: (mode: ReadingChoice) => void, private readonly initial?: ReadingChoice) { super(app); }
	onOpen(): void {
		this.titleEl.setText("选择阅读方式");
		this.contentEl.createEl("p", { text: this.file.path, cls: "agent-split-picker-file" });
		this.contentEl.createEl("p", { text: "选择阅读方式后，从知识库选择另一份文件。文件可以放在任意目录。" });
		const options: [ReadingChoice, string][] = [["md-pdf", this.file.extension === "pdf" ? "PDF＋Markdown · 选择 Markdown" : "Markdown＋PDF · 选择 PDF"]];
		if (this.file.extension === "md") options.push(["english", "英文＋中文 · 当前文件作为英文"], ["chinese", "英文＋中文 · 当前文件作为中文"], ["figures", "正文＋图片与图注 · 单份 Markdown"]);
		for (const [mode, label] of options) {
			const button = this.contentEl.createEl("button", { text: label, cls: "agent-split-picker-choice", attr: { type: "button", "data-reader-choice": mode } });
			if (mode === this.initial) button.addClass("mod-cta");
			button.addEventListener("click", () => { this.close(); this.choose(mode); });
		}
	}
	onClose(): void { this.contentEl.empty(); }
}

export function chooseReadingFile(app: App, extension: "md" | "pdf", exclude: string, title: string): Promise<TFile | undefined> {
	return new Promise(resolve => {
		class Picker extends FuzzySuggestModal<TFile> {
			constructor() { super(app); this.setPlaceholder(title + " · 输入文件名或路径"); }
			getItems(): TFile[] { return app.vault.getFiles().filter(f => f.extension.toLowerCase() === extension && f.path !== exclude); }
			getItemText(file: TFile): string { return file.path; }
			onChooseItem(file: TFile): void { resolve(file); }
			onClose(): void { window.setTimeout(() => resolve(undefined), 0); }
		}
		new Picker().open();
	});
}
