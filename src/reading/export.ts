import { TFile, type App } from "obsidian";
import { derivePassiveMineruMarkdown, validateModelNoteBodyMarkdown } from "../security/safe-markdown";
import { sanitizeQueryNoteFilename } from "../services/query-note";
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
export function readingExportContent(session: ReadingSession, scope: ReadingExportScope, nodeId: string): string {
	const selected = session.nodes.find((node) => node.id === nodeId);
	if (scope !== "session" && !selected) throw new Error("请先选择要导出的节点");
	const nodes = session.nodes.filter((node) => node.status === "done" && (scope === "session" || scope === "node" && node.id === nodeId || scope === "branch" && (selected!.branchId ? node.branchId === selected!.branchId : node.id === nodeId)));
	if (!nodes.length) throw new Error("没有可导出的已完成回答");
	const body = ["# " + safeReadingMarkdown(session.title).trim(), "", "本文记录交互学习过程，学习进度不代表正式 X-Ray 核验状态。", "",
		"原文位置：" + readingPathCode(session.source.path), "", "会话：" + readingPathCode(session.id), ""];
	for (const node of nodes) {
		body.push("## " + safeReadingMarkdown(node.title).trim(), "", "节点：" + readingPathCode(node.id) + (node.parentId ? "；起点：" + readingPathCode(node.parentId) : "；主线起点"), "");
		if (node.question) body.push("问题：" + safeReadingMarkdown(node.question), "");
		if (node.quote) body.push("引用：" + safeReadingMarkdown(node.quote.text), "");
		body.push(safeReadingMarkdown(node.content), "", "依据：", "");
		for (const evidence of node.evidence) body.push("- " + readingPathCode(evidence.id) + " " + (evidence.kind === "paper" ? "本文" : "知识库补充") + "：" + readingPathCode(evidence.path)
			+ (evidence.page ? "，第 " + evidence.page + " 页" : "") + (evidence.visualInspected ? "，已查看图像" : ""));
		body.push("");
	}
	return ["---", "title: " + JSON.stringify(session.title + " · 学习记录"), "type: qa", "tags: [qa, reading]", "created: " + new Date().toISOString(), "reading_session: " + JSON.stringify(session.id), "---", "", ...body].join("\n");
}
let exportQueue: Promise<unknown> = Promise.resolve();
export function exportReading(app: App, session: ReadingSession, scope: ReadingExportScope, nodeId: string): Promise<{ path: string; warning?: string }> {
	const snapshot = structuredClone(session);
	const operation = exportQueue.then(async () => {
		const text = readingExportContent(snapshot, scope, nodeId);
		for (const folder of ["wiki", "wiki/qa"]) if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
		const basename = "wiki/qa/" + new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-") + " " + sanitizeQueryNoteFilename(snapshot.title);
		let filename = basename + ".md"; let number = 2;
		while (app.vault.getAbstractFileByPath(filename)) filename = basename + " " + number++ + ".md";
		await app.vault.create(filename, text);
		const line = "\n- " + new Date().toISOString() + " 导出交互学习记录：[[" + filename.slice(0, -3) + "]]；会话 " + readingPathCode(snapshot.id) + "。\n";
		try {
			const log = app.vault.getAbstractFileByPath("wiki/log.md");
			if (log instanceof TFile) await app.vault.process(log, (current) => current + line);
			else await app.vault.create("wiki/log.md", "# 知识库维护日志\n" + line);
			return { path: filename };
		} catch (error) { return { path: filename, warning: "笔记已导出，但日志追加失败：" + String(error) }; }
	}); exportQueue = operation.catch(() => undefined); return operation;
}
