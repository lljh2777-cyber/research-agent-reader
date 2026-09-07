import type { App } from "obsidian";
import curationSkill from "../../skills/knowledge-curation/SKILL.md";
import { readingCategory, readingTitle } from "../reading/catalog";
import { selectReadingEvidence } from "../reading/document";
import type { ReadingBackend, ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";
import { contentHash, retrievalTerms } from "../retrieval/chunks";
import { curationParagraphs, curationTarget, estimatedTokens } from "./policy";
import { CURATION_RULE_VERSION, type CurationContext, type CurationEvidence } from "./types";
import { curationQuotes, selectCurationParagraphs, type CurationSearch } from "./selection";

export { curationSkill };
export function curationLearningHash(session: ReadingSession, nodeIds: string[]): string {
	return contentHash(JSON.stringify({ source: session.source, title: session.title, nodes: nodeIds.map(id => { const node = session.nodes.find(node => node.id === id); return node && { id: node.id, question: node.question, title: node.title, content: node.content, status: node.status, evidence: node.evidence }; }) }));
}
export async function prepareCuration(app: App, workspace: ReadingWorkspaceService, backendFor: (session: ReadingSession) => ReadingBackend, sessionId: string, requestedIds: string[], targetPath: string, signal?: AbortSignal, search?: CurationSearch): Promise<CurationContext> {
	signal?.throwIfAborted(); await workspace.ready(); const session = structuredClone(workspace.repository.get(sessionId)); const nodeIds = [...new Set(requestedIds)];
	if (readingCategory(session) !== "reading" || session.demo || !nodeIds.length || nodeIds.length > 3) throw new Error("每批请选择一至三个正式阅读节点");
	const nodes = nodeIds.map(id => session.nodes.find(node => node.id === id));
	if (nodes.some(node => !node || node.status !== "done")) throw new Error("只能整理已完成的阅读回答");
	if (!curationTarget(targetPath)) throw new Error("请选择已有的来源、概念、方法或综合笔记");
	const file = app.vault.getFileByPath(targetPath); if (!file) throw new Error("目标笔记不存在");
	const text = await app.vault.cachedRead(file); if (text.length > 160000) throw new Error("目标笔记超过本轮整理容量");
	const metadata = app.metadataCache.getFileCache(file)?.frontmatter || {}; const title = String(metadata.title || file.basename);
	if (targetPath.startsWith("wiki/sources/") && [metadata.reading_depth, metadata.status].includes("metadata-only")) throw new Error("目标仅有元数据，请先创建有依据的来源笔记正文");
	const query = nodes.map(node => node!.title + " " + node!.question).join(" ").slice(0, 1000);
	const { paragraphs, warnings, selection } = await selectCurationParagraphs(text, targetPath, query, search, signal);
	if (!paragraphs.length) throw new Error("目标笔记没有适合整理的正文段落");
	const backend = backendFor(session); const source = await workspace.document(sessionId); await source.verify();
	if (source.source.fingerprint !== session.source.fingerprint) throw new Error("原文已变化，请重新选择来源");
	const evidence: CurationEvidence[] = []; const preferred = nodes.flatMap(node => node!.evidence.filter(item => item.kind === "paper").map(item => item.id));
	const selected = selectReadingEvidence(source, query, 0, preferred).filter(item => !item.asset).slice(0, 5);
	for (const item of selected) evidence.push({ id: "P" + (evidence.length + 1), kind: "paper", path: session.source.path, hash: session.source.fingerprint, text: item.text.slice(0, 4000), label: item.label,
		role: "本文原文", depth: "原文文本，未升级阅读状态", origins: [session.source.path], start: item.start, end: item.start === undefined ? undefined : item.start + Math.min(item.text.length, 4000), page: item.page });
	const visuals = source.evidence.filter(item => item.asset && nodes.some(node => node!.evidence.some(previous => previous.id === item.id && previous.visualInspected))).slice(0, 2);
	if (visuals.length && !backend.images) warnings.push("当前后端不支持图像；图表判断需复核");
	if (backend.images) for (const item of visuals) evidence.push({ id: "V:" + item.id, kind: "paper", path: session.source.path, hash: session.source.fingerprint, text: item.text.slice(0, 1200), label: item.label, role: "本文原文", depth: "本轮附带图像", origins: [session.source.path], page: item.page, visual: true });
	// Supplement only from already-read, hash-matched formal evidence. Learning QA never enters this list.
	for (const item of nodes.flatMap(node => node!.evidence).filter(item => item.kind === "vault" && item.sourceHash)) {
		if (evidence.filter(e => e.kind === "vault").length >= 3 || evidence.some(e => e.path === item.path) || !curationTarget(item.path)) continue;
		const vaultFile = app.vault.getFileByPath(item.path); if (!vaultFile) continue; const raw = await app.vault.cachedRead(vaultFile);
		if (contentHash(raw) !== item.sourceHash || item.start === undefined || item.end === undefined || item.start < 0 || item.end > raw.length || item.end <= item.start) continue;
		const meta = app.metadataCache.getFileCache(vaultFile)?.frontmatter || {};
		evidence.push({ id: "K" + (evidence.length + 1), kind: "vault", path: item.path, hash: item.sourceHash!, text: raw.slice(item.start, Math.min(item.end, item.start + 2000)), label: item.label, role: item.role || "来源层级未标注", depth: String(meta.reading_depth || meta.status || "未标注"), origins: item.origins || [], start: item.start, end: Math.min(item.end, item.start + 2000) });
	}
	if (!evidence.length) throw new Error("Vault 中未找到足够依据，暂不能生成整理建议");
	const key = session.source.path.replace(/\\/g, "/").match(/papers\/([^/]+)\/article\.md$/)?.[1];
	const normalize = (value: unknown): string => String(value || "").replace(/\\/g, "/").toLowerCase().trim();
	const titleText = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
	const pdfTitle = session.source.kind === "pdf" && titleText(title).length >= 30 && titleText(source.evidence.filter(item => !item.asset && item.page !== undefined && item.page <= 2).map(item => item.text).join(" ").slice(0, 18000)).includes(titleText(title));
	const sourceCompatible = !targetPath.startsWith("wiki/sources/") || (key && targetPath === "wiki/sources/" + key + ".md") || pdfTitle || normalize(title) === normalize(session.source.title) || [metadata.source_path, metadata.pdf, metadata.source_pdf, metadata.article_path].some(value => value && normalize(value) === normalize(session.source.path));
	if (!sourceCompatible) warnings.push("目标来源笔记与当前论文身份未匹配；请选择同一论文或概念/方法笔记");
	for (const item of evidence) item.quotes = curationQuotes(item);
	const prompt = JSON.stringify({ instruction: "比较待核对的学习内容与目标段落。仅使用 evidence 的事实依据，不把学习回答当作证据。最多五条建议。", learning: nodes.map(node => ({ title: node!.title, question: node!.question, text: node!.content })),
		target: { title, category: targetPath.split("/")[1], depth: metadata.reading_depth || metadata.status || "未标注", paragraphs }, evidence: evidence.map(({ text: _text, quotes, ...item }) => ({ ...item, quotes })), sourceCompatible });
	const estimate = estimatedTokens(curationSkill + prompt); if (estimate > 18000) throw new Error("本批预计输入超过 18,000 token，请减少节点或选择更聚焦的目标笔记");
	const learningHash = curationLearningHash(session, nodeIds);
	const context: CurationContext = { ruleVersion: CURATION_RULE_VERSION, selection, key: "", sessionId, nodeIds, learningHash, title: readingTitle(session), source: session.source, target: { path: targetPath, title, text, hash: contentHash(text), paragraphs },
		evidence, backendId: session.backend, backendName: backend.name, model: backend.model, prompt, estimate, sourceCompatible: !!sourceCompatible, warnings };
	context.key = contentHash(JSON.stringify([CURATION_RULE_VERSION, curationSkill, learningHash, context.target.hash, evidence, session.backend, backend.name, backend.model, prompt]));
	signal?.throwIfAborted(); return context;
}
export async function verifyCurationContext(app: App, workspace: ReadingWorkspaceService, context: CurationContext, targetHash = context.target.hash): Promise<void> {
	const session = workspace.repository.get(context.sessionId);
	if (curationLearningHash(session, context.nodeIds) !== context.learningHash) throw new Error("学习内容已变化，请刷新整理范围");
	const target = app.vault.getFileByPath(context.target.path);
	if (!target || contentHash(await app.vault.cachedRead(target)) !== targetHash) throw new Error("目标笔记已变化，请重新预览");
	const source = await workspace.document(context.sessionId); await source.verify();
	if (source.source.fingerprint !== context.source.fingerprint) throw new Error("论文来源已变化，请重新核对证据");
	for (const evidence of context.evidence.filter(item => item.kind === "paper")) {
		if (evidence.path !== context.source.path || evidence.hash !== context.source.fingerprint || !source.evidence.some(item =>
			(evidence.visual ? "V:" + item.id === evidence.id && !!item.asset : !item.asset && item.start === evidence.start && item.page === evidence.page)
			&& item.text.startsWith(evidence.text))) throw new Error("保存的引用片段与原文不匹配，请重新读取依据");
	}
	for (const evidence of context.evidence.filter(item => item.kind === "vault")) { const file = app.vault.getFileByPath(evidence.path); if (!file || contentHash(await app.vault.cachedRead(file)) !== evidence.hash) throw new Error("引用的知识依据已变化，请重新生成建议"); }
}
