import type { App } from "obsidian";
import { isTopicExportPath } from "../topic-learning/export-path";
import { setTimeout as delay } from "node:timers/promises";
import { readingCategory, readingTitle } from "../reading/catalog";
import type { ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";
import { contentHash } from "../retrieval/chunks";
import { KnowledgeRetrievalService } from "../retrieval/service";
import type { KnowledgeDocument, RetrievalModels, RetrievalMode, VectorStorage } from "../retrieval/types";

export interface LearningDocument extends KnowledgeDocument { sessionId?: string; nodeId?: string; recordKind: "reading" | "qa"; sourceIdentity: string; }
export interface LearningMatch { path: string; title: string; excerpt: string; relation: "exact-text" | "related"; sessionId?: string; nodeId?: string; sourceIdentity: string; }
export const learningTextHash = (text: string): string => contentHash(text.replace(/\s+/g, " ").trim());
const document = (path: string, title: string, text: string, extras: Pick<LearningDocument, "recordKind" | "sourceIdentity"> & Partial<LearningDocument>): LearningDocument => ({ path, title, text, hash: contentHash(text), aliases: [], doi: "", year: "", authors: "", origins: [], depth: "学习记录", basis: "AI 学习记录，不作为论文证据", ...extras });
export function sessionLearningDocuments(session: ReadingSession): LearningDocument[] {
	if (readingCategory(session) !== "reading" || session.demo) return [];
	return session.nodes.filter(node => node.status === "done" && node.content.trim()).map(node => document("reading/" + session.id + "/" + node.id + ".md", readingTitle(session) + " · " + node.title,
		(node.question ? node.question + "\n\n" : "") + node.content, { recordKind: "reading", sourceIdentity: session.source.kind + ":" + session.source.fingerprint, sessionId: session.id, nodeId: node.id }));
}
export class LearningLibrary {
	readonly index: KnowledgeRetrievalService;
	constructor(private app: App, private workspace: ReadingWorkspaceService, storage: VectorStorage, models: RetrievalModels, mode: () => RetrievalMode) {
		this.index = new KnowledgeRetrievalService(signal => this.documents(signal), storage, models, mode);
	}
	async documents(signal?: AbortSignal): Promise<LearningDocument[]> {
		await this.workspace.ready(); const docs: LearningDocument[] = [];
		for (const session of this.workspace.repository.sessions.values()) { signal?.throwIfAborted(); docs.push(...sessionLearningDocuments(session)); if (docs.length > 10000) throw new Error("学习记录超过一万个节点，当前索引容量不足"); }
		const excludedSessions = new Set([...this.workspace.repository.sessions.values()].filter(session => readingCategory(session) !== "reading" || session.demo).map(session => session.id));
		for (const [i, file] of this.app.vault.getMarkdownFiles().filter(file => /^wiki\/qa\/[^\\]+\.md$/i.test(file.path) && !isTopicExportPath(file.path) && !file.path.split("/").some(part => part.startsWith("."))).entries()) {
			signal?.throwIfAborted(); const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
			if (metadata.type === "topic-learning-record" || metadata.demo === true || ["demo", "test"].includes(metadata.purpose) || excludedSessions.has(metadata.reading_session)) continue;
			const raw = await this.app.vault.cachedRead(file); if (raw.length > 250000) throw new Error("学习笔记过长，请缩小学习索引范围：" + file.path);
			const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
			docs.push(document(file.path, String(metadata.title || file.basename), body, { recordKind: "qa", sourceIdentity: String(metadata.reading_source_fingerprint || "来源未核验") }));
			if (i % 20 === 19) await delay(0, undefined, { signal });
		}
		return docs;
	}
	async find(session: ReadingSession, nodeIds: string[], signal?: AbortSignal): Promise<{ matches: LearningMatch[]; warnings: string[] }> {
		const selected = sessionLearningDocuments(session).filter(doc => nodeIds.includes(doc.nodeId!));
		if (!selected.length) throw new Error("请选择已完成的正式阅读节点");
		const docs = (await this.documents(signal)).filter(doc => doc.sessionId !== session.id);
		if (!docs.length) return { matches: [], warnings: ["尚无其他正式学习记录"] };
		const matches = new Map<string, LearningMatch>(); const hashes = new Set(selected.map(doc => learningTextHash(doc.text)));
		const add = (doc: LearningDocument, excerpt: string, relation: LearningMatch["relation"]): void => { if (!matches.has(doc.path)) matches.set(doc.path, { path: doc.path, title: doc.title, excerpt: excerpt.slice(0, 1800), relation, sessionId: doc.sessionId, nodeId: doc.nodeId, sourceIdentity: doc.sourceIdentity }); };
		for (const doc of docs) if (hashes.has(learningTextHash(doc.text))) add(doc, doc.text, "exact-text");
		const query = readingTitle(session).slice(0, 300) + "\n" + session.nodes.filter(node => nodeIds.includes(node.id)).map(node => node.title).join("；").slice(0, 600);
		const result = await this.index.search(query, { identityQuery: "学习记录关联", paperPaths: docs.map(doc => doc.path), signal, limit: 5 });
		const byPath = new Map(docs.map(doc => [doc.path, doc]));
		for (const hit of result.hits) { const doc = byPath.get(hit.path); if (doc && doc.hash === hit.hash) add(doc, hit.text, "related"); }
		return { matches: [...matches.values()].slice(0, 10), warnings: result.warnings };
	}
	dispose(): void { this.index.dispose(); }
}
