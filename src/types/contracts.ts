import type { IncomingHttpHeaders } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { App, TFile } from "obsidian";

import type { DashboardAction, ReasoningEffort } from "../actions";
import type {
	ChatMessage,
	CliBackendId,
	ProviderCapabilities,
	ProviderTypeId,
} from "../config";
import type {
	QueryCitationValidation,
	QueryRetrievalPath,
	QueryVaultSource,
	QueryWebSource,
	VaultImageAttachment,
} from "../query/normalization";
import type { DashboardSettings } from "../runtime/settings";
import type { ProviderModel } from "../providers/shared";

export type ServiceTier = "default" | "fast";

export interface ExecutionOverrides {
	backend?: CliBackendId;
	model?: string;
	reasoningEffort?: ReasoningEffort | string;
	serviceTier?: ServiceTier;
}

export interface ExecutionConfig {
	backend?: CliBackendId | "direct-api";
	providerId?: string;
	providerName?: string;
	providerType?: ProviderTypeId;
	model: string;
	reasoningEffort: ReasoningEffort | string | null;
	serviceTier: ServiceTier | null;
	modelSource?: string;
	reasoningSource?: string;
}

export interface CodexExecutionConfig extends ExecutionConfig {
	backend?: CliBackendId;
	reasoningEffort: ReasoningEffort | string;
	serviceTier: ServiceTier;
	retrievalMode?: QueryRetrievalMode;
	timeoutSeconds?: number;
}

export interface CliDiscoveredModel {
	id: string;
	label: string;
	description?: string;
	isDefault?: boolean;
	supportedReasoningEfforts?: string[];
	supportsFast: boolean;
}

export interface CliModelDiscoveryResult {
	backendId: CliBackendId;
	models: CliDiscoveredModel[];
	effectiveModel: string;
	source: string;
	complete: boolean;
	message?: string;
	discoveredAt: string;
}

export type TaskRunStatus =
	| "queued"
	| "running"
	| "done"
	| "failed"
	| "interrupted";

export interface TaskRun {
	id: string;
	actionId: string;
	label: string;
	agent: string;
	summary: string;
	executionConfig: ExecutionConfig | null;
	status: TaskRunStatus;
	startedAt: string;
	finishedAt: string;
	exitCode: number | null;
	output: string;
	outputPath?: string;
	error: string;
}

export type TaskRunUpdate = Partial<
	Pick<TaskRun, "status" | "exitCode" | "output" | "error" | "summary">
>;

export interface DashboardProcessEvent {
	schema_version?: string;
	type: string;
	stage?: string;
	mode?: string;
	status?: string;
	label?: string;
	path?: string;
	change_count?: number;
	violation_count?: number;
	rollback_error_count?: number;
	delta?: string;
	payload?: Record<string, unknown>;
}

export interface DashboardProcessResult {
	exitCode: number;
	signal: string;
	stdout: string;
	stderr: string;
	events: DashboardProcessEvent[];
}

export interface DashboardProcessHooks {
	onEvent?: (event: DashboardProcessEvent) => void;
	onStdout?: (chunk: string) => void;
	onStderr?: (line: string) => void;
}

export type PracticeLanguage = "python" | "r";

export interface CodePracticeRequest {
	run_id: string;
	language: PracticeLanguage;
	context_code: string;
	code: string;
	working_directory: string;
	timeout_seconds: number;
}

export interface CodePracticeResult {
	run_id: string;
	status: "idle" | "running" | "success" | "failed" | "timeout" | "stopped";
	language: PracticeLanguage;
	exit_code: number | null;
	duration_ms: number;
	stdout: string;
	stderr: string;
	figures: string[];
	runner_stderr?: string;
}

export interface PracticeNotePayload {
	title: string;
	goal: string;
	notes: string;
	language: PracticeLanguage;
	cells: Array<{
		code: string;
		result: CodePracticeResult | null;
		executionCount: number | null;
	}>;
	relatedNotePath: string;
}

export interface ActivePracticeRun {
	child: ChildProcessWithoutNullStreams;
	stopPath: string;
}

export interface DirectQueryRunToken {
	cancelled: boolean;
	abort?: () => void;
}

export interface ProviderRuntimeEntry {
	status?: "idle" | "models" | "testing" | "done";
	models?: ProviderModel[];
	result?: ProviderConnectionTestResult;
}

export type QueryRetrievalMode = "vault" | "web";
export type QueryMessageRole = "user" | "assistant";
export type QueryMessageStatus =
	| "pending"
	| "stopping"
	| "done"
	| "failed"
	| "interrupted";

export interface QueryMessage {
	id: string;
	role: QueryMessageRole;
	content: string;
	attachments?: VaultImageAttachment[];
	status: QueryMessageStatus;
	progress?: string;
	createdAt: string;
	runId?: string;
	retrievalTrace?: Record<string, unknown> | null;
	vaultSources?: QueryVaultSource[];
	webSources?: QueryWebSource[];
	citationValidation?: QueryCitationValidation;
	retrievalPath?: QueryRetrievalPath;
	retrievalMode?: QueryRetrievalMode;
	queryBackendId?: string;
	providerName?: string;
	model?: string;
	error?: string;
}

