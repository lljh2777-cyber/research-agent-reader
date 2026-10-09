import { setTimeout as delay } from "node:timers/promises";
import { ProviderHttpTransport } from "../providers/http-transport";
import { DIMENSIONS, EMBEDDING_MODEL, RERANK_MODEL, type RetrievalModels } from "./types";

export function normalizedVector(raw: unknown): Float32Array {
	if (!Array.isArray(raw) || raw.length !== DIMENSIONS || !raw.every(Number.isFinite)) throw new Error("嵌入响应维度或数值无效");
	const norm = Math.hypot(...raw); if (!Number.isFinite(norm) || !norm) throw new Error("嵌入响应不能为零向量");
	return Float32Array.from(raw, (value: number) => value / norm);
}
export class BgeModels implements RetrievalModels {
	private tail: Promise<unknown> = Promise.resolve(); private windowStart = 0; private windowBytes = 0;
	constructor(private secret: () => string, private transport = new ProviderHttpTransport()) {}
	private request(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const operation = this.tail.then(async () => {
			signal?.throwIfAborted(); const key = this.secret(); if (!key) throw new Error("请在钥匙串配置硅基流动密钥，并在检索设置选择它");
			const bytes = Buffer.byteLength(JSON.stringify(body));
			if (Date.now() - this.windowStart >= 60000) { this.windowStart = Date.now(); this.windowBytes = 0; }
			if (this.windowBytes + bytes > 360000) { await delay(Math.max(0, 60000 - (Date.now() - this.windowStart)), undefined, { signal }); this.windowStart = Date.now(); this.windowBytes = 0; }
			this.windowBytes += bytes;
			for (let attempt = 0; attempt < 3; attempt++) {
				let cancel: (() => void) | undefined; const abort = () => cancel?.();
				try {
					signal?.throwIfAborted(); signal?.addEventListener("abort", abort, { once: true });
					const response = await this.transport.request({ url: "https://api.siliconflow.cn/v1" + route, method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body,
						timeoutMs: 45000, maxResponseBytes: 8 * 1024 * 1024, registerCancel: (fn) => { cancel = fn; if (signal?.aborted) fn(); } });
					signal?.throwIfAborted(); if (!response.json) throw new Error("invalid-json"); return response.json;
				} catch (error) {
					signal?.throwIfAborted(); const status = Number((error as { status?: number }).status);
					if ([429, 503, 504].includes(status) && attempt < 2) { await delay(1000 * 2 ** attempt, undefined, { signal }); continue; }
					throw new Error(status ? "硅基流动请求失败（HTTP " + status + "）" : "硅基流动连接超时、响应中断或格式错误");
				} finally { signal?.removeEventListener("abort", abort); }
			}
			throw new Error("检索模型请求失败");
		}); this.tail = operation.catch(() => undefined); return operation;
	}
	async embed(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (!input.length || input.length > 16 || input.some((text) => !text.trim() || text.length > 5000)) throw new Error("嵌入输入超出本轮容量");
		const result = await this.request("/embeddings", { model: EMBEDDING_MODEL, input, encoding_format: "float" }, signal);
		if (result.model && result.model !== EMBEDDING_MODEL || !Array.isArray(result.data) || result.data.length !== input.length) throw new Error("嵌入响应与请求不一致");
		const output: Float32Array[] = []; const seen = new Set<number>();
		for (const item of result.data) { if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || seen.has(item.index)) throw new Error("嵌入响应索引无效"); seen.add(item.index); output[item.index] = normalizedVector(item.embedding); }
		return output;
	}
	async rerank(query: string, input: string[], signal?: AbortSignal): Promise<Array<{ index: number; score: number }>> {
		if (!input.length) return [];
		if (input.length > 64 || query.length > 1000 || input.some((text) => text.length > 5000)) throw new Error("重排输入超出本轮容量");
		const result = await this.request("/rerank", { model: RERANK_MODEL, query, documents: input, top_n: input.length, return_documents: false }, signal);
		if (!Array.isArray(result.results) || result.results.length !== input.length) throw new Error("重排响应不完整");
		const seen = new Set<number>();
		return result.results.map((item) => { if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || seen.has(item.index) || !Number.isFinite(item.relevance_score)) throw new Error("重排响应索引或数值无效"); seen.add(item.index); return { index: item.index, score: item.relevance_score }; });
	}
}
