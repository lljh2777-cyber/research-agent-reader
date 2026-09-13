import { randomUUID } from "node:crypto";
import type { ReadingBackend } from "../reading/types";
import { TOPIC_HASH, TOPIC_ID, topicDigest } from "./contracts";
import type { TopicLearningService } from "./service";
import type { TopicHistory, TopicRevision } from "./store";
import type { TopicIntent, TopicModule, TopicPlan } from "./types";

export interface TopicDraft { id: string; base: string; intent: TopicIntent; plan?: TopicPlan; }
export interface TopicListItem { id: string; title: string; goal: string; updatedAt: string; status: string; }
export interface TopicUsage { state: "running" | "returned" | "failed" | "cancelled"; provider: string; model: string; input?: number; output?: number; cachedInput?: number; }
const blank = (): TopicDraft => ({ id: "", base: "", intent: { topic: "", goal: "", background: "" } });
const fromRevision = (r: TopicRevision): TopicDraft => ({ id: r.session.id, base: r.digest, intent: structuredClone(r.session.intent), ...(r.session.plan ? { plan: structuredClone(r.session.plan) } : {}) });
const safeText = (v: unknown, size: number): string => typeof v === "string" ? v.slice(0, size) : "";
export function restoreTopicDraft(raw: unknown): TopicDraft {
	if (!raw || typeof raw !== "object") return blank();
	const value = raw as TopicDraft, id = TOPIC_ID.test(value.id) ? value.id : "", base = TOPIC_HASH.test(value.base) ? value.base : "";
	const intent = { topic: safeText(value.intent?.topic, 160), goal: safeText(value.intent?.goal, 2000), background: safeText(value.intent?.background, 2000) };
	const modules = Array.isArray(value.plan?.modules) ? value.plan.modules.slice(0, 12).map(m => ({ id: safeText(m?.id, 40), title: safeText(m?.title, 160), question: safeText(m?.question, 500), objective: safeText(m?.objective, 1000), prerequisites: Array.isArray(m?.prerequisites) ? m.prerequisites.slice(0, 11).map(p => safeText(p, 40)) : [] })) : undefined;
	return { id, base, intent, ...(modules ? { plan: { version: 1, modules } } : {}) };
}
export const topicStatus = (history: TopicHistory): string => history.errors.length ? "历史需处理" : history.current?.session.confirmation ? "路线已确认" : history.current?.session.plan ? "路线待确认" : history.current ? "仅有目标" : "尚无已提交版本";

