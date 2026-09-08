import { Component, ItemView, MarkdownRenderer, Menu, Modal, Notice, setIcon, type WorkspaceLeaf, type EventRef } from "obsidian";
import { setTimeout, clearTimeout } from "node:timers";
import type AgentDashboardPlugin from "../plugin";
import { ActionInputModal } from "../modals/action-input";
import { ACTION_BY_ID } from "../actions";
import { READING_VIEW_TYPE, type ReadingNode, type ReadingQuote, type ReadingSession, type ReadingWindow } from "../reading/types";
import { readingNode } from "../reading/session";
import { readingCategory, readingSourceKey, readingTitle, recentReading, type ReadingCategory } from "../reading/catalog";
import { layoutReading, READING_MAP } from "../reading/layout";
import { fitReadingZoom, readingTrail, revealReadingPath, searchReadingNodes } from "../reading/navigation";
import { resolveReadingQuote } from "../reading/selection";
import { readingCitations, readingSelectionText } from "../reading/presentation";
import { safeReadingMarkdown } from "../reading/export";
import { ReadingExportModal } from "./reading-export";
import { ReadingModeMotion } from "./reading-mode-motion";
import { ReadingEvidencePanel } from "./reading-evidence-panel";
import { LEARNING_LABELS, markReading, visitReadingEvidence } from "../reading/progress";
import { TEACHING_STYLES } from "../reading/teaching";
import type { ReadingTeachingStyle } from "../reading/types";
import { readingUsageSummary, USAGE_STAGES } from "../reading/usage";
import { readReadingOutcomes, type ReadingOutcome } from "../reading/outcomes";
import { acceptReadingCorrection, readingCoverage } from "../reading/quality";
import type { ReadingLearningState } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";

