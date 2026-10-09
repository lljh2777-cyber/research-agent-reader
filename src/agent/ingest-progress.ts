import type { PaperIngestFlowOptions } from "./paper-ingest-flow";
import type { TaskRun } from "../types/contracts";

export const INGEST_STAGES = {
	prepare: "读取 PDF", identity: "核验与去重", confirm: "确认身份",
	extract: "解析原文", draft: "整理笔记", save: "保存结果", cli: "CLI 执行",
};
export type IngestStage = keyof typeof INGEST_STAGES;
export interface IngestProgress {
	steps: IngestStage[];
	stage: IngestStage;
	detail: string;
	waiting: boolean;
}
export function ingestSteps(options: Pick<PaperIngestFlowOptions, "createArticleMarkdown" | "createArticleWiki">): IngestStage[] {
	return ["prepare", "identity", "confirm", ...(options.createArticleMarkdown ? ["extract" as const] : []), ...(options.createArticleWiki ? ["draft" as const] : []), "save"];
}
export function normalizeIngestProgress(value: unknown): IngestProgress | undefined {
	if (!value || typeof value !== "object") return undefined;
	const p = value as IngestProgress;
	if (!Array.isArray(p.steps) || !p.steps.length || p.steps.length > 6
		|| p.steps.some(s => !Object.prototype.hasOwnProperty.call(INGEST_STAGES, s)) || new Set(p.steps).size !== p.steps.length
		|| !p.steps.includes(p.stage)) return undefined;
	const order = Object.keys(INGEST_STAGES);
	if (p.steps.includes("cli") && p.steps.length !== 1 || p.steps.some((s, i) => i > 0 && order.indexOf(s) <= order.indexOf(p.steps[i - 1]))) return undefined;
	return { steps: [...p.steps], stage: p.stage, detail: String(p.detail || "").slice(0, 240), waiting: p.waiting === true };
}
export function ingestProgressDisplay(run: TaskRun) {
	const p = run.ingestProgress;
	if (!p) return null;
	const active = run.status === "running" || run.status === "queued";
	const index = p.steps.indexOf(p.stage), total = p.steps.length;
	const status = active ? p.waiting ? "等待你的确认" : "正在入库" : run.status === "done" ? "入库完成" : run.status === "interrupted" ? "入库已中断" : "入库未完成";
	const stage = INGEST_STAGES[p.stage];
	return { active, index, total, status, stage, waiting: active && p.waiting,
		value: run.status === "done" ? total : index,
		indeterminate: active && p.stage === "cli",
		detail: active ? p.detail : run.status === "done" ? "所选输出已完成或复用，可在任务结果中打开。" : run.error || p.detail,
		position: p.stage === "cli" ? "由 CLI 回报状态" : run.status === "done" ? `${total} / ${total} 阶段` : `第 ${index + 1} / ${total} 阶段 · ${stage}`,
	};
}
