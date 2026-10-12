import { Modal, TFile, setIcon, type App } from "obsidian";
import { bilingualFileOrder, readingFileTree, readingFolderAncestors, readingLanguageHint, type ReadingFileNode, type ReadingLanguage } from "../reader/reading-file-tree";

export type ReadingChoice = "md-pdf" | "bilingual" | "figures";
export class ReadingModePicker extends Modal {
	constructor(app: App, private readonly file: TFile, private readonly choose: (mode: ReadingChoice) => void, private readonly initial?: ReadingChoice) { super(app); }
	onOpen(): void {
		this.titleEl.setText("选择阅读方式");
		this.contentEl.createEl("p", { text: this.file.name, cls: "agent-split-picker-name" });
		this.contentEl.createEl("p", { text: this.file.path, cls: "agent-split-picker-file" });
		this.contentEl.createEl("p", { text: "选择阅读方式后，从知识库目录树选择另一份文件。" });
		const options: [ReadingChoice, string][] = [["md-pdf", this.file.extension.toLowerCase() === "pdf" ? "PDF＋Markdown" : "Markdown＋PDF"]];
		if (this.file.extension.toLowerCase() === "md") options.push(["bilingual", "英文＋中文 Markdown"], ["figures", "正文＋图片与图注"]);
		for (const [mode, label] of options) {
			const button = this.contentEl.createEl("button", { text: label, cls: "agent-split-picker-choice", attr: { type: "button", "data-reader-choice": mode } });
			if (mode === this.initial) button.addClass("mod-cta");
			button.addEventListener("click", () => { this.close(); this.choose(mode); });
		}
	}
	onClose(): void { this.contentEl.empty(); }
}

interface FileChoice { file: TFile; currentLanguage?: ReadingLanguage }

