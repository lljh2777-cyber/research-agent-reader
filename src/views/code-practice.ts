import { ItemView } from "obsidian";
import { CODE_PRACTICE_VIEW_TYPE } from "../config";

// Old workspace layouts can still reopen this view after the runner is removed.
export class CodePracticeView extends ItemView {
	getViewType(): string { return CODE_PRACTICE_VIEW_TYPE; }
	getDisplayText(): string { return "历史代码练习"; }
	async onOpen(): Promise<void> {
		this.contentEl.createEl("p", { text: "代码练习功能已移除。已保存的练习笔记可在 wiki/code/practice 中打开。" });
	}
}
