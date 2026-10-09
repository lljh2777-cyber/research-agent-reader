import type { SourceStorage } from "../sources/storage";
import { objectDigest, bytesDigest } from "../papers/identity";
import { validatedReview } from "../curation/service";
import { validateCurationRevision } from "../curation/writer";
import type { CurationReview, CurationRevision } from "../curation/types";
import type { ExcerptRef } from "./excerpt-library";

export interface ExcerptHistoryEntry {
	id: string; kind: "review" | "revision"; revision: string; path: string; updated: string;
	label: string; detail: string; excerptDigest: string; before?: string; after?: string;
}
export interface ExcerptHistory { entries: ExcerptHistoryEntry[]; issues: string[]; }
export interface ExcerptHistoryHost {
	read(ref: ExcerptRef, signal: AbortSignal): Promise<ExcerptHistory>;
	open(ref: ExcerptRef, entry: ExcerptHistoryEntry, signal: AbortSignal): Promise<void>;
}
const ID = /^c-[a-f0-9-]{36}$/;
const matches = (review: CurationReview, ref: ExcerptRef): boolean => review.context.excerpt?.snapshot.record.id === ref.id && review.context.excerpt.snapshot.record.annotationPath === ref.annotationPath;

/** Inspect immutable saved payloads only; no stores, services or recovery are initialized. */
export async function readExcerptHistory(io: Pick<SourceStorage, "read" | "list">, ref: ExcerptRef, signal?: AbortSignal): Promise<ExcerptHistory> {
	ref = { ...ref };
	if (!/^ann-excerpt-[a-f0-9]{48}$/.test(ref.id) || ref.annotationPath !== `wiki/annotations/${ref.id}.md`) throw new Error("摘录历史标识无效");
	const result: ExcerptHistory = { entries: [], issues: [] };
	const reviews = new Map<string, CurationReview>(), revisions = new Map<string, CurationRevision>(), hashes = new Map<string, string>();
	let files = 0, bytes = 0;
	for (const kind of ["reviews", "revisions"] as const) {
		signal?.throwIfAborted(); const directory = "knowledge-reviews/" + kind;
		try {
			const listed = await io.list(directory); signal?.throwIfAborted();
			if (listed.some(e => e.name.endsWith(".pending"))) result.issues.push("发现未完成的临时记录，历史只显示已保存内容。");
			const names = listed.filter(e => !e.directory && e.name.endsWith(".json")).map(e => e.name).sort();
			const duplicates = new Set(names.filter((name, i) => i > 0 && name === names[i - 1]));
			if (duplicates.size) result.issues.push("整理记录出现重复标识，相关历史未选择任一版本。");
			for (const name of names) {
				signal?.throwIfAborted();
				if (++files > 256 || bytes >= 64 * 1024 * 1024) { result.issues.push("历史达到读取上限，不能据此判断未显示的整理或撤销是否存在。"); break; }
				if (duplicates.has(name)) continue;
				try {
					const id = name.slice(0, -5); if (!ID.test(id)) throw new Error("文件标识无效");
					const limit = Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - bytes), raw = await io.read(directory + "/" + name, limit); signal?.throwIfAborted();
					if (!raw) throw new Error("记录缺失"); bytes += raw.byteLength;
					if (raw.byteLength > limit) throw new Error("记录超过读取上限");
					const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
					if (record?.version !== 1 || record.id !== id || ![record.created, record.updated].every(t => typeof t === "string" && Number.isFinite(Date.parse(t)))) throw new Error("记录身份或时间无效");
					if (kind === "reviews") {
						if (!record.context?.excerpt) continue;
						const review = validatedReview(record);
						if (!matches(review, ref)) continue;
						reviews.set(id, review);
					} else {
						if (!reviews.has(record.reviewId)) continue;
						if (!["prepared", "applying", "applied", "recovery"].includes(record.state) || typeof record.error !== "string" || record.undoOf !== undefined && (typeof record.undoOf !== "string" || !ID.test(record.undoOf))) throw new Error("修订状态无效");
						revisions.set(id, record);
					}
					hashes.set(kind + ":" + id, bytesDigest(raw));
				} catch (error) { signal?.throwIfAborted(); result.issues.push(directory + "/" + name + "：" + String(error)); }
			}
		} catch (error) { signal?.throwIfAborted(); result.issues.push(directory + "：" + String(error)); }
	}
	// Validate originals first. A malformed original cannot authenticate an undo.
	const valid = new Map<string, CurationRevision>();
	for (const undo of [false, true]) for (const revision of revisions.values()) {
		signal?.throwIfAborted(); if (Boolean(revision.undoOf) !== undo) continue;
		try { validateCurationRevision(revision, reviews, valid); valid.set(revision.id, revision); }
		catch (error) { result.issues.push(revision.id + "：" + String(error)); }
	}
	for (const review of reviews.values()) {
		const r = review.context.excerpt!.snapshot;
		result.entries.push({ id: review.id, kind: "review", path: review.context.target.path, updated: review.updated, revision: hashes.get("reviews:" + review.id)!, excerptDigest: r.digest,
			label: ({ ready: "已保存整理批次", stale: "批次需重新核对", failed: "批次失败", interrupted: "批次中断", generating: "记录为准备中" })[review.state],
			detail: (review.context.excerpt!.includeManual ? "原句与个人备注" : "仅原句") + "；批次记录本身不代表补充成功。" + (review.error || "") });
	}
	for (const revision of valid.values()) {
		const review = reviews.get(revision.reviewId)!, target = revision.writes.find(w => w.role === "target")!;
		const undos = [...valid.values()].filter(r => r.undoOf === revision.id);
		const undone = undos.some(r => r.state === "applied");
		const label = revision.state === "applied" ? revision.undoOf ? "已撤销补充" : undone ? "补充已撤销" : "已补充（历史记录）" : revision.undoOf ? "撤销未完成，需处理" : "补充未完成，需处理";
		result.entries.push({ id: revision.id, kind: "revision", path: target.path, updated: revision.updated, label, excerptDigest: review.context.excerpt!.snapshot.digest,
			revision: objectDigest({ review: hashes.get("reviews:" + review.id), revision: hashes.get("revisions:" + revision.id), undos: undos.map(r => hashes.get("revisions:" + r.id)).sort() }),
			detail: `批次 ${review.id}` + (revision.undoOf ? `；撤销修订 ${revision.undoOf}` : "") + (revision.error ? "；" + revision.error : "") + (revision.needsReview ? "；需复查：" + revision.needsReview : ""), before: target.before!, after: target.after });
	}
	result.entries.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
	return result;
}

export function excerptHistoryDestination(expected: ExcerptHistoryEntry, fresh: ExcerptHistory): string {
	const found = fresh.entries.filter(entry => entry.id === expected.id && entry.kind === expected.kind);
	if (found.length !== 1 || found[0].revision !== expected.revision || found[0].path !== expected.path) throw new Error("整理历史已变化或无法读取，请重新读取摘录详情后打开目标");
	return found[0].path;
}
