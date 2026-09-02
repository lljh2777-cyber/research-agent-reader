import type {
	MineruMarkdownFigureCaption,
	MineruMarkdownImage,
	MineruViewerBlock,
	MineruViewerIndex,
	MineruVisualRepair,
	MineruVisualRepairGroup,
	NormalizedBbox,
} from "./types";
import { captionLinkMatchesBlocks, mergeNestedVisualRepairGroups } from "./reader-markdown";
import { logicalFigureOwnershipForPage } from "./figure-ownership";

interface AdjacencyEdge {
	leftId: string;
	rightId: string;
}

const COORDINATE_EXTENT = 1000;
const ADJACENCY_GAP = 20;
const ADJACENCY_OVERLAP_RATIO = 0.15;
const ENCLOSURE_THRESHOLD = 0.95;
const ENCLOSURE_AREA_RATIO = 1.2;

export const CURRENT_VISUAL_REPAIR_ALGORITHM = "visual-repair-v1.11";

const SUPPORTED_VISUAL_REPAIR_ALGORITHMS = new Set([
	"visual-repair-v1.1",
	"visual-repair-v1.2",
	"visual-repair-v1.3",
	"visual-repair-v1.4",
	"visual-repair-v1.5",
	"visual-repair-v1.6",
	"visual-repair-v1.7",
	"visual-repair-v1.8",
	"visual-repair-v1.9",
	"visual-repair-v1.10",
	CURRENT_VISUAL_REPAIR_ALGORITHM,
]);

export function isSupportedVisualRepairAlgorithm(value: string): boolean {
	return SUPPORTED_VISUAL_REPAIR_ALGORITHMS.has(value);
}

