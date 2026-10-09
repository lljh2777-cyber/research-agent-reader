import { bytesDigest, objectDigest } from "../papers/identity";
import type { AnnotationRecord, AnnotationSelection } from "./types";

export const PDF_EXCERPT_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_EXCERPT_MAX_PAGES = 2000;
export interface PdfExcerptReceipt {
	version: 1;
	algorithm: "pdf-bytes-sha256";
	digest: string;
	byteLength: number;
	page: number;
	pageCount: number;
	textAlgorithm: "pdfjs-items-eol-v1";
	pageTextHash: string;
	pageTextLength: number;
	contextStart: number;
	context: string;
}
export interface PdfTextItem { str: string; hasEOL: boolean; }
export interface PdfPageText { items: PdfTextItem[]; starts: number[]; text: string; hash: string; }
export const supportsPdfExcerpt = (path: string): boolean => /^(papers|Clippings)\/.+\.pdf$/i.test(path)
	&& !path.split("/").some(p => !p || p === "." || p === "..") && !/[\\:\x00-\x1f]/.test(path);
const hash = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max;

/** Raw PDF.js items (disableNormalization: true), item order, spaces and explicit line endings. No OCR or fuzzy matching. */
export function pdfPageText(raw: unknown[]): PdfPageText {
	if (!Array.isArray(raw) || raw.length > 100000) throw new Error("PDF 页内文字超过读取上限");
	const items: PdfTextItem[] = [], starts: number[] = []; let text = "";
	for (const value of raw) {
		const item = value as Partial<PdfTextItem>;
		if (!item || typeof item.str !== "string") continue;
		starts.push(text.length); items.push({ str: item.str, hasEOL: item.hasEOL === true });
		text += item.str + (item.hasEOL === true ? "\n" : "");
		if (text.length > 2 * 1024 * 1024) throw new Error("PDF 页内文字超过读取上限");
	}
	if (!text.trim()) throw new Error("此页没有可提取的文字；扫描图片暂不支持划词摘录");
	return { items, starts, text, hash: objectDigest(items) };
}
export function validPdfExcerpt(value: unknown, anchor: AnnotationRecord["sourceAnchor"], selected: string): value is PdfExcerptReceipt {
	const r = value as PdfExcerptReceipt | undefined;
	return Boolean(r && r.version === 1 && r.algorithm === "pdf-bytes-sha256" && hash(r.digest)
		&& integer(r.byteLength, 1, PDF_EXCERPT_MAX_BYTES) && integer(r.pageCount, 1, PDF_EXCERPT_MAX_PAGES) && integer(r.page, 1, r.pageCount)
		&& r.textAlgorithm === "pdfjs-items-eol-v1" && hash(r.pageTextHash) && integer(r.pageTextLength, 1, 2 * 1024 * 1024)
		&& integer(r.contextStart, 0, r.pageTextLength) && typeof r.context === "string" && r.context.length <= 3200 && r.contextStart + r.context.length <= r.pageTextLength
		&& selected.trim() && selected.length <= 600 && !selected.includes("<!-- agent-dashboard:") && anchor
		&& integer(anchor.start, r.contextStart, r.pageTextLength) && anchor.end === anchor.start + selected.length && anchor.end <= r.contextStart + r.context.length
		&& r.context.slice(anchor.start - r.contextStart, anchor.end - r.contextStart) === selected);
}
export function pdfExcerptId(path: string, receipt: PdfExcerptReceipt, start: number, end: number): string {
	return "ann-excerpt-" + objectDigest({ path, algorithm: receipt.algorithm, digest: receipt.digest, page: receipt.page, textAlgorithm: receipt.textAlgorithm, pageTextHash: receipt.pageTextHash, start, end }).slice(0, 48);
}
export function pdfReceipt(bytes: Uint8Array, page: number, pageCount: number, text: PdfPageText, start: number, end: number): PdfExcerptReceipt {
	const contextStart = Math.max(0, start - 1300);
	return { version: 1, algorithm: "pdf-bytes-sha256", digest: bytesDigest(bytes), byteLength: bytes.length, page, pageCount,
		textAlgorithm: "pdfjs-items-eol-v1", pageTextHash: text.hash, pageTextLength: text.text.length, contextStart, context: text.text.slice(contextStart, end + 1300) };
}
export function preparePdfExcerpt(selection: AnnotationSelection, bytes: Uint8Array, text: PdfPageText, pageCount: number): { id: string; receipt: PdfExcerptReceipt } {
	const { pdfExcerpt: r, sourceStart: start, sourceEnd: end, selectedText: selected } = selection;
	const anchor = { start, end, prefix: selection.prefix, suffix: selection.suffix };
	if (!supportsPdfExcerpt(selection.sourcePath) || selection.sourceRevision || !validPdfExcerpt(r, anchor, selected)) throw new Error("PDF 摘录凭据或选区无效，请从原页重新选择");
	const receipt = pdfReceipt(bytes, r.page, pageCount, text, start, end);
	if (objectDigest(r) !== objectDigest(receipt)) throw new Error("PDF 文件版本或页内文字已变化，请重新选择；本次未保存摘录");
	if (text.text.slice(start, end) !== selected || selection.prefix.length > 80 || selection.suffix.length > 80
		|| text.text.slice(Math.max(0, start - selection.prefix.length), start) !== selection.prefix || text.text.slice(end, end + selection.suffix.length) !== selection.suffix) throw new Error("PDF 选区与页内位置不一致，请重新选择");
	return { id: pdfExcerptId(selection.sourcePath, receipt, start, end), receipt };
}
export function pdfRecordSelection(record: AnnotationRecord): AnnotationSelection {
	const a = record.sourceAnchor;
	if (!a || !validPdfExcerpt(record.pdfExcerpt, a, record.selectedText)) throw new Error("PDF 摘录凭据损坏，请检查摘录文档");
	return { sourcePath: record.sourcePath, selectedText: record.selectedText, sourceStart: a.start, sourceEnd: a.end, prefix: a.prefix, suffix: a.suffix,
		pdfExcerpt: { ...record.pdfExcerpt }, section: record.section, context: record.pdfExcerpt.context, anchorRect: {} as DOMRect, isTableCell: false };
}
