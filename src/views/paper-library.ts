import { ItemView, type WorkspaceLeaf } from "obsidian";
import { associationLabel, filterLibrary, LibraryBrowserController, libraryRowContext, paperStateLabel, sourceFormatLabel, type LibraryFilter } from "../library/browser";
import type { LibraryReadResult } from "../library/reader";
import type { LibraryObjectSummary, LibraryPaper } from "../library/types";
import type { LearningEntry } from "../learning/entry";
import { PAPER_READING_STATES, readingStateBlockReason, ReadingStateEditor, type ReadingStateHost } from "../library/reading-state-editor";
import { PrimaryNoteEditor, primaryNoteCandidates, savedPrimaryNote } from "../library/primary-note-editor";
import type { LibraryCodeLink } from "../library/code-links";
import { renderBibliography } from "./bibliography";
import { renderManualBibliography } from "./manual-bibliography";
import { continuationBlockReason } from "../library/paper-continuation";

export const PAPER_LIBRARY_VIEW_TYPE = "research-paper-library";
export interface PaperLibraryHost extends ReadingStateHost {
	inspectPaperLibrary(signal?: AbortSignal, verifyMineruPath?: string): Promise<LibraryReadResult>;
	openLibraryObject(item: LibraryObjectSummary, read: boolean, signal: AbortSignal): Promise<void>;
	openLibraryCodeLink(paperKey: string, link: LibraryCodeLink, signal: AbortSignal): Promise<void>;
	activateLearningSpace(entry?: LearningEntry): Promise<void>;
	openPaperIntake(): void;
	queryManualPaper(item: LibraryObjectSummary, signal: AbortSignal): Promise<void>;
	continuePaperIntake(paper: LibraryPaper, kind: "local" | "fulltext", signal: AbortSignal): Promise<void>;
	processLibrarySource(item: LibraryObjectSummary, signal: AbortSignal): Promise<void>;
}

