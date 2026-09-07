import type { App } from "obsidian";
import { contentHash } from "../retrieval/chunks";
import { ROLE_LABELS, type KnowledgeResult, type SearchOptions } from "../retrieval/types";
import { readingExportNodes, safeRelatedPath, type ReadingExportScope } from "./export";
import type { ReadingSession } from "./types";

export interface ReadingAssociation { path: string; title: string; hash: string; reason: string; heading: string; excerpt: string; role: string; origins: string[]; }
export type AssociationSearch = (query: string, options: SearchOptions) => Promise<KnowledgeResult>;
export async function readingAssociations(app: App, session: ReadingSession, scope: ReadingExportScope, nodeId: string, search: AssociationSearch, signal: AbortSignal): Promise<{ candidates: ReadingAssociation[]; warnings: string[] }> {
	const nodes = readingExportNodes(session, scope, nodeId); const candidates = new Map<string, ReadingAssociation>();
	// Already-read vault evidence is useful provenance; it is not a similarity judgment.
	for (const node of nodes) for (const evidence of node.evidence) {
		signal.throwIfAborted(); if (evidence.kind !== "vault" || !safeRelatedPath(evidence.path) || candidates.has(evidence.path) || candidates.size >= 10) continue;
		const file = app.vault.getFileByPath(evidence.path); if (!file) continue;
		const raw = await app.vault.cachedRead(file); const hash = contentHash(raw);
		// Older sessions did not store a file hash. Do not label their text as verified current evidence.
		if (!evidence.sourceHash || hash !== evidence.sourceHash) continue;
		candidates.set(evidence.path, { path: evidence.path, title: evidence.label, hash, reason: "本次回答已读取", heading: evidence.heading || "", excerpt: evidence.text.slice(0, 1800), role: evidence.role || "知识库补充", origins: evidence.origins || [] });
	}
	const sample = nodes.length <= 6 ? nodes : [...nodes.slice(0, 3), ...nodes.slice(-3)];
	// Keep the query topical: long generated answers and prompt boilerplate can dominate reranking.
	const query = session.title.slice(0, 300) + "\n" + sample.map(node => node.title.trim() || node.question.slice(0, 80)).join("；").slice(0, 600);
	// Association is an explicit cross-note operation, rather than a paper-specific factual answer.
	const result = await search(query, { signal, identityQuery: "跨论文关联笔记", limit: 6 }); signal.throwIfAborted();
	for (const hit of result.hits) {
		if (!safeRelatedPath(hit.path) || candidates.has(hit.path)) continue;
		candidates.set(hit.path, { path: hit.path, title: hit.title, hash: hit.hash, reason: "主题可能相关", heading: hit.heading, excerpt: hit.text, role: ROLE_LABELS[hit.role], origins: hit.origins });
	}
	return { candidates: [...candidates.values()], warnings: [...result.warnings, ...(nodes.length > 6 ? ["关联检索使用论文标题和前后各三个节点的主题；完整导出内容仍包括所有选定回答。"] : [])] };
}
export function exportBodyText(text: string): string { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, "").replace(/^上一版：[^\n]*\n\s*/, ""); }
/** A bounded changed region, not an O(n²) diff for a 300-node session. */
export function readingExportDiff(before: string, after: string): { added: number; removed: number; lines: string; omitted: boolean } {
	const a = exportBodyText(before).split("\n"); const b = exportBodyText(after).split("\n"); let start = 0; let suffix = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	while (suffix < a.length - start && suffix < b.length - start && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
	const removed = a.slice(start, a.length - suffix); const added = b.slice(start, b.length - suffix);
	return { added: added.length, removed: removed.length, lines: [...removed.slice(0, 100).map(line => "− " + line), ...added.slice(0, 100).map(line => "+ " + line)].join("\n"), omitted: removed.length > 100 || added.length > 100 };
}