function bboxArea(bbox: NormalizedBbox): number {
	return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

function intersectionArea(left: NormalizedBbox, right: NormalizedBbox): number {
	return Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
		* Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
}

function axisOverlap(startA: number, endA: number, startB: number, endB: number): number {
	return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function unionBbox(blocks: readonly MineruViewerBlock[]): NormalizedBbox {
	const bboxes = blocks.map((block) => block.bbox_norm).filter((bbox): bbox is NormalizedBbox => Boolean(bbox));
	return [
		Math.min(...bboxes.map((bbox) => bbox[0])),
		Math.min(...bboxes.map((bbox) => bbox[1])),
		Math.max(...bboxes.map((bbox) => bbox[2])),
		Math.max(...bboxes.map((bbox) => bbox[3])),
	];
}

function eligibleVisuals(blocks: readonly MineruViewerBlock[]): MineruViewerBlock[] {
	return blocks.filter((block) => block.role === "visual" && Boolean(block.asset_path) && Boolean(block.bbox_norm));
}

function visualAdjacency(blocks: readonly MineruViewerBlock[]): AdjacencyEdge[] {
	const edges: AdjacencyEdge[] = [];
	for (let leftIndex = 0; leftIndex < blocks.length; leftIndex += 1) {
		const left = blocks[leftIndex];
		const leftBbox = left.bbox_norm!;
		const leftWidth = leftBbox[2] - leftBbox[0];
		const leftHeight = leftBbox[3] - leftBbox[1];
		for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex += 1) {
			const right = blocks[rightIndex];
			const rightBbox = right.bbox_norm!;
			const rightWidth = rightBbox[2] - rightBbox[0];
			const rightHeight = rightBbox[3] - rightBbox[1];
			const xGap = Math.max(0, Math.max(leftBbox[0], rightBbox[0]) - Math.min(leftBbox[2], rightBbox[2]));
			const yGap = Math.max(0, Math.max(leftBbox[1], rightBbox[1]) - Math.min(leftBbox[3], rightBbox[3]));
			const xOverlap = axisOverlap(leftBbox[0], leftBbox[2], rightBbox[0], rightBbox[2]);
			const yOverlap = axisOverlap(leftBbox[1], leftBbox[3], rightBbox[1], rightBbox[3]);
			const horizontallyNear = xGap <= ADJACENCY_GAP
				&& yOverlap >= ADJACENCY_OVERLAP_RATIO * Math.min(leftHeight, rightHeight);
			const verticallyNear = yGap <= ADJACENCY_GAP
				&& xOverlap >= ADJACENCY_OVERLAP_RATIO * Math.min(leftWidth, rightWidth);
			if (horizontallyNear || verticallyNear) edges.push({ leftId: left.id, rightId: right.id });
		}
	}
	return edges;
}

function clusterVisuals(blocks: readonly MineruViewerBlock[]): MineruViewerBlock[][] {
	const byId = new Map(blocks.map((block) => [block.id, block]));
	const adjacency = new Map(blocks.map((block) => [block.id, new Set<string>()]));
	for (const edge of visualAdjacency(blocks)) {
		adjacency.get(edge.leftId)?.add(edge.rightId);
		adjacency.get(edge.rightId)?.add(edge.leftId);
	}
	const visited = new Set<string>();
	const components: MineruViewerBlock[][] = [];
	for (const block of [...blocks].sort((left, right) => left.page_order - right.page_order)) {
		if (visited.has(block.id)) continue;
		const pending = [block.id];
		visited.add(block.id);
		const component: MineruViewerBlock[] = [];
		while (pending.length) {
			const current = pending.pop()!;
			const currentBlock = byId.get(current);
			if (currentBlock) component.push(currentBlock);
			for (const neighbour of adjacency.get(current) || []) {
				if (visited.has(neighbour)) continue;
				visited.add(neighbour);
				pending.push(neighbour);
			}
		}
		components.push(component.sort((left, right) => left.page_order - right.page_order));
	}
	return components;
}

function enclosingParents(blocks: readonly MineruViewerBlock[]): Map<string, string> {
	const parents = new Map<string, string>();
	for (const child of blocks) {
		const childBbox = child.bbox_norm!;
		const childArea = bboxArea(childBbox);
		const candidates = blocks.flatMap((parent) => {
			if (parent.id === child.id) return [];
			const parentBbox = parent.bbox_norm!;
			const parentArea = bboxArea(parentBbox);
			if (parentArea < childArea * ENCLOSURE_AREA_RATIO) return [];
			const containment = intersectionArea(childBbox, parentBbox) / Math.max(1, childArea);
			return containment >= ENCLOSURE_THRESHOLD ? [{ parent, area: parentArea }] : [];
		}).sort((left, right) => left.area - right.area);
		if (candidates[0]) parents.set(child.id, candidates[0].parent.id);
	}
	return parents;
}

function rootParent(blockId: string, parents: ReadonlyMap<string, string>): string {
	const seen = new Set<string>();
	let current = blockId;
	while (parents.has(current) && !seen.has(current)) {
		seen.add(current);
		current = parents.get(current)!;
	}
	return current;
}

function markdownContext(
	blocks: readonly MineruViewerBlock[],
	markdownImages: readonly MineruMarkdownImage[],
): { ids: string[]; contiguous: boolean; coverage: number; maxGap: number | null } {
	const byId = new Map(markdownImages.map((image) => [image.id, image]));
	const referencedBlocks = blocks.filter((block) => (block.markdown_image_ids || []).some((id) => byId.has(id))).length;
	const ids = [...new Set(blocks.flatMap((block) => block.markdown_image_ids || []).filter((id) => byId.has(id)))]
		.sort((left, right) => byId.get(left)!.order - byId.get(right)!.order);
	const orders = ids.map((id) => byId.get(id)!.order);
	const gaps = ids.slice(1).flatMap((id, index) => {
		const left = byId.get(ids[index])!;
		const right = byId.get(id)!;
		return Number.isInteger(left.char_end) && Number.isInteger(right.char_start)
			? [Math.max(0, right.char_start! - left.char_end!)]
			: [];
	});
	const maxGap = ids.length >= 2 && gaps.length === ids.length - 1 ? Math.max(...gaps) : null;
	const coverage = blocks.length ? referencedBlocks / blocks.length : 0;
	return {
		ids,
		coverage,
		maxGap,
		contiguous: orders.length >= 2
			&& Math.max(...orders) - Math.min(...orders) + 1 === orders.length
			&& coverage >= 0.8
			&& maxGap !== null
			&& maxGap <= 160,
	};
}

function captionOwnedPageCandidate(
	index: MineruViewerIndex,
	pageBlocks: readonly MineruViewerBlock[],
): {
	members: MineruViewerBlock[];
	bbox: NormalizedBbox;
	figureKey: string;
	caption: MineruMarkdownFigureCaption;
} | null {
	if (!index.pdf_source?.packaged_path) return null;
	const ownership = logicalFigureOwnershipForPage(index, pageBlocks);
	if (!ownership || ownership.members.length < 2) return null;
	const { members: visuals, figureKey, caption } = ownership;
	const bbox = unionBbox(visuals);
	const area = bboxArea(bbox) / (COORDINATE_EXTENT ** 2);
	if (area < 0.05 || area > 0.9) return null;
	return { members: visuals, bbox, figureKey, caption };
}

function componentsShareExtendedBand(
	left: readonly MineruViewerBlock[],
	right: readonly MineruViewerBlock[],
): boolean {
	const leftBbox = unionBbox(left);
	const rightBbox = unionBbox(right);
	const xGap = Math.max(0, Math.max(leftBbox[0], rightBbox[0]) - Math.min(leftBbox[2], rightBbox[2]));
	const yGap = Math.max(0, Math.max(leftBbox[1], rightBbox[1]) - Math.min(leftBbox[3], rightBbox[3]));
	const xOverlap = axisOverlap(leftBbox[0], leftBbox[2], rightBbox[0], rightBbox[2]);
	const yOverlap = axisOverlap(leftBbox[1], leftBbox[3], rightBbox[1], rightBbox[3]);
	return (yGap <= 40 && xOverlap >= 0.65 * Math.max(leftBbox[2] - leftBbox[0], rightBbox[2] - rightBbox[0]))
		|| (xGap <= 40 && yOverlap >= 0.65 * Math.max(leftBbox[3] - leftBbox[1], rightBbox[3] - rightBbox[1]));
}

function mergeCaptionAnchoredComponents(
	components: readonly MineruViewerBlock[][],
	markdownImages: readonly MineruMarkdownImage[],
): MineruViewerBlock[][] {
	const working = components.map((component) => [...component].sort((left, right) => left.page_order - right.page_order));
	working.sort((left, right) => unionBbox(left)[1] - unionBbox(right)[1] || unionBbox(left)[0] - unionBbox(right)[0]);
	while (working.length > 1) {
		let merged = false;
		for (let index = 0; index < working.length - 1; index += 1) {
			const left = working[index];
			const right = working[index + 1];
			if (!componentsShareExtendedBand(left, right)) continue;
			const combined = [...left, ...right].sort((a, b) => a.page_order - b.page_order);
			if (combined.length < 3) continue;
			const figureAnchors = combined.reduce(
				(sum, block) => sum + Number(block.caption?.figure_anchor_count || 0),
				0,
			);
			const markdown = markdownContext(combined, markdownImages);
			const area = bboxArea(unionBbox(combined)) / (COORDINATE_EXTENT ** 2);
			if (figureAnchors !== 1 || !markdown.contiguous || markdown.coverage < 0.8 || area < 0.03 || area > 0.8) {
				continue;
			}
			working.splice(index, 2, combined);
			working.sort((a, b) => unionBbox(a)[1] - unionBbox(b)[1] || unionBbox(a)[0] - unionBbox(b)[0]);
			merged = true;
			break;
		}
		if (!merged) break;
	}
	return working;
}

function nearestFollowingFormalCaption(
	component: readonly MineruViewerBlock[],
	pageBlocks: readonly MineruViewerBlock[],
): MineruViewerBlock | null {
	if (!component.length) return null;
	const lastOrder = Math.max(...component.map((block) => block.page_order));
	return [...pageBlocks]
		.sort((left, right) => left.page_order - right.page_order)
		.find((block) => (
			block.page_order > lastOrder
			&& ["text", "title"].includes(block.role)
			&& Boolean(block.text?.leading_formal_figure_caption_key)
		)) || null;
}

function captionAdjacencyScore(captionBbox: NormalizedBbox, visualBbox: NormalizedBbox): number | null {
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

function componentsAreCoordinateNeighbours(
	left: readonly MineruViewerBlock[],
	right: readonly MineruViewerBlock[],
): boolean {
	const leftBbox = unionBbox(left);
	const rightBbox = unionBbox(right);
	const xGap = Math.max(0, Math.max(leftBbox[0], rightBbox[0]) - Math.min(leftBbox[2], rightBbox[2]));
	const yGap = Math.max(0, Math.max(leftBbox[1], rightBbox[1]) - Math.min(leftBbox[3], rightBbox[3]));
	const xOverlap = axisOverlap(leftBbox[0], leftBbox[2], rightBbox[0], rightBbox[2]);
	const yOverlap = axisOverlap(leftBbox[1], leftBbox[3], rightBbox[1], rightBbox[3]);
	return (xGap <= 65 && yOverlap >= 0.2 * Math.min(leftBbox[3] - leftBbox[1], rightBbox[3] - rightBbox[1]))
		|| (yGap <= 65 && xOverlap >= 0.2 * Math.min(leftBbox[2] - leftBbox[0], rightBbox[2] - rightBbox[0]));
}

function isExtendedVisualComponent(blocks: readonly MineruViewerBlock[]): boolean {
	if (!blocks.length) return false;
	const adjacency = new Map(blocks.map((block) => [block.id, new Set<string>()]));
	for (let leftIndex = 0; leftIndex < blocks.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < blocks.length; rightIndex += 1) {
			if (!componentsAreCoordinateNeighbours([blocks[leftIndex]], [blocks[rightIndex]])) continue;
			adjacency.get(blocks[leftIndex].id)?.add(blocks[rightIndex].id);
			adjacency.get(blocks[rightIndex].id)?.add(blocks[leftIndex].id);
		}
	}
	const visited = new Set<string>();
	const pending = [blocks[0].id];
	while (pending.length) {
		const current = pending.pop()!;
		if (visited.has(current)) continue;
		visited.add(current);
		pending.push(...[...(adjacency.get(current) || [])].filter((id) => !visited.has(id)));
	}
	return visited.size === blocks.length;
}

function mergeReadingOrderCaptionComponents(
	components: readonly MineruViewerBlock[][],
	pageBlocks: readonly MineruViewerBlock[],
): MineruViewerBlock[][] {
	if (components.length < 2) return components.map((component) => [...component]);
	const anchors = components.map((component) => nearestFollowingFormalCaption(component, pageBlocks));
	const adjacency = new Map(components.map((_component, index) => [index, new Set<number>()]));
	components.forEach((left, leftIndex) => {
		const leftAnchor = anchors[leftIndex];
		if (!leftAnchor) return;
		for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
			const rightAnchor = anchors[rightIndex];
			if (
				!rightAnchor
				|| rightAnchor.id !== leftAnchor.id
				|| !componentsAreCoordinateNeighbours(left, components[rightIndex])
			) continue;
			adjacency.get(leftIndex)?.add(rightIndex);
			adjacency.get(rightIndex)?.add(leftIndex);
		}
	});
	const merged: MineruViewerBlock[][] = [];
	const visited = new Set<number>();
	for (let start = 0; start < components.length; start += 1) {
		if (visited.has(start)) continue;
		const pending = [start];
		const indexes: number[] = [];
		while (pending.length) {
			const current = pending.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			indexes.push(current);
			pending.push(...[...(adjacency.get(current) || [])].filter((value) => !visited.has(value)));
		}
		const combined = indexes.flatMap((index) => components[index]).sort((a, b) => a.page_order - b.page_order);
		const anchor = anchors[indexes[0]];
		if (
			indexes.length > 1
			&& anchor?.bbox_norm
			&& captionAdjacencyScore(anchor.bbox_norm, unionBbox(combined)) !== null
		) {
			merged.push(combined);
		} else {
			indexes.sort((a, b) => a - b).forEach((index) => merged.push([...components[index]]));
		}
	}
	return merged.sort((left, right) => unionBbox(left)[1] - unionBbox(right)[1] || unionBbox(left)[0] - unionBbox(right)[0]);
}

