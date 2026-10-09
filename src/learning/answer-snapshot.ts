import { objectDigest } from "../papers/identity";
import { validateReadingSession } from "../reading/session";
import type { ReadingSession } from "../reading/types";
import type { TopicStudy } from "../topic-learning/study";
import { TopicStudyStore } from "../topic-learning/study-store";
import type { SourceStorage } from "../sources/storage";

export type AnswerRef = { kind: "reading"; sessionId: string; nodeId: string } | { kind: "topic"; topicId: string; route: string; nodeId: string };
export interface AnswerSnapshot {
	version: 1; ref: AnswerRef; title: string; question: string; content: string; provider: string; model: string;
	context: { kind: "topic" | "pdf" | "article" | "structured" | "code"; location: string; digest: string; requestId: string; rule: string; correction: string };
	digest: string;
}
const hash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
export function validateAnswerRef(ref: AnswerRef): void {
	if (!ref || !["reading", "topic"].includes(ref.kind) || typeof ref.nodeId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(ref.nodeId)) throw new Error("学习回答标识无效");
	if (ref.kind === "reading" ? !/^r-[a-f0-9-]{36}$/.test(ref.sessionId) : !/^t-[a-f0-9-]{36}$/.test(ref.topicId) || !hash(ref.route)) throw new Error("学习会话或路线标识无效");
}
export function validateAnswerSnapshot(raw: AnswerSnapshot): AnswerSnapshot {
	validateAnswerRef(raw?.ref);
	const { digest, ...payload } = raw;
	if (raw.version !== 1 || !hash(digest) || digest !== objectDigest(payload) || ![raw.title, raw.question, raw.content, raw.provider, raw.model].every(v => typeof v === "string") || !raw.content.trim() || raw.content.length > 250000 || raw.title.length > 1000 || raw.question.length > 10000 || raw.provider.length > 500 || raw.model.length > 500) throw new Error("学习回答快照内容或版本无效");
	const c = raw.context;
	if (!c || !["topic", "pdf", "article", "structured", "code"].includes(c.kind) || (raw.ref.kind === "topic") !== (c.kind === "topic") || !hash(c.digest) || ![c.location, c.requestId, c.rule, c.correction].every(v => typeof v === "string" && v.length <= 4000)) throw new Error("学习回答来源凭据无效");
	return structuredClone(raw);
}
function snapshot(payload: Omit<AnswerSnapshot, "digest">): AnswerSnapshot { return validateAnswerSnapshot({ ...payload, digest: objectDigest(payload) }); }
export function readingAnswerSnapshot(input: ReadingSession, nodeId: string): AnswerSnapshot {
	const session = validateReadingSession(structuredClone(input)), node = session.nodes.find(n => n.id === nodeId);
	if (session.demo || session.purpose === "demo" || session.purpose === "test" || !node || node.status !== "done") throw new Error("只能保存正式会话中已完成的 AI 回答");
	return snapshot({ version: 1, ref: { kind: "reading", sessionId: session.id, nodeId }, title: node.title, question: node.question, content: node.content, provider: node.provider || "", model: node.model || "",
		context: { kind: session.source.kind, location: session.source.path, requestId: "", rule: "", correction: node.acceptedCorrectionId || "",
			digest: objectDigest({ source: session.source, evidence: node.evidence, quote: node.quote || null, codeQuote: node.codeQuote || null, web: node.web || null, correction: node.correction || null, acceptedCorrectionId: node.acceptedCorrectionId || null }) } });
}
export function topicAnswerSnapshot(study: TopicStudy, nodeId: string): AnswerSnapshot {
	const node = study.nodes.find(n => n.id === nodeId), attempt = node?.attempts[node.attempts.length - 1];
	if (!node || node.status !== "done" || !attempt || attempt.result?.status !== "done" || node.content !== attempt.result.content || node.title !== attempt.result.title) throw new Error("只能保存已有完成凭据的主题回答");
	return snapshot({ version: 1, ref: { kind: "topic", topicId: study.session.id, route: study.routeDigest, nodeId }, title: node.title, question: node.question, content: node.content, provider: attempt.provider, model: attempt.model,
		context: { kind: "topic", location: study.session.intent.topic, requestId: attempt.requestId, rule: attempt.promptVersion, correction: "", digest: objectDigest({ session: study.session, route: study.routeDigest, revision: study.revision, question: node.question, attempt }) } });
}

/** Read committed data without initializing a repository, recovering jobs or loading an original. */
export async function readAnswerSnapshot(io: SourceStorage, ref: AnswerRef, signal?: AbortSignal): Promise<AnswerSnapshot> {
	ref = structuredClone(ref); validateAnswerRef(ref); signal?.throwIfAborted(); let budget = 64 * 1024 * 1024;
	const read: SourceStorage["read"] = async (path, limit = 512 * 1024) => {
		signal?.throwIfAborted(); if (budget <= 0) throw new Error("回答记录达到读取上限");
		const bytes = await io.read(path, Math.min(limit, budget)); signal?.throwIfAborted(); if (bytes) { budget -= bytes.byteLength; if (budget < 0 || bytes.byteLength > limit) throw new Error("回答记录达到读取上限"); } return bytes;
	};
	if (ref.kind === "topic") {
		const readonly: SourceStorage = { read, list: async path => { signal?.throwIfAborted(); return io.list(path); }, mkdir: async () => { throw new Error("只读回答核对不能创建目录"); }, create: async () => { throw new Error("只读回答核对不能写入"); } };
		const history = await new TopicStudyStore(readonly).read(ref.topicId, ref.route); signal?.throwIfAborted();
		if (history.errors.length || history.pending.length || !history.study) throw new Error("主题回答记录缺失、不完整或有冲突，请重新读取学习会话");
		return topicAnswerSnapshot(history.study, ref.nodeId);
	}
	const found: ReadingSession[] = [];
	for (const root of ["reading-sessions", "code-reading-sessions", "reading-test-sessions"]) {
		const bytes = await read(`${root}/${ref.sessionId}.json`, 64 * 1024 * 1024); if (!bytes) continue;
		if (root === "reading-test-sessions") throw new Error("测试会话不能保存为学习摘录");
		const session = validateReadingSession(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		if (session.id !== ref.sessionId || root === "code-reading-sessions" && session.source.kind !== "code") throw new Error("回答记录与存储位置不一致"); found.push(session);
	}
	if (found.length !== 1) throw new Error("回答会话缺失或存在重复版本，未选择同名替代");
	return readingAnswerSnapshot(found[0], ref.nodeId);
}
