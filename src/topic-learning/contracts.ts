import { createHash, randomUUID } from "node:crypto";
import type { TopicIntent, TopicPlan, TopicSession } from "./types";

export const TOPIC_ID = /^t-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const TOPIC_HASH = /^[a-f0-9]{64}$/;
export function topicObject(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("主题学习记录包含无效或不支持的字段");
	return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, optional = false): string {
	if (typeof value !== "string" || value.length > limit || (!optional && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("主题学习文本为空、过长或含控制字符");
	return value.trim();
}
export function topicDate(value: unknown): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("主题学习时间无效");
	return value;
}
/** Stable across JSON property order; used as an edit receipt, never as source evidence. */
export function topicDigest(value: unknown): string {
	const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : item;
	return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function validateTopicIntent(raw: unknown): TopicIntent {
	const value = topicObject(raw, ["topic", "goal", "background"]);
	return { topic: text(value.topic, 160), goal: text(value.goal, 2000), background: text(value.background, 2000, true) };
}
export function validateTopicPlan(raw: unknown): TopicPlan {
	const value = topicObject(raw, ["version", "modules"]);
	if (value.version !== 1 || !Array.isArray(value.modules) || value.modules.length < 2 || value.modules.length > 12) throw new Error("主题路线需要 2–12 个单元");
	const ids = new Set<string>(), titles = new Set<string>();
	const modules = value.modules.map(rawModule => {
		const module = topicObject(rawModule, ["id", "title", "question", "objective", "prerequisites"]);
		const id = text(module.id, 40), title = text(module.title, 160);
		const normalized = title.normalize("NFKC").replace(/[\s\p{P}]/gu, "").toLowerCase();
		if (!/^unit-[a-z0-9-]+$/.test(id) || ids.has(id) || !normalized || titles.has(normalized)) throw new Error("主题路线单元标识或标题重复／无效");
		if (!Array.isArray(module.prerequisites) || module.prerequisites.length > 11 || module.prerequisites.some(item => typeof item !== "string" || !ids.has(item))
			|| new Set(module.prerequisites).size !== module.prerequisites.length) throw new Error("主题路线先修单元必须唯一且位于当前单元之前");
		ids.add(id); titles.add(normalized);
		return { id, title, question: text(module.question, 500), objective: text(module.objective, 1000), prerequisites: [...module.prerequisites] as string[] };
	});
	return { version: 1, modules };
}
export function topicPlanDigest(session: Pick<TopicSession, "intent" | "plan">): string {
	return topicDigest({ intent: session.intent, plan: session.plan });
}
export function validateTopicSession(raw: unknown): TopicSession {
	const value = topicObject(raw, ["version", "kind", "id", "intent", "evidencePolicy", "createdAt", "updatedAt", "plan", "planOrigin", "confirmation"]);
	if (value.version !== 1 || value.kind !== "topic-learning" || typeof value.id !== "string" || !TOPIC_ID.test(value.id)
		|| value.evidencePolicy !== "general-knowledge") throw new Error("主题学习会话身份或知识来源策略无效");
	const session: TopicSession = { version: 1, kind: "topic-learning", id: value.id, intent: validateTopicIntent(value.intent), evidencePolicy: "general-knowledge",
		createdAt: topicDate(value.createdAt), updatedAt: topicDate(value.updatedAt) };
	if (session.updatedAt < session.createdAt) throw new Error("主题学习更新时间早于创建时间");
	if (value.plan !== undefined) {
		session.plan = validateTopicPlan(value.plan);
		const origin = topicObject(value.planOrigin, ["kind", "provider", "model"]);
		if (origin.kind === "model-knowledge") session.planOrigin = { kind: origin.kind, provider: text(origin.provider, 160), model: text(origin.model, 200) };
		else if (origin.kind === "user" && Object.keys(origin).length === 1) session.planOrigin = { kind: "user" };
		else throw new Error("主题路线来源无效");
	} else if (value.planOrigin !== undefined || value.confirmation !== undefined) throw new Error("尚无主题路线，不能记录路线来源或确认状态");
	if (value.confirmation !== undefined) {
		const confirmation = topicObject(value.confirmation, ["planDigest", "confirmedAt"]);
		if (confirmation.planDigest !== topicPlanDigest(session)) throw new Error("已确认的主题目标或路线发生变化");
		const confirmedAt = topicDate(confirmation.confirmedAt);
		if (confirmedAt < session.createdAt || confirmedAt > session.updatedAt) throw new Error("主题路线确认时间无效");
		session.confirmation = { planDigest: confirmation.planDigest as string, confirmedAt };
	}
	return session;
}
export function createTopicSession(intent: TopicIntent): TopicSession {
	const now = new Date().toISOString();
	return validateTopicSession({ version: 1, kind: "topic-learning", id: "t-" + randomUUID(), intent, evidencePolicy: "general-knowledge", createdAt: now, updatedAt: now });
}
