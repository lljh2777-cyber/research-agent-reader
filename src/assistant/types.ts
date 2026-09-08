import type { ReadingBackend, ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";
import type { KnowledgeResult, SearchOptions } from "../retrieval/types";
import type { LearningMatch } from "../curation/learning";
export interface AssistantSource { id: string; kind: "paper" | "knowledge"; path: string; label: string; text: string; hash: string; page?: number; start?: number; end?: number; role: string; }
export interface AssistantExecution {
	id: string; state: "waiting" | "running" | "succeeded" | "failed" | "interrupted" | "needs-review";
	detail: string; updated: string; nodeId?: string; reviewId?: string; path?: string; hash?: string; reused?: boolean; warning?: string;
}
export interface AssistantAction { id: string; kind: "curation" | "export" | "advance"; nodeIds: string[]; target: string; scope: "node" | "branch" | "session"; contextHash: string; state: "prepared" | "opened"; execution?: AssistantExecution; }
export interface AssistantCall { state: "running" | "done" | "failed" | "interrupted"; estimatedInput: number; input?: number; output?: number; cachedInput?: number; }
export interface AssistantRun {
	version: 1; id: string; sessionId: string; nodeId: string; profileId: string; model: string; question: string; created: string;
	state: "running" | "done" | "failed" | "interrupted"; answer: string; error: string; citations: string[];
	steps: { tool: string; arguments?: Record<string, unknown>; summary: string; cached: boolean; ok: boolean }[]; sources: AssistantSource[]; actions: AssistantAction[]; calls: AssistantCall[];
}
export interface AssistantStorage { list(): Promise<string[]>; read(id: string): Promise<string>; write(id: string, text: string): Promise<void>; }
export interface AssistantDependencies {
	workspace: ReadingWorkspaceService;
	backend(session: ReadingSession, profileId: string): ReadingBackend;
	search(query: string, options: SearchOptions): Promise<KnowledgeResult>;
	readFile(path: string): Promise<string>;
	learning(session: ReadingSession, nodeId: string, signal: AbortSignal): Promise<{ matches: LearningMatch[]; warnings: string[] }>;
	outcomes(session: ReadingSession): Promise<Map<string, { label: string; path: string }[]>>;
	resolveAction?(sessionId: string, action: AssistantAction): Promise<AssistantExecution | undefined>;
	subscribeActions?(changed: () => void): () => void;
}
