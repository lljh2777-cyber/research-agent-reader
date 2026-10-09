import { answerExcerptCompleted, type AnswerExcerptFile, type AnswerExcerptService, type AnswerExcerptSourceStatus } from "./answer-excerpts";

export interface AnswerExcerptPendingList { entries: Array<{ file: AnswerExcerptFile; source: AnswerExcerptSourceStatus }>; issues: string[]; }

/** Read-only work projection; completed work still needs review when its AI record changes. */
export async function readAnswerExcerptPending(service: Pick<AnswerExcerptService, "list" | "sourceStatus">, signal: AbortSignal): Promise<AnswerExcerptPendingList> {
	const files = await service.list(signal), result: AnswerExcerptPendingList = { entries: [], issues: [...files.issues] };
	const checked = new Map<string, AnswerExcerptSourceStatus>(); let limited = false;
	for (const file of files.entries) {
		signal.throwIfAborted(); const answer = file.record.answer; let source = checked.get(answer.digest);
		if (!source) {
			if (checked.size >= 100) { limited = true; source = { state: "unavailable", message: "本次已核对 100 个回答版本，其余记录请在学习摘录中单独核对。" }; }
			else { source = await service.sourceStatus(answer, signal); checked.set(answer.digest, source); }
		}
		signal.throwIfAborted(); if (answerExcerptCompleted(file.record) && source.state === "matched") continue;
		result.entries.push({ file, source });
	}
	if (limited) result.issues.push("学习摘录回答版本核对达到 100 个的上限，未核对项保留复查状态。");
	return result;
}
