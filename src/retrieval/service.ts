import { setTimeout as delay } from "node:timers/promises";
import { chunkDocument, lexicalChunks, paperScope } from "./chunks";
import { EMBEDDING_MODEL, INDEX_VERSION, type IndexStatus, type KnowledgeChunk, type KnowledgeDocument, type KnowledgeHit, type KnowledgeResult, type RetrievalMode, type RetrievalModels, type SearchOptions, type VectorSnapshot, type VectorStorage } from "./types";

export function reciprocalRankFusion(lists: KnowledgeChunk[][], limit = 64): KnowledgeChunk[] {
	const values = new Map<string, { chunk: KnowledgeChunk; score: number }>();
	for (const list of lists) { const seen = new Set<string>(); list.forEach((chunk, i) => { if (seen.has(chunk.id)) return; seen.add(chunk.id); const current = values.get(chunk.id); values.set(chunk.id, { chunk, score: (current?.score || 0) + 1 / (60 + i + 1) }); }); }
	return [...values.values()].sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id)).slice(0, limit).map((value) => value.chunk);
}
export class KnowledgeRetrievalService {
	private snapshot: VectorSnapshot | null = null; private loading: Promise<void> | null = null;
	private controller: AbortController | null = null; private building: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	private searches = new Set<AbortController>();
	status: IndexStatus = { state: "idle", done: 0, total: 0, documents: 0, changed: 0, updated: "", message: "索引尚未建立" };
	constructor(private readDocuments: (signal?: AbortSignal) => Promise<KnowledgeDocument[]>, private storage: VectorStorage, private models: RetrievalModels, private mode: () => RetrievalMode) {}
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private emit(): void { this.listeners.forEach((listener) => { try { listener(); } catch { /* View may have closed. */ } }); }
	private load(): Promise<void> {
		if (!this.loading) this.loading = (async () => {
			try { this.snapshot = await this.storage.read(); if (this.snapshot) this.status = { ...this.status, state: "ready", updated: this.snapshot.updated, documents: Object.keys(this.snapshot.documentHashes).length, done: this.snapshot.vectors.size, total: this.snapshot.vectors.size, message: "已恢复本地索引" }; }
			catch { this.status = { ...this.status, state: "error", message: "索引无法读取，查询会回退关键词；可重新更新索引" }; }
			this.emit();
		})(); return this.loading;
	}
	private async corpus(signal?: AbortSignal): Promise<{ docs: KnowledgeDocument[]; chunks: KnowledgeChunk[] }> {
		const docs = await this.readDocuments(signal); const chunks: KnowledgeChunk[] = [];
		for (const [i, doc] of docs.entries()) { signal?.throwIfAborted(); chunks.push(...chunkDocument(doc)); if (chunks.length > 20000) throw new Error("知识库超过 20,000 个片段上限"); if (i % 20 === 19) await delay(0, undefined, { signal }); }
		return { docs, chunks };
	}
	async inspect(): Promise<IndexStatus> {
		await this.load(); if (this.building) return { ...this.status };
		const { docs, chunks } = await this.corpus();
		const livePaths = new Set(docs.map((doc) => doc.path));
		this.status = { ...this.status, documents: docs.length, total: chunks.length, done: chunks.filter((chunk) => this.snapshot?.vectors.has(chunk.vectorKey)).length,
			changed: docs.filter((doc) => this.snapshot?.documentHashes[doc.path] !== doc.hash).length + Object.keys(this.snapshot?.documentHashes || {}).filter((file) => !livePaths.has(file)).length };
		this.emit(); return { ...this.status };
	}
	update(): Promise<void> {
		if (this.building) return this.building;
		const controller = new AbortController(); this.controller = controller;
		this.building = this.build(controller.signal).finally(() => { this.building = null; this.controller = null; this.emit(); }); return this.building;
	}
	stop(): void { this.controller?.abort(); }
	dispose(): void { this.stop(); this.searches.forEach((controller) => controller.abort()); this.listeners.clear(); }
	private async build(signal: AbortSignal): Promise<void> {
		await this.load();
		this.status = { ...this.status, state: "building", message: "正在读取知识笔记…" }; this.emit();
		try {
			const { docs, chunks } = await this.corpus(signal); const vectors = new Map<string, Float32Array>();
			for (const chunk of chunks) { const vector = this.snapshot?.vectors.get(chunk.vectorKey); if (vector) vectors.set(chunk.vectorKey, vector); }
			const pending = [...new Map(chunks.filter((chunk) => !vectors.has(chunk.vectorKey)).map((chunk) => [chunk.vectorKey, chunk])).values()];
			this.status = { ...this.status, state: "building", total: chunks.length, documents: docs.length, done: chunks.filter((chunk) => vectors.has(chunk.vectorKey)).length, message: "正在构建向量；已有片段复用缓存，限流时会等待" }; this.emit();
			const save = async () => { const snapshot: VectorSnapshot = { version: INDEX_VERSION, model: EMBEDDING_MODEL, vectors: new Map(vectors), documentHashes: Object.fromEntries(docs.map((doc) => [doc.path, doc.hash])), updated: new Date().toISOString() }; await this.storage.write(snapshot); this.snapshot = snapshot; };
			for (let i = 0; i < pending.length; i += 16) {
				signal.throwIfAborted(); const batch = pending.slice(i, i + 16); const result = await this.models.embed(batch.map((chunk) => chunk.input), signal); signal.throwIfAborted();
				if (result.length !== batch.length) throw new Error("嵌入响应数目不一致"); result.forEach((vector, index) => vectors.set(batch[index].vectorKey, vector));
				// Checkpoint successful batches so stop/restart never repeats all uploads.
				await save(); this.status.done = chunks.filter((chunk) => vectors.has(chunk.vectorKey)).length; this.emit(); await delay(0, undefined, { signal });
			}
			signal.throwIfAborted(); await save();
			const latest = await this.readDocuments(signal); const latestHashes = Object.fromEntries(latest.map((doc) => [doc.path, doc.hash]));
			const changed = [...new Set([...Object.keys(latestHashes), ...Object.keys(this.snapshot!.documentHashes)])].filter((file) => latestHashes[file] !== this.snapshot!.documentHashes[file]).length;
			this.status = { ...this.status, state: "ready", changed, updated: this.snapshot!.updated, message: changed ? "构建期间原文有变化，请再次更新；旧向量不会关联新文本" : "索引已更新" };
		} catch (error) { this.status = { ...this.status, state: signal.aborted ? "interrupted" : "error", message: signal.aborted ? "索引已停止，已完成的片段保留，可继续更新" : (error instanceof Error ? error.message : "索引更新失败") }; if (!signal.aborted) throw error; }
		finally { this.emit(); }
	}
	async search(rawQuery: string, options: SearchOptions = {}): Promise<KnowledgeResult> {
		options.signal?.throwIfAborted(); const controller = new AbortController(); const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true }); this.searches.add(controller);
		try { return await this.searchSnapshot(rawQuery, { ...options, signal: controller.signal }); }
		finally { options.signal?.removeEventListener("abort", abort); this.searches.delete(controller); }
	}
	private async searchSnapshot(rawQuery: string, options: SearchOptions): Promise<KnowledgeResult> {
		const query = rawQuery.trim().slice(0, 1000); const signal = options.signal; signal?.throwIfAborted(); await this.load();
		const { docs, chunks: all } = await this.corpus(signal); const scope = paperScope(options.identityQuery || query, docs, options.paperPaths);
		const chunks = scope ? all.filter((chunk) => scope.includes(chunk.path)) : all;
		const warnings: string[] = []; const indexed = chunks.filter((chunk) => this.snapshot?.vectors.has(chunk.vectorKey));
		const base = { warnings, scope, documents: docs.length, indexedChunks: indexed.length, totalChunks: chunks.length };
		if (!query || scope && !scope.length) return { ...base, mode: "lexical", hits: [], warnings: ["未找到指定论文的来源笔记，未扩大到其他论文"] };
		const ideas = /研究思路|研究方向|启发|设想|research ideas/i.test(options.identityQuery || query);
		const eligible = chunks.filter((chunk) => ideas || !["navigation", "speculation"].includes(chunk.role));
		const lexical = lexicalChunks(eligible, query); let mode = this.mode(); let candidates: KnowledgeChunk[] = lexical.slice(0, 64);
		if (mode === "hybrid") {
			if (indexed.length < chunks.length) warnings.push(`向量已覆盖 ${indexed.length}/${chunks.length} 个片段；新增或变化内容仍参加关键词检索，请更新索引`);
			if (!indexed.length) { mode = "rerank"; warnings.push("尚无可用向量，本轮使用关键词＋重排"); }
			else try {
				const [vector] = await this.models.embed([query], signal); signal?.throwIfAborted();
				const dense = eligible.filter((chunk) => this.snapshot!.vectors.has(chunk.vectorKey)).map((chunk) => {
					let score = 0; const target = this.snapshot!.vectors.get(chunk.vectorKey)!; for (let i = 0; i < vector.length; i++) score += vector[i] * target[i]; return { ...chunk, score };
				}).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
				candidates = reciprocalRankFusion([lexical.slice(0, 64), dense.slice(0, 64)]);
			} catch (error) { signal?.throwIfAborted(); warnings.push((error as Error).message + "；本轮已回退关键词"); mode = "lexical"; candidates = lexical.slice(0, 64); }
		}
		let ranked: KnowledgeHit[] = candidates.map((chunk) => ({ ...chunk, score: lexical.find((item) => item.id === chunk.id)?.score || 0 }));
		if (mode !== "lexical" && candidates.length) try {
			const result = await this.models.rerank(query, candidates.map((chunk) => chunk.input), signal); signal?.throwIfAborted();
			ranked = result.map(({ index, score }) => ({ ...candidates[index], score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		} catch (error) { signal?.throwIfAborted(); warnings.push((error as Error).message + "；重排不可用，已回退关键词"); mode = "lexical"; ranked = lexical.slice(0, 64); }
		// Keep two passages per document, not just its highest scoring introduction.
		const counts = new Map<string, number>(); const hits: KnowledgeHit[] = []; const limit = Math.max(1, Math.min(10, options.limit || 6));
		for (const hit of ranked) { if (!counts.has(hit.path) && counts.size >= limit || (counts.get(hit.path) || 0) >= 2) continue; counts.set(hit.path, (counts.get(hit.path) || 0) + 1); hits.push(hit); }
		// Source edits during a request invalidate the returned evidence, even if the model completed.
		const live = new Map((await this.readDocuments(signal)).map((doc) => [doc.path, doc.hash])); const fresh = hits.filter((hit) => live.get(hit.path) === hit.hash);
		if (fresh.length !== hits.length) warnings.push("检索期间来源发生变化，已排除旧片段，请重试"); signal?.throwIfAborted();
		return { ...base, mode, hits: fresh };
	}
}
