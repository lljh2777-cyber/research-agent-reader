import type { ReadingNode, ReadingSession } from "./types";

/** Branch origins, excluding unrelated siblings and earlier turns in the same branch. */
export function readingTrail(session: ReadingSession, id: string): ReadingNode[] {
	const nodes = new Map(session.nodes.map((node) => [node.id, node]));
	const branches = new Map(session.branches.map((branch) => [branch.id, branch]));
	const trail: ReadingNode[] = []; const seen = new Set<string>(); let current = nodes.get(id);
	while (current && !seen.has(current.id)) {
		seen.add(current.id); trail.unshift(current);
		current = current.branchId ? nodes.get(branches.get(current.branchId)?.parentNodeId || "") : undefined;
	}
	return trail;
}

export function revealReadingPath(session: ReadingSession, id: string): void {
	const branches = new Set(readingTrail(session, id).map((node) => node.branchId));
	session.ui.collapsed = session.ui.collapsed.filter((branch) => !branches.has(branch));
}

export function searchReadingNodes(session: ReadingSession, query: string): ReadingNode[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return session.nodes;
	return session.nodes.filter((node) => {
		const text = [node.title, node.question, node.content].join("\n").toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	}).sort((a, b) => Number(terms.every((term) => b.title.toLocaleLowerCase().includes(term))) - Number(terms.every((term) => a.title.toLocaleLowerCase().includes(term))));
}

export function fitReadingZoom(width: number, height: number, viewportWidth: number, viewportHeight: number): { zoom: number; limited: boolean } {
	const scale = Math.min(1, Math.max(0, viewportWidth - 16) / width, Math.max(0, viewportHeight - 16) / height);
	return { zoom: Math.max(0.4, scale), limited: scale < 0.4 };
}
