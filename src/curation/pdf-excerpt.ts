import type { App } from "obsidian";
import { FileSourceStorage, type SourceStorage } from "../sources/storage";
import { decodeSourceManifest, loadPdfSource, type SourceManifest } from "../sources/pdf-package";
import { bytesDigest, objectDigest } from "../papers/identity";
import { conflictingNoteIdentifiers } from "../papers/note-identity";
import { canonicalTitle } from "../fulltext/identity-resolver";
import { PDF_EXCERPT_MAX_BYTES, pdfExcerptId, pdfRecordSelection, supportsPdfExcerpt, validPdfExcerpt } from "../annotations/pdf-excerpt";
import { verifyPdfSelection } from "../annotations/native-pdf-excerpt";
import type { AnnotationRecord } from "../annotations/types";
import type { CurationContext } from "./types";
import type { ReadingSource } from "../reading/types";

export type PdfExcerptSource = { version: 1; kind: "standalone" } | { version: 1; kind: "managed"; manifest: SourceManifest };
export const PDF_EXCERPT_RULE = "pdf-excerpt-curation-v1";
const sourceFor = (record: AnnotationRecord, proof: PdfExcerptSource): ReadingSource => ({ kind: "pdf", path: record.sourcePath,
	fingerprint: record.pdfExcerpt!.digest, title: proof.kind === "managed" ? proof.manifest.identity.title : record.sourcePath.split("/").pop()!.replace(/\.pdf$/i, "") });

/** Managed package files never fall through to a loose PDF when their manifest is missing or damaged. */
async function packageProof(io: SourceStorage, sourcePath: string): Promise<PdfExcerptSource> {
	const parts = sourcePath.split("/");
	if (parts[0].toLowerCase() !== "papers" || parts.length < 3) return { version: 1, kind: "standalone" };
	if (parts[0] !== "papers") throw new Error("请使用原文目录的规范路径 papers/");
	const entries = await io.list("papers/" + parts[1]);
	if (!entries.some(e => e.name === "_source") && !/--(?:pdf|jats)--/.test(parts[1])) return { version: 1, kind: "standalone" };
	if (parts.length !== 3 || parts[2] !== "source.pdf" || !parts[1].includes("--pdf--")) throw new Error("此文件位于受管理原文包中，请选择已登记的 PDF source.pdf");
	return { version: 1, kind: "managed", manifest: (await loadPdfSource(io, parts[1])).manifest };
}
export async function readPdfExcerptSource(app: App, record: AnnotationRecord, signal?: AbortSignal): Promise<{ source: ReadingSource; proof: PdfExcerptSource }> {
	const selection = pdfRecordSelection(record); signal?.throwIfAborted();
	if (!supportsPdfExcerpt(record.sourcePath)) throw new Error("PDF 摘录路径不受支持");
	const root = (app.vault.adapter as { getBasePath?: () => string })?.getBasePath?.();
	if (!root) throw new Error("PDF 摘录整理需要桌面本地知识库");
	const storage = new FileSourceStorage(root);
	const io: SourceStorage = { read: async (...args) => { signal?.throwIfAborted(); const value = await storage.read(...args); signal?.throwIfAborted(); return value; },
		list: async (...args) => { signal?.throwIfAborted(); const value = await storage.list(...args); signal?.throwIfAborted(); return value; },
		mkdir: async () => { throw new Error("PDF 整理只读来源"); }, create: async () => { throw new Error("PDF 整理只读来源"); } };
	const before = await packageProof(io, record.sourcePath);
	const prepared = await verifyPdfSelection(app, selection, signal);
	if (prepared.id !== record.id) throw new Error("PDF 摘录 ID 与原页位置不一致");
	const after = await packageProof(io, record.sourcePath);
	if (objectDigest(before) !== objectDigest(after)) throw new Error("PDF 原文包在核对期间变化，请重新准备");
	const bytes = await io.read(record.sourcePath, PDF_EXCERPT_MAX_BYTES);
	if (!bytes || bytes.length !== record.pdfExcerpt!.byteLength || bytesDigest(bytes) !== record.pdfExcerpt!.digest) throw new Error("PDF 文件版本已变化，请重新核对摘录");
	if (after.kind === "managed" && (after.manifest.files[0].sha256 !== record.pdfExcerpt!.digest || after.manifest.files[0].byteLength !== record.pdfExcerpt!.byteLength)) throw new Error("PDF 原文包与摘录版本不一致");
	return { source: sourceFor(record, after), proof: after };
}
export function validatePdfExcerptContext(context: CurationContext): void {
	const input = context.excerpt, record = input?.snapshot.record, proof = input?.pdfSource;
	if (!record || record.excerpt || !supportsPdfExcerpt(record.sourcePath) || !validPdfExcerpt(record.pdfExcerpt, record.sourceAnchor, record.selectedText)
		|| record.id !== pdfExcerptId(record.sourcePath, record.pdfExcerpt, record.sourceAnchor!.start, record.sourceAnchor!.end)
		|| !proof || proof.version !== 1 || !["standalone", "managed"].includes(proof.kind)) throw new Error("PDF 摘录整理凭据无效");
	if (proof.kind === "managed") {
		const m = decodeSourceManifest(proof.manifest);
		if (record.sourcePath !== `papers/${m.packageKey}/source.pdf` || m.files[0].sha256 !== record.pdfExcerpt.digest || m.files[0].byteLength !== record.pdfExcerpt.byteLength
			|| objectDigest(proof) !== objectDigest({ version: 1, kind: "managed", manifest: m })) throw new Error("PDF 摘录与原文包凭据不一致");
	} else if (objectDigest(proof) !== objectDigest({ version: 1, kind: "standalone" })) throw new Error("独立 PDF 摘录不能带有原文包身份");
	if (objectDigest(context.source) !== objectDigest(sourceFor(record, proof))) throw new Error("PDF 摘录来源与固定文件版本不一致");
}
/** A matching title or DOI alone cannot choose a PDF version for a paper note. */
export function pdfExcerptTargetCompatible(context: CurationContext, metadata: Record<string, unknown>): void {
	if (!context.target.path.startsWith("wiki/sources/")) return;
	const proof = context.excerpt!.pdfSource;
	if (proof?.kind !== "managed") throw new Error("此 PDF 尚未登记并核验原文包；可补充到概念、方法或综合笔记，暂不能补写论文来源笔记");
	const m = proof.manifest;
	const paths = [metadata.source_path, metadata.pdf, metadata.source_pdf, metadata.pdf_path].filter(value => value !== undefined && value !== "");
	if (!paths.length || paths.some(value => value !== context.source.path)
		|| canonicalTitle(String(metadata.title || "")) !== canonicalTitle(m.identity.title) || conflictingNoteIdentifiers(m.identity, metadata)
		|| metadata.citekey && metadata.citekey !== m.citekey || metadata.source_kind && metadata.source_kind !== "pdf"
		|| metadata.source_manifest_digest && metadata.source_manifest_digest !== m.digest || metadata.source_version && metadata.source_version !== m.sourceVersionId
		|| metadata.source_projection_id || metadata.source_xml_sha256 || metadata.article_path
		|| metadata.source_identity_digest && metadata.source_identity_digest !== objectDigest(m.identity)) throw new Error("目标论文与 PDF 身份、来源路径或版本不一致，请选择明确关联同一 PDF 的笔记");
}
