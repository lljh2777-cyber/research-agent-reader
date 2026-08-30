import type { App } from "obsidian";

import type { LLMProvider } from "../providers/adapters";
import type {
	DashboardProcessEvent,
	ExecutionConfig,
	ProviderHttpRequestOptions,
	ProviderHttpResponse,
} from "../types/contracts";
import type { DashboardSettings } from "../runtime/settings";
import { runBoundedAgentLoop } from "./loop";
import {
	buildDraftSystemPrompt,
	buildDraftTools,
	buildDraftUserMessage,
	buildIdentitySystemPrompt,
	buildIdentityTools,
	buildIdentityUserMessage,
	commitSourceNote,
	mineruReadiness,
	parseIdentityResult,
	parseNoteDraft,
	resolveArticleVaultPath,
	runAuthorizedMineruExtract,
	VaultWriteJournal,
	type PaperIngestFlowOptions,
	type PaperIngestIdentity,
	type PaperIngestNoteDraft,
	type PaperIngestReceipts,
} from "./paper-ingest-flow";
import type { AgentLoopResult, AgentLoopStep } from "./types";

export interface AgentLoopServiceDeps {
	app: App;
	getSettings(): DashboardSettings;
	getProvider(profileId: string): {
		provider: LLMProvider;
		profileName: string;
		model: string;
	} | null;
	providerHttpRequest(options: ProviderHttpRequestOptions): Promise<ProviderHttpResponse>;
	getTavilySecret(): string;
	getLexicalRetriever(): {
		retrieve(question: string, expandedTerms?: string[]): Promise<Record<string, unknown>>;
	} | null;
	/** Spawns the toolkit MinerU helper; injectable for tests. */
	runMineruHelper(args: {
		pythonExecutable: string;
		helperPath: string;
		cliArgs: string[];
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
	}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface AgentRunHandle {
	cancel(): void;
}

interface ActiveAgentRun {
	handle: AgentRunHandle;
}

/** Final structured result; paths come from plugin receipts, not model claims. */
export interface PaperIngestFinalResult {
	status: "completed" | "conflict" | "failed";
	citekey: string;
	title: string;
	title_zh: string;
	articlePath: string;
	wikiPath: string;
	filesWritten: string[];
	duplicates: string[];
	conflicts: string[];
	notes: string[];
}

export interface AgentLoopRunOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	events: DashboardProcessEvent[];
	/** Structured result built from tool receipts. */
	result: PaperIngestFinalResult | null;
	loopStatus: AgentLoopResult["status"];
	/** Vault paths written during the run, for direct navigation in the UI. */
	filesWritten: readonly string[];
	executionConfig: ExecutionConfig;
}

const STEP_TITLES: Record<AgentLoopStep["kind"], string> = {
	model: "模型思考",
	tool: "工具调用",
	final: "任务完成",
	error: "出错",
};

/** Mutable per-run state threaded through the phase pipeline. */
interface IngestState {
	traces: string[];
	notes: string[];
	conflicts: string[];
	duplicates: string[];
	journal: VaultWriteJournal;
	receipts: PaperIngestReceipts;
	identity: PaperIngestIdentity | null;
	draft: PaperIngestNoteDraft | null;
	titleConflict: boolean;
	cancelled: boolean;
	errorMessage: string;
}

export class AgentLoopService {
	private readonly deps: AgentLoopServiceDeps;
	private readonly activeRuns = new Map<string, ActiveAgentRun>();

	constructor(deps: AgentLoopServiceDeps) {
		this.deps = deps;
	}

	isActive(runId: string): boolean {
		return this.activeRuns.has(runId);
	}

	stop(runId: string): boolean {
		const active = this.activeRuns.get(runId);
		if (!active) return false;
		active.handle.cancel();
		return true;
	}

