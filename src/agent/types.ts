import type { LLMProvider } from "../providers/adapters";

/**
 * Execution context handed to every tool call. The loop owns the abort
 * controller: user cancellation and the wall-clock deadline both abort the
 * same signal, so long-running tools (MinerU subprocess) can stop promptly.
 */
export interface AgentToolContext {
	signal: AbortSignal;
	deadline: number;
	remainingMs(): number;
}

/**
 * A tool the bounded agent loop may call. Tools are the only way the model
 * can observe the vault or act on it; every capability boundary (path scope,
 * host allowlist, write permission) is enforced inside the tool itself, never
 * trusted from model output.
 */
export interface AgentTool {
	name: string;
	description: string;
	/** JSON-schema-ish parameter hints rendered into the loop prompt. */
	parameters: Record<string, string>;
	required?: string[];
	execute(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
}

export interface AgentToolResult {
	/** Tool output handed back to the model (truncated by the loop budget). */
	output: string;
	/** Human-readable one-line summary kept in the run trace. */
	summary?: string;
	/**
	 * Tool-owned facts kept separately from model-visible prose. The loop
	 * normalizes and bounds this object before recording it as a receipt, so
	 * semantic gates can consume typed observations instead of parsing output.
	 */
	receiptData?: AgentToolReceiptData;
}

/** One path/title pair observed by a tool (for example a Vault search hit). */
export interface AgentToolReceiptCandidate {
	path: string;
	title: string;
}

/** One title/DOI pair and its supporting bibliographic metadata. */
export interface AgentToolReceiptBibliographicRecord {
	title: string;
	doi: string;
	authors: string;
	year: string;
}

/**
 * Structured facts emitted by trusted tool implementations. Every member is
 * optional because different tools observe different kinds of evidence.
 */
export interface AgentToolReceiptData {
	query?: string;
	queryTerms?: string[];
	titles?: string[];
	dois?: string[];
	paths?: string[];
	candidates?: AgentToolReceiptCandidate[];
	bibliographicRecords?: AgentToolReceiptBibliographicRecord[];
}

export interface AgentLoopTurn {
	role: "user" | "assistant";
	content: string;
}

export interface AgentLoopRequest {
	system: string;
	user: string;
	tools: readonly AgentTool[];
	provider: LLMProvider;
	model: string;
	/** Explicit per-turn output token cap; never leave it to provider defaults. */
	maxTokens?: number;
	/** Hard cap on loop turns; each turn is one provider completion. */
	maxSteps?: number;
	/** Wall-clock budget for the whole loop in milliseconds. */
	timeoutMs?: number;
	/** Cap on cumulative tool output fed back to the model, in characters. */
	maxToolOutputChars?: number;
	/** Max characters per single tool result. */
	maxToolResultChars?: number;
	/** Optional timeout for each provider turn; still capped by the loop deadline. */
	providerTimeoutMs?: number;
	/**
	 * Run-level abort signal owned by the caller. When it fires, the loop's
	 * internal signal aborts too — including while a tool is executing — so
	 * cancellation reaches HTTP requests and subprocesses immediately.
	 */
	signal?: AbortSignal;
	/** Returns true when the run has been cancelled by the user. */
	isCancelled?(): boolean;
	/** Progress callback for live UI updates. */
	onStep?(step: AgentLoopStep): void;
}

export type AgentLoopStepKind = "model" | "tool" | "final" | "error";

export interface AgentLoopStep {
	kind: AgentLoopStepKind;
	/** Model turn number, 1-based. */
	step: number;
	title: string;
	detail?: string;
}

export type AgentLoopStatus = "completed" | "cancelled" | "budget-exhausted" | "failed";

/** One observed tool execution, kept as a plugin-side receipt. */
export interface AgentToolCallReceipt {
	tool: string;
	ok: boolean;
	/** Compact argument summary for receipt checks (e.g. the queried DOI). */
	argsSummary: string;
	/** Tool-owned result summary (counts, verified DOI, or read range). */
	resultSummary?: string;
	/** Bounded diagnostic excerpt; semantic gates use structured data below. */
	evidencePreview?: string;
	/** Bounded, tool-owned observations for plugin-side semantic gates. */
	data?: AgentToolReceiptData;
}

export interface AgentLoopResult {
	status: AgentLoopStatus;
	/** Final JSON payload produced by the model, when it finished properly. */
	final: Record<string, unknown> | null;
	/** Raw final text when the model did not produce parseable JSON. */
	finalText: string;
	/** Full human-readable trace of the run (tool calls and results). */
	trace: string;
	steps: AgentLoopStep[];
	/** Plugin-observed tool receipts, used to gate self-reported success. */
	toolCalls: AgentToolCallReceipt[];
	providerModel: string;
	error: string;
}
