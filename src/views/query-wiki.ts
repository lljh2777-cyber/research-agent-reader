import { backendSupportsImages, type QueryTaskChange, type QueryTaskService } from "../query/query-task-service";
import { queryAnswerErrorDetail, type AnswerText } from "../query/answer-text";
import { ROLE_LABELS } from "../retrieval/types";
import {
	ItemView,
	MarkdownRenderer,
	Notice,
	TFile,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";

import {
	ACTION_BY_ID,
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
import { VaultImagePickerModal } from "../modals/vault-image-picker";
import {
	normalizeQueryCitationValidation,
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
	PluginHost,
	QueryMessage as PersistedQueryMessage,
	QueryRetrievalMode,
	QuerySession,
	ServiceTier,
} from "../types/contracts";

type RetrievalTrace = Record<string, unknown> & {
	knowledge?: import("../query/direct-query-service").RetrievalTrace["knowledge"];
	knowledge_passages?: import("../query/direct-query-service").RetrievalTrace["knowledge_passages"];
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

interface QueryViewHost extends PluginHost {
	openModelSettings?(context:"query"):void;
	lightPaperIngestAvailable(): { ready: boolean; reason: string };
	lightAgentMineruReady(): boolean;
	getActiveDirectProviderSummary(): { name: string; model: string } | null;
	readonly queryTasks: QueryTaskService;
	setActiveQueryMode(mode: QueryRetrievalMode | string): Promise<void>;
	setActiveQueryBackend(backendId: string): Promise<void>;
	resolveQueryBackendId(backendId?: string): string;
	isCliBackendAvailable(backendId: CliBackendId): boolean;
	getProviderProfile(profileId: string): ProviderProfile | null;
	getVerifiedProviderProfiles(): ProviderProfile[];
	buildVaultImageReferenceIndex(
		files: TFile[],
	): Map<string, Array<{ title: string; path: string; count: number }>>;
	getCliModelDiscovery(backendId: CliBackendId): CliModelDiscoveryResult | null;
	discoverCliModels(
		backendId: CliBackendId,
		force?: boolean,
	): Promise<CliModelDiscoveryResult>;
	invalidateCliModelDiscovery(backendId: CliBackendId): void;
	directProfileSupportsWebSearch(profileId: string): boolean;
	saveQueryAnswerNote(sessionId: string, messageId: string): Promise<string>;
	saveQueryAnswerNoteWithStatus(sessionId: string, messageId: string): Promise<{ path: string; problem?: string }>;
	getQueryMessageText(sessionId: string, messageId: string): Promise<AnswerText>;
	supportsFast(model: string): boolean;
}

export class QueryWikiView extends ItemView {
	private readonly plugin: QueryViewHost;
	private initialQuestion: string;
	private readonly composerId = Symbol();
	private unsubscribe: (() => void) | null = null;
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
		this.unsubscribe?.();
		const unsubscribe = this.plugin.queryTasks.subscribe((id, change) => this.onTaskChange(id, change));
		this.unsubscribe = unsubscribe;
		await this.render();
		window.requestAnimationFrame(() => {
			if (this.unsubscribe === unsubscribe) this.activateComposerInput();
		});
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.renderVersion++;
		this.inputEl = null;
		this.statusEl = null;
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

	private get activeRunId(): string {
		const task = this.plugin.queryTasks.forSession(this.session.id);
		return task ? task.runId || "starting" : "";
	}

	async render(options: { scrollToBottom?: boolean } = {}): Promise<void> {
		if (!this.unsubscribe) return;
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
				await this.renderMessage(conversation, message, session.id);
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
				if (version === this.renderVersion) conversation.scrollTop = conversation.scrollHeight;
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
			void this.plugin.setActiveQuerySession(sessions.value).then(() => this.render()).then(() => this.activateComposerInput(true));
		});
		const create = this.createIconButton(tools, "message-square-plus", "新建对话");
		create.disabled = Boolean(this.activeRunId);
		create.addEventListener("click", () => {
			this.pendingImages = [];
			void this.plugin.createQuerySession().then(() => this.render()).then(() => this.inputEl?.focus());
		});
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
				.then(() => this.render())
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

	async renderMessage(parent: HTMLElement, message: PersistedQueryMessage, sessionId: string): Promise<void> {
		const messageId = message.id;
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
					const answer = await this.plugin.getQueryMessageText(sessionId, messageId);
					await navigator.clipboard.writeText(answer.text);
					if (!answer.complete) new Notice(`已复制截短版本（原文 ${answer.originalLength} 字符，复制 ${answer.keptLength} 字符）：${answer.problem}`);
					setIcon(copyButton, "check");
					copyButton.title = "已复制";
					window.setTimeout(() => {
						if (!copyButton.isConnected) return;
						setIcon(copyButton, "copy");
						copyButton.title = "复制本条内容";
					}, 1400);
				} catch (error) {
					new Notice(`复制失败：${queryAnswerErrorDetail(error)}`);
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
						const saved = await this.plugin.saveQueryAnswerNoteWithStatus(sessionId, messageId);
						setIcon(noteButton, "check");
						noteButton.title = "已保存笔记";
						const warning = saved.problem ? `。回答已截短：${saved.problem}` : "";
						new Notice(`已保存笔记：${saved.path}${warning}`);
					} catch (error) {
						new Notice(`落笔记失败：${queryAnswerErrorDetail(error)}`);
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
			if (this.plugin.openModelSettings && /模型|连接|CLI|超时|认证|凭据|API|network|timeout/i.test(message.error || "")) {
				body.createEl("button",{text:"检查问答模型"}).onclick=()=>this.plugin.openModelSettings?.("query");
			}
		} else if (message.content) {
			const markdown = body.createDiv({ cls: "query-wiki-markdown markdown-rendered" });
			const version = this.renderVersion;
			await MarkdownRenderer.render(this.app, message.content, markdown, "", this);
			if (version !== this.renderVersion) return;
		}
		const contentLength = message.contentLength ?? message.content.length;
		if (message.status === "done" && message.outputLimitReached === true) {
			body.createEl("p", { text: "模型输出达到上限，回答可能不完整" });
		}
		if (message.status === "done" && contentLength > message.content.length) {
			body.createEl("p", { text: `内容已截短（原文 ${contentLength} 字符，当前保留 ${message.content.length} 字符）` });
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
		if (seeds.length) this.renderTraceGroup(content, trace.knowledge ? "检索候选" : "词法种子", seeds);
		if (trace.knowledge) {
			content.createEl("p", { text: trace.knowledge.scope ? "本轮限定论文：" + (trace.knowledge.scope.join("、") || "未找到对应来源") : "本轮范围：正式知识笔记" });
			for (const warning of trace.knowledge.warnings || []) content.createEl("p", { cls: "query-wiki-trace-note", text: warning });
			content.createEl("p", { text: "相关性仅用于排序；以下片段仍需核对证据是否充分。" });
			for (const hit of trace.knowledge_passages || []) {
				const item = content.createEl("details"); item.createEl("summary", { text: hit.path + " · " + hit.heading });
				item.createEl("p", { text: "内容角色：" + (ROLE_LABELS[hit.role] || "未标注") + "；深度：" + hit.depth + "；原始来源：" + (hit.origins.join("、") || "未标注") });
				item.createEl("pre", { cls: "reading-evidence-text", text: hit.text });
			}
		}
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
		const version = this.renderVersion;
		window.requestAnimationFrame(() => {
			if (version !== this.renderVersion || !input.isConnected) return;
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
		const canAttachImage = backendSupportsImages(backendId, directProfile);
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
		stop.disabled = !this.activeRunId || this.activeRunId === "starting" || Boolean(this.plugin.queryTasks.forSession(sessionId)?.stopping);
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
			void this.submitQuestion(input.value.trim()).catch(error => new Notice(`知识库查询失败：${String(error)}`));
			if (this.activeRunId) send.disabled = true;
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
					if (this.pendingImages.length) { new Notice("请先保留当前模式或自行移除图片，再切换联网查询"); return; }
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
			if (this.pendingImages.length && !backendSupportsImages(backend.value, selectedProfile)) {
				backend.value = backendId;
				new Notice("当前问题含有图片，请选用支持图片的模型，或先移除附件");
				return;
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
			const version = this.renderVersion;
			void this.plugin.discoverCliModels(backendId)
				.then((discovery) => {
					if (version !== this.renderVersion || backend.value !== backendId) return;
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
					if (version !== this.renderVersion || backend.value !== backendId) return;
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

	submitQuestion(question: string): Promise<void> {
		return this.plugin.queryTasks.submit(this.session, question, this.pendingImages, this.executionOverridesByBackend, this.composerId);
	}

	private onTaskChange(sessionId: string, change: QueryTaskChange): void {
		if (sessionId !== this.session.id) return;
		if (change.type === "progress") {
			if (this.statusEl?.isConnected) this.statusEl.setText(change.text);
			return;
		}
		if (change.type === "text") {
			const article = this.contentEl.querySelector(`[data-message-id="${change.messageId}"]`);
			const body = article?.querySelector(".query-wiki-message-body");
			let stream = body?.querySelector(".query-wiki-stream-content");
			if (body && !stream && change.content) stream = body.createDiv({ cls: "query-wiki-stream-content" });
			stream?.setText(change.content);
			if (change.content) {
				const conversation = this.contentEl.querySelector(".query-wiki-conversation");
				if (conversation) conversation.scrollTop = conversation.scrollHeight;
			}
			return;
		}
		if (change.type === "accepted" && change.composer === this.composerId) {
			this.queryDrafts.delete(sessionId);
			if (this.inputEl?.isConnected) this.inputEl.value = "";
			this.pendingImages = [];
		}
		if (change.type === "finished" && change.composer === this.composerId && change.retry && !this.queryDrafts.get(sessionId)) {
			this.queryDrafts.set(sessionId, change.retry.question);
			this.pendingImages = change.retry.attachments;
		}
		void this.render({ scrollToBottom: true }).catch(error => new Notice(`无法显示查询会话：${String(error)}`));
	}

	stopQuery(): void {
		void this.plugin.queryTasks.stop(this.session.id).catch(error => new Notice(`无法停止知识库查询：${String(error)}`));
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
