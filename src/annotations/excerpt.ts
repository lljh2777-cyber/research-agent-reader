import { bytesDigest, objectDigest } from "../papers/identity";
import type { AnnotationRecord, AnnotationSelection } from "./types";

/** A text revision, not a PDF/package verification or a scientific review. Offsets use JS UTF-16. */
export interface ExcerptRevision { algorithm: "markdown-utf8-sha256"; digest: string; length: number; }
export interface ExcerptReceipt extends ExcerptRevision { version: 1; context: string; contextStart: number; }
export const excerptRevision = (content: string): ExcerptRevision => ({ algorithm: "markdown-utf8-sha256", digest: bytesDigest(new TextEncoder().encode(content)), length: content.length });
export const supportsExcerpt = (path: string): boolean => /^(papers|Clippings)\/.+\.md$/.test(path) && !path.split("/").some(p => !p || p === "." || p === "..") && !/[\\:\r\n]/.test(path);
export function validExcerpt(value: unknown, anchor: AnnotationRecord["sourceAnchor"], selected: string): value is ExcerptReceipt {
	const r = value as ExcerptReceipt | undefined;
	return Boolean(r && r.version === 1 && r.algorithm === "markdown-utf8-sha256" && typeof r.digest === "string" && /^[a-f0-9]{64}$/.test(r.digest)
		&& Number.isSafeInteger(r.length) && r.length > 0 && r.length <= 32 * 1024 * 1024
		&& Number.isSafeInteger(r.contextStart) && r.contextStart >= 0 && typeof r.context === "string" && r.context.length <= 3200
		&& r.contextStart + r.context.length <= r.length && anchor && anchor.end <= r.length && anchor.end === anchor.start + selected.length
		&& anchor.start >= r.contextStart && anchor.end <= r.contextStart + r.context.length
		&& r.context.slice(anchor.start - r.contextStart, anchor.end - r.contextStart) === selected);
}
export function prepareExcerpt(selection: AnnotationSelection, content: string): { id: string; receipt: ExcerptReceipt } {
	if (!supportsExcerpt(selection.sourcePath) || !selection.sourceRevision) throw new Error("请从原文 Markdown 重新选择文字后保存摘录");
	if (content.length > 32 * 1024 * 1024 || objectDigest(selection.sourceRevision) !== objectDigest(excerptRevision(content))) throw new Error("原文版本已变化，请重新选择；本次未保存摘录");
	const { sourceStart: start, sourceEnd: end, selectedText: text } = selection;
	if (!text || text.length > 600 || /[\r\n]/.test(text) || text.includes("<!-- agent-dashboard:") || selection.prefix.length > 80 || selection.suffix.length > 80
		|| !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end !== start + text.length
		|| content.slice(start, end) !== text || content.slice(Math.max(0, start - selection.prefix.length), start) !== selection.prefix
		|| content.slice(end, end + selection.suffix.length) !== selection.suffix) throw new Error("选区与原文位置不一致，请重新选择");
	const contextStart = Math.max(0, start - 1300), receipt: ExcerptReceipt = { version: 1, ...excerptRevision(content), contextStart, context: content.slice(contextStart, end + 1300) };
	const id = "ann-excerpt-" + objectDigest({ path: selection.sourcePath, revision: selection.sourceRevision, start, end }).slice(0, 48);
	return { id, receipt };
}
export function excerptMatches(record: AnnotationRecord, content: string): boolean {
	return Boolean(record.excerpt && validExcerpt(record.excerpt, record.sourceAnchor, record.selectedText)
		&& record.excerpt.digest === excerptRevision(content).digest && record.excerpt.length === content.length
		&& content.slice(record.sourceAnchor!.start, record.sourceAnchor!.end) === record.selectedText);
}
