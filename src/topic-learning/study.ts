import { randomUUID } from "node:crypto";
import { learningAncestors, type LearningGraph } from "../learning/graph";
import { TOPIC_HASH, topicDate, topicDigest, topicObject, topicPlanDigest, validateTopicSession } from "./contracts";
import type { TopicSession } from "./types";
import { isTopicTeachingPromptVersion, type TopicTeachingPromptVersion } from "./teaching-rules";

export { STUDY_PROMPT_VERSION } from "./teaching-rules";
export interface TopicNodeSpec { id: string; parentId: string | null; branchId: string | null; moduleId: string | null; question: string; }
export interface TopicStudyUsage { input?: number; output?: number; cachedInput?: number; }
export const UNDERSTANDING_LABELS = { unmarked: "未标记", understood: "已理解", revisit: "待回看", question: "仍有疑问" } as const;
export type TopicUnderstanding = keyof typeof UNDERSTANDING_LABELS;
export type TopicStudyEvent = { type: "start"; session: TopicSession; revision: string }
	| { type: "request"; node: TopicNodeSpec; provider: string; model: string; promptVersion: TopicTeachingPromptVersion; contextIds: string[]; omitted: number }
	| { type: "result"; requestId: string; status: "done" | "failed" | "cancelled"; title: string; content: string; error: string; response: string; usage: TopicStudyUsage }
	| { type: "understanding"; nodeId: string; answerRequestId: string; actor: "user"; state: TopicUnderstanding };
