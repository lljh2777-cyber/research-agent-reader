import type { ReadingBackend, ReadingBackendRequest } from "../reading/types";
import { createTopicSession, topicDigest, topicPlanDigest, validateTopicIntent, validateTopicPlan } from "./contracts";
import { generateTopicPlan } from "./planning";
import { TopicSessionStore } from "./store";
import type { TopicRevision } from "./store";
import type { TopicIntent, TopicPlan, TopicSession } from "./types";

/** T0: durable intent and user-confirmed route. Dialogue/UI integration belongs to T1. */
export class TopicLearningService {
	private active = new Map<string, AbortController>();
	constructor(readonly store: TopicSessionStore) {}
	create(intent: TopicIntent): Promise<TopicRevision> { return this.store.append(createTopicSession(intent), null); }
	async get(id: string, expected?: string): Promise<TopicRevision> {
		const history = await this.store.read(id);
		if (history.errors.length) throw new Error("主题历史无法核验：" + history.errors.join("；"));
		if (!history.current) throw new Error("主题会话不存在或尚未提交");
		if (expected !== undefined && history.current.digest !== expected) throw new Error("主题会话已变化，请重新读取后保存");
		return history.current;
	}
	async editIntent(id: string, expected: string, input: TopicIntent): Promise<TopicRevision> {
		const current = await this.get(id, expected), intent = validateTopicIntent(input);
		if (topicDigest(intent) === topicDigest(current.session.intent)) return current;
		const session = this.touch(current.session); session.intent = intent;
		delete session.plan; delete session.planOrigin; delete session.confirmation;
		return this.store.append(session, expected);
	}
	async editPlan(id: string, expected: string, input: TopicPlan): Promise<TopicRevision> {
		const current = await this.get(id, expected), plan = validateTopicPlan(input);
		if (current.session.plan && topicDigest(plan) === topicDigest(current.session.plan)) return current;
		const session = this.touch(current.session); session.plan = plan; session.planOrigin = { kind: "user" }; delete session.confirmation;
		return this.store.append(session, expected);
	}
	async confirmPlan(id: string, expected: string): Promise<TopicRevision> {
		const current = await this.get(id, expected);
		if (!current.session.plan) throw new Error("请先生成或填写主题路线");
		if (current.session.confirmation) return current;
		const session = this.touch(current.session);
		session.confirmation = { planDigest: topicPlanDigest(session), confirmedAt: session.updatedAt };
		return this.store.append(session, expected);
	}
	/** Explicit recovery into a new session; never rewrite or choose a winner in conflicted history. */
	async copyRevision(id: string, digest: string): Promise<TopicRevision> {
		const history = await this.store.read(id), revision = history.revisions.find(item => item.digest === digest);
		if (!revision) throw new Error("所选历史版本无法核验，请重新读取");
		const session = createTopicSession(revision.session.intent);
		if (revision.session.plan) { session.plan = structuredClone(revision.session.plan); session.planOrigin = structuredClone(revision.session.planOrigin!); }
		return this.store.append(session, null);
	}
	async plan(id: string, expected: string, backend: ReadingBackend, signal?: AbortSignal, onUsage?: ReadingBackendRequest["onUsage"]): Promise<TopicRevision> {
		if (this.active.has(id)) throw new Error("主题路线正在生成，请等待或取消");
		const controller = new AbortController(); this.active.set(id, controller);
		const abort = () => controller.abort(new Error("主题路线生成已取消"));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const timer = setTimeout(() => controller.abort(new Error("主题路线生成超过 3 分钟，可显式重试")), 180_000);
		let rejectAbort: (() => void) | undefined;
		try {
			controller.signal.throwIfAborted();
			const current = await this.get(id, expected);
			if (current.session.confirmation) throw new Error("路线已经确认，请先明确修改路线再重新生成");
			const provider = backend.name, model = backend.model;
			if (!provider?.trim() || !model?.trim() || provider.length > 160 || model.length > 200) throw new Error("主题路线需要有效的模型与供应商名称");
			const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", rejectAbort, { once: true }); });
			controller.signal.throwIfAborted();
			const plan = await Promise.race([generateTopicPlan(current.session.intent, backend, controller.signal, onUsage), cancelled]);
			controller.signal.throwIfAborted();
			const session = this.touch(current.session); session.plan = plan; session.planOrigin = { kind: "model-knowledge", provider, model };
			delete session.confirmation;
			// The edit receipt prevents a late response from replacing newer user changes.
			return await this.store.append(session, expected, controller.signal);
		} finally {
			clearTimeout(timer); signal?.removeEventListener("abort", abort);
			if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
			this.active.delete(id);
		}
	}
	cancel(id: string): void { this.active.get(id)?.abort(new Error("主题路线生成已取消")); }
	dispose(): void { for (const controller of this.active.values()) controller.abort(new Error("主题学习服务已关闭")); }
	private touch(session: TopicSession): TopicSession {
		return { ...structuredClone(session), updatedAt: new Date(Math.max(Date.now(), Date.parse(session.updatedAt))).toISOString() };
	}
}
