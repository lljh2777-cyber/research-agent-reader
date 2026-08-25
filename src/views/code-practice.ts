import path from "node:path";

import {
	ItemView,
	Notice,
	setIcon,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";

import { CODE_PRACTICE_VIEW_TYPE } from "../config";
import { PracticeNoteModal } from "../modals/practice-note";
import type { PluginHost } from "../types/contracts";

type PracticeLanguage = "python" | "r";
type PracticeStatus =
	| "idle"
	| "running"
	| "success"
	| "failed"
	| "timeout"
	| "stopped";

interface CodePracticeResult {
	run_id: string;
	status: PracticeStatus;
	language: PracticeLanguage;
	exit_code: number | null;
	duration_ms: number;
	stdout: string;
	stderr: string;
	figures: string[];
}

interface CodePracticeCell {
	id: string;
	code: string;
	placeholder: string;
	result: CodePracticeResult | null;
	executionCount: number | null;
}

interface CodePracticeRequest {
	run_id: string;
	language: PracticeLanguage;
	context_code: string;
	code: string;
	working_directory: string;
	timeout_seconds: number;
}

interface CodePracticeHost extends PluginHost {
	createPracticeRunId(): string;
	runCodePractice(request: CodePracticeRequest): Promise<CodePracticeResult>;
	stopCodePractice(runId: string): void;
	readPracticeFigure(figurePath: string): string;
	savePracticeNote(payload: {
		title: string;
		goal: string;
		notes: string;
		language: PracticeLanguage;
		cells: Array<{
			code: string;
			result: CodePracticeResult | null;
			executionCount: number | null;
		}>;
		relatedNotePath: string;
	}): Promise<TFile>;
}

interface NotebookControls {
	add: HTMLButtonElement;
	run: HTMLButtonElement;
	stop: HTMLButtonElement;
	clear: HTMLButtonElement;
	clearCode: HTMLButtonElement;
	resetCells: HTMLButtonElement;
	save: HTMLButtonElement;
	addFooter: HTMLButtonElement;
}

export class CodePracticeView extends ItemView {
	private readonly plugin: CodePracticeHost;
	private language: PracticeLanguage;
	private nextCellId: number;
	private cellsByLanguage: Record<PracticeLanguage, CodePracticeCell[]>;
	private activeRunId: string;
	private activeCellId: string;
	private stopRequested: boolean;
	private runningAll: boolean;
	private executionCounter: number;
	private relatedNotePath: string;
	private notebookControls: NotebookControls | null;

	constructor(leaf: WorkspaceLeaf, plugin: CodePracticeHost) {
		super(leaf);
		this.plugin = plugin;
		this.language = "python";
		this.nextCellId = 1;
		this.cellsByLanguage = {
			python: this.createDefaultCells("python"),
			r: this.createDefaultCells("r"),
		};
		this.activeRunId = "";
		this.activeCellId = "";
		this.stopRequested = false;
		this.runningAll = false;
		this.executionCounter = 0;
		this.relatedNotePath = "";
		this.notebookControls = null;
	}

	createCell(code = "", placeholder = ""): CodePracticeCell {
		return { id: `cell-${this.nextCellId++}`, code, placeholder, result: null, executionCount: null };
	}

	createDefaultCells(language: PracticeLanguage): CodePracticeCell[] {
		return language === "r"
			? [this.createCell("", "values <- c(1, 2, 3, 4)"), this.createCell("", "mean(values)")]
			: [this.createCell("", "values = [1, 2, 3, 4]"), this.createCell("", "sum(values) / len(values)")];
	}

	get cells(): CodePracticeCell[] {
		return this.cellsByLanguage[this.language];
	}

	getViewType(): string {
		return CODE_PRACTICE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "代码练习";
	}

	getIcon(): string {
		return "square-code";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		if (this.activeRunId) this.plugin.stopCodePractice(this.activeRunId);
		this.contentEl.empty();
	}

	setRelatedNote(file: TFile | null): void {
		this.relatedNotePath = file?.extension === "md" ? file.path : "";
		if (this.containerEl?.isConnected) this.render();
	}

	render(): void {
		const scrollTop = this.contentEl.scrollTop;
		const scrollLeft = this.contentEl.scrollLeft;
		this.contentEl.empty();
		this.contentEl.addClass("code-practice-view");
		const shell = this.contentEl.createDiv({ cls: "code-practice-shell" });
		this.renderHeader(shell);
		this.renderRuntime(shell);
		this.renderNotebook(shell);
		this.contentEl.scrollTop = scrollTop;
		this.contentEl.scrollLeft = scrollLeft;
		window.requestAnimationFrame(() => {
			if (!this.contentEl?.isConnected) return;
			this.contentEl.scrollTop = scrollTop;
			this.contentEl.scrollLeft = scrollLeft;
		});
	}

	renderHeader(parent: HTMLElement): void {
		const header = parent.createEl("header", { cls: "code-practice-header" });
		const title = header.createDiv({ cls: "code-practice-title" });
		title.createEl("p", { cls: "agent-dashboard-eyebrow", text: "本地运行" });
		title.createEl("h1", { text: "代码练习" });
		const context = header.createDiv({ cls: "code-practice-context" });
		context.createSpan({ cls: "code-practice-context-label", text: "关联笔记" });
		context.createSpan({
			cls: "code-practice-context-value",
			text: this.relatedNotePath ? this.relatedNotePath.replace(/\.md$/i, "") : "未关联",
			attr: { title: this.relatedNotePath || "打开练习视图前选中的 Markdown 笔记会显示在这里" },
		});
	}

	renderRuntime(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: "code-practice-runtime" });
		const warning = bar.createDiv({
			cls: "code-practice-security-notice",
			attr: { role: "note" },
		});
		setIcon(warning.createSpan(), "shield-alert");
		warning.createSpan({
			text: "仅运行可信代码：代码以当前用户权限在本机执行；规则拦截只用于减少误操作，不是安全沙箱。",
		});
		const languages = bar.createDiv({ cls: "code-practice-language-switch", attr: { "aria-label": "运行语言" } });
		[["python", "Python"], ["r", "R"]].forEach(([value, label]) => {
			const button = languages.createEl("button", {
				cls: value === this.language ? "is-active" : "",
				text: label,
				attr: { "aria-pressed": value === this.language ? "true" : "false" },
			});
			button.type = "button";
			button.disabled = Boolean(this.activeRunId);
			button.addEventListener("click", () => this.setLanguage(value as PracticeLanguage));
		});
		const details = bar.createDiv({ cls: "code-practice-runtime-details" });
		this.createRuntimeDetail(details, "解释器", this.currentInterpreter());
		this.createRuntimeDetail(details, "工作目录", "tool-library/output/code-practice/figures/<run-id>");
		this.createRuntimeDetail(details, "权限边界", "当前 Windows 用户；可访问工作目录外路径");
	}

	createRuntimeDetail(parent: HTMLElement, label: string, value: string): void {
		const detail = parent.createDiv({ cls: "code-practice-runtime-detail" });
		detail.createSpan({ text: label });
		detail.createEl("code", { text: value || "未配置", attr: { title: value || "未配置" } });
	}

	renderNotebook(parent: HTMLElement): void {
		const section = parent.createEl("section", { cls: "code-practice-notebook" });
		const toolbar = section.createDiv({ cls: "code-practice-toolbar" });
		const heading = toolbar.createDiv({ cls: "code-practice-notebook-heading" });
		heading.createEl("h2", { text: "练习单元格" });
		heading.createSpan({ text: "运行至当前单元格时，会在新进程中静默重放前置单元格。" });
		const commands = toolbar.createDiv({ cls: "code-practice-commands" });
		const add = this.createCommandButton(commands, "plus", "新增单元格");
		const run = this.createCommandButton(commands, "list-start", "全部运行", "mod-cta");
		const stop = this.createCommandButton(commands, "square", "停止", "mod-warning");
		const clear = this.createCommandButton(commands, "eraser", "清空输出");
		const clearCode = this.createCommandButton(commands, "file-x-2", "清空代码");
		const resetCells = this.createCommandButton(commands, "rows-2", "重置为两格");
		const save = this.createCommandButton(commands, "save", "保存练习");
		add.addEventListener("click", () => this.addCell(this.cells.length - 1));
		run.addEventListener("click", () => void this.runAllCells());
		stop.addEventListener("click", () => this.stopCode());
		clear.addEventListener("click", () => {
			this.cells.forEach((cell) => {
				cell.result = null;
				cell.executionCount = null;
			});
			this.render();
		});
		clearCode.addEventListener("click", () => this.clearAllCellCode());
		resetCells.addEventListener("click", () => this.resetCellsToTwo());
		save.addEventListener("click", () => this.openSaveModal());

		const list = section.createDiv({ cls: "code-practice-cell-list" });
		this.cells.forEach((cell, index) => this.renderCell(list, cell, index));
		const addFooter = section.createEl("button", {
			cls: "code-practice-add-cell",
			attr: { title: "在末尾新增单元格", "aria-label": "在末尾新增单元格" },
		});
		addFooter.type = "button";
		addFooter.disabled = Boolean(this.activeRunId);
		setIcon(addFooter, "plus");
		addFooter.createSpan({ text: "新增单元格" });
		addFooter.addEventListener("click", () => this.addCell(this.cells.length - 1));
		this.notebookControls = { add, run, stop, clear, clearCode, resetCells, save, addFooter };
		this.updateNotebookControls();
	}

	updateNotebookControls(): void {
		if (!this.notebookControls) return;
		const busy = Boolean(this.activeRunId);
		const { add, run, stop, clear, clearCode, resetCells, save, addFooter } = this.notebookControls;
		add.disabled = busy;
		addFooter.disabled = busy;
		run.disabled = busy || !this.cells.some((cell) => cell.code.trim());
		stop.disabled = !busy || this.stopRequested;
		clear.disabled = busy || !this.cells.some((cell) => cell.result);
		clearCode.disabled = busy || !this.cells.some((cell) => cell.code.trim());
		resetCells.disabled = busy || (this.cells.length === 2 && !this.cells.some((cell) => cell.code.trim() || cell.result));
		save.disabled = busy || !this.cells.some((cell) => cell.result && cell.result.status !== "running");
	}

	createCommandButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		className = "",
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: `code-practice-command ${className}`.trim(),
			attr: { title: label, "aria-label": label },
		});
		button.type = "button";
		setIcon(button, icon);
		button.createSpan({ text: label });
		return button;
	}

	renderCell(parent: HTMLElement, cell: CodePracticeCell, index: number): void {
		const article = parent.createEl("article", { cls: "code-practice-cell", attr: { "data-cell-id": cell.id } });
		if (cell.id === this.activeCellId) article.addClass("is-running");
		const inputRow = article.createDiv({ cls: "code-practice-cell-input-row" });
		const prompt = inputRow.createDiv({ cls: "code-practice-cell-prompt" });
		prompt.createSpan({ text: cell.id === this.activeCellId ? "In [*]:" : `In [${cell.executionCount ?? " "}]:` });
		const run = this.createIconButton(prompt, "play", "运行至此（Ctrl+Enter）");
		run.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
		run.disabled = Boolean(this.activeRunId) || !cell.code.trim();
		run.addEventListener("click", () => void this.runCell(cell.id));

		const body = inputRow.createDiv({ cls: "code-practice-cell-body" });
		const controls = body.createDiv({ cls: "code-practice-cell-controls" });
		const up = this.createIconButton(controls, "arrow-up", "上移单元格");
		const down = this.createIconButton(controls, "arrow-down", "下移单元格");
		const add = this.createIconButton(controls, "plus", "在下方新增单元格");
		const remove = this.createIconButton(controls, "trash-2", "删除单元格");
		up.disabled = Boolean(this.activeRunId) || index === 0;
		down.disabled = Boolean(this.activeRunId) || index === this.cells.length - 1;
		add.disabled = Boolean(this.activeRunId);
		remove.disabled = Boolean(this.activeRunId) || this.cells.length === 1;
		up.addEventListener("click", () => this.moveCell(index, index - 1));
		down.addEventListener("click", () => this.moveCell(index, index + 1));
		add.addEventListener("click", () => this.addCell(index));
		remove.addEventListener("click", () => this.removeCell(index));

		const editor = body.createEl("textarea", {
			cls: "code-practice-cell-editor",
			attr: {
				rows: "4",
				spellcheck: "false",
				placeholder: cell.placeholder || (this.language === "r" ? "# 在此输入 R 代码" : "# 在此输入 Python 代码"),
				"aria-label": `${this.language === "python" ? "Python" : "R"} 单元格 ${index + 1}`,
			},
		});
		editor.value = cell.code;
		editor.disabled = Boolean(this.activeRunId);
		this.resizeCellEditor(editor);
		editor.addEventListener("input", () => {
			cell.code = editor.value;
			this.resizeCellEditor(editor);
			this.invalidateCellsFrom(index);
			run.disabled = Boolean(this.activeRunId) || !cell.code.trim();
			this.updateNotebookControls();
		});
		editor.addEventListener("keydown", (event) => {
			const isRAssignmentShortcut = this.language === "r"
				&& event.altKey
				&& !event.ctrlKey
				&& !event.metaKey
				&& !event.shiftKey
				&& !event.isComposing
				&& (event.key === "-" || event.code === "Minus" || event.code === "NumpadSubtract");
			if (isRAssignmentShortcut) {
				event.preventDefault();
				event.stopPropagation();
				editor.setRangeText("<-", editor.selectionStart, editor.selectionEnd, "end");
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				return;
			}
			if (event.key === "Tab") {
				event.preventDefault();
				const start = editor.selectionStart;
				const end = editor.selectionEnd;
				editor.setRangeText("\t", start, end, "end");
				cell.code = editor.value;
				this.resizeCellEditor(editor);
				this.invalidateCellsFrom(index);
				run.disabled = Boolean(this.activeRunId) || !cell.code.trim();
				this.updateNotebookControls();
				return;
			}
			if (event.key !== "Enter" || this.activeRunId) return;
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				event.stopPropagation();
				void this.runCell(cell.id);
			} else if (event.shiftKey) {
				event.preventDefault();
				event.stopPropagation();
				void this.runCell(cell.id, true);
			}
		});

		const output = article.createDiv({ cls: "code-practice-cell-output" });
		this.renderCellOutput(output, cell);
	}

	resizeCellEditor(editor: HTMLTextAreaElement): void {
		const minimumHeight = 132;
		const maximumHeight = Math.max(240, Math.min(520, Math.round(window.innerHeight * 0.6)));
		editor.style.height = `${minimumHeight}px`;
		const contentHeight = editor.scrollHeight;
		editor.style.height = `${Math.min(Math.max(contentHeight, minimumHeight), maximumHeight)}px`;
		editor.style.overflowY = contentHeight > maximumHeight ? "auto" : "hidden";
	}

	createIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "code-practice-icon-button",
			attr: { title: label, "aria-label": label },
		});
		button.type = "button";
		setIcon(button, icon);
		return button;
	}

	renderCellOutput(parent: HTMLElement, cell: CodePracticeCell): void {
		if (!cell.result) return;
		const row = parent.createDiv({ cls: "code-practice-cell-output-row" });
		const prompt = row.createDiv({ cls: "code-practice-cell-prompt is-output" });
		prompt.createSpan({ text: `Out [${cell.executionCount ?? " "}]:` });
		const content = row.createDiv({ cls: "code-practice-cell-result" });
		const heading = content.createDiv({ cls: "code-practice-output-heading" });
		const status = cell.result.status || "idle";
		heading.createSpan({ cls: `code-practice-status code-practice-status-${status}`, text: this.displayStatus(status) });
		const summary = heading.createSpan({ cls: "code-practice-cell-summary" });
		summary.setText(`${this.formatDuration(cell.result.duration_ms)} · 退出码 ${cell.result.exit_code ?? "-"}`);
		if (cell.result.stdout) this.renderStream(content, "标准输出", cell.result.stdout);
		if (cell.result.stderr) {
			const stderr = this.stderrPresentation(status);
			this.renderStream(content, stderr.title, cell.result.stderr, stderr.tone);
		}
		this.renderFigures(content, cell.result.figures || []);
	}

	stderrPresentation(status: PracticeStatus): { title: string; tone: string } {
		if (["failed", "timeout"].includes(status)) return { title: "错误与诊断（stderr）", tone: "error" };
		if (status === "stopped") return { title: "运行消息（stderr）", tone: "message" };
		return { title: "消息与警告（stderr）", tone: "message" };
	}

	renderStream(
		parent: HTMLElement,
		title: string,
		value: string,
		tone = "output",
	): void {
		const block = parent.createDiv({ cls: `code-practice-stream is-${tone}` });
		block.createEl("h3", { text: title });
		block.createEl("pre", { text: value || "（无）" });
	}

	renderFigures(parent: HTMLElement, figures: string[]): void {
		if (!figures.length) return;
		const block = parent.createDiv({ cls: "code-practice-figures" });
		block.createEl("h3", { text: "生成图片" });
		const grid = block.createDiv({ cls: "code-practice-figure-grid" });
		figures.forEach((figurePath) => {
			const item = grid.createEl("figure");
			const dataUrl = this.plugin.readPracticeFigure(figurePath);
			if (dataUrl) item.createEl("img", { attr: { src: dataUrl, alt: path.basename(figurePath) } });
			item.createEl("figcaption", { text: figurePath, attr: { title: figurePath } });
		});
	}

	setLanguage(language: PracticeLanguage): void {
		if (this.activeRunId || language === this.language) return;
		this.language = language;
		this.render();
	}

	currentInterpreter(): string {
		return this.language === "python" ? this.plugin.settings.pythonExecutable : this.plugin.settings.rscriptExecutable;
	}

	invalidateCellsFrom(index: number): void {
		this.cells.slice(index).forEach((candidate) => {
			candidate.result = null;
			candidate.executionCount = null;
			const output = this.contentEl.querySelector<HTMLElement>(
				`[data-cell-id="${candidate.id}"] .code-practice-cell-output`,
			);
			if (output) output.empty();
		});
	}

	clearAllCellCode(): void {
		if (this.activeRunId) return;
		this.cells.forEach((cell) => {
			cell.code = "";
			cell.result = null;
			cell.executionCount = null;
		});
		this.render();
		new Notice("已清空当前语言的代码和输出");
	}

	resetCellsToTwo(): void {
		if (this.activeRunId) return;
		this.cellsByLanguage[this.language] = this.createDefaultCells(this.language);
		this.render();
		new Notice("已重置为两个空单元格");
	}

	addCell(afterIndex: number): void {
		if (this.activeRunId) return;
		const cell = this.createCell("", this.language === "r" ? "# 在此输入 R 代码" : "# 在此输入 Python 代码");
		this.cells.splice(afterIndex + 1, 0, cell);
		this.render();
		this.focusCell(cell.id);
	}

	removeCell(index: number): void {
		if (this.activeRunId || this.cells.length === 1) return;
		this.cells.splice(index, 1);
		this.invalidateCellsFrom(index);
		this.render();
		this.focusCell(this.cells[Math.min(index, this.cells.length - 1)].id);
	}

	moveCell(from: number, to: number): void {
		if (this.activeRunId || to < 0 || to >= this.cells.length) return;
		const [cell] = this.cells.splice(from, 1);
		this.cells.splice(to, 0, cell);
		this.invalidateCellsFrom(Math.min(from, to));
		this.render();
		this.focusCell(cell.id);
	}

	focusCell(cellId: string): void {
		window.setTimeout(() => {
			this.contentEl.querySelector<HTMLTextAreaElement>(
				`[data-cell-id="${cellId}"] .code-practice-cell-editor`,
			)?.focus();
		}, 0);
	}

	async runCell(
		cellId: string,
		focusNext = false,
	): Promise<CodePracticeResult | null> {
		if (this.activeRunId) return null;
		const index = this.cells.findIndex((cell) => cell.id === cellId);
		if (index < 0) return null;
		const cell = this.cells[index];
		const code = cell.code.trimEnd();
		if (!code.trim()) {
			new Notice("请输入代码");
			return null;
		}
		const contextCode = this.cells
			.slice(0, index)
			.filter((candidate) => candidate.code.trim())
			.map((candidate, contextIndex) => `# --- replayed cell ${contextIndex + 1} ---\n${candidate.code.trimEnd()}`)
			.join("\n\n");
		this.activeRunId = this.plugin.createPracticeRunId();
		this.activeCellId = cell.id;
		this.stopRequested = false;
		cell.result = {
			run_id: this.activeRunId,
			status: "running",
			language: this.language,
			exit_code: null,
			duration_ms: 0,
			stdout: "",
			stderr: "",
			figures: [],
		};
		this.render();
		try {
			cell.result = await this.plugin.runCodePractice({
				run_id: this.activeRunId,
				language: this.language,
				context_code: contextCode,
				code,
				working_directory: "tool-library/output/code-practice",
				timeout_seconds: this.plugin.settings.codePracticeTimeoutSeconds,
			});
		} catch (error) {
			cell.result = {
				run_id: this.activeRunId,
				status: "failed",
				language: this.language,
				exit_code: null,
				duration_ms: 0,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				figures: [],
			};
		} finally {
			this.executionCounter += 1;
			cell.executionCount = this.executionCounter;
			this.activeRunId = "";
			this.activeCellId = "";
			this.stopRequested = false;
			this.render();
			if (focusNext) {
				if (index === this.cells.length - 1) this.addCell(index);
				else this.focusCell(this.cells[index + 1].id);
			}
		}
		return cell.result;
	}

	async runAllCells(): Promise<void> {
		if (this.activeRunId || this.runningAll) return;
		this.runningAll = true;
		try {
			for (const cell of [...this.cells]) {
				if (!cell.code.trim()) continue;
				const result = await this.runCell(cell.id);
				if (!result || result.status !== "success") break;
			}
		} finally {
			this.runningAll = false;
			this.render();
		}
	}

	stopCode(): void {
		if (!this.activeRunId || this.stopRequested) return;
		this.stopRequested = true;
		this.plugin.stopCodePractice(this.activeRunId);
		new Notice("正在停止代码练习");
		this.render();
	}

	openSaveModal(): void {
		if (this.activeRunId || !this.cells.some((cell) => cell.result)) return;
		const defaultTitle = `${this.language === "python" ? "Python" : "R"} 练习 ${new Date().toLocaleDateString("zh-CN")}`;
		new PracticeNoteModal(this.app, defaultTitle, async (form) => {
			try {
				const file = await this.plugin.savePracticeNote({
					...form,
					language: this.language,
					cells: this.cells.map((cell) => ({
						code: cell.code,
						result: cell.result,
						executionCount: cell.executionCount,
					})),
					relatedNotePath: this.relatedNotePath,
				});
				new Notice(`已保存：${file.path}`);
				await this.app.workspace.getLeaf(true).openFile(file);
			} catch (error) {
				new Notice(`保存失败：${error instanceof Error ? error.message : String(error)}`, 8000);
			}
		}).open();
	}

	displayStatus(status: PracticeStatus): string {
		return {
			idle: "未运行",
			running: this.stopRequested ? "正在停止" : "运行中",
			success: "成功",
			failed: "失败",
			timeout: "已超时",
			stopped: "已停止",
		}[status] || status;
	}

	formatDuration(durationMs: number): string {
		if (!Number.isFinite(Number(durationMs))) return "-";
		return Number(durationMs) < 1000 ? `${durationMs} ms` : `${(Number(durationMs) / 1000).toFixed(2)} s`;
	}
}
