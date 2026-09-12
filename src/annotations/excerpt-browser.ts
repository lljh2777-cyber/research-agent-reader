import { App, Modal, TFile, type WorkspaceLeaf } from "obsidian";
import { canOrganizeExcerpt, excerptOrganizationLabel, ExcerptLibraryService, type ExcerptList, type ExcerptRef, type ExcerptSnapshot } from "./excerpt-library";
import type { ExcerptHistoryHost } from "./excerpt-history";

/** Local, model-free excerpt browser. Drafts stay visible until explicitly saved or discarded. */
export class ExcerptBrowser extends Modal {
	private readonly service: ExcerptLibraryService;
	private data: ExcerptList = { entries: [], issues: [] };
	private selected?: ExcerptSnapshot;
	private draft = "";
	private query = "";
	private filter = "all";
	private limit = 50;
	private closed = true;
	private busy = false;
	private action?: AbortController;
	private statusAction?: AbortController;
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private messageEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private refreshEl!: HTMLButtonElement;
	private get dirty(): boolean { return Boolean(this.selected && this.draft !== this.selected.record.manualText); }
	constructor(app: App, private readonly initial?: ExcerptRef, private readonly didClose?: () => void, openMarkdown?: (file: TFile) => Promise<WorkspaceLeaf>, private readonly curate?: (ref: ExcerptRef) => void, private readonly history?: ExcerptHistoryHost, private readonly answers?: () => void) { super(app); this.service = new ExcerptLibraryService(app, openMarkdown); }
	onOpen(): void {
		this.closed = false; this.setTitle("摘录"); this.modalEl.addClass("rar-excerpt-modal");
		this.contentEl.createEl("p", { text: "查找保存的原句与个人备注。选择一条摘录后核对来源；备注可以独立修改。", cls: "rar-library-muted" });
		const tools = this.contentEl.createDiv("rar-excerpt-actions");
		this.searchEl = tools.createEl("input", { type: "search", placeholder: "搜索原句、来源或备注", attr: { "aria-label": "搜索摘录", maxlength: "500" } });
		this.searchEl.oninput = () => { this.query = this.searchEl.value; this.limit = 50; this.renderList(); };
		this.refreshEl = this.button(tools, "刷新摘录", () => void this.refresh());
		if (this.answers) this.button(tools, "学习回答摘录", () => { if (this.dirty || this.busy) { this.message("请先保存或放弃个人备注。"); return; } this.answers!(); this.close(); });
		const filter = tools.createEl("select", { attr: { "aria-label": "筛选整理状态" } });
		for (const [value, text] of [["all", "全部状态"], ["pending", "待整理"], ["completed", "整理完成"]]) filter.createEl("option", { value, text });
		filter.onchange = () => { this.filter = filter.value; this.limit = 50; this.renderList(); };
		this.messageEl = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		const grid = this.contentEl.createDiv("rar-excerpt-grid");
		this.listEl = grid.createEl("section", { cls: "rar-excerpt-list", attr: { "aria-label": "摘录列表" } });
		this.detailEl = grid.createEl("section", { cls: "rar-excerpt-detail", attr: { "aria-label": "摘录详情" } });
		void this.refresh();
	}
	close(): void {
		if (this.dirty || this.busy) { this.message("请先保存或放弃修改，并等待当前操作结束后关闭。草稿仍保留在详情中。"); return; }
		super.close();
	}
	/** Plugin unload must release the UI even if the host is shutting down. */
	dispose(): void { super.close(); }
	onClose(): void { this.closed = true; this.action?.abort(); this.statusAction?.abort(); this.contentEl.empty(); this.didClose?.(); }
	private message(text: string): void { if (!this.closed) this.messageEl.setText(text); }
	private button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement {
		const button = parent.createEl("button", { text, attr: { type: "button" } }); button.onclick = run; return button;
	}
	private syncControls(): void {
		this.refreshEl.disabled = this.busy || this.dirty;
		for (const button of Array.from(this.listEl.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = this.busy || this.dirty;
		for (const button of Array.from(this.detailEl.querySelectorAll<HTMLButtonElement>("button[data-requires-clean]"))) button.disabled = this.busy || this.dirty;
		this.contentEl.setAttribute("aria-busy", String(this.busy));
	}
	private async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.closed || this.busy) return;
		this.busy = true; const action = this.action = new AbortController(); this.syncControls();
		for (const input of Array.from(this.detailEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea"))) input.disabled = true;
		try { await work(action.signal); }
		catch (error) { if (!this.closed && !action.signal.aborted) this.message(error instanceof Error ? error.message : String(error)); }
		finally {
			if (!this.closed && this.action === action) {
				this.busy = false; this.action = undefined;
				for (const input of Array.from(this.detailEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea"))) input.disabled = false;
				this.syncControls();
			}
		}
	}
	private async refresh(): Promise<void> {
		if (this.dirty) return;
		await this.run(async signal => {
			this.message("正在读取本地摘录…"); const data = await this.service.list(signal); signal.throwIfAborted();
			this.data = data;
			const id = this.selected?.record.id || this.initial?.id;
			this.selected = data.entries.find(entry => entry.record.id === id);
			this.draft = this.selected?.record.manualText || "";
			this.message(`${data.entries.length} 份摘录；旧批注仍可从文献库或批注目录查看。`);
			this.renderList(); this.renderDetail();
		});
	}
	private renderList(): void {
		this.listEl.empty(); const query = this.query.trim().toLocaleLowerCase();
		const matches = this.data.entries.filter(({ record: r }) => (this.filter === "all" || (r.archiveStatus === "completed" ? "completed" : "pending") === this.filter) && [r.selectedText, r.sourcePath, r.manualText].join("\n").toLocaleLowerCase().includes(query));
		this.listEl.createEl("p", { text: `${matches.length} 条匹配摘录` });
		if (this.data.issues.length) {
			const details = this.listEl.createEl("details"); details.createEl("summary", { text: `${this.data.issues.length} 条读取提示` });
			for (const issue of this.data.issues.slice(0, 100)) details.createEl("p", { text: issue });
			if (this.data.issues.length > 100) details.createEl("p", { text: "这里只展示前 100 条提示，其余文档保持不变。" });
		}
		if (!matches.length) this.listEl.createEl("p", { text: this.data.entries.length ? "没有匹配的摘录，请调整搜索词。" : "尚无可读取的摘录。可在原文 Markdown 中划选文字，点击“批注 → 保存摘录”。" });
		for (const entry of matches.slice(0, this.limit)) {
			const row = this.button(this.listEl, "", () => {
				if (this.dirty || this.busy) return;
				void this.run(async signal => {
					const latest = await this.service.load(entry.record, signal); signal.throwIfAborted();
					this.selected = latest; this.draft = latest.record.manualText; this.message(""); this.renderList(); this.renderDetail();
				});
			});
			row.addClass("rar-excerpt-row"); row.dataset.excerptId = entry.record.id; row.setAttribute("aria-pressed", String(this.selected?.record.id === entry.record.id));
			row.createSpan({ text: entry.record.selectedText }); row.createEl("small", { text: entry.record.sourcePath });
			row.createEl("small", { text: excerptOrganizationLabel(entry.record) });
		}
		if (matches.length > this.limit) this.button(this.listEl, "显示更多摘录", () => { this.limit += 50; this.renderList(); });
		this.syncControls();
	}
	private renderDetail(): void {
		this.statusAction?.abort(); this.detailEl.empty(); const snapshot = this.selected;
		if (!snapshot) { this.detailEl.createEl("p", { text: "选择摘录，查看原句、历史上下文和个人备注。" }); return; }
		const record = snapshot.record;
		this.detailEl.createEl("h3", { text: "原文摘录" });
		this.detailEl.createEl("blockquote", { text: record.selectedText });
		this.detailEl.createEl("p", { text: record.sourcePath });
		this.detailEl.createEl("p", { text: "整理状态：" + excerptOrganizationLabel(record), cls: "rar-excerpt-state" });
		this.detailEl.createEl("p", { text: "整理完成表示当前摘录已处理，由你手动标记；原文变化或无法核对时仍需复查。", cls: "rar-library-muted" });
		const sourceStatus = this.detailEl.createEl("p", { text: "正在核对原文…", attr: { role: "status" } });
		const check = this.statusAction = new AbortController();
		void this.service.status(snapshot, check.signal).then(text => { if (!check.signal.aborted && sourceStatus.isConnected) sourceStatus.setText(text); }, error => { if (!check.signal.aborted && sourceStatus.isConnected) sourceStatus.setText("暂时无法核对：" + String(error)); });
		const context = this.detailEl.createEl("details"); context.createEl("summary", { text: "保存时的上下文与文本版本" });
		context.createEl("pre", { text: record.excerpt!.context }); context.createEl("code", { text: record.excerpt!.digest });
		this.detailEl.createEl("h3", { text: "已保存的个人备注" }); this.detailEl.createEl("pre", { text: record.manualText || "尚未填写" });
		const label = this.detailEl.createEl("label", { text: "编辑个人备注" });
		const input = label.createEl("textarea", { attr: { rows: "5", maxlength: "10000", "aria-label": "编辑个人备注" } }); input.value = this.draft;
		input.oninput = () => { this.draft = input.value; this.syncControls(); };
		const actions = this.detailEl.createDiv("rar-excerpt-actions");
		this.button(actions, "保存备注", () => void this.run(async signal => {
			const saved = await this.service.saveNote(snapshot, this.draft, signal); signal.throwIfAborted();
			this.selected = saved; this.draft = saved.record.manualText;
			this.data.entries = this.data.entries.map(entry => entry.record.id === saved.record.id ? saved : entry);
			this.message("个人备注已保存，原句与历史上下文保留。"); this.renderList(); this.renderDetail();
		})).addClass("mod-cta");
		this.button(actions, "重新读取（保留草稿）", () => void this.run(async signal => {
			const latest = await this.service.load(record, signal); signal.throwIfAborted();
			this.selected = latest; this.data.entries = this.data.entries.map(entry => entry.record.id === latest.record.id ? latest : entry);
			this.message("已显示最新保存内容；请对照草稿核对后再保存。"); this.renderList(); this.renderDetail(); this.syncControls();
		}));
		this.button(actions, "放弃修改", () => { if (this.busy) return; this.draft = snapshot.record.manualText; this.message("已放弃未保存的草稿。"); this.renderDetail(); this.syncControls(); });
		const navigation = this.detailEl.createDiv("rar-excerpt-actions");
		if (canOrganizeExcerpt(record)) {
			const completed = record.archiveStatus === "completed";
			const button = this.button(navigation, completed ? "重新待整理" : "标记整理完成", () => {
				if (this.dirty || this.busy) return;
				void this.run(async signal => {
					const saved = await this.service.setCompleted(snapshot, !completed, signal); signal.throwIfAborted();
					this.selected = saved; this.draft = saved.record.manualText;
					this.data.entries = this.data.entries.map(entry => entry.record.id === saved.record.id ? saved : entry);
					this.message(completed ? "已重新标记待整理；刷新待处理中心可查看。" : "已标记整理完成；原文一致时从待整理列表移出，需复查项仍保留。刷新待处理中心可查看。");
					this.renderList(); this.renderDetail();
				});
			}); button.dataset.requiresClean = "true";
		} else this.detailEl.createEl("p", { text: "此摘录有关联归档任务，请在原归档功能处理其状态。" });
		if (this.curate) this.button(navigation, "补充到已有笔记", () => {
			if (this.dirty || this.busy) { this.message("请先保存或放弃备注草稿后再整理摘录。"); return; }
			this.curate!({ annotationPath: record.annotationPath, id: record.id }); this.close();
		});
		this.button(navigation, "回到原文", () => {
			if (this.dirty) { this.message("请先保存或放弃备注草稿后再回到原文。"); return; }
			void this.run(async signal => { await this.service.openSource(record, signal); signal.throwIfAborted(); this.dispose(); });
		});
		this.button(navigation, "打开摘录文档", () => {
			if (this.dirty) { this.message("请先保存或放弃备注草稿后再打开文档。"); return; }
			void this.run(async signal => {
				await this.service.load(record, signal); signal.throwIfAborted();
				const file = this.app.vault.getAbstractFileByPath(record.annotationPath); if (!(file instanceof TFile)) throw new Error("摘录文档已缺失");
				await this.app.workspace.getLeaf("tab").openFile(file); signal.throwIfAborted(); this.dispose();
			});
		});
		if (this.history) {
			const section = this.detailEl.createEl("section", { cls: "rar-excerpt-history", attr: { "aria-label": "摘录整理历史" } });
			section.createEl("h3", { text: "整理历史" });
			const status = section.createEl("p", { text: "正在读取保存记录…", attr: { role: "status" } });
			void this.history.read(record, check.signal).then(result => {
				if (check.signal.aborted || !section.isConnected) return;
				status.setText(result.entries.length ? `${result.entries.length} 条历史记录；展示当时的状态与修改，不代表当前目标内容或科学结论已核验。` : result.issues.length ? "历史读取不完整，暂不能确认是否已有整理记录。" : "尚无这条摘录的已保存整理记录。可选择“补充到已有笔记”。");
				for (const issue of result.issues.slice(0, 30)) section.createEl("p", { text: issue, cls: "rar-library-muted" });
				if (result.issues.length > 30) section.createEl("p", { text: "还有更多读取提示，建议从整理记录目录检查。" });
				const rows = section.createDiv(); let shown = 0;
				const more = this.button(section, "显示更多历史", () => append());
				const append = () => {
					for (const entry of result.entries.slice(shown, shown + 25)) {
						const card = rows.createEl("details"); card.createEl("summary", { text: entry.label + " · " + entry.path });
						card.createEl("p", { text: entry.updated }); card.createEl("code", { text: entry.id }); card.createEl("p", { text: entry.detail });
						if (entry.excerptDigest !== snapshot.digest) card.createEl("p", { text: "当前摘录与该批次快照不同（备注、整理状态或其他内容可能已变更）；旧记录仅供回看，新补充需重新预览。" });
						const open = this.button(card, "打开当前目标笔记", () => {
							if (this.dirty || this.busy) return;
							void this.run(async signal => { await this.history!.open(record, entry, signal); signal.throwIfAborted(); this.dispose(); });
						}); open.dataset.requiresClean = "true";
						if (entry.before !== undefined && entry.after !== undefined) {
							const diff = card.createEl("details"); diff.createEl("summary", { text: "查看当时目标笔记的修改" });
							// Build potentially large snapshots only when requested.
							diff.ontoggle = () => { if (!diff.open || diff.childElementCount > 1) return; diff.createEl("h4", { text: "修改前" }); diff.createEl("pre", { text: entry.before }); diff.createEl("h4", { text: "修改后" }); diff.createEl("pre", { text: entry.after }); };
						}
					}
					shown += 25; more.hidden = shown >= result.entries.length; this.syncControls();
				}; append();
			}, error => { if (!check.signal.aborted && section.isConnected) status.setText("整理历史暂时无法读取：" + String(error)); });
		}
		this.syncControls();
	}
}
