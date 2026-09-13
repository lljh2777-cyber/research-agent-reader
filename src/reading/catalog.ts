import type { ReadingSession, ReadingSource } from "./types";

export type ReadingCategory = "reading" | "demo" | "test";
export type ReadingDomain = "paper" | "code";
export const sourceReadingDomain = (source: Pick<ReadingSource, "kind">): ReadingDomain => source.kind === "code" ? "code" : "paper";
export function readingCategory(session: ReadingSession): ReadingCategory {
	if (session.purpose) return session.purpose;
	if (!session.demo) return "reading";
	// Legacy fixtures must have the mock source AND demo flag; titles alone never hide real papers.
	if (session.source.path === "demo://reading" && session.source.fingerprint === "0".repeat(64)
		&& /^(集成验收|长会话验收|界面验收|小窗验收)\s*·/.test(session.title)) return "test";
	return "demo";
}
export function readingTitle(session: ReadingSession): string {
	if (session.title.trim() && session.title.trim().toLowerCase() !== "source") return session.title;
	const parts = session.source.path.replace(/\\/g, "/").split("/");
	if (parts[parts.length - 1] === "source.pdf" && parts[parts.length - 2] === "_extraction") return (parts[parts.length - 3] || "未命名论文") + " · PDF";
	return parts[parts.length - 1] || "未命名阅读";
}
export function readingSourceKey(source: ReadingSource): string { return [source.kind, source.path.replace(/\\/g, "/"), source.fingerprint].join("|"); }
export function recentReading(sessions: Iterable<ReadingSession>, category: ReadingCategory = "reading", archived = false, domain?: ReadingDomain): ReadingSession[] {
	return [...sessions].filter((s) => readingCategory(s) === category && Boolean(s.archived) === archived && (!domain || sourceReadingDomain(s.source) === domain))
		.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.lastOpenedAt || b.updatedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.updatedAt || a.createdAt) || a.id.localeCompare(b.id));
}
export function latestReading(sessions: Iterable<ReadingSession>, domain: ReadingDomain): ReadingSession | undefined {
	return recentReading(sessions, "reading", false, domain).sort((a, b) => (b.lastOpenedAt || b.updatedAt || b.createdAt).localeCompare(a.lastOpenedAt || a.updatedAt || a.createdAt))[0];
}
export function matchingReading(sessions: Iterable<ReadingSession>, source: ReadingSource): ReadingSession | undefined {
	return recentReading(sessions).filter((s) => readingSourceKey(s.source) === readingSourceKey(source))
		.sort((a, b) => (b.lastOpenedAt || b.updatedAt).localeCompare(a.lastOpenedAt || a.updatedAt))[0];
}
