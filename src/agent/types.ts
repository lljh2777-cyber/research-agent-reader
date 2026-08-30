import type { LLMProvider } from "../providers/adapters";

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
	execute(args: Record<string, unknown>): Promise<AgentToolResult>;
}

export interface AgentToolResult {
	/** Tool output handed back to the model (truncated by the loop budget). */
	output: string;
	/** Human-readable one-line summary kept in the run trace. */
	summary?: string;
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
	maxTokens?: number;
	/** Hard cap on loop turns; each turn is one provider completion. */
	maxSteps?: number;
	/** Wall-clock budget for the whole loop in milliseconds. */
	timeoutMs?: number;
	/** Cap on cumulative tool output fed back to the model, in characters. */
	maxToolOutputChars?: number;
	/** Max characters per single tool result. */
	maxToolResultChars?: number;
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

export interface AgentLoopResult {
	status: AgentLoopStatus;
	/** Final JSON payload produced by the model, when it finished properly. */
	final: Record<string, unknown> | null;
	/** Raw final text when the model did not produce parseable JSON. */
	finalText: string;
	/** Full human-readable trace of the run (tool calls and results). */
	trace: string;
	steps: AgentLoopStep[];
	providerModel: string;
	error: string;
}