function scoreGroup(
	members: readonly MineruViewerBlock[],
	representatives: readonly MineruViewerBlock[],
	edges: readonly AdjacencyEdge[],
	markdownImages: readonly MineruMarkdownImage[],
	replacementMode: "existing_asset" | "pdf_crop",
	standaloneCaptionAnchor = false,
): Pick<MineruVisualRepairGroup, "confidence" | "decision" | "signals" | "reason_codes" | "warning_codes" | "member_markdown_image_ids"> {
	const captionCharCount = members.reduce((sum, block) => sum + Number(block.caption?.char_count || 0), 0);
	const longCaptionCount = members.reduce((sum, block) => sum + Number(block.caption?.long_item_count || 0), 0);
	const figureAnchorCount = members.reduce((sum, block) => sum + Number(block.caption?.figure_anchor_count || 0), 0)
		+ Number(standaloneCaptionAnchor);
	const panelLabelCount = members.reduce((sum, block) => sum + Number(block.caption?.panel_label_count || 0), 0);
	const markdown = markdownContext(members, markdownImages);
	const unionAreaFraction = bboxArea(unionBbox(representatives)) / (COORDINATE_EXTENT ** 2);
	const uniqueAssetCount = new Set(members.map((block) => block.asset_path || "").filter(Boolean)).size;
	const exactMarkdownAliases = members.every((block) => (block.markdown_image_ids || []).length === 1)
		&& markdown.ids.length === members.length;
	const reasons: string[] = [];
	const warnings: string[] = [];
	let confidence: number;
	if (replacementMode === "existing_asset") {
		confidence = 0.78 + Math.min(0.12, Math.max(0, members.length - 1) * 0.03);
		reasons.push("enclosing_visual_asset");
		if (longCaptionCount) {
			confidence += 0.05;
			reasons.push("long_caption_attached");
		}
		if (markdown.contiguous) {
			confidence += 0.05;
			reasons.push("markdown_references_contiguous");
		}
		if (unionAreaFraction > 0.85 && members.length < 3) {
			confidence = Math.min(confidence, 0.79);
			warnings.push("near_full_page_enclosing_asset");
		}
	} else {
		confidence = 0.5 + (representatives.length >= 3 ? 0.15 : 0.08);
		if (edges.length >= Math.max(1, representatives.length - 1)) {
			confidence += 0.1;
			reasons.push("same_page_connected_visuals");
		}
		if (longCaptionCount) {
			confidence += 0.1;
			reasons.push("long_caption_attached");
		}
		if (panelLabelCount) {
			confidence += 0.05;
			reasons.push("panel_labels_detected");
		}
		if (standaloneCaptionAnchor) {
			confidence += 0.12;
			reasons.push("standalone_figure_caption_after_visuals");
		}
		if (markdown.contiguous) {
			confidence += 0.1;
			reasons.push("markdown_references_contiguous");
		}
		if (unionAreaFraction >= 0.03 && unionAreaFraction <= 0.8) {
			confidence += 0.05;
			reasons.push("plausible_union_area");
		}
		if (figureAnchorCount > 1) {
			confidence -= 0.25;
			warnings.push("multiple_figure_caption_anchors");
		} else if (longCaptionCount > 2 && figureAnchorCount === 0) {
			confidence -= 0.15;
			warnings.push("multiple_long_caption_anchors");
		}
		if (unionAreaFraction > 0.85) {
			confidence -= 0.2;
			warnings.push("near_full_page_union");
		}
	}
	const strongCaptionEvidence = (longCaptionCount > 0 || standaloneCaptionAnchor) && figureAnchorCount === 1;
	const strongPanelGridEvidence = replacementMode === "pdf_crop"
		&& representatives.length >= 4
		&& edges.length >= representatives.length - 1
		&& panelLabelCount >= 2
		&& markdown.contiguous
		&& markdown.coverage >= 0.8;
	const strongEnclosingAliasEvidence = replacementMode === "existing_asset"
		&& representatives.length === 1
		&& members.length >= 3
		&& uniqueAssetCount === members.length
		&& exactMarkdownAliases
		&& markdown.contiguous
		&& markdown.coverage === 1
		&& unionAreaFraction >= 0.03
		&& unionAreaFraction <= 0.85;
	if (strongEnclosingAliasEvidence) reasons.push("complete_enclosing_asset_exact_aliases");
	if (!strongCaptionEvidence && !strongPanelGridEvidence && !strongEnclosingAliasEvidence) {
		confidence = Math.min(confidence, 0.79);
		warnings.push("insufficient_figure_anchor_evidence");
	}
	if (figureAnchorCount > 1 || (longCaptionCount > 2 && figureAnchorCount === 0)) confidence = Math.min(confidence, 0.79);
	confidence = Math.max(0, Math.min(0.99, Number(confidence.toFixed(3))));
	return {
		confidence,
		decision: confidence >= 0.85 ? "auto" : confidence >= 0.65 ? "review" : "skip",
		member_markdown_image_ids: markdown.ids,
		signals: {
			member_count: members.length,
			representative_count: representatives.length,
			adjacent_pair_count: edges.length,
			caption_char_count: captionCharCount,
			long_caption_anchor_count: longCaptionCount,
			figure_caption_anchor_count: figureAnchorCount,
			panel_label_count: panelLabelCount,
			markdown_references_contiguous: markdown.contiguous,
			markdown_reference_coverage: Number(markdown.coverage.toFixed(4)),
			max_markdown_gap_chars: markdown.maxGap,
			union_area_fraction: Number(unionAreaFraction.toFixed(4)),
		},
		reason_codes: reasons,
		warning_codes: [...new Set(warnings)],
	};
}

