import type { AgentLoopRunOutcome } from "./agent-loop-service";
import type { TaskRunUpdate } from "../types/contracts";

/** Initial intake and continuation must expose the same terminal state and reason. */
export function ingestTaskResult(outcome: AgentLoopRunOutcome): TaskRunUpdate {
	const status = outcome.exitCode === 0 ? "done" : outcome.loopStatus === "cancelled" ? "interrupted" : "failed";
	return {
		status,
		exitCode: outcome.exitCode,
		output: outcome.stdout,
		artifacts: outcome.artifacts,
		error: status === "failed"
			? outcome.result?.errors.find(Boolean)
				|| outcome.result?.conflicts.find(Boolean)
				|| outcome.stderr
				|| (outcome.result ? "轻量 Agent 未完成所选输出（详见输出）" : "轻量 Agent 未返回结构化结果")
			: status === "interrupted" ? "任务已手动停止" : "",
	};
}
