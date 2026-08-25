import type {
	MineruBlockRole,
	MineruCaptionPart,
	MineruCaptionPartKind,
	MineruCaptionSummary,
	MineruMarkdownImage,
	MineruViewerBlock,
	MineruViewerIndex,
	MineruViewerPage,
	NormalizedBbox,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const FIGURE_LABEL_RE = /^\s*(?:(Extended\s+Data)\s+Fig(?:ure)?\.?|(Supplementary)\s+Fig(?:ure)?\.?|(Supporting(?:\s+Information)?)\s+Fig(?:ure)?\.?|Fig(?:ure)?\.?|(图))\s*([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)/i;
const FIGURE_LABEL_ANYWHERE_SOURCE = String.raw`(?:Extended\s+Data\s+Fig(?:ure)?\.?|Supplementary\s+Fig(?:ure)?\.?|Supporting(?:\s+Information)?\s+Fig(?:ure)?\.?|Fig(?:ure)?\.?|图)\s*[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*`;
const FIGURE_REFERENCE_VERB_RE = /^(?:shows?|illustrates?|depicts?|demonstrates?|presents?|reports?|displays?|compares?|lists?|summari[sz]es?|gives?|provides?|plots?|is|are|was|were)\b/i;
const NEXT_PAGE_CAPTION_SOURCE = String.raw`(?:see\s+(?:the\s+)?next\s+page\s+for\s+(?:the\s+)?caption|caption\s+(?:is\s+)?continued\s+on\s+(?:the\s+)?next\s+page|continued\s+on\s+(?:the\s+)?next\s+page|caption\s+(?:is\s+)?(?:on|over)\s+(?:the\s+)?next\s+page|continued\s+overleaf|图注(?:见|续见|续|在)?(?:下一|下)页|(?:下一|下)页(?:续见|续|见)图注)`;
const NEXT_PAGE_PLACEHOLDER_RE = new RegExp(
	`${FIGURE_LABEL_ANYWHERE_SOURCE}\\s*[|｜:：.]\\s*${NEXT_PAGE_CAPTION_SOURCE}[.!?。！？]?`,
	"i",
);
const NEXT_PAGE_PLACEHOLDER_CANDIDATE_RE = new RegExp(
	`${FIGURE_LABEL_ANYWHERE_SOURCE}\\s*[|｜:：.]\\s*${NEXT_PAGE_CAPTION_SOURCE}`,
	"i",
);
const PANEL_LABEL_RE = /^\s*[\[(]?[A-Za-z][\])\].:]?\s*$/;
const PANEL_LABEL_NOISE_RE = /^[\[(]?[A-Za-z][\])\].:]?(?:\s+[\[(]?[A-Za-z][\])\].:]?)*$/;
const PANEL_DESCRIPTION_RE = /^\s*[a-z](?:\s*[-\u2013\u2014]\s*[a-z])?[\s,.;:)]/i;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as UnknownRecord
		: {};
}

function asText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		return value.map((item) => asText(item)).filter(Boolean).join(" ").trim();
	}
	if (value === null || typeof value !== "object") return "";
	const record = asRecord(value);
	const nested = record.content ?? record.text ?? record.value;
	return nested === undefined || nested === value ? "" : asText(nested);
}

function asTextParts(value: unknown): string[] {
	if (typeof value === "string") {
		const text = value.trim();
		return text ? [text] : [];
	}
	if (Array.isArray(value)) return value.flatMap((item) => asTextParts(item));
	if (value === null || typeof value !== "object") return [];
	const record = asRecord(value);
	const nested = record.content ?? record.text ?? record.value;
	return nested === undefined || nested === value ? [] : asTextParts(nested);
}

function firstTextParts(...values: unknown[]): string[] {
	for (const value of values) {
		const parts = asTextParts(value);
		if (parts.length) return parts;
	}
	return [];
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		const text = asText(value);
		if (text) return text;
	}
	return "";
}

