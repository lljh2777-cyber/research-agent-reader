import { randomUUID } from "node:crypto";
import { readingCategory } from "./catalog";
import { validateModulePlan } from "./planning";
import { answerHash, effectiveReadingContent } from "./quality";
import { codeFingerprint, validateCodeSnapshot } from "../code-reading/source";
import { verifyCodeQuote, readingQuestionContext } from "../code-reading/quote";
import type { ReadingBranch, ReadingNode, ReadingQuote, ReadingSession, ReadingSource } from "./types";
import { validateStructuredEvidence, validateStructuredSource } from "./structured-source";

export const newReadingId = (): string => "r-" + randomUUID();

function readingTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
	if (!match || !Number.isFinite(Date.parse(value))) return undefined;
	// Date.parse accepts impossible calendar dates by rolling into the following month.
	return new Date(match[1]).toISOString().startsWith(match[1]) ? value : undefined;
}

export function decodeReadingSession(text: string, mtime: Date): { session: ReadingSession; repairedTimes: boolean } {
	const session = validateReadingSession(JSON.parse(text));
	const opened = session.lastOpenedAt, updated = readingTimestamp(session.updatedAt), created = readingTimestamp(session.createdAt);
	if (opened && updated && created) return { session, repairedTimes: false };

	const fileTime = mtime.toISOString();
	let earliest = updated ?? opened;
	if (opened && updated && Date.parse(opened) < Date.parse(updated)) earliest = opened;
	let latestNode: string | undefined;
	if (!created) {
		for (const node of session.nodes) {
			const time = readingTimestamp(node.createdAt);
			if (!time) continue;
			if (!earliest || Date.parse(time) < Date.parse(earliest)) earliest = time;
			if (!latestNode || Date.parse(time) > Date.parse(latestNode)) latestNode = time;
		}
	}
	// Only original timestamps are evidence for the other missing fields.
	session.createdAt = created ?? earliest ?? fileTime;
	session.updatedAt = updated ?? opened ?? created ?? latestNode ?? fileTime;
	session.lastOpenedAt = opened ?? updated ?? created ?? latestNode ?? fileTime;
	return { session, repairedTimes: true };
}

export function createReadingSession(source: ReadingSource, backend = source.kind === "code" ? "codex-cli" : "", model = ""): ReadingSession {
	const now = new Date().toISOString();
	return { version: 1, id: newReadingId(), title: source.title, source, createdAt: now, updatedAt: now, purpose: "reading", lastOpenedAt: now,
		nodes: [], branches: [], mainIds: [], outline: [], mainSummary: "", completed: false, backend, model,
		ui: { mode: "split", ...(source.kind === "code" ? {} : { hideMap: true }), split: 0.5, selectedId: "", zoom: 1, scrollX: 0, scrollY: 0, collapsed: [], drafts: {}, windows: [] } };
}
export function readingNode(session: ReadingSession, id: string): ReadingNode {
	const node = session.nodes.find((item) => item.id === id);
	if (!node) throw new Error("阅读节点不存在");
	return node;
}
export function completedMainContext(session: ReadingSession): string {
	const main = session.mainIds.map(id => readingNode(session, id)).filter(n => n.status === "done");
	const base = session.mainSummary || main.map(n => n.title + "\n" + n.content).join("\n\n");
	const corrections = main.filter(n => n.acceptedCorrectionId).map(n => n.title + "\n" + effectiveReadingContent(session, n));
	return base + (corrections.length ? "\n\n用户选择的后续核对版本，涉及差异时优先于上方旧摘要；事实仍依赖本轮证据：\n" + corrections.join("\n\n") : "");
}
export function addReadingBranch(session: ReadingSession, parentId: string | null, annotation?: ReadingBranch["annotation"]): ReadingBranch {
	const parent = parentId ? readingNode(session, parentId) : undefined;
	if (!parent && !annotation || parent && parent.status !== "done") throw new Error("请等待起点回答完成");
	const ancestors: string[] = [];
	let current: ReadingNode | undefined = parent;
	const seen = new Set<string>();
	while (current?.branchId && !seen.has(current.id)) {
		seen.add(current.id);
		ancestors.unshift(readingQuestionContext(current) + "\n" + effectiveReadingContent(session, current));
		current = session.nodes.find((item) => item.id === current!.parentId);
	}
	const branch: ReadingBranch = { id: newReadingId(), parentNodeId: parentId,
		...(annotation ? { annotation } : {}),
		parentContext: parent ? effectiveReadingContent(session, parent) : "",
		mainSnapshot: completedMainContext(session),
		mainHeadId: session.mainIds.filter((id) => readingNode(session, id).status === "done").slice(-1)[0] || null,
		ancestorContext: ancestors.join("\n\n"), nodeIds: [], summary: "", summarizedCount: 0 };
	session.branches.push(branch);
	return branch;
}
function readingQuoteIssue(quote: ReadingQuote, source: ReadingNode | undefined): string | undefined {
	if (!source) return "来源节点不存在";
	if (source.status !== "done") return "来源回答尚未完成";
	if (!Number.isSafeInteger(quote.start) || !Number.isSafeInteger(quote.end) ||
		quote.start < 0 || quote.end <= quote.start || quote.end > source.content.length) return "选区位置无效";
	if (typeof quote.text !== "string" || !quote.text.trim() || source.content.slice(quote.start, quote.end) !== quote.text) return "引文与来源正文不符";
}

