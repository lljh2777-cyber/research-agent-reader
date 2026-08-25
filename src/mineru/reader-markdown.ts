import {
	classifyCaptionPart,
	containsNextPageCaptionCandidate,
	figureKeyFromText,
	formalFigureCaptionKeyFromText,
	isPanelLabelText,
	nextPageCaptionPlaceholderFromText,
	normalizeAssetPath,
} from "./normalization";
import type {
	MineruCaptionLink,
	MineruReaderVisual,
	MineruViewerBlock,
	MineruViewerIndex,
	MineruVisualRepair,
	MineruVisualRepairGroup,
	NormalizedBbox,
} from "./types";

const IMAGE_TOKEN_RE = /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)|<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

interface CaptionPartEntry {
	block: MineruViewerBlock;
	text: string;
	kind: ReturnType<typeof classifyCaptionPart>;
	order: number;
}

interface MarkdownImageOccurrence {
	id: string;
	start: number;
	end: number;
}

interface MarkdownLineRange {
	start: number;
	contentEnd: number;
	end: number;
	text: string;
}

export interface PdfCaptionContinuationRegion {
	visualId: string;
	sourceBlockId: string;
	pageNumber: number;
	bbox: NormalizedBbox;
}

export interface PdfCaptionContinuationText extends PdfCaptionContinuationRegion {
	text: string;
}

export interface MineruReaderViewportBlock {
	pageNumber: number;
	top: number;
	bottom: number;
}

/**
 * Pick one monotonic DOM boundary for a source page. An inline marker survived
 * the same Markdown suppression/rendering pipeline as the visible text, so it
 * is stronger evidence than a later normalized-text search. The latter is a
 * compatibility fallback for older or partially indexed packages only.
 */
export function readerPageBoundaryIndex(
	exactIndices: readonly number[],
	fallbackIndices: readonly number[],
	previousIndex: number,
	allowDocumentStart = false,
): number {
	const firstAfterPrevious = (values: readonly number[]): number => [...values]
		.filter((value) => Number.isInteger(value) && value > previousIndex)
		.sort((left, right) => left - right)[0] ?? -1;
	const exact = firstAfterPrevious(exactIndices);
	if (exact >= 0) return exact;
	const fallback = firstAfterPrevious(fallbackIndices);
	if (fallback >= 0) return fallback;
	return allowDocumentStart && previousIndex < 0 ? 0 : -1;
}

/**
 * Resolve the page owned by the first visible Markdown line. Blocks crossing
 * the viewport top win over later blocks, so a partially visible paragraph is
 * still attributed to the page where that rendered block begins.
 */
export function readerPageAtViewportTop(
	blocks: readonly MineruReaderViewportBlock[],
	viewportTop: number,
	viewportBottom: number,
	fallbackPage = 1,
): number {
	const top = Number.isFinite(viewportTop) ? viewportTop : 0;
	const bottom = Number.isFinite(viewportBottom)
		? Math.max(top, viewportBottom)
		: Number.POSITIVE_INFINITY;
	const visible = blocks
		.filter((block) => (
			Number.isFinite(block.pageNumber)
			&& block.pageNumber > 0
			&& Number.isFinite(block.top)
			&& Number.isFinite(block.bottom)
			&& block.bottom > top + 0.5
			&& block.top < bottom - 0.5
		))
		.sort((left, right) => {
			const leftVisibleTop = Math.max(top, left.top);
			const rightVisibleTop = Math.max(top, right.top);
			return leftVisibleTop - rightVisibleTop
				|| left.top - right.top
				|| left.bottom - right.bottom;
		});
	return Math.max(1, Math.floor(visible[0]?.pageNumber || fallbackPage));
}

export function readerElementOffset(
	scrollTop: number,
	elementTop: number,
	scrollerTop: number,
): number {
	return Math.max(0, scrollTop + elementTop - scrollerTop);
}

export function alignedReaderScrollTop(
	scrollTop: number,
	elementTop: number,
	scrollerTop: number,
	leadingInset = 0,
): number {
	return Math.max(
		0,
		readerElementOffset(scrollTop, elementTop, scrollerTop) - Math.max(0, leadingInset),
	);
}

type SamePageCaptionProjection = NonNullable<
	MineruReaderVisual["samePageCaptionProjections"]
>[number];

type AtomicBlockProjection = NonNullable<MineruReaderVisual["atomicBlockProjection"]>;
type BoundedHeadingProjection = NonNullable<
	MineruReaderVisual["boundedHeadingProjections"]
>[number];
type BoundedHeadingBoundary = BoundedHeadingProjection["before"];

interface StandaloneSamePageCaption {
	text: string;
	parts: string[];
	markdownImageId?: string;
	atomicBlockProjection?: AtomicBlockProjection;
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function blockText(block: MineruViewerBlock | undefined): string {
	return String(block?.text?.text || "").trim();
}

function axisOverlap(startA: number, endA: number, startB: number, endB: number): number {
	return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function sameTopCaptionBand(left: MineruViewerBlock, right: MineruViewerBlock): boolean {
	const a = left.bbox_norm;
	const b = right.bbox_norm;
	if (!a || !b || Math.abs(a[1] - b[1]) > 45) return false;
	if (axisOverlap(a[0], a[2], b[0], b[2]) > 0) return false;
	const xGap = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
	if (xGap > 80) return false;
	const aHeight = a[3] - a[1];
	const bHeight = b[3] - b[1];
	if (axisOverlap(a[1], a[3], b[1], b[3]) < 0.55 * Math.min(aHeight, bHeight)) return false;
	const heightRatio = bHeight / aHeight;
	return heightRatio >= 0.45 && heightRatio <= 2.2;
}

function isTopTextBlock(block: MineruViewerBlock): boolean {
	return ["text", "title"].includes(block.role)
		&& Boolean(block.bbox_norm)
		&& (block.bbox_norm as NormalizedBbox)[1] <= 320;
}

function firstAlphaIsLowercase(value: string): boolean {
	for (const character of value) {
		if (character.toLocaleLowerCase() !== character.toLocaleUpperCase()) {
			return character === character.toLocaleLowerCase();
		}
	}
	return false;
}

function startsWithPanelLabel(value: string): boolean {
	return /^\s*[a-z](?:\s*[-–—]\s*[a-z])?[\s,.;:)]/i.test(value);
}

interface PanelMarker {
	start: string;
	end: string;
}

function captionPanelMarkers(value: string): PanelMarker[] {
	const markers: PanelMarker[] = [];
	const pattern = /(?:^|[.!?。！？;]\s+)(?:\(([a-z])\)|([a-z])(?:\s*[-–—]\s*([a-z]))?\s*[,;:])/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		const start = String(match[1] || match[2] || "").toLowerCase();
		const end = String(match[3] || start).toLowerCase();
		if (start) markers.push({ start, end });
	}
	return markers;
}

function hasSequentialCaptionPanels(anchorText: string, continuationText: string): boolean {
	const anchorMarkers = captionPanelMarkers(anchorText);
	const continuationMarkers = captionPanelMarkers(continuationText);
	if (!anchorMarkers.length || continuationMarkers.length < 2) return false;
	const lastAnchor = anchorMarkers[anchorMarkers.length - 1].end.charCodeAt(0);
	const firstContinuation = continuationMarkers[0].start.charCodeAt(0);
	if (lastAnchor < 97 || lastAnchor > 122 || firstContinuation !== lastAnchor + 1) return false;
	let previous = continuationMarkers[0];
	for (const marker of continuationMarkers.slice(1)) {
		const current = marker.start.charCodeAt(0);
		const previousStart = previous.start.charCodeAt(0);
		const previousEnd = previous.end.charCodeAt(0);
		const expandsPreviousRange = previousEnd > previousStart && current === previousStart;
		if (!expandsPreviousRange && current !== previousEnd + 1) return false;
		previous = marker;
	}
	return true;
}

