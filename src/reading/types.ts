export const READING_VIEW_TYPE = "research-interactive-reading";
export type ReadingStatus = "pending" | "running" | "done" | "failed" | "interrupted";
export interface ReadingSource {
	kind: "pdf" | "article";
	path: string;
	fingerprint: string;
	title: string;
}
export interface ReadingEvidence {
	id: string;
	kind: "paper" | "vault";
	path: string;
	label: string;
	text: string;
	page?: number;
	start?: number;
	end?: number;
	asset?: string;
	visualInspected?: boolean;
}
export interface ReadingQuote { nodeId: string; text: string; start: number; end: number }
export interface ReadingNode {
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
	provider?: string;
	model?: string;
}
export interface ReadingBranch {
	id: string;
	parentNodeId: string;
	mainSnapshot: string;
	mainHeadId: string | null;
	ancestorContext: string;
	nodeIds: string[];
	summary: string;
	summarizedCount: number;
}
export interface ReadingWindow {
	key: string; nodeId: string; pinned: boolean; minimized: boolean;
	x: number; y: number; width: number; height: number;
}
export interface ReadingSession {
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
	ui: {
		mode: "split" | "map"; split: number; selectedId: string;
		zoom: number; scrollX: number; scrollY: number;
		collapsed: string[]; drafts: Record<string, string>; windows: ReadingWindow[];
	};
}
export interface ReadingResult {
	title: string; content: string; evidenceIds: string[];
	outline?: string[]; mainSummary?: string; completed?: boolean;
}
export interface ReadingImage { evidenceId: string; dataUrl: string }
export interface ReadingBackendRequest {
	system: string; prompt: string; images: ReadingImage[];
	signal: AbortSignal; onDelta?: (text: string) => void;
}
export interface ReadingBackend {
	name: string; model: string; images: boolean;
	complete(request: ReadingBackendRequest): Promise<string>;
}
