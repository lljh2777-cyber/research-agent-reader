import type { KnowledgeResult, SearchOptions } from "../retrieval/types";
import { contentHash, retrievalTerms, retrievalPassageText } from "../retrieval/chunks";
import { curationParagraphs } from "./policy";
import type { CurationEvidence } from "./types";
export type CurationSearch = (query: string, options: SearchOptions) => Promise<KnowledgeResult>;
export async function selectCurationParagraphs(text: string, path: string, query: string, search?: CurationSearch, signal?: AbortSignal) {
	const all = curationParagraphs(text); const terms = retrievalTerms(query);
	const lexical = [...all].sort((a, b) => terms.filter(t => (b.heading + " " + b.text).toLowerCase().includes(t)).length - terms.filter(t => (a.heading + " " + a.text).toLowerCase().includes(t)).length || a.start - b.start);
	const warnings: string[] = []; const semantic = new Map<string, typeof all[number]>(); let mode = "lexical";
	if (search) try {
		const result = await search(query, { signal, identityQuery: "整理目标段落", paperPaths: [path], limit: 1, perDocumentLimit: 8 }); signal?.throwIfAborted();
		mode = result.mode; warnings.push(...result.warnings);
		for (const hit of result.hits) {
			if (hit.path !== path || hit.hash !== contentHash(text) || !Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end > text.length || hit.end <= hit.start || retrievalPassageText(text.slice(hit.start, hit.end)) !== hit.text) { warnings.push("排除路径、指纹或位置不符的检索片段"); continue; }
			for (const p of all) if (p.start < hit.end && p.end > hit.start) semantic.set(p.id, p);
		}
	} catch (error) { signal?.throwIfAborted(); warnings.push("目标段落检索不可用，已回退本地关键词：" + String(error)); }
	// Six ranked candidates plus two lexical anchors; no passage is accepted as a fact by its score.
	const paragraphs = [...new Map([...semantic.values()].slice(0, 6).concat(lexical).map(p => [p.id, p])).values()].slice(0, 8);
	return { paragraphs, warnings: [...new Set(warnings)], selection: { mode, candidates: all.length, selected: paragraphs.length } };
}
/** Exact source spans, so a model may cite an ID without retyping the quotation. */
export function curationQuotes(evidence: CurationEvidence): NonNullable<CurationEvidence["quotes"]> {
	const quotes: NonNullable<CurationEvidence["quotes"]> = [];
	for (const match of evidence.text.matchAll(/[^\n。！？]+[。！？]?/g)) {
		const raw = match[0]; const trimmed = raw.trim(); if (!trimmed) continue; const offset = match.index + raw.indexOf(trimmed);
		for (let start = 0; start < trimmed.length; start += 1000) { const text = trimmed.slice(start, start + 1000); quotes.push({ id: evidence.id + ":q" + (quotes.length + 1), start: offset + start, end: offset + start + text.length, text }); }
	}
	return quotes;
}
