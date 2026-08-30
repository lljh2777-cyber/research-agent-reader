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
	buildPaperIngestSystemPrompt,
	buildPaperIngestTools,
	buildPaperIngestUserMessage,
	parsePaperIngestFinalResult,
	type PaperIngestFinalResult,
	type PaperIngestFlowOptions,
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
	}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface AgentRunHandle {
	cancel(): void;
}

interface ActiveAgentRun {
	handle: AgentRunHandle;
}

export interface AgentLoopRunOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	events: DashboardProcessEvent[];
	/** Structured final result when the loop completed with a valid payload. */
	result: PaperIngestFinalResult | null;
	loopStatus: AgentLoopResult["status"];
		filesWritten: readonly string[];
	executionConfig: ExecutionConfig;
}

const STEP_TITLES: Record<AgentLoopStep["kind"], string> = {
	model: "模型思考",
	tool: "工具调用",
	final: "任务完成",
	error: "出错",
};

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
		const retriever = this.deps.getLexicalRetriever();
		if (!retriever) throw new Error("知识库检索组件不可用");

		const cancelledRef = { value: false };
		this.activeRuns.set(runId, {
			handle: { cancel: () => { cancelledRef.value = true; } },
		});
		const emit = (event: DashboardProcessEvent): void => {
			hooks.onEvent?.(event);
		};
		const emitStatus = (status: string, label: string): void => {
			emit({ type: "status", stage: "agent-loop", status, label });
		};
		emitStatus("running", "轻量 Agent 已启动");

		const { tools, journal } = buildPaperIngestTools(
			{
				vault: { app: this.deps.app },
				http: {
					httpGetJson: async (url, timeoutMs) => {
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
					runHelper: (args) => this.deps.runMineruHelper(args),
				},
				tavily: {
					http: {
						httpRequest: async (request) => {
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
				lexicalRetriever: retriever,
			},
			options,
		);

		const timeoutMs = Math.max(
			60_000,
			Math.min(4 * 60 * 60 * 1000, (Math.round(settings.taskTimeoutMinutes) || 60) * 60 * 1000),
		);
		const loopResult = await runBoundedAgentLoop({
			system: buildPaperIngestSystemPrompt(options),
			user: buildPaperIngestUserMessage(options),
			tools,
			provider: resolved.provider,
			model: resolved.model,
			maxSteps: Math.max(3, Math.min(20, Math.round(settings.lightAgentMaxSteps) || 10)),
			timeoutMs,
			maxToolOutputChars: 80000,
			isCancelled: () => cancelledRef.value,
			onStep: (step) => {
				emitStatus(
					"running",
					[STEP_TITLES[step.kind] || step.kind, step.title, step.detail].filter(Boolean).join(" · "),
				);
			},
		});

		this.activeRuns.delete(runId);
		const structured = parsePaperIngestFinalResult(loopResult.final);
		const filesWritten = journal.paths();
		const success = loopResult.status === "completed" && structured !== null;
		emitStatus(success ? "done" : loopResult.status === "cancelled" ? "stopped" : "failed", describeLoopStatus(loopResult.status));
		const traceWithResult = [
			loopResult.trace,
			"",
			`运行状态：${describeLoopStatus(loopResult.status)}`,
			structured ? formatStructuredResult(structured) : "",
			filesWritten.length ? `写入文件：\n${filesWritten.map((path) => `- ${path}`).join("\n")}` : "",
			loopResult.error ? `错误：${loopResult.error}` : "",
		].filter(Boolean).join("\n");

		return {
			exitCode: success ? 0 : 1,
			stdout: traceWithResult,
			stderr: "",
			events: [],
			result: structured,
			loopStatus: loopResult.status,
			filesWritten,
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

function describeLoopStatus(status: AgentLoopResult["status"]): string {
	return {
		completed: "已完成",
		cancelled: "已手动停止",
		"budget-exhausted": "达到步数或时间预算上限",
		failed: "失败",
	}[status] || status;
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
