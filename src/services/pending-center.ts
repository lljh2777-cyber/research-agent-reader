import { acquisitionActive, decodeJob, PHASE_LABELS, type AcquisitionJob } from "../fulltext/contracts";
import type { AcquisitionStorage } from "../fulltext/repository";
import type { ExcerptList, ExcerptRef } from "../annotations/excerpt-library";
import type { LibraryReadResult } from "../library/reader";
import type { LibraryObjectRef } from "../library/types";
import type { LocalPdfHistory } from "../papers/local-pdf-intake";
import type { TaskRun } from "../types/contracts";
import type { SavedCurationPending } from "./dashboard-curation";
import type { AnswerExcerptPendingList } from "../learning/answer-excerpt-pending";
import { objectDigest, identityRelation } from "../papers/identity";

export const PENDING_CATEGORIES = { metadata: "书目与全文", acquisition: "获取与保存", intake: "入库与转换", excerpt: "摘录待整理", learning: "学习摘录", review: "审阅与复查" } as const;
export type PendingCategory = keyof typeof PENDING_CATEGORIES;
export type PendingTarget = { kind: "library"; object: LibraryObjectRef } | { kind: "excerpt"; ref: ExcerptRef }
	| { kind: "answer-excerpt"; path: string }
	| { kind: "acquisition" | "local" | "task" | "review" | "revision"; id: string };
