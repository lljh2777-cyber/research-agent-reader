import { randomUUID } from "node:crypto";
import type { ReadingBackend, ReadingBackendRequest, ReadingNode, ReadingSession, ReadingUsageEntry } from "./types";
import type { ReadingRepository } from "./store";
export const USAGE_STAGES = { planning: "规划路线", selection: "选择证据", answer: "生成讲解", memory: "压缩记忆" };
export const readingTokenEstimate = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
export async function measuredReadingCall(repository: ReadingRepository, sessionId: string, nodeId: string, stage: ReadingUsageEntry["stage"], backend: ReadingBackend, request: ReadingBackendRequest): Promise<string> {
	const entry: ReadingUsageEntry = { id: randomUUID(), stage, model: backend.name + " · " + backend.model, started: new Date().toISOString(), state: "running", estimatedInput: readingTokenEstimate(request.system + request.prompt) };
	await repository.transact(sessionId, s => { (s.nodes.find(n => n.id === nodeId)!.usage ||= []).push({ ...entry }); });
	try {
		const result = await backend.complete({ ...request, onUsage: usage => { for (const key of ["input", "output", "cachedInput"] as const) if (Number.isFinite(usage[key]) && usage[key]! >= 0) entry[key] = usage[key]; request.onUsage?.(usage); } });
		entry.state = request.signal.aborted ? "interrupted" : "done"; entry.estimatedOutput = readingTokenEstimate(result); return result;
	} catch (error) { entry.state = request.signal.aborted ? "interrupted" : "failed"; throw error; }
	finally { await repository.transact(sessionId, s => { const current = s.nodes.find(n => n.id === nodeId)!.usage!.find(e => e.id === entry.id)!; Object.assign(current, entry); }); }
}
export function readingUsageTotals(nodes: ReadingNode[]) {
	const entries = nodes.flatMap(n => n.usage || []); const calls = entries.filter(e => e.state !== "cached");
	return { calls: calls.length, cacheHits: entries.length - calls.length, unrecordedNodes: nodes.filter(n => n.status === "done" && !n.usage?.length).length,
		input: calls.reduce((sum, e) => sum + (e.input || 0), 0), output: calls.reduce((sum, e) => sum + (e.output || 0), 0), cachedInput: calls.reduce((sum, e) => sum + (e.cachedInput || 0), 0),
		unknownInput: calls.filter(e => e.input === undefined).length, unknownOutput: calls.filter(e => e.output === undefined).length,
		estimatedInput: calls.filter(e => e.input === undefined).reduce((sum, e) => sum + e.estimatedInput, 0) };
}
export function readingUsageSummary(session: Pick<ReadingSession, "nodes">): string {
	const t = readingUsageTotals(session.nodes);
	return `${t.calls} 次模型调用 · ${t.cacheHits} 次证据缓存复用\n接口已报告：输入 ${t.input} / 输出 ${t.output} token，缓存输入 ${t.cachedInput}（包含在输入中）\n未报告输入 ${t.unknownInput} 次（文字估算共约 ${t.estimatedInput} token），未报告输出 ${t.unknownOutput} 次\n${t.unrecordedNodes} 个旧回答没有用量记录。仅统计讲解模型；图像、推理和 CLI 附加上下文以接口计量为准，embedding/rerank 另计。`;
}
