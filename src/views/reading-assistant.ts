import { Component, MarkdownRenderer, Modal, Notice, type App } from "obsidian";
import { setTimeout, clearTimeout } from "node:timers";
import type AgentDashboardPlugin from "../plugin";
import { ASSISTANT_CAPABILITIES } from "../assistant/capabilities";
import type { AssistantRun } from "../assistant/types";
import { safeReadingMarkdown } from "../reading/export";

const states = { running: "正在处理", done: "已完成", failed: "未完成", interrupted: "已中断" };
function button(parent: HTMLElement, text: string, run: () => unknown): HTMLButtonElement {
	const b = parent.createEl("button", { text, attr: { type: "button" } });
	b.onclick = () => { b.disabled = true; void Promise.resolve().then(run).catch(e => new Notice(String(e), 8000)).finally(() => { if (b.isConnected) b.disabled = false; }); }; return b;
}
export class ReadingAssistantModal extends Modal {
	private closed = false; private unsubscribe?: () => void; private renderer = new Component();
	private results!: HTMLElement; private status!: HTMLElement; private history!: HTMLSelectElement; private profile!: HTMLSelectElement; private input!: HTMLTextAreaElement; private submit!: HTMLButtonElement; private stop!: HTMLButtonElement;
	private selectedRun = ""; private following = true; private draftTimer?: ReturnType<typeof setTimeout>;
	constructor(app: App, private plugin: AgentDashboardPlugin, readonly sessionId: string, readonly nodeId: string) { super(app); }
	private get service() { return this.plugin.getReadingAssistant(); }
	private get session() { return this.plugin.getReadingWorkspace().repository.get(this.sessionId); }
	onOpen(): void {
		this.titleEl.setText("阅读助手"); this.modalEl.addClass("reading-assistant-modal"); this.renderer.load();
		const node = this.session.nodes.find(n => n.id === this.nodeId)!;
		const top = this.contentEl.createDiv("assistant-context"); top.createEl("small", { text: this.session.title });
		button(top, "当前目标 · " + node.title, () => { this.close(); return this.plugin.openLearningRecord(this.sessionId, this.nodeId); });
		const toolbar = this.contentEl.createDiv("assistant-toolbar"); this.profile = toolbar.createEl("select", { attr: { "aria-label": "助手 Direct API 模型" } });
		const profiles = this.plugin.getVerifiedProviderProfiles(); for (const p of profiles) this.profile.createEl("option", { value: p.id, text: p.name + " · " + p.model });
		this.profile.value = profiles.some(p => p.id === this.session.backend) ? this.session.backend : profiles.some(p => p.id === this.plugin.settings.activeProviderId) ? this.plugin.settings.activeProviderId : profiles[0]?.id || "";
		this.history = toolbar.createEl("select", { attr: { "aria-label": "助手请求历史" } }); this.history.onchange = () => { this.selectedRun = this.history.value; this.following = false; this.render(); };
		this.status = this.contentEl.createEl("p", { cls: "assistant-status", attr: { role: "status", "aria-live": "polite" } });
		this.results = this.contentEl.createDiv("assistant-results");
		const footer = this.contentEl.createDiv("assistant-composer");
		this.input = footer.createEl("textarea", { attr: { "aria-label": "阅读助手请求", placeholder: "例如：哪些节点还需要回顾？把当前支线准备成学习笔记。", rows: "2", maxlength: "4000" } });
		this.input.value = this.session.ui.drafts["assistant:" + this.nodeId] || "";
		this.input.oninput = () => { clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.saveDraft(), 300); };
		this.input.onkeydown = event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!this.submit.disabled) void this.send().catch(e => new Notice(String(e), 8000)); } };
		const controls = footer.createDiv("assistant-composer-actions"); controls.createEl("small", { text: "每次请求独立处理 · Ctrl/⌘ + Enter 发送" });
		this.stop = button(controls, "停止", () => this.service.stop(this.sessionId)); this.submit = button(controls, "发送请求", () => this.send()); this.submit.addClass("mod-cta");
		this.unsubscribe = this.service.subscribe(() => this.render());
		void this.service.ready().then(() => { if (!this.closed) this.render(); }).catch(e => { if (!this.closed) this.status.setText(String(e)); }); this.render();
	}
	private saveDraft(): void {
		clearTimeout(this.draftTimer); const value = this.input.value;
		void this.plugin.getReadingWorkspace().repository.transact(this.sessionId, s => { if (value) s.ui.drafts["assistant:" + this.nodeId] = value; else delete s.ui.drafts["assistant:" + this.nodeId]; }).catch(e => new Notice("助手草稿保存失败：" + String(e)));
	}
	private async send(): Promise<void> {
		if (this.service.isRunning(this.sessionId)) return; const question = this.input.value.trim(); if (!question) return;
		if (!this.profile.value) throw new Error("请先在插件设置中配置并测试 Direct API 模型");
		this.following = true; this.selectedRun = ""; this.submit.disabled = true; this.saveDraft();
		const task = this.service.start(this.sessionId, this.nodeId, this.profile.value, question); this.render();
		try { await task; if (!this.closed && this.input.value.trim() === question) { this.input.value = ""; this.saveDraft(); } }
		finally { if (!this.closed) this.render(); }
	}
	private render(): void {
		if (this.closed) return;
		const runs = [...this.service.runs.values()].filter(r => r.sessionId === this.sessionId && r.nodeId === this.nodeId).sort((a, b) => b.created.localeCompare(a.created));
		if (this.following || !runs.some(r => r.id === this.selectedRun)) this.selectedRun = runs[0]?.id || "";
		this.history.empty(); if (!runs.length) this.history.createEl("option", { value: "", text: "暂无请求历史" });
		for (const r of runs) this.history.createEl("option", { value: r.id, text: new Date(r.created).toLocaleString() + " · " + r.question.slice(0, 30) }); this.history.value = this.selectedRun;
		const running = this.service.isRunning(this.sessionId); this.submit.disabled = running || !this.profile.value; this.profile.disabled = running; this.stop.disabled = !running;
		const run = runs.find(r => r.id === this.selectedRun);
		this.status.setText((running ? "助手正在处理本会话的请求，关闭窗口后仍会继续。" : "先核对依据，再整理和导出。") + (this.service.errors.length ? " 有 " + this.service.errors.length + " 条记录无法恢复，原文件已保留。" : ""));
		const scroll = this.results.scrollTop; this.renderer.unload(); this.renderer = new Component(); this.renderer.load(); this.results.empty();
		if (!run) {
			this.results.createEl("h3", { text: "把下一步交给阅读助手" });
			this.results.createEl("p", { text: "结合当前阅读背景，查看进度、核对原文、查找已有知识，或准备整理和导出。" });
			const suggestions = this.results.createDiv("assistant-suggestions");
			for (const question of ["列出本篇标记为待回顾和有疑问的节点", "核对当前节点的原文依据，并说明证据边界", "为当前支线准备学习笔记导出", "查找适合补充当前理解的正式笔记，准备整理操作"]) button(suggestions, question, () => { this.input.value = question; this.saveDraft(); this.input.focus(); });
			this.results.createEl("small", { text: "助手使用所选 Direct API；后续讲解或整理沿用阅读会话模型，并在各自记录中计量。查看历史不调用模型。" });
		} else this.renderRun(run);
		this.results.scrollTop = scroll;
	}
	private renderRun(run: AssistantRun): void {
		this.results.createEl("p", { cls: "assistant-question", text: run.question });
		this.results.createEl("small", { text: states[run.state] + " · " + run.model });
		const trace = this.results.createEl("details", { cls: "assistant-trace" }); trace.open = run.state !== "done";
		trace.createEl("summary", { text: "执行轨迹 · " + run.steps.length + " 步 · " + run.calls.length + " 次模型调用" });
		for (const s of run.steps) { const item = trace.createEl("details"); item.createEl("summary", { text: (s.ok ? "✓ " : "! ") + (ASSISTANT_CAPABILITIES.find(c => c.name === s.tool)?.label || s.tool) + (s.cached ? " · 本轮复用" : "") }); item.createEl("pre", { text: s.summary }); }
		const reported = (key: "input" | "output" | "cachedInput") => { const known = run.calls.filter(c => c[key] !== undefined); return known.length ? known.reduce((sum, c) => sum + c[key]!, 0).toLocaleString() + (known.length < run.calls.length ? "（部分调用）" : "") : "未报告"; };
		trace.createEl("p", { cls: "assistant-usage", text: `接口报告：输入 ${reported("input")} / 输出 ${reported("output")} / 缓存输入 ${reported("cachedInput")} token。累计文字输入估算 ${run.calls.reduce((sum, c) => sum + c.estimatedInput, 0).toLocaleString()} token。` });
		if (run.answer) { const answer = this.results.createDiv("markdown-rendered assistant-answer"); void MarkdownRenderer.render(this.app, safeReadingMarkdown(run.answer), answer, "", this.renderer).catch(e => { if (answer.isConnected) answer.setText(run.answer); }); }
		if (run.error) this.results.createEl("p", { cls: "reading-error", text: run.error });
		if (run.state === "failed" || run.state === "interrupted") button(this.results, "填入原请求重试", () => { this.input.value = run.question; this.saveDraft(); this.input.focus(); });
		if (run.sources.length) {
			const sources = this.results.createDiv("assistant-sources"); sources.createEl("small", { text: "本轮实际读取的依据 · 文字与图注" });
			for (const source of run.sources) button(sources, source.id + " · " + (source.kind === "paper" ? "本文" : "知识库补充") + " · " + source.label, () => this.plugin.openAssistantEvidence(run.id, source.id));
		}
		if (run.state === "done") for (const a of run.actions) {
			const card = this.results.createDiv("assistant-action"); const title = { curation: "准备整理建议", export: "预览学习笔记", advance: "继续主线讲解" }[a.kind];
			card.createEl("strong", { text: title }); card.createEl("small", { text: a.target || ({ node: "选中节点", branch: "所在支线", session: "完整会话" }[a.scope]) });
			if (a.kind === "advance" && a.state === "opened") button(card, "已交接 · 查看阅读进度", () => { this.close(); return this.plugin.openLearningRecord(run.sessionId, this.session.ui.selectedId); });
			else button(card, a.state === "opened" ? "重新打开预览" : title, async () => { await this.plugin.dispatchAssistantAction(run.id, a.id); this.close(); });
			card.createEl("small", { text: a.kind === "advance" ? "点击后调用会话模型生成下一单元。" : "在预览中核对范围和依据；尚未写入笔记。" });
		}
	}
	onClose(): void { this.closed = true; if (this.input) this.saveDraft(); this.unsubscribe?.(); this.renderer.unload(); this.contentEl.empty(); }
}
