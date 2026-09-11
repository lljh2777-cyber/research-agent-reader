import {
	ItemView,
	Notice,
	TFile,
	normalizePath,
	setIcon,
	type TAbstractFile,
	type WorkspaceLeaf,
} from "obsidian";

import {
	ACTIONS,
	ACTION_BY_ID,
	type DashboardAction,
	type DashboardActionOptions,
} from "../actions";
import { VIEW_TYPE } from "../config";
import {
	ActionInputModal,
	type ActionRunnerKind,
	type ExecutionOverrides,
} from "../modals/action-input";
import { TaskResultModal } from "../modals/task-result";
import type { PaperIngestFlowOptions } from "../agent/paper-ingest-flow";
import { parsePaperIngestInput } from "../agent/paper-ingest-flow";
import type { AgentLoopRunOutcome } from "../agent/agent-loop-service";
import { ingestTaskResult } from "../agent/ingest-task-result";
import { renderIngestProgress } from "./ingest-progress";
import { ingestProgressDisplay } from "../agent/ingest-progress";
import { serializeActionRequest } from "../runtime/action-request";
import {
	DashboardDataService,
	type DashboardVaultChange,
} from "../services/dashboard-data";
import type {
	DashboardProcessEvent,
	DashboardProcessResult,
	ExecutionConfig,
	PluginHost,
	TaskRun,
} from "../types/contracts";

type DashboardData = NonNullable<Awaited<ReturnType<DashboardDataService["load"]>>>;
type AgentRun = DashboardData["agentRuns"][number];
type KnowledgeGap = DashboardData["knowledgeGaps"][number];
type OkfReadiness = DashboardData["okf"];
type HeatmapDay = DashboardData["activity"]["days"][number];
type RunsFilter = "all" | "done" | "open";
type GapsFilter = "all" | "high" | "medium" | "low";

const ACTION_ICONS: Record<string, string> = {
	"fulltext-acquisition": "download",
	"paper-ingest": "file-down",
	"pdf-xray": "scan-search",
	"code-analysis": "code-xml",
	"code-practice": "square-terminal",
	"vault-retrieval": "search",
	synthesis: "network",
	"vault-lint": "shield-check",
	"okf-export": "package-open",
};

import { readingDashboardState, type ReadingEntry } from "../reading/entry";
import { recentReading, readingTitle } from "../reading/catalog";
import type { ReadingWorkspaceService } from "../reading/workspace";

import { dashboardActionGroup } from "../services/dashboard-navigation";

interface DashboardHost extends PluginHost {
	openKnowledgeMaintenance(): void;
	subscribeTaskRuns?(listener: (progressOnly?: boolean) => void): () => void;
	getRunningTaskRun(actionId: string): TaskRun | null;
	stopTaskRun(runId: string): boolean;
	stopDirectVaultQuery(runId: string): boolean;
	stopVaultAction(runId: string): boolean;
	activateQueryWikiView(initialInput?: string): Promise<void>;
	activateCodePracticeView(): Promise<void>;
	openFulltextAcquisition(mode?: "production" | "demo", jobId?: string): void;
	activateReadingWorkspace(entry?: ReadingEntry): Promise<void>;
	activatePaperLibrary(): Promise<void>;
	activateLearningSpace(entry?: import("../learning/entry").LearningEntry): Promise<void>;
	getReadingWorkspace?(): ReadingWorkspaceService;
	supportsFast(model: string): boolean;
	lightPaperIngestAvailable(): { ready: boolean; reason: string };
	lightAgentMineruReady(): boolean;
	getActiveDirectProviderSummary(): { name: string; model: string } | null;
	runLightPaperIngest(
		runId: string,
		options: PaperIngestFlowOptions,
		profileId: string,
		hooks?: { onEvent?: (event: DashboardProcessEvent) => void },
	): Promise<AgentLoopRunOutcome>;
	getLightAgentRunResult(runId: string): AgentLoopRunOutcome | null;
	runVaultAction(
		runId: string,
		action: DashboardAction,
		input: string,
		executionConfig?: ExecutionConfig | null,
	): Promise<DashboardProcessResult>;
}

export class DashboardView extends ItemView {
	private readonly plugin: DashboardHost;
	private readonly dataService: DashboardDataService;
	private data: DashboardData | null;
	private runsFilter: RunsFilter;
	private gapsFilter: GapsFilter;
	private readonly monthFormatter: Intl.DateTimeFormat;
	private reloadTimer: number | null;
	private readonly pendingVaultChanges: Map<string, DashboardVaultChange>;
	private loadSequence: number;
	private closed: boolean;
	private readonly stoppingRunIds: Set<string>;
	private runsExpanded = false;
	private maintenanceExpanded = false;
	private toolsExpanded = false;
	private recentSignature = "";
	private recentExpanded = false;
	private unsubscribeTaskRuns?: () => void;

	private get currentData(): DashboardData {
		if (!this.data) throw new Error("Dashboard data is not loaded");
		return this.data;
	}

	constructor(leaf: WorkspaceLeaf, plugin: DashboardHost) {
		super(leaf);
		this.plugin = plugin;
		this.dataService = new DashboardDataService(plugin.app, plugin);
		this.data = null;
		this.runsFilter = "all";
		this.gapsFilter = "all";
		this.monthFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short" });
		this.reloadTimer = null;
		this.pendingVaultChanges = new Map();
		this.loadSequence = 0;
		this.closed = false;
		this.stoppingRunIds = new Set();
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "智能体控制台";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		this.closed = false;
		this.renderLoading();
		this.registerVaultRefreshEvents();
		this.unsubscribeTaskRuns?.();
		this.unsubscribeTaskRuns = this.plugin.subscribeTaskRuns?.((progressOnly) => {
			if (!this.closed) { if (progressOnly) this.refreshIngestProgress(); else void this.loadAndRender(); }
		});
		await this.loadAndRender();
		if (this.plugin.getReadingWorkspace) {
			try {
				const reading = this.plugin.getReadingWorkspace(); await reading.ready();
				if (!this.closed) { this.register(reading.repository.subscribe(() => this.refreshReadingEntry())); this.refreshReadingEntry(); }
			} catch { /* The reading view reports recovery details; dashboard remains usable. */ }
		}
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.unsubscribeTaskRuns?.();
		this.unsubscribeTaskRuns = undefined;
		this.loadSequence += 1;
		if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
		this.contentEl.empty();
	}