function hasExactVisualOnlyPageEvidence(
	index: MineruViewerIndex,
	pageBlocks: readonly MineruViewerBlock[],
	candidateCount: number,
	members: readonly MineruViewerBlock[],
	representatives: readonly MineruViewerBlock[],
	edges: readonly AdjacencyEdge[],
	markdownImages: readonly MineruMarkdownImage[],
): boolean {
	if (!index.pdf_source?.packaged_path || candidateCount !== 1 || representatives.length < 4) return false;
	if (members.length !== representatives.length || edges.length < representatives.length - 1) return false;
	const meaningfulBlocks = pageBlocks.filter((block) => block.role !== "discarded");
	const memberIds = new Set(members.map((block) => block.id));
	if (
		meaningfulBlocks.length !== members.length
		|| meaningfulBlocks.some((block) => block.role !== "visual" || !memberIds.has(block.id))
	) return false;
	const assetPaths = members.map((block) => block.asset_path || "").filter(Boolean);
	if (assetPaths.length !== members.length || new Set(assetPaths).size !== members.length) return false;
	if (members.some((block) => Boolean(block.caption?.next_page_marker))) return false;
	const figureAnchorCount = members.reduce(
		(sum, block) => sum + Number(block.caption?.figure_anchor_count || 0),
		0,
	);
	const longCaptionCount = members.reduce((sum, block) => sum + Number(block.caption?.long_item_count || 0), 0);
	if (figureAnchorCount > 1 || longCaptionCount > 1) return false;
	const markdown = markdownContext(members, markdownImages);
	if (
		!markdown.contiguous
		|| markdown.coverage !== 1
		|| markdown.ids.length !== members.length
		|| markdown.maxGap === null
		|| markdown.maxGap > 16
	) return false;
	const unionAreaFraction = bboxArea(unionBbox(representatives)) / (COORDINATE_EXTENT ** 2);
	return unionAreaFraction >= 0.3 && unionAreaFraction <= 0.85;
}

/**
 * MinerU may emit a full-page A–Q composite figure as many disconnected image
 * fragments. Treat it as one crop only when every meaningful page block is a
 * uniquely mapped visual, the Markdown image occurrences form one exact run,
 * and a wider coordinate graph connects every fragment. This page-level proof
 * runs before component scoring so no overlapping partial crop can win first.
 */
function fullPageCompositeCandidate(
	index: MineruViewerIndex,
	pageBlocks: readonly MineruViewerBlock[],
	visuals: readonly MineruViewerBlock[],
): { members: MineruViewerBlock[]; bbox: NormalizedBbox; edges: AdjacencyEdge[]; enclosingAliasCount: number } | null {
	if (!index.pdf_source?.packaged_path || visuals.length < 8) return null;
	const meaningfulBlocks = pageBlocks.filter((block) => block.role !== "discarded");
	if (
		meaningfulBlocks.length !== visuals.length
		|| meaningfulBlocks.some((block) => block.role !== "visual" || !block.asset_path || !block.bbox_norm)
	) return null;
	const enclosingAliasCount = enclosingParents(visuals).size;
	const assetPaths = visuals.map((block) => block.asset_path!);
	if (new Set(assetPaths).size !== visuals.length) return null;
	if (visuals.some((block) => block.markdown_image_ids?.length !== 1 || block.caption?.next_page_marker)) return null;
	const markdown = markdownContext(visuals, index.markdown_images);
	const markdownOrders = markdown.ids
		.map((id) => /^md-img-(\d+)$/.exec(id))
		.filter((match): match is RegExpExecArray => Boolean(match))
		.map((match) => Number(match[1]));
	if (
		markdown.coverage !== 1
		|| markdown.ids.length !== visuals.length
		|| markdownOrders.length !== visuals.length
		|| Math.max(...markdownOrders) - Math.min(...markdownOrders) + 1 !== markdownOrders.length
	) return null;
	const figureAnchorCount = visuals.reduce(
		(sum, block) => sum + Number(block.caption?.figure_anchor_count || 0),
		0,
	);
	const longCaptionCount = visuals.reduce(
		(sum, block) => sum + Number(block.caption?.long_item_count || 0),
		0,
	);
	const panelLabelCount = visuals.reduce(
		(sum, block) => sum + Number(block.caption?.panel_label_count || 0),
		0,
	);
	if (figureAnchorCount > 1 || longCaptionCount > 1 || panelLabelCount < 4) return null;
	if (!isExtendedVisualComponent(visuals)) return null;
	const bbox = unionBbox(visuals);
	const area = bboxArea(bbox) / (COORDINATE_EXTENT ** 2);
	if (area < 0.3 || area > 0.85) return null;
	return {
		members: [...visuals].sort((left, right) => left.page_order - right.page_order),
		bbox,
		edges: visualAdjacency(visuals),
		enclosingAliasCount,
	};
}

