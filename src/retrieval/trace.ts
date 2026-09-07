import type { RetrievalTrace } from "../query/direct-query-service";
import type { KnowledgeResult } from "./types";

export function knowledgeTrace(result: KnowledgeResult): RetrievalTrace {
	const paths = [...new Set(result.hits.map((hit) => hit.path))];
	return {
		stage: "in-plugin-" + result.mode, retrieval_label: { lexical: "关键词片段检索", rerank: "关键词＋BGE 重排", hybrid: "混合检索＋BGE 重排" }[result.mode],
		candidate_paths: paths, lexical_seeds: paths.map((file) => { const hit = result.hits.find((item) => item.path === file)!; return { path: file, title: hit.title, score: hit.score }; }),
		knowledge: { mode: result.mode, scope: result.scope, warnings: result.warnings, indexedChunks: result.indexedChunks, totalChunks: result.totalChunks },
		knowledge_passages: result.hits.map(({ input: _input, vectorKey: _key, ...passage }) => passage),
	};
}
