export type AnnotationArchiveStatus = "none" | "pending" | "completed" | "failed";

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
}

export interface AnnotationRecord {
	id: string;
	annotationPath: string;
	sourcePath: string;
	selectedText: string;
	section: string;
	manualText: string;
	aiText: string;
	aiProvider: string;
	aiModel: string;
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
}

export interface AnnotationDraft {
	manualText?: string;
	aiText?: string;
	aiProvider?: string;
	aiModel?: string;
}

export interface AnnotationSectionMarker {
	sourcePath: string;
	lineStart: number;
	lineEnd: number;
}
