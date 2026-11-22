import type { PaperTrace } from "../reading/paper-agent";
import type { ExcerptReceipt, ExcerptRevision } from "./excerpt";
import type { PdfExcerptReceipt } from "./pdf-excerpt";
import type { BilingualReceipt } from "./bilingual";
import type { AnnotationColor, AnnotationColorChoice } from "./colors";
export type AnnotationArchiveStatus = "none" | "pending" | "completed" | "failed";

export interface AnnotationCliCallReceipt {
	requestedModel: string;
	reportedModel?: string;
	usage?: Record<string, number>;
	costUsd?: number;
}

export interface AnnotationCliReceipt extends AnnotationCliCallReceipt {
	/** A separate, intentional candidate-selection call, never an automatic retry. */
	evidenceSelection?: AnnotationCliCallReceipt;
}

export interface AnnotationSelection {
	sourcePath: string;
	selectedText: string;
	section: string;
	context: string;
	sourceStart: number;
	sourceEnd: number;
	prefix: string;
	suffix: string;
	isTableCell: boolean;
	anchorRect: DOMRect;
	sourceRevision?: ExcerptRevision;
	pdfExcerpt?: PdfExcerptReceipt;
	bilingual?: BilingualReceipt;
	/** A live manually paired Markdown pane saves annotations without editing the source. */
	detached?: boolean;
	/** UI-only notice when a partial rendered link/format span was expanded. */
	linkSelectionExpanded?: boolean;
}

export interface AnnotationRecord {
	paperTraces?: PaperTrace[];
	color?: AnnotationColor;
	id: string;
	annotationPath: string;
	sourcePath: string;
	selectedText: string;
	section: string;
	/** Detached annotations retain their source position without editing the source. */
	sourceAnchor?: { start: number; end: number; prefix: string; suffix: string };
	excerpt?: ExcerptReceipt;
	/** Legacy excerpts without this flag remain listed. */
	excerptListed?: boolean;
	pdfExcerpt?: PdfExcerptReceipt;
	bilingual?: BilingualReceipt;
	manualText: string;
	aiText: string;
	aiEdited?: boolean;
	aiProvider: string;
	aiModel: string;
	aiCli?: AnnotationCliReceipt;
	createdAt: string;
	updatedAt: string;
	archiveStatus: AnnotationArchiveStatus;
	archiveTargets: string[];
	archiveRunId: string;
	archiveError: string;
}

export interface AnnotationExplanation {
	trace?: PaperTrace;
	text: string;
	provider: string;
	model: string;
	cli?: AnnotationCliReceipt;
}

export interface AnnotationDraft {
	paperTraces?: PaperTrace[];
	excerptListed?: boolean;
	aiEdited?: boolean;
	color?: AnnotationColorChoice;
	manualText?: string;
	aiText?: string;
	aiProvider?: string;
	aiModel?: string;
	aiCli?: AnnotationCliReceipt;
}

export interface AnnotationSectionMarker {
	sourcePath: string;
	lineStart: number;
	lineEnd: number;
}
