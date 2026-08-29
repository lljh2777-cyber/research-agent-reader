import type { WebSearchResult } from "../types/contracts";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_WEB_RESULTS = 8;
const MAX_RESULT_CHARS = 1_200;
const MAX_TOTAL_CHARS = 14_000;

export interface WebSearchHttpResult {
	status: number;
	json: Record<string, unknown> | null;
}

export interface WebSearchHttpDeps {
	httpRequest(options: {
		url: string;
		method: string;
		headers: Record<string, string>;
		body: unknown;
		timeoutMs: number;
	}): Promise<WebSearchHttpResult>;
}

export interface WebSearchOptions {
	maxResults: number;
	timeoutMs: number;
}

/**
 * Runs bounded Tavily searches for the given queries: one request per query
 * (≤3 queries from the caller), deduplicated by URL, hard result and content
 * caps so a single turn can never balloon.
 */
export async function searchTavily(
	deps: WebSearchHttpDeps,
	apiKey: string,
	queries: string[],
	options: WebSearchOptions,
): Promise<WebSearchResult[]> {
	const key = String(apiKey || "").trim();
	if (!key) throw new Error("未配置 Tavily API Key");
	const maxResults = Math.max(1, Math.min(MAX_WEB_RESULTS, Math.round(options.maxResults) || 5));
	const seenUrls = new Set<string>();
	const results: WebSearchResult[] = [];
	for (const query of queries) {
		const trimmed = String(query || "").trim();
		if (!trimmed) continue;
		let payload: Record<string, unknown> | null = null;
		try {
			const response = await deps.httpRequest({
				url: TAVILY_ENDPOINT,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${key}`,
				},
				body: {
					query: trimmed.slice(0, 400),
					max_results: maxResults,
					search_depth: "basic",
					include_answer: false,
				},
				timeoutMs: options.timeoutMs,
			});
			if (response.status === 401 || response.status === 403) {
				throw new Error("Tavily API Key 无效或未授权");
			}
			if (response.status === 429) {
				throw new Error("Tavily 配额已用尽（429）");
			}
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`Tavily 请求失败：HTTP ${response.status}`);
			}
			payload = response.json;
		} catch (error) {
			if (error instanceof Error && /Tavily/.test(error.message)) throw error;
			throw new Error(`Tavily 请求失败：${error instanceof Error ? error.message : String(error)}`);
		}
		const rawResults = Array.isArray(payload?.results) ? payload?.results : [];
		for (const raw of rawResults) {
			const record = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
			const url = String(record.url || "").trim();
			if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
			seenUrls.add(url);
			results.push({
				title: String(record.title || url).trim().slice(0, 300),
				url,
				content: String(record.content || "").trim().slice(0, MAX_RESULT_CHARS),
				publishedAt: String(record.published_date || "").trim().slice(0, 40),
			});
			if (results.length >= MAX_WEB_RESULTS) return results;
		}
	}
	return results;
}

/**
 * Renders numbered [1]…[n] evidence blocks for the answer prompt. Every block
 * stays under the per-result budget and the whole context under the total
 * budget so the composed prompt stays bounded.
 */
export function buildWebEvidenceContext(
	results: WebSearchResult[],
	options: { perResultChars?: number; totalChars?: number } = {},
): string {
	const perResultChars = Math.max(200, options.perResultChars ?? MAX_RESULT_CHARS);
	const totalChars = Math.max(perResultChars, options.totalChars ?? MAX_TOTAL_CHARS);
	const blocks: string[] = [];
	let remaining = totalChars;
	results.forEach((result, index) => {
		if (remaining <= 0) return;
		const content = result.content.slice(0, Math.min(perResultChars, remaining));
		const published = result.publishedAt ? `\n发布时间：${result.publishedAt}` : "";
		const block = `[${index + 1}] ${result.title}\n来源：${result.url}${published}\n内容：${content}`;
		blocks.push(block);
		remaining -= block.length;
	});
	return blocks.join("\n\n");
}
