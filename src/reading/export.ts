import { TFile, type App } from "obsidian";
import { derivePassiveMineruMarkdown, validateModelNoteBodyMarkdown } from "../security/safe-markdown";
import { sanitizeQueryNoteFilename } from "../services/query-note";
import { contentHash, inKnowledgeScope } from "../retrieval/chunks";
import type { ReadingSession } from "./types";

export function safeReadingMarkdown(text: string): string {
	const passive = derivePassiveMineruMarkdown(text).replace(/!\[([^\]\n]*)\]\([^\n]*?\)/g, (_, alt: string) => "（图像：" + alt.replace(/[\[\]<>]/g, "") + "；请从证据窗口查看）");
	if (validateModelNoteBodyMarkdown(passive).length) throw new Error("回答包含无法安全显示的 Markdown"); return passive;
}
export function readingPathCode(value: string): string {
	const longest = Math.max(0, ...(value.match(/`+/g) || []).map((item) => item.length)); const fence = "`".repeat(longest + 1);
	return fence + " " + value.replace(/[\r\n]/g, " ") + " " + fence;
}
export type ReadingExportScope = "node" | "branch" | "session";
export interface ReadingExportOptions { related?: string[]; revisionOf?: string; created?: string; }
export interface ReadingExportRecord { path: string; hash: string; text: string; created: string; }
export interface ReadingExportReview { key: string; hash: string; text: string; history: ReadingExportRecord[]; duplicate?: ReadingExportRecord; revisionOf?: string; }
export const safeRelatedPath = (path: string): boolean => inKnowledgeScope(path) && !/[\\[\]|#%<>:\r\n]/.test(path) && !path.split("/").some(part => !part);
export function readingNodeContentHash(node: ReadingSession["nodes"][number]): string { return contentHash(JSON.stringify([node.title, node.question, node.content, node.quote, node.evidence, ...(node.acceptedCorrectionId || node.correction ? [node.acceptedCorrectionId, node.correction] : [])])); }
const relatedPaths = (options: ReadingExportOptions): string[] => [...new Set((options.related || []).filter(safeRelatedPath))].sort();
const wikiLink = (path: string): string => "[[" + path.replace(/\.md$/i, "") + "]]";
export function readingExportNodes(session: ReadingSession, scope: ReadingExportScope, nodeId: string): ReadingSession["nodes"] {
	const selected = session.nodes.find((node) => node.id === nodeId);
	if (scope !== "session" && !selected) throw new Error("请先选择要导出的节点");
	const nodes = session.nodes.filter((node) => node.status === "done" && (scope === "session" || scope === "node" && node.id === nodeId || scope === "branch" && (selected!.branchId ? node.branchId === selected!.branchId : node.id === nodeId)));
	if (!nodes.length) throw new Error("没有可导出的已完成回答");
	return nodes;
}
export function readingExportKey(session: ReadingSession, scope: ReadingExportScope, nodeId: string): string {
	const selected = session.nodes.find(node => node.id === nodeId);
	return contentHash(JSON.stringify([session.id, scope, scope === "session" ? "all" : scope === "branch" ? selected?.branchId || nodeId : nodeId]));
}
function exportBody(session: ReadingSession, scope: ReadingExportScope, nodeId: string, options: ReadingExportOptions): string {
	const nodes = readingExportNodes(session, scope, nodeId);
	const body = ["# " + safeReadingMarkdown(session.title).trim(), "", "本文记录交互学习过程，学习进度不代表正式 X-Ray 核验状态。", "",
		"原文位置：" + readingPathCode(session.source.path), ""];
	for (const node of nodes) {
		body.push("## " + safeReadingMarkdown(node.title).trim(), "");
		const trail: string[] = []; let current = node;
		while (current.branchId) {
			const branch = session.branches.find((b) => b.id === current.branchId)!;
			trail.unshift("支线 " + (session.branches.indexOf(branch) + 1) + " 第 " + (branch.nodeIds.indexOf(current.id) + 1) + " 轮");
			current = session.nodes.find((n) => n.id === branch.parentNodeId)!;
		}
		trail.unshift("主线第 " + (session.mainIds.indexOf(current.id) + 1) + " 单元");
		body.push("学习位置：" + trail.join(" → "), "");
		if (node.question) body.push("问题：" + safeReadingMarkdown(node.question), "");
		if (node.quote) body.push("引用：" + safeReadingMarkdown(node.quote.text), "");
		if (node.correction) body.push("核对版本：对应原回答 " + readingPathCode(node.correction.of) + "；" + (session.nodes.some(n => n.acceptedCorrectionId === node.id) ? "用户已选为后续背景" : "尚未选为后续背景") + "。", "");
		if (node.acceptedCorrectionId) body.push("此处保留历史回答；用户已选用后续核对节点 " + readingPathCode(node.acceptedCorrectionId) + " 作为背景，请同时查阅该节点。", "");
		body.push(safeReadingMarkdown(node.content), "", "依据：", "");
		for (const evidence of node.evidence) body.push("- " + readingPathCode(evidence.id) + " " + (evidence.kind === "paper" ? "本文" : "知识库补充") + "：" + readingPathCode(evidence.path)
			+ (evidence.page ? "，第 " + evidence.page + " 页" : "") + (evidence.start !== undefined ? "，阅读文本字符 " + evidence.start + "–" + evidence.end : "") + (evidence.visualInspected ? "，已查看图像" : "")
			+ (evidence.role ? "；" + safeReadingMarkdown(evidence.role) : "") + (evidence.heading ? "；章节：" + safeReadingMarkdown(evidence.heading) : ""));
		body.push("");
	}
	const related = relatedPaths(options);
	if (related.length) body.push("## 关联笔记", "", "以下关联由导出时选定，用于继续阅读；关联本身不代表结论一致或独立证据。", "", ...related.map(path => "- " + wikiLink(path)), "");
	return body.join("\n");
}
export function readingExportHash(session: ReadingSession, scope: ReadingExportScope, nodeId: string, options: ReadingExportOptions = {}): string {
	return contentHash(session.source.fingerprint + "\n" + exportBody(session, scope, nodeId, options));
}
export function readingExportContent(session: ReadingSession, scope: ReadingExportScope, nodeId: string, options: ReadingExportOptions = {}): string {
	const revision = options.revisionOf && /^wiki\/qa\/[^\r\n\[\]|#<>]+\.md$/.test(options.revisionOf) && !options.revisionOf.includes("..") ? options.revisionOf : "";
	return ["---", "title: " + JSON.stringify(session.title + " · 学习记录"), "type: qa", "tags: [qa, reading]", "created: " + (options.created || new Date().toISOString()), "reading_session: " + JSON.stringify(session.id),
		"reading_export_key: " + readingExportKey(session, scope, nodeId), "reading_content_hash: " + readingExportHash(session, scope, nodeId, options), "reading_source_fingerprint: " + JSON.stringify(session.source.fingerprint),
		"reading_nodes: " + JSON.stringify(readingExportNodes(session, scope, nodeId).map(node => ({ id: node.id, parent: node.parentId, branch: node.branchId, hash: readingNodeContentHash(node) }))),
		"related_notes: " + JSON.stringify(relatedPaths(options)), ...(revision ? ["reading_revision_of: " + JSON.stringify(revision)] : []), "---", "",
		...(revision ? ["上一版：" + wikiLink(revision), ""] : []), exportBody(session, scope, nodeId, options)].join("\n");
}
/** Read generated QA metadata directly: the metadata cache can lag a just-created export. */
export async function readingExportHistory(app: App, key: string): Promise<ReadingExportRecord[]> {
	const records: ReadingExportRecord[] = [];
	for (const file of app.vault.getMarkdownFiles().filter(file => file.path.startsWith("wiki/qa/") && file instanceof TFile)) {
		const text = await app.vault.cachedRead(file); const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] || "";
		if (/^reading_export_key: ([a-f0-9]{64})\r?$/m.exec(fm)?.[1] !== key) continue;
		const hash = /^reading_content_hash: ([a-f0-9]{64})\r?$/m.exec(fm)?.[1]; if (!hash) continue;
		records.push({ path: file.path, hash, text, created: /^created: (.+)\r?$/m.exec(fm)?.[1].trim() || "" });
	}
	return records.sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));
}
export async function reviewReadingExport(app: App, session: ReadingSession, scope: ReadingExportScope, nodeId: string, options: ReadingExportOptions = {}): Promise<ReadingExportReview> {
	const key = readingExportKey(session, scope, nodeId); const hash = readingExportHash(session, scope, nodeId, options);
	const history = await readingExportHistory(app, key); const duplicate = history.find(record => record.hash === hash); const revisionOf = history[0]?.path;
	return { key, hash, history, duplicate, revisionOf, text: readingExportContent(session, scope, nodeId, { ...options, revisionOf }) };
}
let exportQueue: Promise<unknown> = Promise.resolve();
export function exportReading(app: App, session: ReadingSession, scope: ReadingExportScope, nodeId: string, options: ReadingExportOptions & { expectedHash?: string; relatedHashes?: Record<string, string> } = {}, prepared?: (receipt: { path: string; hash: string; reused: boolean }) => Promise<void>): Promise<{ path: string; warning?: string; reused?: boolean }> {
	const snapshot = structuredClone(session);
	const chosen = structuredClone(options);
	const operation = exportQueue.then(async () => {
		const review = await reviewReadingExport(app, snapshot, scope, nodeId, chosen);
		if (chosen.expectedHash && review.hash !== chosen.expectedHash) throw new Error("导出内容已变化，请重新查看预览");
		for (const path of relatedPaths(chosen)) {
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new Error("关联笔记已移动或缺失，请刷新候选：" + path);
			if (chosen.relatedHashes?.[path] && contentHash(await app.vault.cachedRead(file)) !== chosen.relatedHashes[path]) throw new Error("关联笔记已变化，请重新查找关联：" + path);
		}
		if (review.duplicate) { await prepared?.({ path: review.duplicate.path, hash: contentHash(review.duplicate.text), reused: true }); return { path: review.duplicate.path, reused: true }; }
		const text = review.text;
		for (const folder of ["wiki", "wiki/qa"]) if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
		const basename = "wiki/qa/" + new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-") + " " + sanitizeQueryNoteFilename(snapshot.title);
		let filename = basename + ".md"; let number = 2;
		while (app.vault.getAbstractFileByPath(filename)) filename = basename + " " + number++ + ".md";
		await prepared?.({ path: filename, hash: contentHash(text), reused: false });
		await app.vault.create(filename, text);
		const line = "\n- " + new Date().toISOString() + " 导出交互学习记录：[[" + filename.slice(0, -3) + "]]；会话 " + readingPathCode(snapshot.id) + "；内容指纹 " + readingPathCode(review.hash)
			+ (review.revisionOf ? "；上一版 " + readingPathCode(review.revisionOf) : "") + "。\n";
		try {
			const log = app.vault.getAbstractFileByPath("wiki/log.md");
			if (log instanceof TFile) await app.vault.process(log, (current) => current + line);
			else await app.vault.create("wiki/log.md", "# 知识库维护日志\n" + line);
			return { path: filename };
		} catch (error) { return { path: filename, warning: "笔记已导出，但日志追加失败：" + String(error) }; }
	}); exportQueue = operation.catch(() => undefined); return operation;
}
