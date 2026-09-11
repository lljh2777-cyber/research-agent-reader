import type { ReadingBackend } from "../reading/types";
import { topicPlanDigest } from "./contracts";
import type { TopicLearningService } from "./service";
import { nextTopicNode, STUDY_PROMPT_VERSION, studyContext, topicQuestion, type TopicNodeSpec, type TopicStudy, type TopicStudyEvent, type TopicStudyUsage } from "./study";
import { TopicStudyStore } from "./study-store";
import { parseTopicTeaching, topicTeachingRequest } from "./teaching";

export class TopicStudyService {
	private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
	private closed = false;
	constructor(readonly store: TopicStudyStore, private readonly topics: TopicLearningService) {}
	async start(topicId: string, revision: string): Promise<string> {
		if (this.closed) throw new Error("主题学习服务已关闭");
		const r = await this.topics.get(topicId, revision); if (!r.session.confirmation) throw new Error("请先确认主题路线");
		const route = topicPlanDigest(r.session), history = await this.store.read(topicId, route);
		if (history.errors.length) throw new Error(history.errors.join("；"));
		if (!history.study) await this.store.append(topicId, route, null, { type: "start", session: r.session, revision });
		return route;
	}
	async get(topicId: string, route: string, expected?: string): Promise<TopicStudy> {
		const h = await this.store.read(topicId, route);
		if (h.errors.length) throw new Error(h.errors.join("；")); if (!h.study) throw new Error("学习记录不存在或尚未提交");
		if (expected !== undefined && h.study.head !== expected) throw new Error("学习记录已变化，请重新读取"); return h.study;
	}
	async generate(topicId: string, route: string, expected: string, action: { kind: "next" } | { kind: "ask"; parentId: string; question: string; newBranch: boolean } | { kind: "retry"; nodeId: string }, makeBackend: () => ReadingBackend, signal?: AbortSignal): Promise<void> {
		const key = topicId + "/" + route;
		if (this.closed || this.active.has(key)) throw new Error("主题学习已关闭或正在生成，请等待或取消");
		const controller = new AbortController(), abort = () => controller.abort(new Error("主题讲解已取消"));
		signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
		const timer = setTimeout(() => controller.abort(new Error("主题讲解超过 3 分钟，可显式重试")), 180000);
		const promise = Promise.resolve().then(async () => {
			controller.signal.throwIfAborted(); const study = await this.get(topicId, route, expected); controller.signal.throwIfAborted();
			const capacity = await this.store.read(topicId, route);
			if (capacity.commits.length + capacity.pending.length > 509) throw new Error("学习记录剩余空间不足以保存请求与返回，请保留历史并开启新的路线记录");
			let spec: TopicNodeSpec;
			if (action.kind === "next") spec = nextTopicNode(study);
			else if (action.kind === "ask") spec = topicQuestion(study, action.parentId, action.question, action.newBranch);
			else {
				const n = study.nodes.find(n => n.id === action.nodeId); if (!n || n.status === "done") throw new Error("此节点没有可重试的失败请求");
				spec = { id: n.id, parentId: n.parentId, branchId: n.branchId, moduleId: n.moduleId, question: n.question };
			}
			const request = topicTeachingRequest(study, spec, controller.signal), context = studyContext(study, spec.parentId), backend = makeBackend();
			const committed = await this.store.append(topicId, route, expected, { type: "request", node: spec, provider: backend.name, model: backend.model, promptVersion: STUDY_PROMPT_VERSION, contextIds: context.ids, omitted: context.omitted }, controller.signal);
			const usage: TopicStudyUsage = {}; let response = "", detach: (() => void) | undefined, reporting = true;
			let result: Extract<TopicStudyEvent, { type: "result" }>;
			try {
				controller.signal.throwIfAborted();
				const cancelled = new Promise<never>((_, reject) => { const rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", rejectAbort, { once: true }); detach = () => controller.signal.removeEventListener("abort", rejectAbort); });
				response = await Promise.race([backend.complete({ ...request, onUsage: report => { if (reporting && !controller.signal.aborted) for (const key of ["input", "output", "cachedInput"] as const) if (Number.isFinite(report[key]) && report[key]! >= 0) usage[key] = report[key]; } }), cancelled]);
				controller.signal.throwIfAborted(); if (typeof response !== "string") { response = ""; throw new Error("主题讲解响应无效"); }
				const answer = parseTopicTeaching(response); result = { type: "result", requestId: committed.id, status: "done", ...answer, error: "", response, usage };
			} catch (e) { result = { type: "result", requestId: committed.id, status: controller.signal.aborted ? "cancelled" : "failed", title: "", content: "", error: String(e).slice(0, 2000), response: typeof response === "string" ? response.slice(0, 100000) : "", usage }; }
			finally { reporting = false; detach?.(); }
			// Publish a cancelled/failed receipt as well; do not erase an already published request.
			if (result.status === "done" && controller.signal.aborted) { result.status = "cancelled"; result.title = ""; result.content = ""; result.error = "主题讲解已取消"; }
			try { await this.store.append(topicId, route, committed.digest, result, result.status === "done" ? controller.signal : undefined); }
			catch (error) {
				const h = await this.store.read(topicId, route);
				if (result.status !== "done" || !controller.signal.aborted || h.errors.length || h.study?.head !== committed.digest) throw error;
				await this.store.append(topicId, route, committed.digest, { ...result, status: "cancelled", title: "", content: "", error: "提交前已取消讲解，未发布正文" });
			}
		});
		this.active.set(key, { controller, promise });
		try { await promise; } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.active.delete(key); }
	}
	async dispose(): Promise<void> { this.closed = true; for (const { controller } of this.active.values()) controller.abort(new Error("主题学习服务已关闭")); await Promise.allSettled([...this.active.values()].map(a => a.promise)); }
}
