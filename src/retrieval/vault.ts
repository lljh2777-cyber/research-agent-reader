import { TFile, type App } from "obsidian";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash, inKnowledgeScope } from "./chunks";
import type { KnowledgeDocument } from "./types";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value : value ? [value] : []).map(String);
export async function readKnowledgeDocuments(app: App, signal?: AbortSignal): Promise<KnowledgeDocument[]> {
	const files = app.vault.getMarkdownFiles().filter((file) => file instanceof TFile && inKnowledgeScope(file.path)).sort((a, b) => a.path.localeCompare(b.path));
	if (files.length > 5000) throw new Error("知识笔记超过 5,000 篇，当前索引范围需缩小");
	const docs: KnowledgeDocument[] = [];
	for (const [i, file] of files.entries()) {
		signal?.throwIfAborted(); const text = await app.vault.cachedRead(file); if (text.length > 250000) throw new Error("笔记过长，无法完整建立索引：" + file.path);
		const metadata = app.metadataCache.getFileCache(file)?.frontmatter || {};
		if (metadata.type === "learning-answer-excerpt" || /^type: learning-answer-excerpt\r?$/m.test(text.split(/^---\r?$/m)[1] || "")) continue;
		const sourcePaths = strings(metadata.sources).map((value) => value.replace(/^\[\[|\]\]$/g, "").split(/[|#]/)[0]).map((value) => value.endsWith(".md") ? value : value + ".md").filter((value) => value.startsWith("wiki/sources/") && inKnowledgeScope(value));
		docs.push({ path: file.path, title: String(metadata.title || file.basename).slice(0, 500), text, hash: contentHash(text), aliases: [...strings(metadata.aliases), ...strings(metadata.tags)],
			doi: String(metadata.doi || ""), year: String(metadata.year || ""), authors: strings(metadata.authors).join("; "), origins: file.path.startsWith("wiki/sources/") ? [file.path] : sourcePaths,
			depth: String(metadata.reading_depth || metadata.status || "未标注"), basis: String(metadata.evidence_basis || "未标注") });
		if (i % 25 === 24) await delay(0, undefined, { signal });
	}
	return docs;
}
