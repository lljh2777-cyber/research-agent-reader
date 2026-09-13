import { Modal, Notice, type App } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { curationTarget } from "../curation/policy";
import { SUGGESTION_LABELS, type CurationContext, type CurationReview, type CurationRevision } from "../curation/types";
import { readingTitle } from "../reading/catalog";
import { readingExportDiff } from "../reading/export-review";
import type { ReadingSession } from "../reading/types";
import { structuredLocationLabel } from "../reading/structured-reference";
import type { CurationNavigation } from "../services/dashboard-curation";

function action(parent: HTMLElement, text: string, run: () => unknown | Promise<unknown>, primary = false): HTMLButtonElement {
	const button = parent.createEl("button", { text, cls: primary ? "mod-cta" : "", attr: { type: "button" } });
	button.onclick = () => { button.disabled = true; void Promise.resolve().then(run).catch(error => new Notice(String(error), 8000)).finally(() => { if (button.isConnected) button.disabled = false; }); }; return button;
}
function detail(parent: HTMLElement, title: string, text: string): HTMLElement { const box = parent.createEl("details"); box.createEl("summary", { text: title }); box.createEl("pre", { text, cls: "curation-text" }); return box; }
export function curationChangeWindow(before: string, after: string): { before: string; after: string } {
	const left = before.split(/\r?\n/), right = after.split(/\r?\n/); let start = 0, end = 0;
	while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
	while (end < Math.min(left.length, right.length) - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
	return { before: left.slice(Math.max(0, start - 2), left.length - Math.max(0, end - 2)).join("\n"), after: right.slice(Math.max(0, start - 2), right.length - Math.max(0, end - 2)).join("\n") };
}
export function curationBatch(session: ReadingSession, selectedId: string): ReadingSession["nodes"] {
	const node = session.nodes.find(n => n.id === selectedId); return node ? session.nodes.filter(n => n.status === "done" && n.branchId === node.branchId) : [];
}
export class RevisionPreviewModal extends Modal {
	constructor(app: App, private revision: CurationRevision, private apply?: () => Promise<unknown>, private done?: () => void) { super(app); }
	onOpen(): void {
		this.titleEl.setText(this.apply ? this.revision.undoOf ? "核对撤销内容" : "核对选中修改" : "修订内容"); this.modalEl.addClass("curation-modal", "curation-revision-modal");
		this.contentEl.createEl("p", { cls: "curation-intro", text: "逐项核对以下文件。应用前会再次检查文件和证据是否变化。" });
		const files = this.contentEl.createDiv("curation-revision-files");
		for (const write of this.revision.writes) {
			const item = files.createEl("details", { cls: "curation-revision-file" }); item.open = write.role === "target"; item.createEl("summary", { text: write.path });
			const diff = readingExportDiff(write.before || "", write.after); item.createEl("p", { text: `变化区段：新增 ${diff.added} 行，删除 ${diff.removed} 行` });
			if (diff.lines) detail(item, "只看变化" + (diff.omitted ? "（节选）" : ""), diff.lines);
			const changed = curationChangeWindow(write.before || "", write.after);
			const columns = item.createDiv("curation-diff-columns"); for (const [name, text] of [["修改前 · 变化位置", changed.before || "（新增）"], ["修改后 · 变化位置", changed.after]]) { const col = columns.createDiv(); col.createEl("small", { text: name }); col.createEl("pre", { text, cls: "curation-text" }); }
			detail(item, "完整修改前文件", write.before || "（新文件）"); detail(item, "完整修改后文件", write.after);
		}
		const footer = this.contentEl.createDiv("curation-footer"); footer.createEl("span", { text: "保存前一版本 · 保留修订记录" });
		if (this.apply) action(footer, this.revision.undoOf ? "确认撤销" : "应用选中修改", async () => { await this.apply!(); this.done?.(); this.close(); new Notice("修订已保存"); }, true);
		action(footer, "关闭", () => this.close());
	}
}
export class KnowledgeCurationModal extends Modal {
	private closed = false; private sequence = 0; private controller?: AbortController; private unsubscribe?: () => void;
	private nodeIds = new Set<string>(); private selected = new Set<string>(); private context?: CurationContext; private reviewId = "";
	private status!: HTMLElement; private results!: HTMLElement; private evidence!: HTMLElement; private choices!: HTMLElement; private target!: HTMLSelectElement; private generateButton!: HTMLButtonElement; private previewButton!: HTMLButtonElement;
	private cacheNotice = false; private operation = false;
	private renderedState = "";
	private regenerateButton!: HTMLButtonElement;
	private runningKey?: string;
	constructor(app: App, private plugin: AgentDashboardPlugin, private sessionId: string, private nodeId: string, private initialReview?: CurationReview, private initialSelection?: { nodeIds: string[]; target: string }, private hooks?: { prepared(review: CurationReview): Promise<void>; failed(error: unknown): Promise<void> }) { super(app); }
	private get service() { return this.plugin.getCurationService(); }
	private get session() { return this.plugin.getReadingWorkspace().repository.get(this.sessionId); }
	onOpen(): void {
		this.titleEl.setText("把理解整理进知识库"); this.modalEl.addClass("curation-modal");
		this.contentEl.createEl("p", { cls: "curation-intro", text: "从一小段学习内容开始，核对论文依据，再决定如何补充已有笔记。" });
		const grid = this.contentEl.createDiv("curation-grid"); const side = grid.createDiv("curation-side"); const paper = grid.createDiv("curation-paper");
		side.createEl("small", { cls: "curation-eyebrow", text: "01 / 本批学习内容" }); side.createEl("strong", { text: readingTitle(this.session) });
		this.nodeIds = new Set(this.initialReview?.context.nodeIds || this.initialSelection?.nodeIds || [this.nodeId]); const nodes = side.createDiv("curation-nodes");
		for (const node of curationBatch(this.session, this.nodeId)) {
			const label = nodes.createEl("label", { cls: "curation-node" }); const check = label.createEl("input", { type: "checkbox" }); check.checked = this.nodeIds.has(node.id); label.createEl("span", { text: node.title });
			check.onchange = () => { if (check.checked && this.nodeIds.size >= 3) { check.checked = false; new Notice("每批最多三个节点"); return; } if (check.checked) this.nodeIds.add(node.id); else this.nodeIds.delete(node.id); this.reset(); };
		}
		side.createEl("small", { text: "默认一个节点；连续内容可选一至三个。" });
		side.createEl("small", { cls: "curation-eyebrow", text: "02 / 目标笔记" });
		const filter = side.createEl("input", { attr: { placeholder: "筛选已有笔记…", "aria-label": "筛选目标笔记" } });
		this.target = side.createEl("select", { attr: { "aria-label": "整理目标笔记" } });
		const allFiles = this.app.vault.getMarkdownFiles().filter(file => curationTarget(file.path)).sort((a, b) => a.path.localeCompare(b.path));
		const renderTargets = () => { const previous = this.target.value; this.target.empty(); this.target.createEl("option", { value: "", text: "选择已有正式笔记" });
			for (const file of allFiles.filter(file => file.path.toLowerCase().includes(filter.value.toLowerCase()) || file.path === previous)) this.target.createEl("option", { value: file.path, text: file.path.replace("wiki/", "") }); this.target.value = previous; };
		renderTargets(); filter.oninput = renderTargets;
		this.target.value = this.initialReview?.context.target.path || this.initialSelection?.target || ""; this.target.onchange = () => this.reset();
		const tools = side.createDiv("curation-actions"); action(tools, "查找关联", () => this.find(false)); action(tools, "相似学习记录", () => this.find(true));
		this.choices = side.createDiv("curation-candidates");
		this.evidence = side.createDiv("curation-evidence"); action(side, "读取依据与估算", () => this.prepare());
		paper.createEl("small", { cls: "curation-eyebrow", text: "03 / 审阅与选择" });
		this.status = paper.createEl("p", { cls: "curation-status", attr: { role: "status", "aria-live": "polite" } });
		this.results = paper.createDiv("curation-results");
		const footer = this.contentEl.createDiv("curation-footer"); const controls = footer.createDiv("curation-actions");
		this.generateButton = action(controls, "生成整理建议", () => this.generate(), true); action(controls, "停止生成", () => this.stopGeneration());
		this.regenerateButton = action(controls, "重新生成（新请求）", () => this.generate(true)); this.regenerateButton.title = "新建一批建议，保留已有记录；会再次消耗模型用量";
		this.previewButton = action(footer, "预览选中修改", async () => { const revision = await this.plugin.getCurationWriter().preview(this.reviewId, [...this.selected]); this.plugin.showCurationModal(new RevisionPreviewModal(this.app, revision, () => this.plugin.getCurationWriter().apply(revision), () => { this.selected.clear(); this.renderReview(); })); }, true);
		action(footer, "维护记录", () => { this.close(); this.plugin.openKnowledgeMaintenance(); });
		this.unsubscribe = this.service.subscribe(() => { if (this.closed || this.operation) return; const record = this.service.reviews.get(this.reviewId); if (record && this.renderedState !== record.state) this.renderReview(); });
		if (this.initialReview) { this.context = this.initialReview.context; this.reviewId = this.initialReview.id; this.cacheNotice = true; this.renderEvidence(); this.renderReview(); } else this.reset();
		if (!this.initialReview && this.initialSelection) void this.prepare().catch(error => { if (!this.closed) this.status.setText(String(error)); });
	}
	onClose(): void { this.closed = true; this.sequence++; this.controller?.abort(); this.unsubscribe?.(); this.contentEl.empty(); }
	private reset(): void { this.sequence++; this.controller?.abort(); this.context = undefined; this.reviewId = ""; this.selected.clear(); this.evidence.empty(); this.results.empty(); this.status.setText("选择目标笔记后先读取依据。此步骤不调用回答模型。"); this.generateButton.disabled = true; this.regenerateButton.disabled = true; this.previewButton.disabled = true; }
	private async prepare(): Promise<void> {
		const token = ++this.sequence; this.controller?.abort(); const controller = new AbortController(); this.controller = controller; this.status.setText("正在读取原文和目标段落…");
		const context = await this.service.prepare(this.sessionId, [...this.nodeIds], this.target.value, controller.signal); if (this.closed || token !== this.sequence) return;
		this.context = context; const cached = this.service.cached(context); this.reviewId = cached?.id || ""; this.cacheNotice = !!cached; this.selected.clear(); this.renderEvidence(); this.renderReview();
		if (cached) await this.hooks?.prepared(cached);
	}
	private renderEvidence(): void {
		this.evidence.empty(); const context = this.context; if (!context) return;
		this.evidence.createEl("p", { cls: "curation-budget", text: "预计文字输入约 " + context.estimate.toLocaleString() + " token · 最多一次生成调用" });
		this.evidence.createEl("small", { text: context.backendName + " · " + (context.model || "默认模型") + "；图像和推理另计。勾选、差异和历史均在本地完成。" });
		if (context.selection) this.evidence.createEl("small", { text: "目标选段：" + ({ hybrid: "混合检索＋重排", rerank: "关键词＋重排", lexical: "关键词" }[context.selection.mode] || context.selection.mode) + " · 从 " + context.selection.candidates + " 段中选择 " + context.selection.selected + " 段；相关性不代表事实支持。" });
		if (context.backendId === "codex-cli") this.evidence.createEl("small", { text: "Codex CLI 还会附加运行上下文，实际输入可能高于这里的文字估算。" });
		for (const warning of context.warnings) this.evidence.createEl("p", { cls: "reading-error", text: warning });
		for (const evidence of context.evidence) { const box = detail(this.evidence, evidence.id + " · " + evidence.role + (evidence.visual ? " · 附带图像" : ""), evidence.text); box.createEl("small", { text: evidence.path + (evidence.page ? " · 第 " + evidence.page + " 页" : "") + " · " + evidence.depth }); if (evidence.structured) box.createEl("small", { text: structuredLocationLabel(evidence) }); }
	}
	private async generate(force = false): Promise<void> {
		if (!this.context || !this.context.sourceCompatible || this.operation) return; const context = this.context; const token = this.sequence; this.operation = true; this.runningKey = context.key; this.status.setText("正在核对证据并生成整理建议…");
		try { const cached = !force && this.service.cached(context); const review = await this.service.generate(context, force, record => this.hooks?.prepared(record) || Promise.resolve()); if (this.closed || token !== this.sequence) return; this.reviewId = review.id; this.cacheNotice = !!cached; this.selected.clear(); this.renderReview(); }
		catch (error) { await this.hooks?.failed(error); if (!this.closed && token === this.sequence) this.status.setText(String(error) + "；可重新读取依据后重试。"); throw error; }
		finally { this.operation = false; this.runningKey = undefined; }
	}
	private stopGeneration(): void { const key = this.runningKey || this.context?.key; if (key) this.service.stop(key); }
	private renderReview(): void {
		if (this.closed) return; this.results.empty(); const review = this.service.reviews.get(this.reviewId); this.renderedState = review?.state || ""; this.generateButton.disabled = !this.context?.sourceCompatible || review?.state === "generating"; this.regenerateButton.disabled = review?.state !== "ready"; this.previewButton.disabled = true;
		if (!review) { this.status.setText("依据已准备好。点击生成建议后才会调用回答模型。"); return; }
		const usage = review.usage; this.status.setText((this.cacheNotice ? "已恢复保存的结果，本次查看未调用模型。 " : "") + (review.error || (review.state === "generating" ? "正在生成…" : "逐条核对内容，选择希望采用的修改。")));
		this.results.createEl("p", { cls: "curation-usage", text: `本记录：${usage.kind === "reported" ? "接口报告" : "估算"}输入 ${usage.input ?? "未知"} / 输出 ${usage.output ?? "未知"} token · ${usage.calls} 次调用` });
		if (usage.note) this.results.createEl("small", { text: usage.note });
		for (const suggestion of review.suggestions) {
			const card = this.results.createEl("article", { cls: "curation-suggestion" + (!suggestion.applicable ? " is-review-only" : ""), attr: { "data-suggestion-id": suggestion.id } });
			const heading = card.createDiv("curation-suggestion-heading"); const label = heading.createEl("label"); const check = label.createEl("input", { type: "checkbox" }); check.checked = this.selected.has(suggestion.id);
			check.disabled = review.state !== "ready" || !suggestion.applicable || suggestion.decision !== "pending"; label.createEl("strong", { text: suggestion.claim }); heading.createEl("span", { cls: "curation-badge", text: SUGGESTION_LABELS[suggestion.kind] });
			check.onchange = () => { if (check.checked) this.selected.add(suggestion.id); else this.selected.delete(suggestion.id); this.previewButton.disabled = !this.selected.size; };
			card.createEl("p", { text: suggestion.reason }); if (suggestion.text) card.createEl("div", { cls: "curation-proposed", text: suggestion.text });
			if (suggestion.modelKind && suggestion.modelKind !== suggestion.kind) card.createEl("small", { text: "模型原分类：" + SUGGESTION_LABELS[suggestion.modelKind] + "；依据检查后调整为" + SUGGESTION_LABELS[suggestion.kind] });
			if (suggestion.decision !== "pending") card.createEl("small", { text: suggestion.decision === "applied" ? "已应用 · 从修订记录查看或撤销" : "已忽略" });
			const paragraph = review.context.target.paragraphs.find(p => p.id === suggestion.paragraphId); if (paragraph) detail(card, "目标位置 · " + paragraph.heading, paragraph.text);
			for (const citation of suggestion.citations) { const evidence = review.context.evidence.find(e => e.id === citation.id); const box = detail(card, "核对引用 · " + citation.id, citation.quote); if (evidence) { box.createEl("small", { text: evidence.path + " · " + evidence.origins.join("、") }); if (evidence.kind === "vault") action(box, "打开依据笔记", () => this.plugin.openVaultFile(evidence.path)); else action(box, "返回原文依据", () => this.plugin.openCurationEvidence(review.context, citation.id)); } }
			for (const warning of suggestion.warnings) card.createEl("p", { cls: "reading-error", text: warning });
			if (review.state === "ready" && suggestion.decision !== "applied") {
				const row = card.createDiv("curation-actions"); action(row, suggestion.decision === "ignored" ? "恢复待审阅" : "忽略", async () => { await this.service.decide(review.id, suggestion.id, suggestion.decision === "ignored" ? "pending" : "ignored"); this.selected.delete(suggestion.id); this.renderReview(); });
				if (["add", "replace", "condition"].includes(suggestion.kind)) { const editor = card.createEl("details"); editor.createEl("summary", { text: "编辑候选正文" }); const input = editor.createEl("textarea", { cls: "curation-editor", attr: { "aria-label": "候选正文" } }); input.value = suggestion.text;
					action(editor, "保存编辑并重新校验", async () => { await this.service.decide(review.id, suggestion.id, suggestion.decision as "pending" | "ignored", input.value); this.selected.delete(suggestion.id); this.renderReview(); }); }
			}
		}
		this.previewButton.disabled = !this.selected.size || review.state !== "ready";
	}
	private async find(learning: boolean): Promise<void> {
		this.controller?.abort(); const controller = new AbortController(); this.controller = controller; const token = this.sequence; this.choices.empty(); this.choices.createEl("p", { text: "正在查找…" });
		if (learning) {
			const result = await this.plugin.getLearningLibrary().find(this.session, [...this.nodeIds], controller.signal); if (this.closed || token !== this.sequence || controller.signal.aborted) return; this.choices.empty();
			this.choices.createEl("small", { text: "这些是学习记录，不能作为论文依据。文字相同也不代表事实已核验。" });
			for (const match of result.matches) { const box = detail(this.choices, (match.relation === "exact-text" ? "文字相同 · " : "主题相关 · ") + match.title, match.excerpt); box.createEl("small", { text: "原始来源：" + match.sourceIdentity }); action(box, "打开学习记录", () => { if (match.sessionId && match.nodeId) return this.plugin.openLearningRecord(match.sessionId, match.nodeId); return this.plugin.openVaultFile(match.path); }); }
			for (const warning of result.warnings) this.choices.createEl("small", { text: warning }); if (!result.matches.length) this.choices.createEl("p", { text: "未找到相关学习记录。" });
		} else {
			const query = readingTitle(this.session).slice(0, 300) + " " + this.session.nodes.filter(n => this.nodeIds.has(n.id)).map(n => n.title).join("；").slice(0, 500);
			const result = await this.plugin.searchKnowledge(query, { identityQuery: "整理关联候选", limit: 5, signal: controller.signal }); if (this.closed || token !== this.sequence || controller.signal.aborted) return; this.choices.empty();
			for (const hit of result.hits.filter((h, i, list) => curationTarget(h.path) && list.findIndex(other => other.path === h.path) === i)) { const box = detail(this.choices, hit.title, hit.text); action(box, "选择此笔记", () => { filterTarget(this.target, hit.path); this.reset(); return this.prepare(); }); }
			for (const warning of result.warnings) this.choices.createEl("small", { text: warning }); if (!result.hits.length) this.choices.createEl("p", { text: "未找到关联，可手动选择目标。" });
		}
	}
}
function filterTarget(select: HTMLSelectElement, path: string): void { if (![...select.options].some(option => option.value === path)) select.createEl("option", { value: path, text: path.replace("wiki/", "") }); select.value = path; }

export class KnowledgeMaintenanceModal extends Modal {
	private tab = "pending"; private body!: HTMLElement; private counts!: HTMLElement; private closed = false; private unsubscribes: Array<() => void> = [];
	private indexUnsubscribes: Array<() => void> = [];
	constructor(app: App, private plugin: AgentDashboardPlugin, private entry: CurationNavigation = {}) { super(app); this.tab = entry.revisionId ? "history" : entry.reviewId ? "activity" : entry.tab || "pending"; }
	onOpen(): void {
		this.titleEl.setText("知识整理"); this.modalEl.addClass("curation-modal", "curation-maintenance-modal");
		this.contentEl.createEl("p", { cls: "curation-intro", text: "核对待整理内容、失效依据和修订历史。这里的浏览与检查不调用回答模型。" });
		action(this.contentEl, "新知识页草稿", () => { this.plugin.openKnowledgeDrafts(); this.close(); });
		const nav = this.contentEl.createDiv("curation-tabs"); for (const [id, title] of [["pending", "待审阅"], ["stale", "需复查"], ["activity", "整理批次"], ["history", "修订记录"], ["indices", "索引"]]) { const button = action(nav, title, () => { this.entry = {}; this.tab = id; nav.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === button))); this.render(); }); button.setAttribute("aria-pressed", String(id === this.tab)); }
		this.counts = this.contentEl.createEl("p", { cls: "curation-status", attr: { role: "status" } }); this.body = this.contentEl.createDiv("curation-maintenance-body");
		const footer = this.contentEl.createDiv("curation-footer"); action(footer, "检查来源与笔记变化", async () => { await this.plugin.getCurationService().inspect(); this.render(); }); action(footer, "刷新记录", () => this.render());
		this.unsubscribes.push(this.plugin.getCurationService().subscribe(() => this.renderCounts()));
		void this.plugin.getCurationService().ready().then(() => { if (!this.closed) this.render(); }).catch(error => new Notice(String(error)));
	}
	onClose(): void { this.closed = true; [...this.unsubscribes, ...this.indexUnsubscribes].forEach(unsubscribe => unsubscribe()); this.contentEl.empty(); }
	private renderCounts(): void { if (this.closed) return; const service = this.plugin.getCurationService(); this.counts.setText(`${service.reviews.size} 批整理 · ${service.revisions.size} 次修订 · ${service.activeCount} 批正在生成` + (service.changesPending ? " · 文件有变化，待检查" : "")); }
	private render(): void {
		if (this.closed) return; this.indexUnsubscribes.forEach(unsubscribe => unsubscribe()); this.indexUnsubscribes = []; this.body.empty(); this.renderCounts(); const service = this.plugin.getCurationService();
		if (this.tab === "indices") { this.renderIndices(); return; }
		if (service.errors.length) detail(this.body, "无法加载的记录（原文件保留）", service.errors.join("\n"));
		if (this.tab !== "history") {
			if (this.tab === "activity") this.body.createEl("p", { text: "全部已加载整理批次；遗留生成记录在打开后可能标记为中断。", cls: "curation-status" });
			const records = [...service.reviews.values()].filter(r => (!this.entry.reviewId || r.id === this.entry.reviewId) && (this.tab === "activity" || (this.tab === "stale" ? ["stale", "failed", "interrupted"].includes(r.state) : r.state === "generating" || r.state === "ready" && r.suggestions.some(s => s.decision === "pending")))).sort((a, b) => b.updated.localeCompare(a.updated));
			if (this.entry.reviewId) this.body.createEl("p", { text: records.length ? "正在查看所选整理批次；点击上方分类可查看全部。" : "所选整理批次已缺失或无法读取，未选择其他记录。", cls: "curation-status" });
			for (const record of records) { const row = this.body.createEl("article", { cls: "curation-record" }); row.createEl("strong", { text: record.context.title }); row.createEl("p", { text: record.context.target.path + " · " + new Date(record.updated).toLocaleString() }); if (record.error) row.createEl("p", { cls: "reading-error", text: record.error });
				action(row, record.state === "generating" ? "查看进度" : "审阅建议", () => { this.close(); this.plugin.openKnowledgeCuration(record.context.sessionId, record.context.nodeIds[0], record); });
				if (record.state === "generating") action(row, "停止生成", () => service.stop(record.context.key));
			}
			if (!records.length) this.body.createEl("p", { cls: "curation-empty", text: this.tab === "activity" ? "暂无已加载的整理批次。" : this.tab === "stale" ? "暂无需要复查的整理记录。可运行一次变化检查。" : "暂无待审阅内容。从阅读界面选择一个已完成节点，点击「整理进知识库」。" });
		}
		if (this.tab === "history" || this.tab === "stale") {
			const revisions = [...service.revisions.values()].filter(r => (!this.entry.revisionId || r.id === this.entry.revisionId) && (this.tab === "history" || r.needsReview || r.state !== "applied")).sort((a, b) => b.created.localeCompare(a.created));
			if (this.entry.revisionId) this.body.createEl("p", { text: revisions.length ? "正在查看所选修订；点击上方「修订记录」查看全部。" : "所选修订已缺失或无法读取，未跳到其他记录。", cls: "curation-status" });
			for (const revision of revisions) { const row = this.body.createEl("article", { cls: "curation-record" }); row.createEl("strong", { text: revision.writes.find(w => w.role === "target")?.path || "修订" }); row.createEl("p", { text: new Date(revision.created).toLocaleString() + " · " + (revision.state === "applied" ? revision.undoOf ? "已撤销" : "已应用" : "等待恢复") });
				if (revision.error || revision.needsReview) row.createEl("p", { cls: "reading-error", text: revision.error || revision.needsReview });
				action(row, "查看修改", () => this.plugin.showCurationModal(new RevisionPreviewModal(this.app, revision)));
				if (revision.state !== "applied") action(row, "预览并恢复", () => this.plugin.showCurationModal(new RevisionPreviewModal(this.app, revision, () => this.plugin.getCurationWriter().resume(revision.id), () => this.render())));
				else if (!revision.undoOf) action(row, "预览撤销", async () => { const undo = await this.plugin.getCurationWriter().previewUndo(revision.id); this.plugin.showCurationModal(new RevisionPreviewModal(this.app, undo, () => this.plugin.getCurationWriter().applyUndo(undo), () => this.render())); });
			}
			if (this.tab === "history" && !revisions.length && !this.entry.revisionId) this.body.createEl("p", { cls: "curation-empty", text: "采用整理建议后，会在这里保留修改前后的完整内容。" });
		}
	}
	private renderIndices(): void {
		for (const [title, index, description] of [["正式知识索引", this.plugin.getKnowledgeService(), "用于有证据的知识问答，排除学习 QA。"], ["学习记录索引", this.plugin.getLearningLibrary().index, "只用于寻找相似学习内容，不作为论文依据。排除演示与测试。"]] as const) {
			const box = this.body.createEl("article", { cls: "curation-record" }); box.createEl("strong", { text: title }); box.createEl("p", { text: description }); const status = box.createEl("p"); const progress = box.createEl("progress"); progress.max = 1;
			const render = () => { if (!box.isConnected) return; const s = index.status; status.setText(s.message + ` · ${s.documents} 篇 / ${s.done} 个已索引片段 / ${s.changed} 篇变化`); progress.value = s.total ? s.done / s.total : 0; };
			this.indexUnsubscribes.push(index.subscribe(render)); render(); action(box, "更新变化内容", async () => { await index.update(); render(); }, true); action(box, "停止", () => index.stop()); action(box, "检查变化", async () => { await index.inspect(); render(); });
			void index.inspect().then(render).catch(error => { if (box.isConnected) status.setText(String(error)); });
		}
		this.body.createEl("small", { text: "更新索引会把新增或变化的片段发给已配置的 BGE 模型；历史浏览和检查变化仅在本地进行。" });
	}
}