/** Owns editable drafts and exact revision receipts; view changes never invoke a model. */
export class TopicWorkspaceController {
	draft = blank();
	history?: TopicHistory;
	current?: TopicRevision;
	items: TopicListItem[] = [];
	total = 0;
	limit = 40;
	phase: "idle" | "loading" | "saving" | "generating" = "idle";
	message = "";
	usage?: TopicUsage;
	private closed = false;
	private abort?: AbortController;
	constructor(readonly service: TopicLearningService, private readonly changed: () => void) {}
	get busy(): boolean { return this.phase !== "idle"; }
	get dirty(): boolean { return topicDigest(this.draft) !== topicDigest(this.current ? fromRevision(this.current) : { ...blank(), id: this.draft.id }); }
	get intentDirty(): boolean { return !this.current || topicDigest(this.draft.intent) !== topicDigest(this.current.session.intent); }
	get stale(): boolean { return Boolean(this.draft.id && (!this.current || this.history?.errors.length || this.current.digest !== this.draft.base)); }
	get editable(): boolean { return !this.busy && !this.stale; }
	private notify(): void { if (!this.closed) this.changed(); }
	setDraft(raw: unknown): void { if (!this.busy && !this.closed) { this.draft = restoreTopicDraft(raw); this.notify(); } }
	private async operation(phase: typeof this.phase, run: () => Promise<void>): Promise<void> {
		if (this.busy || this.closed) return;
		this.phase = phase; this.message = ""; this.notify();
		try { await run(); } catch (error) { this.message = error instanceof Error ? error.message : String(error); }
		finally { this.phase = "idle"; this.notify(); }
	}
	private async readSelected(): Promise<void> {
		const history = this.draft.id ? await this.service.store.read(this.draft.id) : undefined;
		if (this.closed) return;
		this.history = history; this.current = history?.current;
	}
	async refresh(): Promise<void> { await this.operation("loading", async () => { await this.readSelected(); await this.readList(); }); }
	private async readList(): Promise<void> {
		const ids = await this.service.store.list(), items: TopicListItem[] = [];
		for (const id of ids.slice(0, this.limit)) {
			if (this.closed) return;
			const h = id === this.draft.id && this.history ? this.history : await this.service.store.read(id);
			items.push({ id, title: h.current?.session.intent.topic || (h.errors.length ? "需处理的主题历史" : id), goal: h.current?.session.intent.goal || "请查看保留的历史版本", updatedAt: h.current?.session.updatedAt || "", status: topicStatus(h) });
		}
		if (!this.closed) { this.total = ids.length; this.items = items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)); }
	}
	async select(id: string, discard = false): Promise<void> {
		if (this.busy || this.closed) return;
		if (this.dirty && !discard) { this.message = "请先保存当前修改，或点击“恢复已保存内容”后切换。"; this.notify(); return; }
		await this.operation("loading", async () => {
			const h = id ? await this.service.store.read(id) : undefined;
			if (this.closed) return;
			this.history = h; this.current = h?.current; this.draft = this.current ? fromRevision(this.current) : { ...blank(), id }; this.usage = undefined;
			if (id && !this.current) this.message = "没有可直接编辑的当前版本，请查看历史提示。";
		});
	}
	private requireCurrent(): TopicRevision {
		if (!this.current || this.stale) throw new Error("主题已变化或历史需处理，请重新读取；本地草稿仍保留。");
		return this.current;
	}
	private async accept(revision: TopicRevision): Promise<void> {
		if (this.closed) return;
		this.current = revision; this.draft = fromRevision(revision);
		await this.readSelected();
		try { await this.readList(); } catch { this.message += "；内容已保存，历史列表刷新失败，可稍后重新读取。"; }
	}
	async saveIntent(): Promise<void> {
		await this.operation("saving", async () => {
			const r = this.draft.id ? await this.service.editIntent(this.draft.id, this.requireCurrent().digest, this.draft.intent) : await this.service.create(this.draft.intent);
			this.message = "目标已保存。"; await this.accept(r);
		});
	}
	async savePlan(): Promise<void> {
		await this.operation("saving", async () => {
			const r = this.requireCurrent();
			if (this.intentDirty) throw new Error("请先保存目标；修改目标后需重新安排路线。");
			if (!this.draft.plan) throw new Error("请先填写路线。");
			const saved = await this.service.editPlan(r.session.id, r.digest, this.draft.plan);
			this.message = "路线已保存，确认前可继续修改。"; await this.accept(saved);
		});
	}
	async confirm(): Promise<void> {
		await this.operation("saving", async () => {
			const r = this.requireCurrent(); if (this.dirty) throw new Error("请先保存修改，再确认路线。");
			const saved = await this.service.confirmPlan(r.session.id, r.digest);
			this.message = "路线已确认，可打开学习开发预览；确认表示接受学习安排，不表示已掌握。"; await this.accept(saved);
		});
	}
	async generate(makeBackend: () => ReadingBackend): Promise<void> {
		await this.operation("generating", async () => {
			this.usage = undefined;
			const r = this.requireCurrent();
			if (this.dirty) throw new Error("请先保存或恢复当前修改，再生成路线。");
			if (r.session.confirmation) throw new Error("路线已确认，请先修改并保存路线后再生成。");
			const backend = makeBackend(), controller = new AbortController(); this.abort = controller;
			const usage: TopicUsage = { state: "running", provider: backend.name, model: backend.model }; this.usage = usage; this.notify();
			try {
				const saved = await this.service.plan(r.session.id, r.digest, backend, controller.signal, report => {
					if (controller.signal.aborted || this.closed) return;
					for (const key of ["input", "output", "cachedInput"] as const) if (Number.isFinite(report[key]) && report[key]! >= 0) usage[key] = report[key];
					this.notify();
				});
				usage.state = "returned"; this.message = controller.signal.aborted ? "取消到达前路线已提交，请查看已保存结果。" : "路线草稿已保存，请检查并调整。"; await this.accept(saved);
			} catch (error) { usage.state = controller.signal.aborted ? "cancelled" : "failed"; throw error; }
			finally { this.abort = undefined; }
		});
	}
	cancel(): void { this.abort?.abort(new Error("已请求取消路线生成")); this.message = "已请求取消，正在确认保存状态…"; this.notify(); }
	async copyRevision(digest: string): Promise<void> {
		if (this.dirty) { this.message = "请先保存或恢复当前修改，再复制历史版本。"; this.notify(); return; }
		await this.operation("saving", async () => { const r = await this.service.copyRevision(this.draft.id, digest); this.message = "已创建独立副本，原历史完整保留；路线需重新确认。"; await this.accept(r); });
	}
	async copyDraft(): Promise<void> {
		await this.operation("saving", async () => {
			const plan = this.draft.plan && structuredClone(this.draft.plan);
			const r = await this.service.create(this.draft.intent);
			await this.accept(r);
			if (plan && !this.closed) this.draft.plan = plan;
			this.message = "已将目标另存为新主题；草稿路线已带入，请检查后保存。";
		});
	}
	addModule(): void {
		if (!this.editable || !this.current || this.intentDirty) return;
		const plan = this.draft.plan ||= { version: 1, modules: [] };
		if (plan.modules.length >= 12) return;
		plan.modules.push({ id: "unit-" + randomUUID().slice(0, 8), title: "", question: "", objective: "", prerequisites: [] }); this.notify();
	}
	removeModule(id: string): void {
		if (!this.editable || !this.draft.plan) return;
		this.draft.plan.modules = this.draft.plan.modules.filter(m => m.id !== id);
		for (const m of this.draft.plan.modules) m.prerequisites = m.prerequisites.filter(p => p !== id);
		this.notify();
	}
	moveModule(id: string, delta: -1 | 1): void {
		if (!this.editable || !this.draft.plan) return;
		const modules: TopicModule[] = [...this.draft.plan.modules], index = modules.findIndex(m => m.id === id), target = index + delta;
		if (index < 0 || target < 0 || target >= modules.length) return;
		[modules[index], modules[target]] = [modules[target], modules[index]];
		const before = new Set<string>();
		for (const m of modules) { if (m.prerequisites.some(p => !before.has(p))) { this.message = "此移动会使先修单元排在后面，请先调整先修关系。"; this.notify(); return; } before.add(m.id); }
		this.draft.plan.modules = modules; this.message = ""; this.notify();
	}
	dispose(): void { this.closed = true; this.abort?.abort(); }
}