export class PaperLibraryView extends ItemView {
	private browser: LibraryBrowserController;
	private readingEditor: ReadingStateEditor;
	private primaryEditor: PrimaryNoteEditor;
	private get editingRecord(): boolean { return this.readingEditor.active || this.primaryEditor.active; }
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
	private addButton?: HTMLButtonElement;
	private cancelButton?: HTMLButtonElement;
	constructor(leaf: WorkspaceLeaf, private readonly host: PaperLibraryHost) {
		super(leaf);
		this.browser = new LibraryBrowserController((signal, verifyPath) => this.host.inspectPaperLibrary(signal, verifyPath), () => this.renderResults());
		this.readingEditor = new ReadingStateEditor(this.host, () => this.renderResults());
		this.primaryEditor = new PrimaryNoteEditor(this.host, () => this.renderResults());
	}
	getViewType(): string { return PAPER_LIBRARY_VIEW_TYPE; }
	getDisplayText(): string { return "文献库"; }
	getIcon(): string { return "library-big"; }
	getState(): Record<string, unknown> { return { query: this.query, filter: this.filter, selectedKey: this.selectedKey }; }
	async setState(raw: unknown): Promise<void> {
		if (this.editingRecord) return;
		const state = raw as Record<string, unknown> | undefined;
		this.query = typeof state?.query === "string" ? state.query.slice(0, 500) : "";
		this.filter = ["all", "sources", "sessions", "issues"].includes(String(state?.filter)) ? state!.filter as LibraryFilter : "all";
		this.selectedKey = typeof state?.selectedKey === "string" ? state.selectedKey.slice(0, 2048) : "";
		this.renderShell();
	}
	async onOpen(): Promise<void> { this.closed = false; this.renderShell(); await this.browser.refresh(); }
	async onClose(): Promise<void> { this.closed = true; this.browser.dispose(); this.readingEditor.dispose(); this.primaryEditor.dispose(); this.action?.abort(); this.contentEl.empty(); }
	async revealPaper(paperId: string): Promise<void> {
		if (this.closed || this.editingRecord || this.action) throw new Error("请先结束当前文献操作后再打开记录");
		await this.browser.refresh();
		if (this.closed) throw new Error("文献库已关闭");
		if (this.browser.state.phase !== "ready") throw new Error("文献库刷新未完成，请重新打开已保存记录");
		const matches = this.browser.state.result?.papers.filter(paper => paper.paperId === paperId) || [];
		if (matches.length !== 1) throw new Error("已保存记录未能唯一定位，请查看文献库读取提示");
		if (this.editingRecord || this.action) throw new Error("请先结束当前文献操作后再打开记录");
		this.query = Object.values(matches[0].identifiers)[0] || ""; this.filter = "all"; this.selectedKey = matches[0].key; this.message = ""; this.renderShell(); this.saveView();
	}
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
		this.addButton = this.button(actions, "添加文献", () => this.host.openPaperIntake());
		this.spaceButton = this.button(actions, "阅读空间", () => { void this.run(signal => { signal.throwIfAborted(); return this.host.activateLearningSpace({ kind: "document" }); }); });
		this.refreshButton = this.button(actions, "刷新文献库", () => { if (this.editingRecord) return; this.message = ""; void this.browser.refresh(); });
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
		this.contentEl.setAttribute("aria-busy", String(this.browser.busy || Boolean(this.action) || [this.readingEditor.state.phase, this.primaryEditor.state.phase].some(phase => phase === "preparing" || phase === "saving")));
		this.refreshButton!.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord;
		this.spaceButton!.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord;
		this.addButton!.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord;
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
			const row = this.button(this.list, "", () => { if (this.editingRecord || this.action) return; this.selectedKey = paper.key; this.message = ""; this.renderResults(); this.saveView(); });
			row.disabled = this.editingRecord || Boolean(this.action);
			row.className = "rar-library-row"; row.dataset.paperKey = paper.key; row.setAttribute("aria-pressed", String(paper.key === this.selectedKey));
			row.createSpan({ text: paper.title, cls: "rar-library-row-title" });
			row.createSpan({ text: `${associationLabel(paper)} · ${paper.objects.length} 项内容`, cls: "rar-library-muted" });
			row.createSpan({ text: paperStateLabel(paper.readingState), cls: "rar-library-muted" });
			row.createSpan({ text: libraryRowContext(paper), cls: "rar-library-row-context" });
		}
		if (papers.length > this.limit) this.button(this.list, "显示更多记录", () => { this.limit += 40; this.renderResults(); });
		if (!papers.length && state.phase !== "loading") this.list.createEl("p", { text: data?.papers.length ? "没有匹配结果，可修改关键词或筛选。" : "还没有可展示的文献记录。可通过上方“添加文献”查询并保存。", cls: "rar-library-muted" });
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
		const bibliography = paper.objects.find(item => item.kind === "record" && item.bibliography)?.bibliography;
		if (bibliography) renderBibliography(detail, bibliography);
		const manual = paper.objects.find(item => item.kind === "record" && item.manualBibliography);
		if (manual?.manualBibliography) {
			renderManualBibliography(detail, manual.manualBibliography);
			const query = this.button(detail, "重新查询书目信息", () => { void this.run(signal => this.host.queryManualPaper(manual, signal)); });
			query.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord || this.browser.state.phase !== "ready" || paper.association === "conflict";
		}
		for (const diagnostic of data.diagnostics.filter(item => paper.diagnosticIds.includes(item.id))) detail.createEl("p", { text: diagnostic.message, cls: "rar-library-warning" });
		const intake = detail.createEl("section", { cls: "rar-library-section", attr: { "aria-label": "补充原文与继续处理" } });
		intake.createEl("h3", { text: "补充原文与继续处理" });
		const reason = continuationBlockReason(paper, data);
		intake.createEl("p", { text: reason || "沿用已保存的书目信息。可添加原文，或在下一窗口继续此文献的获取、核对与登记。", cls: "rar-library-muted" });
		const actions = intake.createDiv("rar-library-actions");
		for (const [kind, label] of [["fulltext", "查找全文 / 继续获取"], ["local", "添加本地 PDF / 恢复登记"]] as const) {
			const button = this.button(actions, label, () => { void this.run(signal => this.host.continuePaperIntake(paper, kind, signal)); });
			button.disabled = Boolean(reason) || this.browser.busy || Boolean(this.action) || this.editingRecord || this.browser.state.phase !== "ready";
		}
		this.renderReadingState(detail, paper, data);
		this.renderPrimaryNote(detail, paper, data);
		this.renderCodeLinks(detail, paper, data);
		for (const [kind, title] of [["source", "原文与版本"], ["session", "阅读会话"], ["note", "论文笔记"], ["annotation", "批注"], ["acquisition", "获取记录"]] as const) {
			const objects = paper.objects.filter(item => item.kind === kind); if (!objects.length) continue;
			const section = detail.createEl("section", { cls: "rar-library-section" }); section.createEl("h3", { text: `${title} · ${objects.length}` });
			for (const item of objects) this.renderObject(section, item, paper);
		}
		if (paper.objects.every(item => item.kind === "record")) detail.createEl("p", { text: manual ? "已保存人工条目，尚无已核验的书目信息或关联原文。" : "已保存书目信息，尚无关联原文、阅读会话或笔记。" });
	}
	private renderCodeLinks(parent: HTMLElement, paper: LibraryPaper, data: LibraryReadResult): void {
		const section = parent.createEl("section", { cls: "rar-library-section rar-library-code-links", attr: { "aria-label": "关联代码笔记" } });
		section.createEl("h3", { text: "关联代码笔记" });
		section.createEl("p", { text: "依据 Obsidian 链接缓存，与论文笔记直接相连；不代表论文官方实现或代码已运行。", cls: "rar-library-muted" });
		for (const issue of data.codeLinks?.issues || []) section.createEl("p", { text: issue, cls: "rar-library-warning" });
		const rows = data.codeLinks?.byPaper[paper.key] || [];
		if (!rows.length) section.createEl("p", { text: paper.association === "conflict" ? "文献身份存在冲突，暂不展示代码关联。" : !data.codeLinks ? "代码关联尚未读取，请刷新文献库。" : "本次缓存中未找到直接关联。可在代码笔记中链接论文笔记，或在代码学习导出时选择关联笔记，再刷新文献库。", cls: "rar-library-muted" });
		for (const row of rows.slice(0, 100)) {
			const card = section.createEl("article", { cls: "rar-library-card" });
			card.createEl("strong", { text: row.kind === "code-export" ? "代码学习导出" : "代码项目／脚本笔记" });
			card.createEl("code", { text: row.path, cls: "rar-library-path" });
			card.createEl("p", { text: `${row.direction === "from-paper" ? "论文笔记链接到此处" : "此处链接到论文笔记"}：${row.notePath}`, cls: "rar-library-muted" });
			const open = this.button(card, "打开代码笔记", () => { void this.run(signal => this.host.openLibraryCodeLink(paper.key, row, signal)); });
			open.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord || this.browser.state.phase !== "ready";
		}
		if (rows.length > 100) section.createEl("p", { text: `共 ${rows.length} 条关联，当前展示前 100 条。`, cls: "rar-library-muted" });
	}
	private renderReadingState(parent: HTMLElement, paper: LibraryPaper, data: LibraryReadResult): void {
		const section = parent.createEl("section", { cls: "rar-library-section rar-library-reading-state", attr: { "aria-label": "人工阅读状态" } });
		section.createEl("h3", { text: "我的阅读状态" });
		section.createEl("p", { text: "由你手动标记，与讲解生成量、节点理解和证据审阅分别记录。", cls: "rar-library-muted" });
		const state = this.readingEditor.state;
		if (state.phase === "idle") {
			const reason = readingStateBlockReason(paper, data);
			if (reason) section.createEl("p", { text: reason, cls: "rar-library-warning" });
			else {
				const edit = this.button(section, "修改阅读状态", () => {
					if (this.browser.busy || this.action || this.editingRecord) return;
					this.message = ""; void this.readingEditor.begin(paper.paperId!);
				});
				edit.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord || this.browser.state.phase !== "ready";
			}
			return;
		}
		section.createEl("p", { text: "保存或取消当前编辑后，可切换文献或刷新。", cls: "rar-library-muted" });
		if (state.phase === "preparing") section.createEl("p", { text: "正在核对文献和人工记录…", attr: { role: "status" } });
		if (state.phase === "blocked") section.createEl("p", { text: state.error, cls: "rar-library-warning", attr: { role: "alert" } });
		const actions = section.createDiv("rar-library-actions");
		if (state.phase === "editing" || state.phase === "saving") {
			section.createEl("p", { text: "本次读取的状态：" + paperStateLabel(state.context.paper.readingState), cls: "rar-library-muted" });
			const select = actions.createEl("select", { attr: { "aria-label": "选择我的阅读状态" } });
			for (const value of PAPER_READING_STATES) select.createEl("option", { value, text: paperStateLabel(value) });
			select.value = state.value; select.disabled = state.phase === "saving";
			const save = this.button(actions, state.phase === "saving" ? "正在保存…" : "保存阅读状态", () => { void this.saveReadingState(); });
			save.disabled = !this.readingEditor.canSave;
			select.onchange = () => { this.readingEditor.setValue(select.value); save.disabled = !this.readingEditor.canSave; };
			if (state.error) {
				section.createEl("p", { text: "未确认保存成功：" + state.error, cls: "rar-library-warning", attr: { role: "alert" } });
				section.createEl("p", { text: "所选状态仍保留。可重试；若记录已变化，请取消编辑并刷新，核对最新内容后再保存。", cls: "rar-library-muted" });
			}
		}
		const cancel = this.button(actions, "取消编辑", () => this.readingEditor.cancel()); cancel.disabled = state.phase === "saving";
	}
	private async saveReadingState(): Promise<void> {
		const selectedKey = this.selectedKey;
		const saved = await this.readingEditor.save();
		if (!saved || this.closed) return;
		this.message = "已保存：" + paperStateLabel(saved.value) + "。正在刷新文献库…";
		await this.browser.refresh();
		if (this.closed) return;
		const data = this.browser.state.result, paper = data?.papers.find(item => item.paperId === saved.paperId);
		if (this.browser.state.phase === "ready" && paper && this.selectedKey === selectedKey) { this.selectedKey = paper.key; this.saveView(); }
		this.message = "已保存：" + paperStateLabel(saved.value) + "。";
		if (this.browser.state.phase !== "ready") this.message += "列表尚未刷新成功，请点击刷新文献库核对。";
		else if (!paper || paper.readingState !== saved.value || readingStateBlockReason(paper, data!)) this.message += "最新目录与本次保存不同或存在冲突，请核对读取提示。";
		this.renderResults();
	}
	private renderPrimaryNote(parent: HTMLElement, paper: LibraryPaper, data: LibraryReadResult): void {
		const section = parent.createEl("section", { cls: "rar-library-section rar-library-reading-state", attr: { "aria-label": "主要笔记" } });
		section.createEl("h3", { text: "主要笔记" });
		section.createEl("p", { text: "选择此文献常用的笔记，方便下次打开。选择只用于导航，不合并正文，也不改变审阅或来源版本。", cls: "rar-library-muted" });
		const state = this.primaryEditor.state;
		if (state.phase === "idle") {
			const current = paper.objects.find(item => item.kind === "note" && item.id === paper.primaryNoteId);
			if (current) {
				section.createEl("p", { text: current.title }); section.createEl("code", { text: current.id, cls: "rar-library-path" });
				const open = this.button(section, "打开主要笔记", () => { void this.run(signal => this.host.openLibraryObject(current, false, signal)); });
				open.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord;
			} else section.createEl("p", { text: data.diagnostics.some(item => paper.diagnosticIds.includes(item.id) && item.code === "primary_note_missing") ? "旧选择尚未关联，可重新选择或清除。" : "尚未选择主要笔记。", cls: "rar-library-muted" });
			const reason = readingStateBlockReason(paper, data)?.replace("阅读状态", "主要笔记");
			if (reason) section.createEl("p", { text: reason, cls: "rar-library-warning" });
			else {
				const edit = this.button(section, "选择主要笔记", () => {
					if (this.browser.busy || this.action || this.editingRecord) return;
					this.message = ""; void this.primaryEditor.begin(paper.paperId!);
				});
				edit.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord || this.browser.state.phase !== "ready";
			}
			return;
		}
		section.createEl("p", { text: "保存或取消当前编辑后，可切换文献或刷新。", cls: "rar-library-muted" });
		if (state.phase === "preparing") section.createEl("p", { text: "正在核对文献与候选笔记…", attr: { role: "status" } });
		if (state.phase === "blocked") section.createEl("p", { text: state.error, cls: "rar-library-warning", attr: { role: "alert" } });
		const actions = section.createDiv("rar-library-actions");
		if (state.phase === "editing" || state.phase === "saving") {
			const candidates = primaryNoteCandidates(state.context), previous = savedPrimaryNote(state.context);
			const select = actions.createEl("select", { attr: { "aria-label": "选择主要笔记文件" } });
			select.createEl("option", { value: "", text: "不设主要笔记（清除选择）" });
			for (const note of candidates) select.createEl("option", { value: note.id, text: `${note.title} · ${note.id}` });
			if (previous && !candidates.some(item => item.id === previous)) {
				select.createEl("option", { value: previous, text: "旧选择已失效：" + previous }).disabled = true;
				section.createEl("p", { text: "旧选择已失效，必须明确选另一份笔记或清除；不会自动替换。", cls: "rar-library-warning" });
			}
			if (!candidates.length) section.createEl("p", { text: "当前没有可靠关联的候选笔记。已有失效选择仍可明确清除。", cls: "rar-library-muted" });
			select.value = state.value ?? ""; select.disabled = state.phase === "saving";
			const chosen = section.createEl("code", { text: state.value ?? "不设主要笔记", cls: "rar-library-path" });
			const save = this.button(actions, state.phase === "saving" ? "正在保存…" : "保存主要笔记", () => { void this.savePrimaryNote(); });
			save.disabled = !this.primaryEditor.canSave;
			select.onchange = () => { this.primaryEditor.setValue(select.value || null); chosen.setText(select.value || "不设主要笔记"); save.disabled = !this.primaryEditor.canSave; };
			if (state.error) {
				section.createEl("p", { text: "未确认保存成功：" + state.error, cls: "rar-library-warning", attr: { role: "alert" } });
				section.createEl("p", { text: "所选笔记仍保留。可重试；若笔记或记录已变化，请取消编辑并刷新，核对后再保存。", cls: "rar-library-muted" });
			}
		}
		const cancel = this.button(actions, "取消选择", () => this.primaryEditor.cancel()); cancel.disabled = state.phase === "saving";
	}
	private async savePrimaryNote(): Promise<void> {
		const selectedKey = this.selectedKey, saved = await this.primaryEditor.save();
		if (!saved || this.closed) return;
		const message = saved.value ? "已保存主要笔记：" + saved.value + "。" : "已清除主要笔记选择。";
		this.message = message + "正在刷新文献库…"; await this.browser.refresh();
		if (this.closed) return;
		const data = this.browser.state.result, paper = data?.papers.find(item => item.paperId === saved.paperId);
		if (this.browser.state.phase === "ready" && paper && this.selectedKey === selectedKey) { this.selectedKey = paper.key; this.saveView(); }
		this.message = message;
		if (this.browser.state.phase !== "ready") this.message += "列表尚未刷新成功，请点击刷新文献库核对。";
		else if (!paper || (paper.primaryNoteId ?? null) !== saved.value || readingStateBlockReason(paper, data!) || data?.diagnostics.some(item => paper.diagnosticIds.includes(item.id) && item.code === "primary_note_missing")) this.message += "最新目录与本次保存不同或存在冲突，请核对读取提示。";
		this.renderResults();
	}
	private renderObject(parent: HTMLElement, item: LibraryObjectSummary, paper: LibraryPaper): void {
		const card = parent.createDiv("rar-library-card"); card.dataset.objectId = item.id; card.dataset.objectKind = item.kind;
		card.createEl("h4", { text: item.title });
		const actions = card.createDiv("rar-library-actions");
		const open = (text: string, read = false) => { const button = this.button(actions, text, () => { void this.run(signal => this.host.openLibraryObject(item, read, signal)); }); button.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord; return button; };
		if (item.source) {
			const source = item.source, verification = source.verification;
			card.createEl("p", { text: `${sourceFormatLabel(source.format)} · ${verification.state === "verified" ? "本次来源校验通过" : verification.reason}`, cls: "rar-library-muted" });
			card.createEl("code", { text: source.path, cls: "rar-library-path" });
			if (source.pdfOrigin) card.createEl("p", { text: source.pdfOrigin.reason + (source.pdfOrigin.state === "matched" ? `（${source.pdfOrigin.sourceIds.length} 份匹配 PDF）` : ""), cls: source.pdfOrigin.state === "matched" ? "rar-library-muted" : "rar-library-warning" });
			if (source.sourceVersionId) card.createEl("p", { text: "来源版本：" + source.sourceVersionId, cls: "rar-library-path" });
			if (source.projectionId) card.createEl("p", { text: "正文投影：" + source.projectionId, cls: "rar-library-path" });
			if (item.capabilities?.openOriginal.available) open("打开原文");
			if (source.packageKey && source.manifestDigest && verification.state === "verified" && (source.format === "pdf" || source.format === "jats")) {
				const process = this.button(actions, source.format === "pdf" ? "转换正文 / 生成初始笔记" : "生成 / 恢复初始笔记", () => { void this.run(signal => this.host.processLibrarySource(item, signal)); });
				process.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord || this.browser.state.phase !== "ready";
			}
			if (item.capabilities?.interactiveReading.available) open("开始／继续阅读", true);
			else if (verification.state === "verified") card.createEl("p", { text: item.capabilities?.interactiveReading.reason || "此格式暂未接入交互阅读", cls: "rar-library-muted" });
			if (source.format === "mineru" && verification.state === "unverified") {
				const verify = this.button(actions, "核验此原文", () => { if (this.editingRecord) return; this.message = ""; this.selectionAfterScan = { kind: item.kind, id: item.id }; void this.browser.refresh(source.path); }); verify.disabled = this.browser.busy || Boolean(this.action) || this.editingRecord;
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
		if (this.action || this.closed || this.browser.busy || this.editingRecord) return;
		const controller = new AbortController(); this.action = controller; this.message = "正在打开所选内容…"; this.renderResults();
		try { await operation(controller.signal); if (!this.closed) this.message = ""; }
		catch (error) { if (!this.closed) this.message = "未能打开：" + (error instanceof Error ? error.message : String(error)); }
		finally { this.action = undefined; if (!this.closed) this.renderResults(); }
	}
}
