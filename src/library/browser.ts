import type { LibraryReadResult } from "./reader";
import type { LibraryObjectSummary, LibraryPaper, PaperReadingState } from "./types";

export type LibraryFilter = "all" | "sources" | "sessions" | "issues";
export interface LibraryBrowserState { phase: "idle" | "loading" | "ready" | "failed" | "cancelled"; result?: LibraryReadResult; error: string; }
/** A single scan at a time; cancellation/close revoke publication, including late results. */
export class LibraryBrowserController {
	state: LibraryBrowserState = { phase: "idle", error: "" };
	private controller?: AbortController;
	private pending?: Promise<void>;
	private closed = false;
	get busy(): boolean { return Boolean(this.pending); }
	constructor(private readonly inspect: (signal: AbortSignal, verifyPath?: string) => Promise<LibraryReadResult>, private readonly changed: () => void) {}
	refresh(verifyPath?: string): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.pending) return this.pending;
		const controller = new AbortController(); this.controller = controller;
		this.state = { ...this.state, phase: "loading", error: "" };
		const operation = Promise.resolve().then(async () => {
			try {
				controller.signal.throwIfAborted();
				const result = await this.inspect(controller.signal, verifyPath);
				if (!this.closed && !controller.signal.aborted) this.state = { phase: "ready", result, error: "" };
			} catch (error) {
				if (!this.closed && !controller.signal.aborted) this.state = { ...this.state, phase: "failed", error: error instanceof Error ? error.message : String(error) };
			} finally {
				this.pending = undefined; this.controller = undefined;
				if (!this.closed) this.changed();
			}
		});
		this.pending = operation; this.changed(); return operation;
	}
	cancel(): void {
		if (!this.controller || this.closed) return;
		this.controller.abort(); this.state = { ...this.state, phase: "cancelled", error: "" }; this.changed();
	}
	dispose(): void { this.closed = true; this.controller?.abort(); }
}
export const paperStateLabel = (state: PaperReadingState): string => ({ unmarked: "阅读状态未标记", not_started: "未开始阅读", reading: "正在阅读", completed: "用户标记已读", revisit: "待回看" })[state];
export const sourceFormatLabel = (format: string): string => ({ pdf: "PDF", mineru: "MinerU 正文", jats: "JATS 正文", markdown: "Markdown", unknown: "未知格式" }[format] || format);
export const associationLabel = (paper: LibraryPaper): string => paper.association === "conflict" ? "关联有冲突" : paper.objects.some(item => item.manualBibliography) ? "人工条目 · 未核验" : paper.association === "unidentified" ? "待关联" : "已有标识";
export function libraryRowContext(paper: LibraryPaper): string {
	const labels = { source: "原文", session: "阅读会话", note: "论文笔记", annotation: "批注", record: "书目信息", acquisition: "获取记录" };
	const kinds = [...new Set(paper.objects.map(item => labels[item.kind]))].join("、");
	const item = paper.objects[0];
	const location = item?.source?.path || item?.reading?.source.path || item?.annotationProvenance?.sourcePath || item?.annotationPath || (item?.kind === "note" ? item.id : "");
	return kinds + (location ? " · " + location.replace(/\\/g, "/").split("/").slice(-2).join("/") : "");
}
export function filterLibrary(papers: readonly LibraryPaper[], query: string, filter: LibraryFilter): LibraryPaper[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return papers.filter(paper => {
		if (filter === "sources" && !paper.objects.some(item => item.source)) return false;
		if (filter === "sessions" && !paper.objects.some(item => item.reading)) return false;
		if (filter === "issues" && paper.association === "identified" && !paper.diagnosticIds.length) return false;
		const haystack = [paper.title, paper.citekey, ...Object.values(paper.identifiers), ...paper.objects.flatMap(item => [item.title, item.id, item.source?.path, item.manualBibliography?.reference, ...(item.manualBibliography?.authors || []), item.manualBibliography?.year])].join("\n").toLocaleLowerCase();
		return terms.every(term => haystack.includes(term));
	});
}
export type LibraryNavigation = { kind: "source"; path: string; format: "pdf" | "mineru" | "jats" | "markdown"; read: boolean }
	| { kind: "session"; sessionId: string } | { kind: "note"; path: string };
/** Re-resolve against fresh read-only data. No title-based substitution or latest-session fallback. */
export function libraryNavigation(expected: LibraryObjectSummary, fresh: LibraryReadResult, read = false): LibraryNavigation {
	const item = fresh.papers.flatMap(paper => paper.objects).find(item => item.kind === expected.kind && item.id === expected.id);
	if (!item) throw new Error("此记录已变化或无法读取，请刷新文献库");
	if (item.kind === "source") {
		const source = item.source, old = expected.source;
		if (!source || !old || source.verification.state !== "verified" || old.verification.state !== "verified") throw new Error("请先核验此原文");
		if (source.path !== old.path || source.format !== old.format || source.verification.fingerprint !== old.verification.fingerprint
			|| source.sourceVersionId !== old.sourceVersionId || source.projectionId !== old.projectionId) throw new Error("所选原文版本已变化，请刷新后重新选择");
		const capability = read ? item.capabilities?.interactiveReading : item.capabilities?.openOriginal;
		if (!capability?.available || source.format === "unknown") throw new Error(capability?.reason || "此来源暂不可打开");
		return { kind: "source", path: source.path, format: source.format, read };
	}
	if (item.kind === "session" && item.reading && expected.reading) {
		const current = item.reading.source, old = expected.reading.source;
		if (current.kind !== old.kind || current.path !== old.path || current.fingerprint !== old.fingerprint) throw new Error("会话来源已变化，请刷新后重新选择");
		return { kind: "session", sessionId: item.reading.sessionId };
	}
	if (item.kind === "note") return { kind: "note", path: item.id };
	if (item.kind === "annotation" && item.annotationPath) return { kind: "note", path: item.annotationPath };
	throw new Error("此记录没有可打开的内容");
}
