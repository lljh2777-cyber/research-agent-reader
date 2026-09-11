import { ItemView, type WorkspaceLeaf } from "obsidian";
import { associationLabel, filterLibrary, LibraryBrowserController, libraryRowContext, paperStateLabel, sourceFormatLabel, type LibraryFilter } from "../library/browser";
import type { LibraryReadResult } from "../library/reader";
import type { LibraryObjectSummary, LibraryPaper } from "../library/types";
import type { LearningEntry } from "../learning/entry";

export const PAPER_LIBRARY_VIEW_TYPE = "research-paper-library";
export interface PaperLibraryHost {
	inspectPaperLibrary(signal?: AbortSignal, verifyMineruPath?: string): Promise<LibraryReadResult>;
	openLibraryObject(item: LibraryObjectSummary, read: boolean, signal: AbortSignal): Promise<void>;
	activateLearningSpace(entry?: LearningEntry): Promise<void>;
}

export class PaperLibraryView extends ItemView {
	private browser: LibraryBrowserController;
	private query = "";
	private filter: LibraryFilter = "all";
	private selectedKey = "";
	private selectionAfterScan?: { kind: string; id: string };
	private limit = 40;
	private action?: AbortController;
	private closed = false;
	private message = "";
	private list?: HTMLElement;
	private detail?: HTMLElement;
	private status?: HTMLElement;
	private summary?: HTMLElement;
	private refreshButton?: HTMLButtonElement;
	private spaceButton?: HTMLButtonElement;
	private cancelButton?: HTMLButtonElement;
	constructor(leaf: WorkspaceLeaf, private readonly host: PaperLibraryHost) {
		super(leaf);
		this.browser = new LibraryBrowserController((signal, verifyPath) => this.host.inspectPaperLibrary(signal, verifyPath), () => this.renderResults());
	}
	getViewType(): string { return PAPER_LIBRARY_VIEW_TYPE; }
	getDisplayText(): string { return "文献库"; }
	getIcon(): string { return "library-big"; }
	getState(): Record<string, unknown> { return { query: this.query, filter: this.filter, selectedKey: this.selectedKey }; }
	async setState(raw: unknown): Promise<void> {
		const state = raw as Record<string, unknown> | undefined;
		this.query = typeof state?.query === "string" ? state.query.slice(0, 500) : "";
		this.filter = ["all", "sources", "sessions", "issues"].includes(String(state?.filter)) ? state!.filter as LibraryFilter : "all";
		this.selectedKey = typeof state?.selectedKey === "string" ? state.selectedKey.slice(0, 2048) : "";
		this.renderShell();
	}
	async onOpen(): Promise<void> { this.closed = false; this.renderShell(); await this.browser.refresh(); }
	async onClose(): Promise<void> { this.closed = true; this.browser.dispose(); this.action?.abort(); this.contentEl.empty(); }
	private button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement {
		const button = parent.createEl("button", { text, attr: { type: "button" } }); button.onclick = run; return button;
	}
	private saveView(): void { this.app.workspace.requestSaveLayout(); }
	private renderShell(): void {
		if (this.closed) return;
		this.contentEl.empty(); this.contentEl.addClass("rar-library");
		const header = this.contentEl.createDiv("rar-library-header"), heading = header.createDiv();
		heading.createEl("h1", { text: "文献库" }); heading.createEl("p", { text: "找到资料，继续阅读，回看已保存的笔记。", cls: "rar-library-muted" });
		const actions = header.createDiv("rar-library-actions");
		this.spaceButton = this.button(actions, "阅读空间", () => { void this.run(signal => { signal.throwIfAborted(); return this.host.activateLearningSpace({ kind: "document" }); }); });
		this.refreshButton = this.button(actions, "刷新文献库", () => { this.message = ""; void this.browser.refresh(); });
		this.cancelButton = this.button(actions, "取消扫描", () => { if (this.action) this.action.abort(); else this.browser.cancel(); });
		const tools = this.contentEl.createDiv("rar-library-tools");
		const search = tools.createEl("input", { type: "search", placeholder: "搜索标题、DOI、citekey 或路径", attr: { "aria-label": "搜索文献库", maxlength: "500" } });
		search.value = this.query; search.oninput = () => { this.query = search.value; this.limit = 40; this.renderResults(); this.saveView(); };
		const filter = tools.createEl("select", { attr: { "aria-label": "筛选文献记录" } });
		for (const [value, text] of [["all", "全部记录"], ["sources", "有原文记录"], ["sessions", "有阅读会话"], ["issues", "待关联或有缺口"]]) filter.createEl("option", { value, text });
		filter.value = this.filter; filter.onchange = () => { this.filter = filter.value as LibraryFilter; this.limit = 40; this.renderResults(); this.saveView(); };
		this.status = this.contentEl.createDiv({ cls: "rar-library-status", attr: { role: "status", "aria-live": "polite" } });
		const body = this.contentEl.createDiv("rar-library-body"), sidebar = body.createDiv("rar-library-sidebar");
		this.summary = sidebar.createDiv("rar-library-summary");
		this.list = sidebar.createDiv({ cls: "rar-library-list", attr: { "aria-label": "文献与待关联记录" } });
		this.detail = body.createEl("section", { cls: "rar-library-detail", attr: { "aria-label": "文献详情" } });
		this.renderResults();
	}
	private renderResults(): void {
		if (this.closed || !this.list || !this.detail || !this.status || !this.summary) return;
		const state = this.browser.state, data = state.result;
		if (state.phase === "failed" || state.phase === "cancelled") this.selectionAfterScan = undefined;
		if (state.phase === "ready" && this.selectionAfterScan) {
			const anchor = this.selectionAfterScan;
			this.selectedKey = data?.papers.find(paper => paper.objects.some(item => item.kind === anchor.kind && item.id === anchor.id))?.key || this.selectedKey;
			this.selectionAfterScan = undefined; this.saveView();
		}
		this.contentEl.setAttribute("aria-busy", String(this.browser.busy));
		this.refreshButton!.disabled = this.browser.busy || Boolean(this.action);
		this.spaceButton!.disabled = this.browser.busy || Boolean(this.action);
		this.cancelButton!.hidden = !this.browser.busy && !this.action;
		this.cancelButton!.setText(this.action ? "取消打开" : "取消扫描");
		this.cancelButton!.disabled = !this.action && state.phase !== "loading";
		this.status.empty();
		const phase = state.phase === "loading" ? "正在读取本地文献记录…" : state.phase === "failed" ? "读取失败：" + state.error : state.phase === "cancelled" ? "扫描已取消" : "";
		if (phase) this.status.createDiv({ text: phase + (data ? "；以下保留上次读取结果。" : "") });
		if (data && state.phase === "ready") this.status.createDiv({ text: `${data.papers.length} 条文献及待关联记录 · 本次读取 ${data.stats.filesRead} 个文件${data.complete ? "" : " · 部分内容未能完整读取"}` });
		if (this.message) this.status.createDiv({ text: this.message });
		if (data?.readIssues.length) {
			const issues = this.status.createEl("details"); issues.createEl("summary", { text: `查看 ${data.readIssues.length} 条读取提示` });
			for (const issue of data.readIssues.slice(0, 100)) issues.createEl("p", { text: `${issue.path}：${issue.message}` });
			if (data.readIssues.length > 100) issues.createEl("p", { text: "仅展示前 100 条提示。请按记录检查其余缺口。" });
		}
		const papers = filterLibrary(data?.papers || [], this.query, this.filter);
		this.summary.setText(`${papers.length} 条匹配记录`); this.list.empty();
		for (const paper of papers.slice(0, this.limit)) {
			const row = this.button(this.list, "", () => { this.selectedKey = paper.key; this.message = ""; this.renderResults(); this.saveView(); });
			row.className = "rar-library-row"; row.dataset.paperKey = paper.key; row.setAttribute("aria-pressed", String(paper.key === this.selectedKey));
			row.createSpan({ text: paper.title, cls: "rar-library-row-title" });
			row.createSpan({ text: `${associationLabel(paper)} · ${paper.objects.length} 项内容`, cls: "rar-library-muted" });
			row.createSpan({ text: libraryRowContext(paper), cls: "rar-library-row-context" });
		}
		if (papers.length > this.limit) this.button(this.list, "显示更多记录", () => { this.limit += 40; this.renderResults(); });
		if (!papers.length && state.phase !== "loading") this.list.createEl("p", { text: data?.papers.length ? "没有匹配结果，可修改关键词或筛选。" : "还没有可展示的文献记录。可从控制台添加文献。", cls: "rar-library-muted" });
		const selected = data?.papers.find(paper => paper.key === this.selectedKey);
		this.detail.empty();
		if (selected) this.renderPaper(selected, data!);
		else this.detail.createEl("p", { text: this.selectedKey ? "此记录已不在本次读取结果中，请重新选择。" : "选择左侧记录，查看原文版本、阅读会话和笔记。", cls: "rar-library-empty" });
	}
	private renderPaper(paper: LibraryPaper, data: LibraryReadResult): void {
		const detail = this.detail!;
		detail.createEl("h2", { text: paper.title });
		detail.createEl("p", { text: `${associationLabel(paper)} · ${paperStateLabel(paper.readingState)}`, cls: "rar-library-muted" });
		const identifiers = [...Object.entries(paper.identifiers).map(([key, value]) => `${key.toUpperCase()}：${value}`), ...(paper.citekey ? [`citekey：${paper.citekey}`] : [])];
		if (identifiers.length) detail.createEl("p", { text: identifiers.join(" · "), cls: "rar-library-identifiers" });
		for (const diagnostic of data.diagnostics.filter(item => paper.diagnosticIds.includes(item.id))) detail.createEl("p", { text: diagnostic.message, cls: "rar-library-warning" });
		for (const [kind, title] of [["source", "原文与版本"], ["session", "阅读会话"], ["note", "论文笔记"], ["annotation", "批注"], ["acquisition", "获取记录"]] as const) {
			const objects = paper.objects.filter(item => item.kind === kind); if (!objects.length) continue;
			const section = detail.createEl("section", { cls: "rar-library-section" }); section.createEl("h3", { text: `${title} · ${objects.length}` });
			for (const item of objects) this.renderObject(section, item, paper);
		}
		if (paper.objects.every(item => item.kind === "record")) detail.createEl("p", { text: "已保存书目信息，尚无关联原文、阅读会话或笔记。" });
	}
	private renderObject(parent: HTMLElement, item: LibraryObjectSummary, paper: LibraryPaper): void {
		const card = parent.createDiv("rar-library-card"); card.dataset.objectId = item.id; card.dataset.objectKind = item.kind;
		card.createEl("h4", { text: item.title });
		const actions = card.createDiv("rar-library-actions");
		const open = (text: string, read = false) => { const button = this.button(actions, text, () => { void this.run(signal => this.host.openLibraryObject(item, read, signal)); }); button.disabled = this.browser.busy || Boolean(this.action); return button; };
		if (item.source) {
			const source = item.source, verification = source.verification;
			card.createEl("p", { text: `${sourceFormatLabel(source.format)} · ${verification.state === "verified" ? "本次来源校验通过" : verification.reason}`, cls: "rar-library-muted" });
			card.createEl("code", { text: source.path, cls: "rar-library-path" });
			if (source.sourceVersionId) card.createEl("p", { text: "来源版本：" + source.sourceVersionId, cls: "rar-library-path" });
			if (source.projectionId) card.createEl("p", { text: "正文投影：" + source.projectionId, cls: "rar-library-path" });
			if (item.capabilities?.openOriginal.available) open("打开原文");
			if (item.capabilities?.interactiveReading.available) open("开始／继续阅读", true);
			else if (verification.state === "verified") card.createEl("p", { text: item.capabilities?.interactiveReading.reason || "此格式暂未接入交互阅读", cls: "rar-library-muted" });
			if (source.format === "mineru" && verification.state === "unverified") {
				const verify = this.button(actions, "核验此原文", () => { this.message = ""; this.selectionAfterScan = { kind: item.kind, id: item.id }; void this.browser.refresh(source.path); }); verify.disabled = this.browser.busy || Boolean(this.action);
			}
		}
		if (item.reading) {
			const progress = item.reading;
			card.createEl("p", { text: `${progress.archived ? "已归档 · " : ""}主线已生成 ${progress.explanation.generated}${progress.explanation.planned === null ? "" : "/" + progress.explanation.planned} 单元 · 已理解 ${progress.learning.understood} · 待回看 ${progress.learning.revisit} · ${progress.questionCount === null ? "疑问尚未标记" : "已标记疑问 " + progress.questionCount}`, cls: "rar-library-muted" });
			card.createEl("code", { text: progress.source.path, cls: "rar-library-path" });
			if (item.binding?.state !== "matched") card.createEl("p", { text: item.binding?.reason || "当前来源未关联，可查看历史；继续生成时重新核验原文。", cls: "rar-library-warning" });
			open(item.binding?.state === "matched" ? "继续此会话" : "查看历史会话", true);
		}
		if (item.kind === "note") {
			card.createEl("p", { text: `${paper.primaryNoteId === item.id ? "主要笔记 · " : ""}${item.noteReview?.state === "reviewed" ? "保存的人工审阅标记" : item.noteReview?.state === "stale" ? "正文已变，需复查" : "未记录人工审阅"}`, cls: "rar-library-muted" });
			card.createEl("code", { text: item.id, cls: "rar-library-path" }); open("打开笔记");
		}
		if (item.kind === "annotation") { card.createEl("p", { text: item.binding?.reason || "保留批注的原始来源信息", cls: "rar-library-muted" }); if (item.annotationPath) open("打开批注文件"); }
		if (item.acquisitionPhase) card.createEl("p", { text: "获取状态：" + item.acquisitionPhase });
	}
	private async run(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.action || this.closed || this.browser.busy) return;
		const controller = new AbortController(); this.action = controller; this.message = "正在打开所选内容…"; this.renderResults();
		try { await operation(controller.signal); if (!this.closed) this.message = ""; }
		catch (error) { if (!this.closed) this.message = "未能打开：" + (error instanceof Error ? error.message : String(error)); }
		finally { this.action = undefined; if (!this.closed) this.renderResults(); }
	}
}
