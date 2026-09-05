import { randomUUID } from "node:crypto";
import type { ReadingBranch, ReadingNode, ReadingQuote, ReadingSession, ReadingSource } from "./types";

export const newReadingId = (): string => "r-" + randomUUID();
export function createReadingSession(source: ReadingSource, backend = "codex-cli", model = ""): ReadingSession {
	const now = new Date().toISOString();
	return { version: 1, id: newReadingId(), title: source.title, source, createdAt: now, updatedAt: now,
		nodes: [], branches: [], mainIds: [], outline: [], mainSummary: "", completed: false, backend, model,
		ui: { mode: "split", split: 0.5, selectedId: "", zoom: 1, scrollX: 0, scrollY: 0, collapsed: [], drafts: {}, windows: [] } };
}
export function readingNode(session: ReadingSession, id: string): ReadingNode {
	const node = session.nodes.find((item) => item.id === id);
	if (!node) throw new Error("阅读节点不存在");
	return node;
}
export function completedMainContext(session: ReadingSession): string {
	return session.mainSummary || session.mainIds.map((id) => readingNode(session, id))
		.filter((node) => node.status === "done").map((node) => node.title + "\n" + node.content).join("\n\n");
}
export function addReadingBranch(session: ReadingSession, parentId: string): ReadingBranch {
	const parent = readingNode(session, parentId);
	if (parent.status !== "done") throw new Error("请等待起点回答完成");
	const ancestors: string[] = [];
	let current: ReadingNode | undefined = parent;
	const seen = new Set<string>();
	while (current?.branchId && !seen.has(current.id)) {
		seen.add(current.id);
		ancestors.unshift(current.question + "\n" + current.content);
		current = session.nodes.find((item) => item.id === current!.parentId);
	}
	const branch: ReadingBranch = { id: newReadingId(), parentNodeId: parentId,
		mainSnapshot: completedMainContext(session),
		mainHeadId: session.mainIds.filter((id) => readingNode(session, id).status === "done").slice(-1)[0] || null,
		ancestorContext: ancestors.join("\n\n"), nodeIds: [], summary: "", summarizedCount: 0 };
	session.branches.push(branch);
	return branch;
}
export function addReadingNode(session: ReadingSession, branchId: string | null, question = "", quote?: ReadingQuote): ReadingNode {
	const branch = branchId ? session.branches.find((item) => item.id === branchId) : null;
	if (branchId && !branch) throw new Error("阅读支线不存在");
	const ids = branch ? branch.nodeIds : session.mainIds;
	const last = ids.length ? readingNode(session, ids[ids.length - 1]) : null;
	if (last && last.status !== "done") throw new Error("请先重试或完成当前回答");
	if (!branch && session.completed) throw new Error("主线讲解已完成，可从已有节点继续提问");
	if (quote) {
		const source = readingNode(session, quote.nodeId);
		if (source.status !== "done" || source.content.slice(quote.start, quote.end) !== quote.text || !quote.text.trim()) {
			throw new Error("引用选区已失效，请重新选择");
		}
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
	if (!session || session.version !== 1 || !/^r-[a-f0-9-]{36}$/.test(session.id)
		|| !["pdf", "article"].includes(session.source?.kind) || typeof session.source.path !== "string"
		|| !/^[a-f0-9]{64}$/.test(session.source.fingerprint) || !Array.isArray(session.nodes)
		|| !Array.isArray(session.branches) || !Array.isArray(session.mainIds) || !session.ui) throw new Error("阅读会话格式无效");
	const nodes = new Map<string, ReadingNode>();
	for (const node of session.nodes) {
		if (!node.id || nodes.has(node.id) || typeof node.content !== "string" || typeof node.question !== "string"
			|| !["pending", "running", "done", "failed", "interrupted"].includes(node.status)
			|| !Array.isArray(node.evidence) || (node.parentId && !nodes.has(node.parentId))) throw new Error("阅读节点关系无效");
		nodes.set(node.id, node);
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
		if (branches.has(branch.id) || !nodes.has(branch.parentNodeId) || !Array.isArray(branch.nodeIds)
			|| typeof branch.mainSnapshot !== "string" || typeof branch.ancestorContext !== "string") throw new Error("阅读支线无效");
		branches.add(branch.id); checkChain(branch.nodeIds, branch.id, branch.parentNodeId);
	}
	if (attached.size !== nodes.size) throw new Error("阅读会话包含孤立节点");
	if (typeof session.title !== "string" || typeof session.backend !== "string" || typeof session.model !== "string"
		|| typeof session.mainSummary !== "string" || typeof session.completed !== "boolean" || !Array.isArray(session.outline)
		|| session.outline.some((title) => typeof title !== "string") || !Array.isArray(session.ui.windows)
		|| !Array.isArray(session.ui.collapsed) || session.ui.collapsed.some((id) => typeof id !== "string")
		|| !session.ui.drafts || typeof session.ui.drafts !== "object" || Array.isArray(session.ui.drafts)
		|| Object.values(session.ui.drafts).some((value) => typeof value !== "string")) throw new Error("阅读会话界面或记忆格式无效");
	for (const node of session.nodes) {
		if (typeof node.title !== "string" || typeof node.error !== "string" || node.evidence.some((item) => !item || typeof item.id !== "string"
			|| typeof item.text !== "string" || typeof item.path !== "string" || typeof item.label !== "string" || !["paper", "vault"].includes(item.kind))) throw new Error("阅读证据格式无效");
	}
	for (const branch of session.branches) {
		if (typeof branch.summary !== "string" || !Number.isInteger(branch.summarizedCount) || branch.summarizedCount < 0 || branch.summarizedCount > branch.nodeIds.length) throw new Error("支线记忆位置无效");
	}
	const clamp = (value: number, fallback: number, min: number, max: number): number => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
	session.ui.mode = session.ui.mode === "map" ? "map" : "split";
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
