export interface MineruReaderViewportBlock {
	pageNumber: number;
	top: number;
	bottom: number;
}

/** Choose one monotonic DOM boundary for a source page. */
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

/** Attribute the first visible Markdown line to its owning source page. */
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

export type ReaderMarkdownRestoreTarget =
	| { kind: "top" }
	| { kind: "page"; pageNumber: number }
	| { kind: "visual"; visualId: string }
	| { kind: "none" };

/** Reference-rail selection is not a persisted Markdown reading position. */
export function readerMarkdownRestoreTarget(
	mode: "pdf" | "visuals",
	markdownAnchor: string,
	markdownPage: number,
): ReaderMarkdownRestoreTarget {
	const visualId = String(markdownAnchor || "").trim();
	const pageNumber = Math.max(1, Math.floor(Number(markdownPage) || 1));
	if (!visualId && pageNumber === 1) return { kind: "top" };
	if (mode === "pdf") return { kind: "page", pageNumber };
	if (visualId) return { kind: "visual", visualId };
	return { kind: "none" };
}
