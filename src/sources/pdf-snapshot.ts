import { decodeIdentity, decodePdfSnapshot, decodePdfValidation, PDF_MAX_BYTES, type PdfSnapshot, type PdfValidation } from "../fulltext/contracts";
import { objectDigest, type ResolvedIdentity } from "../papers/identity";

/** A user-selected local file has no download job, provider locator or inferred license. */
export interface LocalPdfSnapshot {
	schemaVersion: 1;
	kind: "local-pdf";
	id: string;
	createdAt: string;
	origin: { kind: "local-file"; fileName: string; versionBasis: "unspecified" | "user-declared" };
	version: "unknown" | "version_of_record" | "accepted_manuscript";
	identity: ResolvedIdentity;
	artifact: { byteLength: number; sha256: string };
	validation: PdfValidation;
}
export type PdfSourceSnapshot = PdfSnapshot | LocalPdfSnapshot;
export const isLocalPdfSnapshot = (snapshot: PdfSourceSnapshot): snapshot is LocalPdfSnapshot => "kind" in snapshot && snapshot.kind === "local-pdf";
const keys = (value: unknown, expected: string[]) => value && typeof value === "object" && !Array.isArray(value)
	&& Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));

export function decodeLocalPdfSnapshot(raw: unknown): LocalPdfSnapshot {
	const s = raw as LocalPdfSnapshot;
	if (!keys(s, ["schemaVersion", "kind", "id", "createdAt", "origin", "version", "identity", "artifact", "validation"])
		|| s.schemaVersion !== 1 || s.kind !== "local-pdf" || !/^s-[a-f0-9-]{36}$/.test(s.id)
		|| typeof s.createdAt !== "string" || !Number.isFinite(Date.parse(s.createdAt))
		|| !keys(s.origin, ["kind", "fileName", "versionBasis"]) || s.origin.kind !== "local-file"
		|| typeof s.origin.fileName !== "string" || s.origin.fileName.length > 255 || !/^[^/\\<>:"|?*\x00-\x1f]+\.pdf$/i.test(s.origin.fileName)
		|| !["unknown", "version_of_record", "accepted_manuscript"].includes(s.version)
		|| s.origin.versionBasis !== (s.version === "unknown" ? "unspecified" : "user-declared")
		|| !keys(s.artifact, ["byteLength", "sha256"]) || !Number.isSafeInteger(s.artifact.byteLength)
		|| s.artifact.byteLength < 16 || s.artifact.byteLength > PDF_MAX_BYTES || !/^[a-f0-9]{64}$/.test(s.artifact.sha256)) throw new Error("本地 PDF 来源凭据无效");
	if (objectDigest(decodeIdentity(s.identity)) !== objectDigest(s.identity) || objectDigest(decodePdfValidation(s.validation)) !== objectDigest(s.validation)) throw new Error("本地 PDF 的身份或校验凭据不完整");
	return structuredClone(s);
}
export function decodePdfSourceSnapshot(raw: unknown): PdfSourceSnapshot {
	return (raw as { kind?: string })?.kind === "local-pdf" ? decodeLocalPdfSnapshot(raw) : decodePdfSnapshot(raw);
}
export const pdfSourceVersion = (snapshot: PdfSourceSnapshot): LocalPdfSnapshot["version"] => isLocalPdfSnapshot(snapshot) ? snapshot.version : snapshot.candidate.version;
export function pdfSourceVersionLabel(snapshot: PdfSourceSnapshot): string {
	const version = pdfSourceVersion(snapshot);
	return version === "unknown" ? "版本未核验" : (isLocalPdfSnapshot(snapshot) ? "用户声明的" : "") + (version === "version_of_record" ? "出版版本" : "作者接受稿");
}
