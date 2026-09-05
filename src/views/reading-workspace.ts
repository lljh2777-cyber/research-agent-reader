import { Component, ItemView, MarkdownRenderer, Modal, Notice, type WorkspaceLeaf } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { ActionInputModal } from "../modals/action-input";
import { ACTION_BY_ID } from "../actions";
import { READING_VIEW_TYPE, type ReadingNode, type ReadingQuote, type ReadingSession, type ReadingWindow } from "../reading/types";
import { readingNode } from "../reading/session";
import { layoutReading } from "../reading/layout";
import { resolveReadingQuote } from "../reading/selection";
import { exportReading, safeReadingMarkdown, type ReadingExportScope } from "../reading/export";
import type { ReadingWorkspaceService } from "../reading/workspace";

const element = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className = "", text = ""): HTMLElementTagNameMap[K] => {
	const node = document.createElement(tag); node.className = className; node.textContent = text; parent.appendChild(node); return node;
};
function button(parent: HTMLElement, text: string, action: () => void, title = text): HTMLButtonElement {
	const node = element(parent, "button", "", text); node.type = "button"; node.title = title; node.setAttribute("aria-label", title); node.onclick = action; return node;
}
export class ReadingWorkspaceView extends ItemView {
	private service!: ReadingWorkspaceService;
	private sessionId = "";
	private unsubscribe?: () => void;
	private unsubscribeStream?: () => void;
	private signature = "";
	private renderer = new Component();
	private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private localDrafts = new Map<string, string>();
	private quote?: ReadingQuote;
	private activeWindow = "";
	private cleanupDrag?: () => void;
	constructor(leaf: WorkspaceLeaf, private readonly plugin: AgentDashboardPlugin) { super(leaf); }
	getViewType(): string { return READING_VIEW_TYPE; }
	getDisplayText(): string { return "PDF 交互深读"; }
	getIcon(): string { return "workflow"; }
	getState(): Record<string, unknown> { return { sessionId: this.sessionId }; }
	async setState(state: unknown): Promise<void> {
		const id = (state as { sessionId?: string })?.sessionId;
		if (id) { this.sessionId = id; if (this.service) this.render(true); }
	}
	async onOpen(): Promise<void> {
		this.service = this.plugin.getReadingWorkspace(); await this.service.ready();
		if (!this.service.repository.sessions.has(this.sessionId)) this.sessionId = [...this.service.repository.sessions.keys()].slice(-1)[0] || "";
		this.renderer.load(); this.unsubscribe = this.service.repository.subscribe((id) => { if (id === this.sessionId) this.render(); });
		this.unsubscribeStream = this.plugin.getReadingEngine().subscribe((id, nodeId, text) => {
			if (id !== this.sessionId) return;
			this.contentEl.querySelectorAll<HTMLElement>("[data-answer-id]").forEach((answer) => {
				if (answer.dataset.answerId === nodeId) { const body = answer.querySelector(".reading-answer-content"); if (body) body.textContent = text; }
			});
		});
		this.render(true);
		if (this.service.repository.errors.length) new Notice("部分阅读会话无法加载，文件已保留：" + this.service.repository.errors.join("；"), 10000);
	}
	async onClose(): Promise<void> {
		this.unsubscribe?.(); this.unsubscribeStream?.(); this.cleanupDrag?.(); this.renderer.unload();
		for (const timer of this.draftTimers.values()) clearTimeout(timer);
		for (const [key, value] of this.localDrafts) { const separator = key.indexOf("|"); const id = key.slice(0, separator); const target = key.slice(separator + 1);
			await this.service.repository.transact(id, (session) => { session.ui.drafts[target] = value; }).catch((error) => new Notice(String(error))); }
	}
	private get session(): ReadingSession | undefined { return this.service?.repository.sessions.get(this.sessionId); }
	private handle(operation: Promise<unknown>): void { void operation.catch((error) => new Notice(error instanceof Error ? error.message : String(error))); }
	private updateUI(edit: (ui: ReadingSession["ui"]) => void): void {
		const id = this.sessionId; this.handle(this.service.repository.transact(id, (session) => edit(session.ui)));
	}
	private selectSession(id: string): void { this.sessionId = id; this.quote = undefined; this.render(true); this.app.workspace.requestSaveLayout(); }
	private render(force = false): void {
		const session = this.session;
		const signature = JSON.stringify(session ? [session.id, session.nodes, session.outline, session.completed, session.backend, session.model,
			session.ui.mode, session.ui.split, session.ui.selectedId, session.ui.zoom, session.ui.windows, session.ui.collapsed] : null);
		if (!force && this.signature === signature) return; this.signature = signature;
		const oldScroll = new Map<string, [number, number]>();
		this.contentEl.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((node) => oldScroll.set(node.dataset.scrollKey!, [node.scrollLeft, node.scrollTop]));
		const focused = this.contentEl.contains(document.activeElement) ? document.activeElement as HTMLTextAreaElement : null;
		const focusKey = focused?.dataset.composer; const cursor = focused?.selectionStart;
		this.renderer.unload(); this.renderer = new Component(); this.renderer.load();
		this.contentEl.replaceChildren(); this.contentEl.classList.add("reading-workspace");
		const toolbar = element(this.contentEl, "div", "reading-toolbar");
		const picker = element(toolbar, "select"); picker.setAttribute("aria-label", "选择阅读会话");
		for (const item of this.service.repository.sessions.values()) { const option = element(picker, "option", "", item.title); option.value = item.id; }
		picker.value = this.sessionId; picker.onchange = () => this.selectSession(picker.value);
		button(toolbar, "新建阅读", () => this.openSource());
		button(toolbar, "交互演示", () => this.handle(this.service.demo().then((id) => this.selectSession(id))));
		button(toolbar, "一次性深读", () => {
			const action = ACTION_BY_ID.get("pdf-xray")!;
			new ActionInputModal(this.app, this.plugin, action, ({ input, overrides, options }) => {
				this.handle(this.plugin.runClassicReading(input, overrides, options));
			}).open();
		});
		if (!session) { element(this.contentEl, "p", "reading-empty", "选择原始 PDF 或已验证的 article.md 开始阅读，也可先打开交互演示。"); return; }
		button(toolbar, session.ui.mode === "split" ? "仅思维导图" : "导图＋对话", () => this.updateUI((ui) => { ui.mode = ui.mode === "split" ? "map" : "split"; }));
		button(toolbar, "−", () => this.updateUI((ui) => { ui.zoom = Math.max(0.4, ui.zoom - 0.1); }), "缩小导图");
		button(toolbar, "+", () => this.updateUI((ui) => { ui.zoom = Math.min(1.8, ui.zoom + 0.1); }), "放大导图");
		button(toolbar, "导出", () => this.openExport());
		button(toolbar, "模型", () => this.openModel());
		element(toolbar, "span", "reading-source-label", session.demo ? "示例内容 · 未调用模型" : session.source.kind === "pdf" ? "原始 PDF" : "已验证 MinerU 原文");
		const body = element(this.contentEl, "div", "reading-body");
		if (session.ui.mode === "split") {
			const chat = element(body, "div", "reading-main-chat"); chat.style.flexBasis = (session.ui.split * 100) + "%";
			const messages = element(chat, "div", "reading-messages"); messages.dataset.scrollKey = "main";
			if (session.outline.length) { const details = element(messages, "details", "reading-outline"); element(details, "summary", "", "主线提纲"); session.outline.forEach((title, i) => element(details, "p", "", (i + 1) + ". " + title)); }
			for (const id of session.mainIds) this.renderAnswer(messages, readingNode(session, id));
			if (!session.mainIds.length) button(messages, "开始讲解 →", () => this.handle(this.service.advance(session.id)));
			this.renderComposer(chat, "main");
			const divider = element(body, "div", "reading-divider"); divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", "调整对话与导图宽度");
			this.drag(divider, (event) => { const box = body.getBoundingClientRect(); const split = Math.max(0.25, Math.min(0.75, (event.clientX - box.left) / box.width)); chat.style.flexBasis = split * 100 + "%"; return () => this.updateUI((ui) => { ui.split = split; }); });
		}
		const mapArea = element(body, "div", "reading-map-area");
		const map = element(mapArea, "div", "reading-map-scroll"); map.dataset.scrollKey = "map";
		this.renderMap(map, session);
		if (session.ui.mode === "map") this.renderComposer(mapArea, "main");
		if (!session.mainIds.length) button(mapArea, "开始讲解 →", () => this.handle(this.service.advance(session.id)));
		const windows = element(this.contentEl, "div", "reading-windows");
		for (const floating of session.ui.windows) this.renderWindow(windows, floating);
		this.contentEl.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((node) => {
			const saved = oldScroll.get(node.dataset.scrollKey!); if (saved) { node.scrollLeft = saved[0]; node.scrollTop = saved[1]; }
		});
		if (focusKey) { const input = [...this.contentEl.querySelectorAll<HTMLTextAreaElement>("textarea[data-composer]")].find((item) => item.dataset.composer === focusKey);
			input?.focus({ preventScroll: true }); if (input && cursor != null) input.setSelectionRange(cursor, cursor); }
	}
	private renderMap(parent: HTMLElement, session: ReadingSession): void {
		const layout = layoutReading(session); const outer = element(parent, "div", "reading-map-extent");
		outer.style.width = layout.width * session.ui.zoom + "px"; outer.style.height = layout.height * session.ui.zoom + "px";
		const canvas = element(outer, "div", "reading-map-canvas"); canvas.style.width = layout.width + "px"; canvas.style.height = layout.height + "px"; canvas.style.transform = "scale(" + session.ui.zoom + ")";
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("width", String(layout.width)); svg.setAttribute("height", String(layout.height)); canvas.appendChild(svg);
		const positions = new Map(layout.nodes.map((node) => [node.id, node]));
		for (const point of layout.nodes) {
			const node = readingNode(session, point.id); const previous = node.parentId ? positions.get(node.parentId) : null;
			if (previous) { const line = document.createElementNS(svg.namespaceURI, "path"); const main = node.branchId === null;
				const x1 = previous.x + (main ? 110 : 220); const y1 = previous.y + (main ? 70 : 35);
				const x2 = point.x + (main ? 110 : 0); const y2 = point.y + (main ? 0 : 35);
				line.setAttribute("d", "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + 30) + ", " + x2 + " " + (y2 - 30) + ", " + x2 + " " + y2); svg.appendChild(line); }
			const card = element(canvas, "div", "reading-map-node " + (node.branchId ? "is-branch" : "is-main") + (session.ui.selectedId === node.id ? " is-selected" : ""));
			card.style.left = point.x + "px"; card.style.top = point.y + "px"; card.dataset.nodeId = node.id;
			button(card, node.title || "正在准备", () => this.selectNode(node.id));
			element(card, "small", "", ({ pending: "等待", running: "生成中", done: "已讲解", failed: "失败", interrupted: "已中断" })[node.status]);
			if (point.hiddenCount) element(card, "small", "", "＋" + point.hiddenCount + " 轮");
			if (node.branchId) button(card, session.ui.collapsed.includes(node.branchId) ? "展开" : "折叠", () => this.updateUI((ui) => { ui.collapsed = ui.collapsed.includes(node.branchId!) ? ui.collapsed.filter((id) => id !== node.branchId) : [...ui.collapsed, node.branchId!]; }));
			if (node.id === session.mainIds[session.mainIds.length - 1] && node.status === "done" && !session.completed) {
				const next = button(card, "→", () => this.handle(this.service.advance(session.id)), "继续下一步主线"); next.className = "reading-advance";
			}
		}
	}
	private selectNode(id: string): void {
		const session = this.session!; const node = readingNode(session, id);
		this.quote = undefined;
		this.handle(this.service.repository.transact(session.id, (draft) => {
			draft.ui.selectedId = id;
			if (draft.ui.mode === "map" || node.branchId) this.ensureWindow(draft, id);
		}).then(() => {
			const selector = node.branchId || session.ui.mode === "map" ? ".reading-float [data-answer-id]" : ".reading-main-chat [data-answer-id]";
			const answer = [...this.contentEl.querySelectorAll<HTMLElement>(selector)].find((item) => item.dataset.answerId === id);
			answer?.scrollIntoView({ block: "nearest", behavior: "smooth" }); answer?.classList.add("reading-highlight");
		}));
	}
	private ensureWindow(session: ReadingSession, id: string): void {
		const node = readingNode(session, id); const key = node.branchId || id;
		const existing = session.ui.windows.find((item) => item.key === key);
		if (existing) { existing.nodeId = id; existing.minimized = false; return; }
		session.ui.windows = session.ui.windows.filter((item) => item.pinned);
		session.ui.windows.push({ key, nodeId: id, pinned: false, minimized: false, x: 48, y: 70, width: 520, height: 480 });
	}
	private renderWindow(parent: HTMLElement, state: ReadingWindow): void {
		const session = this.session!; const node = session.nodes.find((item) => item.id === state.nodeId); if (!node) return;
		const floating = element(parent, "section", "reading-float" + (state.minimized ? " is-minimized" : "")); floating.setAttribute("role", "dialog"); floating.setAttribute("aria-label", node.title);
		floating.dataset.windowKey = state.key; floating.style.left = Math.max(0, Math.min(state.x, this.contentEl.clientWidth - 280)) + "px"; floating.style.top = Math.max(40, Math.min(state.y, this.contentEl.clientHeight - 60)) + "px";
		floating.style.width = Math.min(state.width, Math.max(280, this.contentEl.clientWidth - 20)) + "px"; floating.style.height = state.minimized ? "auto" : state.height + "px";
		floating.onpointerdown = () => { this.activeWindow = state.key; this.contentEl.querySelectorAll<HTMLElement>(".reading-float").forEach((item) => { item.style.zIndex = item === floating ? "12" : "10"; }); };
		const header = element(floating, "div", "reading-float-header"); element(header, "strong", "", node.branchId ? "支线 · " + readingNode(session, session.branches.find((b) => b.id === node.branchId)!.nodeIds[0]).question : node.title);
		button(header, state.pinned ? "取消固定" : "固定", () => this.updateUI((ui) => { ui.windows.find((w) => w.key === state.key)!.pinned = !state.pinned; }));
		button(header, state.minimized ? "展开" : "收起", () => this.updateUI((ui) => { ui.windows.find((w) => w.key === state.key)!.minimized = !state.minimized; }));
		button(header, "×", () => this.updateUI((ui) => { ui.windows = ui.windows.filter((w) => w.key !== state.key); }), "关闭窗口，保留对话");
		let offsetX = 0; let offsetY = 0;
		this.drag(header, (event, first) => {
			const outer = this.contentEl.getBoundingClientRect(); if (first) { const rect = floating.getBoundingClientRect(); offsetX = event.clientX - rect.left; offsetY = event.clientY - rect.top; }
			const x = Math.max(0, Math.min(outer.width - 200, event.clientX - outer.left - offsetX)); const y = Math.max(40, Math.min(outer.height - 40, event.clientY - outer.top - offsetY));
			floating.style.left = x + "px"; floating.style.top = y + "px";
			return () => this.updateUI((ui) => { const saved = ui.windows.find((w) => w.key === state.key); if (saved) { saved.x = x; saved.y = y; } });
		});
		if (state.minimized) return;
		const messages = element(floating, "div", "reading-messages"); messages.dataset.scrollKey = state.key;
		const ids = node.branchId ? session.branches.find((branch) => branch.id === node.branchId)!.nodeIds : [node.id];
		ids.forEach((id) => this.renderAnswer(messages, readingNode(session, id)));
		this.renderComposer(floating, state.key, node.branchId || undefined, node.id);
		const resize = element(floating, "div", "reading-resize"); resize.title = "调整窗口大小";
		this.drag(resize, (event) => { const box = floating.getBoundingClientRect(); const width = Math.max(300, event.clientX - box.left); const height = Math.max(220, event.clientY - box.top); floating.style.width = width + "px"; floating.style.height = height + "px";
			return () => this.updateUI((ui) => { const saved = ui.windows.find((w) => w.key === state.key); if (saved) { saved.width = width; saved.height = height; } }); });
	}
	private renderAnswer(parent: HTMLElement, node: ReadingNode): void {
		const article = element(parent, "article", "reading-answer"); article.dataset.answerId = node.id;
		if (node.question) element(article, "div", "reading-question", node.question);
		element(article, "h3", "", node.title);
		if (node.quote) element(article, "blockquote", "reading-quote", node.quote.text);
		const content = element(article, "div", "reading-answer-content");
		try { void MarkdownRenderer.render(this.app, safeReadingMarkdown(node.content || this.plugin.getReadingEngine().streamed(this.sessionId, node.id) || "正在准备讲解…"), content, "", this.renderer); }
		catch { content.textContent = node.content; }
		const selectionAction = button(article, "选中文字后追问", () => this.captureQuote(node, content));
		selectionAction.disabled = node.status !== "done";
		content.onmouseup = () => { const selected = window.getSelection(); if (node.status === "done" && selected?.toString().trim() && content.contains(selected.anchorNode) && content.contains(selected.focusNode)) { this.captureQuote(node, content); } };
		for (const evidence of node.evidence) button(article, evidence.label + (evidence.visualInspected ? " · 已查看图像" : ""), () => this.showEvidence(node.id, evidence.id));
		if (node.retrieval) {
			const details = element(article, "details"); element(details, "summary", "", "知识库检索路径");
			element(details, "p", "", "检索词：" + node.retrieval.query);
			element(details, "p", "", node.retrieval.paths.join("\n") || "Vault 中未找到足够依据");
			if (node.retrieval.error) element(details, "p", "reading-error", node.retrieval.error);
		}
		if (node.error) element(article, "p", "reading-error", node.error);
		if (node.status === "failed" || node.status === "interrupted") button(article, "重试", () => this.handle(this.service.generate(this.sessionId, node.id)));
		if (node.status === "running" || node.status === "pending") button(article, "停止", () => this.service.stop(this.sessionId, node.id));
	}
	private captureQuote(node: ReadingNode, content: HTMLElement): void {
		const selected = window.getSelection(); const text = selected?.toString().trim() || "";
		if (!text || !content.contains(selected?.anchorNode || null)) { new Notice("先在这条回答中选中文字"); return; }
		try {
			const range = selected!.getRangeAt(0); const before = range.cloneRange(); before.selectNodeContents(content); before.setEnd(range.startContainer, range.startOffset);
			const after = range.cloneRange(); after.selectNodeContents(content); after.setStart(range.endContainer, range.endOffset);
			this.quote = resolveReadingQuote(node.id, node.content, text, before.toString(), after.toString());
		} catch (error) { new Notice(String(error)); return; }
		this.handle(this.service.repository.transact(this.sessionId, (session) => { session.ui.selectedId = node.id; this.ensureWindow(session, node.id); }).then(() => {
			this.render(true); this.contentEl.querySelector<HTMLTextAreaElement>(".reading-float textarea")?.focus();
		}));
	}
	private renderComposer(parent: HTMLElement, key: string, branchId?: string, nodeId?: string): void {
		const session = this.session!; const sessionId = session.id;
		const target = nodeId || (session.nodes.find((node) => node.id === session.ui.selectedId && !node.branchId)?.id) || session.mainIds[session.mainIds.length - 1];
		const box = element(parent, "div", "reading-composer"); const localKey = sessionId + "|" + key;
		const quoted = this.quote && this.quote.nodeId === target ? this.quote : undefined;
		element(box, "small", "", quoted ? "引用追问：" + quoted.text.slice(0, 80) : branchId ? "继续这条支线" : "基于：" + (target ? readingNode(session, target).title : "请先开始主线"));
		if (quoted) button(box, "取消引用", () => { this.quote = undefined; this.render(true); });
		const input = element(box, "textarea"); input.rows = 2; input.placeholder = "输入你想了解的问题…"; input.dataset.composer = key;
		input.value = this.localDrafts.get(localKey) ?? session.ui.drafts[key] ?? "";
		input.oninput = () => { const value = input.value; this.localDrafts.set(localKey, value); clearTimeout(this.draftTimers.get(localKey));
			this.draftTimers.set(localKey, setTimeout(() => { this.handle(this.service.repository.transact(sessionId, (draft) => { draft.ui.drafts[key] = value; })); }, 400)); };
		const send = async (): Promise<void> => {
			if (!target || !input.value.trim()) return; const question = input.value;
			const id = await this.service.ask(sessionId, quoted?.nodeId || target, question, quoted ? undefined : branchId, quoted);
			this.quote = undefined; this.localDrafts.set(localKey, ""); clearTimeout(this.draftTimers.get(localKey));
			await this.service.repository.transact(sessionId, (draft) => { draft.ui.drafts[key] = ""; this.ensureWindow(draft, id); });
		};
		button(box, "发送", () => this.handle(send()));
		input.onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.handle(send()); } };
	}
	private drag(handle: HTMLElement, move: (event: PointerEvent, first: boolean) => () => void): void {
		handle.onpointerdown = (event) => {
			if ((event.target as HTMLElement).closest("button")) return;
			event.preventDefault(); this.cleanupDrag?.(); let commit = move(event, true);
			const onMove = (next: PointerEvent): void => { commit = move(next, false); };
			const stop = (): void => { document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", stop); this.cleanupDrag = undefined; commit(); };
			document.addEventListener("pointermove", onMove); document.addEventListener("pointerup", stop, { once: true });
			this.cleanupDrag = () => { document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", stop); };
		};
	}
	private openSource(): void {
		const modal = new Modal(this.app); modal.titleEl.setText("开始交互阅读");
		const kind = element(modal.contentEl, "select"); [["pdf", "原始 PDF"], ["article", "已验证 article.md"]].forEach(([value, label]) => { element(kind, "option", "", label).value = value; });
		const path = element(modal.contentEl, "input"); path.placeholder = "PDF 完整路径，或 papers/<citekey>/article.md"; path.style.width = "100%";
		const backend = element(modal.contentEl, "select"); element(backend, "option", "", "Codex CLI").value = "codex-cli";
		this.plugin.getVerifiedProviderProfiles().forEach((profile) => { element(backend, "option", "", profile.name + " · " + profile.model).value = profile.id; });
		const model = element(modal.contentEl, "input"); model.placeholder = "Codex 模型（留空使用配置）";
		element(modal.contentEl, "p", "", "所选内容和相关图像将交给所选模型分析。会话自动保存在插件目录。");
		const submit = button(modal.contentEl, "打开并开始讲解", () => {
			submit.disabled = true;
			this.handle(this.service.create(kind.value as "pdf" | "article", path.value.trim().replace(/^"|"$/g, ""), backend.value, model.value.trim())
				.then((id) => { modal.close(); this.selectSession(id); return this.service.advance(id); }).finally(() => { submit.disabled = false; }));
		}); modal.open();
	}
	private showEvidence(nodeId: string, evidenceId: string): void {
		const item = readingNode(this.session!, nodeId).evidence.find((evidence) => evidence.id === evidenceId); if (!item) return;
		const modal = new Modal(this.app); modal.titleEl.setText(item.label); element(modal.contentEl, "p", "", item.path + (item.page ? " · 第 " + item.page + " 页" : ""));
		element(modal.contentEl, "pre", "reading-evidence-text", item.text);
		if (item.kind === "vault") button(modal.contentEl, "打开来源笔记", () => { this.plugin.openVaultFile(item.path); modal.close(); });
		if (item.kind === "paper" && this.session!.source.kind === "article") button(modal.contentEl, "在阅读器打开原文", () => this.handle(this.plugin.activateMineruReaderView(item.path)));
		if (item.kind === "paper") this.handle(this.service.document(this.sessionId).then(async (document) => {
			await document.verify(); const image = await document.image(item); if (image) { const img = element(modal.contentEl, "img"); img.src = image.dataUrl; img.style.maxWidth = "100%"; }
		})); modal.open();
	}
	private openModel(): void {
		const session = this.session!; const modal = new Modal(this.app); modal.titleEl.setText("阅读模型");
		const backend = element(modal.contentEl, "select"); element(backend, "option", "", "Codex CLI").value = "codex-cli";
		this.plugin.getVerifiedProviderProfiles().forEach((profile) => { element(backend, "option", "", profile.name + " · " + profile.model).value = profile.id; }); backend.value = session.backend;
		const model = element(modal.contentEl, "input"); model.value = session.model; model.placeholder = "Codex 模型，留空使用设置";
		button(modal.contentEl, "保存", () => this.handle(this.service.repository.transact(session.id, (draft) => { draft.backend = backend.value; draft.model = model.value.trim(); }).then(() => modal.close()))); modal.open();
	}
	private openExport(): void {
		const sessionId = this.sessionId; const nodeId = this.session!.ui.selectedId;
		const modal = new Modal(this.app); modal.titleEl.setText("导出学习笔记"); const scope = element(modal.contentEl, "select");
		[["node", "选中节点"], ["branch", "选中支线"], ["session", "完整会话"]].forEach(([value, title]) => { element(scope, "option", "", title).value = value; });
		element(modal.contentEl, "p", "", "将已完成的回答保存为 wiki/qa/ 下的新笔记，并追加到日志。不会改变正式论文笔记的深读状态。");
		const submit = button(modal.contentEl, "导出", () => { submit.disabled = true;
			this.handle(exportReading(this.app, this.service.repository.get(sessionId), scope.value as ReadingExportScope, nodeId).then((result) => {
				modal.close(); new Notice(result.warning || "已导出：" + result.path); this.plugin.openVaultFile(result.path);
			}).finally(() => { submit.disabled = false; }));
		}); modal.open();
	}
}
