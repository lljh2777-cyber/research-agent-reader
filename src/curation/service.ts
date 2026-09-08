import type { App } from "obsidian";
import { randomUUID } from "node:crypto";
import type { ReadingBackend, ReadingImage, ReadingSession } from "../reading/types";
import { CURATION_SCHEMA } from "../reading/schemas";
import type { ReadingWorkspaceService } from "../reading/workspace";
import { contentHash } from "../retrieval/chunks";
import { curationSkill, prepareCuration, verifyCurationContext } from "./context";
import { curationParagraphs, curationTarget, estimatedTokens, parseCurationResult, validateSuggestion } from "./policy";
import type { CurationContext, CurationRecordStore, CurationReview, CurationRevision, CurationSuggestion } from "./types";
import type { CurationSearch } from "./selection";

const id = (): string => "c-" + randomUUID(); const now = (): string => new Date().toISOString();
export function validatedReview(raw: unknown): CurationReview {
	if (!raw || typeof raw !== "object") throw new Error("整理记录格式错误"); const record = raw as CurationReview; const context = record.context;
	if (record.version !== 1 || !/^c-[a-f0-9-]{36}$/.test(record.id) || !context || !context.target || !curationTarget(context.target.path) || typeof context.target.text !== "string" || contentHash(context.target.text) !== context.target.hash || !Array.isArray(context.evidence) || !Array.isArray(context.nodeIds) || !Array.isArray(record.suggestions) || !record.usage || !["generating", "ready", "failed", "interrupted", "stale"].includes(record.state)) throw new Error("整理记录结构或指纹错误");
	const paragraphs = curationParagraphs(context.target.text);
	if (!context.target.paragraphs.every(p => paragraphs.some(original => original.id === p.id && original.text === p.text && original.start === p.start && original.end === p.end))) throw new Error("整理段落定位错误");
	for (const evidence of context.evidence) if (!evidence || !["paper", "vault"].includes(evidence.kind) || typeof evidence.text !== "string" || typeof evidence.path !== "string" || typeof evidence.hash !== "string" || !Array.isArray(evidence.origins)) throw new Error("整理证据结构错误");
	const copy = structuredClone(record); copy.suggestions = record.suggestions.map((suggestion, index) => {
		const checked = validateSuggestion(suggestion, copy.context, index);
		// Earlier versions could discard an invalid quotation. Reload must never promote a blocked record.
		return { ...checked, warnings: [...new Set([...checked.warnings, ...(Array.isArray(suggestion.warnings) ? suggestion.warnings.filter(w => typeof w === "string") : [])])], applicable: checked.applicable && suggestion.applicable !== false,
			decision: ["pending", "ignored", "applied"].includes(suggestion.decision) ? suggestion.decision : "pending" };
	});
	return copy;
}
export class CurationService {
	readonly reviews = new Map<string, CurationReview>(); readonly revisions = new Map<string, CurationRevision>(); readonly errors: string[] = [];
	changesPending = false;
	private initialization?: Promise<void>; private listeners = new Set<() => void>(); private operations = new Map<string, Promise<CurationReview>>();
	private controllers = new Map<string, AbortController>(); private queue: Promise<unknown> = Promise.resolve(); private generationCache = new Map<string, CurationReview>();
	constructor(readonly app: App, readonly workspace: ReadingWorkspaceService, readonly store: CurationRecordStore, private backendFor: (session: ReadingSession) => ReadingBackend, private search?: CurationSearch) {}
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	get activeCount(): number { return this.operations.size; }
	noteChange(path: string): void { if ([...this.reviews.values()].some(r => r.context.target.path === path || r.context.evidence.some(e => e.path === path) || r.context.source.kind === "article" && path.startsWith(r.context.source.path.replace(/article\.md$/, "")))) { this.changesPending = true; this.emit(); } }
	emit(): void { this.listeners.forEach(listener => { try { listener(); } catch { /* A closed view must not interrupt persistence. */ } }); }
	ready(): Promise<void> {
		if (!this.initialization) this.initialization = (async () => {
			await this.workspace.ready();
			for (const key of await this.store.list("reviews")) try {
				const review = validatedReview(await this.store.read("reviews", key)); if (review.id !== key) throw new Error("记录 ID 不一致");
				if (review.state === "generating") { review.state = "interrupted"; review.error = "上次生成已中断，可手动重试"; await this.store.write("reviews", review); }
				this.reviews.set(key, review);
			} catch (error) { this.errors.push(key + "：" + String(error)); }
			for (const key of await this.store.list("revisions")) try { const value = await this.store.read("revisions", key) as CurationRevision; if (value.version !== 1 || value.id !== key || !Array.isArray(value.writes)) throw new Error("修订结构错误"); this.revisions.set(key, value); } catch (error) { this.errors.push(key + "：" + String(error)); }
		})(); return this.initialization;
	}
	serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result; }
	async save(review: CurationReview): Promise<void> { await this.store.write("reviews", review); this.reviews.set(review.id, structuredClone(review)); this.emit(); }
	async saveRevision(revision: CurationRevision): Promise<void> { await this.store.write("revisions", revision); this.revisions.set(revision.id, structuredClone(revision)); this.emit(); }
	async prepare(sessionId: string, nodeIds: string[], targetPath: string, signal?: AbortSignal): Promise<CurationContext> { await this.ready(); return prepareCuration(this.app, this.workspace, this.backendFor, sessionId, nodeIds, targetPath, signal, this.search); }
	cached(context: CurationContext): CurationReview | undefined { return [...this.reviews.values()].reverse().filter(review => review.context.key === context.key && review.state === "ready").sort((a, b) => b.updated.localeCompare(a.updated))[0]; }
	generate(context: CurationContext, force = false, prepared?: (review: CurationReview) => Promise<void>): Promise<CurationReview> {
		if (this.operations.has(context.key)) { const operation = this.operations.get(context.key)!; return prepared ? operation.then(async review => { await prepared(review); return review; }) : operation; }
		const controller = new AbortController(); this.controllers.set(context.key, controller);
		const operation = this.run(context, controller.signal, force, prepared).finally(() => { this.operations.delete(context.key); this.controllers.delete(context.key); this.emit(); });
		this.operations.set(context.key, operation); return operation;
	}
	private async run(preparedContext: CurationContext, signal: AbortSignal, force: boolean, prepared?: (review: CurationReview) => Promise<void>): Promise<CurationReview> {
		await this.ready(); const context = structuredClone(preparedContext); await verifyCurationContext(this.app, this.workspace, context); signal.throwIfAborted();
		if (!context.sourceCompatible) throw new Error("当前论文与目标来源笔记不匹配，请重新选择目标");
		const cached = this.cached(context); if (cached && !force) { await prepared?.(cached); return cached; }
		const recovered = this.generationCache.get(context.key); if (recovered) { await this.save(recovered); this.generationCache.delete(context.key); await prepared?.(recovered); return recovered; }
		const stamp = now(); const review: CurationReview = { version: 1, id: id(), context, created: stamp, updated: stamp, state: "generating", suggestions: [], usage: { kind: "estimated", input: context.estimate, calls: 0, model: context.model, note: "文字输入估算；图像和推理开销以服务商实际计量为准" }, error: "" };
		await this.save(review);
		try {
			await prepared?.(structuredClone(review)); signal.throwIfAborted();
			const backend = this.backendFor(this.workspace.repository.get(context.sessionId));
			if (backend.name !== context.backendName || backend.model !== context.model) throw new Error("模型设置已变化，请重新准备本批整理");
			const source = await this.workspace.document(context.sessionId); const images: ReadingImage[] = [];
			for (const evidence of context.evidence.filter(item => item.visual)) { const original = source.evidence.find(item => "V:" + item.id === evidence.id); if (!original || !backend.images) throw new Error("本轮图像证据不可用"); const image = await source.image(original, signal); if (!image) throw new Error("图像证据缺失"); images.push({ ...image, evidenceId: evidence.id }); }
			signal.throwIfAborted(); review.usage.calls = 1; await this.save(review);
			const text = await backend.complete({ system: curationSkill, prompt: context.prompt, schema: CURATION_SCHEMA, images, signal, maxTokens: 4500, onUsage: usage => { review.usage = { ...review.usage, ...usage, kind: "reported", note: "服务商返回用量；可能包含缓存输入与推理开销" }; } });
			signal.throwIfAborted(); review.suggestions = parseCurationResult(text, context);
			if (review.usage.kind === "estimated") review.usage.output = estimatedTokens(text);
			await verifyCurationContext(this.app, this.workspace, context); signal.throwIfAborted(); review.state = "ready"; review.updated = now();
			this.generationCache.set(context.key, structuredClone(review)); await this.save(review); this.generationCache.delete(context.key); return review;
		} catch (error) {
			if (this.generationCache.has(context.key)) { this.errors.push("结果已生成但保存失败；本次运行中重试会复用结果，不再次调用模型"); throw error; }
			review.state = signal.aborted ? "interrupted" : "failed"; review.error = error instanceof Error ? error.message : "整理生成失败"; review.updated = now();
			if (review.usage.kind === "estimated") review.usage.note = "请求未完成；已发送的输入为估算，实际已消耗用量未知";
			await this.save(review); throw error;
		}
	}
	stop(key?: string): void { if (key) this.controllers.get(key)?.abort(); else this.controllers.forEach(controller => controller.abort()); }
	async decide(reviewId: string, suggestionId: string, decision: "pending" | "ignored", text?: string): Promise<void> {
		await this.serial(async () => {
			const existing = this.reviews.get(reviewId); if (!existing || existing.state !== "ready") throw new Error("整理记录尚不可编辑");
			const review = structuredClone(existing); const index = review.suggestions.findIndex(s => s.id === suggestionId); const before = review.suggestions[index];
			if (!before || before.decision === "applied") throw new Error("已应用的建议需从修订记录撤销");
			const suggestion: CurationSuggestion = text === undefined ? before : validateSuggestion({ ...before, text }, review.context, index); suggestion.decision = decision;
			review.suggestions[index] = suggestion; review.updated = now(); await this.save(review);
		});
	}
	async inspect(): Promise<void> {
		await this.ready(); await this.serial(async () => {
			for (const record of [...this.reviews.values()]) {
				if (record.state !== "ready" || record.suggestions.some(s => s.decision === "applied")) continue;
				try { await verifyCurationContext(this.app, this.workspace, record.context); }
				catch (error) { await this.save({ ...record, state: "stale", error: String(error), updated: now() }); }
			}
			for (const revision of [...this.revisions.values()].filter(value => value.state === "applied")) {
				const review = this.reviews.get(revision.reviewId); if (!review) continue;
				const current = [...this.revisions.values()].filter(value => value.state === "applied" && value.writes.some(write => write.role === "target" && write.path === review.context.target.path)).sort((a, b) => b.created.localeCompare(a.created))[0] || revision;
				try { await verifyCurationContext(this.app, this.workspace, review.context, current.writes.find(write => write.role === "target")!.afterHash); if (revision.needsReview) await this.saveRevision({ ...revision, needsReview: undefined, updated: now() }); }
				catch (error) { if (revision.needsReview !== String(error)) await this.saveRevision({ ...revision, needsReview: String(error), updated: now() }); }
			}
			this.changesPending = false; this.emit();
		});
	}
	async dispose(): Promise<void> { this.stop(); await Promise.allSettled([...this.operations.values()]); await this.queue; this.listeners.clear(); }
}
