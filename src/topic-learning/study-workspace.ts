import type { ReadingBackend } from "../reading/types";
import { learningAncestors } from "../learning/graph";
import { TOPIC_HASH, TOPIC_ID } from "./contracts";
import { UNDERSTANDING_LABELS, type TopicStudy, type TopicUnderstanding } from "./study";
import type { TopicStudyService } from "./study-service";

export interface TopicStudyUI { selectedId: string; mainFocusId: string; collapsed: string[]; drafts: Record<string, string>; zoom: number; mapX: number; mapY: number; }
const blankUI = (): TopicStudyUI => ({ selectedId: "", mainFocusId: "", collapsed: [], drafts: {}, zoom: 0.8, mapX: 0, mapY: 0 });
export class TopicStudyController {
	topicId = ""; route = ""; study?: TopicStudy; ui = blankUI();
	routes: { digest: string; title: string; goal: string }[] = [];
	busy = false; generating = false; message = "";
	private abort?: AbortController; private closed = false;
	constructor(readonly service: TopicStudyService, private readonly changed: () => void) {}
	get selected() { return this.study?.nodes.find(n => n.id === this.ui.selectedId); }
	get hasDrafts(): boolean { return Object.values(this.ui.drafts).some(v => v.trim()); }
	state(): Record<string, unknown> { return { topicId: this.topicId, route: this.route, ui: structuredClone(this.ui) }; }
	restore(raw: unknown): void {
		if (this.busy || this.closed) return;
		const value = raw as { topicId?: string; route?: string; ui?: TopicStudyUI } | undefined;
		this.topicId = value?.topicId && TOPIC_ID.test(value.topicId) ? value.topicId : ""; this.route = value?.route && TOPIC_HASH.test(value.route) ? value.route : "";
		const ui = value?.ui; this.ui = blankUI();
		if (ui && typeof ui === "object") {
			this.ui.selectedId = typeof ui.selectedId === "string" ? ui.selectedId.slice(0, 80) : ""; this.ui.mainFocusId = typeof ui.mainFocusId === "string" ? ui.mainFocusId.slice(0, 80) : "";
			this.ui.collapsed = Array.isArray(ui.collapsed) ? ui.collapsed.filter(id => typeof id === "string").slice(0, 192) : [];
			if (ui.drafts && typeof ui.drafts === "object") for (const [id, text] of Object.entries(ui.drafts).slice(0, 192)) if (/^(main-unit-|n-)[a-z0-9-]+$/.test(id) && typeof text === "string") this.ui.drafts[id] = text.slice(0, 2000);
			for (const key of ["zoom", "mapX", "mapY"] as const) if (typeof ui[key] === "number" && Number.isFinite(ui[key])) this.ui[key] = Math.max(key === "zoom" ? 0.4 : 0, Math.min(key === "zoom" ? 1.5 : 100000, ui[key]));
		}
	}
	private notify(): void { if (!this.closed) this.changed(); }
	async refresh(): Promise<void> {
		if (this.busy || this.closed || !this.topicId) return;
		this.busy = true; this.message = ""; this.notify();
		try {
			if (this.route) await this.reload();
			const routes = [];
			for (const digest of (await this.service.store.list(this.topicId)).slice(0, 128)) {
				if (this.closed) return;
				const h = await this.service.store.read(this.topicId, digest);
				routes.push({ digest, title: h.study?.session.intent.topic || "无法核验的学习记录", goal: h.study?.session.intent.goal || h.errors.join("；") });
			}
			if (!this.closed) this.routes = routes;
		} catch (e) { this.message = String(e); }
		finally { this.busy = false; this.notify(); }
	}
	private async reload(): Promise<void> {
		const h = await this.service.store.read(this.topicId, this.route); if (this.closed) return;
		this.study = h.study;
		if (h.errors.length) throw new Error(h.errors.join("；")); if (!h.study) throw new Error("学习记录尚未提交，请从已确认路线打开");
		if (h.pending.length) this.message = `${h.pending.length} 次未完成保存已保留，未作为当前结果。`;
		if (!h.study.nodes.some(n => n.id === this.ui.selectedId)) this.ui.selectedId = h.study.graph.mainIds.slice(-1)[0] || "";
		if (!h.study.graph.mainIds.includes(this.ui.mainFocusId)) this.ui.mainFocusId = h.study.graph.mainIds.slice(-1)[0] || "";
	}
	async open(topicId: string, route: string): Promise<void> {
		if (this.busy || this.closed) return;
		if ((this.topicId !== topicId || this.route !== route) && this.hasDrafts) { this.message = "当前记录有未发送的问题，请先发送或清空草稿再切换。"; this.notify(); return; }
		if (this.topicId !== topicId || this.route !== route) { this.study = undefined; this.restore({ topicId, route }); }
		await this.refresh();
	}
	select(id: string): void {
		if (this.busy || !this.study?.nodes.some(n => n.id === id)) return;
		this.reveal(id);
		this.ui.selectedId = id; if (!this.selected?.branchId) this.ui.mainFocusId = id; this.notify();
	}
	private reveal(id: string): void {
		const visibleBranches = new Set(learningAncestors(this.study!.nodes, id).map(node => node.branchId));
		this.ui.collapsed = this.ui.collapsed.filter(branch => !visibleBranches.has(branch));
	}
	returnToMain(): void { this.select(this.ui.mainFocusId || this.study?.graph.mainIds.slice(-1)[0] || ""); }
	toggle(branchId: string): void { if (this.busy) return; this.ui.collapsed = this.ui.collapsed.includes(branchId) ? this.ui.collapsed.filter(id => id !== branchId) : [...this.ui.collapsed, branchId]; this.notify(); }
	clearDrafts(): void { if (!this.busy) { this.ui.drafts = {}; this.notify(); } }
	async mark(state: TopicUnderstanding): Promise<void> {
		if (this.busy || this.closed || !this.study || !this.selected) return;
		const { head } = this.study, id = this.selected.id; this.busy = true; this.message = "正在保存理解标记…"; this.notify();
		try { await this.service.mark(this.topicId, this.route, head, id, state); await this.reload(); this.message = "已保存用户标记：" + UNDERSTANDING_LABELS[state] + "。这不是事实核验结果。"; }
		catch (e) { this.message = String(e); try { await this.reload(); } catch { /* Preserve the marking error. */ } }
		finally { this.busy = false; this.notify(); }
	}
	async generate(action: Parameters<TopicStudyService["generate"]>[3], makeBackend: () => ReadingBackend): Promise<void> {
		if (this.busy || this.closed || !this.study) return;
		const head = this.study.head, parentDraft = action.kind === "ask" ? this.ui.drafts[action.parentId] : undefined;
		const controller = new AbortController(); this.abort = controller; this.busy = this.generating = true; this.message = "正在生成当前讲解，可取消…"; this.notify();
		try {
			await this.service.generate(this.topicId, this.route, head, action, makeBackend, controller.signal); await this.reload();
			if (this.closed) return;
			const node = action.kind === "retry" ? this.study?.nodes.find(n => n.id === action.nodeId) : this.study?.nodes.slice(-1)[0];
			if (node) { this.reveal(node.id); this.ui.selectedId = node.id; if (!node.branchId) this.ui.mainFocusId = node.id;
				if (action.kind === "ask" && node.status === "done" && this.ui.drafts[action.parentId] === parentDraft) delete this.ui.drafts[action.parentId];
				if (action.kind === "retry" && node.status === "done" && node.parentId && this.ui.drafts[node.parentId]?.trim() === node.question) delete this.ui.drafts[node.parentId];
				this.message = node.status === "done" ? "讲解已保存，生成不表示已经掌握。" : node.attempts.slice(-1)[0]?.result?.error || "讲解未完成，可显式重试。";
			}
		} catch (e) { this.message = String(e); try { await this.reload(); } catch { /* Keep the original actionable failure. */ } }
		finally { this.abort = undefined; this.busy = this.generating = false; this.notify(); }
	}
	cancel(): void { this.abort?.abort(); }
	dispose(): void { this.closed = true; this.abort?.abort(); }
}
