import type { ReadingResult, ReadingSession, ReadingTeachingStyle } from "./types";
export const TEACHING_STYLES: Record<ReadingTeachingStyle, string> = { balanced: "均衡讲解", foundations: "基础解释", methods: "方法细节", evidence: "结果与证据" };
export function teachingPreference(session: ReadingSession): string {
	return ({ balanced: "兼顾研究问题、方法、结果和限制", foundations: "先解释必要的术语与前置知识，使用简短例子；背景与论文事实分开", methods: "重点说明方法的输入输出、步骤、假设、对照与可复现细节", evidence: "重点说明结果、图表、对照、证据强度与结论适用条件" })[session.teachingStyle || "balanced"];
}
export function stableReadingResult(session: ReadingSession, result: ReadingResult): ReadingResult {
	const done = session.mainIds.map(id => session.nodes.find(n => n.id === id)!).filter(n => n.status === "done");
	const normalize = (text: string) => text.replace(/[\s\p{P}]/gu, "").toLocaleLowerCase();
	const outline = session.outline.length ? session.outline : result.outline!;
	if (new Set(outline.map(normalize)).size !== outline.length) throw new Error("主线提纲包含重复单元，请重试");
	if (session.outline.length && JSON.stringify(result.outline) !== JSON.stringify(session.outline)) throw new Error("模型改动了已确定的阅读路线，请重试当前单元");
	if (done.some(n => normalize(n.title) === normalize(result.title) || normalize(n.content) === normalize(result.content))) throw new Error("本次讲解与已有主线重复，请重试当前单元");
	// Older sessions may have generated units before an outline was available.
	if (session.outline.length && done.length >= outline.length) throw new Error("现有主线已覆盖提纲，可从已有节点继续追问");
	return { ...result, outline, completed: done.length + 1 >= outline.length };
}