export function downgradeOverlappingAutoCropGroups(
	groups: readonly MineruVisualRepairGroup[],
): MineruVisualRepairGroup[] {
	const unsafeIds = new Set<string>();
	for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
		const left = groups[leftIndex];
		if (left.decision !== "auto" || left.replacement.mode !== "pdf_crop" || !left.replacement.bbox_norm) continue;
		for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
			const right = groups[rightIndex];
			if (
				right.page_idx !== left.page_idx
				|| right.decision !== "auto"
				|| right.replacement.mode !== "pdf_crop"
				|| !right.replacement.bbox_norm
			) continue;
			const overlap = intersectionArea(left.replacement.bbox_norm, right.replacement.bbox_norm);
			const smallerArea = Math.min(
				bboxArea(left.replacement.bbox_norm),
				bboxArea(right.replacement.bbox_norm),
			);
			if (smallerArea > 0 && overlap / smallerArea >= 0.05) {
				unsafeIds.add(left.id);
				unsafeIds.add(right.id);
			}
		}
	}
	return groups.map((group) => unsafeIds.has(group.id)
		? {
			...group,
			decision: "review",
			confidence: Math.min(group.confidence, 0.79),
			warning_codes: [...new Set([...(group.warning_codes || []), "overlapping_auto_crop_groups"])],
		}
		: group);
}

/**
 * Rebuild the conservative visual repair plan in memory when a valid MinerU
 * package predates the optional derived contracts. The original Markdown,
 * JSON and extracted assets remain untouched; only auto-scored groups affect
 * the reader's derived visual view.
 */
