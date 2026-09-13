import { App, Modal } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { objectDigest } from "../papers/identity";
import { DRAFT_KINDS, newKnowledgeDraft, renderKnowledgeDraft, draftMaterialStatus, type KnowledgeDraft, type DraftMaterial } from "../curation/draft";
import { readExcerptSnapshot } from "../annotations/excerpt-library";
import { readAnswerExcerpt } from "../learning/answer-excerpts";
import { ANSWER_CONTENT_ROLES, answerRoleText, type AnswerContentRole } from "../curation/answer-excerpt";
import { type DraftHistory, type DraftRevision } from "../curation/draft-store";

/** Saved drafts are plugin records, never Wiki pages. Preview uses text nodes, not Markdown execution. */
export class KnowledgeDraftsModal extends Modal {
	private closed = true; private action?: AbortController; private history?: DraftHistory; private baseline?: KnowledgeDraft; private draft?: KnowledgeDraft;
	private expected: string | null = null; private preview?: { draft: KnowledgeDraft; key: string; expected: string | null };
	private list!: HTMLElement; private editor!: HTMLElement; private status!: HTMLElement; private result!: HTMLElement;
	private get dirty(): boolean { return !!this.draft && objectDigest(this.draft) !== objectDigest(this.baseline); }
	constructor(app: App, private plugin: AgentDashboardPlugin, private initial?: { id: string } | { material: DraftMaterial }) { super(app); }
	onOpen(): void {
		this.closed = false; this.setTitle("新知识页草稿"); this.modalEl.addClass("curation-modal", "rar-knowledge-drafts");
		this.contentEl.createEl("p", { text: "保存可继续编辑的草稿。附带材料和正文分别保留；这里不会创建正式知识页，也不调用模型。未保存的输入不能在插件重载后恢复。" });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		const tools = this.contentEl.createDiv("rar-excerpt-actions");
		this.button(tools, "新建空白草稿", () => { if (!this.clean()) return; this.acceptNew(newKnowledgeDraft()); });
		this.button(tools, "刷新草稿列表", () => void this.run(signal => this.renderList(signal)));
		const id = tools.createEl("input", { type: "text", attr: { "aria-label": "按草稿 ID 打开", placeholder: "草稿 ID", maxlength: "38" } });
		this.button(tools, "打开指定草稿", () => { if (this.clean()) void this.run(signal => this.load(id.value, false, signal)); });
		this.list = this.contentEl.createDiv("rar-draft-list"); this.editor = this.contentEl.createDiv();
		const footer = this.contentEl.createDiv("rar-excerpt-actions");
		const cancel = this.button(footer, "取消当前操作", () => this.action?.abort()); cancel.dataset.busy = "cancel";
		const close = this.button(footer, "关闭", () => this.close()); close.dataset.busy = "allow";
		void this.run(async signal => { await this.renderList(signal); if (this.initial && "id" in this.initial) await this.load(this.initial.id, false, signal); else if (this.initial) this.acceptNew(newKnowledgeDraft(this.initial.material)); });
	}
	close(): void { if (!this.clean()) return; super.close(); }
	dispose(): void { super.close(); }
	onClose(): void { this.closed = true; this.action?.abort(); this.contentEl.empty(); }
	private clean(): boolean { if (this.action || this.dirty) { this.status.setText("请等待当前操作完成，并保存或放弃未保存的输入。"); return false; } return true; }
	private button(el: HTMLElement, text: string, run: () => void): HTMLButtonElement { const b = el.createEl("button", { text, attr: { type: "button" } }); b.onclick = () => { try { run(); } catch (error) { this.status.setText(String(error)); } }; return b; }
	private controls(): void {
		for (const el of this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>("button,input,textarea,select")) el.disabled = el.dataset.busy === "cancel" ? !this.action : el.dataset.busy === "allow" ? false : !!this.action;
	}
	private async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.action || this.closed) return; const action = this.action = new AbortController(); this.controls(); this.status.setText("正在读取草稿记录…");
		try { await work(action.signal); }
		catch (error) { if (!this.closed) this.status.setText(action.signal.aborted ? "操作已取消。保存可能已提交，请重新读取核对；输入保留。" : String(error)); }
		finally { if (!this.closed && this.action === action) { this.action = undefined; this.controls(); } }
	}
	private async renderList(signal: AbortSignal): Promise<void> {
		const data = await this.plugin.getKnowledgeDrafts().summaries(signal); signal.throwIfAborted(); this.list.empty();
		const details = this.list.createEl("details"); details.open = !this.draft; details.createEl("summary", { text: `已保存草稿 ${data.entries.length} 份` });
		const search = details.createEl("input", { type: "search", attr: { "aria-label": "搜索知识页草稿", placeholder: "搜索标题或 ID" } }), rows = details.createDiv();
		const render = () => { rows.empty(); for (const entry of data.entries.filter(e => (e.title + e.id).toLowerCase().includes(search.value.toLowerCase()))) {
			const b = this.button(rows, entry.title, () => { if (this.clean()) void this.run(s => this.load(entry.id, false, s)); }); b.dataset.draftId = entry.id;
			rows.createEl("p", { text: entry.id + ` · ${entry.saves} 个保存版本` + (entry.pending ? " · 有未完成保存" : "") + (entry.issues.length ? " · 需复查" : "") });
		} }; render(); search.oninput = render;
		for (const issue of data.issues) details.createEl("p", { text: issue });
		if (!data.entries.length) details.createEl("p", { text: "尚无草稿，可新建空白草稿，或从摘录详情开始。" });
		this.status.setText("草稿列表已读取；未改写正式笔记。");
	}
	private acceptNew(draft: KnowledgeDraft): void { this.draft = structuredClone(draft); this.baseline = structuredClone(draft); this.history = undefined; this.expected = null; this.preview = undefined; this.renderEditor(); this.status.setText("新草稿尚未保存。填写标题和正文后预览保存。"); }
	private async load(id: string, keep: boolean, signal: AbortSignal): Promise<void> {
		const history = await this.plugin.getKnowledgeDrafts().read(id, signal); signal.throwIfAborted();
		if (!history.current && !history.revisions.length && !history.pending.length) throw new Error(history.issues.join("；") || "草稿已缺失，未打开其他记录");
		const latest = history.current || history.pending[0] || history.revisions[0];
		if (keep && (!this.draft || this.draft.id !== id || objectDigest(this.draft.material) !== objectDigest(latest.draft.material))) throw new Error("附带材料或草稿身份不同，请保留输入并另存新草稿。");
		this.baseline = structuredClone(latest.draft); if (!keep) this.draft = structuredClone(latest.draft);
		this.history = history; this.expected = history.current?.digest || null; this.preview = undefined; this.renderEditor();
		this.status.setText(keep ? "已读取最新保存版本，当前输入保留；请对照下方版本记录后再保存。" : history.issues.length ? "草稿存在需复查记录，可查看历史或另存新草稿。" : history.pending.length ? "有未完成保存，请先预览恢复。" : "已恢复保存草稿，尚未创建正式知识页。");
	}
	private renderEditor(): void {
		this.editor.empty(); if (!this.draft) return; const draft = this.draft;
		this.editor.createEl("code", { text: draft.id });
		const title = this.editor.createEl("input", { type: "text", value: draft.title, attr: { "aria-label": "知识页草稿标题", placeholder: "草稿标题", maxlength: "200" } });
		const kind = this.editor.createEl("select", { attr: { "aria-label": "知识页草稿类型" } }); for (const [value, text] of Object.entries(DRAFT_KINDS)) kind.createEl("option", { value, text }); kind.value = draft.kind;
		const body = this.editor.createEl("textarea", { attr: { "aria-label": "知识页草稿正文", placeholder: "写下你的理解和需要核对的问题", maxlength: "40000", rows: "10" } }); body.value = draft.body;
		const changed = () => { draft.title = title.value; draft.kind = kind.value as KnowledgeDraft["kind"]; draft.body = body.value; this.preview = undefined; this.result.empty(); this.status.setText("有未保存的输入；预览后才能保存。"); };
		title.oninput = changed; kind.onchange = changed; body.oninput = changed;
		if (!this.history && draft.material) {
			const m = draft.material, choices = this.editor.createDiv(); choices.createEl("p", { text: "选择附带材料（保存后固定，正文可继续编辑）" });
			const check = (text: string, selected: boolean, update: (value: boolean) => void) => { const label = choices.createEl("label"); const input = label.createEl("input", { type: "checkbox", attr: { "aria-label": text } }); input.checked = selected; label.appendText(text); input.onchange = () => { update(input.checked); this.preview = undefined; this.result.empty(); }; };
			if (m.kind === "excerpt") { const r = readExcerptSnapshot(m.raw, { id: m.excerptId, annotationPath: m.path }).record; choices.createEl("p", { text: "原文摘录已选；个人备注可单独选择。" }); if (r.manualText.trim()) check("草稿附带个人备注", m.includeNote, value => m.includeNote = value); }
			else { const f = readAnswerExcerpt(m.raw, m.path); for (const role of Object.keys(ANSWER_CONTENT_ROLES) as AnswerContentRole[]) if (answerRoleText(f, role).trim()) check("草稿附带" + ANSWER_CONTENT_ROLES[role], m.roles.includes(role), value => { const set = new Set(m.roles); if (value) set.add(role); else set.delete(role); m.roles = (Object.keys(ANSWER_CONTENT_ROLES) as AnswerContentRole[]).filter(r => set.has(r)); }); }
		}
		const tools = this.editor.createDiv("rar-excerpt-actions");
		this.button(tools, "预览草稿", () => { try { const input = structuredClone(draft); input.updated = new Date(Math.max(Date.now(), Date.parse(draft.updated), Date.parse(this.baseline!.updated))).toISOString(); const text = renderKnowledgeDraft(input); this.preview = { draft: input, expected: this.expected, key: objectDigest(draft) }; this.showPreview(text); } catch (error) { this.status.setText(String(error)); } });
		this.button(tools, "重新读取（保留输入）", () => void this.run(signal => this.load(draft.id, true, signal)));
		this.button(tools, "放弃未保存输入", () => { this.draft = structuredClone(this.baseline); this.preview = undefined; this.renderEditor(); this.status.setText("已回到最近读取的草稿。附带材料仍保留。"); });
		this.button(tools, "复制为新草稿", () => { const copy = newKnowledgeDraft(draft.material); copy.title = draft.title; copy.kind = draft.kind; copy.body = draft.body; this.acceptNew(copy); });
		this.button(tools, "核对附带材料", () => void this.run(async signal => { this.status.setText(await draftMaterialStatus(this.app, this.plugin.getAnswerExcerpts(), draft.material, signal)); }));
		const material = this.editor.createEl("details"); material.createEl("summary", { text: "附带材料（固定快照，不随正文编辑改变）" });
		// The full draft preview below contains the same fixed material; raw source metadata is never rendered as HTML.
		material.createEl("pre", { cls: "curation-text", text: draft.material ? (draft.material.kind === "excerpt" ? "原文摘录" : "学习摘录（AI / 人工记录）") + " · " + draft.material.path + "\n保存后即使来源缺失，也保留当时材料；核对按钮检查当前版本。" : "手写草稿，无附带材料。" });
		if (this.history) {
			for (const issue of this.history.issues) this.editor.createEl("p", { text: issue });
			const versions = this.editor.createEl("details"); versions.createEl("summary", { text: `版本记录 · ${this.history.revisions.length} 个已保存 · ${this.history.pending.length} 个待恢复` });
			for (const r of [...this.history.pending, ...this.history.revisions]) {
				const row = versions.createEl("details"); row.createEl("summary", { text: (this.history.pending.includes(r) ? "未完成保存" : "已保存版本") + " · " + r.draft.updated }); row.createEl("code", { text: r.digest });
				row.ontoggle = () => { if (row.open && !row.querySelector("pre")) row.createEl("pre", { cls: "curation-text", text: renderKnowledgeDraft(r.draft) }); };
				this.button(row, "复制此版本为新草稿", () => { if (!this.clean()) return; const copy = newKnowledgeDraft(r.draft.material); copy.title = r.draft.title; copy.body = r.draft.body; copy.kind = r.draft.kind; this.acceptNew(copy); });
				if (this.history.pending.includes(r)) this.button(row, "预览恢复这次保存", () => { if (!this.clean()) return; this.result.empty(); this.result.createEl("pre", { cls: "curation-text", text: renderKnowledgeDraft(r.draft) }); this.button(this.result, "确认恢复草稿", () => void this.run(signal => this.recover(r, signal))); });
			}
		}
		this.result = this.editor.createDiv(); this.controls();
	}
	private showPreview(text: string): void {
		this.result.empty(); this.result.createEl("h3", { text: "草稿保存预览" });
		if (this.expected && this.baseline) { const before = this.result.createEl("details"); before.open = true; before.createEl("summary", { text: "最近读取的已保存版本" }); before.createEl("pre", { text: renderKnowledgeDraft(this.baseline), cls: "curation-text" }); }
		this.result.createEl("p", { text: "本次准备保存" }); this.result.createEl("pre", { text, cls: "curation-text" }); const preview = this.preview!;
		this.button(this.result, "确认保存草稿", () => void this.run(async signal => {
			if (this.preview !== preview || objectDigest(this.draft) !== preview.key || this.expected !== preview.expected) throw new Error("预览已变化，请重新核对");
			const saved = await this.plugin.getKnowledgeDrafts().save(preview.draft, preview.expected, signal); await this.load(saved.draft.id, false, signal); await this.renderList(signal); this.status.setText("草稿已保存，可关闭后继续编辑。正式知识页尚未创建。");
		})).addClass("mod-cta"); this.status.setText("核对正文与附带材料后确认，仅保存草稿记录。");
	}
	private async recover(r: DraftRevision, signal: AbortSignal): Promise<void> { const saved = await this.plugin.getKnowledgeDrafts().resume(r, signal); await this.load(saved.draft.id, false, signal); await this.renderList(signal); this.status.setText("未完成保存已恢复，草稿版本已核对。"); }
}
