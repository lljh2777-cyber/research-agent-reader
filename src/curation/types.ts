import type { ReadingSource } from "../reading/types";
import type { StructuredReadingLocation } from "../reading/structured-source";

export const CURATION_RULE_VERSION = "curation-v2";
export type SuggestionKind = "add" | "replace" | "covered" | "condition" | "conflict" | "insufficient";
export const SUGGESTION_LABELS: Record<SuggestionKind, string> = { add: "可以补充", replace: "段落修订", covered: "已有内容覆盖", condition: "条件不同", conflict: "可能存在冲突", insufficient: "证据不足" };
export interface CurationParagraph { id: string; heading: string; start: number; end: number; text: string; }
export interface CurationEvidence { id: string; kind: "paper" | "vault"; path: string; hash: string; text: string; label: string; role: string; depth: string; origins: string[]; start?: number; end?: number; page?: number; visual?: boolean; evidenceId?: string; structured?: StructuredReadingLocation; quotes?: { id: string; start: number; end: number; text: string }[]; }
export interface CurationCitation { id: string; quote: string; quoteId?: string; }
export interface CurationSuggestion { id: string; kind: SuggestionKind; modelKind?: SuggestionKind; comparison?: { targetQuote: string; evidenceId: string }; paragraphId: string; claim: string; text: string; reason: string; citations: CurationCitation[]; warnings: string[]; applicable: boolean; decision: "pending" | "ignored" | "applied"; }
export interface CurationUsage { kind: "reported" | "estimated"; input?: number; output?: number; cachedInput?: number; calls: number; model: string; note?: string; }
export interface CurationContext {
	answerExcerpt?: { version: 1; snapshot: import("../learning/answer-excerpts").AnswerExcerptFile; paragraphId: string; roles: import("./answer-excerpt").AnswerContentRole[] };
	/** Independent manual input; an empty sessionId is intentional and never enters the reading repository. */
	excerpt?: { version: 1; snapshot: import("../annotations/excerpt-library").ExcerptSnapshot; paragraphId: string; includeManual: boolean; sourceMode: "markdown" | "article" | "structured" };
	ruleVersion?: string;
	selection?: { mode: string; candidates: number; selected: number };
	key: string; sessionId: string; nodeIds: string[]; learningHash: string; title: string; source: ReadingSource;
	target: { path: string; title: string; text: string; hash: string; paragraphs: CurationParagraph[] };
	evidence: CurationEvidence[]; backendId: string; backendName: string; model: string; prompt: string; estimate: number; sourceCompatible: boolean; warnings: string[];
}
export interface CurationReview {
	version: 1; id: string; context: CurationContext; created: string; updated: string;
	state: "generating" | "ready" | "failed" | "interrupted" | "stale";
	suggestions: CurationSuggestion[]; usage: CurationUsage; error: string;
}
export interface RevisionWrite { path: string; before: string | null; after: string; beforeHash: string | null; afterHash: string; role: "target" | "index" | "log"; }
export interface CurationRevision {
	version: 1; id: string; reviewId: string; suggestionIds: string[]; created: string; updated: string;
	state: "prepared" | "applying" | "applied" | "recovery"; writes: RevisionWrite[]; error: string; undoOf?: string; needsReview?: string;
}
export interface CurationRecordStore {
	list(kind: "reviews" | "revisions"): Promise<string[]>;
	read(kind: "reviews" | "revisions", id: string): Promise<unknown>;
	write(kind: "reviews" | "revisions", record: CurationReview | CurationRevision): Promise<void>;
}