	registerVaultRefreshEvents(): void {
		this.registerEvent(this.app.vault.on("create", (file) => this.queueVaultChange("upsert", file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.queueVaultChange("upsert", file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.queueVaultChange("delete", file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			let queuedOldPath = false;
			if (this.isDashboardWikiPath(oldPath)) {
				this.pendingVaultChanges.set(normalizePath(oldPath), {
					type: "delete",
					path: oldPath,
				});
				queuedOldPath = true;
			}
			this.queueVaultChange("upsert", file);
			if (queuedOldPath && !this.isDashboardWikiPath(file?.path)) this.scheduleReload();
		}));
	}

	isDashboardWikiPath(value: unknown): boolean {
		const normalized = normalizePath(String(value || ""));
		return normalized.startsWith("wiki/") && normalized.toLowerCase().endsWith(".md");
	}

	queueVaultChange(type: "upsert" | "delete", file: TAbstractFile): void {
		const filePath = normalizePath(String(file?.path || ""));
		if (!this.isDashboardWikiPath(filePath)) return;
		this.pendingVaultChanges.set(filePath, {
			type,
			path: filePath,
			file: type === "upsert" && file instanceof TFile ? file : null,
		});
		this.scheduleReload();
	}

	scheduleReload(): void {
		if (this.reloadTimer) {
			window.clearTimeout(this.reloadTimer);
		}
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			const changes = [...this.pendingVaultChanges.values()];
			this.pendingVaultChanges.clear();
			void this.loadAndRender(changes);
		}, 1200);
	}

	async loadAndRender(changes: DashboardVaultChange[] = []): Promise<void> {
		const sequence = ++this.loadSequence;
		try {
			const data = await this.dataService.load(changes);
			if (!data || this.closed || sequence !== this.loadSequence) return;
			this.data = data;
			this.renderDashboard();
		} catch (error) {
			if (this.closed || sequence !== this.loadSequence) return;
			console.error("Research Agent Reader failed to load vault data", error);
			this.renderError(error);
		}
	}

	renderLoading(): void {
		this.contentEl.empty();
		this.contentEl.addClass("agent-dashboard-view");
		const shell = this.contentEl.createDiv({ cls: "agent-dashboard-shell" });
		const panel = shell.createDiv({ cls: "agent-dashboard-loading-panel" });
		panel.createEl("p", { cls: "agent-dashboard-eyebrow", text: "研究知识库" });
		panel.createEl("h1", { text: "正在扫描本地知识库..." });
		panel.createEl("p", { cls: "agent-dashboard-loading-copy", text: "正在读取 Markdown 文件、属性区、wikilink、日志记录和笔记活动。" });
	}

	renderError(error: unknown): void {
		this.contentEl.empty();
		this.contentEl.addClass("agent-dashboard-view");
		const shell = this.contentEl.createDiv({ cls: "agent-dashboard-shell" });
		const panel = shell.createDiv({ cls: "agent-dashboard-error-panel" });
		panel.createEl("p", { cls: "agent-dashboard-eyebrow", text: "控制台错误" });
		panel.createEl("h1", { text: "无法读取知识库数据" });
		panel.createEl("p", { cls: "agent-dashboard-loading-copy", text: error instanceof Error ? error.message : String(error) });
	}

	renderDashboard(): void {
		if (!this.data) {
			this.renderLoading();
			return;
		}
		for (const runId of this.stoppingRunIds) {
			const run = this.plugin.getTaskRun(runId);
			if (!run || !["running", "queued"].includes(run.status)) {
				this.stoppingRunIds.delete(runId);
			}
		}
		const scrollTop = this.contentEl.scrollTop;
		this.contentEl.empty();
		this.contentEl.addClass("agent-dashboard-view");
		const shell = this.contentEl.createDiv({ cls: "agent-dashboard-shell" });
		this.renderHeader(shell);
		this.renderActions(shell);
		shell.createDiv({ cls: "ingest-progress" });
		this.refreshIngestProgress();
		const main = shell.createEl("main", {
			cls: "agent-dashboard-grid",
			attr: { "aria-label": "研究知识库控制台" },
		});
		this.recentSignature = "";
		const recent = main.createDiv({ cls: "agent-dashboard-recent", attr: { "aria-label": "最近阅读" } });
		this.refreshRecentReading(recent);
		this.renderAgentRuns(main);
		this.renderStats(main);
		this.renderHeatmap(main);
		const maintenance = main.createEl("details", { cls: "agent-dashboard-maintenance" }); maintenance.open = this.maintenanceExpanded;
		maintenance.createEl("summary", { text: "知识库维护与详细统计" });
		maintenance.addEventListener("toggle", () => { this.maintenanceExpanded = maintenance.open; });
		const detail = maintenance.createDiv({ cls: "agent-dashboard-maintenance-grid" });
		this.renderKnowledgeGaps(detail);
		this.renderProcessingDepth(detail);
		this.renderCoverage(detail);
		this.renderOkfReadiness(detail);
		this.contentEl.scrollTop = scrollTop;
	}

	private refreshIngestProgress(): void {
		if (this.closed) return;
		const panel = this.contentEl.querySelector<HTMLElement>(".ingest-progress");
		if (!panel) return;
		const run = this.plugin.getRunningTaskRun("paper-ingest") || this.plugin.getTaskRuns().find(r => r.actionId === "paper-ingest" && r.ingestProgress) || null;
		renderIngestProgress(panel, run, { stop: () => { const current = this.plugin.getRunningTaskRun("paper-ingest"); if (current) this.requestStopRun(current); }, result: () => { if (run) this.openTaskResult(run); }, stopping: Boolean(run && this.stoppingRunIds.has(run.id)) });
		const state = this.contentEl.querySelector<HTMLElement>('[data-action-id="paper-ingest"] .agent-dashboard-action-state');
		if (state && run && ["running", "queued"].includes(run.status)) {
			const progress = ingestProgressDisplay(run);
			if (progress) state.textContent = this.stoppingRunIds.has(run.id) ? "停止中" : progress.waiting ? "等待你的确认" : progress.stage + " · 点击停止";
		}
	}

