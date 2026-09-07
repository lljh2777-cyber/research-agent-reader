export type RetrievalMode = "lexical" | "rerank" | "hybrid";
export type EvidenceRole = "evidence" | "background" | "navigation" | "speculation" | "provenance";
export const ROLE_LABELS: Record<EvidenceRole, string> = { evidence: "论文依据", background: "背景解释", navigation: "导航线索", speculation: "研究设想", provenance: "来源与核验边界" };
export const EMBEDDING_MODEL = "BAAI/bge-m3";
export const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
export const DIMENSIONS = 1024;
export const INDEX_VERSION = 1;
export const KNOWLEDGE_PREFIXES = ["sources", "concepts", "methods", "datasets", "synthesis", "mocs", "projects", "entities", "code", "r", "linux"].map((name) => "wiki/" + name + "/");
export interface KnowledgeDocument {
	path: string; title: string; text: string; hash: string; aliases: string[];
	doi: string; year: string; authors: string; origins: string[]; depth: string; basis: string;
}
export interface KnowledgeChunk {
	id: string; vectorKey: string; path: string; hash: string; title: string; heading: string;
	start: number; end: number; text: string; input: string; role: EvidenceRole; origins: string[]; depth: string; basis: string;
}
export interface KnowledgeHit extends KnowledgeChunk { score: number; }
export interface KnowledgeResult {
	mode: RetrievalMode; hits: KnowledgeHit[]; warnings: string[]; scope: string[] | null;
	documents: number; indexedChunks: number; totalChunks: number;
}
export interface SearchOptions { signal?: AbortSignal; paperPaths?: string[]; identityQuery?: string; limit?: number; }
export interface RetrievalModels {
	embed(input: string[], signal?: AbortSignal): Promise<Float32Array[]>;
	rerank(query: string, input: string[], signal?: AbortSignal): Promise<Array<{ index: number; score: number }>>;
}
export interface VectorSnapshot { version: number; model: string; updated: string; vectors: Map<string, Float32Array>; documentHashes: Record<string, string>; }
export interface VectorStorage { read(): Promise<VectorSnapshot | null>; write(snapshot: VectorSnapshot): Promise<void>; }
export interface IndexStatus { state: "idle" | "building" | "ready" | "interrupted" | "error"; done: number; total: number; documents: number; changed: number; updated: string; message: string; }