export function buildRuntimeVisualRepair(index: MineruViewerIndex): MineruVisualRepair {
	const groups: MineruVisualRepairGroup[] = [];
	let eligibleCount = 0;
	for (const page of index.pages) {
		const visuals = eligibleVisuals(page.blocks);
		eligibleCount += visuals.length;
		if (!visuals.length) continue;
		const captionOwned = captionOwnedPageCandidate(index, page.blocks);
		if (captionOwned) {
			groups.push({
				id: `runtime-vr-p${String(page.page_idx).padStart(4, "0")}-g0000`,
				page_idx: page.page_idx,
				figure_key: captionOwned.figureKey,
				member_block_ids: captionOwned.members.map((block) => block.id),
				member_asset_paths: captionOwned.members.map((block) => block.asset_path!).sort(),
				member_markdown_image_ids: captionOwned.members
					.map((block) => block.markdown_image_ids![0]),
				caption_anchor_block_ids: page.blocks.filter((block) => (
					block.caption?.formal_figure_caption_keys?.includes(captionOwned.figureKey)
					|| block.text?.formal_figure_caption_keys?.includes(captionOwned.figureKey)
				)).map((block) => block.id),
				decision: "auto",
				confidence: 0.98,
				replacement: { mode: "pdf_crop", bbox_norm: captionOwned.bbox, padding_norm: 6 },
				signals: {
					member_count: captionOwned.members.length,
					markdown_reference_coverage: 1,
					markdown_image_order_contiguous: true,
					formal_caption_page_ownership: true,
					figure_key: captionOwned.figureKey,
					caption_markdown_id: captionOwned.caption.id,
					union_area_fraction: Number((bboxArea(captionOwned.bbox) / (COORDINATE_EXTENT ** 2)).toFixed(4)),
				},
				reason_codes: [
					"formal_caption_page_ownership",
					"markdown_image_order_contiguous",
				],
				warning_codes: [],
				fallback: "original_assets",
			});
			continue;
		}
		const fullPageComposite = fullPageCompositeCandidate(index, page.blocks, visuals);
		if (fullPageComposite) {
			const markdown = markdownContext(fullPageComposite.members, index.markdown_images);
			groups.push({
				id: `runtime-vr-p${String(page.page_idx).padStart(4, "0")}-g0000`,
				page_idx: page.page_idx,
				member_block_ids: fullPageComposite.members.map((block) => block.id),
				member_asset_paths: fullPageComposite.members.map((block) => block.asset_path!).sort(),
				member_markdown_image_ids: markdown.ids,
				caption_anchor_block_ids: [],
				decision: "auto",
				confidence: 0.93,
				replacement: { mode: "pdf_crop", bbox_norm: fullPageComposite.bbox, padding_norm: 6 },
				signals: {
					member_count: fullPageComposite.members.length,
					representative_count: fullPageComposite.members.length,
					adjacent_pair_count: fullPageComposite.edges.length,
					panel_label_count: fullPageComposite.members.reduce(
						(sum, block) => sum + Number(block.caption?.panel_label_count || 0),
						0,
					),
					markdown_reference_coverage: 1,
					markdown_image_order_contiguous: true,
					visual_only_page_full_coverage: true,
					enclosing_alias_count: fullPageComposite.enclosingAliasCount,
					union_area_fraction: Number((bboxArea(fullPageComposite.bbox) / (COORDINATE_EXTENT ** 2)).toFixed(4)),
				},
				reason_codes: [
					"visual_only_page_full_coverage",
					"markdown_image_order_contiguous",
					"extended_coordinate_component",
				],
				warning_codes: [],
				fallback: "original_assets",
			});
			continue;
		}
		const byId = new Map(visuals.map((block) => [block.id, block]));
		const parents = enclosingParents(visuals);
		const aliasesByRoot = new Map<string, MineruViewerBlock[]>();
		for (const childId of parents.keys()) {
			const rootId = rootParent(childId, parents);
			const child = byId.get(childId);
			if (!byId.has(rootId) || !child) continue;
			const aliases = aliasesByRoot.get(rootId) || [];
			aliases.push(child);
			aliasesByRoot.set(rootId, aliases);
		}
		const representatives = visuals.filter((block) => !parents.has(block.id));
		const strictComponents = clusterVisuals(representatives);
		const components = mergeReadingOrderCaptionComponents(
			mergeCaptionAnchoredComponents(strictComponents, index.markdown_images),
			page.blocks,
		);
		const candidates = components.flatMap((component) => {
			const members = [...component, ...component.flatMap((block) => aliasesByRoot.get(block.id) || [])]
				.filter((block, position, all) => all.findIndex((candidate) => candidate.id === block.id) === position)
				.sort((left, right) => left.page_order - right.page_order);
			return component.length > 1 || members.length > component.length
				? [{ component, members, bbox: unionBbox(component) }]
				: [];
		}).sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
		candidates.forEach((candidate, groupOrder) => {
			const replacementMode = candidate.component.length === 1 && candidate.members.length > 1
				? "existing_asset" as const
				: "pdf_crop" as const;
			const followingCaption = nearestFollowingFormalCaption(candidate.component, page.blocks);
			const attachedCaptionCount = candidate.members.reduce(
				(sum, block) => sum + Number(block.caption?.figure_anchor_count || 0),
				0,
			);
			const hasStandaloneCaptionAnchor = attachedCaptionCount === 0
				&& Boolean(followingCaption?.bbox_norm)
				&& captionAdjacencyScore(followingCaption!.bbox_norm!, candidate.bbox) !== null;
			const edges = visualAdjacency(candidate.component);
			const score = scoreGroup(
				candidate.members,
				candidate.component,
				edges,
				index.markdown_images,
				replacementMode,
				hasStandaloneCaptionAnchor,
			);
			if (
				replacementMode === "pdf_crop"
				&& hasExactVisualOnlyPageEvidence(
					index,
					page.blocks,
					candidates.length,
					candidate.members,
					candidate.component,
					edges,
					index.markdown_images,
				)
			) {
				score.confidence = Math.max(score.confidence, 0.9);
				score.decision = "auto";
				score.signals = { ...(score.signals || {}), visual_only_page_exact_coverage: true };
				score.reason_codes = [...(score.reason_codes || []), "visual_only_page_exact_coverage"];
				score.warning_codes = (score.warning_codes || [])
					.filter((code) => code !== "insufficient_figure_anchor_evidence");
			}
			if (replacementMode === "pdf_crop" && !index.pdf_source?.packaged_path) {
				if (score.decision === "auto") {
					score.confidence = Math.min(score.confidence, 0.79);
					score.decision = "review";
				}
				score.warning_codes = [...new Set([...(score.warning_codes || []), "source_pdf_unavailable"])];
			}
			const strictComponentCount = clusterVisuals(candidate.component).length;
			if (strictComponentCount > 1) {
				score.signals = {
					...(score.signals || {}),
					caption_anchored_component_count: strictComponentCount,
				};
				score.reason_codes = [...(score.reason_codes || []), "caption_anchored_spatial_bridge"];
			}
			groups.push({
				id: `runtime-vr-p${String(page.page_idx).padStart(4, "0")}-g${String(groupOrder).padStart(4, "0")}`,
				page_idx: page.page_idx,
				member_block_ids: candidate.members.map((block) => block.id),
				member_asset_paths: [...new Set(candidate.members.map((block) => block.asset_path || "").filter(Boolean))].sort(),
				member_markdown_image_ids: score.member_markdown_image_ids,
				caption_anchor_block_ids: [
					...candidate.members
					.filter((block) => Number(block.caption?.long_item_count || 0) > 0)
					.map((block) => block.id),
					...(hasStandaloneCaptionAnchor && followingCaption ? [followingCaption.id] : []),
				],
				decision: score.decision,
				confidence: score.confidence,
				replacement: replacementMode === "existing_asset"
					? {
						mode: "existing_asset",
						block_id: candidate.component[0].id,
						asset_path: candidate.component[0].asset_path,
					}
					: { mode: "pdf_crop", bbox_norm: candidate.bbox, padding_norm: 6 },
				signals: score.signals,
				reason_codes: score.reason_codes,
				warning_codes: score.warning_codes,
				fallback: "original_assets",
			});
		});
	}
	const allBlocks = index.pages.flatMap((page) => page.blocks);
	const mergedGroups = downgradeOverlappingAutoCropGroups(
		mergeNestedVisualRepairGroups(groups, allBlocks),
	);
	return {
		schema_version: 1,
		algorithm_version: CURRENT_VISUAL_REPAIR_ALGORITHM,
		viewer_index: "runtime",
		status: eligibleCount === 0 ? "unavailable" : index.status,
		inputs: index.inputs,
		groups: mergedGroups,
		caption_links: [],
		issues: eligibleCount === 0 ? ["没有可定位的视觉块"] : [],
	};
}

function hashesMatch(
	inputs: MineruViewerIndex["inputs"],
	articleHash: string,
	mineruHash: string,
): boolean {
	return String(inputs?.article?.sha256 || "").toLowerCase() === articleHash.toLowerCase()
		&& String(inputs?.mineru_result?.sha256 || "").toLowerCase() === mineruHash.toLowerCase()
		&& /^[a-f0-9]{64}$/i.test(articleHash)
		&& /^[a-f0-9]{64}$/i.test(mineruHash);
}

