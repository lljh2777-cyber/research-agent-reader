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
	evaluateDraftPhase,
	computeIngestOutcomeStatus,
	mineruReadiness,
	parseIdentityResult,
	parseNoteDraft,
	resolveArticleVaultPath,
	resolveUniqueCitekey,
	runAuthorizedMineruExtract,
	validateIdentityReceipts,
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
		retrieve(
			question: string,
			expandedTerms?: string[],
			options?: { allowedPrefixes?: string[] },
		): Promise<Record<string, unknown>>;
	} | null;
	/** Absolute filesystem path of the active vault, or "" when unavailable. */
	getVaultRoot(): string;
	/** Filesystem existence probe for toolkit-side paths; injectable for tests. */
	pathExists(absolutePath: string): boolean;
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
	/** Identity/title/authorization blockers — safe stops, not failures. */
	conflicts: string[];
	/** Technical errors (provider, network, extraction, unexpected). */
	errors: string[];
	notes: string[];
}

export interface TaskRunArtifacts {
	articlePath: string;
	wikiPath: string;
	filesWritten: string[];
}

export interface AgentLoopRunOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	events: DashboardProcessEvent[];
	/** Structured result built from tool receipts. */
	result: PaperIngestFinalResult | null;
	loopStatus: AgentLoopResult["status"];
	/** Vault paths written/published during the run, for direct navigation. */
	filesWritten: readonly string[];
	artifacts: TaskRunArtifacts;
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
	errors: string[];
	duplicates: string[];
	journal: VaultWriteJournal;
	receipts: PaperIngestReceipts;
	identity: PaperIngestIdentity | null;
	draft: PaperIngestNoteDraft | null;
	titleConflict: boolean;
	duplicateNoOp: boolean;
	cancelled: boolean;
	/** Set when the total wall-clock budget timer aborted the run. */
	budgetAborted: boolean;
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

	/** Cancels every active run; called from plugin.onunload(). */
	shutdown(): void {
		for (const active of this.activeRuns.values()) {
			try {
				active.handle.cancel();
			} catch (cancelError) {
				console.warn("Could not cancel light-agent run during shutdown", cancelError);
			}
		}
		this.activeRuns.clear();
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
		// Hard wall-clock budget: when it fires the run-level signal aborts
		// everything (loops, HTTP, MinerU). Later phases may only run while
		// budget remains — never re-added via a minimum floor.
		const deadline = Date.now() + Math.max(
			60_000,
			Math.min(4 * 60 * 60 * 1000, (Math.round(settings.taskTimeoutMinutes) || 60) * 60 * 1000),
		);
		let budgetTimer: ReturnType<typeof setTimeout> | null = null;
		const state: IngestState = {
			traces: [],
			notes: [],
			conflicts: [],
			errors: [],
			duplicates: [],
			journal: new VaultWriteJournal(),
			receipts: { mineruPackage: null, articleVaultPath: "", writes: [] },
			identity: null,
			draft: null,
			titleConflict: false,
			duplicateNoOp: false,
			cancelled: false,
			budgetAborted: false,
		};
		this.activeRuns.set(runId, {
			handle: {
				cancel: () => {
					state.cancelled = true;
					abortController.abort();
				},
			},
		});
		budgetTimer = setTimeout(() => {
			state.budgetAborted = true;
			abortController.abort();
		}, Math.max(0, deadline - Date.now()));
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
			const toolDeps = this.buildToolDeps(settings, retriever, abortController.signal);
			const maxStepsPerPhase = Math.max(3, Math.min(20, Math.round(settings.lightAgentMaxSteps) || 10));
			const maxTokens = Math.max(512, Math.min(8192, Math.round(settings.lightAgentMaxOutputTokens) || 4096));
			const isCancelled = (): boolean => state.cancelled;
			// Raw remaining budget — never padded back up to a minimum, so the
			// total wall clock is a hard ceiling.
			const loopTimeout = (): number => Math.max(1_000, deadline - Date.now());
			const ensureBudget = (): boolean => {
				if (deadline - Date.now() >= 15_000) return true;
				state.errors.push("任务时间预算已耗尽，停止后续阶段");
				return false;
			};

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
				timeoutMs: loopTimeout(),
				maxToolOutputChars: 60000,
				signal: abortController.signal,
				isCancelled,
				onStep: onStep("身份核验"),
			});
			state.traces.push(identityLoop.trace);
			if (identityLoop.status !== "completed") {
				state.errors.push(deriveStopError(state, identityLoop));
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			try {
				state.identity = parseIdentityResult(identityLoop.final);
			} catch (identityError) {
				state.errors.push(identityError instanceof Error ? identityError.message : String(identityError));
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			if (!state.identity) {
				state.errors.push("阶段一未返回可解析的身份结果");
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			const identity = state.identity;
			state.conflicts.push(...identity.conflicts);
			state.duplicates.push(...identity.duplicates);
			state.notes.push(...identity.notes);

			// Gate: the model must have actually done the verification work.
			const receiptProblems = validateIdentityReceipts(identity, identityLoop.toolCalls);
			if (receiptProblems.length) {
				state.errors.push(`阶段一未满足插件侧凭据要求：${receiptProblems.join("；")}`);
				return this.finish(state, options, profileId, resolved, emitStatus);
			}

			if (identity.status === "conflict") {
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			if (identity.duplicateStatus === "possible") {
				state.conflicts.push(`疑似重复，需要人工确认：${identity.duplicates.join("；") || "见检索结果"}`);
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			if (identity.duplicateStatus === "exact") {
				state.duplicateNoOp = true;
				state.notes.push(`已存在完全相同文献，跳过生成：${identity.duplicates.join("；") || "见检索结果"}`);
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			emitStatus("running", `阶段一完成 · citekey ${identity.citekey}`);

			// Deterministic citekey uniqueness across vault and toolkit target.
			const citekeyCheck = await this.resolveCitekeyUniqueness(identity.citekey);
			if (citekeyCheck.renamed) {
				identity.citekey = citekeyCheck.citekey;
				state.notes.push(`citekey 已被占用，自动改为 ${citekeyCheck.citekey}`);
			}

			// ---- Phase 2: MinerU extraction (deterministic, authorized PDF only) ----
			if (options.createArticleMarkdown) {
				emitStatus("running", "阶段二 · MinerU 原文提取");
				if (!ensureBudget()) {
					return this.finish(state, options, profileId, resolved, emitStatus);
				}
				if (!options.remoteUploadConfirmed) {
					state.conflicts.push("用户未确认远程处理，跳过 MinerU 提取");
				} else if (!options.sourcePdfPath) {
					state.conflicts.push("未提供 PDF 路径，无法生成原文 Markdown");
				} else {
					const readiness = mineruReadiness(toolDeps.mineru);
					if (!readiness.ready) {
						state.notes.push(`无法生成原文 Markdown：${readiness.reason}`);
					} else {
						await this.runExtractionPhase(options, identity, toolDeps, abortController, deadline, state);
					}
				}
			}

			// ---- Phase 3: note draft fields (model loop) + plugin commit ----
			if (!ensureBudget()) {
				return this.finish(state, options, profileId, resolved, emitStatus);
			}
			const draftDecision = evaluateDraftPhase(
				options,
				state.receipts.articleVaultPath,
				state.titleConflict,
			);
			if (draftDecision.blocker) {
				state.conflicts.push(draftDecision.blocker);
			} else if (draftDecision.downgradeNote) {
				state.notes.push(draftDecision.downgradeNote);
			}
			if (draftDecision.run) {
				emitStatus("running", "阶段三 · 整理文章 Wiki 字段");
				const draftLoop = await runBoundedAgentLoop({
					system: buildDraftSystemPrompt(options, identity.citekey, identity.title),
					user: buildDraftUserMessage(identity.citekey, identity.title),
					tools: buildDraftTools(toolDeps),
					provider: resolved.provider,
					model: resolved.model,
					maxTokens,
					maxSteps: Math.min(maxStepsPerPhase, 8),
					timeoutMs: loopTimeout(),
					maxToolOutputChars: 60000,
					signal: abortController.signal,
					isCancelled,
					onStep: onStep("文章 Wiki"),
				});
				state.traces.push(draftLoop.trace);
				if (draftLoop.status !== "completed") {
					state.errors.push(deriveStopError(state, draftLoop));
					return this.finish(state, options, profileId, resolved, emitStatus);
				}
					state.draft = parseNoteDraft(draftLoop.final);
					if (!state.draft) {
						state.errors.push("阶段三未返回可解析的笔记字段");
					} else {
						state.notes.push(...state.draft.notes);
						// One resolved translation used for both the note and the
						// final result, so they can never diverge.
						const resolvedTitleZh = state.draft.title_zh || identity.title_zh || "";
						if (!resolvedTitleZh) {
							state.notes.push("title_zh 未能审校，笔记保留空值");
						}
						state.draft.title_zh = resolvedTitleZh;
						try {
						const receipt = await commitSourceNote(
							toolDeps.vault,
							identity.citekey,
							{
								title: identity.title || state.draft.title,
								title_zh: state.draft.title_zh,
								authors: identity.authors,
								year: identity.year,
								doi: identity.doi,
								researchQuestion: state.draft.researchQuestion,
								conclusion: state.draft.conclusion,
								motivation: state.draft.motivation,
								evidenceGaps: state.draft.evidenceGaps,
								notes: [],
							},
							"",
							{ signal: abortController.signal },
						);
						state.journal.record(receipt);
						state.receipts.writes = state.journal.receipts();
					} catch (commitError) {
						const message = commitError instanceof Error ? commitError.message : String(commitError);
						if (message.includes("已存在同名文件")) {
							state.conflicts.push(`笔记写入未完成：${message}`);
						} else {
							state.errors.push(`笔记写入失败：${message}`);
						}
					}
				}
			}

			return this.finish(state, options, profileId, resolved, emitStatus);
		} catch (error) {
			if (!state.cancelled) {
				state.errors.push(error instanceof Error ? error.message : String(error));
			}
			return this.finish(state, options, profileId, resolved, emitStatus);
		} finally {
			if (budgetTimer !== null) clearTimeout(budgetTimer);
			this.activeRuns.delete(runId);
		}
	}

	/** Publishes the MinerU package and binds the receipt to the active vault. */
	private async runExtractionPhase(
		options: PaperIngestFlowOptions,
		identity: PaperIngestIdentity,
		toolDeps: ReturnType<AgentLoopService["buildToolDeps"]>,
		abortController: AbortController,
		deadline: number,
		state: IngestState,
	): Promise<void> {
		const remaining = deadline - Date.now();
		if (remaining < 60_000) {
			state.errors.push("剩余时间预算不足以运行 MinerU 提取，已跳过");
			return;
		}
		const timeoutMs = Math.min(
			Math.max(60_000, Math.min(1800_000, options.mineruTimeoutSeconds * 1000)),
			remaining,
		);
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
					timeoutSeconds: Math.round(timeoutMs / 1000),
					includeSourcePdf: options.mineruIncludeSourcePdf,
				},
				{ signal: abortController.signal, timeoutMs },
			);
			const vaultRoot = this.deps.getVaultRoot();
			if (!vaultRoot) {
				state.errors.push("无法确定当前 Vault 的文件系统位置，无法将发布结果绑定到本次任务");
				return;
			}
			state.receipts.articleVaultPath = await resolveArticleVaultPath(
				toolDeps.vault,
				state.receipts.mineruPackage.packagePath,
				vaultRoot,
			);
			if (!state.receipts.articleVaultPath) {
				state.errors.push(
					`MinerU 发布位置（${state.receipts.mineruPackage.packagePath}）不在当前 Vault 内；结果未计入本次入库。请确认当前 Vault 即工具链目录下的 knowledge-base 文件夹（设置 → 工具链与运行环境）`,
				);
				return;
			}
			state.notes.push(`原文包已发布：${state.receipts.articleVaultPath.replace(/\/article\.md$/, "")}`);
			state.titleConflict = !(await articleHeadContainsTitle(
				toolDeps.vault,
				state.receipts.articleVaultPath,
				identity.title,
			));
			if (state.titleConflict) {
				state.conflicts.push(`article.md 开头与核验标题不一致：${identity.title}`);
			}
		} catch (mineruError) {
			if (state.cancelled) return;
			state.errors.push(
				`MinerU 提取失败：${mineruError instanceof Error ? mineruError.message : String(mineruError)}`,
			);
		}
	}

	/** Vault + toolkit publish target existence check for the citekey. */
	private async resolveCitekeyUniqueness(
		base: string,
	): Promise<{ citekey: string; renamed: boolean }> {
		const vault = this.deps.app.vault;
		const toolkitRoot = String(this.deps.getSettings().toolkitRoot || "").replace(/[\\/]+$/, "");
		const exists = async (citekey: string): Promise<boolean> => {
			const notePath = `wiki/sources/${citekey}.md`;
			const packagePaths = [
				`papers/${citekey}/article.md`,
				`knowledge-base/papers/${citekey}/article.md`,
			];
			if (vault.getAbstractFileByPath(notePath)) return true;
			for (const candidate of packagePaths) {
				if (await vault.adapter.exists(candidate, true)) return true;
			}
			if (toolkitRoot) {
				const toolkitPackage = `${toolkitRoot}/knowledge-base/papers/${citekey}`;
				if (this.deps.pathExists(toolkitPackage)) return true;
			}
			return false;
		};
		return resolveUniqueCitekey(base, exists);
	}

	private buildToolDeps(
		settings: DashboardSettings,
		lexicalRetriever: { retrieve(
			question: string,
			expandedTerms?: string[],
			options?: { allowedPrefixes?: string[] },
		): Promise<Record<string, unknown>> },
		runSignal: AbortSignal,
	) {
		// Wire the run-level signal into every HTTP request so user stops and
		// the wall-clock deadline abort in-flight calls immediately.
		const httpGetJson = async (
			url: string,
			timeoutMs: number,
			options?: { signal?: AbortSignal },
		) => {
			const signal = options?.signal || runSignal;
			const response = await this.deps.providerHttpRequest({
				url,
				method: "GET",
				headers: { Accept: "application/json" },
				body: null,
				timeoutMs,
				registerCancel: (cancel) => {
					if (signal.aborted) cancel();
					else signal.addEventListener("abort", cancel, { once: true });
				},
			});
			return { status: response.status, json: response.json, text: response.text };
		};
		return {
			vault: { app: this.deps.app },
			http: { httpGetJson },
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
							registerCancel: (cancel) => {
								if (runSignal.aborted) cancel();
								else runSignal.addEventListener("abort", cancel, { once: true });
							},
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
		const errors = [...state.errors];
		// Budget timeouts abort the run-level signal, which loops report as a
		// bare stop; reclassify them so the user sees the real reason.
		if (state.budgetAborted && !state.cancelled && !errors.some((item) => item.includes("时间预算"))) {
			errors.push("超过任务时间预算，运行已中止");
		}
		const notes = [...state.notes];

		const markdownSatisfied = state.duplicateNoOp
			|| !options.createArticleMarkdown
			|| (state.receipts.mineruPackage !== null
				&& Boolean(state.receipts.articleVaultPath)
				&& !state.titleConflict);
		const wikiSatisfied = state.duplicateNoOp
			|| !options.createArticleWiki
			|| state.receipts.writes.length > 0;
		const identityConflict = state.identity?.status === "conflict";

		const status = computeIngestOutcomeStatus({
			cancelled: state.cancelled,
			conflicts,
			errors,
			identityConflict,
			markdownSatisfied,
			wikiSatisfied,
		});
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
			errors,
			notes,
		};

		emitStatus(
			status === "completed" ? "done" : state.cancelled ? "stopped" : "failed",
			describeOutcome(status, state.cancelled),
		);
		const artifacts: TaskRunArtifacts = {
			articlePath: result.articlePath,
			wikiPath: result.wikiPath,
			filesWritten: [...result.filesWritten],
		};
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
			artifacts,
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

/** Loop-level stop reason, reclassified when the budget timer fired. */
function deriveStopError(state: { budgetAborted: boolean }, loop: AgentLoopResult): string {
	if (state.budgetAborted) return "超过任务时间预算，运行已中止";
	return loop.error || describeLoopStatus(loop.status);
}

function describeOutcome(status: PaperIngestFinalResult["status"], cancelled: boolean): string {
	if (cancelled) return "已手动停止";
	switch (status) {
		case "completed": return "已完成";
		case "conflict": return "发现冲突，已安全停止";
		default: return "失败";
	}
}

function describeLoopStatus(status: AgentLoopResult["status"]): string {
	return {
		cancelled: "已手动停止",
		"budget-exhausted": "达到步数或时间预算上限",
		failed: "运行失败",
		completed: "已完成",
	}[status] || status;
}

/** Plugin-side title consistency gate on the published article. */
export async function articleHeadContainsTitle(
	deps: { app: { vault: { getAbstractFileByPath(path: string): unknown; read(file: unknown): Promise<string> } } },
	articleVaultPath: string,
	title: string,
): Promise<boolean> {
	const normalizedTitle = normalizeTitle(title);
	// Empty or very short titles cannot pass the gate on their own.
	if (normalizedTitle.replace(/\s/g, "").length < 8) return false;
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
	if (result.errors.length) lines.push(`- errors: ${result.errors.join("；")}`);
	if (result.notes.length) lines.push(`- notes: ${result.notes.join("；")}`);
	return lines.filter(Boolean).join("\n");
}
