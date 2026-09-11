import type { ReadingBackendRequest } from "../reading/types";
import { topicObject } from "./contracts";
import { studyContext, type TopicNodeSpec, type TopicStudy } from "./study";
import { STUDY_PROMPT_VERSION, topicTeachingRules, type TopicTeachingPromptVersion } from "./teaching-rules";

export const TOPIC_TEACHING_RULES = topicTeachingRules(STUDY_PROMPT_VERSION);
export const TOPIC_TEACHING_SCHEMA = { type: "object", additionalProperties: false, required: ["title", "content"], properties: { title: { type: "string" }, content: { type: "string" } } };
export function topicTeachingRequest(study: TopicStudy, spec: TopicNodeSpec, signal: AbortSignal, version: TopicTeachingPromptVersion = STUDY_PROMPT_VERSION): ReadingBackendRequest {
	const context = studyContext(study, spec.parentId);
	const prompt = JSON.stringify({ action: spec.branchId ? "回答主题追问" : "讲解当前主线单元", intent: study.session.intent, plan: study.session.plan, moduleId: spec.moduleId, question: spec.question,
		context: context.ids.map(id => { const n = study.nodes.find(n => n.id === id)!; return { id, question: n.question, answer: n.content }; }), omittedAncestors: context.omitted });
	if (prompt.length > 64000) throw new Error("当前祖先对话超过本版上下文预算，请从更靠前的节点另开支线");
	return { system: topicTeachingRules(version), prompt, schema: TOPIC_TEACHING_SCHEMA, images: [], signal, maxTokens: 5000 };
}
export function parseTopicTeaching(raw: string): { title: string; content: string } {
	if (raw.length > 100000) throw new Error("主题讲解响应超过上限");
	let value: unknown;
	try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new Error("主题讲解不是有效 JSON，请显式重试"); }
	const v = topicObject(value, ["title", "content"]);
	for (const [key, limit] of [["title", 160], ["content", 24000]] as const) if (typeof v[key] !== "string" || !v[key].trim() || v[key].length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v[key])) throw new Error("主题讲解标题或正文无效／过长");
	return { title: (v.title as string).trim(), content: (v.content as string).trim() };
}