export interface PendingItem { key: string; category: PendingCategory; title: string; detail: string; next: string; location: string; target: PendingTarget; revision: string; }
export interface PendingResult { items: PendingItem[]; issues: string[]; scannedAt: string; }
export interface PendingInputs {
	library(signal: AbortSignal): Promise<LibraryReadResult>;
	acquisitions: Pick<AcquisitionStorage, "listJobs" | "readJob">;
	local(signal: AbortSignal): Promise<LocalPdfHistory[]>;
	excerpts(signal: AbortSignal): Promise<ExcerptList>;
	curation(signal: AbortSignal): Promise<{ entries: SavedCurationPending[]; issues: string[] }>;
	tasks(): TaskRun[];
	answerExcerpts?(signal: AbortSignal): Promise<AnswerExcerptPendingList>;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function readPendingAcquisitions(io: PendingInputs["acquisitions"], signal: AbortSignal): Promise<{ jobs: AcquisitionJob[]; issues: string[] }> {
	const jobs: AcquisitionJob[] = [], issues: string[] = []; signal.throwIfAborted();
	const ids = [...new Set(await io.listJobs())].sort();
	if (ids.length > 256) issues.push("全文获取超过 256 条，本次仅展示前 256 条记录的待处理状态。");
	for (const id of ids.slice(0, 256)) {
		signal.throwIfAborted();
		try { const job = decodeJob(await io.readJob(id), "production"); if (job.id !== id) throw new Error("文件与获取记录 ID 不一致"); jobs.push(job); }
		catch (error) { signal.throwIfAborted(); issues.push(`${id}：${message(error)}`); }
	}
	signal.throwIfAborted(); return { jobs, issues };
}

/** Parallel read adapters are isolated: one failed area never reports an empty, complete center. */
export async function readPendingCenter(inputs: PendingInputs, signal: AbortSignal): Promise<PendingResult> {
	signal.throwIfAborted();
	const [library, acquisition, local, excerpts, curation, tasks, answers] = await Promise.allSettled([
		Promise.resolve().then(() => inputs.library(signal)), readPendingAcquisitions(inputs.acquisitions, signal), Promise.resolve().then(() => inputs.local(signal)), Promise.resolve().then(() => inputs.excerpts(signal)), Promise.resolve().then(() => inputs.curation(signal)), Promise.resolve().then(() => inputs.tasks()),
		Promise.resolve().then(() => inputs.answerExcerpts?.(signal) || { entries: [], issues: [] }),
	]);
	signal.throwIfAborted();
	const result: PendingResult = { items: [], issues: [], scannedAt: new Date().toISOString() };
	const add = (key: string, category: PendingCategory, title: string, detail: string, next: string, location: string, target: PendingTarget, proof: unknown) => {
		result.items.push({ key, category, title, detail, next, location, target, revision: objectDigest({ target, proof }) });
	};
	const labels = ["文献库", "全文获取", "本地添加", "摘录", "知识整理", "入库任务", "学习摘录"];
	[library, acquisition, local, excerpts, curation, tasks, answers].forEach((entry, i) => { if (entry.status === "rejected") result.issues.push(labels[i] + "读取失败：" + message(entry.reason)); });
	const data = library.status === "fulfilled" ? library.value : undefined;
	const objects = data?.papers.flatMap(p => p.objects) || [];
	const bindings = new Map(objects.filter(o => o.kind === "annotation").map(o => [o.id, o.binding]));
	const knownPackages = data?.papers.filter(p => p.association === "identified").flatMap(p => p.objects).filter(o => o.source?.saved && o.source.verification.state === "verified") || [];
	if (data) {
		result.issues.push(...data.readIssues.map(issue => `${issue.path}：${issue.message}`));
		if (!data.complete) result.issues.push("文献库读取不完整，未推断全文或转换正文的缺口。");
		const seen = new Set<string>();
		for (const paper of data.papers) for (const item of paper.objects) {
			const key = `library:${item.kind}:${item.id}`; if (seen.has(key)) continue; seen.add(key);
			const target: PendingTarget = { kind: "library", object: { kind: item.kind, id: item.id } };
			const proof = { paperId: paper.paperId || null, association: paper.association, identifiers: paper.identifiers, item };
			const location = item.source?.path || item.annotationPath || item.reading?.source.path || item.id;
			if (paper.association === "conflict") { add(key, "review", item.title, "文献关联存在冲突，请在详情中核对。", "查看文献详情", location, target, proof); continue; }
			if (item.kind === "record" && item.manualBibliography) add(key, "metadata", item.title, "人工书目信息尚未核验。", "查看书目信息", location, target, proof);
			else if (item.kind === "record" && item.bibliography && data.complete && !paper.objects.some(o => o.source?.saved)) add(key, "metadata", item.title, "本次完整扫描未发现已保存的原文，可补充全文。", "查看书目信息", location, target, proof);
			else if (item.source && ["missing", "invalid"].includes(item.source.verification.state)) add(key, "review", item.title, item.source.verification.state === "missing" ? "原文缺失，需要核对来源。" : "原文未通过当前核验，需要复查。", "查看来源详情", location, target, proof);
			else if (item.source?.format === "pdf" && item.source.saved && item.source.verification.state === "verified" && data.complete
				&& !paper.objects.some(o => o.source?.pdfOrigin?.state === "matched" && o.source.pdfOrigin.sourceIds.includes(item.id))) add(key, "intake", item.title, "本次扫描未发现与此 PDF 关联的转换正文，可在原文详情核对处理选项。", "查看原文处理选项", location, target, proof);
			else if (item.kind === "note" && item.noteReview?.state !== "reviewed") add(key, "review", item.title, item.noteReview?.state === "stale" ? "笔记内容在上次审阅后发生变化。" : "论文笔记尚未标记人工审阅。", "查看笔记详情", location, target, proof);
			else if (item.kind !== "annotation" && item.binding && item.binding.state !== "matched") add(key, "review", item.title, item.binding.reason, "查看来源关联", location, target, proof);
		}
	}
	if (acquisition.status === "fulfilled") {
		result.issues.push(...acquisition.value.issues);
		for (const job of acquisition.value.jobs) {
			const identity = job.identity?.identifiers || job.confirmedIdentity?.identifiers || { [job.request.input.kind]: job.request.input.value };
			if (job.phase === "acquired" && job.sourcePackages?.length && job.sourcePackages.every(key => {
				const matches = knownPackages.filter(o => o.source!.packageKey === key);
				return matches.length === 1 && identityRelation(identity, matches[0].identifiers) === "same";
			})) continue;
			const detail = job.phase === "acquired" ? job.sourcePackages?.length ? "获取记录已有保存路径，本次未能确认原文包状态，请核对保存与登记。" : "下载结果已获取，请核对原文保存或登记状态。"
				: acquisitionActive(job.phase) ? `获取记录标记为“${PHASE_LABELS[job.phase]}”，请回到原功能查看当前状态。` : `全文获取：${PHASE_LABELS[job.phase]}。${job.error || job.detail}`;
			add("acquisition:" + job.id, "acquisition", job.identity?.title || job.request.input.value, detail, "查看全文获取记录", job.request.input.value, { kind: "acquisition", id: job.id }, job);
		}
	}
	if (local.status === "fulfilled") for (const item of local.value) {
		if (item.state === "saved") continue;
		if (item.state === "unavailable") { result.issues.push(`${item.id}：${item.error}`); continue; }
		add("local:" + item.id, "intake", item.title, "本地 PDF 已有保存操作记录，尚无完成凭据；请核对保存或登记。", "查看本地添加记录", item.fileName, { kind: "local", id: item.id }, item);
	}
	if (excerpts.status === "fulfilled") {
		result.issues.push(...excerpts.value.issues);
		for (const snapshot of excerpts.value.entries) {
			const r = snapshot.record;
			const binding = bindings.get(r.annotationPath + "#" + r.id);
			if (r.archiveStatus === "completed" && binding?.state === "matched") continue;
			const unresolvedCompletion = r.archiveStatus === "completed" && binding?.state !== "changed";
			add("excerpt:" + r.id, binding?.state === "changed" || unresolvedCompletion ? "review" : "excerpt", r.selectedText,
				binding?.state === "changed" ? "原文版本已变化，请核对历史摘录。" : unresolvedCompletion ? "摘录已标记整理完成，但当前原文无法核对，请复查来源。" : "摘录尚未标记整理完成，可回看原句、个人备注与整理历史。",
				"查看摘录", r.sourcePath, { kind: "excerpt", ref: { annotationPath: r.annotationPath, id: r.id } }, { digest: snapshot.digest, binding: binding || null });
		}
	}
	if (answers.status === "fulfilled") {
		result.issues.push(...answers.value.issues);
		for (const { file, source } of answers.value.entries) {
			const r = file.record;
			add("answer-excerpt:" + r.id, source.state === "matched" ? "learning" : "review", "学习摘录 · " + r.answer.title,
				(r.answer.ref.kind === "topic" ? "主题学习" : r.answer.context.kind === "code" ? "代码阅读" : "资料阅读") + " · AI 回答" + (r.humanRevision ? "与人工修订稿" : "") + "。" + (source.state === "matched" ? "尚未标记整理完成，可回看并编辑。" : source.message),
				"查看学习摘录", r.answer.context.location, { kind: "answer-excerpt", path: file.path }, { digest: file.digest, source });
		}
	}
	if (curation.status === "fulfilled") {
		result.issues.push(...curation.value.issues);
		for (const row of curation.value.entries) add(`${row.kind}:${row.id}`, "review", row.path, row.kind === "reviews" ? row.state === "ready" ? "整理建议仍有待审阅项。" : `整理批次标记为“${({ generating: "生成中", failed: "失败", interrupted: "中断", stale: "需复查" } as Record<string, string>)[row.state] || "需核对"}”，请查看保存记录。` : "修订记录标记需复查或恢复。", "查看知识整理记录", row.path, { kind: row.kind === "reviews" ? "review" : "revision", id: row.id }, row.digest);
	}
	if (tasks.status === "fulfilled") {
		if (tasks.value.length > 1000) result.issues.push("任务超过 1000 条，仅展示前 1000 条记录中的未完成入库任务。");
		for (const run of tasks.value.slice(0, 1000)) if (run.actionId === "paper-ingest" && ["queued", "running", "failed", "interrupted"].includes(run.status)) {
			add("task:" + run.id, "intake", run.label || "文献入库", `入库任务${({ queued: "等待执行", running: "记录为进行中", failed: "未完成", interrupted: "已中断" } as Record<string, string>)[run.status]}，请查看进度和已有结果。`, "查看入库任务", run.summary, { kind: "task", id: run.id }, { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, progress: run.ingestProgress || null });
		}
	}
	const duplicates = new Set<string>(), seen = new Set<string>();
	for (const item of result.items) { if (seen.has(item.key)) duplicates.add(item.key); seen.add(item.key); }
	if (duplicates.size) result.issues.push("发现重复待处理标识，相关项未选择任一版本，请回到原功能核对。");
	const stages = Object.keys(PENDING_CATEGORIES);
	result.items = result.items.filter(item => !duplicates.has(item.key)).sort((a, b) => stages.indexOf(a.category) - stages.indexOf(b.category) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
	if (result.items.length > 5000) { result.issues.push("待处理项超过 5000 条，本次仅保留前 5000 条。"); result.items = result.items.slice(0, 5000); }
	return result;
}

/** Re-read at navigation time. Never reuse a stale destination or silently choose a similar object. */
export function pendingDestination(expected: PendingItem, fresh: PendingResult): PendingTarget {
	const matches = fresh.items.filter(item => item.key === expected.key);
	if (matches.length !== 1 || matches[0].revision !== expected.revision || objectDigest(matches[0].target) !== objectDigest(expected.target)) throw new Error("这条待处理记录已变化、完成或暂时无法读取，请刷新后重新选择");
	return structuredClone(matches[0].target);
}

export function filterPending(items: PendingItem[], query: string, category = "all"): PendingItem[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return items.filter(item => (category === "all" || item.category === category) && terms.every(term => [item.title, item.detail, item.location].join("\n").toLocaleLowerCase().includes(term)));
}
