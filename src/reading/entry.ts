import { readingCategory, readingTitle, sourceReadingDomain, type ReadingDomain } from "./catalog";
import type { ReadingSession, ReadingSource } from "./types";

export interface ReadingEntry { domain?: ReadingDomain; source?: Pick<ReadingSource, "kind" | "path">; backend?: string; sessionId?: string; }
/** Old saved layouts only have a session ID. Its source remains authoritative. */
export function readingEntryDomain(entry: ReadingEntry | undefined, sessions: Iterable<ReadingSession>): ReadingDomain {
	const session = entry?.sessionId ? [...sessions].find(s => s.id === entry.sessionId) : undefined;
	return session ? sourceReadingDomain(session.source) : entry?.source ? sourceReadingDomain(entry.source) : entry?.domain === "code" ? "code" : "paper";
}

/** Dashboard reflects saved reading work, independent of CLI task status. */
export function readingDashboardState(sessions: Iterable<ReadingSession>, kind: "paper" | "code" = "paper"): { sessionId: string; title: string; label: string; running: boolean } {
	const active = [...sessions].filter(s => !s.demo && readingCategory(s) === "reading" && !s.archived && (kind === "code" ? s.source.kind === "code" : s.source.kind !== "code"));
	const running = (s: ReadingSession) => s.nodes.some(n => n.status === "running" || n.status === "pending");
	active.sort((a, b) => Number(running(b)) - Number(running(a)) || (b.lastOpenedAt || b.updatedAt).localeCompare(a.lastOpenedAt || a.updatedAt));
	const session = active[0];
	if (!session) return { sessionId: "", title: "", label: kind === "code" ? "打开代码开始阅读" : "打开论文开始阅读", running: false };
	const done = session.nodes.filter(n => !n.branchId && n.status === "done").length;
	const failed = session.nodes.some(n => n.status === "failed" || n.status === "interrupted");
	return { sessionId: session.id, title: readingTitle(session), running: running(session),
		label: `${running(session) ? "生成中" : failed ? "有待重试回答" : session.completed ? "主线已讲完" : "继续阅读"} · ${done}${session.outline.length ? "/" + session.outline.length : ""} 单元` };
}
