import type { SourceStorage } from "../sources/storage";
import { curationTarget } from "../curation/policy";

export interface CurationNavigation { tab?: "pending" | "stale" | "history" | "indices" | "activity"; revisionId?: string; }
export interface DashboardCurationSummary {
	pending: number; revisit: number; generating: number; unfinished: number;
	recent: Array<{ id: string; path: string; updated: string; label: string }>;
	issues: string[];
}
export const emptyCurationSummary = (): DashboardCurationSummary => ({ pending: 0, revisit: 0, generating: 0, unfinished: 0, recent: [], issues: [] });
const ID = /^c-[a-f0-9-]{36}$/;
/** Read saved metadata only. Never initialize CurationService or recover unfinished writes. */
export async function readDashboardCuration(io: Pick<SourceStorage, "read" | "list">): Promise<DashboardCurationSummary> {
	const result = emptyCurationSummary(); let files = 0, bytes = 0;
	for (const kind of ["reviews", "revisions"] as const) {
		const directory = "knowledge-reviews/" + kind;
		try {
			const entries = await io.list(directory);
			if (entries.some(e => e.name.endsWith(".pending"))) result.issues.push("有未完成的临时写入，未计入保存记录。");
			for (const entry of entries.filter(e => !e.directory && e.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
				if (++files > 256 || bytes >= 64 * 1024 * 1024) { result.issues.push("整理摘要达到读取上限，仅统计已读取记录。"); break; }
				try {
					const id = entry.name.slice(0, -5); if (!ID.test(id)) throw new Error("记录文件名无效");
					const raw = await io.read(directory + "/" + entry.name, Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - bytes));
					if (!raw) throw new Error("记录在读取时缺失"); bytes += raw.byteLength;
					const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
					if (record?.version !== 1 || record.id !== id || typeof record.updated !== "string" || !Number.isFinite(Date.parse(record.updated))) throw new Error("记录身份或时间无效");
					if (kind === "reviews") {
						if (!curationTarget(record.context?.target?.path || "") || !Array.isArray(record.suggestions) || !record.suggestions.every((s: { decision?: string } | null) => s && ["pending", "ignored", "applied"].includes(s.decision || ""))) throw new Error("整理摘要字段无效");
						if (record.state === "ready") { if (record.suggestions.some((s: { decision: string }) => s.decision === "pending")) result.pending++; }
						else if (["failed", "interrupted", "stale"].includes(record.state)) result.revisit++;
						else if (record.state === "generating") result.generating++;
						else throw new Error("未知整理状态");
					} else {
						if (!["prepared", "applying", "applied", "recovery"].includes(record.state) || !Array.isArray(record.writes)) throw new Error("修订摘要字段无效");
						const target = record.writes.filter((w: { role?: string } | null) => w?.role === "target");
						if (target.length !== 1 || !curationTarget(target[0].path)) throw new Error("修订目标无效");
						if (record.state !== "applied" || record.needsReview) result.unfinished++;
						result.recent.push({ id, path: target[0].path, updated: record.updated, label: record.state !== "applied" ? "等待核对／恢复" : record.needsReview ? "记录标记需复查" : record.undoOf ? "撤销修订已保存" : "记录标记已应用" });
					}
				} catch (error) { result.issues.push(`${kind}/${entry.name}：${error instanceof Error ? error.message : String(error)}`); }
			}
		} catch (error) { result.issues.push(`${directory}：${error instanceof Error ? error.message : String(error)}`); }
	}
	result.recent.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated) || a.id.localeCompare(b.id)); result.recent = result.recent.slice(0, 3);
	return result;
}
