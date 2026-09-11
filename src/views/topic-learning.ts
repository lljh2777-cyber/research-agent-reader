import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { ReadingBackend } from "../reading/types";
import type { LearningEntry } from "../learning/entry";
import type { TopicLearningService } from "../topic-learning/service";
import { TopicWorkspaceController } from "../topic-learning/workspace";

export const TOPIC_LEARNING_VIEW_TYPE = "research-topic-learning";
export interface TopicLearningHost {
	getTopicLearning(): TopicLearningService;
	getTopicModels(): Array<{ id: string; name: string; model: string }>;
	createTopicBackend(profileId: string): ReadingBackend;
	activateLearningSpace(entry?: LearningEntry): Promise<void>;
}

/** Route preview only: no teaching nodes, evidence claims or automatic model requests. */
export class TopicLearningView extends ItemView {
	readonly controller: TopicWorkspaceController;
	private profileId = "";
	private query = "";
	private closed = false;
	private restoring: Promise<void> = Promise.resolve();
	constructor(leaf: WorkspaceLeaf, private readonly host: TopicLearningHost) {
		super(leaf); this.controller = new TopicWorkspaceController(host.getTopicLearning(), () => { this.render(); this.persist(); });
	}
	getViewType(): string { return TOPIC_LEARNING_VIEW_TYPE; }
	getDisplayText(): string { return "主题路线（预览）"; }
	getIcon(): string { return "route"; }
	getState(): Record<string, unknown> { return { draft: structuredClone(this.controller.draft), profileId: this.profileId, query: this.query }; }
	async setState(raw: unknown): Promise<void> {
		const state = raw as { draft?: unknown; profileId?: unknown; query?: unknown } | undefined;
		this.restoring = this.restoring.then(async () => {
			if (this.closed) return;
			this.profileId = typeof state?.profileId === "string" ? state.profileId.slice(0, 200) : "";
			this.query = typeof state?.query === "string" ? state.query.slice(0, 160) : "";
			this.controller.setDraft(state?.draft); await this.controller.refresh(); this.render();
		}); await this.restoring;
	}
	async selectSession(id: string): Promise<void> { await this.restoring; await this.controller.select(id); }
	async onOpen(): Promise<void> { this.render(); }
	async onClose(): Promise<void> { this.closed = true; this.controller.dispose(); this.contentEl.empty(); }
	private persist(): void { if (!this.closed) this.app.workspace.requestSaveLayout(); }
	private button(parent: HTMLElement, text: string, action: string, run: () => void, disabled = false): HTMLButtonElement {
		const b = parent.createEl("button", { text, attr: { type: "button", "data-topic-action": action } }); b.disabled = disabled; b.onclick = run; return b;
	}
	private field(parent: HTMLElement, text: string, key: string, value: string, max: number, update: (text: string) => void, multiline = false, disabled = false): void {
		const label = parent.createEl("label", { cls: "rar-topic-field" }); label.createSpan({ text });
		const input = multiline ? label.createEl("textarea", { attr: { rows: "3" } }) : label.createEl("input", { type: "text" });
		input.value = value; input.maxLength = max; input.dataset.topicField = key; input.disabled = disabled;
		let composing = false;
		input.addEventListener("compositionstart", () => { composing = true; });
		input.addEventListener("compositionend", () => { composing = false; update(input.value); if (key === "history-search") this.render(); else this.refreshDraftControls(); this.persist(); });
		input.oninput = () => { update(input.value); if (key === "history-search" && !composing) this.render(); else this.refreshDraftControls(); this.persist(); };
	}
	/** Keep input elements alive while typing, including IME composition and native undo history. */
	private refreshDraftControls(): void {
		const c = this.controller, root = this.contentEl;
		const disable = (action: string, disabled: boolean) => root.querySelectorAll<HTMLButtonElement>(`[data-topic-action="${action}"]`).forEach(b => { b.disabled = disabled; });
		const intent = c.draft.intent, resets = c.intentDirty && Boolean(c.draft.plan || c.current?.session.plan);
		const saveIntent = root.querySelector<HTMLButtonElement>('[data-topic-action="save-intent"]');
		saveIntent?.setText(resets ? "保存目标并重置路线" : "保存目标");
		disable("save-intent", !c.editable || !c.intentDirty || !intent.topic.trim() || !intent.goal.trim());
		const resetHint = root.querySelector<HTMLElement>("[data-topic-reset-hint]"); if (resetHint) resetHint.hidden = !resets;
		const discard = root.querySelector<HTMLButtonElement>('[data-topic-action="discard"]'); if (discard) { discard.hidden = !c.dirty && !c.stale; discard.disabled = c.busy; }
		disable("save-plan", !c.editable || c.intentDirty || !c.draft.plan || !c.dirty);
		disable("confirm", !c.editable || c.dirty || !c.current?.session.plan || Boolean(c.current?.session.confirmation));
		disable("generate", !c.editable || c.dirty || Boolean(c.current?.session.confirmation) || !this.host.getTopicModels().some(m => m.id === this.profileId));
		disable("add-unit", !c.editable || c.intentDirty || (c.draft.plan?.modules.length || 0) >= 12);
		disable("copy-revision", c.busy || c.dirty); disable("copy-draft", c.busy || !intent.topic.trim() || !intent.goal.trim());
		const hint = root.querySelector<HTMLElement>("[data-topic-dirty-hint]"); if (hint) hint.hidden = !c.dirty;
		for (const [index, unit] of (c.draft.plan?.modules || []).entries()) {
			const card = [...root.querySelectorAll<HTMLElement>("[data-unit-id]")].find(el => el.dataset.unitId === unit.id); if (!card) continue;
			const disabled = !c.editable || c.intentDirty;
			card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLFieldSetElement>("input,textarea,fieldset").forEach(el => { el.disabled = disabled; });
			card.querySelectorAll<HTMLButtonElement>("button").forEach(b => { b.disabled = disabled || b.dataset.topicAction === "up" && index === 0 || b.dataset.topicAction === "down" && index === c.draft.plan!.modules.length - 1; });
			for (const check of card.querySelectorAll<HTMLInputElement>("[data-prerequisite]")) {
				const label = check.parentElement?.querySelector("span"); if (label) label.textContent = c.draft.plan!.modules.find(m => m.id === check.dataset.prerequisite)?.title || "未命名单元";
			}
		}
	}
	private render(): void {
		if (this.closed) return;
		const active = this.contentEl.doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
		const field = active?.dataset?.topicField, start = active?.selectionStart, end = active?.selectionEnd, scroll = this.contentEl.scrollTop;
		this.contentEl.empty(); this.contentEl.addClass("rar-topic");
		const c = this.controller, header = this.contentEl.createDiv("rar-topic-header"), title = header.createDiv();
		title.createEl("h1", { text: "主题路线" }); title.createEl("p", { text: "预览 · 先安排想学的内容，再逐步深入。", cls: "rar-topic-muted" });
		this.button(header, "从资料开始", "document", () => { void this.host.activateLearningSpace({ kind: "document" }).catch(e => { c.message = String(e); this.render(); }); }, c.busy);
		this.contentEl.createEl("p", { text: "无需添加资料即可保存目标和安排路线。模型生成使用一般知识；讲解、对话与思维导图将在后续版本开放。", cls: "rar-topic-intro" });
		const status = this.contentEl.createDiv({ cls: "rar-topic-status", attr: { role: "status", "aria-live": "polite" } });
		const phases = { idle: "", loading: "正在读取已保存主题…", saving: "正在保存…", generating: "正在生成路线，可取消；不会自动重试。" };
		if (phases[c.phase]) status.createEl("p", { text: phases[c.phase] });
		if (c.message) status.createEl("p", { text: c.message });
		if (c.phase === "generating") this.button(status, "取消生成", "cancel", () => c.cancel());
		if (c.usage) {
			const u = c.usage, state = { running: "请求中", returned: "已返回", failed: "失败", cancelled: "已取消" }[u.state];
			status.createEl("p", { cls: "rar-topic-muted", text: `本次请求${state} · ${u.provider} · ${u.model} · 输入 ${u.input ?? "未报告"} / 输出 ${u.output ?? "未报告"} token${u.cachedInput === undefined ? "" : `（输入中缓存 ${u.cachedInput}）`}。仅展示本次打开期间的接口报告，用量缺失不代表零消耗。` });
		}
		const body = this.contentEl.createDiv("rar-topic-body"), sidebar = body.createDiv("rar-topic-sidebar"), editor = body.createDiv("rar-topic-editor");
		const historyActions = sidebar.createDiv("rar-topic-actions");
		this.button(historyActions, "新建主题", "new", () => { void c.select(""); }, c.busy);
		this.button(historyActions, "重新读取", "refresh", () => { void c.refresh(); }, c.busy);
		this.field(sidebar, "搜索已读取主题", "history-search", this.query, 160, value => { this.query = value; });
		sidebar.createEl("p", { text: `已读取 ${c.items.length} / ${c.total} 个主题`, cls: "rar-topic-muted" });
		const list = sidebar.createDiv("rar-topic-history");
		const matches = c.items.filter(item => (item.title + item.goal + item.id).toLowerCase().includes(this.query.trim().toLowerCase()));
		for (const item of matches) {
			const b = this.button(list, "", "select", () => { void c.select(item.id); }, c.busy); b.dataset.topicId = item.id; b.setAttribute("aria-pressed", String(item.id === c.draft.id));
			b.createEl("strong", { text: item.title }); b.createSpan({ text: item.status });
			b.createSpan({ text: item.goal.length > 90 ? item.goal.slice(0, 90) + "…" : item.goal });
			if (item.updatedAt) b.createSpan({ text: new Date(item.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) });
		}
		if (!c.items.length && !c.busy) list.createEl("p", { text: "还没有保存的主题，从右侧填写目标开始。", cls: "rar-topic-muted" });
		else if (!matches.length && !c.busy) list.createEl("p", { text: "没有匹配的主题，可修改关键词或读取更多主题。", cls: "rar-topic-muted" });
		if (c.items.length < c.total) this.button(sidebar, "读取更多主题", "more", () => { c.limit += 40; void c.refresh(); }, c.busy);
		if (c.stale) editor.createEl("p", { text: "已保存版本变化或历史需要处理。本地草稿仍保留；可查看历史、恢复已保存内容，或将本地目标另存为新主题。", cls: "rar-topic-warning" });
		if (c.history?.pending.length) editor.createEl("p", { text: `${c.history.pending.length} 次未完成的保存已保留，不作为当前版本。`, cls: "rar-topic-warning" });
		for (const error of c.history?.errors || []) editor.createEl("p", { text: error, cls: "rar-topic-warning" });
		const form = editor.createEl("section"); form.createEl("h2", { text: c.draft.id ? "学习目标" : "想学习什么" });
		const intent = c.draft.intent;
		this.field(form, "主题", "topic", intent.topic, 160, v => { intent.topic = v; }, false, c.busy);
		this.field(form, "希望达到的目标", "goal", intent.goal, 2000, v => { intent.goal = v; }, true, c.busy);
		this.field(form, "已有基础（可选）", "background", intent.background, 2000, v => { intent.background = v; }, true, c.busy);
		const intentActions = form.createDiv("rar-topic-actions");
		const resets = c.intentDirty && Boolean(c.draft.plan || c.current?.session.plan);
		this.button(intentActions, resets ? "保存目标并重置路线" : "保存目标", "save-intent", () => { void c.saveIntent(); }, !c.editable || !c.intentDirty || !intent.topic.trim() || !intent.goal.trim());
		form.createEl("p", { text: "目标变化后需要重新安排路线；已保存的旧路线仍可在历史版本中查看。", cls: "rar-topic-muted", attr: { "data-topic-reset-hint": "" } }).hidden = !resets;
		this.button(intentActions, "恢复已保存内容", "discard", () => { void c.select(c.draft.id, true); }, c.busy).hidden = !c.dirty && !c.stale;
		if (c.stale) this.button(intentActions, "本地目标另存为新主题", "copy-draft", () => { void c.copyDraft(); }, c.busy || !intent.topic.trim() || !intent.goal.trim());
		if (c.current) this.renderPlan(editor);
		this.renderHistory(editor);
		if (field) {
			const next = [...this.contentEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-topic-field]")].find(el => el.dataset.topicField === field);
			if (next && !next.disabled) { next.focus({ preventScroll: true }); if (start != null && end != null) next.setSelectionRange(start, end); }
		}
		this.contentEl.scrollTop = scroll;
	}
	private renderPlan(editor: HTMLElement): void {
		const c = this.controller, section = editor.createEl("section"); section.createEl("h2", { text: "学习路线" });
		const confirmed = c.current?.session.confirmation;
		section.createEl("p", { text: confirmed ? "已保存路线已确认；修改并保存后需重新确认。" : "待确认 · 填写 2–12 个单元，先修关系只指向前面的单元。", cls: "rar-topic-muted" });
		const origin = c.current?.session.planOrigin;
		if (origin) section.createEl("p", { text: origin.kind === "user" ? "已保存路线来源：用户编写或修改。" : `已保存路线来源：模型一般知识 · ${origin.provider} · ${origin.model}；未据此读取库内资料。`, cls: "rar-topic-muted" });
		const models = this.host.getTopicModels(), selector = section.createEl("label", { cls: "rar-topic-field" }); selector.createSpan({ text: "生成路线的模型" });
		const select = selector.createEl("select", { attr: { "aria-label": "生成路线的模型" } });
		select.createEl("option", { value: "", text: "手动填写，或选择已验证的模型" });
		for (const model of models) select.createEl("option", { value: model.id, text: model.name + " · " + model.model });
		select.value = this.profileId; select.disabled = c.busy; select.onchange = () => { this.profileId = select.value; this.render(); this.persist(); };
		if (!models.length) section.createEl("p", { text: "可先手动填写路线。使用模型时，请在插件设置中配置并测试 Direct API。", cls: "rar-topic-muted" });
		const generate = section.createDiv("rar-topic-actions");
		this.button(generate, c.current?.session.plan ? "重新生成路线草稿" : "生成路线草稿", "generate", () => { void c.generate(() => this.host.createTopicBackend(this.profileId)); }, !c.editable || c.dirty || Boolean(confirmed) || !models.some(m => m.id === this.profileId));
		section.createEl("p", { text: "点击生成会将已保存的主题、目标和基础发送给所选模型。重新生成会替换当前草稿，旧版本可在历史中查看。", cls: "rar-topic-muted" });
		for (const [index, unit] of (c.draft.plan?.modules || []).entries()) {
			const card = section.createDiv("rar-topic-unit"); card.dataset.unitId = unit.id;
			card.createEl("h3", { text: `单元 ${index + 1}` });
			const disabled = !c.editable || c.intentDirty;
			this.field(card, "标题", unit.id + ":title", unit.title, 160, v => { unit.title = v; }, false, disabled);
			this.field(card, "中心问题", unit.id + ":question", unit.question, 500, v => { unit.question = v; }, true, disabled);
			this.field(card, "学习目标", unit.id + ":objective", unit.objective, 1000, v => { unit.objective = v; }, true, disabled);
			const prereqs = card.createEl("fieldset"); prereqs.disabled = disabled; prereqs.createEl("legend", { text: "先修单元" });
			const previous = c.draft.plan!.modules.slice(0, index);
			if (!previous.length) prereqs.createEl("span", { text: "无前置单元", cls: "rar-topic-muted" });
			for (const candidate of previous) {
				const label = prereqs.createEl("label"), check = label.createEl("input", { type: "checkbox" }); check.checked = unit.prerequisites.includes(candidate.id); check.dataset.prerequisite = candidate.id;
				label.createSpan({ text: candidate.title || "未命名单元" }); check.onchange = () => { unit.prerequisites = check.checked ? [...unit.prerequisites, candidate.id] : unit.prerequisites.filter(id => id !== candidate.id); this.render(); this.persist(); };
			}
			const actions = card.createDiv("rar-topic-actions");
			this.button(actions, "上移", "up", () => c.moveModule(unit.id, -1), disabled || index === 0);
			this.button(actions, "下移", "down", () => c.moveModule(unit.id, 1), disabled || index === c.draft.plan!.modules.length - 1);
			this.button(actions, "移除此单元", "remove-unit", () => c.removeModule(unit.id), disabled);
		}
		const actions = section.createDiv("rar-topic-actions");
		this.button(actions, "添加单元", "add-unit", () => c.addModule(), !c.editable || c.intentDirty || (c.draft.plan?.modules.length || 0) >= 12);
		this.button(actions, "保存路线", "save-plan", () => { void c.savePlan(); }, !c.editable || c.intentDirty || !c.draft.plan || !c.dirty);
		this.button(actions, "确认路线", "confirm", () => { void c.confirm(); }, !c.editable || c.dirty || !c.current?.session.plan || Boolean(confirmed));
		section.createEl("p", { text: "有未保存修改；表单草稿随当前标签页保留，请保存后确认或切换主题。", cls: "rar-topic-muted", attr: { "data-topic-dirty-hint": "" } }).hidden = !c.dirty;
	}
	private renderHistory(parent: HTMLElement): void {
		const c = this.controller; if (!c.history?.revisions.length) return;
		const history = parent.createEl("details", { cls: "rar-topic-revisions" }); history.createEl("summary", { text: `查看 ${c.history.revisions.length} 个已保存版本` });
		for (const r of [...c.history.revisions].sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt) || a.id.localeCompare(b.id))) {
			const entry = history.createEl("details"); entry.createEl("summary", { text: `${r.session.updatedAt.replace("T", " ").replace(".000Z", " UTC")} · ${r.session.intent.topic}${r.digest === c.current?.digest ? " · 当前版本" : ""}` });
			entry.createEl("p", { text: "目标：" + r.session.intent.goal }); entry.createEl("p", { text: "基础：" + (r.session.intent.background || "未填写") });
			for (const unit of r.session.plan?.modules || []) entry.createEl("p", { text: `${unit.title}：${unit.question}；目标：${unit.objective}；先修：${unit.prerequisites.map(id => r.session.plan!.modules.find(m => m.id === id)?.title || id).join("、") || "无"}` });
			entry.createEl("p", { text: "复制将创建新主题，保留原历史，清除副本中的路线确认。", cls: "rar-topic-muted" });
			this.button(entry, "从此版本创建副本", "copy-revision", () => { void c.copyRevision(r.digest); }, c.busy || c.dirty);
		}
	}
}
