import { randomUUID } from "node:crypto";
import { contentHash, inKnowledgeScope, retrievalPassageText } from "../retrieval/chunks";
import { readingContext } from "../reading/engine";
import { currentReadingModule } from "../reading/planning";
import type { ReadingSession } from "../reading/types";
import type { KnowledgeHit } from "../retrieval/types";
import { curationTarget } from "../curation/policy";
import type { AssistantDependencies, AssistantRun, AssistantSource } from "./types";
import type { AssistantToolName } from "./capabilities";
import { toolRequestKey, ToolFeedbackError } from "../agent/tool-feedback";
import { structuredReference, matchStructuredReference } from "../reading/structured-reference";

function boundedBackground(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.floor((limit - 20) / 2); return text.slice(0, head) + "\n[背景节选，完整记录保留本地]\n" + text.slice(-(limit - head - 20));
}

export function assistantContextHash(session: ReadingSession, ids: string[], scope = "node"): string {
	const first = session.nodes.find(n => n.id === ids[0]);
	const nodes = session.nodes.filter(n => scope === "session" || (scope === "branch" ? n.branchId === first?.branchId : ids.includes(n.id)));
	return contentHash(JSON.stringify([session.source, session.mainIds, session.mainSummary, session.completed, nodes.map(n => [n.id, n.parentId, n.branchId, n.status, n.title, n.question, n.content, n.evidence])]));
}
export function assistantContext(session: ReadingSession, nodeId: string) {
	const node = session.nodes.find(n => n.id === nodeId); if (!node || node.status !== "done") throw new Error("请选择一个已完成的阅读节点");
	const branch = session.branches.find(b => b.id === node.branchId);
	const next = currentReadingModule(session);
	const background = branch ? ["创建时主线背景：", boundedBackground(branch.mainSnapshot, 3000), "支线起点：", boundedBackground(session.nodes.find(n => n.id === branch.parentNodeId)?.content || "", 600),
		"相关祖先：", boundedBackground(branch.ancestorSummary || branch.ancestorContext, 900), "支线摘要：", boundedBackground(branch.summary, 700), "近期支线对话：",
		boundedBackground(branch.nodeIds.filter(id => id !== nodeId).map(id => session.nodes.find(n => n.id === id)).filter(n => n?.status === "done").slice(-2).map(n => n!.question + "\n" + n!.content).join("\n\n"), 1200)].join("\n\n") : boundedBackground(readingContext(session, nodeId), 6500);
	return { sessionId: session.id, title: session.title, source: session.source.kind, selected: { id: node.id, title: node.title, question: node.question, branchId: node.branchId, learningState: node.learningState || "unmarked" },
		background, progress: { done: session.mainIds.filter(id => session.nodes.find(n => n.id === id)?.status === "done").length, planned: session.outline.length,
			nextUnit: next ? { number: next.number, title: next.title, question: next.question } : null,
			latestMainNodeId: session.mainIds[session.mainIds.length - 1] || null, canAdvance: !session.completed && session.nodes.find(n => n.id === session.mainIds[session.mainIds.length - 1])?.status === "done" },
		counts: Object.fromEntries(["understood", "revisit", "question", "unmarked"].map(state => [state, session.nodes.filter(n => n.status === "done" && (n.learningState || "unmarked") === state).length])) };
}
export class AssistantTools {
	private candidates = new Map<string, { nodeId: string; evidenceId: string } | KnowledgeHit>();
	private paths = new Set<string>(); private cache = new Map<string, string>();
	constructor(private deps: AssistantDependencies, readonly session: ReadingSession, private run: AssistantRun, private signal: AbortSignal) {}
	private node(id: unknown) { const node = this.session.nodes.find(n => n.id === id && n.status === "done"); if (!node) throw new ToolFeedbackError("unknown_node", "节点不属于本次会话或尚未完成", { tool: "reading_context", arguments: { state: "all", offset: 0 } }); return node; }
	async verify(): Promise<void> {
		this.signal.throwIfAborted(); const doc = await this.deps.workspace.document(this.session.id); await doc.verify();
		if (doc.source.fingerprint !== this.session.source.fingerprint) throw new Error("原文已变化，请重新打开来源"); this.signal.throwIfAborted();
	}
	async execute(tool: Exclude<AssistantToolName, "final">, args: Record<string, unknown>): Promise<{ output: string; cached: boolean }> {
		const sources = this.run.sources.length, actions = this.run.actions.length;
		try { return await this.executeChecked(tool, args); }
		catch (error) { this.run.sources.length = sources; this.run.actions.length = actions; throw error; }
	}
	private async executeChecked(tool: Exclude<AssistantToolName, "final">, args: Record<string, unknown>): Promise<{ output: string; cached: boolean }> {
		this.signal.throwIfAborted(); const key = toolRequestKey(tool, args); const cached = this.cache.get(key);
		if (cached && tool !== "read_evidence") return { output: cached, cached: true };
		let value: unknown;
		if (tool === "reading_context") {
			if (!["all", "understood", "revisit", "question", "unmarked"].includes(String(args.state))) throw new Error("理解状态无效");
			const nodes = this.session.nodes.filter(n => n.status === "done" && (args.state === "all" || (n.learningState || "unmarked") === args.state)); const offset = Number(args.offset);
			value = { total: nodes.length, next: offset + 12 < nodes.length ? offset + 12 : null, nodes: nodes.slice(offset, offset + 12).map(n => ({ id: n.id, title: n.title, branchId: n.branchId, state: n.learningState || "unmarked" })) };
		} else if (tool === "read_node") {
			const node = this.node(args.nodeId); const references = node.evidence.map((e, i) => { const id = "P:" + node.id + ":" + i; this.candidates.set(id, { nodeId: node.id, evidenceId: e.id }); return { id, label: e.label, kind: e.kind }; });
			value = { role: "学习记录，不作为论文证据", id: node.id, title: node.title, content: node.content.slice(0, 7000), truncated: node.content.length > 7000, references,
				evidenceRead: references.length ? { tool: "read_evidence", arguments: { ids: references.slice(0, 3).map(ref => ref.id) } } : null };
		} else if (tool === "search_knowledge") {
			if (!String(args.query).trim()) throw new Error("请输入检索词"); const result = await this.deps.search(String(args.query), { signal: this.signal, limit: 4 });
			value = { mode: result.mode, warnings: result.warnings, candidates: result.hits.filter(h => inKnowledgeScope(h.path)).slice(0, 6).map(hit => { const id = "K:" + contentHash(JSON.stringify([hit.path, hit.hash, hit.start, hit.end])).slice(0, 20); this.candidates.set(id, hit); this.paths.add(hit.path); return { id, path: hit.path, title: hit.title, heading: hit.heading, role: hit.role, preview: hit.text.slice(0, 200) }; }) };
		} else if (tool === "search_learning") {
			const node = this.node(args.nodeId); value = { role: "学习记录，不能作为论文事实依据", ...await this.deps.learning(this.session, node.id, this.signal) };
		} else if (tool === "outcomes") {
			const node = this.node(args.nodeId); value = (await this.deps.outcomes(this.session)).get(node.id) || [];
		} else if (tool === "read_evidence") {
			const ids = [...new Set(args.ids as string[])]; if (!ids.length || ids.length > 3) throw new Error("每轮最多读取三个已返回的证据编号");
			await this.verify(); const sources: AssistantSource[] = [];
			for (const id of ids) {
				const candidate = this.candidates.get(id); if (!candidate) throw new ToolFeedbackError("unknown_evidence", "证据编号未由本轮工具提供", { availableIds: [...this.candidates.keys()].slice(-6), next: "从 read_node 或 search_knowledge 结果复制编号；不可使用页码、S 编号或自行拼接。" });
				let source: Omit<AssistantSource, "id">;
				if ("nodeId" in candidate) {
					const previous = this.node(candidate.nodeId).evidence.find(e => e.id === candidate.evidenceId)!;
					if (previous.kind === "paper") {
						const doc = await this.deps.workspace.document(this.session.id); const original = doc.evidence.find(e => e.id === previous.id); if (!original) throw new Error("原文引用已失效");
						source = { kind: "paper", path: this.session.source.path, hash: this.session.source.fingerprint, label: original.label, text: original.text.slice(0, 5000), page: original.page, role: original.asset ? "本文图注/文字，图像尚未核对" : "本文原文", start: original.start, end: original.start === undefined ? undefined : original.start + Math.min(original.text.length, 5000) };
						if (this.session.source.kind === "structured") { Object.assign(source, structuredReference(original, this.session.source, 5000)); matchStructuredReference(source, this.session.source, doc.evidence); }
					} else {
						if (!inKnowledgeScope(previous.path) || !previous.sourceHash || previous.start === undefined || previous.end === undefined) throw new Error("补充来源缺少可核对的位置或指纹");
						const raw = await this.deps.readFile(previous.path); if (contentHash(raw) !== previous.sourceHash || previous.start < 0 || previous.end > raw.length || previous.end <= previous.start) throw new Error("知识来源已变化");
						source = { kind: "knowledge", path: previous.path, hash: previous.sourceHash, label: previous.label, role: previous.role || "来源层级未标注", text: raw.slice(previous.start, Math.min(previous.end, previous.start + 5000)), start: previous.start, end: Math.min(previous.end, previous.start + 5000) };
					}
				} else {
					const raw = await this.deps.readFile(candidate.path);
					if (contentHash(raw) !== candidate.hash || candidate.start < 0 || candidate.end > raw.length || candidate.end <= candidate.start || retrievalPassageText(raw.slice(candidate.start, candidate.end)) !== candidate.text) throw new Error("检索来源已变化，请重新检索");
					source = { kind: "knowledge", path: candidate.path, hash: candidate.hash, label: candidate.title, role: candidate.role + " · " + candidate.depth, text: raw.slice(candidate.start, Math.min(candidate.end, candidate.start + 5000)), start: candidate.start, end: Math.min(candidate.end, candidate.start + 5000) };
				}
				const existing = this.run.sources.find(s => s.path === source.path && s.hash === source.hash && s.text === source.text && s.evidenceId === source.evidenceId);
				const saved = existing || { ...source, id: "S" + (this.run.sources.length + 1) }; if (!existing) this.run.sources.push(saved); sources.push(saved);
			}
			await this.verify(); value = { sources, sourceWarnings: ((await this.deps.workspace.document(this.session.id)).sourceWarnings || []).slice(0, 12).map(s => s.slice(0, 500)), note: "仅提供本轮文字片段，不代表全文或图像已核验；JATS 使用正文块与字符定位，没有 PDF 页码" };
		} else if (tool === "prepare_action") {
			const ids = [...new Set(args.nodeIds as string[])]; if (!ids.length || ids.length > 3) throw new Error("请选择一至三个节点"); ids.forEach(id => this.node(id));
			if (!["curation", "export", "advance"].includes(String(args.kind)) || !["node", "branch", "session"].includes(String(args.scope))) throw new Error("操作类别或范围无效");
			const candidate = this.candidates.get(String(args.target)); const target = candidate && "path" in candidate ? candidate.path : String(args.target);
			if (args.kind === "curation" && (!this.paths.has(target) || !curationTarget(target))) throw new ToolFeedbackError("unknown_target", "整理目标必须使用本轮正式知识检索返回的候选编号或完整路径", { availablePaths: [...this.paths].filter(curationTarget).slice(0, 3), next: "先 search_knowledge，再从结果复制 target；search_learning 不提供正式整理目标。" });
			if (args.kind !== "curation" && args.target !== "") throw new Error("此操作不接受目标路径");
			if (args.kind === "export" && args.scope !== "session" && ids.length !== 1) throw new Error("节点或支线导出只能指定一个起点");
			if (args.kind !== "export" && args.scope !== "node") throw new Error("此操作只接受节点范围");
			if (args.kind === "advance" && (this.session.completed || ids.length !== 1 || ids[0] !== this.session.mainIds[this.session.mainIds.length - 1])) throw new ToolFeedbackError("invalid_advance", "只能从未完成主线的最新单元继续", { latestMainNodeId: this.session.mainIds[this.session.mainIds.length - 1], completed: this.session.completed });
			if (args.kind === "curation" && ids.some(id => this.node(id).branchId !== this.node(ids[0]).branchId)) throw new Error("一次整理请选择同一主线或支线中的节点");
			const action = { id: randomUUID(), kind: args.kind as "curation" | "export" | "advance", nodeIds: ids, target, scope: args.scope as "node" | "branch" | "session", contextHash: assistantContextHash(this.session, ids, String(args.scope)), state: "prepared" as const };
			this.run.actions.push(action); value = { ...action, status: "仅准备操作卡，尚未执行。请用户在卡片中继续。" };
		} else throw new Error("未知助手工具");
		this.signal.throwIfAborted(); const output = JSON.stringify(value); if (output.length > 19000) throw new Error("工具结果过长，请缩小问题范围"); this.cache.set(key, output); return { output, cached: false };
	}
}