function endsWithTerminalPunctuation(value: string): boolean {
	let normalized = value.trim();
	while (/<\/[^>]+>\s*$/.test(normalized)) {
		normalized = normalized.replace(/<\/[^>]+>\s*$/, "").trimEnd();
	}
	return /[.!?。！？]["'”’\)\]}]*$/.test(normalized);
}

function captionPartEntries(blocks: readonly MineruViewerBlock[]): CaptionPartEntry[] {
	let order = 0;
	return [...blocks]
		.sort((left, right) => left.page_order - right.page_order || left.source_index - right.source_index)
		.flatMap((block) => {
			const storedParts = block.caption?.parts || [];
			const parts = storedParts.length
				? storedParts
					.map((part) => ({ text: String(part.text || "").trim(), kind: part.kind }))
					.filter((part) => Boolean(part.text))
				: [String(block.caption?.text || "").trim()]
					.filter(Boolean)
					.map((text) => ({ text, kind: classifyCaptionPart(text) }));
			return parts.map((part) => ({
				block,
				...part,
				order: order++,
			}));
		});
}

function bboxContainmentRatio(container: NormalizedBbox, child: NormalizedBbox): number {
	const intersection = axisOverlap(container[0], container[2], child[0], child[2])
		* axisOverlap(container[1], container[3], child[1], child[3]);
	const childArea = Math.max(0, child[2] - child[0]) * Math.max(0, child[3] - child[1]);
	return childArea > 0 ? intersection / childArea : 0;
}

function blockPageIdx(block: MineruViewerBlock): number | null {
	const match = /^p(\d{4,})-/.exec(block.id);
	return match ? Number(match[1]) : null;
}

function captionAdjacencyScore(
	captionBbox: NormalizedBbox,
	visualBbox: NormalizedBbox,
): number | null {
	const captionWidth = captionBbox[2] - captionBbox[0];
	const visualWidth = visualBbox[2] - visualBbox[0];
	const sharedWidth = axisOverlap(captionBbox[0], captionBbox[2], visualBbox[0], visualBbox[2]);
	const overlapRatio = sharedWidth / Math.max(1, Math.min(captionWidth, visualWidth));
	if (overlapRatio < 0.55) return null;

	let gap: number;
	if (captionBbox[1] >= visualBbox[3] - 20) {
		gap = Math.max(0, captionBbox[1] - visualBbox[3]);
		if (gap > 100) return null;
	} else if (visualBbox[1] >= captionBbox[3] - 20) {
		gap = Math.max(0, visualBbox[1] - captionBbox[3]);
		if (gap > 80) return null;
	} else {
		return null;
	}
	return gap + (1 - overlapRatio) * 40;
}

function nearestFollowingFormalCaptionId(
	block: MineruViewerBlock,
	orderedPageBlocks: readonly MineruViewerBlock[],
): string {
	const position = orderedPageBlocks.findIndex((candidate) => candidate.id === block.id);
	if (position < 0) return "";
	const caption = orderedPageBlocks.slice(position + 1).find((candidate) =>
		["text", "title"].includes(candidate.role)
		&& Boolean(formalFigureCaptionKeyFromText(blockText(candidate))));
	return caption?.id || "";
}

/**
 * Bind a standalone MinerU text block such as `Extended Data Fig. 1 | ...`
 * to the uniquely adjacent visual on the same page. The global competition
 * check is important: a full-width caption below two unrelated visual groups
 * stays visible instead of being guessed onto either group.
 */
function standaloneSamePageCaption(
	blocks: readonly MineruViewerBlock[],
	allBlocks: readonly MineruViewerBlock[],
	pageIdx: number,
): StandaloneSamePageCaption | null {
	// An explicit source-page placeholder is stronger evidence than proximity:
	// its formal caption must be resolved on the following page only.
	if (blocks.some((block) => block.caption?.next_page_marker === true)) return null;
	const memberIds = new Set(blocks.map((block) => block.id));
	const pageVisuals = allBlocks.filter((block) =>
		blockPageIdx(block) === pageIdx
		&& ["visual", "table"].includes(block.role)
		&& Boolean(block.bbox_norm)
		&& (
			block.markdown_image_ids?.length === 1
			|| (
				block.role === "table"
				&& !block.markdown_image_ids?.length
				&& Boolean(block.markdown_table_range)
			)
		));
	if (!pageVisuals.some((block) => memberIds.has(block.id))) return null;

	const orderedPageBlocks = allBlocks
		.filter((block) => blockPageIdx(block) === pageIdx)
		.sort((left, right) => left.page_order - right.page_order || left.source_index - right.source_index);
	const completeCaptionParts = (anchor: MineruViewerBlock): string[] | null => {
		const anchorText = blockText(anchor);
		const anchorPosition = orderedPageBlocks.findIndex((block) => block.id === anchor.id);
		if (anchorPosition < 0) return null;
		const laterSemantic = orderedPageBlocks.slice(anchorPosition + 1).filter((next) => (
			next.role !== "discarded"
			&& (["visual", "table", "equation", "other"].includes(next.role) || Boolean(blockText(next)))
		));
		const anchorIsTerminal = endsWithTerminalPunctuation(anchorText);
		const continuationCandidates = laterSemantic.filter((next) => {
			const nextText = blockText(next);
			return next.role === "text"
				&& nextText.length >= 24
				&& !figureKeyFromText(nextText)
				&& sameTopCaptionBand(anchor, next)
				&& (anchorIsTerminal ? startsWithPanelLabel(nextText) : (
					firstAlphaIsLowercase(nextText) || startsWithPanelLabel(nextText)
				));
		});
		if (!continuationCandidates.length) return anchorIsTerminal ? [anchorText] : null;
		if (
			continuationCandidates.length !== 1
			|| laterSemantic[0]?.id !== continuationCandidates[0].id
			|| !endsWithTerminalPunctuation(blockText(continuationCandidates[0]))
		) return null;
		return [anchorText, blockText(continuationCandidates[0])];
	};

	const matches: Array<StandaloneSamePageCaption & { score: number }> = [];
	for (const candidate of allBlocks) {
		const text = blockText(candidate);
		if (
			memberIds.has(candidate.id)
			|| blockPageIdx(candidate) !== pageIdx
			|| !["text", "title"].includes(candidate.role)
			|| !candidate.bbox_norm
			|| !formalFigureCaptionKeyFromText(text)
		) continue;
		const parts = completeCaptionParts(candidate);
		// Do not suppress only the formal half of a split caption. If a
		// non-terminal anchor has no unique, complete continuation, preserve the
		// whole Markdown run for manual reading instead of leaving an orphan tail.
		if (!parts) continue;

		const captionPosition = orderedPageBlocks.findIndex((block) => block.id === candidate.id);
		const ranked = pageVisuals
			.map((visual) => {
				const visualPosition = orderedPageBlocks.findIndex((block) => block.id === visual.id);
				const spatialScore = captionAdjacencyScore(candidate.bbox_norm!, visual.bbox_norm!);
				if (
					visualPosition < 0
					|| captionPosition <= visualPosition
					|| nearestFollowingFormalCaptionId(visual, orderedPageBlocks) !== candidate.id
					|| spatialScore === null
				) return { visual, score: null };
				return {
					visual,
					score: spatialScore + Math.min(60, Math.max(0, captionPosition - visualPosition - 1) * 3),
				};
			})
			.filter((entry): entry is { visual: MineruViewerBlock; score: number } => entry.score !== null)
			.sort((left, right) => left.score - right.score || right.visual.source_index - left.visual.source_index);
		if (!ranked.length) continue;
		const bestScore = ranked[0].score;
		const equallyPlausible = ranked.filter((entry) => entry.score <= bestScore + 5);
		if (
			!equallyPlausible.length
			|| equallyPlausible.some((entry) => !memberIds.has(entry.visual.id))
		) continue;
		const anchor = equallyPlausible[0].visual;
		const common = {
			text: parts.length === 1 ? parts[0] : parts.join(" ").replace(/\s+/g, " ").trim(),
			parts,
			score: bestScore,
		};
		if (anchor.markdown_image_ids?.length === 1) {
			matches.push({ ...common, markdownImageId: anchor.markdown_image_ids[0] });
			continue;
		}
		const tableRange = anchor.markdown_table_range;
		const captionRange = candidate.markdown_text_range;
		const tableCaptionPosition = orderedPageBlocks.findIndex((block) => block.id === candidate.id);
		const previousSemantic = [...orderedPageBlocks.slice(0, tableCaptionPosition)]
			.reverse()
			.find((block) => (
				block.role !== "discarded"
				&& (["visual", "table", "equation", "other"].includes(block.role) || Boolean(blockText(block)))
			));
		if (
			blocks.length !== 1
			|| anchor.role !== "table"
			|| parts.length !== 1
			|| !tableRange
			|| !captionRange
			|| previousSemantic?.id !== anchor.id
			|| tableRange.end > captionRange.start
		) continue;
		matches.push({
			...common,
			atomicBlockProjection: {
				tableBlockId: anchor.id,
				tableRange: { ...tableRange },
				captionRange: { ...captionRange },
				captionText: parts[0],
			},
		});
	}
	if (!matches.length) return null;
	matches.sort((left, right) => left.score - right.score);
	if (matches.length > 1 && matches[1].score <= matches[0].score + 5) return null;
	return matches[0];
}

function unionBboxes(values: readonly NormalizedBbox[]): NormalizedBbox | null {
	if (!values.length) return null;
	return [
		Math.min(...values.map((bbox) => bbox[0])),
		Math.min(...values.map((bbox) => bbox[1])),
		Math.max(...values.map((bbox) => bbox[2])),
		Math.max(...values.map((bbox) => bbox[3])),
	];
}

function groupsShareCaptionBand(left: NormalizedBbox, right: NormalizedBbox): boolean {
	const xGap = Math.max(0, Math.max(left[0], right[0]) - Math.min(left[2], right[2]));
	if (xGap > 40) return false;
	const leftHeight = left[3] - left[1];
	const rightHeight = right[3] - right[1];
	const verticalOverlap = axisOverlap(left[1], left[3], right[1], right[3]);
	return verticalOverlap >= 0.55 * Math.min(leftHeight, rightHeight);
}

function groupsAreCoordinateNeighbours(left: NormalizedBbox, right: NormalizedBbox): boolean {
	const leftWidth = left[2] - left[0];
	const leftHeight = left[3] - left[1];
	const rightWidth = right[2] - right[0];
	const rightHeight = right[3] - right[1];
	const xGap = Math.max(0, Math.max(left[0], right[0]) - Math.min(left[2], right[2]));
	const yGap = Math.max(0, Math.max(left[1], right[1]) - Math.min(left[3], right[3]));
	const xOverlap = axisOverlap(left[0], left[2], right[0], right[2]);
	const yOverlap = axisOverlap(left[1], left[3], right[1], right[3]);
	return (
		xGap <= 65 && yOverlap >= 0.20 * Math.min(leftHeight, rightHeight)
	) || (
		yGap <= 65 && xOverlap >= 0.20 * Math.min(leftWidth, rightWidth)
	);
}

const NESTED_GROUP_CONTAINMENT_THRESHOLD = 0.97;
const NESTED_GROUP_AREA_RATIO = 1.35;

function bboxArea(bbox: NormalizedBbox): number {
	return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function repairGroupFigureKeys(members: readonly MineruViewerBlock[]): Set<string> {
	const keys = new Set<string>();
	for (const member of members) {
		for (const key of member.caption?.formal_figure_caption_keys || []) keys.add(key);
		for (const key of member.caption?.next_page_figure_keys || []) keys.add(key);
		for (const entry of captionPartEntries([member])) {
			if (entry.kind !== "formal-caption" && entry.kind !== "next-page-placeholder") continue;
			const key = formalFigureCaptionKeyFromText(entry.text) || figureKeyFromText(entry.text);
			if (key) keys.add(key);
		}
	}
	return keys;
}

function repairGroupsAreSourceAdjacent(
	left: readonly MineruViewerBlock[],
	right: readonly MineruViewerBlock[],
): boolean {
	if (!left.length || !right.length) return false;
	const leftOrders = left.map((block) => block.page_order);
	const rightOrders = right.map((block) => block.page_order);
	const leftMin = Math.min(...leftOrders);
	const leftMax = Math.max(...leftOrders);
	const rightMin = Math.min(...rightOrders);
	const rightMax = Math.max(...rightOrders);
	return rightMin <= leftMax + 1 && leftMin <= rightMax + 1;
}

/**
 * MinerU may emit a complete multi-panel crop and then repeat one contained
 * panel strip as another repair group. Collapse the smaller group only when
 * geometry, source order, and one non-conflicting formal figure key agree.
 * Its members and caption anchors are retained on the enclosing group so the
 * correct caption is transferred instead of being lost with the duplicate.
 */
export function mergeNestedVisualRepairGroups(
	groups: readonly MineruVisualRepairGroup[],
	allBlocks: readonly MineruViewerBlock[],
): MineruVisualRepairGroup[] {
	const blockById = new Map(allBlocks.map((block) => [block.id, block]));
	const markdownOrder = (id: string): number => markdownImageOrder(id) ?? Number.MAX_SAFE_INTEGER;
	const orderedMemberIds = (ids: readonly string[]): string[] => [...new Set(ids)].sort(
		(left, right) => (blockById.get(left)?.source_index ?? Number.MAX_SAFE_INTEGER)
			- (blockById.get(right)?.source_index ?? Number.MAX_SAFE_INTEGER),
	);
	const working: MineruVisualRepairGroup[] = groups.map((group) => ({
		...group,
		member_block_ids: [...group.member_block_ids],
		member_markdown_image_ids: [...(group.member_markdown_image_ids || [])],
		caption_anchor_block_ids: [...(group.caption_anchor_block_ids || [])],
	}));

	while (true) {
		let match: { outerIndex: number; innerIndex: number; containment: number } | null = null;
		for (let leftIndex = 0; leftIndex < working.length && !match; leftIndex += 1) {
			const left = working[leftIndex];
			if (left.decision !== "auto" || left.replacement.mode !== "pdf_crop" || !left.replacement.bbox_norm) continue;
			for (let rightIndex = leftIndex + 1; rightIndex < working.length; rightIndex += 1) {
				const right = working[rightIndex];
				if (
					right.page_idx !== left.page_idx
					|| right.decision !== "auto"
					|| right.replacement.mode !== "pdf_crop"
					|| !right.replacement.bbox_norm
				) continue;
				const leftArea = bboxArea(left.replacement.bbox_norm);
				const rightArea = bboxArea(right.replacement.bbox_norm);
				if (leftArea <= 0 || rightArea <= 0) continue;
				const outerIndex = leftArea >= rightArea ? leftIndex : rightIndex;
				const innerIndex = outerIndex === leftIndex ? rightIndex : leftIndex;
				const outer = working[outerIndex];
				const inner = working[innerIndex];
				const outerArea = Math.max(leftArea, rightArea);
				const innerArea = Math.min(leftArea, rightArea);
				if (outerArea < innerArea * NESTED_GROUP_AREA_RATIO) continue;
				const containment = bboxContainmentRatio(
					outer.replacement.bbox_norm!,
					inner.replacement.bbox_norm!,
				);
				if (containment < NESTED_GROUP_CONTAINMENT_THRESHOLD) continue;
				const outerMembers = outer.member_block_ids
					.map((id) => blockById.get(id))
					.filter((block): block is MineruViewerBlock => Boolean(block));
				const innerMembers = inner.member_block_ids
					.map((id) => blockById.get(id))
					.filter((block): block is MineruViewerBlock => Boolean(block));
				if (
					outerMembers.length !== outer.member_block_ids.length
					|| innerMembers.length !== inner.member_block_ids.length
					|| !repairGroupsAreSourceAdjacent(outerMembers, innerMembers)
				) continue;
				const figureKeys = new Set([
					...repairGroupFigureKeys(outerMembers),
					...repairGroupFigureKeys(innerMembers),
				]);
				if (figureKeys.size !== 1) continue;
				match = { outerIndex, innerIndex, containment };
				break;
			}
		}
		if (!match) break;

		const outer = working[match.outerIndex];
		const inner = working[match.innerIndex];
		const memberBlockIds = orderedMemberIds([
			...outer.member_block_ids,
			...inner.member_block_ids,
		]);
		const memberMarkdownImageIds = [...new Set([
			...(outer.member_markdown_image_ids || []),
			...(inner.member_markdown_image_ids || []),
		])].sort((left, right) => markdownOrder(left) - markdownOrder(right));
		const nestedCount = Number(outer.signals?.nested_group_count || 0)
			+ Number(inner.signals?.nested_group_count || 0) + 1;
		const summedSignal = (name: string): number => Number(outer.signals?.[name] || 0)
			+ Number(inner.signals?.[name] || 0);
		const merged: MineruVisualRepairGroup = {
			...outer,
			member_block_ids: memberBlockIds,
			member_markdown_image_ids: memberMarkdownImageIds,
			caption_anchor_block_ids: [...new Set([
				...(outer.caption_anchor_block_ids || []),
				...(inner.caption_anchor_block_ids || []),
			])],
			confidence: Math.min(outer.confidence, inner.confidence),
			signals: {
				...(outer.signals || {}),
				member_count: memberBlockIds.length,
				representative_count: summedSignal("representative_count"),
				adjacent_pair_count: summedSignal("adjacent_pair_count"),
				caption_char_count: summedSignal("caption_char_count"),
				long_caption_anchor_count: summedSignal("long_caption_anchor_count"),
				figure_caption_anchor_count: summedSignal("figure_caption_anchor_count"),
				panel_label_count: summedSignal("panel_label_count"),
				nested_group_count: nestedCount,
				nested_overlap_containment: Number(match.containment.toFixed(4)),
			},
			reason_codes: [...new Set([
				...(outer.reason_codes || []),
				...(inner.reason_codes || []),
				"nested_visual_overlap_deduplicated",
			])],
		};
		const insertAt = Math.min(match.outerIndex, match.innerIndex);
		const removeAt = Math.max(match.outerIndex, match.innerIndex);
		working.splice(removeAt, 1);
		working.splice(insertAt, 1, merged);
	}
	return working;
}

/**
 * A standalone formal caption can also explain why strict spatial clustering
 * split one multi-panel figure into neighbouring columns. Merge only an
 * all-PDF-crop, panel-labelled connected component with exactly one uniquely
 * matched caption; two independently captioned side-by-side figures remain
 * separate.
 */
export function mergeStandaloneCaptionRepairGroups(
	groups: readonly MineruVisualRepairGroup[],
	allBlocks: readonly MineruViewerBlock[],
): MineruVisualRepairGroup[] {
	const blockById = new Map(allBlocks.map((block) => [block.id, block]));
	const nestedGroups = mergeNestedVisualRepairGroups(groups, allBlocks);
	const descriptors = nestedGroups.map((group, index) => {
		const members = group.member_block_ids
			.map((id) => blockById.get(id))
			.filter((block): block is MineruViewerBlock => Boolean(block));
		const bbox = group.replacement.bbox_norm
			|| unionBboxes(members.flatMap((block) => block.bbox_norm ? [block.bbox_norm] : []));
		const panelLabelSignal = Number(group.signals?.panel_label_count || 0);
		const hasPanelLabels = panelLabelSignal > 0
			|| captionPartEntries(members).some((entry) => entry.kind === "panel-label");
		const hasMemberFormalCaption = captionPartEntries(members)
			.some((entry) => entry.kind === "formal-caption");
		const orderedPageBlocks = allBlocks
			.filter((block) => blockPageIdx(block) === group.page_idx)
			.sort((left, right) => left.page_order - right.page_order || left.source_index - right.source_index);
		const followingCaptionIds = [...new Set(members
			.map((member) => nearestFollowingFormalCaptionId(member, orderedPageBlocks))
			.filter(Boolean))];
		const followingCaptionId = followingCaptionIds.length === 1 ? followingCaptionIds[0] : "";
		return {
			group,
			index,
			members,
			bbox,
			hasPanelLabels,
			hasMemberFormalCaption,
			followingCaptionId,
		};
	});
	const adjacency = new Map<number, Set<number>>();
	descriptors.forEach((descriptor) => adjacency.set(descriptor.index, new Set()));
	for (let leftIndex = 0; leftIndex < descriptors.length; leftIndex += 1) {
		const left = descriptors[leftIndex];
		if (
			left.group.decision !== "auto"
			|| left.group.replacement.mode !== "pdf_crop"
			|| !left.bbox
		) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < descriptors.length; rightIndex += 1) {
			const right = descriptors[rightIndex];
			if (
				right.group.page_idx !== left.group.page_idx
				|| right.group.decision !== "auto"
				|| right.group.replacement.mode !== "pdf_crop"
				|| !right.bbox
			) continue;
			const panelBandBridge = left.hasPanelLabels
				&& right.hasPanelLabels
				&& groupsShareCaptionBand(left.bbox, right.bbox);
			const readingOrderBridge = Boolean(
				left.followingCaptionId
				&& left.followingCaptionId === right.followingCaptionId
				&& groupsAreCoordinateNeighbours(left.bbox, right.bbox),
			);
			if (!panelBandBridge && !readingOrderBridge) continue;
			adjacency.get(left.index)!.add(right.index);
			adjacency.get(right.index)!.add(left.index);
		}
	}

	const consumed = new Set<number>();
	const result: MineruVisualRepairGroup[] = [];
	for (const descriptor of descriptors) {
		if (consumed.has(descriptor.index)) continue;
		const component: typeof descriptors = [];
		const pending = [descriptor.index];
		while (pending.length) {
			const currentIndex = pending.pop()!;
			if (consumed.has(currentIndex)) continue;
			consumed.add(currentIndex);
			component.push(descriptors[currentIndex]);
			for (const neighbour of adjacency.get(currentIndex) || []) {
				if (!consumed.has(neighbour)) pending.push(neighbour);
			}
		}
		component.sort((left, right) => left.index - right.index);
		if (component.length < 2 || component.some((entry) => entry.hasMemberFormalCaption)) {
			result.push(...component.map((entry) => entry.group));
			continue;
		}
		const combinedMembers = component.flatMap((entry) => entry.members);
		const combinedCaption = standaloneSamePageCaption(
			combinedMembers,
			allBlocks,
			component[0].group.page_idx,
		);
		if (!combinedCaption) {
			result.push(...component.map((entry) => entry.group));
			continue;
		}
		const primary = component.find((entry) => Boolean(
			combinedCaption.markdownImageId
			&& entry.members.some((member) =>
				member.markdown_image_ids?.includes(combinedCaption.markdownImageId!)),
		)) || component[0];
		const memberIds = [...new Set(component.flatMap((entry) => entry.group.member_block_ids))]
			.sort((left, right) => (blockById.get(left)?.source_index || 0) - (blockById.get(right)?.source_index || 0));
		const markdownIds = [...new Set(component.flatMap((entry) =>
			entry.group.member_markdown_image_ids || entry.members.flatMap((block) => block.markdown_image_ids || [])))]
			.sort((left, right) => (markdownImageOrder(left) || 0) - (markdownImageOrder(right) || 0));
		const bbox = unionBboxes(component.flatMap((entry) => entry.bbox ? [entry.bbox] : []));
		if (!bbox) {
			result.push(...component.map((entry) => entry.group));
			continue;
		}
		result.push({
			...primary.group,
			member_block_ids: memberIds,
			member_markdown_image_ids: markdownIds,
			confidence: Math.min(...component.map((entry) => entry.group.confidence)),
			replacement: {
				mode: "pdf_crop",
				bbox_norm: bbox,
				padding_norm: Math.max(...component.map((entry) => Number(entry.group.replacement.padding_norm || 0))),
			},
			reason_codes: [...new Set([
				...(primary.group.reason_codes || []),
				component.every((entry) => entry.followingCaptionId === component[0].followingCaptionId)
					? "reading_order_caption_spatial_bridge"
					: "standalone_caption_spatial_bridge",
			])],
		});
	}
	return result;
}

function panelLabelProjectionsForBlocks(
	blocks: readonly MineruViewerBlock[],
	allBlocks: readonly MineruViewerBlock[],
	pageIdx: number,
): NonNullable<MineruReaderVisual["panelLabelProjections"]> {
	const projections: NonNullable<MineruReaderVisual["panelLabelProjections"]> = [];
	const seen = new Set<string>();
	for (const entry of captionPartEntries(blocks)) {
		if (entry.kind !== "panel-label") continue;
		for (const markdownImageId of entry.block.markdown_image_ids || []) {
			const key = `${markdownImageId}\u0000${entry.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			projections.push({ markdownImageId, label: entry.text });
		}
	}

	const memberIds = new Set(blocks.map((block) => block.id));
	for (const candidate of allBlocks) {
		const text = String(candidate.text?.text || "").trim();
		if (
			memberIds.has(candidate.id)
			|| candidate.role !== "text"
			|| blockPageIdx(candidate) !== pageIdx
			|| !candidate.bbox_norm
			|| !isPanelLabelText(text)
		) continue;
		const candidateBbox = candidate.bbox_norm;
		const containingMembers = blocks.filter((member) => {
			const memberBbox = member.bbox_norm;
			return Boolean(
				memberBbox
				&& member.markdown_image_ids?.length === 1
				&& bboxContainmentRatio(memberBbox, candidateBbox) >= 0.95,
			);
		});
		if (containingMembers.length !== 1) continue;
		const markdownImageId = containingMembers[0].markdown_image_ids?.[0];
		if (!markdownImageId) continue;
		const key = `${markdownImageId}\u0000${text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		projections.push({ markdownImageId, label: text });
	}
	return projections;
}

function samePageCaptionDetails(
	blocks: readonly MineruViewerBlock[],
	allBlocks: readonly MineruViewerBlock[],
	pageIdx: number,
): {
	caption: string;
	captionParts: string[];
	samePageCaptionProjections: NonNullable<MineruReaderVisual["samePageCaptionProjections"]>;
	atomicBlockProjection?: AtomicBlockProjection;
} {
	const entries = captionPartEntries(blocks);
	const allProjections = entries.flatMap((entry) => {
		const exactPlaceholder = nextPageCaptionPlaceholderFromText(entry.text);
		if (entry.kind === "other" && containsNextPageCaptionCandidate(entry.text)) {
			// Match the complete bound atom, but suppress only the strict placeholder
			// substring. Prefix OCR such as `q r` remains visible unless MinerU emitted
			// it as independently verifiable panel-label atoms.
			if (!exactPlaceholder) return [];
			return (entry.block.markdown_image_ids || []).map((markdownImageId) => ({
				markdownImageId,
				text: entry.text,
				suppressText: exactPlaceholder,
			}));
		}
		return (entry.block.markdown_image_ids || []).map((markdownImageId) => ({
			markdownImageId,
			text: entry.text,
		}));
	});
	const memberCaptions = blocks
		.map((block) => String(block.caption?.text || "").trim())
		.filter((caption) => caption.length > 1);
	const fallback = selectVisualCaption(memberCaptions);
	const emptyResult = {
		caption: fallback,
		captionParts: [],
		samePageCaptionProjections: allProjections,
	};

	const formalEntries = entries.filter((entry) => entry.kind === "formal-caption");
	if (!formalEntries.length) {
		const standalone = standaloneSamePageCaption(blocks, allBlocks, pageIdx);
		if (!standalone) return emptyResult;
		return {
			caption: standalone.text,
			captionParts: standalone.parts,
			samePageCaptionProjections: standalone.markdownImageId
				? [
					...allProjections,
					...standalone.parts.map((text) => ({
						markdownImageId: standalone.markdownImageId!,
						text,
					})),
				]
				: allProjections,
			...(standalone.atomicBlockProjection
				? { atomicBlockProjection: standalone.atomicBlockProjection }
				: {}),
		};
	}
	if (formalEntries.length !== 1) return emptyResult;
	const formal = formalEntries[0];
	const isSafeContinuation = (entry: CaptionPartEntry): boolean => {
		const structurallySequential = entry.kind === "other"
			&& !endsWithTerminalPunctuation(formal.text)
			&& hasSequentialCaptionPanels(formal.text, entry.text);
		return entry.order > formal.order
			&& (entry.kind === "caption-continuation" || structurallySequential)
			&& entry.text.length >= 24
			&& !figureKeyFromText(entry.text)
			&& endsWithTerminalPunctuation(entry.text);
	};
	const sameBlockLater = entries.filter((entry) =>
		entry.block.id === formal.block.id && entry.order > formal.order);
	const sameBlockChain: CaptionPartEntry[] = [];
	for (const entry of sameBlockLater) {
		if (!isSafeContinuation(entry)) break;
		sameBlockChain.push(entry);
	}
	const terminalFormalChain = endsWithTerminalPunctuation(formal.text)
		&& sameBlockChain.length > 0
		&& startsWithPanelLabel(sameBlockChain[0].text)
		? sameBlockChain
		: [];
	const nonTerminalCrossBlockCandidates = !endsWithTerminalPunctuation(formal.text)
		? entries.filter((entry) => isSafeContinuation(entry))
		: [];
	const continuations = sameBlockChain.length > 0 && !endsWithTerminalPunctuation(formal.text)
		? sameBlockChain
		: terminalFormalChain.length > 0
			? terminalFormalChain
			: nonTerminalCrossBlockCandidates.length === 1
				? nonTerminalCrossBlockCandidates
				: [];
	if (!continuations.length) {
		return {
			caption: fallback || formal.text,
			captionParts: [],
			samePageCaptionProjections: allProjections,
		};
	}

	return {
		caption: [formal.text, ...continuations.map((entry) => entry.text)]
			.join(" ")
			.replace(/\s+/g, " ")
			.trim(),
		captionParts: [],
		samePageCaptionProjections: allProjections,
	};
}

function markdownImageOccurrences(markdown: string): Map<string, MarkdownImageOccurrence> {
	const occurrences = new Map<string, MarkdownImageOccurrence>();
	let imageOrder = 0;
	IMAGE_TOKEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = IMAGE_TOKEN_RE.exec(markdown)) !== null) {
		const rawAssetPath = match[2] || match[3] || match[4];
		if (!rawAssetPath) continue;
		const id = `md-img-${String(imageOrder).padStart(4, "0")}`;
		imageOrder += 1;
		occurrences.set(id, { id, start: match.index, end: IMAGE_TOKEN_RE.lastIndex });
	}
	return occurrences;
}

function previousMarkdownLine(markdown: string, lineStart: number): MarkdownLineRange | null {
	if (lineStart <= 0) return null;
	const contentEnd = lineStart - 1;
	const previousNewline = markdown.lastIndexOf("\n", Math.max(0, contentEnd - 1));
	const start = previousNewline + 1;
	return {
		start,
		contentEnd,
		end: lineStart,
		text: markdown.slice(start, contentEnd),
	};
}

function nextMarkdownLine(markdown: string, lineStart: number): MarkdownLineRange | null {
	if (lineStart >= markdown.length) return null;
	const newline = markdown.indexOf("\n", lineStart);
	const contentEnd = newline < 0 ? markdown.length : newline;
	return {
		start: lineStart,
		contentEnd,
		end: newline < 0 ? markdown.length : newline + 1,
		text: markdown.slice(lineStart, contentEnd),
	};
}

function previousNonBlankMarkdownLines(
	markdown: string,
	lineStart: number,
	limit: number,
): MarkdownLineRange[] {
	const lines: MarkdownLineRange[] = [];
	let cursor = lineStart;
	let blankCount = 0;
	while (lines.length < limit) {
		const line = previousMarkdownLine(markdown, cursor);
		if (!line) break;
		cursor = line.start;
		if (!line.text.trim()) {
			blankCount += 1;
			if (blankCount > 2) break;
			continue;
		}
		blankCount = 0;
		lines.push(line);
	}
	return lines;
}

function nextNonBlankMarkdownLines(
	markdown: string,
	lineStart: number,
	limit: number,
): MarkdownLineRange[] {
	const lines: MarkdownLineRange[] = [];
	let cursor = lineStart;
	let blankCount = 0;
	while (lines.length < limit) {
		const line = nextMarkdownLine(markdown, cursor);
		if (!line) break;
		cursor = line.end;
		if (!line.text.trim()) {
			blankCount += 1;
			if (blankCount > 2) break;
			continue;
		}
		blankCount = 0;
		lines.push(line);
	}
	return lines;
}

/**
 * Match a complete ordered caption-atom run on exactly one side of its bound
 * Markdown image occurrence. A gap, reorder, partial match, or two-sided
 * ambiguity preserves the whole run.
 */
function adjacentProjectedTextRunRanges(
	markdown: string,
	occurrence: MarkdownImageOccurrence,
	parts: readonly SamePageCaptionProjection[],
): Array<{ start: number; end: number }> | null {
	const normalizedParts = parts
		.map((part) => ({
			...part,
			text: part.text.trim(),
			suppressText: part.suppressText?.trim(),
		}))
		.filter((part) => Boolean(part.text));
	if (
		!normalizedParts.length
		|| normalizedParts.some((part) => /[\r\n]/.test(part.text))
		|| normalizedParts.some((part) => part.suppressText && /[\r\n]/.test(part.suppressText))
	) return null;
	const imageLineStart = markdown.lastIndexOf("\n", Math.max(0, occurrence.start - 1)) + 1;
	const imageNewline = markdown.indexOf("\n", occurrence.end);
	const imageLineEnd = imageNewline < 0 ? markdown.length : imageNewline;
	if (
		markdown.slice(imageLineStart, occurrence.start).trim()
		|| markdown.slice(occurrence.end, imageLineEnd).trim()
	) return null;

	const previousLines = previousNonBlankMarkdownLines(
		markdown,
		imageLineStart,
		normalizedParts.length,
	);
	const nextLines = nextNonBlankMarkdownLines(
		markdown,
		imageNewline < 0 ? markdown.length : imageNewline + 1,
		normalizedParts.length,
	);
	const matchingSplits: Array<{ beforeCount: number; afterCount: number }> = [];
	for (let beforeCount = 0; beforeCount <= normalizedParts.length; beforeCount += 1) {
		const afterCount = normalizedParts.length - beforeCount;
		const beforeMatches = previousLines.length >= beforeCount
			&& previousLines
				.slice(0, beforeCount)
				.reverse()
				.every((line, index) => line.text.trim() === normalizedParts[index].text);
		const afterMatches = nextLines.length >= afterCount
			&& nextLines
				.slice(0, afterCount)
				.every((line, index) => line.text.trim() === normalizedParts[beforeCount + index].text);
		if (beforeMatches && afterMatches) matchingSplits.push({ beforeCount, afterCount });
	}
	if (matchingSplits.length !== 1) return null;
	const [{ beforeCount, afterCount }] = matchingSplits;
	const matched = [
		...previousLines
			.slice(0, beforeCount)
			.reverse()
			.map((line, index) => ({ line, part: normalizedParts[index] })),
		...nextLines
			.slice(0, afterCount)
			.map((line, index) => ({ line, part: normalizedParts[beforeCount + index] })),
	];
	const ranges: Array<{ start: number; end: number }> = [];
	for (const { line, part } of matched) {
		if (!part.suppressText) {
			ranges.push({ start: line.start, end: line.end });
			continue;
		}
		const localIndex = line.text.indexOf(part.suppressText);
		if (
			localIndex < 0
			|| line.text.indexOf(part.suppressText, localIndex + part.suppressText.length) >= 0
		) return null;
		ranges.push({
			start: line.start + localIndex,
			end: line.start + localIndex + part.suppressText.length,
		});
	}
	return ranges;
}

function verifiedSourceProjectionRanges(
	markdown: string,
	visuals: readonly MineruReaderVisual[],
	localRangesByVisual: ReadonlyMap<string, readonly { start: number; end: number }[]>,
	occurrences: ReadonlyMap<string, MarkdownImageOccurrence>,
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const visual of visuals) {
		const projections = visual.captionSourceProjections || [];
		const bounds = visual.captionSourceImageBounds;
		const beforeImage = bounds ? occurrences.get(bounds.beforeMarkdownImageId) : undefined;
		const afterImage = bounds ? occurrences.get(bounds.afterMarkdownImageId) : undefined;
		if (
			!projections.length
			|| !beforeImage
			|| !afterImage
			|| beforeImage.start >= afterImage.start
		) continue;
		const verified: Array<{ start: number; end: number }> = [];
		let valid = true;
		for (const projection of projections) {
			const { start, end } = projection;
			const expected = projection.text.trim();
			const source = Number.isInteger(start) && Number.isInteger(end)
				? markdown.slice(start, end)
				: "";
			const content = source.endsWith("\n") ? source.slice(0, -1).replace(/\r$/, "") : source;
			IMAGE_TOKEN_RE.lastIndex = 0;
			const containsImageToken = IMAGE_TOKEN_RE.test(content);
			IMAGE_TOKEN_RE.lastIndex = 0;
			if (
				!expected
				|| start < 0
				|| end <= start
				|| end > markdown.length
				|| (start > 0 && markdown[start - 1] !== "\n")
				|| (end < markdown.length && markdown[end - 1] !== "\n")
				|| /[\r\n]/.test(content)
				|| content.trim() !== expected
				|| containsImageToken
			) {
				valid = false;
				break;
			}
			verified.push({ start, end });
		}
		if (!valid || verified.length !== projections.length) continue;
		if (
			verified[0].start < beforeImage.end
			|| verified[verified.length - 1].end > afterImage.start
		) continue;
		for (let index = 1; index < verified.length; index += 1) {
			const previous = verified[index - 1];
			const current = verified[index];
			if (
				current.start < previous.end
				|| markdown.slice(previous.end, current.start).trim()
			) {
				valid = false;
				break;
			}
		}
		if (!valid) continue;
		const targetChainBound = verified.length >= 2;
		const occurrenceBound = verified.length === 1
			&& (localRangesByVisual.get(visual.id) || []).some((localRange) =>
				localRange.end <= verified[0].start
				&& !markdown.slice(localRange.end, verified[0].start).trim());
		if (!targetChainBound && !occurrenceBound) continue;
		verified.forEach((range, index) => {
			if (projections[index].suppress !== false) ranges.push(range);
		});
	}
	return ranges;
}

