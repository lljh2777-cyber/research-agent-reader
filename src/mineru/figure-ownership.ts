import type {
	MineruMarkdownFigureCaption,
	MineruViewerBlock,
	MineruViewerIndex,
} from "./types";

function eligibleVisuals(blocks: readonly MineruViewerBlock[]): MineruViewerBlock[] {
	return blocks
		.filter((block) => block.role === "visual" && Boolean(block.asset_path) && Boolean(block.bbox_norm))
		.sort((left, right) => left.page_order - right.page_order || left.source_index - right.source_index);
}

export function formalFigureKeysForPage(blocks: readonly MineruViewerBlock[]): string[] {
	return [...new Set(blocks.flatMap((block) => [
		...(block.caption?.formal_figure_caption_keys || []),
		...(block.text?.formal_figure_caption_keys || []),
		block.caption?.leading_formal_figure_caption_key || "",
		block.text?.leading_formal_figure_caption_key || "",
	].map((key) => String(key || "").trim().toLowerCase()).filter(Boolean)))];
}

export function visualAnchoredFigureKeys(index: MineruViewerIndex): Set<string> {
	return new Set(index.pages.flatMap((page) => (
		eligibleVisuals(page.blocks).length ? formalFigureKeysForPage(page.blocks) : []
	)));
}

function captionBoundaryOwnsImageRun(
	caption: MineruMarkdownFigureCaption,
	firstMarkdownImageId: string,
	lastMarkdownImageId: string,
): boolean {
	return caption.after_markdown_image_id === firstMarkdownImageId
		|| caption.before_markdown_image_id === lastMarkdownImageId;
}

/**
 * Resolve one logical Figure for a page from formal figure identity and exact
 * article.md image order. Geometry is intentionally absent: callers may use
 * it to crop an already-owned Figure, but it must not decide ownership.
 */
export function logicalFigureOwnershipForPage(
	index: MineruViewerIndex,
	pageBlocks: readonly MineruViewerBlock[],
): {
	members: MineruViewerBlock[];
	figureKey: string;
	caption: MineruMarkdownFigureCaption;
} | null {
	const visuals = eligibleVisuals(pageBlocks);
	if (!visuals.length || visuals.some((block) => block.markdown_image_ids?.length !== 1)) return null;
	const imageById = new Map(index.markdown_images.map((image) => [image.id, image]));
	const orderedImageIds = visuals.map((block) => block.markdown_image_ids![0])
		.sort((left, right) => (imageById.get(left)?.order ?? Number.MAX_SAFE_INTEGER)
			- (imageById.get(right)?.order ?? Number.MAX_SAFE_INTEGER));
	if (
		new Set(orderedImageIds).size !== visuals.length
		|| orderedImageIds.some((id) => !imageById.has(id))
	) return null;
	const imageOrders = orderedImageIds.map((id) => imageById.get(id)!.order);
	if (Math.max(...imageOrders) - Math.min(...imageOrders) + 1 !== imageOrders.length) return null;

	const samePageKeys = formalFigureKeysForPage(pageBlocks);
	if (samePageKeys.length > 1) return null;
	let figureKey = samePageKeys[0] || "";
	let captionCandidates = (index.markdown_captions || []).filter((caption) => caption.figure_key === figureKey);
	if (!figureKey) {
		const anchoredKeys = visualAnchoredFigureKeys(index);
		captionCandidates = (index.markdown_captions || []).filter((caption) => (
			!anchoredKeys.has(caption.figure_key)
			&& captionBoundaryOwnsImageRun(
				caption,
				orderedImageIds[0],
				orderedImageIds[orderedImageIds.length - 1],
			)
		));
		const boundaryKeys = [...new Set(captionCandidates.map((caption) => caption.figure_key))];
		if (boundaryKeys.length !== 1) return null;
		figureKey = boundaryKeys[0];
		captionCandidates = captionCandidates.filter((caption) => caption.figure_key === figureKey);
	}
	if (captionCandidates.length !== 1) return null;
	const caption = captionCandidates[0];
	if (
		!samePageKeys.length
		&& !captionBoundaryOwnsImageRun(
			caption,
			orderedImageIds[0],
			orderedImageIds[orderedImageIds.length - 1],
		)
	) return null;
	return { members: visuals, figureKey, caption };
}
