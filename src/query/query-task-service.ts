import { Notice } from "obsidian";
import { ACTION_BY_ID, type DashboardAction } from "../actions";
import { getCliBackendLabel, isCliBackendId, type CliBackendId } from "../config";
import { profileSupportsQueryImage, type ProviderProfile } from "../providers/profile";
import { getClaudeDefaultModelLabel } from "../runtime/settings";
import { makeVaultSourcePathResolver } from "../services/vault-evidence";
import type {
	DashboardProcessEvent, DashboardProcessHooks, DashboardProcessResult, ExecutionConfig, ExecutionOverrides,
	PluginHost, QueryMessage as PersistedQueryMessage, QueryRetrievalMode, QuerySession,
} from "../types/contracts";
import {
	normalizeQueryCitationValidation, normalizeQueryRetrievalPath, normalizeQueryVaultSources,
	normalizeQueryWebSources, normalizeVaultImageAttachments, type VaultImageAttachment,
} from "./normalization";

interface QuestionImageResolution {
	attachments: VaultImageAttachment[];
	notePaths: string[];
	discoveredCount: number;
	totalBytes: number;
}

interface QueryTaskHost extends Pick<PluginHost, "app" | "settings" | "isActionRunning"
	| "startTaskRun" | "finishTaskRun" | "resolveActionExecutionConfig" | "resolveCliActionExecutionConfig"> {
	querySessions: QuerySession[];
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
	resolveQueryBackendId(backendId?: string): string;
	getProviderProfile(profileId: string): ProviderProfile | null;
	resolveDirectQueryExecutionConfig(profile: ProviderProfile): ExecutionConfig;
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
		hooks?: DashboardProcessHooks,
		attachments?: VaultImageAttachment[],
	): Promise<DashboardProcessResult>;
	runVaultAction(
		runId: string,
		action: DashboardAction,
		input: string,
		executionConfig?: ExecutionConfig | null,
		hooks?: DashboardProcessHooks,
	): Promise<DashboardProcessResult>;
	stopDirectVaultQuery(runId: string): boolean;
	stopVaultAction(runId: string): boolean;
}

export function backendSupportsImages(backend: string, profile: unknown): boolean {
	return backend === "claude-code" || profileSupportsQueryImage(profile);
}

export type QueryTaskChange =
	| { type: "accepted"; composer: symbol }
	| { type: "finished"; composer: symbol; retry?: QueryRetry }
	| { type: "refresh" }
	| { type: "text"; messageId: string; content: string }
	| { type: "progress"; text: string };

type QueryRetry = { question: string; attachments: VaultImageAttachment[] };

interface ActiveQuery {
	retry?: QueryRetry;
	sessionId: string;
	messageId: string;
	runId: string;
	backendId: string;
	stopping: boolean;
}

type QueryListener = (sessionId: string, change: QueryTaskChange) => void;

export class QueryTaskService {
	private active: ActiveQuery | null = null;
	private pending: Promise<void> | null = null;
	private saveFailureNotified = false;
	private readonly lifetime = new AbortController();
	private readonly listeners = new Set<QueryListener>();

	constructor(private readonly plugin: QueryTaskHost) {}

	get shutdownSignal(): AbortSignal { return this.lifetime.signal; }