	renderHeader(parent: HTMLElement): void {
		const header = parent.createEl("header", { cls: "agent-dashboard-header" });
		setIcon(header.createSpan({ cls: "agent-dashboard-brand", attr: { "aria-hidden": "true" } }), "library-big");
		const titleBlock = header.createDiv({ cls: "agent-dashboard-title-block" });
		titleBlock.createEl("p", { cls: "agent-dashboard-eyebrow", text: this.currentData.header.scope });
		titleBlock.createEl("h1", { text: this.currentData.header.title });
		const status = header.createDiv({ cls: "agent-dashboard-header-status", attr: { "aria-label": "知识库状态" } });
		status.createSpan({
			cls: "agent-dashboard-status-pill agent-dashboard-local-pill",
			text: this.currentData.header.status,
		});
		status.createSpan({ cls: "agent-dashboard-vault-chip", text: this.currentData.header.vault });
		status.createSpan({ cls: "agent-dashboard-scan-time", text: this.currentData.header.lastScan });
		const refresh = status.createEl("button", {
			cls: "agent-dashboard-refresh-button",
			attr: { "aria-label": "刷新控制台状态", title: "刷新" },
		});
		refresh.type = "button";
		setIcon(refresh, "refresh-cw");
		this.registerDomEvent(refresh, "click", async () => {
			await this.runRefresh(refresh);
		});
	}

	renderActions(parent: HTMLElement): void {
		const rail = parent.createEl("nav", { cls: "agent-dashboard-action-rail", attr: { "aria-label": "研究知识库操作" } });
		const primary = rail.createDiv({ cls: "agent-dashboard-primary-actions" });
		const secondary = rail.createDiv({ cls: "agent-dashboard-secondary-actions", attr: { "aria-label": "常用操作" } });
		const tools = rail.createEl("details", { cls: "agent-dashboard-tools" });
		const runningTools = this.currentData.actions.some(action => dashboardActionGroup(action.id) === "tools" && this.plugin.isActionRunning(action.id));
		tools.open = this.toolsExpanded || runningTools;
		tools.createEl("summary", { text: "扩展工具：代码、维护与导出" + (runningTools ? " · 有任务运行" : "") });
		tools.addEventListener("toggle", () => { if (tools.isConnected) this.toolsExpanded = tools.open; });
		const toolActions = tools.createDiv({ cls: "agent-dashboard-secondary-actions", attr: { "aria-label": "扩展工具" } });
		const library = primary.createEl("button", { cls: "agent-dashboard-action-button is-primary", attr: { type: "button", "aria-label": "文献库" } });
		library.dataset.actionId = "paper-library";
		setIcon(library.createSpan({ cls: "agent-dashboard-action-icon" }), "library-big");
		library.createSpan({ cls: "agent-dashboard-action-label", text: "文献库" });
		library.createSpan({ cls: "agent-dashboard-action-state", text: "原文版本、阅读会话与笔记" });
		library.onclick = () => { void this.plugin.activatePaperLibrary().catch(error => new Notice(String(error))); };
		for (const [id, label, description, icon, run] of [
			["learning-space", "阅读空间", "从资料开始，继续对话与导图阅读", "book-open", () => this.plugin.activateLearningSpace({ kind: "document" })],
			["knowledge-curation", "知识整理", "审阅整理建议，回看修订与索引", "notebook-pen", () => this.plugin.openKnowledgeMaintenance()],
		] as const) {
			const button = primary.createEl("button", { cls: "agent-dashboard-action-button is-primary", attr: { type: "button", "aria-label": label } });
			button.dataset.actionId = id; setIcon(button.createSpan({ cls: "agent-dashboard-action-icon" }), icon);
			button.createSpan({ cls: "agent-dashboard-action-label", text: label }); button.createSpan({ cls: "agent-dashboard-action-state", text: description });
			button.onclick = () => { button.disabled = true; void Promise.resolve().then(run).catch(error => new Notice(String(error))).finally(() => { if (button.isConnected) button.disabled = false; }); };
		}
		const topic = secondary.createEl("button", { cls: "agent-dashboard-action-button is-secondary", attr: { type: "button", "aria-label": "主题路线（预览）" } });
		topic.dataset.actionId = "topic-planning";
		setIcon(topic.createSpan({ cls: "agent-dashboard-action-icon" }), "route");
		topic.createSpan({ cls: "agent-dashboard-action-label", text: "主题路线（预览）" });
		topic.onclick = () => { void this.plugin.activateLearningSpace({ kind: "topic" }).catch(error => new Notice(String(error))); };
		const mainIds = ["paper-ingest", "pdf-xray", "vault-retrieval"];
		const descriptions: Record<string, string> = { "paper-ingest": "导入论文，整理原文与初始笔记", "pdf-xray": "沿主线阅读，带着问题探索", "vault-retrieval": "从已有文献中查找依据与答案" };
		const actions = this.currentData.actions.filter(action => action.showInRail !== false);
		const ordered = [...mainIds.flatMap(id => actions.filter(a => a.id === id)), ...actions.filter(a => !mainIds.includes(a.id))];
		ordered.forEach((action) => {
			const isRunning = this.plugin.isActionRunning(action.id);
			const runningTask = isRunning ? this.plugin.getRunningTaskRun(action.id) : null;
			const isStopping = Boolean(runningTask && this.stoppingRunIds.has(runningTask.id));
			const button = (dashboardActionGroup(action.id) === "tools" ? toolActions : secondary).createEl("button", {
				cls: "agent-dashboard-action-button is-secondary",
				attr: {
					"aria-label": !action.enabled
						? `${action.label}，待接入`
						: isRunning
							? `${isStopping ? "正在停止" : "停止"}${action.label}`
							: action.label,
					title: isRunning ? `${isStopping ? "正在停止" : "点击停止"}：${action.label}` : action.description,
				},
			});
			button.type = "button";
			button.dataset.actionId = action.id;
			button.disabled = !action.enabled || isStopping || (isRunning && !runningTask);
			if (!action.enabled) button.addClass("is-unavailable");
			if (isRunning) button.addClass("is-running");
			const icon = button.createSpan({ cls: "agent-dashboard-action-icon" });
			setIcon(icon, isRunning ? "square" : ACTION_ICONS[action.id] || "circle");
			button.createSpan({ cls: "agent-dashboard-action-label", text: action.label });
			button.createSpan({
				cls: "agent-dashboard-action-state",
				text: !action.enabled ? "待接入" : isStopping ? "停止中" : isRunning ? "运行中 · 点击停止" : descriptions[action.id] || "",
			});
			this.registerDomEvent(button, "click", () => {
				const currentRun = this.plugin.getRunningTaskRun(action.id);
				if (currentRun) {
					this.requestStopRun(currentRun);
					return;
				}
				this.openAction(action);
			});
		});
		this.refreshReadingEntry();
	}
	private refreshReadingEntry(): void {
		if (this.closed || !this.plugin.getReadingWorkspace) return;
		const recent = this.contentEl.querySelector<HTMLElement>(".agent-dashboard-recent"); if (recent) this.refreshRecentReading(recent);
		for (const [actionId, domain, title] of [["pdf-xray", "paper", "文献深读"], ["code-analysis", "code", "代码分析"]] as const) {
			if (this.plugin.isActionRunning(actionId)) continue;
			const button = this.contentEl.querySelector<HTMLButtonElement>('[data-action-id="' + actionId + '"]'); if (!button) continue;
			const state = readingDashboardState(this.plugin.getReadingWorkspace().repository.sessions.values(), domain);
			const label = button.querySelector(".agent-dashboard-action-state"); if (label) label.textContent = state.label;
			button.classList.toggle("is-running", state.running);
			button.title = [state.title, state.label, "打开" + title + "；停止生成请使用阅读界面的停止按钮"].filter(Boolean).join("\n");
			button.setAttribute("aria-label", title + "，" + state.label + (state.title ? "，" + state.title : ""));
		}
	}
	private refreshRecentReading(parent: HTMLElement): void {
		const sessions = this.plugin.getReadingWorkspace ? recentReading(this.plugin.getReadingWorkspace().repository.sessions.values()).slice(0, 3) : [];
		const signature = JSON.stringify(sessions.map(s => [s.id, readingTitle(s), readingDashboardState([s], s.source.kind === "code" ? "code" : "paper").label]));
		if (signature === this.recentSignature) return; this.recentSignature = signature;
		parent.empty();
		parent.classList.toggle("is-expanded", this.recentExpanded);
		parent.createEl("h2", { text: "最近阅读" });
		if (!sessions.length) { parent.createEl("p", { cls: "agent-dashboard-empty-state", text: "打开一篇论文后，可以从这里继续阅读。" }); return; }
		const list = parent.createDiv({ cls: "agent-dashboard-recent-list" });
		for (const session of sessions) {
			const state = readingDashboardState([session], session.source.kind === "code" ? "code" : "paper"); const item = list.createEl("button", { cls: "agent-dashboard-recent-item", attr: { title: readingTitle(session), "aria-label": "继续阅读：" + readingTitle(session) } }); item.type = "button";
			setIcon(item.createSpan({ cls: "agent-dashboard-recent-icon", attr: { "aria-hidden": "true" } }), session.source.kind === "code" ? "code-xml" : "book-open");
			const copy = item.createSpan({ cls: "agent-dashboard-recent-copy" }); copy.createSpan({ cls: "agent-dashboard-recent-title", text: readingTitle(session) });
			copy.createSpan({ cls: "agent-dashboard-recent-state", text: state.label });
			setIcon(item.createSpan({ cls: "agent-dashboard-recent-arrow", attr: { "aria-hidden": "true" } }), "arrow-right");
			item.addEventListener("click", () => { void this.plugin.activateReadingWorkspace({ sessionId: session.id }).catch(error => new Notice(String(error))); });
		}
		if (sessions.length > 1) {
			const more = parent.createEl("button", { cls: "agent-dashboard-text-action agent-dashboard-recent-more", text: this.recentExpanded ? "收起其他阅读" : `其他 ${sessions.length - 1} 条阅读` }); more.type = "button";
			more.addEventListener("click", () => { this.recentExpanded = !this.recentExpanded; parent.classList.toggle("is-expanded", this.recentExpanded); more.textContent = this.recentExpanded ? "收起其他阅读" : `其他 ${sessions.length - 1} 条阅读`; });
		}
	}

