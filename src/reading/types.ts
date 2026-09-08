export const READING_VIEW_TYPE = "research-interactive-reading";
export type ReadingStatus = "pending" | "running" | "done" | "failed" | "interrupted";
export type ReadingLearningState = "unmarked" | "understood" | "revisit" | "question";
export type ReadingTeachingStyle = "balanced" | "foundations" | "methods" | "evidence";
export interface ReadingUsageEntry {
	id: string; stage: "planning" | "selection" | "answer" | "memory"; model: string; started: string;
	state: "running" | "done" | "failed" | "interrupted" | "cached";
	estimatedInput: number; estimatedOutput?: number; input?: number; output?: number; cachedInput?: number;
}
export interface ReadingEvidenceSelection { ids: string[]; query: string; needsVisual: boolean; vaultQuery?: string; }
export interface ReadingEvidenceView {
	history: { nodeId: string; evidenceId: string }[]; cursor: number;
	x: number; y: number; width: number; height: number;
}
export interface ReadingSource {
	kind: "pdf" | "article" | "code";
	code?: import("../code-reading/source").CodeSnapshot;
	path: string;
	fingerprint: string;
	title: string;
}
export interface ReadingEvidence {
	id: string;
	kind: "paper" | "vault" | "code";
	startLine?: number;
	endLine?: number;
	language?: import("../code-reading/source").CodeLanguage;
	path: string;
	label: string;
	text: string;
	page?: number;
	start?: number;
	end?: number;
	asset?: string;
	visualInspected?: boolean;
	role?: string;
	heading?: string;
	origins?: string[];
	sourceHash?: string;
}
export interface ReadingQuote { nodeId: string; text: string; start: number; end: number }
export interface ReadingCodeQuote { evidenceId: string; path: string; sourceHash: string; text: string; start: number; end: number; startLine: number; endLine: number }
export interface ReadingNode {
	requestWeb?: boolean;
	web?: { mode: "native" | "tavily"; query: string; sources: { url: string; title: string; content?: string }[]; warning: string; };
	correction?: { of: string; originalHash: string; reason: string };
	acceptedCorrectionId?: string;
	providedEvidenceIds?: string[];
	providedImageIds?: string[];
	usage?: ReadingUsageEntry[];
	selectionCache?: { key: string; value: ReadingEvidenceSelection };
	learningState?: ReadingLearningState;
	reviewedEvidence?: string[];
	id: string;
	parentId: string | null;
	branchId: string | null;
	question: string;
	title: string;
	content: string;
	status: ReadingStatus;
	error: string;
	createdAt: string;
	evidence: ReadingEvidence[];
	quote?: ReadingQuote;
	codeQuote?: ReadingCodeQuote;
	provider?: string;
	model?: string;
	retrieval?: { query: string; paths: string[]; error?: string; label?: string; warnings?: string[] };
}
export interface ReadingBranch {
	parentContext?: string;
	id: string;
	parentNodeId: string;
	mainSnapshot: string;
	mainHeadId: string | null;
	ancestorContext: string;
	ancestorSummary?: string;
	nodeIds: string[];
	summary: string;
	summarizedCount: number;
}
export interface ReadingWindow {
	key: string; nodeId: string; pinned: boolean; minimized: boolean;
	x: number; y: number; width: number; height: number;
	scrollTop?: number;
}
export interface ReadingModule { title: string; question: string; evidenceIds: string[]; }
export interface ReadingModulePlan { version: 1; modules: ReadingModule[]; }
export interface ReadingSession {
	sourceRelocations?: { from: string; to: string; date: string; fingerprint: string }[];
	modulePlan?: ReadingModulePlan;
	teachingStyle?: ReadingTeachingStyle;
	version: 1;
	id: string;
	title: string;
	source: ReadingSource;
	createdAt: string;
	updatedAt: string;
	nodes: ReadingNode[];
	branches: ReadingBranch[];
	mainIds: string[];
	outline: string[];
	mainSummary: string;
	completed: boolean;
	backend: string;
	model: string;
	demo?: boolean;
	purpose?: "reading" | "demo" | "test";
	archived?: boolean;
	pinned?: boolean;
	lastOpenedAt?: string;
	ui: {
		webDrafts?: Record<string, boolean>;
		mode: "split" | "map"; split: number; selectedId: string;
		mainFocusId?: string; mainScroll?: number; pendingQuote?: ReadingQuote;
		mainComposerExpanded?: boolean;
		zoom: number; scrollX: number; scrollY: number;
		collapsed: string[]; drafts: Record<string, string>; windows: ReadingWindow[];
		learningFilter?: ReadingLearningState | "all";
		evidenceView?: ReadingEvidenceView;
	};
}
export interface ReadingResult {
	title: string; content: string; evidenceIds: string[];
	outline?: string[]; mainSummary?: string; completed?: boolean;
}
export interface ReadingImage { evidenceId: string; dataUrl: string }
export interface ReadingBackendRequest {
	webSearch?: import("../types/contracts").NativeWebSearchProtocol;
	disableReasoning?: boolean;
	schema?: Record<string, unknown>;
	system: string; prompt: string; images: ReadingImage[];
	signal: AbortSignal; onDelta?: (text: string) => void;
	maxTokens?: number;
	onUsage?: (usage: { input?: number; output?: number; cachedInput?: number }) => void;
}
export interface ReadingBackend {
	webSearch?: () => import("../services/web-search").WebSearchBackendResolution;
	name: string; model: string; images: boolean;
	complete(request: ReadingBackendRequest): Promise<string>;
}
