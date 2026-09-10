import { objectDigest } from "../papers/identity";
import { canonicalTitle } from "../fulltext/identity-resolver";
import type { ReadingEvidence, ReadingSource } from "./types";
import { validateStructuredSource, validateStructuredEvidence, type StructuredReadingLocation } from "./structured-source";

/** Persisted excerpt used by assistants/reviews; its ID remains the original reading evidence ID. */
export interface StructuredReference {
	evidenceId?: string; structured?: StructuredReadingLocation;
	path: string; hash: string; text: string; start?: number; end?: number; page?: number;
}
export function structuredReference(item: ReadingEvidence, source: ReadingSource, limit: number): Pick<StructuredReference, "evidenceId" | "structured" | "start" | "end"> {
	validateStructuredSource(source); validateStructuredEvidence(item, source);
	return { evidenceId: item.id, structured: structuredClone(item.structured!), start: item.start, end: item.start! + Math.min(limit, item.text.length) };
}
export function validateStructuredReference(ref: StructuredReference, source: ReadingSource): void {
	validateStructuredSource(source);
	validateStructuredEvidence({ id: ref.evidenceId!, kind: "paper", path: ref.path, sourceHash: ref.hash, label: "", text: ref.text,
		start: ref.start, end: ref.end, page: ref.page, structured: ref.structured, asset: ref.structured?.resourceId }, source);
}
export function matchStructuredReference(ref: StructuredReference, source: ReadingSource, evidence: ReadingEvidence[]): ReadingEvidence {
	validateStructuredReference(ref, source);
	const item = evidence.find(e => e.id === ref.evidenceId);
	if (!item || objectDigest(item.structured) !== objectDigest(ref.structured) || item.start !== ref.start || !item.text.startsWith(ref.text)
		|| item.sourceHash !== ref.hash || item.path !== ref.path) throw new Error("JATS 引用与固定原文块不一致");
	return item;
}
export function structuredLocationLabel(ref: StructuredReference): string {
	return ref.structured ? `JATS 块 ${ref.structured.blockId} · 字符 ${ref.start}–${ref.end} · 无 PDF 页码` : "";
}

/** Exact paper identifiers and source provenance take priority over a matching title. */
export function structuredTargetCompatible(source: ReadingSource, path: string, metadata: Record<string, unknown>): boolean {
	const m = validateStructuredSource(source).manifest;
	if (!path.startsWith("wiki/sources/")) return true;
	if (canonicalTitle(String(metadata.title || "")) !== canonicalTitle(m.identity.title)) return false;
	if (metadata.citekey && metadata.citekey !== m.citekey) return false;
	const ids = { doi: String(metadata.doi || "").replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").trim().toLowerCase(),
		pmid: String(metadata.pmid || "").replace(/^PMID:\s*/i, "").trim(), pmcid: String(metadata.pmcid || "").toUpperCase().trim() };
	const keys = ["doi", "pmid", "pmcid"] as const;
	if (keys.some(k => ids[k] && m.identity.identifiers[k] && ids[k] !== m.identity.identifiers[k])) return false;
	const jats = metadata.source_kind === "jats" || metadata.source_manifest_digest || /--jats--/.test(String(metadata.source_path || ""));
	if (jats) return metadata.source_kind === "jats" && metadata.source_path === source.path && metadata.source_manifest_digest === m.digest
		&& metadata.source_projection_id === m.projectionId && metadata.source_identity_digest === objectDigest(m.identity)
		&& metadata.source_version === m.sourceVersionId && metadata.source_xml_sha256 === m.files.find(f => f.path === "_source/article.xml")!.sha256;
	return keys.some(k => ids[k] && ids[k] === m.identity.identifiers[k]) || path === `wiki/sources/${m.citekey}.md`;
}
