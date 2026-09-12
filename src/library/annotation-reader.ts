import { readAnnotationRecords } from "../annotations/annotation-service";
import type { LibraryContentRole, LibraryAnnotationProvenance } from "./types";

export interface LibraryAnnotationReadRecord {
	id: string;
	sourcePath: string;
	selectedText: string;
	section: string;
	roles: LibraryContentRole[];
	anchor?: { start: number; end: number; prefix: string; suffix: string };
	provenance: LibraryAnnotationProvenance;
}
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
function section(body: string, name: "manual" | "ai"): string {
	const start = `<!-- annotation:${name}:start -->`, end = `<!-- annotation:${name}:end -->`;
	const at = body.indexOf(start), until = body.indexOf(end);
	if (at < 0 || until < at || body.indexOf(start, at + start.length) >= 0 || body.indexOf(end, until + end.length) >= 0) throw new Error("旧批注内容分区缺失、重复或未闭合");
	const value = body.slice(at + start.length, until);
	if (/<!-- annotation:(?:manual|ai):(?:start|end) -->/.test(value)) throw new Error("旧批注内容分区交叠，角色无法可靠区分");
	return value.trim();
}

/** Compatibility reader only. Never rewrites an external annotation or reinterprets its AI text. */
export function readLibraryAnnotations(content: string, annotationPath: string, parseYaml: (text: string) => unknown): { records: LibraryAnnotationReadRecord[]; errors: string[] } {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	let raw: Record<string, unknown> = {};
	try { if (frontmatter) raw = asRecord(parseYaml(frontmatter[1])); }
	catch { return { records: [], errors: ["批注文献属性无法解析，文件已保留"] }; }
	if (raw.annotation_schema !== undefined) {
		try {
			if (raw.annotation_schema !== 2) throw new Error("旧批注格式版本不受支持");
			if (content.includes("<!-- agent-dashboard:annotation-start ")) throw new Error("同一文件混合两种批注格式，需先核对");
			const source = asRecord(raw.source), anchor = asRecord(raw.anchor), quote = asRecord(anchor.quote), position = asRecord(anchor.position), heading = asRecord(anchor.heading);
			if (!text(raw.id, 200) || !/^annotation-[a-f0-9-]{36}$/.test(raw.id) || annotationPath.split("/").pop() !== raw.id + ".md"
				|| !text(source.path, 600) || !source.path || !text(source.noteId, 600) || source.path !== source.noteId
				|| !text(source.vaultId, 200) || !source.vaultId || !text(source.revision, 64) || !/^[a-f0-9]{64}$/.test(source.revision)
				|| anchor.schemaVersion !== 1 || !text(quote.exact, 10000) || !quote.exact || !text(quote.prefix, 2000) || !text(quote.suffix, 2000)
				|| !Number.isSafeInteger(position.start) || !Number.isSafeInteger(position.end) || Number(position.start) < 0
				|| Number(position.end) !== Number(position.start) + quote.exact.length || !text(heading.text, 2000)) throw new Error("旧批注身份、来源版本或锚点无效");
			const body = content.slice(frontmatter![0].length), manual = section(body, "manual"), ai = section(body, "ai");
			return { records: [{ id: raw.id, sourcePath: source.path, selectedText: quote.exact, section: heading.text,
				anchor: { start: Number(position.start), end: Number(position.end), prefix: quote.prefix, suffix: quote.suffix },
				roles: ["original_quote", ...(manual ? ["personal_note" as const] : []), ...(ai ? ["ai_explanation" as const] : [])],
				provenance: { format: "annotation-schema-2", sourcePath: source.path, sourceRevision: source.revision, vaultId: source.vaultId },
			}], errors: [] };
		} catch (error) { return { records: [], errors: [error instanceof Error ? error.message : "旧批注读取失败"] }; }
	}
	const result = readAnnotationRecords(content, annotationPath);
	return { errors: result.errors, records: result.records.map(record => ({
		id: record.id, sourcePath: record.sourcePath, selectedText: record.selectedText, section: record.section, anchor: record.sourceAnchor,
		roles: ["original_quote", ...(record.manualText ? ["personal_note" as const] : []), ...(record.aiText ? ["ai_explanation" as const] : [])],
		provenance: { format: record.excerpt ? "dashboard-excerpt-1" : "dashboard-blocks", sourcePath: record.sourcePath, ...(record.excerpt ? { sourceRevision: record.excerpt.digest } : {}) },
	})) };
}