function verifiedBoundedHeadingRanges(
	markdown: string,
	visuals: readonly MineruReaderVisual[],
	occurrences: ReadonlyMap<string, MarkdownImageOccurrence>,
): Array<{ start: number; end: number }> {
	const boundaryRange = (boundary: BoundedHeadingBoundary): { start: number; end: number } | null => {
		if (boundary.kind === "image") return occurrences.get(boundary.markdownImageId) || null;
		const range = boundary.markdownTableRange;
		if (
			range.offset_unit !== "utf16-code-unit"
			|| !Number.isInteger(range.start)
			|| !Number.isInteger(range.end)
			|| range.start < 0
			|| range.end <= range.start
			|| range.end > markdown.length
		) return null;
		const source = markdown.slice(range.start, range.end);
		const lineStart = markdown.lastIndexOf("\n", Math.max(0, range.start - 1)) + 1;
		const nextNewline = markdown.indexOf("\n", range.end);
		const lineEnd = nextNewline < 0 ? markdown.length : nextNewline;
		if (
			!/^<table\b[^>]*>[\s\S]*<\/table>$/i.test(source)
			|| markdown.slice(lineStart, range.start).trim()
			|| markdown.slice(range.end, lineEnd).trim()
			|| markdown.indexOf(source) !== range.start
			|| markdown.indexOf(source, range.start + source.length) >= 0
		) return null;
		return { start: range.start, end: range.end };
	};
	const ranges: Array<{ start: number; end: number }> = [];
	for (const visual of visuals) {
		for (const projection of visual.boundedHeadingProjections || []) {
			const expected = projection.text.trim();
			const beforeBoundary = boundaryRange(projection.before);
			const afterBoundary = boundaryRange(projection.after);
			if (!expected || !beforeBoundary || !afterBoundary || beforeBoundary.start >= afterBoundary.start) continue;
			const beforeLineEnd = markdown.indexOf("\n", beforeBoundary.end);
			const scanStart = beforeLineEnd < 0 ? markdown.length : beforeLineEnd + 1;
			const afterLineStart = markdown.lastIndexOf("\n", Math.max(0, afterBoundary.start - 1)) + 1;
			if (scanStart > afterLineStart) continue;
			const matches: MarkdownLineRange[] = [];
			let cursor = scanStart;
			while (cursor < afterLineStart) {
				const line = nextMarkdownLine(markdown, cursor);
				if (!line || line.start >= afterLineStart) break;
				cursor = line.end;
				const heading = /^\s{0,3}#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/.exec(line.text);
				if (heading?.[1].trim() === expected) matches.push(line);
			}
			if (matches.length === 1) ranges.push({ start: matches[0].start, end: matches[0].end });
		}
	}
	return ranges;
}