export function figureKeyFromText(value: string): string {
	const match = FIGURE_LABEL_RE.exec(value);
	if (!match) return "";
	const prefix = match[1]
		? "extended-data-figure"
		: match[2]
			? "supplementary-figure"
			: match[3]
				? "supporting-figure"
				: match[4]
				? "图"
				: "figure";
	const identifier = match[5].replace(/\./g, "_").replace(/\s+/g, "").toLowerCase();
	return identifier ? `${prefix}:${identifier}` : "";
}

/**
 * Return a key only for an explicit caption heading. A bare prose reference such
 * as `Fig. 2 shows ...` deliberately remains a figure reference, not a caption.
 */
export function formalFigureCaptionKeyFromText(value: string): string {
	const match = FIGURE_LABEL_RE.exec(value);
	if (!match) return "";
	const suffix = value.slice(match[0].length);
	const delimited = /^\s*[|｜:：.]\s*([^|｜:：.\s][\s\S]*)$/.exec(suffix);
	const undelimited = /^\s+([^|｜:：.\s][\s\S]*)$/.exec(suffix);
	const title = String(delimited?.[1] || undelimited?.[1] || "").trim();
	if (title.length < 5 || FIGURE_REFERENCE_VERB_RE.test(title)) return "";
	return figureKeyFromText(value);
}

export function isPanelLabelText(value: string): boolean {
	return PANEL_LABEL_RE.test(value);
}

export function containsNextPageCaptionCandidate(value: string): boolean {
	return NEXT_PAGE_PLACEHOLDER_CANDIDATE_RE.test(value);
}

function firstAlphaIsLowercase(value: string): boolean {
	for (const character of value) {
		if (character.toLocaleLowerCase() !== character.toLocaleUpperCase()) {
			return character === character.toLocaleLowerCase();
		}
	}
	return false;
}