	requestStopRun(run: TaskRun): void {
		if (!run || this.stoppingRunIds.has(run.id)) return;
		// Ownership is resolved by the plugin (loop → direct query → process);
		// the dashboard must not infer it from executionConfig.backend.
		const requested = this.plugin.stopTaskRun(run.id);
		if (!requested) {
			new Notice("任务进程已经结束，正在刷新运行状态");
			void this.loadAndRender();
			return;
		}
		this.stoppingRunIds.add(run.id);
		new Notice(`正在停止：${run.label}`);
		this.renderDashboard();
	}

	renderStats(parent: HTMLElement): void {
		const grid = parent.createEl("section", { cls: "agent-dashboard-metric-grid", attr: { "aria-label": "知识库摘要指标" } });
		this.currentData.metrics.forEach((metric) => {
			const card = grid.createEl("article", { cls: `agent-dashboard-metric-card agent-dashboard-tone-${metric.tone}` });
			card.createDiv({ cls: "agent-dashboard-metric-label", text: metric.label });
			const value = card.createDiv({ cls: "agent-dashboard-metric-value" });
			if (!/^\d+$/.test(metric.value)) value.addClass("is-empty");
			value.createSpan({ text: metric.value });
			if (metric.unit.length > 0) {
				value.createEl("small", { text: metric.unit });
			}
			card.createEl("p", { cls: "agent-dashboard-metric-detail", text: metric.detail });
			if (metric.label === "知识库健康" && !/^\d+$/.test(metric.value)) {
				const check = card.createEl("button", { cls: "agent-dashboard-text-action", text: "运行体检" }); check.type = "button";
				check.addEventListener("click", () => { const action = ACTION_BY_ID.get("vault-lint"); if (action) this.openAction(action); });
			}
		});
	}