function verifiedInlineCaptionRanges(
	markdown: string,
	visuals: readonly MineruReaderVisual[],
	viewerIndex: MineruViewerIndex | undefined,
): Array<{ start: number; end: number }> {
	if (!viewerIndex) return [];
	const blockById = new Map(
		viewerIndex.pages.flatMap((page) => page.blocks).map((block) => [block.id, block]),
	);
	const ranges: Array<{ start: number; end: number }> = [];
	for (const visual of visuals) {
		for (const projection of visual.captionInlineProjections || []) {
			const block = blockById.get(projection.sourceBlockId);
			const blockRange = block?.markdown_text_range;
			if (
				!block
				|| block.role !== "text"
				|| !blockRange
				|| blockRange.offset_unit !== "utf16-code-unit"
				|| !Number.isInteger(projection.start)
				|| !Number.isInteger(projection.end)
				|| projection.start < blockRange.start
				|| projection.end > blockRange.end
				|| projection.end <= projection.start
			) continue;
			const exact = markdown.slice(projection.start, projection.end);
			if (
				!projection.text
				|| exact !== projection.text
				|| markdown.indexOf(projection.text) !== projection.start
				|| markdown.indexOf(projection.text, projection.start + projection.text.length) >= 0
				|| !hasSequentialCaptionPanels(visual.captionParts[0] || visual.caption, exact)
			) continue;
			ranges.push({ start: projection.start, end: projection.end });
		}
	}
	return ranges;
}

