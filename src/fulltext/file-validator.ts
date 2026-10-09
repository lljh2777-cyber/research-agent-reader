import { loadPdfJs } from "obsidian";
import { setTimeout, clearTimeout } from "node:timers";
import { extractPdfDoiCandidates } from "../agent/pdf-identity";
import { canonicalTitle } from "./identity-resolver";
import { decodePdfValidation, PDF_MAX_BYTES, type PdfValidation, type ResolvedIdentity } from "./contracts";
import { SourceError } from "./errors";
import { abortable } from "./transport";

export interface PdfPage {
	getTextContent(): Promise<{items: Array<{str?: string; hasEOL?: boolean}>}>;
	getViewport(options: {scale: number}): {width: number; height: number};
	render(options: unknown): {promise: Promise<void>; cancel(): void}; cleanup?(): void;
}
export interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage>; getMetadata?(): Promise<{info?: Record<string, unknown>; metadata?: {get?(key: string): unknown}}> ; }
export interface PdfApi { getDocument(options: unknown): {promise: Promise<PdfDocument>; destroy(): Promise<void>}; }
export type PdfLoader = () => Promise<PdfApi>;
export const defaultPdfLoader: PdfLoader = async () => await loadPdfJs() as PdfApi;
export function pdfEnvelope(bytes: Uint8Array): void {
	if (bytes.length < 16 || bytes.length > PDF_MAX_BYTES || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-" || !Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString("ascii").includes("%%EOF")) throw new SourceError("invalid_pdf", "PDF 文件头、结束标记或大小不符合要求");
}
export async function openBoundedPdf(bytes: Uint8Array, signal: AbortSignal, loader: PdfLoader = defaultPdfLoader): Promise<{pdf: PdfDocument; destroy(): Promise<void>}> {
	pdfEnvelope(bytes);
	const api = await abortable(loader(), signal), task = api.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, stopAtErrors: true });
	try { const pdf = await abortable(task.promise, signal); if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 2048) throw new SourceError("pdf_pages", "PDF 页数无效或超过 2048 页"); return { pdf, destroy: () => task.destroy() }; }
	catch (error) { void task.destroy().catch(() => undefined); if (error instanceof SourceError) throw error; throw new SourceError("unreadable_pdf", "PDF 无法解析或需要密码，未保存为可用快照"); }
}
export async function validatePdf(bytes: Uint8Array, identity: ResolvedIdentity, signal: AbortSignal, loader: PdfLoader = defaultPdfLoader): Promise<PdfValidation> {
	const controller = new AbortController(), relay = () => controller.abort(signal.reason); signal.addEventListener("abort", relay, {once:true}); if (signal.aborted) relay();
	const timer = setTimeout(() => controller.abort(new SourceError("pdf_timeout", "PDF 校验超时")), 20000); let opened: Awaited<ReturnType<typeof openBoundedPdf>> | undefined;
	try {
		opened = await openBoundedPdf(bytes, controller.signal, loader);
		const page = await abortable(opened.pdf.getPage(1), controller.signal);
		const content = await abortable(page.getTextContent(), controller.signal);
		const firstPageText = content.items.map(i => (i.str || "") + (i.hasEOL ? "\n" : " ")).join("").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").slice(0,8000);
		const doiCandidates = extractPdfDoiCandidates([firstPageText]).slice(0,30);
		const metadata = opened.pdf.getMetadata ? await abortable(opened.pdf.getMetadata(), controller.signal) : undefined;
		const embedded = extractPdfDoiCandidates([String(metadata?.info?.DOI || ""), String(metadata?.metadata?.get?.("prism:doi") || "")]);
		const expectedDoi = identity.identifiers.doi;
		const title = canonicalTitle(identity.title), titleMatched = title.length >= 20 && canonicalTitle(firstPageText).includes(title);
		if (expectedDoi && (embedded.some(doi => doi.toLowerCase() !== expectedDoi) || (!titleMatched && doiCandidates.length > 0 && !doiCandidates.some(doi => doi.toLowerCase() === expectedDoi)))) throw new SourceError("pdf_identity_conflict", "PDF 中的论文标识与所选论文冲突；文件保留在未完成尝试中", "conflict");
		page.cleanup?.();
		return decodePdfValidation({ pageCount: opened.pdf.numPages, firstPageText, doiCandidates, identityCheck: titleMatched && (!expectedDoi || [...doiCandidates,...embedded].some(doi => doi.toLowerCase() === expectedDoi)) ? "verified" : "needs_confirmation", bodyCheck: "not_checked" });
	} finally { clearTimeout(timer); signal.removeEventListener("abort", relay); if (opened) await opened.destroy().catch(() => undefined); }
}
