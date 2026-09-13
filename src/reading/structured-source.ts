import { decodeJatsManifest, type JatsManifest } from "../sources/jats-package";
import { objectDigest } from "../papers/identity";
import type { ReadingEvidence, ReadingSource } from "./types";

/** The full manifest pins every source file, including the deterministic projection. */
export interface StructuredReadingSnapshot { version: 1; format: "jats"; manifest: JatsManifest; }
export interface StructuredReadingLocation {
	packageKey: string; projectionId: string; blockId: string; xmlPath: string;
	xmlStart: number; xmlEnd: number; blockStart: number; blockEnd: number;
	resourceId?: string;
}
export const structuredFingerprint = (snapshot: StructuredReadingSnapshot): string => objectDigest(snapshot);
export function validateStructuredSource(source: ReadingSource): StructuredReadingSnapshot {
	const snapshot = source.structured;
	if (source.kind !== "structured" || snapshot?.version !== 1 || snapshot.format !== "jats") throw new Error("结构化阅读来源无效");
	const manifest = decodeJatsManifest(snapshot.manifest);
	if (source.path !== `papers/${manifest.packageKey}/article.md` || source.title !== manifest.identity.title
		|| structuredFingerprint(snapshot) !== source.fingerprint) throw new Error("结构化阅读来源与固定清单不一致");
	return snapshot;
}
export function structuredEvidenceId(location: StructuredReadingLocation, start: number): string {
	return `jats-${location.blockId}-${location.resourceId ? "image-" + location.resourceId.split("/")[1].split(".")[0] : start}`;
}
/** Offline session validation uses the saved manifest; it never rebinds history to live files. */
export function validateStructuredEvidence(evidence: ReadingEvidence, source: ReadingSource): void {
	const loc = evidence.structured, manifest = source.structured?.manifest;
	if (source.kind !== "structured" || evidence.kind !== "paper" || !loc || !manifest
		|| loc.packageKey !== manifest.packageKey || loc.projectionId !== manifest.projectionId
		|| evidence.path !== source.path || evidence.sourceHash !== source.fingerprint || evidence.page !== undefined
		|| typeof loc.xmlPath !== "string" || !/^\/article\[1\](?:\/[A-Za-z_][\w:.-]*\[[1-9]\d*\])+$/.test(loc.xmlPath)
		|| loc.blockId !== "b-" + objectDigest({ xmlSha256: manifest.files.find(f => f.path === "_source/article.xml")!.sha256, path: loc.xmlPath }).slice(0, 24)) throw new Error("JATS 证据与来源快照不一致");
	const mdBytes = manifest.files.find(f => f.path === "article.md")!.byteLength;
	const xmlBytes = manifest.files.find(f => f.path === "_source/article.xml")!.byteLength;
	if ([loc.xmlStart, loc.xmlEnd, loc.blockStart, loc.blockEnd, evidence.start, evidence.end].some(n => !Number.isSafeInteger(n) || n! < 0)
		|| loc.xmlStart >= loc.xmlEnd || loc.xmlEnd > xmlBytes || loc.blockStart >= loc.blockEnd || loc.blockEnd > mdBytes
		|| evidence.start! < loc.blockStart || evidence.end! > loc.blockEnd || evidence.start! >= evidence.end!
		|| evidence.text.length !== evidence.end! - evidence.start! || evidence.text.length > 4500) throw new Error("JATS 证据字符位置无效");
	if (loc.resourceId !== undefined && (typeof loc.resourceId !== "string" || !/^images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(loc.resourceId)
		|| !manifest.files.some(f => f.path === loc.resourceId))) throw new Error("JATS 图像不属于固定原文包");
	if (evidence.asset !== loc.resourceId || evidence.id !== structuredEvidenceId(loc, evidence.start!)) throw new Error("JATS 证据标识或资源位置无效");
}
