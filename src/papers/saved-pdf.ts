import * as path from "node:path";
import { loadPdfSource, packageKeyValid } from "../sources/pdf-package";
import type { SourceCatalog } from "./catalog";
import { bytesDigest } from "./identity";

/** A saved original is independent of a download job and of its temporary file. */
export interface SavedPdfRef { packageKey: string; manifestDigest: string; paperId: string; sha256: string; byteLength: number; }
export function decodeSavedPdfRef(value: unknown): SavedPdfRef {
	const r = value as SavedPdfRef;
	if (!r || !packageKeyValid(r.packageKey) || !/^p-[a-f0-9-]{36}$/.test(r.paperId)
		|| !/^[a-f0-9]{64}$/.test(r.manifestDigest) || !/^[a-f0-9]{64}$/.test(r.sha256)
		|| !Number.isSafeInteger(r.byteLength) || r.byteLength < 16 || r.byteLength > 64 * 1024 * 1024
		|| Object.keys(r).sort().join() !== ["packageKey", "manifestDigest", "paperId", "sha256", "byteLength"].sort().join()) throw new Error("已保存 PDF 的来源凭据无效");
	return { packageKey: r.packageKey, manifestDigest: r.manifestDigest, paperId: r.paperId, sha256: r.sha256, byteLength: r.byteLength };
}
export async function readSavedPdf(catalog: SourceCatalog, vaultRoot: string, reference: SavedPdfRef, signal: AbortSignal) {
	const ref = decodeSavedPdfRef(reference); signal.throwIfAborted();
	const source = await loadPdfSource(catalog.storage, ref.packageKey), m = source.manifest;
	if (m.digest !== ref.manifestDigest || m.paperId !== ref.paperId || m.files[0].sha256 !== ref.sha256 || m.files[0].byteLength !== ref.byteLength) throw new Error("已保存原文版本已变化，请重新选择");
	const plan = await catalog.associate(m.identity); signal.throwIfAborted();
	if (plan.existingPaperId !== ref.paperId) throw new Error("已保存原文的文献关联已变化");
	const bytes = await catalog.storage.read(`papers/${ref.packageKey}/source.pdf`, ref.byteLength); signal.throwIfAborted();
	if (!bytes || bytes.length !== ref.byteLength || bytesDigest(bytes) !== ref.sha256) throw new Error("已保存 PDF 内容已变化");
	if (!path.isAbsolute(vaultRoot)) throw new Error("无法定位当前知识库");
	return { ...source, bytes, path: path.join(vaultRoot, "papers", ref.packageKey, "source.pdf"), reference: ref };
}