	renderHeatmap(parent: HTMLElement): void {
		const panel = this.createPanel(parent, "agent-dashboard-panel-wide agent-dashboard-heatmap-panel", "知识库概览", this.currentData.activity.title, this.currentData.activity.rangeLabel);
		const stage = panel
			.createDiv({ cls: "agent-dashboard-heatmap-scroll", attr: { role: "img", "aria-label": "最近三个月笔记最后修改日期的分布，不代表完整活动记录" } })
			.createDiv({ cls: "agent-dashboard-heatmap-stage" });
		stage.style.setProperty("--dashboard-weeks", String(Math.ceil(this.currentData.activity.days.length / 7)));
		const monthRow = stage.createDiv({ cls: "agent-dashboard-month-row", attr: { "aria-hidden": "true" } });
		const graph = stage.createDiv({ cls: "agent-dashboard-heatmap-graph" });
		const weekdayLabels = graph.createDiv({ cls: "agent-dashboard-weekday-labels", attr: { "aria-hidden": "true" } });
		["一", "", "三", "", "五", "", "日"].forEach((label) => weekdayLabels.createSpan({ text: label }));
		const cells = graph.createDiv({ cls: "agent-dashboard-heatmap-cells" });
		this.renderMonthMarkers(monthRow, this.currentData.activity.days);
		this.currentData.activity.days.forEach((day) => {
			const label = day.inRange ? `${day.date}: ${day.count} 篇笔记的最后修改日期在这一天` : `${day.date}: 不在统计范围内`;
			const cell = cells.createSpan({
				cls: `agent-dashboard-heat-cell agent-dashboard-heat-level-${day.inRange ? day.level : 0}`,
				attr: { "aria-label": label, title: label },
			});
			if (!day.inRange) {
				cell.addClass("agent-dashboard-heat-cell-outside");
			}
		});
		const footer = panel.createDiv({ cls: "agent-dashboard-heatmap-footer" });
		footer.createEl("p", { cls: "agent-dashboard-activity-note", text: "按笔记最后修改时间统计，不代表完整活动记录或阅读时长。" });
		const legend = footer.createDiv({ cls: "agent-dashboard-density-legend", attr: { "aria-label": "活动密度图例" } });
		legend.createSpan({ text: "少" });
		[0, 1, 2, 3, 4].forEach((level) => legend.createSpan({ cls: `agent-dashboard-density agent-dashboard-density-${level}` }));
		legend.createSpan({ text: "多" });
	}

	renderAgentRuns(parent: HTMLElement): void {
		const panel = this.createPanel(parent, "agent-dashboard-list-panel agent-dashboard-tasks", "当前工作", "任务与结果");
		this.renderFilterGroup(panel, "runs");
		const list = panel.createDiv({ cls: "agent-dashboard-table-list" });
		this.renderAgentRunsList(list);
	}

	renderKnowledgeGaps(parent: HTMLElement): void {
		const panel = this.createPanel(parent, "agent-dashboard-list-panel", "知识缺口", "待处理问题");
		this.renderFilterGroup(panel, "gaps");
		const list = panel.createDiv({ cls: "agent-dashboard-table-list" });
		this.renderKnowledgeGapsList(list);
	}

	renderProcessingDepth(parent: HTMLElement): void {
		const panel = this.createPanel(parent, "agent-dashboard-tri-panel", "处理深度", "论文证据深度");
		const bar = panel.createDiv({ cls: "agent-dashboard-stacked-bar", attr: { "aria-label": "证据处理深度分布" } });
		this.currentData.processingDepth.forEach((row) => {
			const segment = bar.createSpan({
				cls: `agent-dashboard-bar-segment agent-dashboard-bar-${this.formatClassToken(row.label)}`,
				attr: { "aria-label": `${this.displayDepth(row.label)}: ${row.percent}%` },
			});
			segment.style.width = `${row.percent}%`;
		});
		const list = panel.createDiv({ cls: "agent-dashboard-count-list" });
		this.currentData.processingDepth.forEach((row) => {
			const item = list.createDiv({ cls: "agent-dashboard-count-item" });
			item.createSpan({ cls: "agent-dashboard-count-name", text: this.displayDepth(row.label) });
			item.createSpan({ cls: "agent-dashboard-count-value", text: `${row.count} / ${row.percent}%` });
		});
	}

	renderCoverage(parent: HTMLElement): void {
		const panel = this.createPanel(parent, "agent-dashboard-tri-panel", "知识枢纽", "方法 / 综合覆盖");
		const stats = panel.createDiv({ cls: "agent-dashboard-coverage-stats" });
		[
			["方法", this.currentData.coverage.methodNodes],
			["综合", this.currentData.coverage.synthesisNodes],
			["待建", this.currentData.coverage.missingMethodPages],
		].forEach(([label, value]) => {
			const stat = stats.createDiv({ cls: "agent-dashboard-coverage-stat" });
			stat.createSpan({ cls: "agent-dashboard-coverage-number", text: String(value) });
			stat.createSpan({ cls: "agent-dashboard-coverage-label", text: String(label) });
		});
		const hubs = panel.createDiv({ cls: "agent-dashboard-hub-list" });
		this.currentData.coverage.recentHubs.forEach((hub) => hubs.createDiv({ cls: "agent-dashboard-hub-item" }).createSpan({ cls: "agent-dashboard-hub-name", text: hub }));
	}

	renderOkfReadiness(parent: HTMLElement): void {
		const panel = this.createPanel(parent, "agent-dashboard-tri-panel", "可移植输出", "OKF 就绪度", this.currentData.okf.latestLabel);
		this.renderOkfList(panel, this.currentData.okf);
		this.renderRiskBox(panel, this.currentData.okf);
	}

	renderFilterGroup(panel: HTMLElement, type: "runs" | "gaps"): void {
		const heading = panel.find(".agent-dashboard-panel-heading");
		if (!heading) return;
		heading.addClass("agent-dashboard-compact-heading");
		const group = heading.createDiv({ cls: "agent-dashboard-filter-group", attr: { "aria-label": type === "runs" ? "筛选智能体运行记录" : "筛选知识缺口" } });
		const filters = type === "runs" ? [["all", "全部"], ["done", "已完成"], ["open", "未完成"]] : [["all", "全部"], ["high", "高"], ["medium", "中"], ["low", "低"]];
		filters.forEach(([key, label]) => {
			const active = type === "runs" ? this.runsFilter === key : this.gapsFilter === key;
			const button = group.createEl("button", {
				cls: active ? "agent-dashboard-filter-button is-active" : "agent-dashboard-filter-button",
				text: label,
				attr: { "aria-pressed": active ? "true" : "false" },
			});
			button.type = "button";
			this.registerDomEvent(button, "click", () => {
				if (type === "runs") {
					this.runsFilter = key as RunsFilter;
					this.runsExpanded = false;
				} else {
					this.gapsFilter = key as GapsFilter;
				}
				this.renderDashboard();
			});
		});
	}