export function validReadingQuote(node: ReadingNode): ReadingQuote | undefined {
	return node.quoteIssue ? undefined : node.quote;
}

export function addReadingNode(session: ReadingSession, branchId: string | null, question = "", quote?: ReadingQuote): ReadingNode {
	const branch = branchId ? session.branches.find((item) => item.id === branchId) : null;
	if (branchId && !branch) throw new Error("阅读支线不存在");
	const ids = branch ? branch.nodeIds : session.mainIds;
	const last = ids.length ? readingNode(session, ids[ids.length - 1]) : null;
	if (last && last.status !== "done") throw new Error("请先重试或完成当前回答");
	if (!branch && session.completed) throw new Error("主线讲解已完成，可从已有节点继续提问");
	if (quote) {
		const issue = readingQuoteIssue(quote, session.nodes.find(node => node.id === quote.nodeId));
		if (issue) throw new Error("引用选区已失效：" + issue + "，请重新选择");
	}
	const node: ReadingNode = { id: newReadingId(), parentId: last?.id || branch?.parentNodeId || null,
		branchId, question, title: question.slice(0, 36) || "准备讲解", content: "", status: "pending", error: "",
		createdAt: new Date().toISOString(), evidence: [], ...(quote ? { quote } : {}) };
	session.nodes.push(node); ids.push(node.id); session.ui.selectedId = node.id;
	if (!branch) session.ui.mainFocusId = node.id;
	return node;
}
export function validateReadingSession(value: unknown): ReadingSession {
	const session = value as ReadingSession;
	if (typeof session?.version !== "number") throw new Error("阅读会话版本号无效");
	if (session.version !== 1) throw new Error("不支持的阅读会话版本 " + session.version);
	if (!/^r-[a-f0-9-]{36}$/.test(session.id)
		|| !["pdf", "article", "structured", "code"].includes(session.source?.kind) || typeof session.source.path !== "string"
		|| !/^[a-f0-9]{64}$/.test(session.source.fingerprint) || !Array.isArray(session.nodes)
		|| !Array.isArray(session.branches) || !Array.isArray(session.mainIds) || !session.ui) throw new Error("阅读会话格式无效");
	const nodes = new Map<string, ReadingNode>();
	if (session.source.kind === "structured") validateStructuredSource(session.source);
	else if (session.source.structured !== undefined) throw new Error("结构化来源不可绑定到旧来源类型");
	if (session.source.kind === "code" && codeFingerprint(validateCodeSnapshot(session.source.code)) !== session.source.fingerprint) throw new Error("代码来源指纹与快照不一致");
	for (const node of session.nodes) {
		if (!node.id || nodes.has(node.id) || typeof node.content !== "string" || typeof node.question !== "string"
			|| !["pending", "running", "done", "failed", "interrupted"].includes(node.status)
			|| !Array.isArray(node.evidence) || (node.parentId && !nodes.has(node.parentId))) throw new Error("阅读节点关系无效");
		nodes.set(node.id, node);
		if (node.codeQuote) {
			if (session.source.kind !== "code" || !node.branchId) throw new Error("源码追问只能属于代码支线");
			verifyCodeQuote(node.codeQuote, node.evidence.find(e => e.id === node.codeQuote!.evidenceId));
		}
		for (const e of node.evidence.filter(e => e.kind === "code")) {
			const file = session.source.code?.files.find(f => f.path === e.path);
			if (session.source.kind !== "code" || !file || e.sourceHash !== file.hash || !Number.isInteger(e.startLine) || !Number.isInteger(e.endLine)
				|| e.startLine! < 1 || e.endLine! < e.startLine! || e.endLine! > file.lines || e.language !== file.language) throw new Error("代码引用与来源快照不一致");
		}
		for (const e of node.evidence) {
			if (session.source.kind === "structured" && e.kind === "paper" || e.structured !== undefined) validateStructuredEvidence(e, session.source);
			if (e.relatedIds !== undefined && (!Array.isArray(e.relatedIds) || e.relatedIds.length > 2000 || e.relatedIds.some(id => typeof id !== "string"))) throw new Error("证据关联记录无效");
		}
	}
	const attached = new Set<string>();
	const checkChain = (ids: string[], branchId: string | null, parent: string | null): void => {
		for (const id of ids) {
			const node = nodes.get(id);
			if (!node || attached.has(id) || node.branchId !== branchId || node.parentId !== parent) throw new Error("阅读会话存在断链或重复节点");
			attached.add(id); parent = id;
		}
	};
	checkChain(session.mainIds, null, null);
	const branches = new Set<string>();
	for (const branch of session.branches) {
		if (branches.has(branch.id) || (branch.parentNodeId === null ? !branch.annotation : !nodes.has(branch.parentNodeId)) || !Array.isArray(branch.nodeIds)
			|| typeof branch.mainSnapshot !== "string" || typeof branch.ancestorContext !== "string") throw new Error("阅读支线无效");
		const a = branch.annotation;
		if (a && (session.source.kind === "code" || !a.id || typeof a.selected !== "string" || typeof a.question !== "string" || typeof a.note !== "string"
			|| typeof a.path !== "string" || !a.path.endsWith(".md") || /[:\\\\]/.test(a.path) || a.path.split("/").some(part => !part || part === "." || part === "..")
			|| ![a.at, a.englishStart].every(n => Number.isSafeInteger(n) && n >= 0) || typeof a.chinese !== "boolean"
			|| ![a.digest, a.englishDigest].every(d => /^[a-f0-9]{64}$/.test(d)) || !Array.isArray(a.quotes) || a.quotes.some(q => typeof q !== "string"))) throw new Error("批注分支来源无效");
		branches.add(branch.id); checkChain(branch.nodeIds, branch.id, branch.parentNodeId);
	}
	if (attached.size !== nodes.size) throw new Error("阅读会话包含孤立节点");
	if (typeof session.title !== "string" || typeof session.backend !== "string" || typeof session.model !== "string"
		|| typeof session.mainSummary !== "string" || typeof session.completed !== "boolean" || !Array.isArray(session.outline)
		|| session.outline.some((title) => typeof title !== "string") || !Array.isArray(session.ui.windows)
		|| !Array.isArray(session.ui.collapsed) || session.ui.collapsed.some((id) => typeof id !== "string")
		|| !session.ui.drafts || typeof session.ui.drafts !== "object" || Array.isArray(session.ui.drafts)
		|| Object.values(session.ui.drafts).some((value) => typeof value !== "string")) throw new Error("阅读会话界面或记忆格式无效");
	if (session.modulePlan !== undefined) session.modulePlan = validateModulePlan(session.modulePlan, session.outline);
	if (session.sourceRelocations !== undefined && (!Array.isArray(session.sourceRelocations) || session.sourceRelocations.some(r => !r || typeof r.from !== "string" || typeof r.to !== "string" || !Number.isFinite(Date.parse(r.date)) || r.fingerprint !== session.source.fingerprint))) throw new Error("原文位置历史无效");
	for (const node of session.nodes) {
		const issue = node.quote && readingQuoteIssue(node.quote, nodes.get(node.quote.nodeId));
		if (issue) node.quoteIssue = issue;
		else delete node.quoteIssue;
		if (node.requestWeb !== undefined && (typeof node.requestWeb !== "boolean" || node.requestWeb && !node.branchId)) throw new Error("联网只能由问题支线发起");
		if (node.web && (!node.requestWeb || !["native", "tavily"].includes(node.web.mode) || typeof node.web.query !== "string" || node.web.query.length > 400 || typeof node.web.warning !== "string" || !Array.isArray(node.web.sources) || node.web.sources.length > 3 || node.web.sources.some(s => !s || typeof s.title !== "string" || typeof s.url !== "string" || !/^https?:\/\//.test(s.url) || s.content !== undefined && (typeof s.content !== "string" || s.content.length > 1200)))) throw new Error("联网来源记录无效");
		if (node.correction) { const original = nodes.get(node.correction.of); if (!original || !node.branchId || session.nodes.indexOf(original) >= session.nodes.indexOf(node) || node.correction.originalHash !== answerHash(original.content) || typeof node.correction.reason !== "string" || node.correction.reason.length > 4000) throw new Error("核对版本关系无效"); }
		if (node.acceptedCorrectionId) { const correction = nodes.get(node.acceptedCorrectionId); if (correction?.correction?.of !== node.id || correction.status !== "done") throw new Error("所选核对版本无效"); }
		for (const ids of [node.providedEvidenceIds, node.providedImageIds]) if (ids !== undefined && (!Array.isArray(ids) || ids.length > 32 || ids.some(id => typeof id !== "string"))) throw new Error("证据覆盖记录无效");
		if (node.usage !== undefined && (!Array.isArray(node.usage) || node.usage.some(e => !e || typeof e.id !== "string" || typeof e.model !== "string" || typeof e.started !== "string" || !Number.isFinite(e.estimatedInput) || !["planning", "selection", "answer", "memory"].includes(e.stage) || !["running", "done", "failed", "interrupted", "cached"].includes(e.state) || [e.estimatedInput, e.estimatedOutput, e.input, e.output, e.cachedInput].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))))) throw new Error("阅读用量记录无效");
		if (node.selectionCache && (typeof node.selectionCache.key !== "string" || !Array.isArray(node.selectionCache.value?.ids) || node.selectionCache.value.ids.some(id => typeof id !== "string"))) node.selectionCache = undefined;
		if (node.learningState !== undefined && !["unmarked", "understood", "revisit", "question"].includes(node.learningState)) throw new Error("学习标记无效");
		if (node.reviewedEvidence !== undefined && (!Array.isArray(node.reviewedEvidence) || node.reviewedEvidence.some(id => !node.evidence.some(e => e.id === id)))) throw new Error("原文核对标记无效");
		if (typeof node.title !== "string" || typeof node.error !== "string" || node.evidence.some((item) => !item || typeof item.id !== "string"
			|| typeof item.text !== "string" || typeof item.path !== "string" || typeof item.label !== "string" || !["paper", "vault", "code"].includes(item.kind))) throw new Error("阅读证据格式无效");
	}
	for (const branch of session.branches) {
		if (branch.parentContext !== undefined && typeof branch.parentContext !== "string") throw new Error("支线起点背景无效");
		if (typeof branch.summary !== "string" || !Number.isInteger(branch.summarizedCount) || branch.summarizedCount < 0 || branch.summarizedCount > branch.nodeIds.length) throw new Error("支线记忆位置无效");
	}
	const clamp = (value: number, fallback: number, min: number, max: number): number => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
	if (session.purpose !== undefined && !["reading", "demo", "test"].includes(session.purpose)) throw new Error("阅读会话用途无效");
	// Demo execution remains blocked from real models, including old fixtures made by external scripts.
	if (session.demo && session.purpose === "reading") session.purpose = undefined;
	session.purpose = readingCategory(session);
	session.archived = session.archived === true; session.pinned = session.pinned === true;
	session.lastOpenedAt = readingTimestamp(session.lastOpenedAt);
	session.ui.mode = session.ui.mode === "map" ? "map" : "split";
	if (session.ui.webDrafts && (typeof session.ui.webDrafts !== "object" || Array.isArray(session.ui.webDrafts) || Object.values(session.ui.webDrafts).some(v => typeof v !== "boolean"))) throw new Error("联网草稿选项无效");
	if (!["balanced", "foundations", "methods", "evidence"].includes(session.teachingStyle || "balanced")) session.teachingStyle = "balanced";
	if (!["all", "unmarked", "understood", "revisit", "question"].includes(session.ui.learningFilter || "all")) session.ui.learningFilter = "all";
	const pane = session.ui.evidenceView;
	if (pane) {
		if (!Array.isArray(pane.history) || !pane.history.length || !Number.isInteger(pane.cursor) || pane.cursor < 0 || pane.cursor >= pane.history.length || pane.history.some(ref => !nodes.get(ref.nodeId)?.evidence.some(e => e.id === ref.evidenceId))) session.ui.evidenceView = undefined;
		else { pane.x = clamp(pane.x, 24, 0, 10000); pane.y = clamp(pane.y, 110, 0, 10000); pane.width = clamp(pane.width, 520, 300, 4000); pane.height = clamp(pane.height, 540, 220, 4000); }
	}
	session.ui.split = clamp(session.ui.split, 0.5, 0.25, 0.75); session.ui.zoom = clamp(session.ui.zoom, 1, 0.4, 1.8);
	session.ui.scrollX = clamp(session.ui.scrollX, 0, 0, 1_000_000); session.ui.scrollY = clamp(session.ui.scrollY, 0, 0, 1_000_000);
	session.ui.mainScroll = clamp(session.ui.mainScroll || 0, 0, 0, 1_000_000);
	if (!nodes.has(session.ui.selectedId)) session.ui.selectedId = session.mainIds[session.mainIds.length - 1] || "";
	if (!session.mainIds.includes(session.ui.mainFocusId || "")) session.ui.mainFocusId = session.mainIds[session.mainIds.length - 1];
	session.ui.windows = session.ui.windows.filter((item) => item && typeof item.key === "string" && nodes.has(item.nodeId)).map((item) => ({
		...item, pinned: item.pinned === true, minimized: item.minimized === true, x: clamp(item.x, 48, 0, 10000), y: clamp(item.y, 70, 0, 10000),
		width: clamp(item.width, 520, 280, 4000), height: clamp(item.height, 480, 220, 4000), scrollTop: clamp(item.scrollTop || 0, 0, 0, 1_000_000),
	}));
	if (session.ui.pendingQuote) {
		const quote = session.ui.pendingQuote; const source = nodes.get(quote.nodeId);
		if (!source || source.content.slice(quote.start, quote.end) !== quote.text) session.ui.pendingQuote = undefined;
	}
	return session;
}