export interface TopicStudyCommit { version: 1; id: string; parent: string | null; date: string; event: TopicStudyEvent; digest: string; }
export interface TopicStudyAttempt { requestId: string; provider: string; model: string; promptVersion: TopicTeachingPromptVersion; date: string; contextIds: string[]; omitted: number; result?: Extract<TopicStudyEvent, { type: "result" }>; }
export interface TopicStudyNode extends TopicNodeSpec { title: string; content: string; status: "done" | "failed" | "cancelled" | "interrupted"; attempts: TopicStudyAttempt[]; understanding?: { state: TopicUnderstanding; date: string; commitId: string; answerRequestId: string; actor: "user" }; }
export interface TopicStudy { session: TopicSession; revision: string; routeDigest: string; head: string; nodes: TopicStudyNode[]; graph: LearningGraph; }
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export const STUDY_COMMIT_ID = new RegExp("^e-" + UUID + "$");
const BRANCH = new RegExp("^b-" + UUID + "$"), NODE = new RegExp("^(n-" + UUID + "|main-unit-[a-z0-9-]+)$");
const text = (raw: unknown, max: number, empty = false): string => {
	if (typeof raw !== "string" || raw.length > max || (!empty && !raw.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) throw new Error("主题讲解文本无效或超过长度上限"); return raw;
};
function identifier(raw: unknown, pattern: RegExp): string { if (typeof raw !== "string" || !pattern.test(raw)) throw new Error("主题讲解标识无效"); return raw; }
export function validateStudyEvent(raw: unknown): TopicStudyEvent {
	const type = (raw as TopicStudyEvent)?.type;
	if (type === "start") {
		const v = topicObject(raw, ["type", "session", "revision"]), session = validateTopicSession(v.session);
		if (!session.confirmation || !session.plan) throw new Error("主题讲解必须绑定已确认路线");
		return { type, session, revision: identifier(v.revision, TOPIC_HASH) };
	}
	if (type === "request") {
		const v = topicObject(raw, ["type", "node", "provider", "model", "promptVersion", "contextIds", "omitted"]), n = topicObject(v.node, ["id", "parentId", "branchId", "moduleId", "question"]);
		if (!isTopicTeachingPromptVersion(v.promptVersion) || !Array.isArray(v.contextIds) || v.contextIds.length > 9 || new Set(v.contextIds).size !== v.contextIds.length || !Number.isSafeInteger(v.omitted) || (v.omitted as number) < 0 || (v.omitted as number) > 192) throw new Error("主题讲解上下文记录无效");
		return { type, node: { id: identifier(n.id, NODE), parentId: n.parentId === null ? null : identifier(n.parentId, NODE), branchId: n.branchId === null ? null : identifier(n.branchId, BRANCH), moduleId: n.moduleId === null ? null : identifier(n.moduleId, /^unit-[a-z0-9-]{1,35}$/), question: text(n.question, 2000) }, provider: text(v.provider, 160), model: text(v.model, 200), promptVersion: v.promptVersion, contextIds: v.contextIds.map(id => identifier(id, NODE)), omitted: v.omitted as number };
	}
	if (type === "understanding") {
		const v = topicObject(raw, ["type", "nodeId", "answerRequestId", "actor", "state"]);
		if (v.actor !== "user" || typeof v.state !== "string" || !Object.prototype.hasOwnProperty.call(UNDERSTANDING_LABELS, v.state)) throw new Error("理解状态只能来自用户的有效标记");
		return { type, nodeId: identifier(v.nodeId, NODE), answerRequestId: identifier(v.answerRequestId, STUDY_COMMIT_ID), actor: "user", state: v.state as TopicUnderstanding };
	}
	if (type === "result") {
		const v = topicObject(raw, ["type", "requestId", "status", "title", "content", "error", "response", "usage"]), usage = topicObject(v.usage, ["input", "output", "cachedInput"]);
		if (!["done", "failed", "cancelled"].includes(String(v.status))) throw new Error("主题讲解返回状态无效");
		for (const n of Object.values(usage)) if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("主题讲解用量无效");
		if (typeof v.response !== "string" || v.response.length > 100000) throw new Error("主题原始响应无效或过长");
		const result = { type, requestId: identifier(v.requestId, STUDY_COMMIT_ID), status: v.status as "done" | "failed" | "cancelled", title: text(v.title, 160, v.status !== "done"), content: text(v.content, 24000, v.status !== "done"), error: text(v.error, 2000, true), response: v.response, usage: usage as TopicStudyUsage };
		if (result.status !== "done" && (result.title || result.content)) throw new Error("失败的讲解不能发布正文");
		return result;
	}
	throw new Error("未知主题讲解事件");
}
export function validateStudyCommit(raw: unknown, fileId: string): TopicStudyCommit {
	const v = topicObject(raw, ["version", "id", "parent", "date", "event", "digest"]);
	if (v.version !== 1 || v.id !== fileId) throw new Error("主题讲解记录版本或文件标识无效");
	const payload = { version: 1 as const, id: identifier(v.id, STUDY_COMMIT_ID), parent: v.parent === null ? null : identifier(v.parent, TOPIC_HASH), date: topicDate(v.date), event: validateStudyEvent(v.event) };
	if (topicDigest(payload) !== v.digest) throw new Error("主题讲解记录摘要不一致"); return { ...payload, digest: String(v.digest) };
}
export function studyContext(study: TopicStudy, parentId: string | null): { ids: string[]; omitted: number } {
	const ancestors = learningAncestors(study.nodes, parentId);
	// Keep the branch's originating main unit plus its most recent eight ancestors, never siblings.
	const origin = [...ancestors].reverse().find(n => !n.branchId), recent = ancestors.slice(-8);
	const included = origin && !recent.includes(origin) ? [origin, ...recent] : recent;
	return { ids: included.map(n => n.id), omitted: ancestors.length - included.length };
}
export function projectStudy(commits: TopicStudyCommit[]): TopicStudy {
	if (!commits.length || commits[0].event.type !== "start") throw new Error("主题讲解缺少起始路线");
	const first = commits[0].event, study: TopicStudy = { session: first.session, revision: first.revision, routeDigest: topicPlanDigest(first.session), head: commits[0].digest, nodes: [], graph: { mainIds: [], branches: [], collapsed: [] } };
	const requests = new Map<string, TopicStudyNode>();
	for (const commit of commits.slice(1)) {
		const e = commit.event; if (e.type === "start") throw new Error("主题讲解路线不能在同一记录中替换");
		if (e.type === "request") {
			const spec = e.node, parent = study.nodes.find(n => n.id === spec.parentId), existing = study.nodes.find(n => n.id === spec.id);
			if (existing) {
				if (existing.status === "done" || topicDigest(spec) !== topicDigest({ id: existing.id, parentId: existing.parentId, branchId: existing.branchId, moduleId: existing.moduleId, question: existing.question })) throw new Error("重试不能覆盖已返回正文或改变节点问题");
			} else {
				if (study.nodes.length >= 192) throw new Error("主题学习达到 192 个节点上限");
				if (!spec.branchId) {
					const module = study.session.plan!.modules[study.graph.mainIds.length];
					if (!module || spec.id !== "main-" + module.id || spec.moduleId !== module.id || spec.question !== module.question || spec.parentId !== (study.graph.mainIds.slice(-1)[0] || null) || parent && parent.status !== "done") throw new Error("主题主线必须按固定路线逐单元推进");
					study.graph.mainIds.push(spec.id);
				} else {
					if (spec.moduleId !== null || !parent || parent.status !== "done") throw new Error("追问需要已返回的父节点");
					let branch = study.graph.branches.find(b => b.id === spec.branchId);
					if (branch && branch.nodeIds.slice(-1)[0] !== spec.parentId) throw new Error("继续支线必须从它的最后一轮开始");
					if (!branch) { branch = { id: spec.branchId, parentNodeId: spec.parentId!, nodeIds: [] }; study.graph.branches.push(branch); }
					branch.nodeIds.push(spec.id);
				}
			}
			const context = studyContext(study, spec.parentId);
			if (topicDigest(context.ids) !== topicDigest(e.contextIds) || context.omitted !== e.omitted) throw new Error("主题讲解上下文与祖先关系不一致");
			const node = existing || { ...spec, title: spec.moduleId ? study.session.plan!.modules.find(m => m.id === spec.moduleId)!.title : spec.question, content: "", status: "interrupted" as const, attempts: [] };
			if (!existing) study.nodes.push(node);
			node.status = "interrupted"; node.attempts.push({ requestId: commit.id, provider: e.provider, model: e.model, promptVersion: e.promptVersion, date: commit.date, contextIds: [...e.contextIds], omitted: e.omitted }); requests.set(commit.id, node);
		} else if (e.type === "result") {
			const node = requests.get(e.requestId), attempt = node?.attempts.slice(-1)[0];
			if (!node || !attempt || attempt.requestId !== e.requestId || attempt.result) throw new Error("讲解返回缺少唯一且仍有效的请求");
			attempt.result = e; node.status = e.status; if (e.status === "done") { node.title = e.title; node.content = e.content; }
		} else {
			const node = study.nodes.find(n => n.id === e.nodeId), answer = node?.attempts.slice(-1)[0];
			if (!node || node.status !== "done" || answer?.requestId !== e.answerRequestId) throw new Error("理解标记必须对应已返回的当前回答");
			node.understanding = { state: e.state, actor: "user", date: commit.date, commitId: commit.id, answerRequestId: e.answerRequestId };
		}
		study.head = commit.digest;
	}
	return study;
}
export function nextTopicNode(study: TopicStudy): TopicNodeSpec {
	const last = study.nodes.find(n => n.id === study.graph.mainIds.slice(-1)[0]);
	if (last && last.status !== "done") throw new Error("请先重试上一主线单元");
	const module = study.session.plan!.modules[study.graph.mainIds.length]; if (!module) throw new Error("本路线的主线单元均已生成");
	return { id: "main-" + module.id, parentId: last?.id || null, branchId: null, moduleId: module.id, question: module.question };
}
export function topicQuestion(study: TopicStudy, parentId: string, question: string, newBranch = false): TopicNodeSpec {
	const parent = study.nodes.find(n => n.id === parentId); if (!parent || parent.status !== "done") throw new Error("请先选择已返回的讲解节点");
	return { id: "n-" + randomUUID(), parentId, branchId: !newBranch && parent.branchId ? parent.branchId : "b-" + randomUUID(), moduleId: null, question: text(question.trim(), 2000) };
}