export interface QuerySession {
	id: string;
	title: string;
	retrievalMode: QueryRetrievalMode;
	queryBackendId: string;
	createdAt: string;
	updatedAt: string;
	messages: QueryMessage[];
}

export interface ProviderRuntimeConfig {
	id: string;
	name: string;
	type: ProviderTypeId | "codex-cli";
	baseUrl: string;
	model: string;
	secretId?: string;
	timeoutSeconds: number;
	capabilities?: Partial<ProviderCapabilities>;
}

export interface ProviderChatRequest {
	model?: string;
	messages: readonly ChatMessage[];
	maxTokens?: number;
}

export interface ProviderRequestOptions {
	registerCancel?: (cancel: () => void) => void;
	timeoutMs?: number;
}

export interface ProviderCompletion {
	text: string;
	raw?: Record<string, unknown>;
}

export interface ProviderHttpRequestOptions extends ProviderRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export interface ProviderHttpResponse {
	status: number;
	endpoint: string;
	headers: IncomingHttpHeaders;
	text: string;
	json: Record<string, unknown> | null;
}

export interface ProviderHttpStreamOptions extends ProviderRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
	maxResponseBytes?: number;
	format: "sse" | "ndjson";
	onEvent: (data: string) => void;
}

export interface ProviderHttpStreamResponse {
	status: number;
	endpoint: string;
	headers: IncomingHttpHeaders;
}

export interface NormalizedProviderError {
	type: string;
	status: number;
	endpoint: string;
	message: string;
}

export interface ProviderCapabilityCheck {
	supported: boolean;
	verified: boolean;
	error?: string;
	note?: string;
	protocol?: string;
	preview?: string;
}

export interface ProviderConnectionTestResult {
	ok: boolean;
	type: string;
	provider?: ProviderTypeId | CliBackendId;
	endpoint?: string;
	model: string;
	modelExists?: boolean | null;
	modelCount?: number;
	status?: number;
	message?: string;
	streaming?: ProviderCapabilityCheck;
	pdf?: ProviderCapabilityCheck;
	vision?: ProviderCapabilityCheck;
	webSearch?: ProviderCapabilityCheck;
	responsePreview?: string;
	responseTimeMs: number;
	testedAt: string;
}

export interface LintSummary {
	score?: number;
	errors?: number;
	warnings?: number;
	info?: number;
}

export interface LintReport {
	generated_at: string;
	summary?: LintSummary;
	findings?: LintFinding[];
}

export interface LintFinding {
	severity: "error" | "warning" | "info";
	category: string;
	code: string;
	path: string;
	message: string;
	fixable?: boolean;
}

export interface LintStatus {
	latest: LintReport | null;
	error: string;
}

export interface OkfExportLatest {
	generated_at?: string;
	conformant?: boolean;
	concept_count?: number;
	unresolved_link_count?: number;
}

export interface OkfExportStatus {
	exporterAvailable: boolean;
	latest: OkfExportLatest | null;
	error: string;
}

export interface PluginHost {
	app: App;
	settings: DashboardSettings;
	normalizeProviderError(error: unknown): NormalizedProviderError;
	providerHttpRequest(options: ProviderHttpRequestOptions): Promise<ProviderHttpResponse>;
	providerHttpStream(options: ProviderHttpStreamOptions): Promise<ProviderHttpStreamResponse>;
	probeCodexCliConnection(): Promise<ProviderConnectionTestResult>;
	getTaskRuns(): TaskRun[];
	getTaskRun(runId: string): TaskRun | null;
	getTaskRunOutput(run: TaskRun): string;
	getLintStatus(): LintStatus;
	getOkfExportStatus(): OkfExportStatus;
	isActionRunning(actionId: string): boolean;
	getModelLabel(model: string): string;
	getReasoningLabel(reasoningEffort: string): string;
	resolveActionExecutionConfig(
		action: DashboardAction,
		overrides?: ExecutionOverrides,
	): CodexExecutionConfig;
	resolveCliActionExecutionConfig(
		action: DashboardAction,
		backendId: CliBackendId,
		overrides?: ExecutionOverrides,
	): CodexExecutionConfig;
	isCliBackendAvailable(backendId: CliBackendId): boolean;
	getCliModelDiscovery(backendId: CliBackendId): CliModelDiscoveryResult | null;
	discoverCliModels(
		backendId: CliBackendId,
		force?: boolean,
	): Promise<CliModelDiscoveryResult>;
	startTaskRun(
		action: DashboardAction,
		summary: string,
		executionConfig?: ExecutionConfig | null,
	): Promise<TaskRun>;
	finishTaskRun(runId: string, updates: TaskRunUpdate): Promise<TaskRun | null>;
	getQuerySessions(): QuerySession[];
	getActiveQuerySession(): QuerySession;
	createQuerySession(): Promise<QuerySession>;
	setActiveQuerySession(sessionId: string): Promise<void>;
	clearActiveQuerySession(): Promise<void>;
	deleteActiveQuerySession(): Promise<QuerySession | null>;
}

export interface VaultRecord {
	file: TFile;
	path: string;
	name: string;
	text: string;
	frontmatter: Record<string, unknown>;
	hasFrontmatter: boolean;
	type: string;
	tags: string[];
	mtime: number;
	ctime: number;
}