function suppressProjectedReaderText(
	markdown: string,
	visuals: readonly MineruReaderVisual[],
	viewerIndex?: MineruViewerIndex,
): string {
	const occurrences = markdownImageOccurrences(markdown);
	const ranges = new Map<string, { start: number; end: number }>();
	const captionTexts = new Map<string, Set<string>>();
	const localRangesByVisual = new Map<string, Array<{ start: number; end: number }>>();
	for (const visual of visuals) {
		const captionRuns = new Map<string, SamePageCaptionProjection[]>();
		for (const projection of visual.samePageCaptionProjections || []) {
			const text = projection.text.trim();
			if (!text) continue;
			const run = captionRuns.get(projection.markdownImageId) || [];
			run.push({
				...projection,
				text,
				...(projection.suppressText ? { suppressText: projection.suppressText.trim() } : {}),
			});
			captionRuns.set(projection.markdownImageId, run);
			const texts = captionTexts.get(projection.markdownImageId) || new Set<string>();
			texts.add(text);
			captionTexts.set(projection.markdownImageId, texts);
		}
		for (const [markdownImageId, parts] of captionRuns) {
			const occurrence = occurrences.get(markdownImageId);
			if (!occurrence) continue;
			const matchedRanges = adjacentProjectedTextRunRanges(markdown, occurrence, parts);
			if (!matchedRanges?.length) continue;
			const visualRanges = localRangesByVisual.get(visual.id) || [];
			visualRanges.push(...matchedRanges);
			localRangesByVisual.set(visual.id, visualRanges);
			for (const range of matchedRanges) ranges.set(`${range.start}:${range.end}`, range);
		}
	}
	for (const visual of visuals) {
		for (const projection of visual.panelLabelProjections || []) {
			const label = projection.label.trim();
			if (
				!label
				|| !isPanelLabelText(label)
				|| captionTexts.get(projection.markdownImageId)?.has(label)
			) continue;
			const occurrence = occurrences.get(projection.markdownImageId);
			if (!occurrence) continue;
			const matchedRanges = adjacentProjectedTextRunRanges(markdown, occurrence, [{
				markdownImageId: projection.markdownImageId,
				text: label,
			}]);
			for (const range of matchedRanges || []) ranges.set(`${range.start}:${range.end}`, range);
		}
	}
	for (const range of verifiedSourceProjectionRanges(markdown, visuals, localRangesByVisual, occurrences)) {
		ranges.set(`${range.start}:${range.end}`, range);
	}
	for (const range of verifiedBoundedHeadingRanges(markdown, visuals, occurrences)) {
		ranges.set(`${range.start}:${range.end}`, range);
	}
	for (const range of verifiedInlineCaptionRanges(markdown, visuals, viewerIndex)) {
		ranges.set(`${range.start}:${range.end}`, range);
	}
	return [...ranges.values()]
		.sort((left, right) => right.start - left.start)
		.reduce(
			(result, range) => `${result.slice(0, range.start)}${result.slice(range.end)}`,
			markdown,
		);
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function nextPagePlaceholdersForFigure(
	caption: MineruViewerBlock["caption"] | undefined,
	figureKey: string,
): string[] {
	if (!caption) return [];
	if (caption.next_page_placeholders !== undefined) {
		return caption.next_page_placeholders
			.filter((placeholder) => placeholder.figure_key === figureKey)
			.map((placeholder) => String(placeholder.text || "").trim())
			.filter(Boolean);
	}
	const legacy = nextPageCaptionPlaceholderFromText(String(caption.text || ""), figureKey);
	return legacy ? [legacy] : [];
}

function markdownImageOrder(markdownImageId: string): number | null {
	const match = /^md-img-(\d+)$/.exec(markdownImageId);
	return match ? Number(match[1]) : null;
}

function sourceImageBoundsForProjectionBlocks(
	projectionBlocks: readonly MineruViewerBlock[],
	allBlocks: readonly MineruViewerBlock[],
): MineruReaderVisual["captionSourceImageBounds"] | null {
	if (!projectionBlocks.length) return null;
	const mappedVisuals = allBlocks
		.filter((block) => block.role === "visual" && block.markdown_image_ids?.length === 1)
		.map((block) => ({
			block,
			markdownImageId: block.markdown_image_ids![0],
			markdownOrder: markdownImageOrder(block.markdown_image_ids![0]),
		}))
		.filter((entry): entry is typeof entry & { markdownOrder: number } => entry.markdownOrder !== null)
		.sort((left, right) => left.block.source_index - right.block.source_index);
	if (mappedVisuals.length < 2) return null;
	for (let index = 1; index < mappedVisuals.length; index += 1) {
		if (
			mappedVisuals[index].block.source_index <= mappedVisuals[index - 1].block.source_index
			|| mappedVisuals[index].markdownOrder <= mappedVisuals[index - 1].markdownOrder
		) return null;
	}
	const firstSourceIndex = Math.min(...projectionBlocks.map((block) => block.source_index));
	const lastSourceIndex = Math.max(...projectionBlocks.map((block) => block.source_index));
	const before = [...mappedVisuals]
		.reverse()
		.find((entry) => entry.block.source_index < firstSourceIndex);
	const after = mappedVisuals.find((entry) => entry.block.source_index > lastSourceIndex);
	if (!before || !after) return null;
	const intervalTextBlocks = allBlocks.filter((block) =>
		block.source_index > before.block.source_index
		&& block.source_index < after.block.source_index
		&& ["text", "title"].includes(block.role)
		&& Boolean(blockText(block)));
	for (const projectionBlock of projectionBlocks) {
		const text = blockText(projectionBlock);
		if (intervalTextBlocks.filter((block) => blockText(block) === text).length !== 1) return null;
	}
	return {
		beforeMarkdownImageId: before.markdownImageId,
		afterMarkdownImageId: after.markdownImageId,
	};
}

function runningHeaderSourceBounds(
	block: MineruViewerBlock,
	allBlocks: readonly MineruViewerBlock[],
): Pick<BoundedHeadingProjection, "before" | "after"> | null {
	const anchors: Array<{ sourceIndex: number; boundary: BoundedHeadingBoundary }> = [];
	for (const candidate of allBlocks) {
		if (candidate.role === "visual" && candidate.markdown_image_ids?.length === 1) {
			anchors.push({
				sourceIndex: candidate.source_index,
				boundary: {
					kind: "image" as const,
					markdownImageId: candidate.markdown_image_ids[0],
				},
			});
			continue;
		}
		if (candidate.role === "table" && candidate.markdown_table_range) {
			anchors.push({
				sourceIndex: candidate.source_index,
				boundary: {
					kind: "table" as const,
					markdownTableRange: candidate.markdown_table_range,
				},
			});
		}
	}
	anchors.sort((left, right) => left.sourceIndex - right.sourceIndex);
	const before = [...anchors].reverse().find((anchor) => anchor.sourceIndex < block.source_index);
	const after = anchors.find((anchor) => anchor.sourceIndex > block.source_index);
	if (!before || !after) return null;
	const sameTextBlocks = allBlocks.filter((candidate) => (
		candidate.source_index > before.sourceIndex
		&& candidate.source_index < after.sourceIndex
		&& blockText(candidate) === blockText(block)
		&& (candidate.id === block.id || ["text", "title"].includes(candidate.role))
	));
	if (sameTextBlocks.length !== 1 || sameTextBlocks[0].id !== block.id) return null;
	return { before: before.boundary, after: after.boundary };
}

function runningHeaderProjectionsForPages(
	allBlocks: readonly MineruViewerBlock[],
	pageIndices: ReadonlySet<number>,
): NonNullable<MineruReaderVisual["boundedHeadingProjections"]> {
	const explicitHeaders = allBlocks.filter((block) => (
		block.role === "discarded"
		&& ["header", "page_header"].includes(block.source_type.toLowerCase())
		&& Boolean(block.bbox_norm)
		&& Boolean(blockText(block))
	));
	if (!explicitHeaders.length) return [];
	const projections = new Map<string, NonNullable<MineruReaderVisual["boundedHeadingProjections"]>[number]>();
	for (const block of allBlocks) {
		const pageIdx = blockPageIdx(block);
		const text = blockText(block);
		if (
			pageIdx === null
			|| !pageIndices.has(pageIdx)
			|| block.role !== "discarded"
			|| ["header", "page_header"].includes(block.source_type.toLowerCase())
			|| !block.bbox_norm
			|| !text
			|| text.length > 80
			|| /[\r\n]/.test(text)
		) continue;
		const hasExactHeaderTwin = explicitHeaders.some((header) => {
			const headerPageIdx = blockPageIdx(header);
			return headerPageIdx !== null
				&& headerPageIdx !== pageIdx
				&& blockText(header) === text
				&& Boolean(header.bbox_norm)
				&& block.bbox_norm!.every((coordinate, index) =>
					Math.abs(coordinate - header.bbox_norm![index]) <= 10);
		});
		if (!hasExactHeaderTwin) continue;
		const bounds = runningHeaderSourceBounds(block, allBlocks);
		if (!bounds) continue;
		const boundaryKey = (boundary: BoundedHeadingBoundary): string => boundary.kind === "image"
			? `image:${boundary.markdownImageId}`
			: `table:${boundary.markdownTableRange.start}:${boundary.markdownTableRange.end}`;
		const key = `${text}\u0000${boundaryKey(bounds.before)}\u0000${boundaryKey(bounds.after)}`;
		projections.set(key, { text, ...bounds });
	}
	return [...projections.values()];
}

function sourceMatchesCaptionLink(source: MineruViewerBlock | undefined, link: MineruCaptionLink): boolean {
	const caption = source?.caption;
	const placeholders = nextPagePlaceholdersForFigure(caption, link.figure_key);
	return link.relation === "next_page_figure_caption"
		&& link.target_page_idx === link.source_page_idx + 1
		&& source?.role === "visual"
		&& Boolean(source.asset_path && source.bbox_norm)
		&& caption?.next_page_marker === true
		&& sameIds(caption.figure_keys || [], [link.figure_key])
		&& sameIds(caption.next_page_figure_keys || [], [link.figure_key])
		&& placeholders.length === 1;
}

/**
 * Recompute the safe caption span from current MinerU blocks. This keeps a
 * stale or edited caption_links contract from jumping over body/figure
 * boundaries or absorbing prose after a complete caption.
 */
export function captionLinkMatchesBlocks(
	link: MineruCaptionLink,
	source: MineruViewerBlock | undefined,
	targetPageBlocks: readonly MineruViewerBlock[],
): boolean {
	if (!sourceMatchesCaptionLink(source, link)) return false;
	const ordered = [...targetPageBlocks].sort(
		(left, right) => left.page_order - right.page_order || left.source_index - right.source_index,
	);
	const anchorPosition = ordered.findIndex((block) => block.id === link.caption_block_ids[0]);
	if (anchorPosition < 0) return false;
	for (let position = 0; position < anchorPosition; position += 1) {
		const block = ordered[position];
		if (block.role === "discarded") continue;
		if (["visual", "table", "equation"].includes(block.role)) return false;
		if (!["text", "title"].includes(block.role) || !blockText(block)) continue;
		return false;
	}
	const anchor = ordered[anchorPosition];
	const anchorText = blockText(anchor);
	if (
		!isTopTextBlock(anchor)
		|| formalFigureCaptionKeyFromText(anchorText) !== link.figure_key
	) return false;

	const expectedIds = [anchor.id];
	let expectedStatus: MineruCaptionLink["status"] = "partial";
	if (endsWithTerminalPunctuation(anchorText)) {
		expectedStatus = "complete";
	} else {
		for (const next of ordered.slice(anchorPosition + 1)) {
			if (next.role === "discarded") continue;
			if (["visual", "table", "equation"].includes(next.role)) break;
			if (!["text", "title"].includes(next.role)) continue;
			const nextText = blockText(next);
			if (!nextText) {
				if (sameTopCaptionBand(anchor, next)) break;
				continue;
			}
			const nextFormalKey = formalFigureCaptionKeyFromText(nextText);
			if (nextFormalKey === link.figure_key && sameTopCaptionBand(anchor, next)) return false;
			if (
				next.role === "text"
				&& !figureKeyFromText(nextText)
				&& sameTopCaptionBand(anchor, next)
				&& (firstAlphaIsLowercase(nextText) || startsWithPanelLabel(nextText))
			) {
				expectedIds.push(next.id);
				expectedStatus = endsWithTerminalPunctuation(nextText) ? "complete" : "partial";
			}
			break;
		}
	}
	return sameIds(link.caption_block_ids, expectedIds) && link.status === expectedStatus;
}

function inferredLinksForSource(
	source: MineruViewerBlock,
	allBlocks: readonly MineruViewerBlock[],
	pageIdx: number,
): MineruCaptionLink[] {
	const figureKeys = source.caption?.next_page_figure_keys || [];
	if (figureKeys.length !== 1) return [];
	const figureKey = figureKeys[0];
	const targetPageIdx = pageIdx + 1;
	const targetBlocks = allBlocks.filter((block) => blockPageIdx(block) === targetPageIdx);
	const anchors = targetBlocks.filter((block) => (
		["text", "title"].includes(block.role)
		&& isTopTextBlock(block)
		&& formalFigureCaptionKeyFromText(blockText(block)) === figureKey
	));
	const candidates: MineruCaptionLink[] = [];
	for (const anchor of anchors) {
		const possibleIds = [[anchor.id]];
		for (const continuation of targetBlocks) {
			if (continuation.id !== anchor.id && ["text", "title"].includes(continuation.role)) {
				possibleIds.push([anchor.id, continuation.id]);
			}
		}
		for (const captionBlockIds of possibleIds) {
			for (const status of ["complete", "partial"] as const) {
				const link: MineruCaptionLink = {
					visual_block_id: source.id,
					caption_block_ids: captionBlockIds,
					source_page_idx: pageIdx,
					target_page_idx: targetPageIdx,
					figure_key: figureKey,
					relation: "next_page_figure_caption",
					status,
				};
				if (captionLinkMatchesBlocks(link, source, targetBlocks)) candidates.push(link);
			}
		}
	}
	return candidates;
}

/** Infer a link only when one group member has exactly one strict candidate. */
export function inferRuntimeNextPageCaptionLink(
	blocks: readonly MineruViewerBlock[],
	allBlocks: readonly MineruViewerBlock[],
	pageIdx: number,
): MineruCaptionLink | null {
	const candidates = blocks.flatMap((block) => inferredLinksForSource(block, allBlocks, pageIdx));
	return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Locate an empty MinerU text column that is spatially aligned with a
 * next-page caption anchor. The original PDF text layer may still contain the
 * missing words, so callers can read only these tightly bounded regions.
 */
export function pdfCaptionContinuationRegions(
	visuals: readonly MineruReaderVisual[],
	viewerIndex: MineruViewerIndex,
): PdfCaptionContinuationRegion[] {
	const allBlocks = viewerIndex.pages.flatMap((page) => page.blocks);
	const blockById = new Map(allBlocks.map((block) => [block.id, block]));
	const candidates: PdfCaptionContinuationRegion[] = [];
	for (const visual of visuals) {
		if (
			visual.captionStatus
			&& visual.captionPageIdx !== undefined
			&& visual.captionSourceBlockIds.length === 1
		) {
			const anchor = blockById.get(visual.captionSourceBlockIds[0]);
			const anchorText = blockText(anchor);
			const anchorKey = formalFigureCaptionKeyFromText(anchorText);
			if (
				!anchor
				|| !anchor.bbox_norm
				|| !anchorKey
				|| !captionPanelMarkers(anchorText).length
			) continue;
			const explicitSources = visual.memberBlockIds
				.map((id) => blockById.get(id))
				.filter((block): block is MineruViewerBlock => Boolean(
					block?.caption?.next_page_marker === true
						&& block.caption.next_page_figure_keys?.length === 1
						&& block.caption.next_page_figure_keys[0] === anchorKey,
				));
			if (explicitSources.length !== 1) continue;
			const page = viewerIndex.pages.find((candidate) => candidate.page_idx === visual.captionPageIdx);
			if (!page) continue;
			const emptyAligned = page.blocks.filter((block) => (
				block.id !== anchor.id
				&& block.role === "text"
				&& Boolean(block.bbox_norm)
				&& !blockText(block)
				&& Number(block.text?.char_count || 0) === 0
				&& sameTopCaptionBand(anchor, block)
			));
			if (emptyAligned.length !== 1 || !emptyAligned[0].bbox_norm) continue;
			candidates.push({
				visualId: visual.id,
				sourceBlockId: emptyAligned[0].id,
				pageNumber: visual.captionPageIdx + 1,
				bbox: [...emptyAligned[0].bbox_norm] as NormalizedBbox,
			});
			continue;
		}

		// Some MinerU outputs attach only the left half of a two-column caption
		// to the final figure asset, leave the right caption column empty, and
		// merge that right-column text into the preceding page's body block.
		// Recover only when one incomplete formal caption and one directly
		// adjacent empty PDF column form a unique spatial pair.
		if (visual.captionSourceBlockIds.length || visual.captionPageIdx !== undefined) continue;
		const members = visual.memberBlockIds
			.map((id) => blockById.get(id))
			.filter((block): block is MineruViewerBlock => Boolean(block));
		const entries = captionPartEntries(members);
		const formalEntries = entries.filter((entry) => entry.kind === "formal-caption");
		if (formalEntries.length !== 1) continue;
		const formal = formalEntries[0];
		if (
			!formal.block.bbox_norm
			|| endsWithTerminalPunctuation(formal.text)
			|| !captionPanelMarkers(formal.text).length
			|| entries.some((entry) => (
				entry.order > formal.order && entry.kind === "caption-continuation"
			))
		) continue;
		const page = viewerIndex.pages.find((candidate) => candidate.page_idx === visual.pageIdx);
		if (!page) continue;
		const emptyAdjacent = page.blocks.filter((block) => (
			block.id !== formal.block.id
			&& block.role === "text"
			&& Boolean(block.bbox_norm)
			&& !blockText(block)
			&& Number(block.text?.char_count || 0) === 0
			&& captionAdjacencyScore(block.bbox_norm!, formal.block.bbox_norm!) !== null
		));
		if (emptyAdjacent.length !== 1 || !emptyAdjacent[0].bbox_norm) continue;
		candidates.push({
			visualId: visual.id,
			sourceBlockId: emptyAdjacent[0].id,
			pageNumber: visual.pageIdx + 1,
			bbox: [...emptyAdjacent[0].bbox_norm] as NormalizedBbox,
		});
	}
	const claimedSources = new Map<string, number>();
	for (const candidate of candidates) {
		claimedSources.set(candidate.sourceBlockId, (claimedSources.get(candidate.sourceBlockId) || 0) + 1);
	}
	return candidates.filter((candidate) => claimedSources.get(candidate.sourceBlockId) === 1);
}

function captionRecoveryAnchorText(
	visual: MineruReaderVisual,
	blockById: ReadonlyMap<string, MineruViewerBlock>,
): string {
	if (visual.captionSourceBlockIds.length === 1) {
		const linked = blockText(blockById.get(visual.captionSourceBlockIds[0]));
		if (linked) return linked;
	}
	const members = visual.memberBlockIds
		.map((id) => blockById.get(id))
		.filter((block): block is MineruViewerBlock => Boolean(block));
	const formal = captionPartEntries(members).filter((entry) => entry.kind === "formal-caption");
	return formal.length === 1 ? formal[0].text : "";
}

interface CaptionWordToken {
	value: string;
	start: number;
	end: number;
}

function captionWordTokens(value: string): CaptionWordToken[] {
	const tokens: CaptionWordToken[] = [];
	const pattern = /[\p{L}\p{N}]+/gu;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		tokens.push({
			value: match[0].toLocaleLowerCase(),
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return tokens;
}

/**
 * Locate a PDF caption prefix in Markdown by words rather than by a long raw
 * substring. This tolerates PDF.js line breaks, non-breaking spaces and
 * punctuation/soft-hyphen differences while still requiring one unique block.
 */
function tokenPrefixStart(content: string, recoveredText: string): number {
	const recovered = captionWordTokens(recoveredText);
	const candidate = captionWordTokens(content);
	const prefixLength = Math.min(14, recovered.length);
	if (prefixLength < 7 || candidate.length < prefixLength) return -1;
	const prefix = recovered.slice(0, prefixLength).map((token) => token.value);
	const starts: number[] = [];
	for (let index = 0; index + prefix.length <= candidate.length; index += 1) {
		if (prefix.every((value, offset) => candidate[index + offset].value === value)) {
			starts.push(candidate[index].start);
		}
	}
	return starts.length === 1 ? starts[0] : -1;
}

function inlineProjectionForRecoveredCaption(
	markdown: string,
	targetBlocks: readonly MineruViewerBlock[],
	anchorText: string,
	recoveredText: string,
): NonNullable<MineruReaderVisual["captionInlineProjections"]>[number] | null {
	const recovered = recoveredText
		.replace(/([\p{L}\p{N}])[-\u00ad]\s+([\p{L}\p{N}])/gu, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
	if (
		recovered.length < 32
		|| figureKeyFromText(recovered)
		|| !hasSequentialCaptionPanels(anchorText, recovered)
	) return null;
	const matches: NonNullable<MineruReaderVisual["captionInlineProjections"]> = [];
	for (const block of targetBlocks) {
		const range = block.markdown_text_range;
		if (
			block.role !== "text"
			|| !range
			|| range.offset_unit !== "utf16-code-unit"
			|| range.start < 0
			|| range.end <= range.start
			|| range.end > markdown.length
		) continue;
		const source = markdown.slice(range.start, range.end);
		const content = source.endsWith("\n") ? source.slice(0, -1).replace(/\r$/, "") : source;
		const localStart = tokenPrefixStart(content, recovered);
		const localEnd = content.trimEnd().length;
		if (localStart < 0 || localEnd <= localStart) continue;
		const text = content.slice(localStart, localEnd);
		if (!hasSequentialCaptionPanels(anchorText, text)) continue;
		matches.push({
			sourceBlockId: block.id,
			start: range.start + localStart,
			end: range.start + localEnd,
			text,
		});
	}
	return matches.length === 1 ? matches[0] : null;
}

/**
 * Apply PDF text recovered from the exact empty caption column. Suppression is
 * limited to a unique suffix inside one mapped Markdown block; the legitimate
 * body prefix of a MinerU-merged paragraph is preserved.
 */
export function applyPdfCaptionContinuationRecovery(
	markdown: string,
	visuals: MineruReaderVisual[],
	viewerIndex: MineruViewerIndex,
	recoveredRegions: readonly PdfCaptionContinuationText[],
): number {
	const requests = new Map(
		pdfCaptionContinuationRegions(visuals, viewerIndex)
			.map((region) => [`${region.visualId}\u0000${region.sourceBlockId}`, region]),
	);
	const claimedRanges = new Set<string>();
	const blockById = new Map(
		viewerIndex.pages.flatMap((page) => page.blocks).map((block) => [block.id, block]),
	);
	let recoveredCount = 0;
	for (const recovered of recoveredRegions) {
		const request = requests.get(`${recovered.visualId}\u0000${recovered.sourceBlockId}`);
		const visual = visuals.find((candidate) => candidate.id === recovered.visualId);
		if (!request || !visual || request.pageNumber !== recovered.pageNumber) continue;
		const page = viewerIndex.pages.find((candidate) => candidate.page_idx + 1 === recovered.pageNumber);
		const anchorText = captionRecoveryAnchorText(visual, blockById);
		if (!page || !anchorText) continue;
		const candidateBlocks = viewerIndex.pages
			.filter((candidate) => (
				candidate.page_idx === page.page_idx || candidate.page_idx === page.page_idx - 1
			))
			.flatMap((candidate) => candidate.blocks);
		const projection = inlineProjectionForRecoveredCaption(
			markdown,
			candidateBlocks,
			anchorText,
			recovered.text,
		);
		if (!projection || claimedRanges.has(`${projection.start}:${projection.end}`)) continue;
		claimedRanges.add(`${projection.start}:${projection.end}`);
		// Prefer the exact Markdown suffix after the PDF text has located it. The
		// Markdown keeps equations and punctuation more faithfully than PDF.js.
		const continuation = projection.text.replace(/\s+/g, " ").trim();
		visual.caption = `${visual.caption.trim()} ${continuation}`.replace(/\s+/g, " ").trim();
		visual.captionParts = [...new Set([
			...(visual.captionParts.length ? visual.captionParts : [anchorText]),
			continuation,
		])];
		visual.captionInlineProjections = [...(visual.captionInlineProjections || []), projection];
		visual.captionStatus = endsWithTerminalPunctuation(continuation) ? "complete" : "partial";
		recoveredCount += 1;
	}
	return recoveredCount;
}

export function prepareReaderMarkdown(
	markdown: string,
	visuals: readonly MineruReaderVisual[],
	viewerIndex?: MineruViewerIndex,
): string {
	const atomicCaptures = visuals.flatMap((visual) => {
		const projection = visual.atomicBlockProjection;
		if (!projection) return [];
		const tableRange = projection.tableRange;
		const captionRange = projection.captionRange;
		if (
			tableRange.offset_unit !== "utf16-code-unit"
			|| captionRange.offset_unit !== "utf16-code-unit"
			|| !Number.isInteger(tableRange.start)
			|| !Number.isInteger(tableRange.end)
			|| !Number.isInteger(captionRange.start)
			|| !Number.isInteger(captionRange.end)
			|| tableRange.start < 0
			|| tableRange.end <= tableRange.start
			|| captionRange.start < tableRange.end
			|| captionRange.end <= captionRange.start
			|| captionRange.end > markdown.length
		) return [];
		const tableText = markdown.slice(tableRange.start, tableRange.end);
		const captionSource = markdown.slice(captionRange.start, captionRange.end);
		const captionContent = captionSource.endsWith("\n")
			? captionSource.slice(0, -1).replace(/\r$/, "")
			: captionSource;
		const captionText = projection.captionText.trim();
		if (
			!/^<table\b[^>]*>[\s\S]*<\/table>$/i.test(tableText)
			|| !captionText
			|| captionContent.trim() !== captionText
			|| markdown.indexOf(tableText) !== tableRange.start
			|| markdown.indexOf(tableText, tableRange.start + tableText.length) >= 0
			|| markdown.indexOf(captionText) !== captionRange.start + captionContent.indexOf(captionText)
			|| markdown.indexOf(captionText, captionRange.start + captionContent.indexOf(captionText) + captionText.length) >= 0
			|| markdown.slice(tableRange.end, captionRange.start).trim()
			|| (captionRange.start > 0 && markdown[captionRange.start - 1] !== "\n")
			|| (captionRange.end < markdown.length && markdown[captionRange.end - 1] !== "\n")
		) return [];
		return [{ visualId: visual.id, tableText, captionSource, captionText }];
	});
	const locateAtomicCapture = (
		value: string,
		capture: typeof atomicCaptures[number],
	): { tableStart: number; tableEnd: number; captionStart: number; captionEnd: number } | null => {
		const tableStart = value.indexOf(capture.tableText);
		if (tableStart < 0 || value.indexOf(capture.tableText, tableStart + capture.tableText.length) >= 0) return null;
		const captionStart = value.indexOf(capture.captionSource, tableStart + capture.tableText.length);
		if (
			captionStart < 0
			|| value.indexOf(capture.captionSource, captionStart + capture.captionSource.length) >= 0
			|| value.indexOf(capture.captionText) < 0
			|| value.indexOf(capture.captionText, value.indexOf(capture.captionText) + capture.captionText.length) >= 0
		) return null;
		const tableEnd = tableStart + capture.tableText.length;
		const captionEnd = captionStart + capture.captionSource.length;
		if (value.slice(tableEnd, captionStart).trim()) return null;
		return { tableStart, tableEnd, captionStart, captionEnd };
	};
	const imageToVisual = new Map<string, string>();
	const assetCandidates = new Map<string, Set<string>>();
	visuals.forEach((visual) => {
		(visual.memberMarkdownImageIds || []).forEach((imageId) => imageToVisual.set(imageId, visual.id));
		visual.memberAssetPaths.forEach((assetPath) => {
			const candidates = assetCandidates.get(assetPath) || new Set<string>();
			candidates.add(visual.id);
			assetCandidates.set(assetPath, candidates);
		});
	});
	let prepared = suppressProjectedReaderText(markdown, visuals, viewerIndex);
	const protectedTableRanges = atomicCaptures.flatMap((capture) => {
		const start = prepared.indexOf(capture.tableText);
		if (start < 0 || prepared.indexOf(capture.tableText, start + capture.tableText.length) >= 0) return [];
		return [{ start, end: start + capture.tableText.length }];
	});
	const inserted = new Set<string>();
	let imageOrder = 0;
	IMAGE_TOKEN_RE.lastIndex = 0;
	prepared = prepared.replace(
		IMAGE_TOKEN_RE,
		(_match, _alt: string, anglePath: string, plainPath: string, htmlPath: string, offset: number) => {
			const rawAssetPath = anglePath || plainPath || htmlPath;
			if (!rawAssetPath) return _match;
			const imageId = `md-img-${String(imageOrder).padStart(4, "0")}`;
			imageOrder += 1;
			if (protectedTableRanges.some((range) => offset >= range.start && offset + _match.length <= range.end)) {
				return _match;
			}
			const assetPath = normalizeAssetPath(rawAssetPath);
			const candidates = assetPath ? assetCandidates.get(assetPath) : undefined;
			const visualId = imageToVisual.get(imageId)
				|| (candidates?.size === 1 ? [...candidates][0] : undefined);
			if (!visualId) return _match;
			if (inserted.has(visualId)) return "";
			inserted.add(visualId);
			return `<span class="agent-dashboard-mineru-reading-anchor" data-visual-id="${escapeHtmlAttribute(visualId)}" aria-label="图像位置"></span>`;
		},
	);
	const atomicReplacements = atomicCaptures.flatMap((capture) => {
		const located = locateAtomicCapture(prepared, capture);
		if (!located) return [];
		return [{ capture, ...located }];
	}).sort((left, right) => right.tableStart - left.tableStart);
	for (const replacement of atomicReplacements) {
		if (inserted.has(replacement.capture.visualId)) continue;
		const anchor = `<span class="agent-dashboard-mineru-reading-anchor" data-visual-id="${escapeHtmlAttribute(replacement.capture.visualId)}" aria-label="图像位置"></span>`;
		prepared = `${prepared.slice(0, replacement.tableStart)}${anchor}${prepared.slice(replacement.tableEnd, replacement.captionStart)}${prepared.slice(replacement.captionEnd)}`;
		inserted.add(replacement.capture.visualId);
	}
	if (!viewerIndex?.pages.length) return prepared;

	const positionsByPage = new Map<number, number[]>();
	const addPosition = (pageIdx: number, position: number): void => {
		if (position < 0) return;
		const positions = positionsByPage.get(pageIdx) || [];
		positions.push(position);
		positionsByPage.set(pageIdx, positions);
	};
	for (const page of viewerIndex.pages) {
		for (const block of page.blocks) {
			const range = block.markdown_text_range || block.markdown_table_range;
			if (
				!range
				|| range.offset_unit !== "utf16-code-unit"
				|| range.start < 0
				|| range.end <= range.start
				|| range.end > markdown.length
			) continue;
			const source = markdown.slice(range.start, range.end);
			if (!source.trim()) continue;
			const position = prepared.indexOf(source);
			if (position >= 0 && prepared.indexOf(source, position + source.length) < 0) {
				addPosition(page.page_idx, position);
			}
		}
	}
	const insertions: Array<{ pageNumber: number; position: number }> = [];
	let previousPosition = -1;
	const firstLineEnd = prepared.indexOf("\n");
	const firstPageFallback = firstLineEnd >= 0 ? firstLineEnd + 1 : prepared.length;
	for (const page of [...viewerIndex.pages].sort((left, right) => left.page_idx - right.page_idx)) {
		const positions = (positionsByPage.get(page.page_idx) || [])
			.filter((position) => position > previousPosition)
			.sort((left, right) => left - right);
		const position = positions[0] ?? (page.page_idx === 0 ? firstPageFallback : -1);
		if (position < 0) continue;
		insertions.push({ pageNumber: page.page_idx + 1, position });
		previousPosition = position;
	}
	for (const insertion of insertions.sort((left, right) => right.position - left.position)) {
		const anchor = `<span class="agent-dashboard-mineru-page-anchor" data-reader-page="${insertion.pageNumber}" aria-hidden="true"></span>`;
		prepared = `${prepared.slice(0, insertion.position)}${anchor}${prepared.slice(insertion.position)}`;
	}
	return prepared;
}

export function resolveVisualCaptionDetails(
	blocks: readonly MineruViewerBlock[],
	allBlocks: readonly MineruViewerBlock[],
	repair: MineruVisualRepair | null,
	pageIdx: number,
): Pick<
	MineruReaderVisual,
	"caption" | "captionParts" | "captionSourceBlockIds" | "captionSourceProjections" | "captionInlineProjections" | "captionSourceImageBounds" | "captionPageIdx" | "captionStatus" | "pageRange" | "panelLabelProjections" | "samePageCaptionProjections" | "atomicBlockProjection" | "boundedHeadingProjections"
> {
	const memberIds = new Set(blocks.map((block) => block.id));
	const storedLinks = (repair?.caption_links || []).filter((candidate) => memberIds.has(candidate.visual_block_id));
	const link = storedLinks.length === 1
		? storedLinks[0]
		: storedLinks.length === 0
			? inferRuntimeNextPageCaptionLink(blocks, allBlocks, pageIdx) || undefined
			: undefined;
	const memberCaptions = blocks
		.map((block) => String(block.caption?.text || "").trim())
		.filter((caption) => caption.length > 1);
	const samePageCaption = samePageCaptionDetails(blocks, allBlocks, pageIdx);
	const panelLabelProjections = panelLabelProjectionsForBlocks(blocks, allBlocks, pageIdx);
	const samePageHeadingProjections = runningHeaderProjectionsForPages(allBlocks, new Set([pageIdx]));
	const targetPageBlocks = allBlocks.filter((block) => blockPageIdx(block) === link?.target_page_idx);
	if (!link) {
		return {
			...samePageCaption,
			captionSourceBlockIds: [],
			captionSourceProjections: [],
			captionInlineProjections: [],
			captionSourceImageBounds: undefined,
			panelLabelProjections,
			boundedHeadingProjections: samePageHeadingProjections,
			pageRange: [pageIdx, pageIdx],
		};
	}
	const blockById = new Map(allBlocks.map((block) => [block.id, block]));
	const source = blockById.get(link.visual_block_id);
	const linkedBlocks = link.caption_block_ids.map((blockId) => blockById.get(blockId));
	if (
		linkedBlocks.some((block) => !block)
		|| !captionLinkMatchesBlocks(link, source, targetPageBlocks)
	) {
		return {
			...samePageCaption,
			captionSourceBlockIds: [],
			captionSourceProjections: [],
			captionInlineProjections: [],
			captionSourceImageBounds: undefined,
			panelLabelProjections,
			boundedHeadingProjections: samePageHeadingProjections,
			pageRange: [pageIdx, pageIdx],
		};
	}
	const sourceParts = link.caption_block_ids
		.map((blockId) => String(blockById.get(blockId)?.text?.text || "").trim())
		.filter(Boolean);
	const formalCaption = sourceParts.join(" ").replace(/\s+/g, " ").trim();
	const placeholderCaptions = blocks
		.filter((block) => block.caption?.next_page_marker === true)
		.flatMap((block) => nextPagePlaceholdersForFigure(block.caption, link.figure_key))
		.filter(Boolean);
	const resolvedLinkedBlocks = linkedBlocks.filter(
		(block): block is MineruViewerBlock => Boolean(block),
	);
	let sourceProjectionBlocks = resolvedLinkedBlocks;
	if (resolvedLinkedBlocks.length === 1) {
		const orderedTargetPageBlocks = [...targetPageBlocks]
			.sort((left, right) => left.page_order - right.page_order || left.source_index - right.source_index);
		const linkedPosition = orderedTargetPageBlocks.findIndex((block) => block.id === resolvedLinkedBlocks[0].id);
		for (const candidate of orderedTargetPageBlocks.slice(linkedPosition + 1)) {
			if (candidate.role === "discarded") continue;
			if (["visual", "table", "equation", "other"].includes(candidate.role)) break;
			if (!["text", "title"].includes(candidate.role) || !blockText(candidate)) continue;
			sourceProjectionBlocks = [...resolvedLinkedBlocks, candidate];
			break;
		}
	}
	const linkedIds = new Set(link.caption_block_ids);
	const captionSourceImageBounds = sourceImageBoundsForProjectionBlocks(sourceProjectionBlocks, allBlocks);
	const captionSourceProjections = captionSourceImageBounds
		&& sourceProjectionBlocks.every((block) => Boolean(block.markdown_text_range))
		? sourceProjectionBlocks.map((block) => ({
			start: block.markdown_text_range!.start,
			end: block.markdown_text_range!.end,
			text: blockText(block),
			suppress: linkedIds.has(block.id),
		}))
		: [];
	return {
		caption: selectVisualCaption([formalCaption, ...memberCaptions]),
		captionParts: [...new Set([...sourceParts, ...placeholderCaptions])],
		captionSourceBlockIds: [...link.caption_block_ids],
		captionSourceProjections,
		captionInlineProjections: [],
		captionSourceImageBounds: captionSourceImageBounds || undefined,
		captionPageIdx: link.target_page_idx,
		captionStatus: link.status,
		panelLabelProjections,
		boundedHeadingProjections: runningHeaderProjectionsForPages(
			allBlocks,
			new Set([pageIdx, link.target_page_idx]),
		),
		samePageCaptionProjections: samePageCaption.samePageCaptionProjections,
		pageRange: [Math.min(pageIdx, link.target_page_idx), Math.max(pageIdx, link.target_page_idx)],
	};
}

export function visualLabelFromCaption(caption: string, sequence: number): string {
	const normalized = caption.replace(/\s+/g, " ").trim();
	const match = /^(Extended Data Fig(?:ure)?\.?|Supplementary Fig(?:ure)?\.?|Fig(?:ure)?\.?|Table|图|表)\s*([A-Za-z0-9_-]+)/i.exec(normalized);
	if (match) return `${match[1]} ${match[2]}`.replace(/\s+/g, " ").trim();
	return `图像 ${sequence}`;
}

export function selectVisualCaption(captions: readonly string[]): string {
	const unique = [...new Set(captions.map((caption) => caption.trim()).filter(Boolean))];
	const figureCaptions = unique.filter((caption) =>
		Boolean(formalFigureCaptionKeyFromText(caption))
		|| /^(?:Table|表)\s*[A-Za-z0-9_-]+\s*[|｜:：.]\s*[^|｜:：.\s]/i.test(caption),
	);
	if (figureCaptions.length) {
		return figureCaptions.sort((left, right) => right.length - left.length)[0];
	}
	const safeFallbacks = unique.filter((caption) => !figureKeyFromText(caption));
	const longCaptions = safeFallbacks.filter((caption) => caption.length >= 24);
	if (longCaptions.length) return longCaptions.join(" ");
	return safeFallbacks.sort((left, right) => right.length - left.length)[0] || "";
}