	subscribe(listener: QueryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private publish(sessionId: string, change: QueryTaskChange): void {
		for (const listener of this.listeners) listener(sessionId, change);
	}

	forSession(id: string): Readonly<ActiveQuery> | null {
		return this.active?.sessionId === id ? this.active : null;
	}

	submit(session: QuerySession, question: string, images: VaultImageAttachment[],
		overrides: Record<CliBackendId, ExecutionOverrides>, composer: symbol): Promise<void> {
		if (!question || this.shutdownSignal.aborted || this.active || this.plugin.isActionRunning("vault-retrieval")) return Promise.resolve();
		const task: ActiveQuery = { sessionId: session.id, runId: "", messageId: "", backendId: "", stopping: false };
		this.active = task;
		this.pending = this.run(task, session, question, images, overrides, composer).finally(() => {
			this.active = null;
			this.pending = null;
			this.publish(session.id, { type: "finished", composer, retry: task.retry });
		});
		return this.pending;
	}

	private cancelBackend(task: ActiveQuery): boolean {
		return isCliBackendId(task.backendId)
			? this.plugin.stopVaultAction(task.runId)
			: this.plugin.stopDirectVaultQuery(task.runId);
	}

	async stop(sessionId: string): Promise<void> {
		const task = this.active;
		if (!task?.runId || task.sessionId !== sessionId || task.stopping) return;
		task.stopping = this.cancelBackend(task);
		if (!task.stopping) {
			new Notice("当前查询进程已经结束");
			return;
		}
		const text = "正在停止任务";
		this.publish(task.sessionId, { type: "progress", text });
		await this.saveMessageUpdate(task.sessionId, task.messageId, { status: "stopping", progress: text });
	}

	shutdown(): Promise<void> | null {
		this.listeners.clear();
		this.lifetime.abort(new Error("插件卸载，已停止本轮查询"));
		if (this.active?.runId && !this.active.stopping) this.cancelBackend(this.active);
		return this.pending;
	}

	private async run(task: ActiveQuery, session: QuerySession, question: string, images: VaultImageAttachment[],
		overrides: Record<CliBackendId, ExecutionOverrides>, composer: symbol): Promise<void> {
		const action = ACTION_BY_ID.get("vault-retrieval");
		if (!action) {
			new Notice("知识库检索操作未注册");
			return;
		}
		const backendId = this.plugin.resolveQueryBackendId(session.queryBackendId);
		const directProfile = isCliBackendId(backendId)
			? null
			: this.plugin.getProviderProfile(backendId);
		if (!isCliBackendId(backendId) && !directProfile) {
			new Notice("所选 Direct API 配置不可用，请重新选择执行后端");
			return;
		}
		const selectedImages = normalizeVaultImageAttachments(images);
		const canSendImages = backendSupportsImages(backendId, directProfile);
		if (selectedImages.length && !canSendImages) {
			new Notice("当前执行后端未启用视觉输入，无法发送图片");
			return;
		}
		let linkedImageResult: QuestionImageResolution = {
			attachments: [],
			notePaths: [],
			discoveredCount: 0,
			totalBytes: 0,
		};
		if (canSendImages) {
			try {
				linkedImageResult = await this.plugin.resolveQuestionImageAttachments(question, selectedImages);
			} catch (error) {
				if (this.shutdownSignal.aborted) return;
				new Notice(
					`问题未发送，无法解析链接笔记中的图片：${error instanceof Error ? error.message : String(error)}`,
					8000,
				);
				return;
			}
		}
		if (this.shutdownSignal.aborted) return;
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
		const executionConfig: ExecutionConfig = directProfile
			? this.plugin.resolveDirectQueryExecutionConfig(directProfile)
			: backendId === "claude-code"
				? this.plugin.resolveCliActionExecutionConfig(
					action,
					"claude-code",
					overrides["claude-code"],
				)
			: backendId === "opencode"
				? this.plugin.resolveCliActionExecutionConfig(
					action,
					"opencode",
					overrides["opencode"],
				)
			: {
				backend: "codex-cli" as const,
				...this.plugin.resolveActionExecutionConfig(
					action,
					overrides["codex-cli"],
				),
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
			model: executionConfig.model,
		};
		const input = this.plugin.buildQueryActionInput(
			question,
			priorMessages,
			retrievalMode,
			attachments,
		);
		let run = null;
		let completedRun = null;
		let restoreQuestion = false;
		try {
			task.messageId = assistantMessage.id;
			task.backendId = backendId;
			await this.plugin.appendQueryMessages(session.id, [userMessage, assistantMessage], question);
			this.saveFailureNotified = false;
			this.publish(session.id, { type: "accepted", composer });
			this.shutdownSignal.throwIfAborted();
			run = await this.plugin.startTaskRun(action, question.slice(0, 160), executionConfig);
			task.runId = run.id;
			await this.saveMessageUpdate(session.id, assistantMessage.id, { runId: run.id });
			this.shutdownSignal.throwIfAborted();
			this.publish(session.id, { type: "refresh" });
			const hooks: DashboardProcessHooks = {
				onEvent: event => this.handleRunnerEvent(session.id, assistantMessage.id, event),
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
			const stopped = task.stopping
				|| result.exitCode === 130
				|| (result.events || []).some((event) => event.type === "status" && event.stage === "stopped");
			const status = this.shutdownSignal.aborted ? "interrupted" : result.exitCode === 0 ? "done" : stopped ? "interrupted" : "failed";
			const resultEvent = [...(result.events || [])]
				.reverse()
				.find((event) => event.type === "retrieval-result");
			const structuredResult = resultEvent?.payload && typeof resultEvent.payload === "object"
				? resultEvent.payload
				: null;
			const response = String(structuredResult?.answer_markdown || result.stdout || "").trim();
			const error = status === "done"
				? ""
				: status === "interrupted"
					? "已停止本轮查询。"
					: result.stderr.trim() || `查询进程退出码：${result.exitCode}`;
			const traceEvent = [...(result.events || [])].reverse().find((event) => event.type === "retrieval-preflight");
			await this.saveMessageUpdate(session.id, assistantMessage.id, {
				status,
				content: response || (status === "done" ? "本轮查询未返回文本。" : ""),
				error,
				progress: "",
				retrievalTrace: traceEvent?.payload || assistantMessage.retrievalTrace || null,
				vaultSources: this.vaultSources(structuredResult?.vault_sources),
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
			restoreQuestion = status === "failed";
			completedRun = await this.plugin.finishTaskRun(run.id, {
				status,
				exitCode: result.exitCode,
				output,
				error,
			});
			new Notice(status === "done" ? "知识库回答已完成" : status === "interrupted" ? "知识库查询已停止" : "知识库查询失败");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const interrupted = this.shutdownSignal.aborted || task.stopping || /cancelled|canceled|已停止|正在停止/i.test(message);
			restoreQuestion = !interrupted;
			await this.saveMessageUpdate(session.id, assistantMessage.id, {
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
			if (restoreQuestion) task.retry = { question, attachments };
			if (!completedRun) console.warn("Query run completed without a persisted task record");
		}
	}

	private vaultSources(value: unknown) {
		return normalizeQueryVaultSources(value, { resolveVaultPath: makeVaultSourcePathResolver(this.plugin.app) });
	}

	private async saveMessageUpdate(
		sessionId: string,
		messageId: string,
		patch: Partial<PersistedQueryMessage>,
		saveMode: "debounced" | "immediate" = "immediate",
	): Promise<void> {
		try {
			const saved = await this.plugin.updateQueryMessage(sessionId, messageId, patch, saveMode);
			if (saved) this.saveFailureNotified = false;
		} catch (error) {
			// Several progress events can receive the rejection from the same disk write.
			if (!this.saveFailureNotified) {
				this.saveFailureNotified = true;
				new Notice(`查询记录保存失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private handleRunnerEvent(sessionId: string, messageId: string, event: DashboardProcessEvent): void {
		if (event.type === "assistant-reset" || (event.type === "assistant-delta" && event.delta)) {
			const session = this.plugin.querySessions.find(item => item.id === sessionId);
			const message = session?.messages.find(item => item.id === messageId);
			if (!message) return;
			message.content = event.type === "assistant-reset" ? "" : (message.content + event.delta).slice(0, 20000);
			this.publish(sessionId, { type: "text", messageId, content: message.content });
			return;
		}

		let patch: Partial<PersistedQueryMessage>;
		let saveMode: "debounced" | "immediate" = "debounced";
		let change: QueryTaskChange = { type: "refresh" };
		if (event.type === "retrieval-preflight") {
			const trace = event.payload as import("./direct-query-service").RetrievalTrace | undefined;
			const seeds = Array.isArray(trace?.lexical_seeds) ? trace.lexical_seeds.length : 0;
			const related = Array.isArray(trace?.graph_expansion) ? trace.graph_expansion.length : 0;
			patch = {
				retrievalTrace: event.payload || null,
				retrievalMode: event.mode === "vault" ? "vault" : "web",
				progress: trace?.fallback?.used ? "未找到可靠种子，正在检查方向索引"
					: `${trace?.retrieval_label || "检索完成"}：${seeds} 个种子，${related} 个关联页面`,
			};
		} else if (event.type === "retrieval-result" && event.payload && typeof event.payload === "object") {
			const payload = event.payload;
			saveMode = "immediate";
			patch = {
				content: String(payload.answer_markdown || "").slice(0, 20000),
				vaultSources: this.vaultSources(payload.vault_sources),
				webSources: normalizeQueryWebSources(payload.web_sources),
				citationValidation: normalizeQueryCitationValidation(payload.citation_validation),
				retrievalPath: normalizeQueryRetrievalPath(payload.retrieval_path),
				progress: "回答与来源校验完成",
			};
		} else if (event.type === "status" && event.label) {
			patch = { progress: event.label };
			change = { type: "progress", text: event.label };
		} else return;

		void this.saveMessageUpdate(sessionId, messageId, patch, saveMode);
		this.publish(sessionId, change);
	}
}
