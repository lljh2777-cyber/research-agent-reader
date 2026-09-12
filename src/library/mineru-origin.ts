import { PDF_MAX_BYTES } from "../fulltext/contracts";
import { bytesDigest } from "../papers/identity";
import type { SourceManifest } from "../sources/pdf-package";
import type { LibraryIdentifiers, LibraryPdfOrigin } from "./types";

export interface LibraryPdfCandidate { manifest: SourceManifest; verified: boolean; }
export const pdfOriginKey = (sha256: string, byteLength: number): string => sha256 + ":" + byteLength;
const conflictingIds = (a: LibraryIdentifiers, b: LibraryIdentifiers): boolean => (["doi", "pmid", "pmcid"] as const).some(k => Boolean(a[k] && b[k] && a[k] !== b[k]));

/** Read projection only. A declared input is separate from full conversion-content verification. */
export function matchMineruOrigin(raw: Uint8Array, article: Uint8Array, index: ReadonlyMap<string, LibraryPdfCandidate[]>,
	metadata: { identifiers: LibraryIdentifiers; citekey?: string }): { origin: LibraryPdfOrigin; identity?: Pick<SourceManifest, "paperId" | "citekey" | "identity"> } | undefined {
	const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	// Preserve old converters and packages without input receipts; never infer from directory names.
	if (m?.schema_version !== 1 || m.extractor !== "mineru-open-api" || !m.source) return;
	if (m.source.sha256 === undefined || m.source.size === undefined) return;
	const sha256 = m.source.sha256, byteLength = m.source.size;
	if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > PDF_MAX_BYTES) throw new Error("转换包的 PDF 哈希或文件大小凭据无效");
	const outputs = Array.isArray(m.outputs) ? m.outputs : [];
	const text = outputs.filter((o: { path?: string } | null) => o?.path === "article.md");
	if (text.length !== 1 || text[0].size !== article.byteLength || text[0].sha256 !== bytesDigest(article)) throw new Error("转换正文与清单中的大小或哈希不一致，未关联论文");
	const copies = outputs.filter((o: { path?: string } | null) => o?.path === "_extraction/source.pdf");
	if (copies.length > 1 || copies.some((o: { size?: number; sha256?: string }) => o.size !== byteLength || o.sha256 !== sha256)
		|| m.options?.include_source_pdf === true && copies.length !== 1) throw new Error("转换包附带 PDF 的凭据与输入不一致，未关联论文");
	const candidates = index.get(pdfOriginKey(sha256, byteLength)) || [];
	const unresolved = (reason: string) => ({ origin: { state: "unresolved" as const, sha256, byteLength, sourceIds: [], reason } });
	if (!candidates.length) return unresolved("未找到与转换清单的哈希和大小一致的已保存 PDF，未通过 PDF 凭据建立关联");
	if (candidates.length > 64) return unresolved("匹配的 PDF 版本过多，请先核对来源");
	if (candidates.some(c => !c.verified)) return unresolved("匹配的 PDF 包存在未通过核验的来源，请先核对");
	const first = candidates[0].manifest, identifiers: LibraryIdentifiers = { ...first.identity.identifiers };
	for (const { manifest: current } of candidates) {
		if (current.paperId !== first.paperId || current.citekey !== first.citekey || conflictingIds(identifiers, current.identity.identifiers)) return unresolved("相同 PDF 内容指向不同论文身份，未选择其中一个关联");
		for (const kind of ["doi", "pmid", "pmcid"] as const) if (current.identity.identifiers[kind]) identifiers[kind] = current.identity.identifiers[kind];
	}
	if (conflictingIds(identifiers, metadata.identifiers) || metadata.citekey && metadata.citekey !== first.citekey) return unresolved("转换正文属性与 PDF 来源身份冲突，未继承 PDF 身份");
	return {
		origin: { state: "matched", sha256, byteLength, sourceIds: candidates.map(c => `papers/${c.manifest.packageKey}/source.pdf`).sort(), reason: "转换清单的输入哈希与文件大小匹配已核验 PDF；转换正文单独核验" },
		identity: { paperId: first.paperId, citekey: first.citekey, identity: { ...first.identity, identifiers } },
	};
}
