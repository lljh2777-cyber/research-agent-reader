import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import rules from "../../skills/reading-assistant/SKILL.md";
import { ASSISTANT_CAPABILITIES, ASSISTANT_SCHEMA, parseAssistantStep } from "./capabilities";
import { assistantContext, assistantContextHash, AssistantTools } from "./tools";
import { validateAssistantRun } from "./store";
import { readingTokenEstimate } from "../reading/usage";
import { contentHash } from "../retrieval/chunks";
import type { AssistantAction, AssistantDependencies, AssistantExecution, AssistantRun, AssistantStorage } from "./types";
import { curationTarget } from "../curation/policy";
import { ToolFailureGuard, toolFeedback } from "../agent/tool-feedback";
import { matchStructuredReference } from "../reading/structured-reference";
export class ReadingAssistantService {
	readonly runs = new Map<string, AssistantRun>(); readonly errors: string[] = [];
	actionError = "";
	private initialization?: Promise<void>; private listeners = new Set<() => void>();
	private active = new Map<string, { controller: AbortController; promise: Promise<AssistantRun> }>();
	private dispatching = new Set<string>();
	private disposed = false;
	private actionQueue: Promise<unknown> = Promise.resolve(); private unsubscribeActions?: () => void;
	private refreshing?: Promise<void>; private refreshAgain = false; private liveExecutions = new Set<string>();
	constructor(readonly deps: AssistantDependencies, private storage: AssistantStorage) {}
	subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private emit() { this.listeners.forEach(f => { try { f(); } catch { /* View callbacks cannot interrupt saves. */ } }); }
	ready(): Promise<void> { return this.initialization ||= (async () => { await this.deps.workspace.ready(); for (const id of await this.storage.list()) try {
		const r = validateAssistantRun(JSON.parse(await this.storage.read(id))); if (r.id !== id) throw new Error("记录编号不一致");
		if (r.state === "running") { r.state = "interrupted"; r.error = "上次助手请求已中断，可重新发起"; r.calls.forEach(c => { if (c.state === "running") c.state = "interrupted"; }); await this.storage.write(id, JSON.stringify(r)); }
		this.runs.set(id, r);
	} catch (e) { this.errors.push(id + "：" + String(e)); }
		if (!this.disposed) this.unsubscribeActions = this.deps.subscribeActions?.(() => { void this.refreshActions().catch(() => undefined); });
	})(); }
	private async save(run: AssistantRun) { await this.storage.write(run.id, JSON.stringify(run)); this.runs.set(run.id, structuredClone(run)); this.emit(); }
	isRunning(sessionId: string) { return this.active.has(sessionId); }
	stop(sessionId: string) { this.active.get(sessionId)?.controller.abort(); }
	private actionSerial<T>(operation: () => Promise<T>): Promise<T> { const task = this.actionQueue.then(operation); this.actionQueue = task.catch(() => undefined); return task; }
	async recordExecution(runId: string, actionId: string, executionId: string, patch: Partial<Omit<AssistantExecution, "id" | "updated">>): Promise<void> {
		await this.ready(); await this.actionSerial(async () => {
			if (this.disposed) throw new Error("阅读助手已关闭");
			const run = structuredClone(this.runs.get(runId)); const action = run?.actions.find(a => a.id === actionId);
			if (!run || run.state !== "done" || !action?.execution || action.execution.id !== executionId) throw new Error("操作已被重新打开，请使用最新预览");
			action.execution = { ...action.execution, ...patch, detail: (patch.detail ?? action.execution.detail).slice(0, 1500), updated: new Date().toISOString() };
			validateAssistantRun(run); await this.save(run);
			if (patch.state === "running") this.liveExecutions.add(executionId); else if (patch.state) this.liveExecutions.delete(executionId);
		});
	}
	async refreshActions(): Promise<void> {
		if (this.disposed || !this.deps.resolveAction) return; this.refreshAgain = true;
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => { await this.ready(); do {
			this.refreshAgain = false; await this.actionSerial(async () => {
				for (const original of [...this.runs.values()]) {
					if (this.disposed) return; if (original.state !== "done") continue;
					const run = structuredClone(original); let changed = false;
					for (const action of run.actions) if (action.execution && !(action.kind === "export" && this.liveExecutions.has(action.execution.id))) {
						let next: AssistantExecution | undefined;
						try { next = await this.deps.resolveAction!(run.sessionId, structuredClone(action)); }
						catch { next = { ...action.execution, state: "needs-review", detail: "暂时无法核对执行记录，请刷新或打开原功能查看" }; }
						if (next && JSON.stringify(next) !== JSON.stringify(action.execution)) { action.execution = { ...next, detail: next.detail.slice(0, 1500), updated: new Date().toISOString() }; changed = true; }
					}
					if (changed && !this.disposed) { validateAssistantRun(run); await this.save(run); }
				}
			});
		} while (this.refreshAgain && !this.disposed); })().then(() => { if (this.actionError) { this.actionError = ""; this.emit(); } })
			.catch(error => { this.actionError = "执行状态刷新失败：" + String(error).slice(0, 300); this.emit(); throw error; }).finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}
	/** Persist the handoff before invoking business UI. Reopening a preview is safe; advancing is one-shot. */
	async dispatch(runId: string, actionId: string, handoff: (action: AssistantAction, sessionId: string) => Promise<void> | void): Promise<void> {
		if (this.disposed) throw new Error("阅读助手已关闭");
		const key = runId + ":" + actionId; if (this.dispatching.has(key)) throw new Error("操作正在交接"); this.dispatching.add(key);
		try {
			await this.ready(); const linked = await this.actionSerial(async () => {
			const run = validateAssistantRun(structuredClone(this.runs.get(runId))); const action = run.actions.find(a => a.id === actionId);
			if (run.state !== "done" || !action) throw new Error("请求未完成或操作不存在");
			if (action.kind === "export" && action.execution && this.liveExecutions.has(action.execution.id)) throw new Error("此操作已关联执行记录，正在保存，请稍候");
			if (action.kind === "export" && action.execution?.path && this.deps.resolveAction) action.execution = await this.deps.resolveAction(run.sessionId, action) || action.execution;
			const retryExport = action.kind === "export" && action.execution && ["failed", "interrupted"].includes(action.execution.state);
			if (action.execution && !retryExport && (action.execution.state === "running" || action.execution.nodeId || action.execution.reviewId || action.execution.path)) throw new Error("此操作已关联执行记录，请查看结果或从原功能重试");
			const session = this.deps.workspace.repository.get(run.sessionId);
			if (session.demo || action.nodeIds.some(id => !session.nodes.some(n => n.id === id && n.status === "done")) || assistantContextHash(session, action.nodeIds, action.scope) !== action.contextHash) throw new Error("阅读内容已变化，请重新准备操作");
			if (action.kind === "curation" && (!curationTarget(action.target) || action.scope !== "node" || action.nodeIds.some(id => session.nodes.find(n => n.id === id)?.branchId !== session.nodes.find(n => n.id === action.nodeIds[0])?.branchId))) throw new Error("整理目标或范围无效");
			if (action.kind !== "curation" && action.target || action.kind === "export" && action.scope !== "session" && action.nodeIds.length !== 1) throw new Error("操作范围无效");
			if (action.kind === "advance" && (action.state === "opened" || action.scope !== "node" || session.completed || action.nodeIds.length !== 1 || action.nodeIds[0] !== session.mainIds[session.mainIds.length - 1])) throw new Error("此主线操作已交接或已经过期，请前往阅读界面查看或重试");
			await new AssistantTools(this.deps, session, run, new AbortController().signal).verify();
			if (this.disposed) throw new Error("阅读助手已关闭");
			action.state = "opened"; action.execution = { id: randomUUID(), state: "waiting", detail: action.kind === "advance" ? "已交接，等待关联讲解节点" : "预览已准备，等待在对应功能中继续", updated: new Date().toISOString() };
			await this.save(run); return { action: structuredClone(action), sessionId: run.sessionId };
			});
			try { if (this.disposed) throw new Error("阅读助手已关闭"); await handoff(linked.action, linked.sessionId); }
			catch (error) { if (!this.disposed) await this.recordExecution(runId, actionId, linked.action.execution!.id, { state: "failed", detail: "交接未完成：" + String(error) }); throw error; }
		} finally { this.dispatching.delete(key); }
	}
	start(sessionId: string, nodeId: string, profileId: string, question: string): Promise<AssistantRun> {
		if (this.disposed) return Promise.reject(new Error("阅读助手已关闭"));
		if (this.active.has(sessionId)) return Promise.reject(new Error("当前会话的助手仍在运行"));
		const controller = new AbortController(); const promise = this.run(sessionId, nodeId, profileId, question, controller).finally(() => { this.active.delete(sessionId); this.emit(); });
		this.active.set(sessionId, { controller, promise }); return promise;
	}
	private async run(sessionId: string, nodeId: string, profileId: string, question: string, controller: AbortController): Promise<AssistantRun> {
		await this.ready(); if (!question.trim() || question.length > 4000) throw new Error("请输入不超过 4000 字符的请求");
		const session = structuredClone(this.deps.workspace.repository.get(sessionId)); if (session.demo) throw new Error("演示会话不调用助手模型");
		if (session.source.kind === "code") throw new Error("代码会话暂不支持论文阅读助手");
		const context = assistantContext(session, nodeId); const backend = this.deps.backend(session, profileId);
		const run: AssistantRun = { version: 1, id: "a-" + randomUUID(), sessionId, nodeId, profileId, model: backend.name + " · " + backend.model, question: question.trim(), created: new Date().toISOString(), state: "running", answer: "", error: "", steps: [], sources: [], actions: [], citations: [], calls: [] };
		if (session.source.kind === "structured") run.source = structuredClone(session.source);
		await this.save(run); const tools = new AssistantTools(this.deps, session, run, controller.signal); const timer = setTimeout(() => controller.abort(), 240000);
		const history: { role: string; data: unknown }[] = []; const failures = new ToolFailureGuard(); let used = 0; let outputChars = 0;
		const system = rules + "\n可用工具（参数必须齐全）：" + JSON.stringify(ASSISTANT_CAPABILITIES);
		try {
			await tools.verify();
			for (let i = 0; i < 8; i++) {
				controller.signal.throwIfAborted(); const prompt = JSON.stringify({ context, request: question, history }); const estimate = readingTokenEstimate(system + prompt + JSON.stringify(ASSISTANT_SCHEMA));
				if (used + estimate > 42000) throw new Error("助手达到本轮文字输入预算，请拆分任务；已有轨迹已保留"); used += estimate;
				const call: AssistantRun["calls"][number] = { state: "running", estimatedInput: estimate }; run.calls.push(call); await this.save(run);
				let raw: string;
				try { raw = await backend.complete({ system, prompt, schema: ASSISTANT_SCHEMA, disableReasoning: true, images: [], signal: controller.signal, maxTokens: 3000, onUsage: u => { for (const key of ["input", "output", "cachedInput"] as const) if (Number.isFinite(u[key]) && u[key]! >= 0) call[key] = u[key]; } }); call.state = "done"; }
				catch (e) { call.state = controller.signal.aborted ? "interrupted" : "failed"; throw e; }
				finally { await this.save(run); }
				controller.signal.throwIfAborted(); const step = parseAssistantStep(raw);
				if (step.tool === "final") {
					const citations = [...new Set(step.arguments.citations as string[])]; if (citations.some(id => !run.sources.some(s => s.id === id))) throw new Error("助手引用了本轮未读取的依据");
					const answer = String(step.arguments.answer); if (!answer.trim()) throw new Error("助手返回空回答"); for (const match of answer.matchAll(/\[(S\d+)\]/g)) if (!citations.includes(match[1])) throw new Error("助手正文与引用列表不一致");
					await tools.verify(); for (const s of run.sources.filter(s => s.kind === "knowledge")) if (contentHash(await this.deps.readFile(s.path)) !== s.hash) throw new Error("回答期间知识来源已变化");
					if (run.source?.kind === "structured") { const doc = await this.deps.workspace.document(sessionId); for (const s of run.sources.filter(s => s.kind === "paper")) matchStructuredReference(s, run.source, doc.evidence); }
					run.answer = answer; run.citations = citations; run.state = "done"; await this.save(run); return run;
				}
				try { const result = await tools.execute(step.tool, step.arguments); outputChars += result.output.length; failures.succeeded(step.tool, step.arguments);
					run.steps.push({ tool: step.tool, arguments: step.arguments, summary: result.output.slice(0, 180), cached: result.cached, ok: true }); history.push({ role: "tool", data: { request: step, result: result.output } });
				} catch (e) { controller.signal.throwIfAborted(); const feedback = toolFeedback(e); run.steps.push({ tool: step.tool, arguments: step.arguments, summary: JSON.stringify(feedback).slice(0, 300), cached: false, ok: false }); history.push({ role: "tool", data: { request: step, error: feedback } });
					if (failures.failed(step.tool, step.arguments)) throw new Error("助手重复提交相同的无效操作，已停止以避免继续消耗；请根据执行轨迹调整请求");
				}
				await this.save(run);
				if (outputChars > 38000) throw new Error("工具内容超过本轮预算，已有轨迹已保留");
			}
			throw new Error("助手达到八轮调用上限，已有轨迹已保留，请缩小任务");
		} catch (e) {
			run.state = controller.signal.aborted ? "interrupted" : "failed"; run.error = controller.signal.aborted ? "助手已停止或超时，可重新发起" : String(e).slice(0, 3000);
			try { await this.save(run); } catch (saveError) {
				run.error += "；本次状态保存失败，关闭应用可能丢失本轮结果：" + String(saveError).slice(0, 500);
				this.runs.set(run.id, structuredClone(run)); this.emit();
			}
			throw e;
		}
		finally { clearTimeout(timer); }
	}
	async dispose() { this.disposed = true; this.unsubscribeActions?.(); for (const r of this.active.values()) r.controller.abort(); await Promise.allSettled([...this.active.values()].map(r => r.promise)); await this.actionQueue; this.listeners.clear(); }
}
