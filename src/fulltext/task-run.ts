import type { TaskRun } from "../types/contracts";
import { acquisitionActive, PHASE_LABELS, type AcquisitionJob } from "./contracts";

/** Read-only projection; acquisition records are not subject to the dashboard output-retention policy. */
export function acquisitionTaskRun(job: AcquisitionJob): TaskRun {
	if (job.mode !== "production") throw new Error("演示记录不能进入正式任务历史");
	return {
		id: job.id, actionId: "fulltext-acquisition", label: "获取全文", agent: "fulltext-acquisition-service", summary: job.request.input.value, executionConfig: null,
		status: acquisitionActive(job.phase) ? (job.phase === "queued" ? "queued" : "running") : job.phase === "acquired" ? "done" : ["interrupted", "cancelled"].includes(job.phase) ? "interrupted" : "failed",
		startedAt: job.createdAt, finishedAt: acquisitionActive(job.phase) ? "" : job.updatedAt, exitCode: job.phase === "acquired" ? 0 : null,
		output: PHASE_LABELS[job.phase] + "\n" + job.detail, error: job.error || job.storageWarning || "",
	};
}