	renderAgentRunsList(parent: HTMLElement): void {
		parent.empty();
		const visibleRuns = this.currentData.agentRuns.filter((run) => this.isVisibleAgentRun(run));
		if (visibleRuns.length === 0) {
			parent.createEl("p", { cls: "agent-dashboard-empty-state", text: "当前筛选条件下没有运行记录。" });
			return;
		}
		(this.runsExpanded ? visibleRuns : visibleRuns.slice(0, 5)).forEach((run) => {
			const row = run.runId
				? parent.createEl("button", { cls: "agent-dashboard-data-row agent-dashboard-run-row" })
				: parent.createEl("article", { cls: "agent-dashboard-data-row" });
			if (run.runId && row instanceof HTMLButtonElement) {
				const runId = run.runId;
				row.type = "button";
				row.setAttr("title", run.detail + "\n查看任务输出");
				this.registerDomEvent(row, "click", () => {
					const taskRun = this.plugin.getTaskRun(runId);
					if (taskRun) this.openTaskResult(taskRun);
				});
			}
			const copy = row.createSpan({ cls: "agent-dashboard-run-copy" });
			copy.createSpan({ cls: "agent-dashboard-row-title", text: run.label + " · " + run.task });
			copy.createSpan({ cls: "agent-dashboard-row-type", text: `${run.time} · ${run.agent}` });
			row.createSpan({ cls: `agent-dashboard-status-badge agent-dashboard-status-${run.status}`, text: this.displayStatus(run.status) });
		});
		if (visibleRuns.length > 5) {
			const more = parent.createEl("button", { cls: "agent-dashboard-text-action agent-dashboard-more-runs", text: this.runsExpanded ? "收起历史记录" : `查看全部 ${visibleRuns.length} 条` }); more.type = "button";
			more.addEventListener("click", () => { this.runsExpanded = !this.runsExpanded; this.renderAgentRunsList(parent); });
		}
	}

	renderKnowledgeGapsList(parent: HTMLElement): void {
		parent.empty();
		const visibleGaps = this.currentData.knowledgeGaps.filter((gap) => this.isVisibleKnowledgeGap(gap));
		if (visibleGaps.length === 0) {
			parent.createEl("p", { cls: "agent-dashboard-empty-state", text: "当前筛选条件下没有待处理的知识缺口。" });
			return;
		}
		visibleGaps.forEach((gap) => {
			const row = parent.createEl("article", { cls: "agent-dashboard-data-row agent-dashboard-gap-row" });
			row.createSpan({ cls: "agent-dashboard-row-type", text: this.displayGapType(gap.type) });
			row.createSpan({ cls: "agent-dashboard-row-title", text: gap.title });
			row.createSpan({ cls: `agent-dashboard-severity-badge agent-dashboard-severity-${gap.severity}`, text: this.displaySeverity(gap.severity) });
			this.renderKnowledgeGapAction(row, gap);
		});
	}

	renderKnowledgeGapAction(parent: HTMLElement, gap: KnowledgeGap): void {
		const action = ACTION_BY_ID.get(gap.actionId);
		const button = parent.createEl("button", {
			cls: "agent-dashboard-gap-action",
			attr: {
				"aria-label": action ? `处理知识缺口：${gap.title}，使用${action.label}` : `无法处理知识缺口：${gap.title}`,
				title: action ? `使用“${action.label}”处理` : "尚未配置对应操作",
			},
		});
		button.type = "button";
		button.disabled = !action || !action.enabled || this.plugin.isActionRunning(action.id);
		if (action && this.plugin.isActionRunning(action.id)) button.addClass("is-running");
		setIcon(button.createSpan({ cls: "agent-dashboard-gap-action-icon" }), action?.id === "okf-export" ? "package-open" : "arrow-right");
		button.createSpan({ text: action && this.plugin.isActionRunning(action.id) ? "处理中" : "处理" });
		this.registerDomEvent(button, "click", () => {
			if (!action) {
				new Notice("该知识缺口尚未配置对应操作");
				return;
			}
			this.openAction(action, { initialInput: gap.actionInput || "" });
		});
	}

	renderOkfList(parent: HTMLElement, okf: OkfReadiness): void {
		const list = parent.createDiv({ cls: "agent-dashboard-okf-list" });
		okf.readiness.forEach((item) => {
			const row = list.createDiv({ cls: "agent-dashboard-okf-item" });
			row.createSpan({ cls: "agent-dashboard-okf-label", text: item.label });
			row.createSpan({ cls: `agent-dashboard-okf-state agent-dashboard-okf-${item.state}`, text: this.displayOkfState(item.state) });
		});
	}

	renderRiskBox(parent: HTMLElement, okf: OkfReadiness): void {
		const box = parent.createDiv({ cls: "agent-dashboard-risk-box" });
		const head = box.createDiv({ cls: "agent-dashboard-risk-head" });
		head.createSpan({ text: "维护风险" });
		head.createSpan({ text: this.displayRisk(okf.maintenanceRisk.level) });
		const list = box.createEl("ul", { cls: "agent-dashboard-risk-list" });
		okf.maintenanceRisk.items.forEach((item) => list.createEl("li", { text: item }));
	}

	createPanel(
		parent: HTMLElement,
		className: string,
		kicker: string,
		title: string,
		stat?: string,
	): HTMLElement {
		const panel = parent.createEl("section", { cls: `agent-dashboard-panel ${className}`, attr: { "aria-label": title } });
		const heading = panel.createDiv({ cls: "agent-dashboard-panel-heading" });
		const titleBlock = heading.createDiv();
		titleBlock.createEl("p", { cls: "agent-dashboard-panel-kicker", text: kicker });
		titleBlock.createEl("h2", { text: title });
		if (stat) {
			heading.createEl("p", { cls: "agent-dashboard-panel-stat", text: stat });
		}
		return panel;
	}

