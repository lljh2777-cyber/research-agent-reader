import type { LibraryPaper } from "./types";

export interface LibraryCodeLink { path: string; notePath: string; direction: "from-paper" | "to-paper"; kind: "code-note" | "code-export"; }
export interface LibraryCodeLinks { byPaper: Record<string, LibraryCodeLink[]>; issues: string[]; }
export interface CodeLinkFile { path: string; codeExport?: boolean; }
const safe = (p: string) => p.endsWith(".md") && !/[\\:\x00-\x1f]/.test(p) && p.split("/").every(s => s && s !== "." && s !== "..");
/** Navigation from Obsidian's resolved-link snapshot, not paper identity or scientific evidence. */
export function libraryCodeLinks(papers: LibraryPaper[], files: CodeLinkFile[], links: Record<string, Record<string, number>> | undefined): LibraryCodeLinks {
	const result: LibraryCodeLinks = { byPaper: Object.create(null), issues: [] };
	if (!links) { result.issues.push("Obsidian 链接缓存尚不可用，请稍后刷新文献库。"); return result; }
	const existing = new Set(files.filter(f => safe(f.path)).map(f => f.path));
	const codes = new Map(files.filter(f => safe(f.path) && (/^wiki\/code\/(projects|scripts)\/.+\.md$/.test(f.path) || f.path.startsWith("wiki/qa/") && f.codeExport)).map(f => [f.path, f.path.startsWith("wiki/qa/") ? "code-export" as const : "code-note" as const]));
	const owners = new Map<string, string[]>();
	for (const paper of papers) {
		result.byPaper[paper.key] = [];
		if (paper.association === "conflict") continue;
		for (const note of paper.objects.filter(o => o.kind === "note" && existing.has(o.id))) owners.set(note.id, [...(owners.get(note.id) || []), paper.key]);
	}
	let count = 0;
	for (const [from, targets] of Object.entries(links)) {
		if (!owners.has(from) && !codes.has(from)) continue;
		for (const [to, occurrences] of Object.entries(targets)) {
			if (++count > 50000) { result.issues.push("代码关联达到链接读取上限，仅显示已检查的部分。"); return result; }
			if (!(occurrences > 0) || !existing.has(to)) continue;
			const notePath = owners.has(from) && codes.has(to) ? from : codes.has(from) && owners.has(to) ? to : "";
			if (!notePath) continue;
			const path = notePath === from ? to : from;
			for (const key of owners.get(notePath)!) result.byPaper[key].push({ path, notePath, direction: notePath === from ? "from-paper" : "to-paper", kind: codes.get(path)! });
		}
	}
	for (const rows of Object.values(result.byPaper)) rows.sort((a, b) => a.path.localeCompare(b.path) || a.notePath.localeCompare(b.notePath) || a.direction.localeCompare(b.direction));
	return result;
}
export function codeLinkStillPresent(expected: LibraryCodeLink, current: LibraryCodeLink[]): boolean {
	return current.some(row => row.path === expected.path && row.notePath === expected.notePath && row.direction === expected.direction && row.kind === expected.kind);
}
