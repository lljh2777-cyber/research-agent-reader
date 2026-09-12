import type { ManualBibliography } from "../library/manual-record";

export function renderManualBibliography(parent: HTMLElement, value: ManualBibliography): void {
	const section = parent.createEl("section", { cls: "rar-library-section", attr: { "aria-label": "未核验人工条目" } });
	section.createEl("p", { text: "未核验 · 用户手工填写。以下内容尚未与书目来源或论文原文核对。", cls: "rar-library-warning" });
	section.createEl("p", { text: "作者：" + (value.authors.join("；") || "未填写") });
	section.createEl("p", { text: "年份：" + (value.year || "未填写") });
	if (value.reference) section.createEl("p", { text: "待核对标识或线索：" + value.reference });
	if (value.notes) section.createEl("p", { text: "个人备注：" + value.notes, cls: "rar-manual-notes" });
}