	async runPaperIngest(
		runId: string,
		options: PaperIngestFlowOptions,
		profileId: string,
		hooks: { onEvent?: (event: DashboardProcessEvent) => void } = {},
	): Promise<AgentLoopRunOutcome> {
		const settings = this.deps.getSettings();
		const resolved = this.deps.getProvider(profileId);
		if (!resolved) {
			throw new Error("Direct API 配置不存在或尚未通过连接测试");
		}

		const abortController = new AbortController();
		const state: IngestState = {
			traces: [],
			notes: [],
			conflicts: [],
			duplicates: [],
			journal: new VaultWriteJournal(),
			receipts: { mineruPackage: null, articleVaultPath: "", writes: [] },
			identity: null,
			draft: null,
			titleConflict: false,
			cancelled: false,
			errorMessage: "",
		};
		this.activeRuns.set(runId, {
			handle: {
				cancel: () => {
					state.cancelled = true;
					abortController.abort();
				},
			},
		});
		const emitStatus = (status: string, label: string): void => {
			hooks.onEvent?.({ type: "status", stage: "agent-loop", status, label });
		};
		const onStep = (phase: string) => (step: AgentLoopStep): void => {
			emitStatus("running", [phase, STEP_TITLES[step.kind] || step.kind, step.title, step.detail]
				.filter(Boolean).join(" · "));
		};
		emitStatus("running", "轻量 Agent 已启动");

		try {
			const retriever = this.deps.getLexicalRetriever();
			if (!retriever) throw new Error("知识库检索组件不可用");
			const toolDeps = this.buildToolDeps(settings, retriever);
			const deadline = Date.now() + Math.max(
				60_000,
				Math.min(4 * 60 * 60 * 1000, (Math.round(settings.taskTimeoutMinutes) || 60) * 60 * 1000),
			);
			const maxStepsPerPhase = Math.max(3, Math.min(20, Math.round(settings.lightAgentMaxSteps) || 10));
			const maxTokens = Math.max(512, Math.min(8192, Math.round(settings.lightAgentMaxOutputTokens) || 4096));
			const isCancelled = (): boolean => state.cancelled;

			// ---- Phase 1: identity + dedup (model loop, read-only tools) ----
			emitStatus("running", "阶段一 · 身份核验与去重");
			const identityLoop = await runBoundedAgentLoop({
				system: buildIdentitySystemPrompt(options),
				user: buildIdentityUserMessage(options),
				tools: buildIdentityTools(toolDeps),
				provider: resolved.provider,
				model: resolved.model,
				maxTokens,
				maxSteps: maxStepsPerPhase,
				timeoutMs: Math.max(30_000, deadline - Date.now()),
				maxToolOutputChars: 60000,
				isCancelled,
				onStep: onStep("身份核验"),
			});
			state.traces.push(identityLoop.trace);
			if (identityLoop.status !== "completed") {
				state.errorMessage = identityLoop.error;
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			try {
				state.identity = parseIdentityResult(identityLoop.final);
			} catch (identityError) {
				state.errorMessage = identityError instanceof Error ? identityError.message : String(identityError);
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			if (!state.identity) {
				state.errorMessage = "阶段一未返回可解析的身份结果";
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			state.conflicts.push(...state.identity.conflicts);
			state.duplicates.push(...state.identity.duplicates);
			state.notes.push(...state.identity.notes);
			emitStatus("running", state.identity.status === "verified"
				? `阶段一完成 · citekey ${state.identity.citekey}`
				: "阶段一完成 · 发现冲突");

			if (state.identity.status === "conflict") {
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			const identity = state.identity;

			// ---- Phase 2: MinerU extraction (deterministic, authorized PDF only) ----
			if (options.createArticleMarkdown) {
				emitStatus("running", "阶段二 · MinerU 原文提取");
				if (!options.remoteUploadConfirmed) {
					state.conflicts.push("用户未确认远程处理，跳过 MinerU 提取");
				} else if (!options.sourcePdfPath) {
					state.conflicts.push("未提供 PDF 路径，无法生成原文 Markdown");
				} else {
					const readiness = mineruReadiness(toolDeps.mineru);
					if (!readiness.ready) {
						state.notes.push(`无法生成原文 Markdown：${readiness.reason}`);
					} else {
						try {
							state.receipts.mineruPackage = await runAuthorizedMineruExtract(
								toolDeps.mineru,
								{
									source: options.sourcePdfPath,
									citekey: identity.citekey,
									model: options.mineruModel,
									language: options.mineruLanguage,
									ocr: options.mineruOcr,
									formula: options.mineruFormula,
									table: options.mineruTable,
									pages: options.mineruPages,
									timeoutSeconds: options.mineruTimeoutSeconds,
									includeSourcePdf: options.mineruIncludeSourcePdf,
								},
								{
									signal: abortController.signal,
									timeoutMs: Math.max(60_000, Math.min(1800_000, options.mineruTimeoutSeconds * 1000)),
								},
							);
							state.receipts.articleVaultPath = await resolveArticleVaultPath(toolDeps.vault, identity.citekey);
							if (!state.receipts.articleVaultPath) {
								state.conflicts.push(`MinerU 包已发布但未在知识库中找到 papers/${identity.citekey}/article.md`);
							} else {
								state.notes.push(`原文包已发布：${state.receipts.articleVaultPath.replace(/\/article\.md$/, "")}`);
								state.titleConflict = !(await articleHeadContainsTitle(
									toolDeps.vault,
									state.receipts.articleVaultPath,
									identity.title,
								));
								if (state.titleConflict) {
									state.conflicts.push(`article.md 开头与核验标题不一致：${identity.title}`);
								}
							}
						} catch (mineruError) {
							if (state.cancelled) {
								return this.finish(state, options, profileId, resolved, emitStatus);
							}
							state.conflicts.push(
								`MinerU 提取失败：${mineruError instanceof Error ? mineruError.message : String(mineruError)}`,
							);
						}
					}
				}
			}

			// ---- Phase 3: note draft fields (model loop) + plugin commit ----
			if (options.createArticleWiki && !state.titleConflict) {
				emitStatus("running", "阶段三 · 整理文章 Wiki 字段");
				const draftLoop = await runBoundedAgentLoop({
					system: buildDraftSystemPrompt(options, identity.citekey, identity.title),
					user: buildDraftUserMessage(identity.citekey, identity.title),
					tools: buildDraftTools(toolDeps),
					provider: resolved.provider,
					model: resolved.model,
					maxTokens,
					maxSteps: Math.min(maxStepsPerPhase, 8),
					timeoutMs: Math.max(30_000, deadline - Date.now()),
					maxToolOutputChars: 60000,
					isCancelled,
					onStep: onStep("文章 Wiki"),
				});
				state.traces.push(draftLoop.trace);
				if (draftLoop.status !== "completed") {
					state.errorMessage = draftLoop.error;
					return this.finish(state, options, profileId, resolved, emitStatus);
				}
				state.draft = parseNoteDraft(draftLoop.final);
				if (!state.draft) {
					state.conflicts.push("阶段三未返回可解析的笔记字段");
				} else {
					state.notes.push(...state.draft.notes);
					if (!state.draft.title_zh) {
						state.notes.push("title_zh 未能审校，笔记保留空值");
					}
					try {
						const receipt = await commitSourceNote(
							toolDeps.vault,
							identity.citekey,
							{
								title: identity.title || state.draft.title,
								title_zh: state.draft.title_zh,
								researchQuestion: state.draft.researchQuestion,
								conclusion: state.draft.conclusion,
								motivation: state.draft.motivation,
								evidenceGaps: state.draft.evidenceGaps,
								notes: [],
							},
							"ingest_mode: lightweight\nregistry_status: pending",
						);
						state.journal.record(receipt);
						state.receipts.writes = state.journal.receipts();
					} catch (commitError) {
						state.conflicts.push(
							`笔记写入未完成：${commitError instanceof Error ? commitError.message : String(commitError)}`,
						);
					}
				}
			} else if (options.createArticleWiki && state.titleConflict) {
				state.notes.push("因标题一致性问题未创建文章 Wiki，请人工核对后重试");
			}

			return this.finish(state, options, profileId, resolved, emitStatus);
		} catch (error) {
			if (!state.cancelled) {
				state.errorMessage = error instanceof Error ? error.message : String(error);
			}
			return this.finish(state, options, profileId, resolved, emitStatus);
		} finally {
			this.activeRuns.delete(runId);
		}
	}

	private buildToolDeps(
		settings: DashboardSettings,
		lexicalRetriever: { retrieve(question: string, expandedTerms?: string[]): Promise<Record<string, unknown>> },
	) {
		return {
			vault: { app: this.deps.app },
			http: {
				httpGetJson: async (url: string, timeoutMs: number) => {
					const response = await this.deps.providerHttpRequest({
						url,
						method: "GET",
						headers: { Accept: "application/json" },
						body: null,
						timeoutMs,
					});
					return { status: response.status, json: response.json, text: response.text };
				},
			},
			mineru: {
				toolkitRoot: settings.toolkitRoot,
				mineruExecutable: settings.mineruExecutable,
				mineruBaseUrl: settings.mineruBaseUrl,
				pythonExecutable: settings.pythonExecutable,
				runHelper: (args: Parameters<AgentLoopServiceDeps["runMineruHelper"]>[0]) =>
					this.deps.runMineruHelper(args),
			},
			tavily: {
				http: {
					httpRequest: async (request: { url: string; method: string; headers: Record<string, string>; body: unknown; timeoutMs: number }) => {
						const response = await this.deps.providerHttpRequest({
							url: request.url,
							method: request.method,
							headers: request.headers,
							body: request.body,
							timeoutMs: request.timeoutMs,
						});
						return { status: response.status, json: response.json };
					},
				},
				apiKey: this.deps.getTavilySecret(),
				maxResults: Math.max(1, Math.min(8, Math.round(settings.webSearchMaxResults) || 5)),
				timeoutMs: Math.max(5, Math.min(60, Math.round(settings.webSearchTimeoutSeconds) || 20)) * 1000,
			},
			lexicalRetriever,
		};
	}

	/**
	 * Builds the outcome from plugin-observed receipts. Success requires the
	 * requested outputs to exist as receipts; model claims alone never count.
	 */
	private finish(
		state: IngestState,
		options: PaperIngestFlowOptions,
		profileId: string,
		resolved: { profileName: string; model: string },
		emitStatus: (status: string, label: string) => void,
	): AgentLoopRunOutcome {
		const conflicts = [...state.conflicts];
		if (state.errorMessage) conflicts.push(state.errorMessage);
		const notes = [...state.notes];

		const markdownSatisfied = !options.createArticleMarkdown
			|| (state.receipts.mineruPackage !== null
				&& Boolean(state.receipts.articleVaultPath)
				&& !state.titleConflict);
		const wikiSatisfied = !options.createArticleWiki || state.receipts.writes.length > 0;
		const identityConflict = state.identity?.status === "conflict";

		const status: PaperIngestFinalResult["status"] = state.cancelled
			? "failed"
			: (identityConflict || conflicts.length > 0)
				? "conflict"
				: (markdownSatisfied && wikiSatisfied)
					? "completed"
					: "failed";

		const loopStatus: AgentLoopResult["status"] = state.cancelled
			? "cancelled"
			: status === "completed"
				? "completed"
				: "failed";

		const result: PaperIngestFinalResult = {
			status,
			citekey: state.identity?.citekey || "",
			title: state.identity?.title || state.draft?.title || "",
			title_zh: state.identity?.title_zh || state.draft?.title_zh || "",
			articlePath: state.receipts.articleVaultPath,
			wikiPath: state.receipts.writes[0]?.path || "",
			filesWritten: [...state.journal.paths()],
			duplicates: [...state.duplicates],
			conflicts,
			notes,
		};

		emitStatus(
			status === "completed" ? "done" : state.cancelled ? "stopped" : "failed",
			describeOutcome(status, state.cancelled),
		);
		const traceWithResult = [
			...state.traces,
			"",
			`运行状态：${describeOutcome(status, state.cancelled)}`,
			formatStructuredResult(result),
			result.filesWritten.length
				? `写入文件：\n${result.filesWritten.map((path) => `- ${path}`).join("\n")}`
				: "",
		].filter(Boolean).join("\n");

		return {
			exitCode: status === "completed" ? 0 : 1,
			stdout: traceWithResult,
			stderr: "",
			events: [],
			result,
			loopStatus,
			filesWritten: [...state.journal.paths()],
			executionConfig: {
				backend: "direct-api",
				providerId: profileId,
				providerName: resolved.profileName,
				model: resolved.model,
				reasoningEffort: null,
				serviceTier: null,
			},
		};
	}
}

function describeOutcome(status: PaperIngestFinalResult["status"], cancelled: boolean): string {
	if (cancelled) return "已手动停止";
	switch (status) {
		case "completed": return "已完成";
		case "conflict": return "发现冲突，已安全停止";
		default: return "失败";
	}
}

/** Plugin-side title consistency gate on the published article. */
export async function articleHeadContainsTitle(
	deps: { app: { vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> } } },
	articleVaultPath: string,
	title: string,
): Promise<boolean> {
	const normalizedTitle = normalizeTitle(title);
	if (normalizedTitle.length < 8) return true;
	const file = deps.app.vault.getAbstractFileByPath(articleVaultPath);
	if (!file) return false;
	const content = await deps.app.vault.read(file);
	const head = normalizeTitle(content.slice(0, 6000));
	const prefixLength = Math.min(48, normalizedTitle.length);
	return head.includes(normalizedTitle.slice(0, prefixLength));
}

function normalizeTitle(value: string): string {
	return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function formatStructuredResult(result: PaperIngestFinalResult): string {
	const lines = [
		"结构化结果：",
		`- status: ${result.status}`,
		`- citekey: ${result.citekey || "（空）"}`,
		`- title: ${result.title || "（空）"}`,
		result.title_zh ? `- title_zh: ${result.title_zh}` : "",
		result.articlePath ? `- articlePath: ${result.articlePath}` : "",
		result.wikiPath ? `- wikiPath: ${result.wikiPath}` : "",
	];
	if (result.duplicates.length) lines.push(`- duplicates: ${result.duplicates.join("；")}`);
	if (result.conflicts.length) lines.push(`- conflicts: ${result.conflicts.join("；")}`);
	if (result.notes.length) lines.push(`- notes: ${result.notes.join("；")}`);
	return lines.filter(Boolean).join("\n");
}
