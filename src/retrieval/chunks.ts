import { learningBlockRanges } from "../learning/curated-block";
import { createHash } from "node:crypto";
import { tokenizeForLexicalRetrieval } from "../query/lexical-retrieval";
import { EMBEDDING_MODEL, KNOWLEDGE_PREFIXES, type EvidenceRole, type KnowledgeChunk, type KnowledgeDocument } from "./types";

export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const inKnowledgeScope = (file: string): boolean => KNOWLEDGE_PREFIXES.some((prefix) => file.startsWith(prefix)) && file.endsWith(".md") && !file.split("/").some((part) => part.startsWith("."));
const STOP = new Set("a an the of in on at to for with and or is are was were be been can could should would do does did what which how why when where this that these those it its by from as than into about all entire".split(" "));
export function retrievalTerms(text: string): string[] { return tokenizeForLexicalRetrieval(text, 100).filter((term) => !STOP.has(term)).slice(0, 40); }
export function evidenceRole(document: KnowledgeDocument, heading: string): EvidenceRole {
	if (/发散|设想|研究建议|对我研究|开放问题|研究启发|可复用思路/.test(heading)) return "speculation";
	if (/来源|核验范围|证据缺口|元数据|与现有文献|待.*验证/.test(heading)) return "provenance";
	if (/\/mocs\/|\/projects\//.test(document.path) || /相关页面|链接|领域定位/.test(heading)) return "navigation";
	if (/\/sources\//.test(document.path)) return "evidence";
	return "background";
}
export function retrievalPassageText(text: string): string { return text.replace(/!\[[^\]]*\]\([^\n]*?\)/g, "").replace(/!\[\[[^\]]*\]\]/g, "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label: string) => label || target).trim(); }
export function chunkDocument(doc: KnowledgeDocument): KnowledgeChunk[] {
	const chunks: KnowledgeChunk[] = []; const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(doc.text);
	let cursor = frontmatter?.[0].length || 0; let trail: string[] = []; let fenced = "";
	const sections: Array<{ start: number; end: number; heading: string }> = [];
	for (const match of doc.text.slice(cursor).matchAll(/^.*(?:\n|$)/gm)) {
		const line = match[0]; const offset = (frontmatter?.[0].length || 0) + match.index;
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) { if (!fenced) fenced = fence[1]; else if (fence[1][0] === fenced[0] && fence[1].length >= fenced.length) fenced = ""; continue; }
		const heading = !fenced && /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (!heading) continue;
		if (offset > cursor) sections.push({ start: cursor, end: offset, heading: trail.filter(Boolean).join(" / ") });
		trail = trail.slice(0, heading[1].length - 1); trail[heading[1].length - 1] = heading[2]; cursor = offset + line.length;
	}
	if (cursor < doc.text.length) sections.push({ start: cursor, end: doc.text.length, heading: trail.filter(Boolean).join(" / ") });
	const excluded = learningBlockRanges(doc.text);
	const eligible = sections.flatMap(section => {
		const pieces: typeof sections = []; let from = section.start;
		for (const range of excluded) { if (range.end <= from || range.start >= section.end) continue; if (from < range.start) pieces.push({ ...section, start: from, end: range.start }); from = Math.max(from, range.end); }
		if (from < section.end) pieces.push({ ...section, start: from }); return pieces;
	});
	for (const section of eligible) for (let start = section.start; start < section.end;) {
		let end = Math.min(section.end, start + 1800);
		if (end < section.end) { const paragraph = doc.text.lastIndexOf("\n\n", end); if (paragraph > start + 900) end = paragraph; if (/[\uD800-\uDBFF]/.test(doc.text[end - 1])) end--; }
		const text = retrievalPassageText(doc.text.slice(start, end)); const input = doc.title + "\n" + section.heading + "\n" + text;
		if (text) chunks.push({ id: contentHash(doc.path + "|" + doc.hash + "|" + start + "|" + end).slice(0, 24), vectorKey: contentHash(EMBEDDING_MODEL + "|v1|" + input), path: doc.path,
			hash: doc.hash, title: doc.title, heading: section.heading, start, end, text, input, role: evidenceRole(doc, section.heading), origins: doc.origins, depth: doc.depth, basis: doc.basis });
		if (end === section.end) break;
		start = Math.max(start + 1, end - 160); if (/[\uDC00-\uDFFF]/.test(doc.text[start])) start++;
	}
	return chunks;
}
export function lexicalChunks(chunks: KnowledgeChunk[], query: string): Array<KnowledgeChunk & { score: number }> {
	const terms = retrievalTerms(query);
	return chunks.map((chunk) => {
		const title = new Set(retrievalTerms(chunk.title + " " + chunk.heading)); const body = new Set(tokenizeForLexicalRetrieval(chunk.text, 2000));
		const score = terms.reduce((sum, term) => sum + (title.has(term) ? 6 : 0) + (body.has(term) ? 2 : 0), 0);
		return { ...chunk, score };
	}).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
/** Identity constraints come from the user's question, never from an LLM's expanded keywords. */
export function paperScope(query: string, docs: KnowledgeDocument[], explicit?: string[]): string[] | null {
	if (explicit) return [...new Set(explicit.filter((file) => docs.some((doc) => doc.path === file)))];
	const lower = query.toLowerCase(); const sources = docs.filter((doc) => doc.path.startsWith("wiki/sources/"));
	const years = [...lower.matchAll(/\b([a-z][a-z-]+)\s*(?:et\s+al\.?\s*)?[,， ]*\s*((?:19|20)\d{2})\b/g)].filter(([, author]) => !STOP.has(author) && !["since", "before", "after", "year", "published"].includes(author));
	const dois = lower.match(/10\.\d{4,9}\/[^\s\]）)]+/g) || [];
	const matched = sources.filter((doc) => lower.includes(doc.path.split("/").slice(-1)[0].slice(0, -3).toLowerCase()) ||
		(doc.title.length > 20 && lower.includes(doc.title.toLowerCase())) || dois.some((doi) => doi.replace(/[.,;]+$/, "") === doc.doi.toLowerCase()) ||
		years.some(([, author, year]) => doc.year === year && (doc.path.split("/").slice(-1)[0].toLowerCase().startsWith(author + "_") || new RegExp("\\b" + author + "\\b", "i").test(doc.authors))));
	if (!matched.length) return years.length || dois.length ? [] : null;
	const paths = new Set(matched.map((doc) => doc.path));
	// Keep paper-specific searches on source notes. Multi-paper method/synthesis pages
	// are useful expansion routes, but can mix claims from unrelated papers.
	return [...paths];
}