class ReadingFilePicker extends Modal {
	private expanded: Set<string>;
	private searchExpanded = new Set<string>();
	private query = "";
	private selected?: TFile;
	private language?: ReadingLanguage;
	private tree!: HTMLElement;
	private preview!: HTMLElement;
	private confirm!: HTMLButtonElement;
	private resolved = false;
	constructor(app: App, private readonly extension: "md" | "pdf", private readonly exclude: string, private readonly heading: string, private readonly finish: (choice: FileChoice | undefined) => void, private readonly bilingual = false) {
		super(app); this.expanded = new Set(readingFolderAncestors(exclude)); this.language = readingLanguageHint(exclude);
	}
	onOpen(): void {
		this.modalEl.addClass("agent-reading-file-modal"); this.titleEl.setText(this.heading);
		const current = this.contentEl.createDiv({ cls: "agent-reading-file-current" });
		current.createSpan({ text: this.bilingual ? "当前文件" : "配对文件", cls: "agent-reading-file-label" });
		current.createSpan({ text: this.exclude.split("/").pop(), cls: "agent-reading-file-name", attr: { title: this.exclude } });
		if (this.bilingual) {
			const role = current.createEl("label", { cls: "agent-reading-file-role" }); role.createSpan({ text: "当前文件是" });
			const select = role.createEl("select", { attr: { "aria-label": "当前文件语言" } });
			for (const [value, text] of [["", "请选择语言"], ["en", "英文原文"], ["zh-CN", "中文译文"]]) select.createEl("option", { text, value });
			select.value = this.language ?? "";
			select.addEventListener("change", () => { this.language = select.value === "en" || select.value === "zh-CN" ? select.value : undefined; this.updateSelection(); });
			this.contentEl.createEl("p", { text: "左栏英文原文，右栏中文译文。语言按文件名提示预选，请核对；这不会建立段落对应或翻译证据。", cls: "agent-reading-file-hint" });
		}
		const search = this.contentEl.createEl("input", { cls: "agent-reading-file-search", type: "search", attr: { placeholder: "搜索文件名或路径…", "aria-label": "搜索文件名或路径" } });
		search.addEventListener("input", () => {
			this.query = search.value.trim(); this.searchExpanded.clear();
			const expand = (nodes: ReadingFileNode[]): void => { for (const node of nodes) if (node.kind === "folder") { this.searchExpanded.add(node.path); expand(node.children); } };
			expand(this.nodes()); this.renderTree();
		});
		search.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); this.tree.querySelector<HTMLElement>('[role="treeitem"]')?.focus(); } });
		this.tree = this.contentEl.createDiv({ cls: "agent-reading-file-tree", attr: { role: "tree", "aria-label": "知识库文件目录" } });
		this.tree.addEventListener("keydown", event => this.navigate(event));
		this.preview = this.contentEl.createDiv({ cls: "agent-reading-file-preview", attr: { "aria-live": "polite" } });
		const footer = this.contentEl.createDiv({ cls: "agent-reading-file-footer" });
		footer.createSpan({ text: `仅显示 ${this.extension.toUpperCase()} 文件`, cls: "agent-reading-file-hint" });
		const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } }); cancel.addEventListener("click", () => this.close());
		this.confirm = footer.createEl("button", { text: "打开双栏", cls: "mod-cta", attr: { type: "button", "data-reader-confirm": "true" } });
		this.confirm.addEventListener("click", () => this.accept());
		this.renderTree(); this.updateSelection(); search.focus();
	}
	private nodes(): ReadingFileNode[] { return readingFileTree(this.app.vault.getFiles().map(file => file.path), this.extension, this.exclude, this.query); }
	private openFolders(): Set<string> { return this.query ? this.searchExpanded : this.expanded; }
	private renderTree(focusPath?: string): void {
		this.tree.empty(); const nodes = this.nodes(), expanded = this.openFolders();
		const append = (items: ReadingFileNode[], depth: number): void => {
			for (const [i, node] of items.entries()) {
				const row = this.tree.createEl("button", { cls: "agent-reading-file-row", attr: { type: "button", role: "treeitem", "data-file-path": node.path, "data-file-kind": node.kind, "aria-level": String(depth + 1), "aria-posinset": String(i + 1), "aria-setsize": String(items.length), title: node.path, tabindex: "-1" } });
				row.style.setProperty("--tree-depth", String(depth));
				const chevron = row.createSpan({ cls: "agent-reading-file-chevron" });
				if (node.kind === "folder") { row.setAttribute("aria-expanded", String(expanded.has(node.path))); setIcon(chevron, expanded.has(node.path) ? "chevron-down" : "chevron-right"); }
				else row.setAttribute("aria-selected", String(this.selected?.path === node.path));
				setIcon(row.createSpan({ cls: "agent-reading-file-icon" }), node.kind === "folder" ? "folder" : this.extension === "pdf" ? "file-text" : "file");
				row.createSpan({ text: node.name, cls: "agent-reading-file-name" });
				row.addEventListener("focus", () => { for (const item of this.rows()) item.tabIndex = item === row ? 0 : -1; });
				row.addEventListener("click", () => {
					if (node.kind === "folder") { if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path); this.renderTree(node.path); }
					else { const file = this.app.vault.getAbstractFileByPath(node.path); if (file instanceof TFile) { this.selected = file; this.updateSelection(); } }
				});
				if (node.kind === "file") row.addEventListener("dblclick", () => this.accept());
				if (node.kind === "folder" && expanded.has(node.path)) append(node.children, depth + 1);
			}
		};
		append(nodes, 0); const rows = this.rows();
		const active = rows.find(row => row.dataset.filePath === focusPath) ?? rows.find(row => row.dataset.filePath === this.selected?.path) ?? rows[0];
		if (active) { active.tabIndex = 0; if (focusPath) active.focus(); }
		else this.tree.createDiv({ text: this.query ? "没有匹配的文件，试试其他文件名或路径。" : `没有可选择的 ${this.extension.toUpperCase()} 文件。`, cls: "agent-reading-file-empty" });
	}
	private rows(): HTMLButtonElement[] { return Array.from(this.tree.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')); }
	private navigate(event: KeyboardEvent): void {
		const rows = this.rows(), index = rows.indexOf(event.target as HTMLButtonElement), row = rows[index]; if (!row) return;
		let target: HTMLButtonElement | undefined;
		if (event.key === "ArrowDown") target = rows[Math.min(index + 1, rows.length - 1)];
		else if (event.key === "ArrowUp") target = rows[Math.max(0, index - 1)];
		else if (event.key === "Home") target = rows[0];
		else if (event.key === "End") target = rows[rows.length - 1];
		else if (event.key === "ArrowRight") {
			if (row.dataset.fileKind !== "folder") return;
			if (row.getAttribute("aria-expanded") === "false") { event.preventDefault(); row.click(); return; }
			target = rows[index + 1];
		} else if (event.key === "ArrowLeft") {
			if (row.getAttribute("aria-expanded") === "true") { event.preventDefault(); row.click(); return; }
			const parent = readingFolderAncestors(row.dataset.filePath!).pop(); target = rows.find(item => item.dataset.filePath === parent);
		} else return;
		event.preventDefault(); target?.focus(); target?.scrollIntoView({ block: "nearest" });
	}
	private updateSelection(): void {
		for (const row of this.rows()) if (row.dataset.fileKind === "file") row.setAttribute("aria-selected", String(row.dataset.filePath === this.selected?.path));
		this.preview.empty(); this.confirm.disabled = !this.selected || (this.bilingual && !this.language);
		if (!this.selected) { this.preview.createSpan({ text: "展开文件夹，选择另一份文件。", cls: "agent-reading-file-hint" }); return; }
		if (this.bilingual && this.language) {
			const order = bilingualFileOrder(this.exclude, this.selected.path, this.language);
			for (const [label, path] of [["英文原文", order.left], ["中文译文", order.right]]) {
				const line = this.preview.createDiv(); line.createSpan({ text: label, cls: "agent-reading-file-label" }); line.createSpan({ text: path, cls: "agent-reading-file-path" });
			}
		} else {
			this.preview.createDiv({ text: this.selected.path, cls: "agent-reading-file-path" });
			if (this.bilingual) this.preview.createSpan({ text: "请选择当前文件的语言，再打开双栏。", cls: "agent-reading-file-hint" });
		}
	}
	private accept(): void {
		if (!this.selected || (this.bilingual && !this.language)) return;
		if (this.app.vault.getAbstractFileByPath(this.selected.path) !== this.selected) { this.selected = undefined; this.renderTree(); this.updateSelection(); return; }
		this.resolved = true; this.finish({ file: this.selected, currentLanguage: this.language }); this.close();
	}
	onClose(): void { if (!this.resolved) { this.resolved = true; this.finish(undefined); } this.contentEl.empty(); }
}

export function chooseReadingFile(app: App, extension: "md" | "pdf", exclude: string, title: string): Promise<TFile | undefined> {
	return new Promise(resolve => new ReadingFilePicker(app, extension, exclude, title, choice => resolve(choice?.file)).open());
}

export function chooseBilingualReadingFile(app: App, current: string): Promise<{ file: TFile; currentLanguage: ReadingLanguage } | undefined> {
	return new Promise(resolve => new ReadingFilePicker(app, "md", current, "选择另一份 Markdown", choice => resolve(choice?.currentLanguage ? { file: choice.file, currentLanguage: choice.currentLanguage } : undefined), true).open());
}
