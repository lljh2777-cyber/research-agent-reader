import { Component, ItemView, MarkdownRenderer, type WorkspaceLeaf } from "obsidian";
import { layoutLearning, LEARNING_MAP } from "../learning/graph";
import { safeLearningMarkdown } from "../learning/presentation";
import type { ReadingBackend } from "../reading/types";
import { TopicStudyController } from "../topic-learning/study-workspace";
import type { TopicStudyService } from "../topic-learning/study-service";
import type { TopicStudyNode } from "../topic-learning/study";
export const TOPIC_STUDY_VIEW_TYPE = "research-topic-study";
export interface TopicStudyHost {
	getTopicStudy(): TopicStudyService;
	getTopicModels(): Array<{ id: string; name: string; model: string }>;
	createTopicBackend(profileId: string): ReadingBackend;
	activateLearningSpace(entry: { kind: "topic"; sessionId: string }): Promise<void>;
}
export class TopicStudyView extends ItemView {
	readonly controller: TopicStudyController;
	private profileId = ""; private closed = false; private renderer = new Component(); private renderId = 0;
	private restoring: Promise<void> = Promise.resolve();
	private mapSelection?: string; private focusMap = false;
	constructor(leaf: WorkspaceLeaf, private readonly host: TopicStudyHost) { super(leaf); this.controller = new TopicStudyController(host.getTopicStudy(), () => { this.render(); this.persist(); }); }
	getViewType(): string { return TOPIC_STUDY_VIEW_TYPE; }
	getDisplayText(): string { return "主题学习（开发预览）"; }
	getIcon(): string { return "messages-square"; }
	getState(): Record<string, unknown> { return { ...this.controller.state(), profileId: this.profileId }; }
	async setState(raw: unknown): Promise<void> {
		this.restoring = this.restoring.then(async () => { if (this.closed) return; this.controller.restore(raw); const v = raw as { profileId?: unknown } | undefined; this.profileId = typeof v?.profileId === "string" ? v.profileId.slice(0, 200) : ""; await this.controller.refresh(); this.render(); }); await this.restoring;
	}
	async openStudy(topicId: string, route: string): Promise<void> { await this.restoring; await this.controller.open(topicId, route); }
	async onOpen(): Promise<void> { this.renderer.load(); this.render(); }
	async onClose(): Promise<void> { this.closed = true; this.controller.dispose(); this.renderer.unload(); this.contentEl.empty(); }
	private persist(): void { if (!this.closed) this.app.workspace.requestSaveLayout(); }
	private button(root: HTMLElement, text: string, action: string, run: () => void, disabled = false): HTMLButtonElement {
		const b = root.createEl("button", { text, attr: { type: "button", "data-study-action": action } }); b.disabled = disabled; b.onclick = run; return b;
	}
	private get modelReady(): boolean { return this.host.getTopicModels().some(p => p.id === this.profileId); }
	private generate(action: Parameters<TopicStudyController["generate"]>[0]): void { void this.controller.generate(action, () => this.host.createTopicBackend(this.profileId)); }
	private render(): void {
		if (this.closed) return;
		const scroll = this.contentEl.scrollTop, c = this.controller, s = c.study;
		this.renderId++; this.renderer.unload(); this.renderer = new Component(); this.renderer.load(); this.contentEl.empty(); this.contentEl.addClass("rar-study");
		const header = this.contentEl.createDiv("rar-study-header"), title = header.createDiv(); title.createEl("h1", { text: s?.session.intent.topic || "主题学习" });
		title.createEl("p", { text: "开发预览 · 一般知识讲解，尚未完成独立教学审阅。", cls: "rar-study-muted" });
		this.button(header, "返回路线", "plan", () => { void this.host.activateLearningSpace({ kind: "topic", sessionId: c.topicId }).catch(e => { c.message = String(e); this.render(); }); }, c.busy);
		this.contentEl.createEl("p", { text: "这里使用模型一般知识，不代表已核验的论文或库内证据。生成讲解不表示已经掌握；理解标记、导出与教学验收在后续阶段接入。", cls: "rar-study-intro" });
		const tools = this.contentEl.createDiv("rar-study-tools"), routes = tools.createEl("label", { cls: "rar-study-field" }); routes.createSpan({ text: "已固定的学习路线" });
		const picker = routes.createEl("select", { attr: { "aria-label": "选择学习记录" } }); picker.createEl("option", { value: "", text: "选择已经开始的学习记录" });
		for (const r of c.routes) picker.createEl("option", { value: r.digest, text: `${r.title} · ${r.goal.slice(0, 60)} · ${r.digest.slice(0, 6)}` });
		picker.value = c.route; picker.disabled = c.busy; picker.onchange = () => { void c.open(c.topicId, picker.value); };
		this.button(tools, "重新读取", "refresh", () => { void c.refresh(); }, c.busy);
		if (c.hasDrafts) this.button(tools, "清空未发送问题", "clear-drafts", () => c.clearDrafts(), c.busy);
		const status = this.contentEl.createDiv({ cls: "rar-study-status", attr: { role: "status", "aria-live": "polite" } });
		if (c.busy) status.createEl("p", { text: c.generating ? "正在生成当前节点…" : "正在读取学习记录…" });
		if (c.message) status.createEl("p", { text: c.message });
		if (c.generating) this.button(status, "取消生成", "cancel", () => c.cancel());
		if (!s) { this.contentEl.createEl("p", { text: "从路线页确认学习安排后打开，或选择已有学习记录。打开页面不会生成讲解。", cls: "rar-study-muted" }); return; }
		const summary = this.contentEl.createEl("details", { cls: "rar-study-route" }); summary.createEl("summary", { text: `学习目标：${s.session.intent.goal} · 已生成 ${s.nodes.filter(n => !n.branchId && n.status === "done").length}/${s.session.plan!.modules.length} 个主线单元` });
		summary.createEl("p", { text: "基础：" + (s.session.intent.background || "未填写") });
		for (const unit of s.session.plan!.modules) summary.createEl("p", { text: unit.title + " · " + unit.objective });
		summary.createEl("p", { text: "此学习记录固定使用上述路线；路线页之后的修改不会重写这里的历史。", cls: "rar-study-muted" });
		const controls = this.contentEl.createDiv("rar-study-tools"), modelLabel = controls.createEl("label", { cls: "rar-study-field" }); modelLabel.createSpan({ text: "讲解模型" });
		const model = modelLabel.createEl("select", { attr: { "aria-label": "讲解模型" } }); model.createEl("option", { value: "", text: "选择已验证的 Direct API" });
		for (const p of this.host.getTopicModels()) model.createEl("option", { value: p.id, text: p.name + " · " + p.model }); model.value = this.modelReady ? this.profileId : ""; model.disabled = c.busy; model.onchange = () => { this.profileId = model.value; this.render(); this.persist(); };
		const lastMain = s.nodes.find(n => n.id === s.graph.mainIds[s.graph.mainIds.length - 1]);
		this.button(controls, s.graph.mainIds.length ? "讲解下一主线单元" : "生成第 1 单元讲解", "next", () => this.generate({ kind: "next" }), c.busy || !this.modelReady || s.graph.mainIds.length >= s.session.plan!.modules.length || Boolean(lastMain && lastMain.status !== "done"));
		this.button(controls, "返回主线位置", "return-main", () => c.returnToMain(), c.busy || !s.graph.mainIds.length);
		this.contentEl.createEl("p", { text: "点击生成会将固定路线、当前问题及选定祖先对话发送给所选模型；每次只生成一轮。", cls: "rar-study-muted" });
		const body = this.contentEl.createDiv("rar-study-body"), conversation = body.createDiv("rar-study-conversation"), map = body.createDiv("rar-study-map-panel");
		conversation.createEl("h2", { text: c.selected?.branchId ? "支线对话" : "主线对话" });
		if (!c.selected) conversation.createEl("p", { text: "选择模型后生成第一个主线单元。" });
		else {
			const selected = c.selected, ids = selected.branchId ? s.graph.branches.find(b => b.id === selected.branchId)!.nodeIds : s.graph.mainIds;
			const timeline = conversation.createDiv("rar-study-timeline");
			for (const id of ids) { const node = s.nodes.find(n => n.id === id)!; const b = this.button(timeline, node.title, "select-turn", () => c.select(id), c.busy); b.dataset.studyNode = id; b.setAttribute("aria-pressed", String(id === selected.id)); }
			if (selected.branchId) { const branch = s.graph.branches.find(b => b.id === selected.branchId)!; this.button(conversation, "回到支线起点", "branch-origin", () => c.select(branch.parentNodeId), c.busy); }
			this.renderAnswer(conversation, selected);
		}
		this.renderMap(map); this.contentEl.scrollTop = scroll;
	}
	private renderAnswer(root: HTMLElement, node: TopicStudyNode): void {
		const c = this.controller, article = root.createEl("article"); article.dataset.answerNode = node.id; article.createEl("h3", { text: node.title });
		article.createEl("p", { text: "问题：" + node.question, cls: "rar-study-question" });
		const labels = { done: "讲解已返回", failed: "生成失败", cancelled: "生成已取消", interrupted: "请求未完成／已中断" };
		article.createEl("p", { text: labels[node.status] + " · 模型一般知识 · 尚未核验", cls: "rar-study-muted" });
		if (node.status === "done") {
			const content = article.createDiv("rar-study-answer"), serial = this.renderId;
			try { void MarkdownRenderer.render(this.app, safeLearningMarkdown(node.content), content, "", this.renderer).catch(() => { if (!this.closed && serial === this.renderId) content.setText(node.content); }); }
			catch { content.setText(node.content); }
		} else {
			article.createEl("p", { text: node.attempts[node.attempts.length - 1].result?.error || "没有已提交的返回正文，重载不会自动重发请求。" });
			this.button(article, "重试此节点", "retry", () => this.generate({ kind: "retry", nodeId: node.id }), c.busy || !this.modelReady);
		}
		const history = article.createEl("details"); history.createEl("summary", { text: `${node.attempts.length} 次请求与用量记录` });
		for (const attempt of node.attempts) {
			const u = attempt.result?.usage; history.createEl("p", { text: `${attempt.provider} · ${attempt.model} · ${attempt.result ? labels[attempt.result.status] : labels.interrupted} · 输入 ${u?.input ?? "未报告"} / 输出 ${u?.output ?? "未报告"} token${u?.cachedInput === undefined ? "" : `，其中缓存输入 ${u.cachedInput}`}。上下文包含 ${attempt.contextIds.length} 轮祖先对话，省略更早 ${attempt.omitted} 轮。` });
		}
		history.createEl("p", { text: "未报告不等于零消耗；失败或中断的请求也可能产生费用。", cls: "rar-study-muted" });
		if (node.status !== "done") return;
		const field = article.createEl("label", { cls: "rar-study-field" }); field.createSpan({ text: "针对这里的问题" });
		const input = field.createEl("textarea", { attr: { rows: "3", maxlength: "2000", "aria-label": "主题追问" } }); input.value = c.ui.drafts[node.id] || ""; input.disabled = c.busy;
		const actions = article.createDiv("rar-study-tools"), last = c.study!.graph.branches.find(b => b.id === node.branchId)?.nodeIds.slice(-1)[0];
		const ask = (newBranch: boolean) => this.generate({ kind: "ask", parentId: node.id, question: input.value, newBranch });
		const follow = this.button(actions, node.branchId ? "继续此支线" : "提出支线问题", "ask", () => ask(false), c.busy || !this.modelReady || !input.value.trim() || Boolean(node.branchId && last !== node.id));
		const fork = node.branchId ? this.button(actions, "从这里另开支线", "fork", () => ask(true), c.busy || !this.modelReady || !input.value.trim()) : undefined;
		input.oninput = () => { c.ui.drafts[node.id] = input.value; follow.disabled = c.busy || !this.modelReady || !input.value.trim() || Boolean(node.branchId && last !== node.id); if (fork) fork.disabled = c.busy || !this.modelReady || !input.value.trim(); this.persist(); };
	}
	private renderMap(root: HTMLElement): void {
		const c = this.controller, s = c.study!; root.createEl("h2", { text: "学习导图" });
		const actions = root.createDiv("rar-study-tools");
		this.button(actions, "缩小", "zoom-out", () => { c.ui.zoom = Math.max(0.4, c.ui.zoom - 0.1); this.render(); this.persist(); });
		this.button(actions, "放大", "zoom-in", () => { c.ui.zoom = Math.min(1.5, c.ui.zoom + 0.1); this.render(); this.persist(); });
		this.button(actions, "定位当前", "focus-map", () => { this.focusMap = true; c.select(c.ui.selectedId); }, c.busy || !c.selected);
		const viewport = root.createDiv("rar-study-map-scroll"); viewport.tabIndex = 0; viewport.setAttribute("aria-label", "学习导图，可滚动，点击节点回看对话");
		const layout = layoutLearning({ ...s.graph, collapsed: c.ui.collapsed }), extent = viewport.createDiv("rar-study-map-extent"), canvas = extent.createDiv("rar-study-map-canvas");
		extent.style.width = layout.width * c.ui.zoom + "px"; extent.style.height = layout.height * c.ui.zoom + "px"; canvas.style.width = layout.width + "px"; canvas.style.height = layout.height + "px"; canvas.style.transform = `scale(${c.ui.zoom})`;
		const svg = this.contentEl.doc.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", String(layout.width)); svg.setAttribute("height", String(layout.height)); canvas.appendChild(svg);
		const positions = new Map(layout.nodes.map(n => [n.id, n]));
		for (const point of layout.nodes) {
			const node = s.nodes.find(n => n.id === point.id)!, parent = positions.get(node.parentId || "");
			if (parent) { const line = this.contentEl.doc.createElementNS(svg.namespaceURI, "path"), x = parent.x + LEARNING_MAP.width / 2, y = parent.y + LEARNING_MAP.height; line.setAttribute("d", `M ${x} ${y} L ${point.x + LEARNING_MAP.width / 2} ${point.y}`); svg.appendChild(line); }
			const card = canvas.createDiv("rar-study-map-node"); card.style.left = point.x + "px"; card.style.top = point.y + "px"; card.dataset.studyNode = node.id;
			const b = this.button(card, node.title, "map-select", () => c.select(node.id), c.busy); b.setAttribute("aria-pressed", String(c.ui.selectedId === node.id));
			card.createSpan({ text: (node.branchId ? "支线" : "主线") + " · " + (node.status === "done" ? "已讲解" : "未完成"), cls: "rar-study-muted" });
			if (node.branchId) this.button(card, c.ui.collapsed.includes(node.branchId) ? `展开支线（其余 ${point.hiddenCount} 轮）` : "折叠支线", "collapse", () => c.toggle(node.branchId!), c.busy);
		}
		viewport.scrollLeft = c.ui.mapX; viewport.scrollTop = c.ui.mapY;
		const selected = positions.get(c.ui.selectedId);
		if (selected && (this.focusMap || this.mapSelection !== undefined && this.mapSelection !== c.ui.selectedId)) {
			const x = selected.x * c.ui.zoom, y = selected.y * c.ui.zoom, width = LEARNING_MAP.width * c.ui.zoom, height = LEARNING_MAP.height * c.ui.zoom;
			if (this.focusMap || x < viewport.scrollLeft || x + width > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = Math.max(0, x - (viewport.clientWidth - width) / 2);
			if (this.focusMap || y < viewport.scrollTop || y + height > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, y - (viewport.clientHeight - height) / 2);
			c.ui.mapX = viewport.scrollLeft; c.ui.mapY = viewport.scrollTop;
		}
		this.mapSelection = c.ui.selectedId; this.focusMap = false;
		viewport.onscroll = () => { c.ui.mapX = viewport.scrollLeft; c.ui.mapY = viewport.scrollTop; this.persist(); };
	}
}