	async runRefresh(button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.addClass("is-loading");
		button.setAttribute("aria-label", "正在刷新控制台状态");
		button.title = "扫描中";
		setIcon(button, "loader-circle");
		await this.loadAndRender();
		button.removeClass("is-loading");
		button.setAttribute("aria-label", "控制台状态已刷新");
		button.title = "完成";
		setIcon(button, "check");
		window.setTimeout(() => {
			button.setAttribute("aria-label", "刷新控制台状态");
			button.title = "刷新";
			setIcon(button, "refresh-cw");
			button.disabled = false;
		}, 900);
	}

	openAction(
		action: DashboardAction,
		options: { initialInput?: string } = {},
	): void {
		if (!action.enabled) {
			new Notice(`${action.label}将在后续阶段接入`);
			return;
		}
		if (action.queryView) {
			void this.plugin.activateQueryWikiView(options.initialInput || "");
			return;
		}
		if (action.id === "fulltext-acquisition") { this.plugin.openFulltextAcquisition(); return; }
		if (action.id === "pdf-xray" || action.id === "code-analysis") {
			const code = action.id === "code-analysis";
			void this.plugin.activateReadingWorkspace({ domain: code ? "code" : "paper" }).catch(error => new Notice(String(error)));
			return;
		}
		if (this.plugin.isActionRunning(action.id)) {
			new Notice(`${action.label}正在运行`);
			return;
		}
		if (action.localView) {
			void this.plugin.activateCodePracticeView();
			return;
		}
		if (action.ai || action.requiresInput) {
			new ActionInputModal(this.app, this.plugin, action, ({ input, overrides, options: actionOptions, runner }) => {
				void this.executeAction(action, input, overrides, actionOptions, runner);
			}, options).open();
			return;
		}
		void this.executeAction(action, "");
	}

