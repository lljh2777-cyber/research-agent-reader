import {
	ItemView,
	MarkdownRenderer,
	Notice,
	TFile,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";

import {
	ACTIONS,
	ACTION_BY_ID,
	type DashboardAction,
} from "../actions";
import {
	MAX_QUERY_IMAGE_ATTACHMENTS,
	MODEL_OPTIONS,
	QUERY_WIKI_VIEW_TYPE,
	REASONING_OPTIONS,
	getCliBackendLabel,
	isCliBackendId,
	type CliBackendId,
} from "../config";
import {
	ActionInputModal,
	type ExecutionOverrides,
} from "../modals/action-input";
import { TaskResultModal } from "../modals/task-result";
import { VaultImagePickerModal } from "../modals/vault-image-picker";
import {
	normalizeQueryCitationValidation,
	normalizeQueryRetrievalPath,
	normalizeQueryVaultSources,
	normalizeQueryWebSources,
	normalizeVaultImageAttachments,
	type QueryVaultSource,
	type VaultImageAttachment,
} from "../query/normalization";
import { makeVaultSourcePathResolver } from "../services/vault-evidence";
import {
	profileSupportsQueryImage,
	type ProviderProfile,
} from "../providers/profile";
import {
	getClaudeConfigSourceLabel,
	getClaudeDefaultModelLabel,
	getCodexConfigSourceLabel,
	getCodexDefaultModelLabel,
	getOpenCodeConfigSourceLabel,
	getOpenCodeDefaultModelLabel,
} from "../runtime/settings";
import type {
	CliModelDiscoveryResult,
	DashboardProcessEvent,
	DashboardProcessResult,
	ExecutionConfig,
	PluginHost,
	QueryMessage as PersistedQueryMessage,
	QueryRetrievalMode,
	QuerySession,
	ServiceTier,
} from "../types/contracts";

type RetrievalTrace = Record<string, unknown> & {
	stage?: string;
	retrieval_label?: string;
	lexical_terms?: string[];
	lexical_seeds?: TraceCandidate[];
	graph_expansion?: TraceCandidate[];
	context_pages?: string[];
	keyword_expansion?: {
		terms?: string[];
		attempted?: boolean;
		error?: string;
	};
	retriever?: {
		selected?: string;
		reason?: string;
	};
	retriever_fallback?: {
		used?: boolean;
		from?: string;
		to?: string;
		reason?: string;
	};
	fallback?: {
		used?: boolean;
		paths?: string[];
		reason?: string;
	};
};

interface TraceCandidate {
	path?: string;
	title?: string;
	title_zh?: string;
}

interface QueryExecutionOverrides {
	model: string;
	reasoningEffort: string;
	serviceTier: ServiceTier;
}

interface QuestionImageResolution {
	attachments: VaultImageAttachment[];
	notePaths: string[];
	discoveredCount: number;
	totalBytes: number;
}

interface QueryRunnerHooks {
	onEvent?: (event: DashboardProcessEvent) => void;
}

interface QueryViewHost extends PluginHost {
	lightPaperIngestAvailable(): { ready: boolean; reason: string };
	lightAgentMineruReady(): boolean;
	getActiveDirectProviderSummary(): { name: string; model: string } | null;
	querySessions: QuerySession[];
	isQueryExecutionActive(runId: string, backendId?: string): boolean;
	appendQueryMessages(
		sessionId: string,
		messages: PersistedQueryMessage[],
		firstQuestion?: string,
	): Promise<void>;
	updateQueryMessage(
		sessionId: string,
		messageId: string,
		updates: Partial<PersistedQueryMessage>,
		saveMode?: "immediate" | "debounced",
	): Promise<PersistedQueryMessage | null>;
	createQueryMessageId(): string;
	setActiveQueryMode(mode: QueryRetrievalMode | string): Promise<void>;
	setActiveQueryBackend(backendId: string): Promise<void>;
	resolveQueryBackendId(backendId?: string): string;
	isCliBackendAvailable(backendId: CliBackendId): boolean;
	getProviderProfile(profileId: string): ProviderProfile | null;
	getVerifiedProviderProfiles(): ProviderProfile[];
	buildVaultImageReferenceIndex(
		files: TFile[],
	): Map<string, Array<{ title: string; path: string; count: number }>>;
	resolveDirectQueryExecutionConfig(profile: ProviderProfile): ExecutionConfig;
	getCliModelDiscovery(backendId: CliBackendId): CliModelDiscoveryResult | null;
	discoverCliModels(
		backendId: CliBackendId,
		force?: boolean,
	): Promise<CliModelDiscoveryResult>;
	invalidateCliModelDiscovery(backendId: CliBackendId): void;
	resolveQuestionImageAttachments(
		question: string,
		existingAttachments?: VaultImageAttachment[],
	): Promise<QuestionImageResolution>;
	buildQueryActionInput(
		question: string,
		priorMessages: PersistedQueryMessage[],
		mode?: QueryRetrievalMode,
		attachments?: VaultImageAttachment[],
	): string;
	runDirectVaultQuery(
		runId: string,
		providerId: string,
		question: string,
		priorMessages: PersistedQueryMessage[],
		mode?: QueryRetrievalMode,
		hooks?: QueryRunnerHooks,
		attachments?: VaultImageAttachment[],
	): Promise<DashboardProcessResult>;
	directProfileSupportsWebSearch(profileId: string): boolean;
	saveQueryAnswerNote(sessionId: string, messageId: string): Promise<string>;
	runVaultAction(
		runId: string,
		action: DashboardAction,
		input: string,
		executionConfig?: ExecutionConfig | null,
		hooks?: QueryRunnerHooks,
	): Promise<DashboardProcessResult>;
	stopDirectVaultQuery(runId: string): boolean;
	stopVaultAction(runId: string): boolean;
	supportsFast(model: string): boolean;
}

export class QueryWikiView extends ItemView {
	private readonly plugin: QueryViewHost;
	private initialQuestion: string;
	private activeRunId: string;
	private activeMessageId: string;
	private stopRequested: boolean;
	private renderVersion: number;
	private inputEl: HTMLTextAreaElement | null;
	private inputSessionId: string;
	private statusEl: HTMLSpanElement | null;
	private pendingImages: VaultImageAttachment[];
	private readonly queryDrafts: Map<string, string>;
	private navigatorFrame: number;
	private executionOverridesByBackend: Record<CliBackendId, QueryExecutionOverrides>;

	constructor(leaf: WorkspaceLeaf, plugin: QueryViewHost) {
		super(leaf);
		this.plugin = plugin;
		this.initialQuestion = "";
		this.activeRunId = "";
		this.activeMessageId = "";
		this.stopRequested = false;
		this.renderVersion = 0;
		this.inputEl = null;
		this.inputSessionId = "";
		this.statusEl = null;
		this.pendingImages = [];
		this.queryDrafts = new Map();
		this.navigatorFrame = 0;
		this.executionOverridesByBackend = {
			"codex-cli": {
				model: "",
				reasoningEffort: "",
				serviceTier: "default",
			},
			"claude-code": {
				model: "",
				reasoningEffort: "",
				serviceTier: "default",
			},
			"opencode": {
				model: "",
				reasoningEffort: "",
				serviceTier: "default",
			},
		};
	}

	getViewType(): string {
		return QUERY_WIKI_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "知识库对话";
	}

	getIcon(): string {
		return "messages-square";
	}

	async onOpen(): Promise<void> {
		this.syncActiveRunFromSession();
		await this.render();
		window.requestAnimationFrame(() => this.activateComposerInput());
	}

	async onClose(): Promise<void> {
		if (this.navigatorFrame) window.cancelAnimationFrame(this.navigatorFrame);
		this.navigatorFrame = 0;
		this.contentEl.empty();
	}

	setInitialQuestion(value: unknown): void {
		this.initialQuestion = String(value || "").trim();
		if (this.initialQuestion) {
			this.queryDrafts.set(this.session.id, this.initialQuestion);
		}
		if (this.containerEl?.isConnected) {
			void this.render().then(() => this.inputEl?.focus());
		}
	}

	activateComposerInput(moveCursorToEnd = false): void {
		const input = this.inputEl;
		if (!input?.isConnected) return;
		input.disabled = false;
		input.readOnly = false;
		input.removeAttribute("disabled");
		input.removeAttribute("readonly");
		input.focus({ preventScroll: true });
		if (moveCursorToEnd) {
			const end = input.value.length;
			input.setSelectionRange(end, end);
		}
	}

	get session(): QuerySession {
		return this.plugin.getActiveQuerySession();
	}

	syncActiveRunFromSession(): void {
		const activeMessage = this.session.messages.find((message) => {
			return ["pending", "stopping"].includes(message.status)
				&& message.runId
				&& this.plugin.isQueryExecutionActive(message.runId, message.queryBackendId);
		});
		this.activeRunId = activeMessage?.runId || "";
		this.activeMessageId = activeMessage?.id || "";
		this.stopRequested = activeMessage?.status === "stopping";
	}

	async render(options: { scrollToBottom?: boolean } = {}): Promise<void> {
		const version = ++this.renderVersion;
		const session = this.session;
		const previousInput = this.inputEl;
		const previousInputSessionId = this.inputSessionId;
		const restoreInputFocus = Boolean(
			previousInput?.isConnected
			&& previousInputSessionId === session.id
			&& typeof document !== "undefined"
			&& document.activeElement === previousInput,
		);
		const previousSelection = restoreInputFocus && previousInput
			? {
				start: previousInput.selectionStart,
				end: previousInput.selectionEnd,
			}
			: null;
		if (previousInput?.isConnected) {
			this.queryDrafts.set(previousInputSessionId || session.id, previousInput.value);
		}
		if (this.navigatorFrame) window.cancelAnimationFrame(this.navigatorFrame);
		this.navigatorFrame = 0;
		this.contentEl.empty();
		this.contentEl.addClass("query-wiki-view");
		const shell = this.contentEl.createDiv({ cls: "query-wiki-shell" });
		this.renderHeader(shell, session);
		const conversationRegion = shell.createDiv({ cls: "query-wiki-conversation-region" });
		const conversation = conversationRegion.createDiv({
			cls: "query-wiki-conversation",
			attr: { "aria-live": "polite" },
		});
		if (!session.messages.length) {
			this.renderEmptyState(conversation);
		} else {
			for (const message of session.messages) {
				if (version !== this.renderVersion) return;
				await this.renderMessage(conversation, message);
			}
		}
		if (version !== this.renderVersion) return;
		this.renderConversationNavigator(conversationRegion, conversation, session.messages);
		this.renderComposer(shell);
		if (restoreInputFocus) {
			window.requestAnimationFrame(() => {
				if (version !== this.renderVersion || !this.inputEl?.isConnected) return;
				this.inputEl.focus({ preventScroll: true });
				if (previousSelection) {
					const max = this.inputEl.value.length;
					this.inputEl.setSelectionRange(
						Math.min(previousSelection.start, max),
						Math.min(previousSelection.end, max),
					);
				}
			});
		}
		if (options.scrollToBottom) {
			window.requestAnimationFrame(() => {
				conversation.scrollTop = conversation.scrollHeight;
			});
		}
	}

	renderConversationNavigator(
		parent: HTMLElement,
		conversation: HTMLElement,
		messages: PersistedQueryMessage[],
	): void {
		const navigationMessages = Array.isArray(messages)
			? messages.filter((message) => message.role === "user")
			: [];
		if (navigationMessages.length < 2) return;
		parent.addClass("has-navigator");
		const navigator = parent.createEl("nav", {
			cls: "query-wiki-navigator",
			attr: { "aria-label": "快速定位用户问题" },
		});
		navigator.style.setProperty("--query-navigator-count", String(navigationMessages.length));
		const markers: Array<{ marker: HTMLButtonElement; messageId: string }> = [];
		for (const [index, message] of navigationMessages.entries()) {
			const snippet = String(
				message.content
					|| message.progress
					|| "空问题",
			)
				.replace(/```[\s\S]*?```/g, " 代码块 ")
				.replace(/[#>*_`~\[\]]/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 72);
			const marker = navigator.createEl("button", {
				cls: "query-wiki-navigator-marker is-user",
				attr: {
					type: "button",
					"aria-label": `问题 ${index + 1}：${snippet}`,
					"data-target-message-id": message.id,
				},
			});
			marker.createSpan({
				cls: "query-wiki-navigator-tooltip",
				text: snippet || "空问题",
			});
			marker.addEventListener("click", () => {
				const article = conversation.querySelector(
					`[data-message-id="${CSS.escape(String(message.id))}"]`,
				);
				if (!article) return;
				const conversationRect = conversation.getBoundingClientRect();
				const articleRect = article.getBoundingClientRect();
				const top = conversation.scrollTop + articleRect.top - conversationRect.top - 12;
				conversation.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
				markers.forEach((item) => {
					item.marker.toggleClass("is-active", item.messageId === message.id);
					item.marker.setAttribute(
						"aria-current",
						item.messageId === message.id ? "true" : "false",
					);
				});
			});
			markers.push({ marker, messageId: message.id });
		}
		const updateActiveMarker = () => {
			this.navigatorFrame = 0;
			const conversationRect = conversation.getBoundingClientRect();
			const threshold = conversationRect.top + Math.min(120, conversationRect.height * 0.3);
			let activeId = markers[0]?.messageId || "";
			for (const item of markers) {
				const article = conversation.querySelector(
					`[data-message-id="${CSS.escape(String(item.messageId))}"]`,
				);
				if (!article) continue;
				if (article.getBoundingClientRect().top <= threshold) activeId = item.messageId;
				else break;
			}
			markers.forEach((item) => {
				const active = item.messageId === activeId;
				item.marker.toggleClass("is-active", active);
				item.marker.setAttribute("aria-current", active ? "true" : "false");
			});
		};
		const scheduleUpdate = () => {
			if (this.navigatorFrame) return;
			this.navigatorFrame = window.requestAnimationFrame(updateActiveMarker);
		};
		conversation.addEventListener("scroll", scheduleUpdate, { passive: true });
		scheduleUpdate();
	}

	renderHeader(parent: HTMLElement, session: QuerySession): void {
		const header = parent.createEl("header", { cls: "query-wiki-header" });
		const title = header.createDiv({ cls: "query-wiki-title" });
		title.createEl("p", { cls: "query-wiki-kicker", text: "VAULT EVIDENCE" });
		title.createEl("h1", { text: "知识库对话" });
		const tools = header.createDiv({ cls: "query-wiki-header-tools" });
		const sessions = tools.createEl("select", {
			cls: "query-wiki-session-select",
			attr: { "aria-label": "选择查询会话", title: "查询历史" },
		});
		this.plugin.getQuerySessions().forEach((item) => {
			sessions.createEl("option", {
				text: item.title || "新对话",
				attr: { value: item.id },
			});
		});
		sessions.value = session.id;
		sessions.disabled = Boolean(this.activeRunId);
		sessions.addEventListener("change", () => {
			this.pendingImages = [];
			void this.plugin.setActiveQuerySession(sessions.value).then(() => {
				this.syncActiveRunFromSession();
				return this.render();
			}).then(() => this.activateComposerInput(true));
		});
		const create = this.createIconButton(tools, "message-square-plus", "新建对话");
		create.disabled = Boolean(this.activeRunId);
		create.addEventListener("click", () => {
			this.pendingImages = [];
			void this.plugin.createQuerySession().then(() => this.render()).then(() => this.inputEl?.focus());
		});
		const save = this.createIconButton(tools, "file-output", "整理为笔记");
		save.disabled = Boolean(this.activeRunId) || !session.messages.some((message) => message.role === "assistant" && message.status === "done");
		save.addEventListener("click", () => this.openSynthesisHandoff());
		const canDeleteSession = this.plugin.getQuerySessions().length > 1;
		const clear = this.createIconButton(
			tools,
			"trash-2",
			canDeleteSession ? "删除当前对话" : "清空当前对话",
		);
		clear.disabled = Boolean(this.activeRunId)
			|| (!canDeleteSession && session.messages.length === 0);
		clear.addEventListener("click", () => {
			const confirmation = canDeleteSession
				? "删除当前查询会话？此操作不会删除任何知识库笔记。"
				: "清空当前查询会话？此操作不会删除任何知识库笔记。";
			if (!window.confirm(confirmation)) return;
			this.pendingImages = [];
			this.queryDrafts.delete(session.id);
			const operation = canDeleteSession
				? this.plugin.deleteActiveQuerySession()
				: this.plugin.clearActiveQuerySession();
			void operation
				.then(() => {
					this.syncActiveRunFromSession();
					return this.render();
				})
				.then(() => this.inputEl?.focus());
		});
	}

	renderEmptyState(parent: HTMLElement): void {
		const empty = parent.createDiv({ cls: "query-wiki-empty" });
		const icon = empty.createDiv({ cls: "query-wiki-empty-icon" });
		setIcon(icon, "search");
		empty.createEl("h2", { text: "从当前知识库开始查询" });
		empty.createEl("p", {
			text: "当前会话暂无查询记录。",
		});
	}

	async renderMessage(parent: HTMLElement, message: PersistedQueryMessage): Promise<void> {
		const article = parent.createEl("article", {
			cls: `query-wiki-message is-${message.role} is-${message.status || "done"}`,
			attr: { "data-message-id": message.id },
		});
		const heading = article.createDiv({ cls: "query-wiki-message-heading" });
		const identity = heading.createDiv({ cls: "query-wiki-message-identity" });
		const icon = identity.createSpan({ cls: "query-wiki-message-icon" });
		setIcon(icon, message.role === "user" ? "user" : "library-big");
		identity.createSpan({ text: message.role === "user" ? "你" : "检索助手" });
		if (message.role === "assistant" && message.retrievalMode) {
			identity.createSpan({
				cls: `query-wiki-message-mode is-${message.retrievalMode}`,
				text: message.retrievalMode === "web" ? "联网" : "知识库",
			});
		}
		if (message.role === "assistant" && message.queryBackendId) {
			const cliBackend = isCliBackendId(message.queryBackendId);
			const backendLabel = cliBackend
				? getCliBackendLabel(message.queryBackendId)
				: message.providerName || "Direct API";
			identity.createSpan({
				cls: `query-wiki-message-backend ${
					message.queryBackendId === "claude-code"
						? "is-claude"
						: message.queryBackendId === "opencode"
							? "is-opencode"
						: message.queryBackendId === "codex-cli"
							? "is-codex"
							: "is-direct"
				}`,
				text: backendLabel,
				attr: {
					title: message.model
						? `${backendLabel} · ${message.model}`
						: message.queryBackendId,
				},
			});
		}
		if (message.role === "assistant" && message.retrievalTrace?.retrieval_label) {
			identity.createSpan({
				cls: "query-wiki-message-retrieval",
				text: String(message.retrievalTrace.retrieval_label),
				attr: { title: `检索路径：${this.displayRetrievalStage(message.retrievalTrace.stage)}` },
			});
		}
		const messageTools = heading.createDiv({ cls: "query-wiki-message-tools" });
		messageTools.createSpan({
			cls: "query-wiki-message-time",
			text: this.formatTime(message.createdAt),
		});
		if (message.content) {
			const copyButton = messageTools.createEl("button", {
				cls: "query-wiki-message-copy",
				attr: {
					type: "button",
					title: "复制本条内容",
					"aria-label": "复制本条内容",
				},
			});
			setIcon(copyButton, "copy");
			copyButton.addEventListener("click", async () => {
				try {
					await navigator.clipboard.writeText(String(message.content || ""));
					setIcon(copyButton, "check");
					copyButton.title = "已复制";
					window.setTimeout(() => {
						if (!copyButton.isConnected) return;
						setIcon(copyButton, "copy");
						copyButton.title = "复制本条内容";
					}, 1400);
				} catch (error) {
					new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
				}
			});
			if (message.role === "assistant" && message.status === "done") {
				const noteButton = messageTools.createEl("button", {
					cls: "query-wiki-message-copy query-wiki-message-note",
					attr: {
						type: "button",
						title: "落为笔记：保存为 Markdown 笔记",
						"aria-label": "将本回答保存为笔记",
					},
				});
				setIcon(noteButton, "notebook-pen");
				noteButton.addEventListener("click", async () => {
					noteButton.disabled = true;
					try {
						const savedPath = await this.plugin.saveQueryAnswerNote(
							this.session.id,
							message.id,
						);
						setIcon(noteButton, "check");
						noteButton.title = "已保存笔记";
						new Notice(`已保存笔记：${savedPath}`);
					} catch (error) {
						new Notice(`落笔记失败：${error instanceof Error ? error.message : String(error)}`);
					} finally {
						window.setTimeout(() => {
							if (!noteButton.isConnected) return;
							noteButton.disabled = false;
							setIcon(noteButton, "notebook-pen");
							noteButton.title = "落为笔记：保存为 Markdown 笔记";
						}, 1600);
					}
				});
			}
		}
		const body = article.createDiv({ cls: "query-wiki-message-body" });
		if (message.role === "user") {
			body.createEl("p", { text: message.content });
			this.renderMessageImages(body, message.attachments);
			return;
		}
		if (["pending", "stopping"].includes(message.status)) {
			const progress = body.createDiv({ cls: "query-wiki-progress" });
			progress.createSpan({ cls: "query-wiki-progress-indicator" });
			this.statusEl = progress.createSpan({
				text: message.progress || (message.status === "stopping" ? "正在停止任务" : "正在准备检索"),
			});
			if (message.content) {
				body.createEl("div", {
					cls: "query-wiki-stream-content",
					text: message.content,
				});
			}
		} else if (message.status === "failed" || message.status === "interrupted") {
			body.createEl("p", {
				cls: "query-wiki-error",
				text: message.error || "本轮查询未完成。",
			});
		} else if (message.content) {
			const markdown = body.createDiv({ cls: "query-wiki-markdown markdown-rendered" });
			await MarkdownRenderer.render(this.app, message.content, markdown, "", this);
		}
		if (
			(message.vaultSources && message.vaultSources.length)
			|| (message.webSources && message.webSources.length)
			|| message.citationValidation?.warnings?.length
		) {
			this.renderSourcePanel(article, message);
		}
		if (message.retrievalTrace) {
			this.renderRetrievalTrace(article, message.retrievalTrace);
		}
	}

	renderMessageImages(parent: HTMLElement, attachments: unknown): void {
		const images = normalizeVaultImageAttachments(attachments);
		if (!images.length) return;
		const gallery = parent.createDiv({ cls: "query-wiki-message-images" });
		for (const image of images) {
			const file = this.app.vault.getAbstractFileByPath(image.path);
			const figure = gallery.createEl("figure", { cls: "query-wiki-message-image" });
			if (file instanceof TFile) {
				figure.createEl("img", {
					attr: {
						src: this.app.vault.getResourcePath(file),
						alt: image.name,
					},
				});
			}
			figure.createEl("figcaption", {
				text: file
					? image.sourceNotePath
						? `${image.path} · 来自 ${image.sourceNotePath}`
						: image.path
					: `${image.path}（文件已不可用）`,
			});
		}
	}

	renderRetrievalTrace(parent: HTMLElement, trace: RetrievalTrace): void {
		const seeds = Array.isArray(trace.lexical_seeds) ? trace.lexical_seeds : [];
		const graph = Array.isArray(trace.graph_expansion) ? trace.graph_expansion : [];
		const fallback = trace.fallback && typeof trace.fallback === "object"
			? trace.fallback
			: { used: false, paths: [] };
		const details = parent.createEl("details", { cls: "query-wiki-trace" });
		const summary = details.createEl("summary");
		const summaryIcon = summary.createSpan({ cls: "query-wiki-trace-icon" });
		setIcon(summaryIcon, "git-fork");
		summary.createSpan({
			text: fallback.used
				? `本轮检索 · ${trace.retrieval_label || "索引回退"}`
				: `本轮检索 · ${trace.retrieval_label || "图扩展"} · ${seeds.length} 个种子 / ${graph.length} 个关联页`,
		});
		const content = details.createDiv({ cls: "query-wiki-trace-content" });
		content.createEl("p", {
			cls: "query-wiki-trace-stage",
			text: `检索阶段：${this.displayRetrievalStage(trace.stage)}`,
		});
		const lexicalTerms = Array.isArray(trace.lexical_terms) ? trace.lexical_terms : [];
		if (lexicalTerms.length) {
			content.createEl("p", {
				cls: "query-wiki-trace-note",
				text: `查询词：${lexicalTerms.slice(0, 12).map((item) => String(item)).join("、")}`,
			});
		}
		if (seeds.length) this.renderTraceGroup(content, "词法种子", seeds);
		const expandedTerms = Array.isArray(trace.keyword_expansion?.terms)
			? trace.keyword_expansion.terms
			: [];
		if (expandedTerms.length) {
			content.createEl("p", {
				cls: "query-wiki-trace-note",
				text: `关键词扩展：${expandedTerms.join("、")}`,
			});
		} else if (trace.keyword_expansion?.attempted && trace.keyword_expansion?.error) {
			content.createEl("p", {
				cls: "query-wiki-trace-note",
				text: `关键词扩展未采用：${trace.keyword_expansion.error}`,
			});
		}
		if (graph.length) this.renderTraceGroup(content, "PPR 关联页", graph);
		const contextPages = Array.isArray(trace.context_pages) ? trace.context_pages : [];
		if (contextPages.length) {
			this.renderTraceGroup(
				content,
				"送入模型的页面",
				contextPages.map((item) => ({
					path: item,
					title: item.replace(/\.md$/i, ""),
				})),
			);
		}
		if (fallback.used) {
			content.createEl("p", {
				cls: "query-wiki-trace-note",
				text: "未找到可靠词法种子，已回退到方向索引。",
			});
			this.renderTraceGroup(
				content,
				"回退索引",
				(fallback.paths || []).map((item) => ({ path: item, title: item.replace(/\.md$/i, "") })),
			);
		}
		const retrieverFallback = trace.retriever_fallback;
		if (retrieverFallback?.used) {
			const reason = String(retrieverFallback.reason || "");
			content.createEl("p", {
				cls: "query-wiki-trace-note",
				text: `检索器回退：${this.displayRetrieverName(retrieverFallback.from)} → ${this.displayRetrieverName(retrieverFallback.to)}${reason ? `（${reason}）` : ""}`,
			});
		} else if (trace.retriever?.reason) {
			content.createEl("p", {
				cls: "query-wiki-trace-note",
				text: `检索器：${this.displayRetrieverName(trace.retriever.selected)}（${String(trace.retriever.reason)}）`,
			});
		}
		content.createEl("p", {
			cls: "query-wiki-trace-note",
			text: "这些页面是候选路由；实际采用的证据以回答中的“检索路径”和引用为准。",
		});
	}

	renderTraceGroup(
		parent: HTMLElement,
		title: string,
		candidates: TraceCandidate[],
	): void {
		const group = parent.createDiv({ cls: "query-wiki-trace-group" });
		group.createEl("h3", { text: title });
		const list = group.createDiv({ cls: "query-wiki-trace-list" });
		candidates.slice(0, 8).forEach((candidate) => {
			const pathValue = String(candidate.path || "");
			const label = candidate.title_zh || candidate.title || pathValue.replace(/\.md$/i, "");
			const button = list.createEl("button", {
				cls: "query-wiki-trace-link",
				text: label,
				attr: { type: "button", title: pathValue },
			});
			button.disabled = !pathValue;
			button.addEventListener("click", () => {
				void this.app.workspace.openLinkText(pathValue, "", true);
			});
		});
	}

	normalizeVaultSourceEntries(values: unknown): QueryVaultSource[] {
		return normalizeQueryVaultSources(values, {
			resolveVaultPath: makeVaultSourcePathResolver(this.app),
		});
	}

	renderSourcePanel(parent: HTMLElement, message: PersistedQueryMessage): void {
		const vaultSources = this.normalizeVaultSourceEntries(message.vaultSources);
		const webSources = normalizeQueryWebSources(message.webSources);
		const validation = normalizeQueryCitationValidation(message.citationValidation);
		const details = parent.createEl("details", { cls: "query-wiki-sources" });
		details.open = webSources.length > 0;
		const summary = details.createEl("summary");
		const summaryIcon = summary.createSpan({ cls: "query-wiki-sources-icon" });
		setIcon(summaryIcon, webSources.length ? "globe-2" : "library-big");
		const summaryParts: string[] = [];
		if (vaultSources.length) summaryParts.push(`${vaultSources.length} 个知识库页面`);
		if (webSources.length) summaryParts.push(`${webSources.length} 个联网来源`);
		summary.createSpan({
			text: `证据来源 · ${summaryParts.join(" / ") || "校验提示"}`,
		});
		const validationLabel = {
			verified: "事件已核验",
			structured: "结构已核验",
			unverified: "来源未核验",
			partial: "部分通过",
			invalid: "结构异常",
			"not-applicable": "",
		}[validation.status];
		if (validationLabel) {
			summary.createSpan({
				cls: `query-wiki-validation is-${validation.status}`,
				text: validationLabel,
			});
		}
		const content = details.createDiv({ cls: "query-wiki-sources-content" });
		if (vaultSources.length) {
			const group = content.createDiv({ cls: "query-wiki-source-group" });
			group.createEl("h3", { text: "知识库证据" });
			const list = group.createDiv({ cls: "query-wiki-source-list" });
			vaultSources.forEach((source) => {
				const button = list.createEl("button", {
					cls: "query-wiki-source-item is-vault",
					attr: { type: "button", title: source.path },
				});
				const icon = button.createSpan({ cls: "query-wiki-source-icon" });
				setIcon(icon, "file-text");
				const text = button.createSpan({ cls: "query-wiki-source-text" });
				text.createEl("strong", { text: source.title || source.path });
				text.createEl("span", { text: source.path });
				const badge = button.createSpan({
					cls: `query-wiki-source-badge ${source.cited ? "is-verified" : "is-structured"}`,
					text: source.cited ? "正文引用" : "未引用",
				});
				badge.title = source.cited
					? "该页面以 Obsidian wikilink 出现在回答正文中"
					: "该页面列入结构化来源，但正文没有对应 wikilink";
				button.addEventListener("click", () => {
					void this.app.workspace.openLinkText(source.path, "", true);
				});
			});
		}
		if (webSources.length) {
			const group = content.createDiv({ cls: "query-wiki-source-group" });
			group.createEl("h3", { text: "联网来源" });
			const list = group.createDiv({ cls: "query-wiki-source-list" });
			webSources.forEach((source, index) => {
				const link = list.createEl("a", {
					cls: "query-wiki-source-item is-web",
					href: source.url,
					attr: {
						target: "_blank",
						rel: "noopener noreferrer",
						title: source.url,
					},
				});
				link.createSpan({ cls: "query-wiki-source-number", text: String(index + 1) });
				const text = link.createSpan({ cls: "query-wiki-source-text" });
				text.createEl("strong", { text: source.title || source.domain });
				const metadata = [
					source.publisher || source.domain,
					source.publishedAt,
				].filter(Boolean).join(" · ");
				text.createEl("span", { text: metadata || source.domain });
				const verification = source.eventVerified
					? {
						className: "is-verified",
						label: "事件核验",
						title: "该 URL 出现在本轮 Codex Web Search JSONL 事件中",
					}
					: source.verification === "model"
						? {
							className: "is-unverified",
							label: "模型提供",
							title: "该 URL 仅来自模型回答正文；供应商协议没有返回可独立核验的搜索来源",
						}
						: {
							className: "is-structured",
							label: "结构核验",
							title: "该 URL 已通过结构与正文引用一致性校验，但 JSONL 未提供来源事件佐证",
						};
				const badge = link.createSpan({
					cls: `query-wiki-source-badge ${verification.className}`,
					text: verification.label,
				});
				badge.title = verification.title;
			});
		}
		if (validation.warnings.length) {
			const warning = content.createDiv({ cls: "query-wiki-source-warnings" });
			const icon = warning.createSpan({ cls: "query-wiki-source-warning-icon" });
			setIcon(icon, "triangle-alert");
			const list = warning.createEl("ul");
			validation.warnings.forEach((item) => list.createEl("li", { text: item }));
		}
		if (message.retrievalPath?.webQueries?.length) {
			content.createEl("p", {
				cls: "query-wiki-source-queries",
				text: `联网检索词：${message.retrievalPath.webQueries.join("；")}`,
			});
		}
	}

	renderComposer(parent: HTMLElement): void {
		const composer = parent.createEl("section", {
			cls: "query-wiki-composer",
			attr: { "aria-label": "知识库查询输入" },
		});
		this.renderExecutionSettings(composer);
		const input = composer.createEl("textarea", {
			cls: "query-wiki-input",
			attr: {
				rows: "4",
				placeholder: "输入问题…",
				"aria-label": "输入知识库问题",
			},
		});
		const sessionId = this.session.id;
		if (this.initialQuestion) {
			this.queryDrafts.set(sessionId, this.initialQuestion);
		}
		input.value = this.queryDrafts.get(sessionId) || "";
		this.initialQuestion = "";
		this.inputEl = input;
		this.inputSessionId = sessionId;
		input.disabled = false;
		input.readOnly = false;
		input.removeAttribute("disabled");
		input.removeAttribute("readonly");
		window.requestAnimationFrame(() => {
			if (!input.isConnected) return;
			input.style.height = "auto";
			input.style.height = `${Math.min(Math.max(input.scrollHeight, 92), 220)}px`;
		});
		if (this.pendingImages.length) {
			const previews = composer.createDiv({ cls: "query-wiki-pending-images" });
			this.pendingImages.forEach((image, index) => {
				const preview = previews.createDiv({ cls: "query-wiki-pending-image" });
				const file = this.app.vault.getAbstractFileByPath(image.path);
				if (file instanceof TFile) {
					preview.createEl("img", {
						attr: {
							src: this.app.vault.getResourcePath(file),
							alt: "",
						},
					});
				}
				const previewText = preview.createDiv({ cls: "query-wiki-pending-image-text" });
				previewText.createEl("strong", { text: image.name });
				previewText.createEl("span", {
					text: image.sourceNotePath
						? `${image.path} · 来自 ${image.sourceNotePath}`
						: image.path,
				});
				const remove = this.createIconButton(preview, "x", `移除图片 ${image.name}`);
				remove.disabled = Boolean(this.activeRunId);
				remove.addEventListener("click", () => {
					this.initialQuestion = this.inputEl?.value || "";
					this.pendingImages = this.pendingImages.filter((_, itemIndex) => itemIndex !== index);
					void this.render().then(() => this.inputEl?.focus());
				});
			});
		}
		const footer = composer.createDiv({ cls: "query-wiki-composer-footer" });
		const turnCount = this.session.messages.filter((message) => message.role === "user").length;
		const hint = footer.createSpan({
			cls: "query-wiki-shortcut",
			text: `${turnCount}/30 轮`,
		});
		const controls = footer.createDiv({ cls: "query-wiki-composer-actions" });
		this.renderRetrievalModeSwitch(controls);
		const backendId = this.plugin.resolveQueryBackendId(this.session.queryBackendId);
		const directProfile = isCliBackendId(backendId)
			? null
			: this.plugin.getProviderProfile(backendId);
		const canAttachImage = backendId === "claude-code"
			|| profileSupportsQueryImage(directProfile);
		const attach = this.createIconButton(
			controls,
			"image-plus",
			this.pendingImages.length ? "继续添加 Vault 图片" : "附加 Vault 图片",
		);
		attach.addClass("query-wiki-attach");
		attach.disabled = Boolean(this.activeRunId)
			|| !canAttachImage
			|| this.pendingImages.length >= MAX_QUERY_IMAGE_ATTACHMENTS;
		attach.title = canAttachImage
			? this.pendingImages.length >= MAX_QUERY_IMAGE_ATTACHMENTS
				? `最多附加 ${MAX_QUERY_IMAGE_ATTACHMENTS} 张图片`
				: `附加 Vault 图片（${this.pendingImages.length}/${MAX_QUERY_IMAGE_ATTACHMENTS}）`
			: directProfile
				? "当前 Direct API 配置或适配器未启用视觉输入"
				: "当前 CLI 后端未启用视觉输入";
		attach.addEventListener("click", () => {
			if (attach.disabled) return;
			const draft = this.inputEl?.value || "";
			new VaultImagePickerModal(this.app, this.plugin, (image) => {
				this.initialQuestion = draft;
				this.pendingImages = normalizeVaultImageAttachments([
					...this.pendingImages,
					image,
				]);
				void this.render().then(() => this.inputEl?.focus());
			}, this.pendingImages).open();
		});
		const stop = this.createIconButton(controls, "square", "停止生成");
		stop.addClass("query-wiki-stop");
		stop.disabled = !this.activeRunId || this.activeRunId === "starting" || this.stopRequested;
		stop.addEventListener("click", () => this.stopQuery());
		const send = controls.createEl("button", {
			cls: "query-wiki-send mod-cta",
			attr: { type: "button", "aria-label": "发送问题" },
		});
		setIcon(send, "arrow-up");
		send.createSpan({ text: "发送" });
		send.disabled = Boolean(this.activeRunId) || !input.value.trim();
		const submit = () => {
			if (send.disabled) return;
			void this.submitQuestion(input.value.trim());
		};
		input.addEventListener("input", () => {
			this.queryDrafts.set(sessionId, input.value);
			send.disabled = Boolean(this.activeRunId) || !input.value.trim();
			input.style.height = "auto";
			input.style.height = `${Math.min(Math.max(input.scrollHeight, 92), 220)}px`;
		});
		input.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				submit();
			}
		});
		input.addEventListener("keyup", (event) => event.stopPropagation());
		send.addEventListener("click", submit);
		if (this.activeRunId) hint.setText("查询运行中，可先输入下一问题");
	}

	renderRetrievalModeSwitch(parent: HTMLElement): void {
		const currentMode = this.session.retrievalMode === "vault" ? "vault" : "web";
		const control = parent.createDiv({
			cls: "query-wiki-mode-switch",
			attr: { role: "radiogroup", "aria-label": "查询证据范围" },
		});
		[
			["vault", "database", "知识库", "仅使用当前知识库中的证据"],
			["web", "globe-2", "联网搜索", "综合知识库证据与实时联网来源"],
		].forEach(([value, iconName, label, title]) => {
			const button = control.createEl("button", {
				cls: value === currentMode ? "query-wiki-mode-option is-active" : "query-wiki-mode-option",
				attr: {
					type: "button",
					role: "radio",
					title,
					"aria-checked": value === currentMode ? "true" : "false",
				},
			});
			const icon = button.createSpan({ cls: "query-wiki-mode-icon" });
			setIcon(icon, iconName);
			button.createSpan({ text: label });
			button.disabled = Boolean(this.activeRunId);
			button.addEventListener("click", async () => {
				if (button.disabled || value === currentMode) return;
				this.initialQuestion = this.inputEl?.value || "";
				const activeBackendId = this.plugin.resolveQueryBackendId(this.session.queryBackendId);
				if (
					value === "web"
					&& !isCliBackendId(activeBackendId)
					&& !this.plugin.directProfileSupportsWebSearch(activeBackendId)
				) {
					if (this.pendingImages.length) this.pendingImages = [];
					await this.plugin.setActiveQueryBackend("codex-cli");
					new Notice(
						"该 Direct API 供应商未启用联网搜索；已切换到 Codex CLI",
					);
				}
				await this.plugin.setActiveQueryMode(value);
				await this.render();
				this.inputEl?.focus();
			});
		});
	}

	renderExecutionSettings(parent: HTMLElement): void {
		const action = ACTION_BY_ID.get("vault-retrieval");
		if (!action) return;
		const directProfiles = this.plugin.getVerifiedProviderProfiles();
		const backendId = this.plugin.resolveQueryBackendId(this.session.queryBackendId);
		const directProfile = isCliBackendId(backendId)
			? null
			: directProfiles.find((profile) => profile.id === backendId) || null;
		const codexOverrides = this.executionOverridesByBackend["codex-cli"];
		const claudeOverrides = this.executionOverridesByBackend["claude-code"];
		const openCodeOverrides = this.executionOverridesByBackend["opencode"];
		let codexDiscovery = this.plugin.getCliModelDiscovery("codex-cli");
		let claudeDiscovery = this.plugin.getCliModelDiscovery("claude-code");
		let openCodeDiscovery = this.plugin.getCliModelDiscovery("opencode");
		const effective = this.plugin.resolveActionExecutionConfig(action, codexOverrides);
		const claudeEffective = this.plugin.resolveCliActionExecutionConfig(
			action,
			"claude-code",
			claudeOverrides,
		);
		const openCodeEffective = this.plugin.resolveCliActionExecutionConfig(
			action,
			"opencode",
			openCodeOverrides,
		);
		const claudeSourceLabel = getClaudeConfigSourceLabel(
			this.plugin.settings.claudeConfigSource,
		);
		const claudeDefaultModelLabel = getClaudeDefaultModelLabel(
			this.plugin.settings.claudeConfigSource,
		);
		const openCodeSourceLabel = getOpenCodeConfigSourceLabel(
			this.plugin.settings.openCodeConfigSource,
		);
		const openCodeDefaultModelLabel = getOpenCodeDefaultModelLabel(
			this.plugin.settings.openCodeConfigSource,
		);
		const codexSourceLabel = getCodexConfigSourceLabel(
			this.plugin.settings.codexConfigSource,
		);
		const codexDefaultModelLabel = getCodexDefaultModelLabel(
			this.plugin.settings.codexConfigSource,
		);
		const codexModelLabel = effective.model
			? this.plugin.getModelLabel(effective.model)
			: codexDefaultModelLabel;
		const codexReasoningLabel = effective.reasoningEffort
			? this.plugin.getReasoningLabel(effective.reasoningEffort)
			: "CLI 默认推理";
		const details = parent.createEl("details", { cls: "query-wiki-run-settings" });
		details.open = true;
		const summary = details.createEl("summary");
		const icon = summary.createSpan({ cls: "query-wiki-settings-icon" });
		setIcon(icon, "sliders-horizontal");
		const summaryText = summary.createSpan({
			text: directProfile
				? `Direct API · ${directProfile.name} · ${directProfile.model}`
				: backendId === "claude-code"
					? `Agent · Claude Code · ${claudeEffective.model || claudeDefaultModelLabel} · ${this.plugin.getReasoningLabel(claudeEffective.reasoningEffort || "")}`
				: backendId === "opencode"
					? `Agent · OpenCode · ${openCodeEffective.model || openCodeDefaultModelLabel} · ${this.plugin.getReasoningLabel(openCodeEffective.reasoningEffort || "")}`
				: `Agent · Codex CLI · ${codexModelLabel} · ${codexReasoningLabel} · ${
					effective.serviceTier === "fast"
						? "快速"
						: this.plugin.settings.codexConfigSource === "cc-switch"
							? "当前速度配置"
							: "标准"
				}`,
		});
		const grid = details.createDiv({ cls: "query-wiki-settings-grid" });
		const backend = this.createSelectField(grid, "执行后端");
		const agentGroup = backend.createEl("optgroup", {
			attr: { label: "Agent（知识库 / 联网）" },
		});
		agentGroup.createEl("option", {
			text: "Codex CLI",
			attr: { value: "codex-cli" },
		});
		const claudeOption = agentGroup.createEl("option", {
			text: "Claude Code · 只读",
			attr: { value: "claude-code" },
		});
		claudeOption.disabled = !this.plugin.isCliBackendAvailable("claude-code");
		const openCodeOption = agentGroup.createEl("option", {
			text: "OpenCode · 只读",
			attr: { value: "opencode" },
		});
		openCodeOption.disabled = !this.plugin.isCliBackendAvailable("opencode");
		const directGroup = backend.createEl("optgroup", {
			attr: { label: "Direct API" },
		});
		directProfiles.forEach((profile) => {
			const webCapable = this.plugin.directProfileSupportsWebSearch(profile.id);
			const option = directGroup.createEl("option", {
				text: `Direct API · ${profile.name} · ${profile.model} · ${webCapable ? "知识库+联网" : "知识库"}`,
				attr: {
					value: profile.id,
					title: webCapable
						? "知识库问答与联网搜索均可用"
						: "仅知识库问答；联网需在设置中启用原生联网或配置 Tavily",
				},
			});
			option.disabled = this.session.retrievalMode === "web" && !webCapable;
		});
		backend.value = backendId;
		const model = this.createSelectField(grid, "模型");
		const reasoning = this.createSelectField(grid, "推理强度");
		reasoning.createEl("option", { text: "使用检索默认", attr: { value: "" } });
		REASONING_OPTIONS.forEach((option) => {
			reasoning.createEl("option", { text: option.label, attr: { value: option.id } });
		});
		reasoning.value = codexOverrides.reasoningEffort;
		const speed = this.createSelectField(grid, "速度");
		speed.createEl("option", {
			text: this.plugin.settings.codexConfigSource === "cc-switch"
				? "使用当前配置"
				: "标准",
			attr: { value: "default" },
		});
		speed.createEl("option", { text: "快速", attr: { value: "fast" } });
		speed.value = codexOverrides.serviceTier;
		const claudeModel = this.createSelectField(grid, "模型");
		const claudeReasoning = this.createSelectField(grid, "推理强度");
		claudeReasoning.createEl("option", {
			text: "使用 Claude 默认",
			attr: { value: "" },
		});
		REASONING_OPTIONS.forEach((option) => {
			claudeReasoning.createEl("option", {
				text: option.label,
				attr: { value: option.id },
			});
		});
		claudeReasoning.value = claudeOverrides.reasoningEffort;
		const openCodeModel = this.createSelectField(grid, "模型");
		const openCodeReasoning = this.createSelectField(grid, "推理强度");
		openCodeReasoning.createEl("option", {
			text: "使用 OpenCode 默认",
			attr: { value: "" },
		});
		REASONING_OPTIONS.forEach((option) => {
			openCodeReasoning.createEl("option", {
				text: option.label,
				attr: { value: option.id },
			});
		});
		openCodeReasoning.value = openCodeOverrides.reasoningEffort;
		const modelStatus = details.createDiv({ cls: "query-wiki-cli-model-status" });
		const backendNotice = details.createDiv({ cls: "query-wiki-direct-notice" });
		const populateModelSelect = (
			select: HTMLSelectElement,
			defaultLabel: string,
			discovery: CliModelDiscoveryResult | null,
			selectedValue: string,
		): void => {
			select.replaceChildren();
			select.createEl("option", {
				text: defaultLabel,
				attr: { value: "" },
			});
			const models = discovery?.models || (
				select === model
					? MODEL_OPTIONS.map((option) => ({
						id: option.id,
						label: option.label,
						description: option.description,
						supportsFast: option.supportsFast,
					}))
					: []
			);
			models.forEach((option) => {
				select.createEl("option", {
					text: option.description
						? `${option.label} · ${option.description}`
						: option.label,
					attr: { value: option.id },
				});
			});
			if (
				selectedValue
				&& !models.some((option) => option.id === selectedValue)
			) {
				select.createEl("option", {
					text: `${selectedValue} · 已保存的自定义模型`,
					attr: { value: selectedValue },
				});
			}
			select.value = selectedValue;
		};
		const renderCodexModels = (): void => {
			const defaultModel = this.plugin.resolveActionExecutionConfig(action).model;
			populateModelSelect(
				model,
				`使用检索默认 · ${defaultModel
					? this.plugin.getModelLabel(defaultModel)
					: codexDefaultModelLabel}`,
				codexDiscovery,
				codexOverrides.model,
			);
		};
		const renderClaudeModels = (): void => {
			const detectedModel = claudeDiscovery?.effectiveModel
				|| claudeEffective.model
				|| claudeDefaultModelLabel;
			populateModelSelect(
				claudeModel,
				`使用后端默认 · ${detectedModel}`,
				claudeDiscovery,
				claudeOverrides.model,
			);
		};
		const renderOpenCodeModels = (): void => {
			const detectedModel = openCodeDiscovery?.effectiveModel
				|| openCodeEffective.model
				|| openCodeDefaultModelLabel;
			populateModelSelect(
				openCodeModel,
				`使用后端默认 · ${detectedModel}`,
				openCodeDiscovery,
				openCodeOverrides.model,
			);
		};
		renderCodexModels();
		renderClaudeModels();
		renderOpenCodeModels();
		const sync = () => {
			const selectedProfile = directProfiles.find((profile) => profile.id === backend.value) || null;
			const usingDirect = Boolean(selectedProfile);
			const usingClaude = backend.value === "claude-code";
			const usingOpenCode = backend.value === "opencode";
			const usingAlternateCli = usingClaude || usingOpenCode;
			if (model.parentElement) model.parentElement.hidden = usingDirect || usingAlternateCli;
			if (reasoning.parentElement) reasoning.parentElement.hidden = usingDirect || usingAlternateCli;
			if (speed.parentElement) speed.parentElement.hidden = usingDirect || usingAlternateCli;
			if (claudeModel.parentElement) claudeModel.parentElement.hidden = !usingClaude;
			if (claudeReasoning.parentElement) claudeReasoning.parentElement.hidden = !usingClaude;
			if (openCodeModel.parentElement) openCodeModel.parentElement.hidden = !usingOpenCode;
			if (openCodeReasoning.parentElement) openCodeReasoning.parentElement.hidden = !usingOpenCode;
			modelStatus.hidden = usingDirect;
			const activeDiscovery = usingClaude
				? claudeDiscovery
				: usingOpenCode
					? openCodeDiscovery
					: codexDiscovery;
			modelStatus.setText(
				activeDiscovery
					? `模型来源：${activeDiscovery.source} · 可识别 ${activeDiscovery.models.length} 个模型${
						activeDiscovery.complete ? "" : "（候选列表可能不完整）"
					}${activeDiscovery.message ? `。${activeDiscovery.message}` : ""}`
					: "正在识别当前后端的可用模型…",
			);
			backendNotice.toggleClass("is-visible", usingDirect || usingAlternateCli);
			backendNotice.setText(
				selectedProfile
					? [
						`将筛选后的知识库候选笔记发送至 ${selectedProfile.name}（${selectedProfile.model}）。`,
						profileSupportsQueryImage(selectedProfile)
							? `可附加最多 ${MAX_QUERY_IMAGE_ATTACHMENTS} 张 Vault 图片，并自动识别问题中的笔记链接。`
							: "当前适配器未启用视觉输入。",
						this.session.retrievalMode === "web"
							? "Direct API 通过供应商原生联网或 Tavily 检索公开网络来源，回答需引用 [n] 来源；不执行 Skill、不调用工具、不写入文件。"
							: "Direct API 仅使用插件筛选出的 Vault 证据，不联网、不执行 Skill、不调用工具，也不写入文件。",
					].join("")
					: usingClaude
						? `Claude Code 使用 ${claudeSourceLabel} 和 plan 权限模式。知识库模式只开放 Read、Glob 和 Grep；联网搜索模式额外开放 WebSearch 和 WebFetch。可附加最多 ${MAX_QUERY_IMAGE_ATTACHMENTS} 张 Vault 图片，图片由 Read 工具按本地路径读取；两种模式都不开放文件写入。视觉与联网结果取决于当前模型及账号能力。`
						: usingOpenCode
							? `OpenCode 使用${openCodeSourceLabel}。知识库模式仅开放 read、glob、grep 和 list；联网搜索模式额外开放 websearch/webfetch。Shell、编辑和外部目录访问均禁用；首版不向 OpenCode 发送图片附件。`
						: `Codex CLI 使用${codexSourceLabel}。知识库模式使用只读沙箱；联网搜索模式启用 Codex 原生 Web Search。`,
			);
			if (selectedProfile) {
				summaryText.setText(`Direct API · ${selectedProfile.name} · ${selectedProfile.model}`);
				return;
			}
			if (usingClaude) {
				claudeOverrides.model = claudeModel.value;
				claudeOverrides.reasoningEffort = claudeReasoning.value;
				claudeOverrides.serviceTier = "default";
				const next = this.plugin.resolveCliActionExecutionConfig(
					action,
					"claude-code",
					claudeOverrides,
				);
				summaryText.setText(
					`Agent · Claude Code · ${next.model || claudeDiscovery?.effectiveModel || claudeDefaultModelLabel} · ${this.plugin.getReasoningLabel(next.reasoningEffort || "")}`,
				);
				return;
			}
			if (usingOpenCode) {
				openCodeOverrides.model = openCodeModel.value;
				openCodeOverrides.reasoningEffort = openCodeReasoning.value;
				openCodeOverrides.serviceTier = "default";
				const next = this.plugin.resolveCliActionExecutionConfig(
					action,
					"opencode",
					openCodeOverrides,
				);
				summaryText.setText(
					`Agent · OpenCode · ${next.model || openCodeDiscovery?.effectiveModel || openCodeDefaultModelLabel} · ${this.plugin.getReasoningLabel(next.reasoningEffort || "")}`,
				);
				return;
			}
			const selectedModel = model.value || this.plugin.resolveActionExecutionConfig(action).model;
			if (!this.plugin.supportsFast(selectedModel) && speed.value === "fast") speed.value = "default";
			const fastOption = speed.querySelector<HTMLOptionElement>('option[value="fast"]');
			if (fastOption) fastOption.disabled = !this.plugin.supportsFast(selectedModel);
			codexOverrides.model = model.value;
			codexOverrides.reasoningEffort = reasoning.value;
			codexOverrides.serviceTier = speed.value === "fast" ? "fast" : "default";
			const next = this.plugin.resolveActionExecutionConfig(
				action,
				codexOverrides,
			);
			summaryText.setText(
				`Agent · Codex CLI · ${next.model ? this.plugin.getModelLabel(next.model) : codexDefaultModelLabel} · ${
					next.reasoningEffort ? this.plugin.getReasoningLabel(next.reasoningEffort) : "CLI 默认推理"
				} · ${next.serviceTier === "fast"
					? "快速"
					: this.plugin.settings.codexConfigSource === "cc-switch"
						? "当前速度配置"
						: "标准"}`,
			);
		};
		backend.addEventListener("change", async () => {
			this.initialQuestion = this.inputEl?.value || "";
			const selectedProfile = directProfiles.find((profile) => profile.id === backend.value) || null;
			if (isCliBackendId(backend.value)) {
				this.plugin.invalidateCliModelDiscovery(backend.value);
			}
			const selectedSupportsImages = backend.value === "claude-code"
				|| profileSupportsQueryImage(selectedProfile);
			if (this.pendingImages.length && !selectedSupportsImages) {
				this.pendingImages = [];
				new Notice("所选后端未启用视觉输入，已移除待发送图片");
			}
			await this.plugin.setActiveQueryBackend(backend.value);
			await this.render();
			this.inputEl?.focus();
		});
		model.addEventListener("change", sync);
		reasoning.addEventListener("change", sync);
		speed.addEventListener("change", sync);
		claudeModel.addEventListener("change", sync);
		claudeReasoning.addEventListener("change", sync);
		openCodeModel.addEventListener("change", sync);
		openCodeReasoning.addEventListener("change", sync);
		sync();
		if (isCliBackendId(backendId)) {
			void this.plugin.discoverCliModels(backendId)
				.then((discovery) => {
					if (backend.value !== backendId) return;
					if (backendId === "claude-code") {
						claudeDiscovery = discovery;
						renderClaudeModels();
					} else if (backendId === "opencode") {
						openCodeDiscovery = discovery;
						renderOpenCodeModels();
					} else {
						codexDiscovery = discovery;
						renderCodexModels();
					}
					sync();
				})
				.catch((error) => {
					if (backend.value !== backendId) return;
					modelStatus.setText(`模型识别失败：${String(error)}`);
				});
		}
	}

	createSelectField(parent: HTMLElement, labelText: string): HTMLSelectElement {
		const label = parent.createEl("label", { cls: "query-wiki-settings-field" });
		label.createSpan({ text: labelText });
		return label.createEl("select");
	}

	createIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "query-wiki-icon-button",
			attr: { type: "button", title: label, "aria-label": label },
		});
		setIcon(button, icon);
		return button;
	}

	async submitQuestion(question: string): Promise<void> {
		if (!question || this.activeRunId || this.plugin.isActionRunning("vault-retrieval")) return;
		const action = ACTION_BY_ID.get("vault-retrieval");
		if (!action) {
			new Notice("知识库检索操作未注册");
			return;
		}
		const session = this.session;
		const backendId = this.plugin.resolveQueryBackendId(session.queryBackendId);
		const directProfile = isCliBackendId(backendId)
			? null
			: this.plugin.getProviderProfile(backendId);
		if (!isCliBackendId(backendId) && !directProfile) {
			new Notice("所选 Direct API 配置不可用，请重新选择执行后端");
			return;
		}
		const selectedImages = normalizeVaultImageAttachments(this.pendingImages);
		const backendSupportsImages = backendId === "claude-code"
			|| profileSupportsQueryImage(directProfile);
		if (selectedImages.length && !backendSupportsImages) {
			new Notice("当前执行后端未启用视觉输入，无法发送图片");
			return;
		}
		let linkedImageResult: QuestionImageResolution = {
			attachments: [],
			notePaths: [],
			discoveredCount: 0,
			totalBytes: 0,
		};
		if (backendSupportsImages) {
			try {
				linkedImageResult = await this.plugin.resolveQuestionImageAttachments(question, selectedImages);
			} catch (error) {
				new Notice(
					`未能解析链接笔记中的图片，将继续使用手动附件：${error instanceof Error ? error.message : String(error)}`,
					8000,
				);
			}
		}
		const attachments = normalizeVaultImageAttachments([
			...selectedImages,
			...linkedImageResult.attachments,
		]);
		if (linkedImageResult.discoveredCount > 0) {
			const addedCount = attachments.filter((attachment) => attachment.sourceNotePath).length;
			new Notice(
				linkedImageResult.discoveredCount > addedCount
					? `从链接笔记发现 ${linkedImageResult.discoveredCount} 张图片，本轮按限制附加 ${addedCount} 张`
					: `已从链接笔记附加 ${addedCount} 张图片`,
			);
		}
		const retrievalMode: QueryRetrievalMode = session.retrievalMode === "web"
			&& isCliBackendId(backendId)
			? "web"
			: "vault";
		const priorMessages = session.messages.filter((message) => message.status === "done");
		const now = new Date().toISOString();
		const userMessage: PersistedQueryMessage = {
			id: this.plugin.createQueryMessageId(),
			role: "user",
			content: question,
			attachments,
			status: "done",
			createdAt: now,
			retrievalMode,
		};
		const assistantMessage: PersistedQueryMessage = {
			id: this.plugin.createQueryMessageId(),
			role: "assistant",
			content: "",
			status: "pending",
			progress: "正在准备检索",
			createdAt: new Date(Date.now() + 1).toISOString(),
			runId: "",
			retrievalTrace: null,
			vaultSources: [],
			webSources: [],
			citationValidation: normalizeQueryCitationValidation(null),
			retrievalPath: normalizeQueryRetrievalPath(null),
			error: "",
			retrievalMode,
			queryBackendId: backendId,
			providerName: directProfile?.name || getCliBackendLabel(backendId),
			model: directProfile?.model || (
				backendId === "claude-code"
					? this.plugin.resolveCliActionExecutionConfig(
						action,
						"claude-code",
						this.executionOverridesByBackend["claude-code"],
						).model
						|| this.plugin.getCliModelDiscovery("claude-code")?.effectiveModel
						|| getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)
					: backendId === "opencode"
						? this.plugin.resolveCliActionExecutionConfig(
							action,
							"opencode",
							this.executionOverridesByBackend["opencode"],
						).model
							|| this.plugin.getCliModelDiscovery("opencode")?.effectiveModel
							|| getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)
					: ""
			),
		};
		this.activeRunId = "starting";
		this.activeMessageId = assistantMessage.id;
		this.stopRequested = false;
		const executionConfig: ExecutionConfig = directProfile
			? this.plugin.resolveDirectQueryExecutionConfig(directProfile)
			: backendId === "claude-code"
				? this.plugin.resolveCliActionExecutionConfig(
					action,
					"claude-code",
					this.executionOverridesByBackend["claude-code"],
				)
			: backendId === "opencode"
				? this.plugin.resolveCliActionExecutionConfig(
					action,
					"opencode",
					this.executionOverridesByBackend["opencode"],
				)
			: {
				backend: "codex-cli" as const,
				...this.plugin.resolveActionExecutionConfig(
					action,
					this.executionOverridesByBackend["codex-cli"],
				),
			};
		assistantMessage.model = executionConfig.model;
		const input = this.plugin.buildQueryActionInput(
			question,
			priorMessages,
			retrievalMode,
			attachments,
		);
		let run = null;
		let completedRun = null;
		try {
			await this.plugin.appendQueryMessages(session.id, [userMessage, assistantMessage], question);
			this.queryDrafts.delete(session.id);
			if (this.inputEl?.isConnected) this.inputEl.value = "";
			this.pendingImages = [];
			await this.render({ scrollToBottom: true });
			run = await this.plugin.startTaskRun(action, question.slice(0, 160), executionConfig);
			this.activeRunId = run.id;
			await this.plugin.updateQueryMessage(session.id, assistantMessage.id, { runId: run.id });
			await this.render({ scrollToBottom: true });
			const hooks: QueryRunnerHooks = {
				onEvent: (event: DashboardProcessEvent) => {
					this.handleRunnerEvent(session.id, assistantMessage.id, event);
				},
			};
			const result = directProfile
				? await this.plugin.runDirectVaultQuery(
					run.id,
					directProfile.id,
					question,
					priorMessages,
					"vault",
					hooks,
					userMessage.attachments || [],
				)
				: await this.plugin.runVaultAction(
					run.id,
					action,
					input,
					executionConfig,
					hooks,
				);
			const stopped = this.stopRequested
				|| result.exitCode === 130
				|| (result.events || []).some((event) => event.type === "status" && event.stage === "stopped");
			const status = result.exitCode === 0 ? "done" : stopped ? "interrupted" : "failed";
			const resultEvent = [...(result.events || [])]
				.reverse()
				.find((event) => event.type === "retrieval-result");
			const structuredResult = resultEvent?.payload && typeof resultEvent.payload === "object"
				? resultEvent.payload
				: null;
			const response = String(structuredResult?.answer_markdown || result.stdout || "").trim();
			const error = status === "done"
				? ""
				: stopped
					? "已停止本轮查询。"
					: result.stderr.trim() || `查询进程退出码：${result.exitCode}`;
			const traceEvent = [...(result.events || [])].reverse().find((event) => event.type === "retrieval-preflight");
			await this.plugin.updateQueryMessage(session.id, assistantMessage.id, {
				status,
				content: response || (status === "done" ? "本轮查询未返回文本。" : ""),
				error,
				progress: "",
				retrievalTrace: traceEvent?.payload || assistantMessage.retrievalTrace || null,
				vaultSources: this.normalizeVaultSourceEntries(structuredResult?.vault_sources),
				webSources: normalizeQueryWebSources(structuredResult?.web_sources),
				citationValidation: normalizeQueryCitationValidation(structuredResult?.citation_validation),
				retrievalPath: normalizeQueryRetrievalPath(structuredResult?.retrieval_path),
				retrievalMode: traceEvent?.mode === "vault"
					? "vault"
					: traceEvent?.mode === "web"
						? "web"
						: retrievalMode,
				queryBackendId: backendId,
				providerName: directProfile?.name || getCliBackendLabel(backendId),
				model: executionConfig.model || (
					backendId === "claude-code"
						? getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)
						: ""
				),
			});
			const output = [
				response,
				result.stderr.trim() ? `运行日志\n${result.stderr.trim()}` : "",
			].filter(Boolean).join("\n\n").slice(0, 120000) || error;
			completedRun = await this.plugin.finishTaskRun(run.id, {
				status,
				exitCode: result.exitCode,
				output,
				error,
			});
			new Notice(status === "done" ? "知识库回答已完成" : stopped ? "知识库查询已停止" : "知识库查询失败");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const interrupted = this.stopRequested || /cancelled|canceled|已停止|正在停止/i.test(message);
			await this.plugin.updateQueryMessage(session.id, assistantMessage.id, {
				status: interrupted ? "interrupted" : "failed",
				error: interrupted ? "已停止本轮查询。" : message,
				progress: "",
			});
			if (run) {
				completedRun = await this.plugin.finishTaskRun(run.id, {
					status: interrupted ? "interrupted" : "failed",
					exitCode: null,
					output: "",
					error: message,
				});
			}
			new Notice(interrupted ? "知识库查询已停止" : `知识库查询失败：${message}`);
		} finally {
			this.activeRunId = "";
			this.activeMessageId = "";
			this.stopRequested = false;
			await this.render({ scrollToBottom: true });
			if (!completedRun) console.warn("Query run completed without a persisted task record");
		}
	}

	handleRunnerEvent(sessionId: string, messageId: string, event: DashboardProcessEvent): void {
		if (!event || typeof event !== "object") return;
		if (event.type === "retrieval-preflight") {
			const trace = (event.payload || {}) as RetrievalTrace;
			void this.plugin.updateQueryMessage(sessionId, messageId, {
				retrievalTrace: event.payload || null,
				retrievalMode: event.mode === "vault" ? "vault" : "web",
				progress: this.progressFromTrace(trace),
			}, "debounced").then(() => this.render({ scrollToBottom: true }));
			this.updateProgressText(this.progressFromTrace(trace));
			return;
		}
		if (event.type === "assistant-reset") {
			const session = this.plugin.querySessions.find((item) => item.id === sessionId);
			const message = session?.messages.find((item) => item.id === messageId);
			if (message) message.content = "";
			const streamEl = this.contentEl.querySelector(
				`[data-message-id="${messageId}"] .query-wiki-stream-content`,
			);
			if (streamEl) streamEl.setText("");
			return;
		}
		if (event.type === "retrieval-result" && event.payload && typeof event.payload === "object") {
			const payload = event.payload;
			void this.plugin.updateQueryMessage(sessionId, messageId, {
				content: String(payload.answer_markdown || "").slice(0, 20000),
				vaultSources: this.normalizeVaultSourceEntries(payload.vault_sources),
				webSources: normalizeQueryWebSources(payload.web_sources),
				citationValidation: normalizeQueryCitationValidation(payload.citation_validation),
				retrievalPath: normalizeQueryRetrievalPath(payload.retrieval_path),
				progress: "回答与来源校验完成",
			}).then(() => this.render({ scrollToBottom: true }));
			this.updateProgressText("回答与来源校验完成");
			return;
		}
		if (event.type === "assistant-delta" && event.delta) {
			const session = this.plugin.querySessions.find((item) => item.id === sessionId);
			const message = session?.messages.find((item) => item.id === messageId);
			if (!message) return;
			message.content = `${message.content || ""}${String(event.delta)}`.slice(0, 20000);
			const article = this.contentEl.querySelector(`[data-message-id="${messageId}"]`);
			const body = article?.querySelector(".query-wiki-message-body");
			let streamEl = body?.querySelector(".query-wiki-stream-content");
			if (body && !streamEl) {
				streamEl = body.createDiv({ cls: "query-wiki-stream-content" });
			}
			if (streamEl) streamEl.setText(message.content);
			const conversation = this.contentEl.querySelector(".query-wiki-conversation");
			if (conversation) conversation.scrollTop = conversation.scrollHeight;
			return;
		}
		if (event.type === "status" && event.label) {
			void this.plugin.updateQueryMessage(
				sessionId,
				messageId,
				{ progress: String(event.label) },
				"debounced",
			);
			this.updateProgressText(String(event.label));
		}
	}

	updateProgressText(value: unknown): void {
		if (this.statusEl?.isConnected) this.statusEl.setText(String(value || ""));
	}

	progressFromTrace(trace: RetrievalTrace): string {
		if (!trace || typeof trace !== "object") return "已完成检索预检";
		if (trace.fallback?.used) return "未找到可靠种子，正在检查方向索引";
		const seedCount = Array.isArray(trace.lexical_seeds) ? trace.lexical_seeds.length : 0;
		const graphCount = Array.isArray(trace.graph_expansion) ? trace.graph_expansion.length : 0;
		return `${trace.retrieval_label || "检索完成"}：${seedCount} 个种子，${graphCount} 个关联页面`;
	}

	stopQuery(): void {
		if (!this.activeRunId || this.activeRunId === "starting" || this.stopRequested) return;
		const message = this.session.messages.find((item) => item.id === this.activeMessageId);
		this.stopRequested = message?.queryBackendId && !isCliBackendId(message.queryBackendId)
			? this.plugin.stopDirectVaultQuery(this.activeRunId)
			: this.plugin.stopVaultAction(this.activeRunId);
		if (!this.stopRequested) {
			new Notice("当前查询进程已经结束");
			return;
		}
		this.updateProgressText("正在停止任务");
		if (message) {
			void this.plugin.updateQueryMessage(this.session.id, message.id, {
				status: "stopping",
				progress: "正在停止任务",
			});
		}
	}

	openSynthesisHandoff(): void {
		const action = ACTION_BY_ID.get("synthesis");
		if (!action) {
			new Notice("综合分析操作未注册");
			return;
		}
		const session = this.session;
		const transcript = session.messages
			.filter((message) => message.status === "done" && message.content)
			.slice(-10)
			.map((message) => `${message.role === "user" ? "用户" : "知识库回答"}：\n${message.content}`)
			.join("\n\n");
		const initialInput = [
			"将以下知识库查询对话整理为合适的 Wiki 页面。",
			"先重新核验被引用的 vault 页面，不要把对话中的模型表述直接当作证据。",
			"根据内容选择 synthesis、method、concept、dataset 或 project 页面；优先更新已有页面，写入前遵守 research-vault-synthesis 边界并同步相应索引和日志。",
			"",
			`会话标题：${session.title}`,
			"",
			transcript,
		].join("\n").slice(0, 30000);
		new ActionInputModal(
			this.app,
			this.plugin,
			action,
			({ input, overrides }) => {
				void this.executeSynthesisHandoff(action, input, overrides);
			},
			{ initialInput },
		).open();
	}

	async executeSynthesisHandoff(
		action: DashboardAction,
		input: string,
		overrides: ExecutionOverrides,
	): Promise<void> {
		if (this.plugin.isActionRunning(action.id)) {
			new Notice("综合分析正在运行");
			return;
		}
		const backendId = overrides.backend === "claude-code"
			? "claude-code"
			: overrides.backend === "opencode"
				? "opencode"
				: "codex-cli";
		const executionConfig = this.plugin.resolveCliActionExecutionConfig(
			action,
			backendId,
			overrides,
		);
		const summary = input.trim().split(/\r?\n/)[0].slice(0, 160) || "整理查询对话";
		const run = await this.plugin.startTaskRun(action, summary, executionConfig);
		let completedRun;
		try {
			const result = await this.plugin.runVaultAction(run.id, action, input, executionConfig);
			const output = [
				result.stdout.trim(),
				result.stderr.trim() ? `运行日志\n${result.stderr.trim()}` : "",
			].filter(Boolean).join("\n\n").slice(0, 120000) || "任务未返回文本输出。";
			const status = result.exitCode === 0 ? "done" : "failed";
			completedRun = await this.plugin.finishTaskRun(run.id, {
				status,
				exitCode: result.exitCode,
				output,
				error: status === "failed" ? `进程退出码：${result.exitCode}` : "",
			});
			new Notice(status === "done" ? "查询对话已整理为知识任务" : "整理为笔记失败");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			completedRun = await this.plugin.finishTaskRun(run.id, {
				status: "failed",
				exitCode: null,
				output: "",
				error: message,
			});
			new Notice(`整理为笔记失败：${message}`);
		}
		if (completedRun) new TaskResultModal(this.app, this.plugin, completedRun, null).open();
	}

	displayRetrieverName(value: unknown): string {
		const name = String(value || "").trim();
		if (name === "toolkit") return "Research Vault Toolkit";
		if (name === "in-plugin-lexical") return "内置词法检索";
		return name || "默认检索器";
	}

	displayRetrievalStage(stage: unknown): string {
		const stageKey = String(stage || "");
		return {
			"lexical-seed+graph-expansion": "词法种子 → 关系扩展",
			"lexical-seed+ppr": "词法种子 → PPR 图扩展",
			"llm-keyword+ppr": "LLM 关键词扩展 → PPR 图扩展",
			"in-plugin-lexical": "内置词法检索",
			"no-match-fallback": "无匹配 → 方向索引回退",
			"preflight-unavailable": "预检不可用，交由检索 skill 回退",
		}[stageKey] || stageKey || "未知";
	}

	formatTime(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		return new Intl.DateTimeFormat("zh-CN", {
			hour: "2-digit",
			minute: "2-digit",
		}).format(date);
	}
}