function sameBbox(left: NormalizedBbox | null, right: NormalizedBbox | null): boolean {
	if (!left || !right) return left === right;
	return left.every((coordinate, index) => Math.abs(coordinate - right[index]) <= 0.01);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function bboxContains(container: NormalizedBbox, child: NormalizedBbox): boolean {
	return container[0] <= child[0] + 0.01
		&& container[1] <= child[1] + 0.01
		&& container[2] + 0.01 >= child[2]
		&& container[3] + 0.01 >= child[3];
}

export interface VisualContractValidationInput {
	viewerIndex: MineruViewerIndex;
	visualRepair: MineruVisualRepair;
	sourceIndex: MineruViewerIndex;
	articleHash: string;
	mineruHash: string;
}

/**
 * Bind a derived Viewer Index and visual repair plan back to the index rebuilt
 * from the verified source Markdown/JSON. Consumers must apply no group when
 * this returns any error.
 */
export function validateVisualContracts(input: VisualContractValidationInput): string[] {
	const errors: string[] = [];
	const { viewerIndex, visualRepair, sourceIndex, articleHash, mineruHash } = input;
	if (!hashesMatch(viewerIndex.inputs, articleHash, mineruHash)) errors.push("Viewer Index 输入哈希不匹配");
	if (!hashesMatch(visualRepair.inputs, articleHash, mineruHash)) errors.push("视觉修复输入哈希不匹配");
	if (viewerIndex.schema_version !== 1 || visualRepair.schema_version !== 1) errors.push("视觉契约 schema 不受支持");
	if (!isSupportedVisualRepairAlgorithm(visualRepair.algorithm_version)) {
		errors.push("视觉修复算法版本不受支持");
	}
	if (viewerIndex.pages.length > 2048 || viewerIndex.markdown_images.length > 4096) errors.push("Viewer Index 超过结构资源上限");
	if ((viewerIndex.markdown_captions || []).length > 4096) errors.push("Viewer Index 正式图注超过结构资源上限");
	if (stableJson(viewerIndex.coordinate_system) !== stableJson(sourceIndex.coordinate_system)) {
		errors.push("Viewer Index 坐标系统与原始索引不一致");
	}
	if (stableJson(viewerIndex.pdf_source) !== stableJson(sourceIndex.pdf_source)) {
		errors.push("Viewer Index PDF 来源声明与原始索引不一致");
	}

	const sourceByIndex = new Map<number, { block: MineruViewerBlock; pageIdx: number }>();
	const sourceImageById = new Map(sourceIndex.markdown_images.map((image) => [image.id, image]));
	for (const page of sourceIndex.pages) {
		for (const block of page.blocks) {
			if (sourceByIndex.has(block.source_index)) errors.push("原始索引 source_index 不唯一");
			sourceByIndex.set(block.source_index, { block, pageIdx: page.page_idx });
		}
	}
	const blockById = new Map<string, { block: MineruViewerBlock; pageIdx: number }>();
	const seenSourceIndexes = new Set<number>();
	const seenPageIndexes = new Set<number>();
	for (const page of viewerIndex.pages) {
		if (seenPageIndexes.has(page.page_idx)) errors.push(`Viewer Index 页码重复：${page.page_idx}`);
		seenPageIndexes.add(page.page_idx);
		if (page.blocks.length > 512) errors.push(`Viewer Index 第 ${page.page_idx + 1} 页超过块数上限`);
		for (const block of page.blocks) {
			if (blockById.has(block.id)) errors.push(`Viewer Index block id 重复：${block.id}`);
			if (seenSourceIndexes.has(block.source_index)) errors.push(`Viewer Index source_index 重复：${block.source_index}`);
			blockById.set(block.id, { block, pageIdx: page.page_idx });
			seenSourceIndexes.add(block.source_index);
			const source = sourceByIndex.get(block.source_index);
			if (!source) {
				errors.push(`Viewer Index 块无法反向绑定原始 JSON：${block.id}`);
				continue;
			}
			if (
				source.pageIdx !== page.page_idx
				|| source.block.id !== block.id
				|| source.block.page_order !== block.page_order
				|| source.block.source_type !== block.source_type
				|| source.block.role !== block.role
				|| source.block.asset_path !== block.asset_path
				|| !sameBbox(source.block.bbox_norm, block.bbox_norm)
				|| JSON.stringify(source.block.markdown_image_ids || []) !== JSON.stringify(block.markdown_image_ids || [])
				|| stableJson(source.block.caption) !== stableJson(block.caption)
				|| stableJson(source.block.text) !== stableJson(block.text)
				|| stableJson(source.block.markdown_text_range) !== stableJson(block.markdown_text_range)
				|| stableJson(source.block.markdown_table_range) !== stableJson(block.markdown_table_range)
			) errors.push(`Viewer Index 块来源绑定不一致：${block.id}`);
		}
	}
	if (blockById.size !== sourceByIndex.size) errors.push("Viewer Index 未完整覆盖原始 JSON 块");
	if (viewerIndex.markdown_images.length !== sourceIndex.markdown_images.length) {
		errors.push("Viewer Index Markdown 图片清单长度不一致");
	}
	const seenMarkdownImageIds = new Set<string>();
	const seenMarkdownOrders = new Set<number>();
	for (const image of viewerIndex.markdown_images) {
		if (seenMarkdownImageIds.has(image.id) || seenMarkdownOrders.has(image.order)) {
			errors.push(`Viewer Index Markdown 图片 ID 或顺序重复：${image.id}`);
		}
		seenMarkdownImageIds.add(image.id);
		seenMarkdownOrders.add(image.order);
		const source = sourceImageById.get(image.id);
		if (
			!source
			|| source.order !== image.order
			|| source.asset_path !== image.asset_path
			|| source.occurrence !== image.occurrence
			|| source.char_start !== image.char_start
			|| source.char_end !== image.char_end
		) errors.push(`Viewer Index Markdown 图片绑定不一致：${image.id}`);
	}
	if (stableJson(viewerIndex.markdown_captions || []) !== stableJson(sourceIndex.markdown_captions || [])) {
		errors.push("Viewer Index Markdown 正式图注绑定不一致");
	}

	if (visualRepair.groups.length > 4096) errors.push("视觉修复组数超过安全上限");
	const groupIds = new Set<string>();
	const consumedMembers = new Set<string>();
	for (const group of visualRepair.groups) {
		if (!group.id || groupIds.has(group.id)) errors.push(`视觉修复 group id 缺失或重复：${group.id}`);
		groupIds.add(group.id);
		const memberIds = group.member_block_ids;
		if (memberIds.length < 2 || memberIds.length > 512 || new Set(memberIds).size !== memberIds.length) {
			errors.push(`视觉修复成员数量或唯一性非法：${group.id}`);
			continue;
		}
		const members = memberIds.map((id) => blockById.get(id));
		if (members.some((member) => !member || member.pageIdx !== group.page_idx)) {
			errors.push(`视觉修复成员页绑定非法：${group.id}`);
			continue;
		}
		if (memberIds.some((id) => consumedMembers.has(id))) errors.push(`视觉修复成员跨组重复：${group.id}`);
		memberIds.forEach((id) => consumedMembers.add(id));
		const memberAssets = [...new Set(members.map((member) => member?.block.asset_path || "").filter(Boolean))].sort();
		if (
			group.member_asset_paths
			&& JSON.stringify([...group.member_asset_paths].sort()) !== JSON.stringify(memberAssets)
		) errors.push(`视觉修复资产清单不一致：${group.id}`);
		const expectedMarkdownIds = new Set(members.flatMap((member) => member?.block.markdown_image_ids || []));
		const actualMarkdownIds = new Set(group.member_markdown_image_ids || []);
		if (
			actualMarkdownIds.size !== (group.member_markdown_image_ids || []).length
			|| actualMarkdownIds.size !== expectedMarkdownIds.size
			|| [...actualMarkdownIds].some((id) => !expectedMarkdownIds.has(id))
			) {
			errors.push(`视觉修复 Markdown 图片引用未精确绑定成员：${group.id}`);
		}
		if (group.figure_key) {
			const page = viewerIndex.pages.find((candidate) => candidate.page_idx === group.page_idx);
			const expected = page
				? captionOwnedPageCandidate(viewerIndex, page.blocks)
				: null;
			const expectedIds = new Set(expected?.members.map((block) => block.id) || []);
			if (
				!expected
				|| expected.figureKey !== group.figure_key
				|| expectedIds.size !== memberIds.length
				|| memberIds.some((id) => !expectedIds.has(id))
			) errors.push(`视觉修复 Figure 所有权绑定非法：${group.id}`);
		}
		if (new Set(group.caption_anchor_block_ids || []).size !== (group.caption_anchor_block_ids || []).length) {
			errors.push(`视觉修复图注锚点重复：${group.id}`);
		}
		for (const anchorId of group.caption_anchor_block_ids || []) {
			const anchor = blockById.get(anchorId);
			if (!anchor || anchor.pageIdx !== group.page_idx || !["visual", "text", "title"].includes(anchor.block.role)) {
				errors.push(`视觉修复图注锚点非法：${group.id}`);
			}
		}
		if (!Number.isFinite(group.confidence) || group.confidence < 0 || group.confidence > 1) {
			errors.push(`视觉修复置信度非法：${group.id}`);
		}
		if (group.decision === "auto" && group.confidence < 0.85) errors.push(`自动视觉修复置信度不足：${group.id}`);
		if (group.decision === "review" && (group.confidence < 0.65 || group.confidence >= 0.85)) {
			errors.push(`复核视觉修复置信度不在 0.65–0.849：${group.id}`);
		}
		if (group.decision === "skip" && group.confidence >= 0.65) errors.push(`跳过视觉修复置信度过高：${group.id}`);
		if (group.replacement.mode === "existing_asset") {
			const replacementMember = group.replacement.block_id
				? blockById.get(group.replacement.block_id)?.block
				: undefined;
			if (
				!group.replacement.block_id
				|| !memberIds.includes(group.replacement.block_id)
				|| !group.replacement.asset_path
				|| !memberAssets.includes(group.replacement.asset_path)
				|| replacementMember?.asset_path !== group.replacement.asset_path
			) errors.push(`existing_asset 替换未绑定成员：${group.id}`);
		} else if (group.replacement.mode === "pdf_crop") {
			const crop = group.replacement.bbox_norm;
			if (
				!crop
				|| members.some((member) => member?.block.bbox_norm && !bboxContains(crop, member.block.bbox_norm))
				|| Number(group.replacement.padding_norm || 0) < 0
				|| Number(group.replacement.padding_norm || 0) > 40
			) errors.push(`pdf_crop 几何范围非法：${group.id}`);
			if (group.decision === "auto" && !viewerIndex.pdf_source?.packaged_path) {
				errors.push(`缺少 source.pdf 时不得自动执行 pdf_crop：${group.id}`);
			}
		} else {
			errors.push(`视觉修复 replacement mode 非法：${group.id}`);
		}
	}
	const autoCropGroups = visualRepair.groups.filter((group) => (
		group.decision === "auto"
		&& group.replacement.mode === "pdf_crop"
		&& Boolean(group.replacement.bbox_norm)
	));
	for (let leftIndex = 0; leftIndex < autoCropGroups.length; leftIndex += 1) {
		const left = autoCropGroups[leftIndex];
		for (const right of autoCropGroups.slice(leftIndex + 1)) {
			if (right.page_idx !== left.page_idx) continue;
			const overlap = intersectionArea(left.replacement.bbox_norm!, right.replacement.bbox_norm!);
			const smallerArea = Math.min(
				bboxArea(left.replacement.bbox_norm!),
				bboxArea(right.replacement.bbox_norm!),
			);
			if (smallerArea > 0 && overlap / smallerArea >= 0.05) {
				errors.push(`同页自动 pdf_crop 几何重叠：${left.id} / ${right.id}`);
			}
		}
	}
	const linkedVisuals = new Set<string>();
	const linkedCaptionBlocks = new Set<string>();
	for (const link of visualRepair.caption_links || []) {
		if (linkedVisuals.has(link.visual_block_id)) errors.push(`跨页图注视觉块重复：${link.visual_block_id}`);
		linkedVisuals.add(link.visual_block_id);
		const visual = blockById.get(link.visual_block_id);
		const captionIds = link.caption_block_ids;
		const captions = captionIds.map((id) => blockById.get(id));
		if (
			!visual
			|| visual.pageIdx !== link.source_page_idx
			|| visual.block.role !== "visual"
			|| link.target_page_idx !== link.source_page_idx + 1
			|| !captionIds.length
			|| new Set(captionIds).size !== captionIds.length
			|| captions.some((entry) => (
				!entry
				|| entry.pageIdx !== link.target_page_idx
				|| !["text", "title"].includes(entry.block.role)
				|| !String(entry.block.text?.text || "").trim()
			))
			|| captionIds.some((id) => consumedMembers.has(id) || linkedCaptionBlocks.has(id))
			|| !captionLinkMatchesBlocks(
				link,
				visual.block,
				viewerIndex.pages.find((page) => page.page_idx === link.target_page_idx)?.blocks || [],
			)
		) errors.push(`跨页图注来源绑定非法：${link.visual_block_id}`);
		captionIds.forEach((id) => linkedCaptionBlocks.add(id));
	}
	return [...new Set(errors)];
}