	async executeAction(
		action: DashboardAction,
		input: string,
		executionOverrides: ExecutionOverrides = {},
		actionOptions: DashboardActionOptions = {},
		runner: ActionRunnerKind = "cli-agent",
	): Promise<void> {
		if (action.id === "paper-ingest" && runner === "light-agent") {
			await this.executeLightPaperIngest(action, input, actionOptions);
			return;
		}
		const summary = input.trim().split(/\r?\n/)[0].slice(0, 160) || action.description;
		const requestPayload = serializeActionRequest(
			action,
			input,
			actionOptions,
			this.plugin.settings.mineruExecutable,
			this.plugin.settings.mineruBaseUrl,
		);
		const backendId = executionOverrides.backend === "claude-code"
			? "claude-code"
			: executionOverrides.backend === "opencode"
				? "opencode"
				: "codex-cli";
		const executionConfig = action.ai
			? this.plugin.resolveCliActionExecutionConfig(
				action,
				backendId,
				executionOverrides,
			)
			: null;
		let run: TaskRun | null = null;
		let completedRun;
		try {
			run = await this.plugin.startTaskRun(action, summary, executionConfig);
			await this.loadAndRender();
			const result = await this.plugin.runVaultAction(run.id, action, requestPayload, executionConfig);
			const output = this.formatProcessOutput(result);
			const lintCompletedWithFindings = action.id === "vault-lint"
				&& result.exitCode === 1
				&& result.stdout.includes("Vault lint: score");
			const repairCompletedWithFindings = action.id === "vault-lint-fix"
				&& result.exitCode === 1
				&& result.stdout.includes("Post-repair vault lint:");
			const interrupted = result.exitCode === 130
				|| (result.events || []).some((event) => event.type === "status" && event.stage === "stopped");
			const rollbackEvent = [...(result.events || [])]
				.reverse()
				.find((event) => event.type === "change-manifest");
			const rollbackCompleted = rollbackEvent?.status === "rolled-back";
			const rollbackIncomplete = rollbackEvent?.status === "rollback-incomplete";
			const status = interrupted
				? "interrupted"
				: result.exitCode === 0 || lintCompletedWithFindings || repairCompletedWithFindings
					? "done"
					: "failed";
			completedRun = await this.plugin.finishTaskRun(run.id, {
				status,
				exitCode: result.exitCode,
				output,
				error: status === "failed"
					? `进程退出码：${result.exitCode}`
					: status === "interrupted"
						? rollbackIncomplete
							? "任务已手动停止，但自动回滚不完整，请检查变更清单"
							: rollbackCompleted
								? "任务已手动停止，修改已自动回滚"
								: "任务已手动停止"
						: "",
			});
			const completionMessage = lintCompletedWithFindings
				? "知识库体检已完成，发现待处理项"
				: repairCompletedWithFindings
					? "体检修复已完成，仍有待处理项"
					: `${action.label}已完成`;
			new Notice(
				status === "done"
					? completionMessage
					: status === "interrupted"
						? rollbackIncomplete
							? `${action.label}已停止，但回滚不完整`
							: rollbackCompleted
								? `${action.label}已停止，修改已回滚`
								: `${action.label}已停止`
						: `${action.label}执行失败`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			completedRun = run ? await this.plugin.finishTaskRun(run.id, {
				status: "failed",
				exitCode: null,
				output: "",
				error: message,
			}) : null;
			new Notice(`${action.label}执行失败：${message}`);
		}
		await this.loadAndRender();
		if (completedRun) {
			this.openTaskResult(completedRun);
		}
	}

	/**
	 * 文献入库 through the in-plugin bounded agent loop: no CLI process, the
	 * Direct API profile is the brain and the loop only exposes allowlisted
	 * tools. Mirrors executeAction's TaskRun lifecycle.
	 */
	async executeLightPaperIngest(
		action: DashboardAction,
		input: string,
		actionOptions: DashboardActionOptions,
	): Promise<void> {
		const availability = this.plugin.lightPaperIngestAvailable();
		if (!availability.ready) {
			new Notice(`轻量 Agent 不可用：${availability.reason}`);
			return;
		}
		const profileId = this.plugin.settings.activeProviderId;
		const providerSummary = this.plugin.getActiveDirectProviderSummary();
		const summary = input.trim().split(/\r?\n/)[0].slice(0, 160) || "轻量 Agent 文献入库";
		// One authoritative parse at the input boundary: quotes stripped,
		// file:// URLs resolved, the path separated from the notes so local
		// directories never leak into the model prompt.
		const parsedInput = parsePaperIngestInput(input);
		const flowOptions: PaperIngestFlowOptions = {
			sourcePdfPath: parsedInput.sourcePdfPath,
			requestNotes: parsedInput.requestNotes,
			identityCandidateTitle: String(actionOptions.identityCandidateTitle || "").trim().slice(0, 500),
			identityCandidateDoi: String(actionOptions.identityCandidateDoi || "").trim().slice(0, 200),
			createArticleMarkdown: actionOptions.createArticleMarkdown !== false,
			createArticleWiki: actionOptions.createArticleWiki !== false,
			articleWikiSource: actionOptions.articleWikiSource === "pdf"
				? "pdf"
				: actionOptions.articleWikiSource === "article"
					? "article"
					: "auto",
			mineruModel: actionOptions.mineruModel === "pipeline" || actionOptions.mineruModel === "auto"
				? actionOptions.mineruModel
				: "vlm",
			mineruLanguage: actionOptions.mineruLanguage || "en",
			mineruOcr: actionOptions.mineruOcr === true,
			mineruFormula: actionOptions.mineruFormula !== false,
			mineruTable: actionOptions.mineruTable !== false,
			mineruPages: actionOptions.mineruPages || "",
			mineruTimeoutSeconds: Math.max(60, Math.min(1800, Math.round(Number(actionOptions.mineruTimeoutSeconds)) || 600)),
			mineruIncludeSourcePdf: actionOptions.mineruIncludeSourcePdf === true,
			remoteUploadConfirmed: actionOptions.mineruRemoteConfirmed === true,
		};
		if (flowOptions.createArticleMarkdown && !flowOptions.remoteUploadConfirmed) {
			new Notice("请先勾选「确认远程处理」：PDF 将发送至 MinerU 服务");
			return;
		}
		const executionConfig: ExecutionConfig = {
			backend: "direct-api",
			providerId: profileId,
			providerName: providerSummary?.name || "Direct API",
			model: providerSummary?.model || "",
			reasoningEffort: null,
			serviceTier: null,
		};
		let run: TaskRun | null = null;
		let completedRun: TaskRun | null = null;
		try {
			run = await this.plugin.startTaskRun(action, summary, executionConfig);
			await this.loadAndRender();
			const outcome = await this.plugin.runLightPaperIngest(run.id, flowOptions, profileId);
			const conflict = outcome.result?.status === "conflict";
			const duplicate = outcome.result?.status === "completed"
				&& outcome.exitCode === 0
				&& !outcome.result.wikiPath
				&& !outcome.result.articlePath
				&& (outcome.result.duplicates.length > 0 || outcome.result.notes.some((note) => note.includes("已存在完全相同文献")));
			const updates = ingestTaskResult(outcome);
			const status = updates.status;
			completedRun = await this.plugin.finishTaskRun(run.id, updates);
			new Notice(
				status === "done"
					? duplicate
						? "已存在完全相同文献，跳过生成（详见任务结果）"
						: conflict
							? "文献入库发现冲突，详见任务结果"
							: `${action.label}已完成（轻量 Agent）`
					: status === "interrupted"
						? `${action.label}已停止`
						: `${action.label}未完成（轻量 Agent）`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			completedRun = run ? await this.plugin.finishTaskRun(run.id, {
				status: "failed",
				exitCode: null,
				output: "",
				error: message,
			}) : null;
			new Notice(`${action.label}执行失败：${message}`);
		}
		await this.loadAndRender();
		if (completedRun) {
			this.openTaskResult(completedRun);
		}
	}

	openTaskResult(run: TaskRun): void {
		if (run.actionId === "fulltext-acquisition") { this.plugin.openFulltextAcquisition("production", run.id); return; }
		const onRepair = run.actionId === "vault-lint"
			? () => {
				const repairAction = ACTION_BY_ID.get("vault-lint-fix");
				if (repairAction) this.openAction(repairAction);
			}
			: null;
		new TaskResultModal(this.app, this.plugin, run, onRepair).open();
	}

	formatProcessOutput(result: DashboardProcessResult): string {
		const parts: string[] = [];
		if (result.stdout.trim()) {
			parts.push(result.stdout.trim());
		}
		if (result.stderr.trim()) {
			parts.push(`运行日志\n${result.stderr.trim()}`);
		}
		return parts.join("\n\n").slice(0, 120000) || "任务未返回文本输出。";
	}

	isVisibleAgentRun(run: AgentRun): boolean {
		if (this.runsFilter === "all") return true;
		if (this.runsFilter === "open") return run.status !== "done";
		return run.status === this.runsFilter;
	}

	isVisibleKnowledgeGap(gap: KnowledgeGap): boolean {
		return this.gapsFilter === "all" || gap.severity === this.gapsFilter;
	}

	renderMonthMarkers(parent: HTMLElement, days: HeatmapDay[]): void {
		const weekCount = Math.ceil(days.length / 7);
		for (let week = 0; week < weekCount; week += 1) {
			const monthStart = days.slice(week * 7, week * 7 + 7).find((day) => {
				const date = new Date(`${day.date}T00:00:00`);
				return day.inRange && date.getDate() === 1;
			});
			parent.createSpan({ text: monthStart ? this.monthFormatter.format(new Date(`${monthStart.date}T00:00:00`)) : "" });
		}
	}

	displayStatus(status: string): string {
		return {
			done: "已完成",
			failed: "失败",
			interrupted: "已中断",
			queued: "排队中",
			planned: "计划中",
			pending: "待处理",
			running: "运行中",
		}[status] || status;
	}

	displaySeverity(severity: string): string {
		return {
			high: "高",
			medium: "中",
			low: "低",
		}[severity] || severity;
	}

	displayGapType(type: string): string {
		return {
			method: "方法",
			paper: "文献",
			code: "代码",
			quality: "质量",
			okf: "OKF",
		}[type] || type;
	}

	displayOkfState(state: string): string {
		return {
			ready: "就绪",
			pending: "待处理",
			planned: "计划中",
		}[state] || state;
	}

	displayRisk(level: string): string {
		return {
			watch: "关注",
			low: "低",
		}[level] || level;
	}

	displayDepth(label: string): string {
		return {
			"metadata-only": "仅元数据",
			"abstract-level": "摘要级",
			"x-ray": "x-ray 深读",
			"static-read": "代码静态阅读",
		}[label] || label;
	}

	formatClassToken(value: unknown): string {
		return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
	}
}
