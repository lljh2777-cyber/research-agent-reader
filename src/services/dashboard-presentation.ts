import type { TaskRun, VaultRecord } from "../types/contracts";

/** Explicit depth wins over legacy workflow status or tags. No note is rewritten. */
export function dashboardPaperDepth(record: Pick<VaultRecord, "frontmatter" | "tags">): "metadata-only" | "abstract-level" | "x-ray" {
	for (const value of [record.frontmatter.depth, record.frontmatter.analysis_depth, record.frontmatter.status]) {
		const depth = String(value || "").trim().toLowerCase();
		if (depth === "x-ray" || depth === "xray") return "x-ray";
		if (depth === "abstract-level" || depth === "metadata-only") return depth;
	}
	return record.tags.some(tag => ["x-ray", "xray"].includes(tag.toLowerCase())) ? "x-ray" : "metadata-only";
}

export function dashboardRunPriority(status: string): number {
	return ["running", "queued", "pending"].includes(status) ? 0 : ["failed", "interrupted"].includes(status) ? 1 : 2;
}

export function dashboardTaskTitle(run: TaskRun, records: Map<string, VaultRecord>): string {
	const wiki = run.artifacts?.wikiPath;
	const note = wiki ? records.get(wiki.replace(/\\/g, "/")) : undefined;
	if (note) return String(note.frontmatter.title || note.name);
	const summary = (run.summary || run.label).trim().split(/\r?\n/)[0].replace(/^["']|["']$/g, "");
	if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|(?:wiki|papers)\/)/.test(summary)) {
		const parts = summary.replace(/\\/g, "/").split("/"); const name = parts.pop() || "";
		if (/^(?:article\.md|source\.pdf)$/i.test(name)) { const folder = parts.pop(); return (folder === "_extraction" ? parts.pop() : folder) || name; }
		return name.replace(/\.(?:pdf|md)$/i, "");
	}
	return summary || run.label;
}