function endsWithTerminalPunctuation(value: string): boolean {
	let normalized = value.trim();
	while (/<\/[^>]+>\s*$/.test(normalized)) {
		normalized = normalized.replace(/<\/[^>]+>\s*$/, "").trimEnd();
	}
	return /[.!?。！？]["'”’\)\]}]*$/.test(normalized);
}

export function classifyCaptionPart(value: string): MineruCaptionPartKind {
	const text = value.trim();
	if (!text) return "other";
	const nextPagePlaceholder = nextPageCaptionPlaceholderFromText(text);
	if (nextPagePlaceholder) {
		return nextPagePlaceholder === text ? "next-page-placeholder" : "other";
	}
	if (containsNextPageCaptionCandidate(text)) return "other";
	if (formalFigureCaptionKeyFromText(text)) return "formal-caption";
	if (isPanelLabelText(text)) return "panel-label";
	if (
		text.length >= 24
		&& !figureKeyFromText(text)
		&& (firstAlphaIsLowercase(text) || PANEL_DESCRIPTION_RE.test(text))
		&& endsWithTerminalPunctuation(text)
	) return "caption-continuation";
	return "other";
}

/**
 * Recover only the exact next-page placeholder span from a possibly polluted
 * MinerU image-caption array. The caller still has to require one exact
 * occurrence in article.md before removing it.
 */
export function nextPageCaptionPlaceholderFromText(value: string, expectedFigureKey = ""): string {
	const match = NEXT_PAGE_PLACEHOLDER_RE.exec(value);
	if (!match) return "";
	const placeholder = match[0].trim();
	const suffix = value.slice(match.index + match[0].length).trim();
	if (suffix && !PANEL_LABEL_NOISE_RE.test(suffix)) return "";
	const figureKey = formalFigureCaptionKeyFromText(placeholder);
	if (!figureKey || (expectedFigureKey && figureKey !== expectedFigureKey)) return "";
	return placeholder;
}

export function normalizeAssetPath(value: unknown): string {
	let path = String(value || "").trim().replace(/^<|>$/g, "");
	try {
		path = decodeURIComponent(path);
	} catch {
		// Keep the literal path when percent-decoding is invalid.
	}
	path = path.replace(/\\/g, "/").replace(/^\.\//, "");
	const segments = path.split("/");
	if (
		!path
		|| /^[a-z][a-z0-9+.-]*:/i.test(path)
		|| path.startsWith("/")
		|| segments.some((segment) => segment === "..")
	) {
		return "";
	}
	return path;
}

export function normalizeBbox(value: unknown, scaleUnitInterval = true): NormalizedBbox | null {
	if (!Array.isArray(value) || value.length !== 4) return null;
	if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) return null;
	const numbers = value as number[];
	let [x1, y1, x2, y2] = numbers;
	if (scaleUnitInterval && Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 1.5) {
		x1 *= 1000;
		y1 *= 1000;
		x2 *= 1000;
		y2 *= 1000;
	}
	if (x2 <= x1 || y2 <= y1) return null;
	if (x1 < -5 || y1 < -5 || x2 > 1005 || y2 > 1005) return null;
	return [
		Math.max(0, Math.min(1000, x1)),
		Math.max(0, Math.min(1000, y1)),
		Math.max(0, Math.min(1000, x2)),
		Math.max(0, Math.min(1000, y2)),
	];
}

function classifyRole(sourceType: string, record: UnknownRecord = {}): MineruBlockRole {
	const type = sourceType.toLowerCase();
	if (["image", "chart"].includes(type)) return "visual";
	if (["table", "table_body"].includes(type)) return "table";
	if (["equation", "interline_equation", "formula"].includes(type)) return "equation";
	if (["title", "heading", "paragraph_title"].includes(type) || record.text_level !== undefined) return "title";
	if (["text", "paragraph", "list"].includes(type)) return "text";
	if (["aside_text", "header", "footer", "page_header", "page_footer", "page_footnote", "page_number", "discarded"].includes(type)) {
		return "discarded";
	}
	return "other";
}

function extractAssetPath(record: UnknownRecord): string {
	const content = asRecord(record.content);
	const source = asRecord(content.image_source ?? content.table_source);
	return normalizeAssetPath(
		record.img_path
		?? record.image_path
		?? source.path
		?? source.src
		?? content.img_path,
	);
}

function independentHtmlTableBody(record: UnknownRecord, sourceType: string): string {
	if (sourceType.toLowerCase() !== "table") return "";
	const content = asRecord(record.content);
	const value = record.table_body ?? content.table_body;
	if (typeof value !== "string") return "";
	const table = value.trim();
	const openingTags = table.match(/<table\b/gi) || [];
	const closingTags = table.match(/<\/table\s*>/gi) || [];
	return openingTags.length === 1
		&& closingTags.length === 1
		&& /^<table\b[^>]*>[\s\S]*<\/table>$/i.test(table)
		? table
		: "";
}

function uniqueExactMarkdownRange(
	markdown: string,
	value: string,
): MineruViewerBlock["markdown_table_range"] | undefined {
	if (!value) return undefined;
	const start = markdown.indexOf(value);
	if (start < 0 || markdown.indexOf(value, start + value.length) >= 0) return undefined;
	const end = start + value.length;
	const lineStart = markdown.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const nextNewline = markdown.indexOf("\n", end);
	const lineEnd = nextNewline < 0 ? markdown.length : nextNewline;
	if (markdown.slice(lineStart, start).trim() || markdown.slice(end, lineEnd).trim()) return undefined;
	return { offset_unit: "utf16-code-unit", start, end };
}

function extractCaption(record: UnknownRecord, sourceType: string): MineruCaptionSummary | undefined {
	const content = asRecord(record.content);
	const type = sourceType.toLowerCase();
	const values = type === "table"
		? [record.table_caption, content.table_caption]
		: type === "chart"
			? [record.chart_caption, content.chart_caption]
			: [record.image_caption, content.image_caption];
	const parts: MineruCaptionPart[] = firstTextParts(...values).map((text) => ({
		text,
		kind: classifyCaptionPart(text),
	}));
	const text = parts.map((part) => part.text).join(" ").trim();
	if (!text) return undefined;
	const itemCount = parts.length;
	const nextPagePlaceholders = parts.flatMap((part, index) => {
		const placeholder = nextPageCaptionPlaceholderFromText(part.text);
		const figureKey = placeholder ? formalFigureCaptionKeyFromText(placeholder) : "";
		return placeholder && figureKey ? [{ index, text: placeholder, figure_key: figureKey }] : [];
	});
	const hasNextPageMarker = nextPagePlaceholders.length > 0;
	const placeholder = nextPagePlaceholders[0]?.text || "";
	const figureKey = figureKeyFromText(text)
		|| (placeholder ? formalFigureCaptionKeyFromText(placeholder) : "");
	return {
		text,
		parts,
		char_count: text.length,
		item_count: Math.max(1, itemCount),
		figure_keys: figureKey ? [figureKey] : [],
		leading_figure_key: figureKey || undefined,
		next_page_marker: hasNextPageMarker,
		next_page_figure_keys: hasNextPageMarker && figureKey ? [figureKey] : [],
		next_page_placeholders: nextPagePlaceholders,
		next_page_reference_count: hasNextPageMarker ? 1 : 0,
		ends_with_terminal_punctuation: endsWithTerminalPunctuation(text),
	};
}

function extractTextSummary(record: UnknownRecord): MineruViewerBlock["text"] | undefined {
	const content = asRecord(record.content);
	const text = firstString(record.text, content.paragraph_content, record.content, record.list_items);
	if (!text) return undefined;
	const figureKey = figureKeyFromText(text);
	return {
		text,
		char_count: text.length,
		item_count: 1,
		figure_keys: figureKey ? [figureKey] : [],
		leading_figure_key: figureKey || undefined,
		next_page_marker: false,
		next_page_figure_keys: [],
		ends_with_terminal_punctuation: /[.!?。！？]\s*$/.test(text),
	};
}

interface FlatMineruElement {
	record: UnknownRecord;
	pageIdx: number;
	sourceIndex: number;
	pageOrder: number;
}

function flattenMineruPayload(payload: unknown): FlatMineruElement[] {
	if (!Array.isArray(payload)) return [];
	const flattened: FlatMineruElement[] = [];
	let sourceIndex = 0;
	if (payload.every(Array.isArray)) {
		payload.forEach((page, pageIdx) => {
			(page as unknown[]).forEach((item, pageOrder) => {
				flattened.push({ record: asRecord(item), pageIdx, sourceIndex, pageOrder });
				sourceIndex += 1;
			});
		});
		return flattened;
	}
	const pageOrders = new Map<number, number>();
	payload.forEach((item, index) => {
		const record = asRecord(item);
		const rawPage = Number(record.page_idx ?? record.pageIndex ?? 0);
		const pageIdx = Number.isInteger(rawPage) && rawPage >= 0 ? rawPage : 0;
		const pageOrder = pageOrders.get(pageIdx) || 0;
		pageOrders.set(pageIdx, pageOrder + 1);
		flattened.push({ record, pageIdx, sourceIndex: index, pageOrder });
	});
	return flattened;
}

export function extractMarkdownImages(markdown: string): MineruMarkdownImage[] {
	const images: MineruMarkdownImage[] = [];
	const occurrences = new Map<string, number>();
	const matches: Array<{ start: number; assetPath: string }> = [];
	MARKDOWN_IMAGE_RE.lastIndex = 0;
	HTML_IMAGE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = MARKDOWN_IMAGE_RE.exec(markdown)) !== null) {
		const assetPath = normalizeAssetPath(match[1] || match[2]);
		if (assetPath) matches.push({ start: match.index, assetPath });
	}
	while ((match = HTML_IMAGE_RE.exec(markdown)) !== null) {
		const assetPath = normalizeAssetPath(match[1]);
		if (assetPath) matches.push({ start: match.index, assetPath });
	}
	matches.sort((left, right) => left.start - right.start);
	for (const matchRecord of matches) {
		const assetPath = matchRecord.assetPath;
		if (!assetPath) continue;
		const occurrence = occurrences.get(assetPath) || 0;
		occurrences.set(assetPath, occurrence + 1);
		images.push({
			id: `md-img-${String(images.length).padStart(4, "0")}`,
			order: images.length,
			asset_path: assetPath,
			occurrence,
		});
	}
	return images;
}

