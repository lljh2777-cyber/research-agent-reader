export type MineruReaderMode = "pdf" | "visuals";

export type NormalizedBbox = readonly [number, number, number, number];

export type MineruBlockRole =
	| "text"
	| "title"
	| "visual"
	| "table"
	| "equation"
	| "discarded"
	| "other";

export type MineruCaptionPartKind =
	| "formal-caption"
	| "next-page-placeholder"
	| "panel-label"
	| "caption-continuation"
	| "other";

export interface MineruCaptionPart {
	text: string;
	kind: MineruCaptionPartKind;
}

export interface MineruNextPagePlaceholder {
	index: number;
	text: string;
	figure_key: string;
}

export interface MineruMarkdownTextRange {
	offset_unit: "utf16-code-unit";
	start: number;
	end: number;
}

export interface MineruCaptionSummary {
	text?: string;
	parts?: MineruCaptionPart[];
	char_count?: number;
	item_count?: number;
	figure_keys?: string[];
	leading_figure_key?: string;
	formal_figure_caption_keys?: string[];
	leading_formal_figure_caption_key?: string;
	next_page_marker?: boolean;
	next_page_figure_keys?: string[];
	next_page_placeholders?: MineruNextPagePlaceholder[];
	next_page_reference_count?: number;
	starts_with_lowercase?: boolean;
	starts_with_panel_label?: boolean;
	ends_with_terminal_punctuation?: boolean;
}

export interface MineruTextSummary {
	text?: string;
	char_count?: number;
	item_count?: number;
	figure_keys?: string[];
	leading_figure_key?: string;
	formal_figure_caption_keys?: string[];
	leading_formal_figure_caption_key?: string;
	next_page_marker?: boolean;
	next_page_figure_keys?: string[];
	starts_with_lowercase?: boolean;
	starts_with_panel_label?: boolean;
	ends_with_terminal_punctuation?: boolean;
}

export interface MineruViewerBlock {
	id: string;
	source_index: number;
	page_order: number;
	source_type: string;
	role: MineruBlockRole;
	bbox_norm: NormalizedBbox | null;
	asset_path?: string;
	caption?: MineruCaptionSummary;
	text?: MineruTextSummary;
	markdown_image_ids?: string[];
	markdown_text_range?: MineruMarkdownTextRange;
	markdown_table_range?: MineruMarkdownTextRange;
}

export interface MineruViewerPage {
	page_idx: number;
	blocks: MineruViewerBlock[];
}

export interface MineruMarkdownImage {
	id: string;
	order: number;
	asset_path: string;
	occurrence: number;
}

export interface MineruViewerIndex {
	schema_version: number;
	status: "complete" | "partial" | "unavailable";
	inputs?: {
		article?: { path?: string; sha256?: string };
		mineru_result?: { path?: string; sha256?: string };
	};
	coordinate_system?: {
		kind?: string;
		extent?: number;
		page_index_base?: number;
	};
	pdf_source?: {
		packaged_path?: string;
		manifest_source_fallback?: boolean;
	};
	markdown_images: MineruMarkdownImage[];
	pages: MineruViewerPage[];
	issues: string[];
}

export type MineruRepairDecision = "auto" | "review" | "keep-original";
export type MineruReplacementMode = "existing_asset" | "pdf_crop" | "none";

export interface MineruVisualRepairGroup {
	id: string;
	page_idx: number;
	member_block_ids: string[];
	member_markdown_image_ids?: string[];
	decision: MineruRepairDecision;
	confidence: number;
	replacement: {
		mode: MineruReplacementMode;
		block_id?: string;
		bbox_norm?: NormalizedBbox;
		padding_norm?: number;
		asset_path?: string;
		existing_asset_path?: string;
	};
	caption_anchor_block_ids?: string[];
	signals?: Record<string, unknown>;
	reason_codes?: string[];
	fallback?: string;
}

export interface MineruCaptionLink {
	visual_block_id: string;
	caption_block_ids: string[];
	source_page_idx: number;
	target_page_idx: number;
	figure_key: string;
	relation: "next_page_figure_caption";
	status: "complete" | "partial";
}

export interface MineruVisualRepair {
	schema_version: number;
	algorithm_version: string;
	viewer_index?: string;
	status: "complete" | "partial" | "unavailable";
	inputs?: MineruViewerIndex["inputs"];
	groups: MineruVisualRepairGroup[];
	caption_links: MineruCaptionLink[];
	issues: string[];
}

export interface MineruReaderVisual {
	id: string;
	pageIdx: number;
	label: string;
	caption: string;
	captionParts: string[];
	captionSourceBlockIds: string[];
	captionSourceProjections?: Array<{
		start: number;
		end: number;
		text: string;
		suppress?: boolean;
	}>;
	captionInlineProjections?: Array<{
		sourceBlockId: string;
		start: number;
		end: number;
		text: string;
	}>;
	captionSourceImageBounds?: {
		beforeMarkdownImageId: string;
		afterMarkdownImageId: string;
	};
	captionPageIdx?: number;
	captionStatus?: "complete" | "partial";
	pageRange: readonly [number, number];
	memberBlockIds: string[];
	memberAssetPaths: string[];
	memberMarkdownImageIds: string[];
	panelLabelProjections?: Array<{
		markdownImageId: string;
		label: string;
	}>;
	samePageCaptionProjections?: Array<{
		markdownImageId: string;
		text: string;
		suppressText?: string;
	}>;
	atomicBlockProjection?: {
		tableBlockId: string;
		tableRange: MineruMarkdownTextRange;
		captionRange: MineruMarkdownTextRange;
		captionText: string;
	};
	boundedHeadingProjections?: Array<{
		text: string;
		before:
			| { kind: "image"; markdownImageId: string }
			| { kind: "table"; markdownTableRange: MineruMarkdownTextRange };
		after:
			| { kind: "image"; markdownImageId: string }
			| { kind: "table"; markdownTableRange: MineruMarkdownTextRange };
	}>;
	anchorAssetPath: string;
	display:
		| { mode: "asset"; assetPath: string }
		| { mode: "pdf-crop"; bbox: NormalizedBbox; padding: number }
		| { mode: "fragment-set"; assetPaths: string[] };
	repairDecision: MineruRepairDecision;
	confidence: number;
}

export interface MineruReaderPackage {
	sourceKind: "mineru" | "markdown";
	packagePath: string;
	articlePath: string;
	title: string;
	articleMarkdown: string;
	mineruPayload: unknown;
	viewerIndex: MineruViewerIndex;
	visualRepair: MineruVisualRepair | null;
	visuals: MineruReaderVisual[];
	pdfPath: string | null;
	externalPdfRecorded: boolean;
	issues: string[];
}

export interface MineruReaderViewState {
	articlePath: string;
	mode: MineruReaderMode;
	followPdfReading: boolean;
	followVisualReading: boolean;
	showLayoutBoxes: boolean;
	currentVisualId: string;
	markdownAnchor: string;
	markdownPage: number;
	pdfPage: number;
	pdfZoom: number;
	splitRatio: number;
}
