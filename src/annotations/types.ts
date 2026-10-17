import type { ExcerptReceipt, ExcerptRevision } from "./excerpt";
import type { PdfExcerptReceipt } from "./pdf-excerpt";
import type { BilingualReceipt } from "./bilingual";
export type AnnotationArchiveStatus = "none" | "pending" | "completed" | "failed";

export interface AnnotationCliReceipt {
	requestedModel: string;
	reportedModel?: string;
	usage?: Record<string, number>;
	costUsd?: number;
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
	id: string;
	annotationPath: string;
	sourcePath: string;
	selectedText: string;
	section: string;
	/** Detached annotations retain their source position without editing the source. */
	sourceAnchor?: { start: number; end: number; prefix: string; suffix: string };
	excerpt?: ExcerptReceipt;
	pdfExcerpt?: PdfExcerptReceipt;
	bilingual?: BilingualReceipt;
	manualText: string;
	aiText: string;
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
	text: string;
	provider: string;
	model: string;
	cli?: AnnotationCliReceipt;
}

export interface AnnotationDraft {
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