/**
 * Produce candidate ranges only. Text uniqueness does not establish block
 * identity; the reader must additionally verify a target-page chain or an
 * occurrence-bound source-image run before suppressing any candidate.
 */
function uniqueStandaloneMarkdownTextRangeCandidates(
	markdown: string,
): Map<string, { offset_unit: "utf16-code-unit"; start: number; end: number } | null> {
	const ranges = new Map<
		string,
		{ offset_unit: "utf16-code-unit"; start: number; end: number } | null
	>();
	let start = 0;
	while (start < markdown.length) {
		const newline = markdown.indexOf("\n", start);
		const contentEnd = newline < 0 ? markdown.length : newline;
		const end = newline < 0 ? markdown.length : newline + 1;
		const text = markdown.slice(start, contentEnd).trim();
		if (text) {
			if (ranges.has(text)) ranges.set(text, null);
			else ranges.set(text, { offset_unit: "utf16-code-unit", start, end });
		}
		start = end;
	}
	return ranges;
}

export function buildRuntimeViewerIndex(payload: unknown, markdown: string): MineruViewerIndex {
	const issues: string[] = [];
	const elements = flattenMineruPayload(payload);
	const nestedByPage = Array.isArray(payload) && payload.length > 0 && payload.every(Array.isArray);
	if (!elements.length) issues.push("MinerU JSON 没有可识别的元素数组");
	const markdownImages = extractMarkdownImages(markdown);
	const imageIds = new Map<string, string[]>();
	const imageCursors = new Map<string, number>();
	markdownImages.forEach((image) => {
		const ids = imageIds.get(image.asset_path) || [];
		ids.push(image.id);
		imageIds.set(image.asset_path, ids);
	});
	const pages = new Map<number, MineruViewerPage>();
	let locatedBlockCount = 0;
	elements.forEach(({ record, pageIdx, sourceIndex, pageOrder }) => {
		const sourceType = String(record.type || "unknown");
		const assetPath = extractAssetPath(record);
		const bbox = normalizeBbox(record.bbox, nestedByPage);
		if (bbox) locatedBlockCount += 1;
		else issues.push(`元素 ${sourceIndex} 缺少有效 bbox，已关闭该元素的版面定位`);
		const role = classifyRole(sourceType, record);
		const block: MineruViewerBlock = {
			id: `p${String(pageIdx).padStart(4, "0")}-s${String(sourceIndex).padStart(6, "0")}`,
			source_index: sourceIndex,
			page_order: pageOrder,
			source_type: sourceType,
			role,
			bbox_norm: bbox,
		};
		if (assetPath) {
			block.asset_path = assetPath;
			const candidates = imageIds.get(assetPath) || [];
			const cursor = imageCursors.get(assetPath) || 0;
			block.markdown_image_ids = candidates[cursor] ? [candidates[cursor]] : [];
			if (candidates[cursor]) imageCursors.set(assetPath, cursor + 1);
		}
		const tableBody = assetPath ? independentHtmlTableBody(record, sourceType) : "";
		const markdownTableRange = uniqueExactMarkdownRange(markdown, tableBody);
		if (markdownTableRange) block.markdown_table_range = markdownTableRange;
		const caption = extractCaption(record, sourceType);
		if (caption) block.caption = caption;
		if (["text", "title", "discarded"].includes(role)) {
			const text = extractTextSummary(record);
			if (text) block.text = text;
		}
		const page = pages.get(pageIdx) || { page_idx: pageIdx, blocks: [] };
		page.blocks.push(block);
		pages.set(pageIdx, page);
	});
	const markdownTextRanges = uniqueStandaloneMarkdownTextRangeCandidates(markdown);
	const normalizedPages = [...pages.values()].sort((a, b) => a.page_idx - b.page_idx);
	for (const page of normalizedPages) {
		for (const block of page.blocks) {
			const text = String(block.text?.text || "").trim();
			const range = text ? markdownTextRanges.get(text) : null;
			if (range) block.markdown_text_range = range;
		}
	}
	return reclassifyRuntimeRunningHeaders({
		schema_version: 1,
		status: !elements.length || locatedBlockCount === 0
			? "unavailable"
			: issues.length
				? "partial"
				: "complete",
		coordinate_system: { kind: "normalized-page", extent: 1000, page_index_base: 0 },
		markdown_images: markdownImages,
		pages: normalizedPages,
		issues,
	});
}