const element = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
	const node = document.createElement(tag); node.className = className; node.textContent = text; parent.appendChild(node); return node;
};
function button(parent: HTMLElement, text: string, action: () => void, title = text): HTMLButtonElement {
	const node = element(parent, "button", "", text); node.type = "button"; node.title = title; node.setAttribute("aria-label", title); node.onclick = action; return node;
}
function icon(parent: HTMLElement, name: string): HTMLElement { const node = element(parent, "span", "reading-icon"); node.setAttribute("aria-hidden", "true"); setIcon(node, name); return node; }
function actionButton(parent: HTMLElement, name: string, label: string, action: () => void, compact = false): HTMLButtonElement {
	const node = button(parent, "", action, label); node.className = compact ? "reading-icon-button" : "reading-action";
	icon(node, name); element(node, "span", compact ? "reading-sr-only" : "", label); return node;
}
export class ReadingWorkspaceView extends ItemView {
	private service!: ReadingWorkspaceService;
	private sessionId = "";
	private unsubscribe?: () => void;
	private unsubscribeStream?: () => void;
	private signature = "";
	private contentSignature = "";
	private modeMotion = new ReadingModeMotion(this.contentEl);
	private modeMainScroll = 0;
	private evidencePanel?: ReadingEvidencePanel;
	private outcomes = new Map<string, ReadingOutcome[]>(); private outcomeSequence = 0;
	private outcomeTimer?: ReturnType<typeof setTimeout>; private outcomeUnsubscribe?: () => void; private outcomeEvents: EventRef[] = [];
	private renderer = new Component();
	private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private scrollTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private scrollEdits = new Map<string, { sessionId: string; edit: (ui: ReadingSession["ui"]) => void }>();
	private localDrafts = new Map<string, string>();
	private quote?: ReadingQuote;
	private cleanupDrag?: () => void;
	private selectionBar?: HTMLElement;
	private selectionCleanup?: () => void;
	private modals = new Set<Modal>();
	constructor(leaf: WorkspaceLeaf, private readonly plugin: AgentDashboardPlugin) { super(leaf); }
	getViewType(): string { return READING_VIEW_TYPE; }
	getDisplayText(): string { return "PDF 交互深读"; }
	getIcon(): string { return "workflow"; }
	getState(): Record<string, unknown> { return { sessionId: this.sessionId }; }
	async setState(state: unknown): Promise<void> {
		const id = (state as { sessionId?: string })?.sessionId;
		if (id) { if (this.service?.repository.sessions.has(id)) this.selectSession(id); else this.sessionId = id; }
	}
	async onOpen(): Promise<void> {
		this.service = this.plugin.getReadingWorkspace(); await this.service.ready();
		this.evidencePanel = new ReadingEvidencePanel(this.app, this.service, this.plugin);
		this.outcomeUnsubscribe = this.plugin.getCurationService().subscribe(() => this.scheduleOutcomes());
		const refreshExports = (file: { path: string }): void => { if (file.path.startsWith("wiki/qa/")) this.scheduleOutcomes(); };
		this.outcomeEvents.push(this.app.vault.on("create", refreshExports), this.app.vault.on("modify", refreshExports), this.app.vault.on("delete", refreshExports));
		this.outcomeEvents.push(this.app.vault.on("rename", (file, old) => { if (file.path.startsWith("wiki/qa/") || old.startsWith("wiki/qa/")) this.scheduleOutcomes(); }));
		const restored = this.service.repository.sessions.get(this.sessionId);
		if (!restored || restored.archived || readingCategory(restored) !== "reading") this.sessionId = recentReading(this.service.repository.sessions.values())[0]?.id || "";
		this.renderer.load(); this.unsubscribe = this.service.repository.subscribe((id) => { if (id === this.sessionId) { this.render(); this.evidencePanel?.sync(this.session, this.contentEl); } });
		this.unsubscribeStream = this.plugin.getReadingEngine().subscribe((id, nodeId, text) => {
			if (id !== this.sessionId) return;
			this.contentEl.querySelectorAll<HTMLElement>("[data-answer-id]").forEach((answer) => {
				if (answer.dataset.answerId === nodeId) { const body = answer.querySelector(".reading-answer-content"); if (body) body.textContent = text; }
			});
		});
		this.quote = this.session?.ui.pendingQuote;
		const dismissSelection = (event: PointerEvent): void => { if (!this.selectionBar?.contains(event.target as Node)) this.hideSelectionActions(); };
		const dismissOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") this.hideSelectionActions(); };
		const dismissOnScroll = (): void => this.hideSelectionActions();
		document.addEventListener("pointerdown", dismissSelection); document.addEventListener("keydown", dismissOnEscape);
		this.contentEl.addEventListener("scroll", dismissOnScroll, true);
		this.selectionCleanup = () => { document.removeEventListener("pointerdown", dismissSelection); document.removeEventListener("keydown", dismissOnEscape); this.contentEl.removeEventListener("scroll", dismissOnScroll, true); };
		this.render(true);
		this.scheduleOutcomes();
		if (this.service.repository.errors.length) new Notice("部分阅读会话无法加载，文件已保留：" + this.service.repository.errors.join("；"), 10000);
	}
	async onClose(): Promise<void> {
		this.outcomeSequence++; clearTimeout(this.outcomeTimer); this.outcomeUnsubscribe?.(); this.outcomeEvents.forEach(ref => this.app.vault.offref(ref));
		this.evidencePanel?.dispose();
		this.modeMotion.stop();
		this.unsubscribe?.(); this.unsubscribeStream?.(); this.cleanupDrag?.(); this.selectionCleanup?.(); this.hideSelectionActions(); this.renderer.unload();
		for (const modal of this.modals) modal.close();
		for (const timer of this.draftTimers.values()) clearTimeout(timer);
		for (const timer of this.scrollTimers.values()) clearTimeout(timer);
		for (const pending of this.scrollEdits.values()) await this.service.repository.transact(pending.sessionId, (session) => pending.edit(session.ui)).catch((error) => new Notice(String(error)));
		for (const [key, value] of this.localDrafts) { const separator = key.indexOf("|"); const id = key.slice(0, separator); const target = key.slice(separator + 1);
			await this.service.repository.transact(id, (session) => { session.ui.drafts[target] = value; }).catch((error) => new Notice(String(error))); }
	}
	private get session(): ReadingSession | undefined { return this.service?.repository.sessions.get(this.sessionId); }
	private handle(operation: Promise<unknown>): void { void operation.catch((error) => new Notice(error instanceof Error ? error.message : String(error))); }
	private updateUI(edit: (ui: ReadingSession["ui"]) => void): void {
		const id = this.sessionId; this.handle(this.service.repository.transact(id, (session) => edit(session.ui)));
	}
	private selectSession(id: string): void { this.modeMotion.stop(); this.outcomes.clear(); this.sessionId = id; this.quote = id ? this.service.repository.get(id).ui.pendingQuote : undefined; this.signature = ""; this.contentEl.replaceChildren(); this.render(true); this.app.workspace.requestSaveLayout();
		this.scheduleOutcomes();
		if (id) this.handle(this.service.repository.transact(id, (s) => { s.lastOpenedAt = new Date().toISOString(); }));
	}
	private rememberScroll(key: string, edit: (ui: ReadingSession["ui"]) => void): void {
		const sessionId = this.sessionId; const fullKey = sessionId + ":" + key;
		this.scrollEdits.set(fullKey, { sessionId, edit }); clearTimeout(this.scrollTimers.get(fullKey));
		this.scrollTimers.set(fullKey, setTimeout(() => { this.scrollEdits.delete(fullKey); this.handle(this.service.repository.transact(sessionId, (draft) => edit(draft.ui))); }, 250));
	}
	private renderHeader(session?: ReadingSession): void {
		const header = element(this.contentEl, "header", "reading-header");
		const identity = element(header, "div", "reading-identity"); const mark = element(identity, "div", "reading-brand-mark"); icon(mark, "book-open");
		const names = element(identity, "div", "reading-identity-text");
		const eyebrow = element(names, "div", "reading-eyebrow"); element(eyebrow, "span", "", "交互深读");
		if (session) element(eyebrow, "span", "reading-source-badge", session.demo ? "交互演示" : session.source.kind === "pdf" ? "PDF 原文" : "MinerU 原文");
		const select = button(names, session ? readingTitle(session) : "选择或管理阅读会话", () => this.openSessionLibrary(), "选择阅读会话"); select.className = "reading-session-select";
		icon(names, "chevron-down").classList.add("reading-session-chevron");
		const actions = element(header, "div", "reading-header-actions");
		if (session) {
			const modes = element(actions, "div", "reading-mode-switch"); modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "阅读模式");
			element(modes, "span", "reading-mode-indicator").setAttribute("aria-hidden", "true");
			for (const [mode, name, label] of [["split", "panels-left-bottom", "导图＋对话"], ["map", "git-branch", "仅思维导图"]] as const) {
				const control = actionButton(modes, name, label, () => this.updateUI((ui) => { ui.mode = mode; })); control.dataset.readingMode = mode; control.setAttribute("aria-pressed", String(session.ui.mode === mode));
			}
			actionButton(actions, "download", "导出学习笔记", () => this.openExport(), true);
			if (!session.demo) actionButton(actions, "sparkles", "阅读助手", () => this.plugin.openReadingAssistant(session.id, this.session!.ui.selectedId), true);
			if (!session.demo) actionButton(actions, "notebook-pen", "整理进知识库", () => this.plugin.openKnowledgeCuration(session.id, this.session!.ui.selectedId), true);
		}
		const create = actionButton(actions, "plus", "新建阅读", () => this.openSource()); create.classList.add("reading-primary");
		const more = actionButton(actions, "ellipsis", "更多阅读选项", () => {
			const menu = new Menu();
			if (session) menu.addItem((item) => item.setTitle("阅读模型").setIcon("sliders-horizontal").onClick(() => this.openModel()));
			if (session && !session.demo) {
				menu.addItem(item => item.setTitle("证据覆盖").setIcon("list-checks").onClick(() => this.handle(this.openCoverage())));
				menu.addItem(item => item.setTitle("重新定位原文").setIcon("folder-search").onClick(() => this.openRelocate()));
			}
			if (session) menu.addItem(item => item.setTitle("阅读用量").setIcon("gauge").onClick(() => { const modal = this.modal("本会话模型用量"); element(modal.contentEl, "pre", "reading-usage-summary", readingUsageSummary(this.session!)); modal.open(); }));
			menu.addItem(item => item.setTitle("知识库维护").setIcon("notebook-pen").onClick(() => this.plugin.openKnowledgeMaintenance()));
			menu.addItem((item) => item.setTitle("交互演示").setIcon("play").onClick(() => this.handle(this.service.demo().then((id) => this.selectSession(id)))));
			menu.addItem((item) => item.setTitle("一次性深读").setIcon("file-text").onClick(() => new ActionInputModal(this.app, this.plugin, ACTION_BY_ID.get("pdf-xray")!, ({ input, overrides, options }) => this.handle(this.plugin.runClassicReading(input, overrides, options))).open()));
			const box = more.getBoundingClientRect(); menu.showAtPosition({ x: box.right, y: box.bottom });
		}, true); more.setAttribute("aria-haspopup", "menu");
	}
	private renderEmpty(): void {
		const empty = element(this.contentEl, "div", "reading-empty"); icon(empty, "book-open");
		element(empty, "p", "reading-eyebrow", "从一篇论文，展开理解"); element(empty, "h2", "", "沿着主线读，带着问题探索");
		element(empty, "p", "", "让 AI 逐步讲解论文，在导图中追问、回看依据，并保存你的阅读过程。");
		const actions = element(empty, "div", "reading-empty-actions"); actionButton(actions, "plus", "打开一篇论文", () => this.openSource()).classList.add("reading-primary");
		actionButton(actions, "play", "先体验交互演示", () => this.handle(this.service.demo().then((id) => this.selectSession(id))));
		element(empty, "small", "", "支持原始 PDF 与已验证的 MinerU article.md");
	}
	private render(force = false): void {
		const session = this.session;
		const contentSignature = JSON.stringify(session ? [session.id, session.title, session.archived, session.pinned, session.nodes, session.outline, session.completed, session.backend, session.model,
			session.ui.split, session.ui.pendingQuote, session.ui.mainComposerExpanded, session.ui.zoom,
			session.ui.learningFilter,
			session.ui.windows.map(({ scrollTop: _scroll, ...geometry }) => geometry), session.ui.collapsed] : null);
		const signature = contentSignature + JSON.stringify([session?.ui.mode, session?.ui.selectedId, session?.ui.mainFocusId]);
		if (!force && this.signature === signature) return; this.signature = signature;
		if (!force && session && this.contentSignature === contentSignature && this.contentEl.querySelector(".reading-body")) {
			this.cleanupDrag?.(); this.hideSelectionActions();
			// Keep node elements mounted between the two clicks of a native double-click.
			this.contentEl.querySelectorAll<HTMLElement>(".reading-map-node").forEach(card => {
				const selected = card.dataset.nodeId === session.ui.selectedId;
				card.classList.toggle("is-selected", selected); card.querySelector(".reading-node-open")?.setAttribute("aria-current", String(selected));
			});
			const focus = this.contentEl.querySelector<HTMLButtonElement>(".reading-focus-node"); if (focus) focus.disabled = !session.ui.selectedId;
			this.renderMode(session, this.contentEl.dataset.mode !== session.ui.mode); return;
		}
		this.contentSignature = contentSignature; this.modeMotion.stop();
		this.cleanupDrag?.(); this.hideSelectionActions();
		const oldScroll = new Map<string, [number, number]>();
		this.contentEl.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((node) => oldScroll.set(node.dataset.scrollKey!, [node.scrollLeft, node.scrollTop]));
		if (this.contentEl.dataset.mode === "map" && oldScroll.has("main")) oldScroll.set("main", [0, this.modeMainScroll]);
		const focused = this.contentEl.contains(document.activeElement) ? document.activeElement as HTMLTextAreaElement : null;
		const focusKey = focused?.dataset.composer; const cursor = focused?.selectionStart; const focusDivider = focused?.classList.contains("reading-divider");
		const focusResize = focused?.classList.contains("reading-resize") ? focused.closest<HTMLElement>(".reading-float")?.dataset.windowKey : undefined;
		this.renderer.unload(); this.renderer = new Component(); this.renderer.load();
		this.contentEl.replaceChildren(); this.contentEl.classList.add("reading-workspace");
		this.contentEl.dataset.mode = session?.ui.mode || "empty";
		this.renderHeader(session);
		if (!session) { this.renderEmpty(); return; }
		const body = element(this.contentEl, "div", "reading-body");
		body.style.setProperty("--reading-split", String(session.ui.split));
		{
			const panel = element(body, "div", "reading-main-chat"); panel.style.flexBasis = (session.ui.split * 100) + "%";
			const chat = element(panel, "div", "reading-main-chat-inner");
			const heading = element(chat, "div", "reading-panel-heading"); icon(heading, "align-left"); element(heading, "h2", "", "主线讲解");
			const completed = session.mainIds.filter((id) => readingNode(session, id).status === "done").length;
			element(heading, "span", "reading-panel-meta", session.outline.length ? completed + " / " + session.outline.length + " 节" : completed + " 个单元");
			const messages = element(chat, "div", "reading-messages"); messages.dataset.scrollKey = "main";
			messages.onscroll = () => { if (this.session?.ui.mode !== "split") return; const top = messages.scrollTop; this.rememberScroll("main", (ui) => { ui.mainScroll = top; }); };
			if (session.outline.length) {
				const details = element(messages, "details", "reading-outline"); const summary = element(details, "summary"); icon(summary, "list-tree"); element(summary, "span", "", "阅读路线");
				element(summary, "span", "reading-outline-count", session.outline.length + " 个单元"); icon(summary, "chevron-down");
				session.outline.forEach((title, i) => { const row = button(details, "", () => { if (session.mainIds[i]) this.selectNode(session.mainIds[i]); }, title);
					row.disabled = !session.mainIds[i]; element(row, "span", "reading-outline-number", String(i + 1).padStart(2, "0"));
					const label = element(row, "span", "reading-outline-label"); element(label, "span", "", title);
					const question = session.modulePlan?.modules[i]?.question; if (question) element(label, "small", "", question); });
			}
			for (const id of session.mainIds) this.renderAnswer(messages, readingNode(session, id));
			if (!session.mainIds.length) button(messages, "开始讲解 →", () => this.handle(this.service.advance(session.id)));
			const divider = element(body, "div", "reading-divider"); divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", "调整对话与导图宽度");
			divider.tabIndex = 0; divider.setAttribute("aria-orientation", "vertical"); divider.setAttribute("aria-valuemin", "25"); divider.setAttribute("aria-valuemax", "75"); divider.setAttribute("aria-valuenow", String(Math.round(session.ui.split * 100)));
			divider.onkeydown = (event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); this.updateUI((ui) => { ui.split = Math.max(0.25, Math.min(0.75, ui.split + (event.key === "ArrowLeft" ? -0.05 : 0.05))); }); } };
			this.drag(divider, (event) => { const box = body.getBoundingClientRect(); const split = Math.max(0.25, Math.min(0.75, (event.clientX - box.left) / box.width)); panel.style.flexBasis = split * 100 + "%"; return () => this.updateUI((ui) => { ui.split = split; }); });
		}
		const mapArea = element(body, "div", "reading-map-area");
		const mapHeading = element(mapArea, "div", "reading-panel-heading"); icon(mapHeading, "git-branch"); element(mapHeading, "h2", "", "学习导图");
		const legend = element(mapHeading, "div", "reading-map-legend"); element(legend, "span", "is-main", "主线"); element(legend, "span", "is-branch", "追问");
		actionButton(mapHeading, "search", "搜索导图节点", () => this.openNodeSearch(), true);
		const latest = actionButton(mapHeading, "list-end", "返回最新主线", () => this.selectNode(session.mainIds[session.mainIds.length - 1], true), true); latest.disabled = !session.mainIds.length;
		const map = element(mapArea, "div", "reading-map-scroll"); map.dataset.scrollKey = "map";
		map.tabIndex = 0; map.setAttribute("aria-label", "学习导图；单击选中节点，双击打开小窗；拖动空白处平移");
		map.onscroll = () => { const x = map.scrollLeft; const y = map.scrollTop; this.rememberScroll("map", (ui) => { ui.scrollX = x; ui.scrollY = y; }); };
		let panX = 0; let panY = 0; let scrollX = 0; let scrollY = 0;
		this.drag(map, (event, first) => {
			if (first) { panX = event.clientX; panY = event.clientY; scrollX = map.scrollLeft; scrollY = map.scrollTop; map.classList.add("is-panning"); }
			map.scrollLeft = scrollX + panX - event.clientX; map.scrollTop = scrollY + panY - event.clientY;
			return () => { const x = map.scrollLeft; const y = map.scrollTop; this.rememberScroll("map", (ui) => { ui.scrollX = x; ui.scrollY = y; }); };
		}, (event) => !(event.target as HTMLElement).closest(".reading-map-node"));
		this.renderMap(map, session);
		const mapFooter = element(mapArea, "div", "reading-map-footer");
		element(mapFooter, "span", "reading-map-hint", session.nodes.length + " 个节点 · 单击选中 · 双击打开");
		const filter = element(mapFooter, "select", "reading-learning-filter"); filter.setAttribute("aria-label", "筛选学习状态");
		for (const [value, label] of [["all", "全部学习状态"], ...Object.entries(LEARNING_LABELS)]) element(filter, "option", "", label).value = value;
		filter.value = session.ui.learningFilter || "all"; filter.onchange = () => this.updateUI(ui => { ui.learningFilter = filter.value as ReadingLearningState | "all"; });
		const controls = element(mapFooter, "div", "reading-map-controls");
		actionButton(controls, "minus", "缩小导图", () => this.updateUI((ui) => { ui.zoom = Math.max(0.4, ui.zoom - 0.1); }), true);
		const zoom = button(controls, Math.round(session.ui.zoom * 100) + "%", () => this.updateUI((ui) => { ui.zoom = 1; }), "恢复原始缩放"); zoom.className = "reading-zoom-value";
		actionButton(controls, "plus", "放大导图", () => this.updateUI((ui) => { ui.zoom = Math.min(1.8, ui.zoom + 0.1); }), true);
		actionButton(controls, "scan", "适应视野", () => this.fitMap(), true);
		const focus = actionButton(controls, "focus", "定位选中节点", () => this.revealMapNode(this.session!.ui.selectedId), true); focus.classList.add("reading-focus-node"); focus.disabled = !session.ui.selectedId;
		element(mapArea, "div", "reading-map-composer");
		this.renderMode(session, false);
		if (!session.mainIds.length) button(mapArea, "开始讲解 →", () => this.handle(this.service.advance(session.id)));
		const windows = element(this.contentEl, "div", "reading-windows");
		for (const floating of session.ui.windows) this.renderWindow(windows, floating);
		this.contentEl.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((node) => {
			const key = node.dataset.scrollKey!;
			const saved = oldScroll.get(key) || (key === "main" ? [0, session.ui.mainScroll || 0] : key === "map" ? [session.ui.scrollX, session.ui.scrollY] : [0, session.ui.windows.find((w) => w.key === key)?.scrollTop || 0]);
			if (key === "main") this.modeMainScroll = saved[1];
			node.style.scrollBehavior = "auto"; node.scrollLeft = saved[0]; node.scrollTop = saved[1]; node.style.scrollBehavior = "";
		});
		if (focusKey) { const input = [...this.contentEl.querySelectorAll<HTMLTextAreaElement>("textarea[data-composer]")].find((item) => item.dataset.composer === focusKey);
			input?.focus({ preventScroll: true }); if (input && cursor != null) input.setSelectionRange(cursor, cursor); }
		else if (focusDivider) this.contentEl.querySelector<HTMLElement>(".reading-divider")?.focus({ preventScroll: true });
		else if (focusResize) [...this.contentEl.querySelectorAll<HTMLElement>(".reading-float")].find((w) => w.dataset.windowKey === focusResize)?.querySelector<HTMLElement>(".reading-resize")?.focus({ preventScroll: true });
		this.evidencePanel?.sync(session, this.contentEl);
		this.renderOutcomes();
	}
	private renderMode(session: ReadingSession, animate: boolean): void {
		const messages = this.contentEl.querySelector<HTMLElement>(".reading-main-chat .reading-messages")!;
		if (animate && this.contentEl.dataset.mode === "split") this.modeMainScroll = messages.scrollTop;
		const focused = this.contentEl.ownerDocument.activeElement as HTMLTextAreaElement | null;
		const focusMain = focused?.dataset.composer?.startsWith("main:") && this.contentEl.contains(focused);
		const start = focused?.selectionStart; const end = focused?.selectionEnd;
		this.modeMotion.change(session.ui.mode, () => {
			const chat = this.contentEl.querySelector<HTMLElement>(".reading-main-chat")!;
			chat.style.flexBasis = session.ui.mode === "split" ? session.ui.split * 100 + "%" : "0px";
			const inner = chat.querySelector<HTMLElement>(".reading-main-chat-inner")!;
			inner.querySelector(".reading-composer")?.remove();
			const composer = this.contentEl.querySelector<HTMLElement>(".reading-map-composer")!; composer.replaceChildren();
			if (session.ui.mode === "split") this.renderComposer(inner, "main");
			else if (session.ui.windows.some(w => !w.minimized) && !session.ui.mainComposerExpanded) {
				const collapsed = element(composer, "div", "reading-composer-collapsed");
				actionButton(collapsed, "message-square-plus", "从主线新建支线", () => this.updateUI(ui => { ui.mainComposerExpanded = true; }));
			} else this.renderComposer(composer, "main");
		}, animate);
		if (animate && session.ui.mode === "split") {
			messages.style.scrollBehavior = "auto"; messages.scrollTop = this.modeMainScroll; messages.style.scrollBehavior = "";
		}
		if (focusMain) {
			const input = this.contentEl.querySelector<HTMLTextAreaElement>("textarea[data-composer^='main:']");
			input?.focus({ preventScroll: true }); if (start != null && end != null) input?.setSelectionRange(start, end);
			if (!input) this.contentEl.querySelector<HTMLButtonElement>("[data-reading-mode][aria-pressed='true']")?.focus({ preventScroll: true });
		}
	}
	private renderMap(parent: HTMLElement, session: ReadingSession): void {
		const layout = layoutReading(session); const outer = element(parent, "div", "reading-map-extent");
		outer.style.width = layout.width * session.ui.zoom + "px"; outer.style.height = layout.height * session.ui.zoom + "px";
		const canvas = element(outer, "div", "reading-map-canvas"); canvas.style.width = layout.width + "px"; canvas.style.height = layout.height + "px"; canvas.style.transform = "scale(" + session.ui.zoom + ")";
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", String(layout.width)); svg.setAttribute("height", String(layout.height)); canvas.appendChild(svg);
		const positions = new Map(layout.nodes.map((node) => [node.id, node]));
		for (const point of layout.nodes) {
			const node = readingNode(session, point.id); const previous = node.parentId ? positions.get(node.parentId) : null;
			if (previous) { const line = document.createElementNS(svg.namespaceURI, "path"); const vertical = node.branchId === readingNode(session, previous.id).branchId;
				const x1 = previous.x + (vertical ? READING_MAP.width / 2 : READING_MAP.width); const y1 = previous.y + (vertical ? READING_MAP.height : READING_MAP.height / 2);
				const x2 = point.x + (vertical ? READING_MAP.width / 2 : 0); const y2 = point.y + (vertical ? 0 : READING_MAP.height / 2);
				line.setAttribute("class", node.branchId ? "is-branch" : "is-main");
				line.setAttribute("d", `M ${x1} ${y1} C ${vertical ? x1 : x1 + 36} ${vertical ? y1 + 28 : y1}, ${vertical ? x2 : x2 - 36} ${vertical ? y2 - 28 : y2}, ${x2} ${y2}`); svg.appendChild(line); }
			const card = element(canvas, "div", "reading-map-node " + (node.branchId ? "is-branch" : "is-main") + (session.ui.selectedId === node.id ? " is-selected" : ""));
			const learning = node.learningState || "unmarked"; card.dataset.learningState = learning;
			if (session.ui.learningFilter && session.ui.learningFilter !== "all" && session.ui.learningFilter !== learning) card.classList.add("is-learning-muted");
			card.style.left = point.x + "px"; card.style.top = point.y + "px"; card.dataset.nodeId = node.id;
			card.style.width = READING_MAP.width + "px"; card.style.height = READING_MAP.height + "px"; card.dataset.status = node.status;
			const open = button(card, "", () => this.selectMapNode(node.id), node.title || "正在准备"); open.className = "reading-node-open"; open.setAttribute("aria-current", String(session.ui.selectedId === node.id));
			open.title += " · 单击选中，双击打开小窗"; open.setAttribute("aria-description", "单击或空格选中；双击或 Enter 打开小窗");
			open.ondblclick = () => this.selectNode(node.id, false, true);
			open.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); if (!event.repeat) this.selectNode(node.id, false, true); } };
			const label = element(open, "span", "reading-node-label");
			if (node.branchId) { icon(label, "corner-down-right"); element(label, "span", "", "追问"); }
			else { element(label, "span", "reading-node-number", String(session.mainIds.indexOf(node.id) + 1).padStart(2, "0")); element(label, "span", "", "主线单元"); }
			element(open, "span", "reading-node-title", node.title || "正在准备讲解");
			const meta = element(card, "div", "reading-node-meta"); icon(meta, node.status === "done" ? "check" : node.status === "failed" || node.status === "interrupted" ? "circle-alert" : "loader-circle");
			element(meta, "span", "", ({ pending: "准备中", running: "正在讲解", done: "已讲解", failed: "生成失败", interrupted: "已中断" })[node.status]);
			if (point.hiddenCount) element(meta, "span", "reading-node-questions", "另 " + point.hiddenCount + " 轮");
			const questions = session.branches.filter((branch) => branch.parentNodeId === node.id).length;
			if (questions) element(meta, "span", "reading-node-questions", questions + " 条追问");
			if (node.branchId) { const collapsed = session.ui.collapsed.includes(node.branchId); const toggle = actionButton(meta, collapsed ? "chevrons-down" : "chevrons-up", collapsed ? "展开" : "折叠", () => this.updateUI((ui) => { ui.collapsed = ui.collapsed.includes(node.branchId!) ? ui.collapsed.filter((id) => id !== node.branchId) : [...ui.collapsed, node.branchId!]; }), true); if (point.hiddenCount) toggle.title += " · " + point.hiddenCount + " 轮"; }
			if (node.id === session.mainIds[session.mainIds.length - 1] && node.status === "done" && !session.completed) {
				const next = actionButton(card, "arrow-right", "继续下一步主线", () => this.handle(this.service.advance(session.id)), true); next.classList.add("reading-advance");
			}
		}
	}
	private focusMapNode(id: string): void {
		const map = this.contentEl.querySelector<HTMLElement>(".reading-map-scroll");
		const card = [...this.contentEl.querySelectorAll<HTMLElement>("[data-node-id]")].find((item) => item.dataset.nodeId === id);
		if (!map || !card) return;
		const bounds = map.getBoundingClientRect(); const box = card.getBoundingClientRect();
		map.scrollTo({ left: map.scrollLeft + box.left - bounds.left - (map.clientWidth - box.width) / 2, top: map.scrollTop + box.top - bounds.top - (map.clientHeight - box.height) / 2 });
		card.classList.add("reading-highlight");
	}
	private revealMapNode(id: string): void {
		const sessionId = this.sessionId;
		this.handle(this.service.repository.transact(sessionId, (session) => revealReadingPath(session, id)).then(() => { if (this.sessionId === sessionId) this.focusMapNode(id); }));
	}
	private fitMap(): void {
		const session = this.session!; const map = this.contentEl.querySelector<HTMLElement>(".reading-map-scroll"); if (!map) return;
		const layout = layoutReading(session); const extent = map.querySelector<HTMLElement>(".reading-map-extent")!;
		const margin = parseFloat(getComputedStyle(extent).marginLeft) || 0;
		const fitted = fitReadingZoom(layout.width, layout.height, map.clientWidth - margin, map.clientHeight);
		this.handle(this.service.repository.transact(session.id, (draft) => { draft.ui.zoom = fitted.zoom; }).then(() => {
			if (session.id !== this.sessionId) return;
			this.contentEl.querySelector<HTMLElement>(".reading-map-scroll")?.scrollTo(0, 0);
			if (fitted.limited) new Notice("已缩小至 40%；长导图可折叠支线，或搜索并定位节点");
		}));
	}
	private selectMapNode(id: string): void {
		const node = readingNode(this.session!, id);
		this.updateUI(ui => { ui.selectedId = id; if (!node.branchId) ui.mainFocusId = id; });
	}
	private selectNode(id: string, reveal = false, popup = false): void {
		const session = this.session!; const node = readingNode(session, id);
		this.quote = undefined;
		this.handle(this.service.repository.transact(session.id, (draft) => {
			draft.ui.selectedId = id;
			draft.ui.pendingQuote = undefined;
			revealReadingPath(draft, id);
			if (!node.branchId) draft.ui.mainFocusId = id;
			if (popup || draft.ui.mode === "map" || node.branchId) this.ensureWindow(draft, id);
		}).then(() => {
			if (session.id !== this.sessionId) return;
			const selector = popup || node.branchId || session.ui.mode === "map" ? ".reading-float [data-answer-id]" : ".reading-main-chat [data-answer-id]";
			const answer = [...this.contentEl.querySelectorAll<HTMLElement>(selector)].find((item) => item.dataset.answerId === id);
			answer?.scrollIntoView({ block: "nearest", behavior: "smooth" }); answer?.classList.add("reading-highlight");
			if (reveal) this.focusMapNode(id);
		}));
	}
	private ensureWindow(session: ReadingSession, id: string): void {
		const node = readingNode(session, id); const key = node.branchId || id;
		const existing = session.ui.windows.find((item) => item.key === key);
		if (existing) { existing.nodeId = id; existing.minimized = false; return; }
		session.ui.windows = session.ui.windows.filter((item) => item.pinned);
		session.ui.windows.push({ key, nodeId: id, pinned: false, minimized: false, x: Math.max(32, this.contentEl.clientWidth - 568), y: 124, width: 520, height: 560 });
	}
	private renderWindow(parent: HTMLElement, state: ReadingWindow): void {
		const session = this.session!; const node = session.nodes.find((item) => item.id === state.nodeId); if (!node) return;
		const floating = element(parent, "section", "reading-float" + (state.minimized ? " is-minimized" : "") + (node.branchId ? " is-branch" : "") + (state.pinned ? " is-pinned" : "")); floating.setAttribute("role", "dialog"); floating.setAttribute("aria-label", node.title);
		const width = Math.min(state.minimized ? 320 : state.width, Math.max(280, this.contentEl.clientWidth - 24));
		const height = Math.min(state.height, Math.max(220, this.contentEl.clientHeight - 52));
		floating.dataset.windowKey = state.key; floating.style.left = Math.max(0, Math.min(state.x, this.contentEl.clientWidth - width - 12)) + "px";
		floating.style.top = Math.max(40, Math.min(state.y, this.contentEl.clientHeight - (state.minimized ? 72 : height) - 12)) + "px";
		floating.style.width = width + "px"; floating.style.height = state.minimized ? "auto" : height + "px";
		floating.onpointerdown = () => { this.contentEl.querySelectorAll<HTMLElement>(".reading-float").forEach((item) => { item.style.zIndex = item === floating ? "12" : "10"; }); };
		const header = element(floating, "div", "reading-float-header"); icon(header, node.branchId ? "messages-square" : "book-open");
		const heading = element(header, "div", "reading-float-heading"); element(heading, "span", "reading-sr-only", node.branchId ? "支线对话" : "主线讲解");
		element(heading, "strong", "", node.branchId ? readingNode(session, session.branches.find((b) => b.id === node.branchId)!.nodeIds[0]).question : node.title);
		const pin = actionButton(header, state.pinned ? "pin-off" : "pin", state.pinned ? "取消固定" : "固定", () => this.updateUI((ui) => { ui.windows.find((w) => w.key === state.key)!.pinned = !state.pinned; }), true); pin.setAttribute("aria-pressed", String(state.pinned));
		actionButton(header, state.minimized ? "chevron-down" : "minus", state.minimized ? "展开" : "收起", () => this.updateUI((ui) => { ui.windows.find((w) => w.key === state.key)!.minimized = !state.minimized; }), true);
		actionButton(header, "x", "关闭窗口，保留对话", () => this.updateUI((ui) => { ui.windows = ui.windows.filter((w) => w.key !== state.key); }), true);
		let offsetX = 0; let offsetY = 0;
		this.drag(header, (event, first) => {
			const outer = this.contentEl.getBoundingClientRect(); if (first) { const rect = floating.getBoundingClientRect(); offsetX = event.clientX - rect.left; offsetY = event.clientY - rect.top; }
			const x = Math.max(0, Math.min(outer.width - floating.offsetWidth - 12, event.clientX - outer.left - offsetX)); const y = Math.max(40, Math.min(outer.height - floating.offsetHeight - 12, event.clientY - outer.top - offsetY));
			floating.style.left = x + "px"; floating.style.top = y + "px";
			return () => this.updateUI((ui) => { const saved = ui.windows.find((w) => w.key === state.key); if (saved) { saved.x = x; saved.y = y; } });
		});
		if (state.minimized) return;
		if (node.branchId) {
			const trail = readingTrail(session, node.id); const path = element(floating, "nav", "reading-breadcrumb"); path.setAttribute("aria-label", "问题来源");
			const origin = trail[trail.length - 2];
			if (origin) actionButton(path, "corner-up-left", "返回问题起点", () => this.selectNode(origin.id, true), true);
			const crumbs = element(path, "div", "reading-breadcrumb-path"); crumbs.title = trail.map((item) => item.title).join(" → ");
			if (trail.length > 3) element(crumbs, "span", "", "…");
			for (const ancestor of trail.slice(-3)) {
				if (ancestor.id === node.id) element(crumbs, "span", "reading-breadcrumb-current", "当前追问");
				else { const jump = button(crumbs, ancestor.title, () => this.selectNode(ancestor.id, true)); jump.dataset.originId = ancestor.id; icon(crumbs, "chevron-right"); }
			}
		}
		const messages = element(floating, "div", "reading-messages"); messages.dataset.scrollKey = state.key;
		messages.onscroll = () => { const top = messages.scrollTop; this.rememberScroll(state.key, (ui) => { const saved = ui.windows.find((w) => w.key === state.key); if (saved) saved.scrollTop = top; }); };
		const ids = node.branchId ? session.branches.find((branch) => branch.id === node.branchId)!.nodeIds : [node.id];
		ids.forEach((id) => this.renderAnswer(messages, readingNode(session, id)));
		this.renderComposer(floating, state.key, node.branchId || undefined, node.id);
		this.renderWindowResize(floating, state.key);
	}
	private renderWindowResize(floating: HTMLElement, key: string): void {
		const apply = (initial: DOMRect, edge: string, dx: number, dy: number): (() => void) => {
			const outer = this.contentEl.getBoundingClientRect();
			let left = initial.left - outer.left; let top = initial.top - outer.top;
			let right = left + initial.width; let bottom = top + initial.height;
			if (edge.includes("w")) left = Math.max(8, Math.min(right - 280, left + dx));
			if (edge.includes("e")) right = Math.min(outer.width - 12, Math.max(left + 280, right + dx));
			if (edge.includes("n")) top = Math.max(40, Math.min(bottom - 220, top + dy));
			if (edge.includes("s")) bottom = Math.min(outer.height - 12, Math.max(top + 220, bottom + dy));
			floating.style.left = left + "px"; floating.style.top = top + "px";
			floating.style.width = (right - left) + "px"; floating.style.height = (bottom - top) + "px";
			return () => this.updateUI((ui) => { const saved = ui.windows.find((w) => w.key === key); if (saved) { saved.x = left; saved.y = top; saved.width = right - left; saved.height = bottom - top; } });
		};
		for (const edge of ["se", "e", "s", "w", "n", "ne", "nw", "sw"]) {
			const handle = element(floating, "div", "reading-resize-handle reading-resize-" + edge + (edge === "se" ? " reading-resize" : "")); handle.dataset.resizeEdge = edge;
			handle.title = "拖动边缘调整窗口大小";
			if (edge === "se") { icon(handle, "move-diagonal-2"); handle.tabIndex = 0; handle.setAttribute("aria-label", "调整窗口大小；方向键调整，Shift 加方向键微调");
				handle.onkeydown = (event) => { if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
					event.preventDefault(); const step = event.shiftKey ? 4 : 24;
					apply(floating.getBoundingClientRect(), "se", event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)();
				};
			} else handle.setAttribute("aria-hidden", "true");
			let initial: DOMRect; let startX = 0; let startY = 0;
			this.drag(handle, (event, first) => { if (first) { initial = floating.getBoundingClientRect(); startX = event.clientX; startY = event.clientY; }
				return apply(initial, edge, event.clientX - startX, event.clientY - startY);
			});
		}
	}
	private renderAnswer(parent: HTMLElement, node: ReadingNode): void {
		const article = element(parent, "article", "reading-answer"); article.dataset.answerId = node.id;
		if (node.question) element(article, "div", "reading-question", node.question);
		const kicker = element(article, "div", "reading-answer-kicker"); icon(kicker, node.branchId ? "sparkles" : "book-open");
		element(kicker, "span", "", node.branchId ? "一起理解" : "主线 " + String(this.session!.mainIds.indexOf(node.id) + 1).padStart(2, "0"));
		if (node.evidence.length) element(kicker, "span", "reading-answer-source-count", node.evidence.length + " 处依据");
		element(article, "h3", "", node.title);
		if (node.quote) element(article, "blockquote", "reading-quote", node.quote.text);
		const content = element(article, "div", "reading-answer-content");
		const placeholder = node.status === "failed" || node.status === "interrupted" ? "本单元尚未完成，可在下方重试。" : "正在准备讲解…";
		try { void MarkdownRenderer.render(this.app, safeReadingMarkdown(node.content || this.plugin.getReadingEngine().streamed(this.sessionId, node.id) || placeholder), content, "", this.renderer).then(() => {
			const first = content.firstElementChild;
			if (first && /^H[1-6]$/.test(first.tagName) && first.textContent?.trim() === node.title.trim()) first.remove();
			this.renderCitations(content, node);
		}).catch(() => { content.textContent = node.content; }); }
		catch { content.textContent = node.content; }
		const tools = element(article, "div", "reading-answer-tools");
		if (node.status === "done") {
			actionButton(tools, "message-square-warning", "核对／重新解释", () => this.openCorrection(node), true);
			if (node.correction) actionButton(tools, "git-compare", "比较核对版本", () => this.compareCorrection(node));
			if (node.acceptedCorrectionId) actionButton(tools, "git-pull-request-arrow", "查看已选核对版本", () => this.selectNode(node.acceptedCorrectionId!, true));
			const learning = element(tools, "select", "reading-learning-filter"); learning.setAttribute("aria-label", "我的理解状态：" + node.title);
			for (const [value, label] of Object.entries(LEARNING_LABELS)) element(learning, "option", "", label).value = value;
			learning.value = node.learningState || "unmarked";
			learning.onchange = () => this.handle(this.service.repository.transact(this.sessionId, s => markReading(s, node.id, learning.value as ReadingLearningState)));
		}
		const selectionAction = actionButton(tools, "text-cursor-input", "选中文字后追问", () => this.captureQuote(node, content));
		selectionAction.disabled = node.status !== "done";
		content.onmouseup = () => this.showSelectionActions(node, content);
		content.onkeyup = (event) => { if (event.shiftKey && event.key.startsWith("Arrow")) this.showSelectionActions(node, content); };
		if (node.evidence.length) {
			const sources = element(article, "details", "reading-sources"); const summary = element(sources, "summary"); icon(summary, "quote"); element(summary, "span", "", "查看原文依据"); element(summary, "span", "reading-source-count", String(node.evidence.length)); icon(summary, "chevron-down");
			for (const [index, evidence] of node.evidence.entries()) {
				const source = button(sources, "", () => this.showEvidence(node.id, evidence.id), evidence.label); source.className = "reading-source-row";
				element(source, "span", "reading-source-index", String(index + 1)); const label = element(source, "span", "reading-source-title"); element(label, "span", "", evidence.label);
				element(label, "small", "", (evidence.kind === "paper" ? "本文原文" : "知识库补充") + (evidence.role ? " · " + evidence.role : "") + (evidence.page ? " · 第 " + evidence.page + " 页" : "") + (evidence.visualInspected ? " · 图像已提供给模型" : "") + (node.reviewedEvidence?.includes(evidence.id) ? " · 我已核对" : "")); icon(source, "arrow-up-right");
			}
		}
		if (node.retrieval) {
			const details = element(article, "details", "reading-sources"); element(details, "summary", "", "知识库检索路径");
			element(details, "p", "", "检索词：" + node.retrieval.query);
			if (node.retrieval.label) element(details, "p", "", node.retrieval.label);
			for (const warning of node.retrieval.warnings || []) element(details, "p", "reading-error", warning);
			element(details, "p", "", node.retrieval.paths.join("\n") || "Vault 中未找到足够依据");
			if (node.retrieval.error) element(details, "p", "reading-error", node.retrieval.error);
		}
		if (node.web) {
			const details = element(article, "details", "reading-sources"); element(details, "summary", "", "网络补充 · " + (node.web.mode === "native" ? "原生联网" : "Tavily"));
			element(details, "p", "", node.web.warning);
			if (node.web.mode === "tavily") element(details, "p", "", "实际检索词：" + node.web.query);
			for (const [index, source] of node.web.sources.entries()) {
				const row = element(details, "p"); const link = element(row, "a", "", `[网络 W${index + 1}] ${source.title || source.url}`); link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
				if (source.content) element(details, "p", "reading-evidence-text", source.content);
			}
		}
		if (node.error) element(article, "p", "reading-error", node.error);
		const outcome = element(article, "details", "reading-sources reading-outcomes"); outcome.dataset.outcomeNode = node.id;
		if (node.usage?.length) {
			const usage = element(article, "details", "reading-sources reading-usage"); element(usage, "summary", "", "模型用量 · " + node.usage.filter(e => e.state !== "cached").length + " 次调用");
			for (const entry of node.usage) element(usage, "p", "reading-usage-entry", USAGE_STAGES[entry.stage] + " · " + ({ running: "进行中", done: "已返回", failed: "失败", interrupted: "中断", cached: "复用缓存，无模型调用" })[entry.state] + "\n" + entry.model + "\n输入 " + (entry.input ?? "未报告，文字估算约 " + entry.estimatedInput) + " / 输出 " + (entry.output ?? (entry.estimatedOutput === undefined ? "未知" : "未报告，估算约 " + entry.estimatedOutput)) + " token" + (entry.cachedInput === undefined ? "" : " · 其中缓存输入 " + entry.cachedInput));
		} else if (node.status === "done" && !this.session!.demo) element(article, "small", "reading-usage-unrecorded", "此回答未记录模型用量");
		if (node.status === "failed" || node.status === "interrupted") element(article, "small", "reading-usage-unrecorded", "重试会核对原文，匹配的证据选择可复用；讲解将重新请求，已完成的记忆摘要保留。");
		if (node.status === "failed" || node.status === "interrupted") actionButton(tools, "rotate-cw", "重试", () => this.handle(this.service.generate(this.sessionId, node.id)));
		if (node.status === "running" || node.status === "pending") actionButton(tools, "square", "停止", () => this.service.stop(this.sessionId, node.id));
	}
	private scheduleOutcomes(): void {
		clearTimeout(this.outcomeTimer); const token = ++this.outcomeSequence;
		this.outcomeTimer = setTimeout(() => {
			const session = this.session; if (!session || session.demo) { this.outcomes.clear(); this.renderOutcomes(); return; }
			void readReadingOutcomes(this.app, structuredClone(session), this.plugin.getCurationService()).then(result => {
				if (token !== this.outcomeSequence || session.id !== this.sessionId) return; this.outcomes = result; this.renderOutcomes();
			}).catch(() => { if (token === this.outcomeSequence) this.contentEl.querySelectorAll<HTMLElement>(".reading-outcomes").forEach(el => { el.hidden = false; el.replaceChildren(); element(el, "summary", "", "关联记录读取失败"); button(el, "重新读取记录", () => this.scheduleOutcomes()); }); });
		}, 150);
	}
	private renderOutcomes(): void {
		this.contentEl.querySelectorAll<HTMLElement>("[data-outcome-node]").forEach(el => {
			const rows = this.outcomes.get(el.dataset.outcomeNode!) || []; el.replaceChildren(); el.hidden = !rows.length;
			if (!rows.length) return;
			element(el, "summary", "", [...new Set(rows.map(row => row.label))].join(" · ") + "（" + rows.length + "）");
			for (const row of rows) button(el, row.label + " · " + row.path, () => {
				if (row.reviewId) { const review = this.plugin.getCurationService().reviews.get(row.reviewId); if (review) this.plugin.openKnowledgeCuration(this.sessionId, el.dataset.outcomeNode!, review); }
				else this.plugin.openVaultFile(row.path);
			}).classList.add("reading-outcome-link");
		});
	}
	private renderCitations(content: HTMLElement, node: ReadingNode): void {
		const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); const texts: Text[] = []; let current: Node | null;
		while ((current = walker.nextNode())) if (!current.parentElement?.closest("a, button, pre, .math, .math-inline, .math-block")) texts.push(current as Text);
		for (const text of texts) {
			const matches = readingCitations(text.data, node.evidence.map((e) => e.id), node.content); if (!matches.length) continue;
			const fragment = document.createDocumentFragment(); let offset = 0;
			for (const match of matches) {
				fragment.append(text.data.slice(offset, match.start)); const group = document.createElement("span"); group.className = "reading-citation"; group.dataset.readingCitation = match.raw;
				for (const id of match.ids) { const index = node.evidence.findIndex((e) => e.id === id); button(group, String(index + 1), () => this.showEvidence(node.id, id), "依据 " + (index + 1) + " · " + node.evidence[index].label); }
				fragment.append(group); offset = match.end;
			}
			fragment.append(text.data.slice(offset)); text.parentElement?.closest("code")?.classList.add("reading-citation-code"); text.replaceWith(fragment);
		}
	}
	private hideSelectionActions(): void { this.selectionBar?.remove(); this.selectionBar = undefined; }
	private showSelectionActions(node: ReadingNode, content: HTMLElement): void {
		this.hideSelectionActions(); const selected = window.getSelection();
		if (node.status !== "done" || !selected?.rangeCount || !selected.toString().trim() || !content.contains(selected.anchorNode) || !content.contains(selected.focusNode)) return;
		const range = selected.getRangeAt(0).cloneRange();
		const rect = range.getBoundingClientRect(); const outer = this.contentEl.getBoundingClientRect();
		const bar = element(this.contentEl, "div", "reading-selection-actions"); this.selectionBar = bar; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "选中文字操作");
		bar.style.left = Math.max(8, Math.min(outer.width - 280, rect.left - outer.left)) + "px";
		bar.style.top = Math.max(8, Math.min(outer.height - 42, rect.bottom - outer.top + 6)) + "px";
		bar.onpointerdown = (event) => event.preventDefault();
		actionButton(bar, "message-square-plus", "追问选中文字", () => { this.hideSelectionActions(); this.captureQuote(node, content, range); });
		actionButton(bar, "message-square-warning", "核对选中文字", () => { this.hideSelectionActions(); this.captureQuote(node, content, range, true); });
		actionButton(bar, "copy", "复制选中文字", () => this.handle(navigator.clipboard.writeText(readingSelectionText(range)).then(() => { this.hideSelectionActions(); new Notice("已复制选中文字"); })));
	}
	private captureQuote(node: ReadingNode, content: HTMLElement, selectedRange?: Range, correction = false): void {
		const selected = window.getSelection(); const range = selectedRange || (selected?.rangeCount ? selected.getRangeAt(0) : undefined);
		if (!range?.toString().trim() || !content.contains(range.startContainer) || !content.contains(range.endContainer)) { new Notice("先在这条回答中选中文字"); return; }
		try {
			const before = range.cloneRange(); before.selectNodeContents(content); before.setEnd(range.startContainer, range.startOffset);
			const after = range.cloneRange(); after.selectNodeContents(content); after.setStart(range.endContainer, range.endOffset);
			this.quote = resolveReadingQuote(node.id, node.content, readingSelectionText(range).trim(), readingSelectionText(before), readingSelectionText(after));
		} catch (error) { new Notice(String(error)); return; }
		const sessionId = this.sessionId; const quote = this.quote;
		if (correction) { this.quote = undefined; this.openCorrection(node, quote); return; }
		this.handle(this.service.repository.transact(sessionId, (session) => { session.ui.selectedId = node.id; session.ui.pendingQuote = quote; this.ensureWindow(session, node.id); }).then(() => {
			if (sessionId !== this.sessionId) return;
			this.render(true); const key = node.branchId || node.id;
			[...this.contentEl.querySelectorAll<HTMLElement>(".reading-float")].find((w) => w.dataset.windowKey === key)?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
		}));
	}
	private renderComposer(parent: HTMLElement, key: string, branchId?: string, nodeId?: string): void {
		const session = this.session!; const sessionId = session.id;
		const target = nodeId || session.ui.mainFocusId || session.mainIds[session.mainIds.length - 1];
		key = key === "main" ? "main:" + (target || "") : key;
		const compact = parent.classList.contains("reading-float");
		const box = element(parent, "div", "reading-composer"); const localKey = sessionId + "|" + key;
		const quoted = this.quote && this.quote.nodeId === target ? this.quote : undefined;
		const targetLabel = quoted ? "新建子支线 · 引用：" + quoted.text.slice(0, 80) : branchId ? "继续当前支线 · 从最后一轮续问" : "新建支线 · " + (target ? "主线 " + String(session.mainIds.indexOf(target) + 1).padStart(2, "0") + "：" + readingNode(session, target).title : "请先开始主线");
		const context = element(box, "div", "reading-composer-context"); icon(context, quoted ? "quote" : "corner-down-right"); element(context, "small", "", targetLabel).title = targetLabel;
		const webLabel = element(context, "label", "reading-web-option"); const web = element(webLabel, "input"); web.type = "checkbox";
		web.checked = session.backend !== "codex-cli" && session.ui.webDrafts?.[key] === true; web.disabled = session.backend === "codex-cli" || session.demo === true;
		element(webLabel, "span", "", "联网补充"); webLabel.title = web.disabled ? "联网支线需选择 Direct API 阅读模型" : "仅本次追问使用供应商联网配置；先读取本文，再补充网页";
		web.onchange = () => this.updateUI(ui => { (ui.webDrafts ||= {})[key] = web.checked; });
		if (quoted) actionButton(context, "x", "取消引用", () => { this.quote = undefined; this.updateUI((ui) => { ui.pendingQuote = undefined; }); this.render(true); }, true);
		if (!compact && session.ui.mode === "map" && session.ui.windows.some((w) => !w.minimized)) actionButton(context, "chevron-down", "收起主输入框", () => this.updateUI((ui) => { ui.mainComposerExpanded = false; }), true);
		const input = element(box, "textarea"); input.rows = compact ? 1 : 2; input.placeholder = branchId ? "继续聊聊这个问题…" : "哪里还不理解？从这里展开追问…"; input.dataset.composer = key; input.setAttribute("aria-label", targetLabel);
		input.title = "Enter 发送 · Shift + Enter 换行";
		input.value = this.localDrafts.get(localKey) ?? session.ui.drafts[key] ?? "";
		const fitInput = (): void => { if (compact) { input.style.height = "0px"; input.style.height = Math.max(28, Math.min(96, parent.clientHeight * 0.2, input.scrollHeight)) + "px"; } };
		input.oninput = () => { fitInput(); const value = input.value; sendButton.disabled = !target || !value.trim(); this.localDrafts.set(localKey, value); clearTimeout(this.draftTimers.get(localKey));
			this.draftTimers.set(localKey, setTimeout(() => { this.handle(this.service.repository.transact(sessionId, (draft) => { draft.ui.drafts[key] = value; })); }, 400)); };
		let sending = false;
		const send = async (): Promise<void> => {
			if (sending || !target || !input.value.trim()) return; const question = input.value; sending = true;
			try {
				const id = await this.service.ask(sessionId, quoted?.nodeId || target, question, quoted ? undefined : branchId, quoted, web.checked);
				this.quote = undefined; this.localDrafts.set(localKey, ""); clearTimeout(this.draftTimers.get(localKey));
				await this.service.repository.transact(sessionId, (draft) => { draft.ui.pendingQuote = undefined; draft.ui.drafts[key] = ""; if (draft.ui.webDrafts) draft.ui.webDrafts[key] = false; this.ensureWindow(draft, id); });
			} finally { sending = false; }
		};
		const footer = element(box, "div", "reading-composer-footer"); element(footer, "small", "", "Enter 发送 · Shift + Enter 换行");
		const sendButton = actionButton(footer, "arrow-up", "发送", () => this.handle(send()), true); sendButton.classList.add("reading-send"); sendButton.disabled = !target || !input.value.trim();
		input.onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.handle(send()); } };
		fitInput();
	}
	private drag(handle: HTMLElement, move: (event: PointerEvent, first: boolean) => () => void, shouldStart: (event: PointerEvent) => boolean = () => true): void {
		handle.onpointerdown = (event) => {
			if (event.button !== 0 || (event.target as HTMLElement).closest("button") || !shouldStart(event)) return;
			event.preventDefault(); this.modeMotion.stop(); this.cleanupDrag?.(); let commit = move(event, true);
			const onMove = (next: PointerEvent): void => { commit = move(next, false); };
			const cleanup = (): void => { handle.classList.remove("is-panning"); document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", stop); document.removeEventListener("pointercancel", stop); };
			const stop = (): void => { cleanup(); this.cleanupDrag = undefined; commit(); };
			document.addEventListener("pointermove", onMove); document.addEventListener("pointerup", stop, { once: true }); document.addEventListener("pointercancel", stop, { once: true });
			this.cleanupDrag = cleanup;
		};
	}
	private modal(title: string): Modal {
		const modal = new Modal(this.app); modal.titleEl.setText(title); modal.modalEl.classList.add("reading-modal"); this.modals.add(modal);
		const close = modal.onClose.bind(modal); modal.onClose = () => { close(); this.modals.delete(modal); }; return modal;
	}
	private openNodeSearch(): void {
		const sessionId = this.sessionId; const modal = this.modal("搜索导图节点"); modal.modalEl.classList.add("reading-node-search-modal");
		const search = element(modal.contentEl, "input", "reading-library-search"); search.type = "search"; search.placeholder = "搜索标题、问题或回答，包含已折叠节点"; search.setAttribute("aria-label", "搜索导图内容");
		const count = element(modal.contentEl, "p", "reading-search-count"); count.setAttribute("role", "status");
		const list = element(modal.contentEl, "div", "reading-search-results");
		const render = (): void => {
			list.replaceChildren(); const session = this.service.repository.get(sessionId); const results = searchReadingNodes(session, search.value);
			count.textContent = results.length > 100 ? "找到 " + results.length + " 个节点，显示前 100 个；可增加关键词缩小范围" : results.length ? results.length + " 个节点 · 点击跳转并展开所在支线" : "没有匹配的节点，试试更短的关键词";
			for (const node of results.slice(0, 100)) {
				const result = button(list, "", () => { modal.close(); if (this.sessionId === sessionId) this.selectNode(node.id, true); }, node.title); result.className = "reading-search-result"; result.dataset.resultId = node.id;
				element(result, "small", "", node.branchId ? "追问 · " + readingTrail(session, node.id)[0].title : "主线 " + String(session.mainIds.indexOf(node.id) + 1).padStart(2, "0"));
				element(result, "strong", "", node.title || "正在准备讲解");
				element(result, "span", "", (node.question || node.content).replace(/\s+/g, " ").slice(0, 140));
			}
		};
		search.oninput = render; search.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); list.querySelector<HTMLButtonElement>("button")?.click(); } else if (event.key === "ArrowDown") { event.preventDefault(); list.querySelector<HTMLButtonElement>("button")?.focus(); } };
		const unsubscribe = this.service.repository.subscribe((id) => { if (id === sessionId) render(); }); const close = modal.onClose.bind(modal); modal.onClose = () => { unsubscribe(); close(); };
		render(); modal.open(); search.focus();
	}
	private openSessionLibrary(): void {
		const modal = this.modal("阅读会话"); modal.modalEl.classList.add("reading-library-modal");
		const search = element(modal.contentEl, "input", "reading-library-search"); search.type = "search"; search.placeholder = "搜索论文标题或来源路径"; search.setAttribute("aria-label", "搜索阅读会话");
		const tabs = element(modal.contentEl, "div", "reading-library-tabs"); const list = element(modal.contentEl, "div", "reading-library-list");
		let scope: ReadingCategory | "archived" = "reading";
		const render = (): void => {
			tabs.replaceChildren(); list.replaceChildren();
			for (const [value, label] of [["reading", "正在阅读"], ["archived", "已归档"], ["demo", "演示"], ["test", "开发测试"]] as const) {
				const tab = button(tabs, label, () => { scope = value; render(); }); tab.setAttribute("aria-pressed", String(scope === value));
			}
			const query = search.value.trim().toLocaleLowerCase();
			const sessions = recentReading(this.service.repository.sessions.values(), scope === "archived" ? "reading" : scope, scope === "archived")
				.filter((s) => (readingTitle(s) + " " + s.source.path).toLocaleLowerCase().includes(query));
			const groups = new Map<string, ReadingSession[]>();
			for (const session of sessions) { const key = readingSourceKey(session.source); const group = groups.get(key) || []; group.push(session); groups.set(key, group); }
			if (!sessions.length) element(list, "p", "reading-library-empty", query ? "没有找到匹配的会话" : "这里还没有会话");
			for (const group of groups.values()) {
				const section = element(list, "section", "reading-library-group");
				if (group.length > 1) element(section, "p", "reading-library-group-label", (group[0].source.kind === "pdf" ? "PDF" : "MinerU") + " · 同一来源的 " + group.length + " 个会话");
				for (const session of group) {
					const row = element(section, "div", "reading-library-row" + (session.id === this.sessionId ? " is-current" : "")); row.dataset.sessionId = session.id;
					const open = button(row, "", () => { modal.close(); this.selectSession(session.id); }, "打开会话：" + readingTitle(session)); open.className = "reading-library-open";
					element(open, "strong", "", (session.pinned ? "置顶 · " : "") + readingTitle(session));
					const completed = session.mainIds.filter((id) => readingNode(session, id).status === "done").length;
					const timestamp = session.lastOpenedAt || session.updatedAt; const date = Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toLocaleString() : "时间未记录";
					element(open, "small", "", (session.source.kind === "pdf" ? "PDF" : "MinerU") + " · " + completed + " 个主线单元 · " + date);
					element(open, "small", "reading-library-path", session.source.path).title = session.source.path;
					const actions = element(row, "div", "reading-library-actions");
					actionButton(actions, session.pinned ? "pin-off" : "pin", session.pinned ? "取消置顶" : "置顶", () => this.handle(this.service.repository.transact(session.id, (s) => { s.pinned = !s.pinned; })), true);
					actionButton(actions, "pencil", "重命名", () => {
						const rename = this.modal("重命名阅读会话"); const input = element(element(rename.contentEl, "label", "reading-field", "会话名称"), "input"); input.value = readingTitle(session); input.maxLength = 200;
						const submit = button(rename.contentEl, "保存名称", () => { const title = input.value.trim(); if (!title) { new Notice("请输入会话名称"); return; } this.handle(this.service.repository.transact(session.id, (s) => { s.title = title; }).then(() => rename.close())); });
						submit.classList.add("mod-cta"); rename.open(); input.focus(); input.select();
					}, true);
					if (readingCategory(session) === "reading") actionButton(actions, session.archived ? "archive-restore" : "archive", session.archived ? "恢复会话" : "归档", () => this.handle(this.service.repository.transact(session.id, (s) => { s.archived = !s.archived; }).then(() => {
						if (session.id === this.sessionId && this.service.repository.get(session.id).archived) this.selectSession(recentReading(this.service.repository.sessions.values())[0]?.id || "");
					})), true);
				}
			}
		};
		search.oninput = render; const unsubscribe = this.service.repository.subscribe(render); const close = modal.onClose.bind(modal); modal.onClose = () => { unsubscribe(); close(); };
		render(); modal.open(); search.focus();
	}
	openSource(entry?: import("../reading/entry").ReadingEntry): void {
		const modal = this.modal("开始交互阅读");
		element(modal.contentEl, "p", "reading-modal-intro", "选择一篇论文，建立可以随时继续的阅读会话。");
		const kind = element(element(modal.contentEl, "label", "reading-field", "原文类型"), "select"); [["pdf", "原始 PDF"], ["article", "已验证 article.md"]].forEach(([value, label]) => { element(kind, "option", "", label).value = value; });
		const path = element(element(modal.contentEl, "label", "reading-field", "原文位置"), "input"); path.placeholder = "PDF 完整路径，或 papers/<citekey>/article.md";
		const backend = element(element(modal.contentEl, "label", "reading-field", "讲解后端"), "select"); element(backend, "option", "", "Codex CLI").value = "codex-cli";
		this.plugin.getVerifiedProviderProfiles().forEach((profile) => { element(backend, "option", "", profile.name + " · " + profile.model).value = profile.id; });
		const model = element(element(modal.contentEl, "label", "reading-field", "Codex 模型（可选）"), "input"); model.placeholder = "留空使用配置中的模型";
		backend.onchange = () => { model.parentElement!.hidden = backend.value !== "codex-cli"; };
		if (entry?.source) { kind.value = entry.source.kind; path.value = entry.source.path; }
		if (entry?.backend && [...backend.options].some(o => o.value === entry.backend)) backend.value = entry.backend;
		model.parentElement!.hidden = backend.value !== "codex-cli";
		const startNew = element(modal.contentEl, "label", "reading-new-session-option"); const forceNew = element(startNew, "input"); forceNew.type = "checkbox"; element(startNew, "span", "", "为同一原文重新建立会话");
		element(modal.contentEl, "p", "reading-modal-intro", "默认继续相同原文的已有会话，并沿用该会话的模型。原文变化时会创建新会话。");
		element(modal.contentEl, "p", "reading-modal-intro", "所选内容和相关图像将交给所选模型分析。阅读过程自动保存。");
		const submit = button(modal.contentEl, "打开并继续阅读", () => {
			submit.disabled = true;
			this.handle(this.service.open(kind.value as "pdf" | "article", path.value.trim().replace(/^"|"$/g, ""), backend.value, model.value.trim(), forceNew.checked)
				.then(({ id, created }) => { modal.close(); this.selectSession(id); if (created) return this.service.advance(id); }).finally(() => { submit.disabled = false; }));
		}); submit.classList.add("mod-cta"); modal.open();
	}
	private showEvidence(nodeId: string, evidenceId: string): void {
		const sessionId = this.sessionId;
		const pin = () => this.handle(this.service.repository.transact(sessionId, s => visitReadingEvidence(s, nodeId, evidenceId)));
		if (this.session?.ui.evidenceView) { pin(); return; }
		const item = readingNode(this.session!, nodeId).evidence.find((evidence) => evidence.id === evidenceId); if (!item) return;
		const modal = this.modal(item.label); element(modal.contentEl, "p", "reading-evidence-location", item.path + (item.page ? " · 第 " + item.page + " 页" : ""));
		button(modal.contentEl, "固定原文对照", () => { modal.close(); pin(); });
		if (item.heading || item.role) element(modal.contentEl, "p", "reading-evidence-location", [item.role, item.heading].filter(Boolean).join(" · "));
		if (item.origins?.length) element(modal.contentEl, "p", "reading-evidence-location", "原始来源：" + item.origins.join("、"));
		if (item.start !== undefined) element(modal.contentEl, "p", "", "阅读文本字符位置：" + item.start + "–" + item.end + (item.page ? "" : "；页码未唯一匹配，以本段原文为准"));
		element(modal.contentEl, "pre", "reading-evidence-text", item.text);
		if (item.kind === "vault") button(modal.contentEl, "打开来源笔记", () => { this.plugin.openVaultFile(item.path); modal.close(); });
		if (item.kind === "paper" && this.session!.source.kind === "article") button(modal.contentEl, "在阅读器打开原文", () => this.handle(this.service.document(this.sessionId).then(async (source) => { await source.verify(); await this.plugin.openReadingEvidence(item.path, item.page); modal.close(); })));
		if (item.kind === "paper") this.handle(this.service.document(this.sessionId).then(async (document) => {
			await document.verify(); const image = await document.image(document.source.kind === "pdf" && item.page ? { ...item, asset: "pdf-page" } : item); if (image) { const img = element(modal.contentEl, "img"); img.src = image.dataUrl; img.style.maxWidth = "100%"; }
		})); modal.open();
	}
	private openCorrection(node: ReadingNode, quote?: ReadingQuote): void {
		const sessionId = this.sessionId; const modal = this.modal("核对／重新解释");
		element(modal.contentEl, "p", "reading-modal-intro", "指出你认为有误或需要重新解释的部分。原回答保留，核对结果会成为独立支线；生成后可比较两个版本。");
		if (quote) element(modal.contentEl, "blockquote", "reading-quote", quote.text);
		const input = element(modal.contentEl, "textarea", "reading-correction-input"); input.placeholder = "例如：这里是否混淆了两个指标的分母？请结合原文核对。"; input.maxLength = 4000; input.rows = 3; input.setAttribute("aria-label", "核对要求");
		const start = button(modal.contentEl, "读取原文并核对", () => {
			if (start.disabled) return; start.disabled = true;
			this.handle(this.service.correct(sessionId, node.id, input.value, quote).then(id => { modal.close(); if (this.sessionId === sessionId) this.selectNode(id, true); }).finally(() => { start.disabled = false; }));
		}); start.classList.add("mod-cta"); modal.open(); input.focus();
	}
	private compareCorrection(node: ReadingNode): void {
		const sessionId = this.sessionId; const original = readingNode(this.session!, node.correction!.of); const modal = this.modal("核对版本对照");
		element(modal.contentEl, "p", "reading-modal-intro", "选择后，新主线和新支线使用此版本作为背景。旧回答与已创建支线的记忆保留；这不表示科学事实已经核验。");
		element(modal.contentEl, "h3", "", "原回答"); element(modal.contentEl, "pre", "reading-evidence-text", original.content);
		element(modal.contentEl, "h3", "", "核对版本"); element(modal.contentEl, "pre", "reading-evidence-text", node.content);
		const apply = button(modal.contentEl, original.acceptedCorrectionId === node.id ? "已用于后续背景" : "用于后续背景", () => {
			apply.disabled = true;
			this.handle(this.service.document(sessionId).then(async doc => { await doc.verify(); await this.service.repository.transact(sessionId, s => acceptReadingCorrection(s, node.id)); modal.close(); }).finally(() => { apply.disabled = false; }));
		}); apply.classList.add("mod-cta"); apply.disabled = original.acceptedCorrectionId === node.id; modal.open();
	}
	private openRelocate(): void {
		const session = this.session!; const modal = this.modal("重新定位原文");
		element(modal.contentEl, "p", "reading-modal-intro", "适用于文件移动或重命名。内容指纹完全一致才恢复关联；内容变化请新建会话。");
		const input = element(modal.contentEl, "input", "reading-correction-input"); input.value = session.source.path; input.setAttribute("aria-label", "原文新位置");
		const go = button(modal.contentEl, "核对文件并恢复", () => { if (go.disabled) return; go.disabled = true; this.handle(this.service.relocate(session.id, input.value.trim().replace(/^"|"$/g, "")).then(() => { modal.close(); new Notice("原文位置已恢复，历史保留"); }).finally(() => { go.disabled = false; })); }); modal.open();
	}
	private async openCoverage(): Promise<void> {
		const sessionId = this.sessionId; const doc = await this.service.document(sessionId); await doc.verify();
		const session = this.service.repository.get(sessionId); const rows = readingCoverage(session, doc.evidence); const modal = this.modal("证据覆盖");
		const texts = rows.filter(r => !r.evidence.asset), images = rows.filter(r => r.evidence.asset);
		element(modal.contentEl, "p", "reading-modal-intro", `已记录提供的文字片段 ${texts.filter(r => r.provided).length}/${texts.length}；图像 ${images.filter(r => r.provided).length}/${images.length}。旧回答仅有引用记录时，标为历史引用。`);
		element(modal.contentEl, "p", "reading-modal-intro", "这些是本地输入与个人核对记录，不代表全文科学核验；缺失的补充材料不计入分母。");
		for (const row of rows) {
			const e = row.evidence; const open = button(modal.contentEl, `${e.label} · ${e.asset ? "图像" : "文字"} · ${row.provided ? "已提供给模型" : row.legacy ? "历史引用" : "尚无提供记录"}${row.reviewed ? " · 我已核对" : ""}`, () => {
				const detail = this.modal(e.label); element(detail.contentEl, "pre", "reading-evidence-text", e.text);
				if (row.nodeId) button(detail.contentEl, "定位相关回答", () => { detail.close(); modal.close(); if (this.sessionId === sessionId) this.selectNode(row.nodeId, true); });
				if (e.asset) this.handle(doc.verify().then(() => doc.image(e)).then(image => { if (image) { const img = element(detail.contentEl, "img"); img.src = image.dataUrl; img.style.maxWidth = "100%"; } })); detail.open();
			}); open.classList.add("reading-coverage-row");
		} modal.open();
	}
	private openModel(): void {
		const session = this.session!; const modal = this.modal("阅读模型");
		const backend = element(element(modal.contentEl, "label", "reading-field", "讲解后端"), "select"); element(backend, "option", "", "Codex CLI").value = "codex-cli";
		this.plugin.getVerifiedProviderProfiles().forEach((profile) => { element(backend, "option", "", profile.name + " · " + profile.model).value = profile.id; }); backend.value = session.backend;
		const model = element(element(modal.contentEl, "label", "reading-field", "Codex 模型（可选）"), "input"); model.value = session.model; model.placeholder = "留空使用配置中的模型";
		const style = element(element(modal.contentEl, "label", "reading-field", "后续讲解重点"), "select");
		for (const [value, label] of Object.entries(TEACHING_STYLES)) element(style, "option", "", label).value = value;
		style.value = session.teachingStyle || "balanced";
		backend.onchange = () => { model.parentElement!.hidden = backend.value !== "codex-cli"; }; model.parentElement!.hidden = backend.value !== "codex-cli";
		button(modal.contentEl, "保存", () => this.handle(this.service.repository.transact(session.id, (draft) => { draft.backend = backend.value; draft.model = model.value.trim(); draft.teachingStyle = style.value as ReadingTeachingStyle; }).then(() => modal.close()))).classList.add("mod-cta"); modal.open();
	}
	private openExport(): void {
		const sessionId = this.sessionId; const nodeId = this.session!.ui.selectedId;
		const modal = new ReadingExportModal(this.app, () => this.service.repository.get(sessionId), nodeId, (query, options) => this.plugin.searchKnowledge(query, options), path => this.plugin.openVaultFile(path), () => this.plugin.openKnowledgeCuration(sessionId, nodeId));
		this.modals.add(modal); const close = modal.onClose.bind(modal); modal.onClose = () => { close(); this.modals.delete(modal); }; modal.open();
	}
	revealLearningNode(nodeId: string): void { if (this.session?.nodes.some(node => node.id === nodeId)) this.selectNode(nodeId, true); }
}
