/** Geometry for a continuous PDF scroller with a viewport-sized window of page canvases. */
export class PdfPageWindow {
	private readonly heights: number[];
	readonly pageCount: number;

	constructor(pageCount: number, estimatedHeight: number, readonly gap = 18) {
		this.pageCount = Math.max(1, Math.floor(pageCount));
		this.heights = Array(this.pageCount).fill(Math.max(1, Math.floor(estimatedHeight)));
	}

	height(pageNumber: number): number {
		return this.heights[this.boundPage(pageNumber) - 1];
	}

	setHeight(pageNumber: number, height: number): void {
		if (Number.isFinite(height) && height > 0) this.heights[this.boundPage(pageNumber) - 1] = Math.floor(height);
	}

	offset(pageNumber: number): number {
		const precedingPages = Math.max(0, Math.min(this.pageCount, Math.floor(pageNumber) - 1));
		let offset = 0;
		for (let index = 0; index < precedingPages; index += 1) {
			offset += this.heights[index] + (index < this.pageCount - 1 ? this.gap : 0);
		}
		return offset;
	}

	pageAt(offset: number): number {
		let end = 0;
		for (let index = 0; index < this.pageCount - 1; index += 1) {
			end += this.heights[index] + this.gap;
			if (offset < end) return index + 1;
		}
		return this.pageCount;
	}

	range(pageNumber: number, endPageNumber = pageNumber): { first: number; last: number; before: number; after: number } {
		const page = this.boundPage(pageNumber);
		const first = Math.max(1, page - 1);
		const last = Math.min(this.pageCount, Math.max(page, this.boundPage(endPageNumber)) + 1);
		return {
			first,
			last,
			before: this.offset(first),
			after: this.offset(this.pageCount + 1) - this.offset(last + 1),
		};
	}

	private boundPage(pageNumber: number): number {
		return Math.max(1, Math.min(this.pageCount, Math.floor(pageNumber)));
	}
}
