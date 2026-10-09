import type { App } from "obsidian";
import type { CurationService } from "../curation/service";
import type { CurationReview, CurationRevision } from "../curation/types";
import type { ReadingSession } from "./types";
import { readingNodeContentHash } from "./export";
export interface ReadingOutcome { label: string; path: string; reviewId?: string; }
export function curationNodeOutcomes(sessionId: string, nodeId: string, reviews: Iterable<CurationReview>, revisions: Iterable<CurationRevision>): ReadingOutcome[] {
	const records = [...revisions]; const undone = new Set(records.filter(r => r.state === "applied" && r.undoOf).map(r => r.undoOf));
	return [...reviews].filter(r => r.context.sessionId === sessionId && r.context.nodeIds.includes(nodeId)).flatMap(review => {
		const writes = records.filter(r => r.reviewId === review.id && !r.undoOf); const active = writes.filter(r => r.state === "applied" && !undone.has(r.id));
		const states = new Set<string>();
		if (active.length) states.add(active.some(r => r.needsReview) ? "需复查" : "已采纳");
		if (writes.some(r => r.state !== "applied") || records.some(r => r.reviewId === review.id && r.undoOf && r.state !== "applied")) states.add("待恢复");
		if (writes.length && !active.length && writes.every(r => undone.has(r.id))) states.add("已撤销");
		if (review.state === "stale") states.add("需复查");
		if (review.state === "ready" && review.suggestions.some(s => s.decision === "pending")) states.add("待审阅");
		if (["failed", "interrupted"].includes(review.state)) states.add("整理需重试");
		if (review.state === "generating") states.add("整理中");
		return [...states].map(label => ({ label, path: review.context.target.path, reviewId: review.id }));
	});
}
export function exportedNodes(text: string, session: ReadingSession): { id: string; label: string }[] {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]; if (!fm) return [];
	try {
		const id = JSON.parse(/^reading_session: (.+)$/m.exec(fm)?.[1] || "null"); if (id !== session.id) return [];
		const nodes = JSON.parse(/^reading_nodes: (.+)$/m.exec(fm)?.[1] || "null"); if (!Array.isArray(nodes)) return [];
		return nodes.flatMap(ref => { const node = session.nodes.find(n => n.id === ref?.id); return node ? [{ id: node.id, label: ref.hash ? ref.hash === readingNodeContentHash(node) ? "已导出" : "已导出旧版" : "已导出（旧记录）" }] : []; });
	} catch { return []; }
}
export async function readReadingOutcomes(app: App, session: ReadingSession, service: CurationService): Promise<Map<string, ReadingOutcome[]>> {
	await service.ready(); const result = new Map(session.nodes.map(node => [node.id, curationNodeOutcomes(session.id, node.id, service.reviews.values(), service.revisions.values())]));
	for (const file of app.vault.getMarkdownFiles().filter(f => f.path.startsWith("wiki/qa/"))) {
		const metadata = app.metadataCache.getFileCache(file)?.frontmatter;
		if (metadata?.reading_session && metadata.reading_session !== session.id) continue;
		for (const ref of exportedNodes(await app.vault.cachedRead(file), session)) result.get(ref.id)!.push({ label: ref.label, path: file.path });
	}
	return result;
}