function nearSameHeaderBbox(left: NormalizedBbox | null, right: NormalizedBbox | null): boolean {
	if (
		!left
		|| !right
		|| left[1] > 80
		|| right[1] > 80
		|| left[3] > 120
		|| right[3] > 120
		|| left[3] - left[1] > 60
		|| right[3] - right[1] > 60
	) return false;
	return left.every((coordinate, index) => Math.abs(coordinate - right[index]) <= 10);
}

/**
 * MinerU occasionally emits a repeated running header as ordinary text on one
 * page even though the same header is correctly marked on another page. Keep
 * this repair deliberately narrow: exact short text, another page, an explicit
 * header/page_header source type, and an almost identical top-of-page box.
 */
export function reclassifyRuntimeRunningHeaders(index: MineruViewerIndex): MineruViewerIndex {
	const knownHeaders = index.pages.flatMap((page) => page.blocks
		.filter((block) => (
			block.role === "discarded"
			&& ["header", "page_header"].includes(block.source_type.toLowerCase())
			&& Boolean(block.bbox_norm)
			&& Boolean(String(block.text?.text || "").trim())
		))
		.map((block) => ({ pageIdx: page.page_idx, block })));
	if (!knownHeaders.length) return index;
	let changed = false;
	const pages = index.pages.map((page) => ({
		...page,
		blocks: page.blocks.map((block) => {
			if (!["text", "title"].includes(block.role) || !block.bbox_norm) return block;
			const blockPosition = page.blocks.findIndex((candidate) => candidate.id === block.id);
			const hasEarlierPageContent = page.blocks.slice(0, blockPosition).some((candidate) => (
				candidate.role !== "discarded"
				&& (["visual", "table", "equation", "other"].includes(candidate.role)
					|| Boolean(String(candidate.text?.text || "").trim()))
			));
			if (hasEarlierPageContent) return block;
			const text = String(block.text?.text || "").trim();
			if (!text || text.length > 80 || /[\r\n]/.test(text)) return block;
			const matchesKnownHeader = knownHeaders.some((header) => (
				header.pageIdx !== page.page_idx
				&& String(header.block.text?.text || "").trim() === text
				&& nearSameHeaderBbox(block.bbox_norm, header.block.bbox_norm)
			));
			if (!matchesKnownHeader) return block;
			changed = true;
			return { ...block, role: "discarded" as const };
		}),
	}));
	return changed ? { ...index, pages } : index;
}

export function bboxToPercent(bbox: NormalizedBbox): {
	left: number;
	top: number;
	width: number;
	height: number;
} {
	return {
		left: bbox[0] / 10,
		top: bbox[1] / 10,
		width: (bbox[2] - bbox[0]) / 10,
		height: (bbox[3] - bbox[1]) / 10,
	};
}

export function paddedBbox(bbox: NormalizedBbox, padding: number): NormalizedBbox {
	return [
		Math.max(0, bbox[0] - padding),
		Math.max(0, bbox[1] - padding),
		Math.min(1000, bbox[2] + padding),
		Math.min(1000, bbox[3] + padding),
	];
}

export function extractCaptionText(value: unknown): string {
	return asText(value);
}
