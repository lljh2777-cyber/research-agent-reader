import { loadPrism, Modal, type App } from "obsidian";
import type { ReadingEvidence, ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";
import { codeQuote, codeSelectionOffsets } from "../code-reading/quote";

/** Line numbers are outside selectable code; source bytes never become executable HTML. */
export function renderCodeEvidence(parent: HTMLElement, evidence: ReadingEvidence): HTMLElement {
	const block = parent.createDiv("reading-code-block");
	block.createEl("pre", { cls: "reading-code-lines", text: Array.from({ length: (evidence.endLine || 1) - (evidence.startLine || 1) + 1 }, (_, i) => String((evidence.startLine || 1) + i)).join("\n"), attr: { "aria-hidden": "true" } });
	const pre = block.createEl("pre"); const code = pre.createEl("code", { text: evidence.text, cls: "language-" + (evidence.language || "text") });
	code.dataset.codeEvidenceId = evidence.id;
	void loadPrism().then(prism => { if (code.isConnected) prism.highlightElement(code); }).catch(() => { /* Plain source remains readable. */ });
	return code;
}
export class CodeSourceModal extends Modal {
	private closed = false;
	constructor(app: App, private service: ReadingWorkspaceService, private session: ReadingSession, private onCreated?: (nodeId: string) => void) { super(app); }
	onOpen(): void { this.modalEl.classList.add("reading-modal", "reading-code-source-modal"); this.titleEl.setText("源码与行号"); void this.load(); }
	onClose(): void { this.closed = true; this.contentEl.empty(); }
	private async load(): Promise<void> {
		const status = this.contentEl.createEl("p", { text: "正在核对源码版本…", attr: { role: "status" } });
		let evidence: ReadingEvidence[] = [];
		try { const doc = await this.service.document(this.session.id); evidence = doc.evidence; await doc.verify(); status.textContent = "只读源码 · " + this.session.source.code!.files.length + " 个文件 · 版本 " + this.session.source.fingerprint.slice(0, 12); }
		catch (error) { status.textContent = String(error) + "；以下只显示本会话已保存的历史代码。"; if (!evidence.length) evidence = [...new Map(this.session.nodes.flatMap(n => n.evidence).filter(e => e.kind === "code").map(e => [e.id, e])).values()]; }
		if (this.closed) return;
		this.contentEl.createEl("p", { cls: "reading-evidence-location", text: this.session.source.path });
		const search = this.contentEl.createEl("input", { type: "search", placeholder: "搜索文件或代码内容", attr: { "aria-label": "搜索源码" } });
		const select = this.contentEl.createEl("select", { attr: { "aria-label": "选择代码片段" } }); const body = this.contentEl.createDiv("reading-code-source-body");
		const question = this.contentEl.createDiv("reading-code-question");
		const show = () => { body.empty(); question.empty(); const item = evidence.find(e => e.id === select.value); if (item) { body.createEl("p", { text: item.label }); this.bindQuestion(renderCodeEvidence(body, item), item, question); } else body.createEl("p", { text: "没有匹配的代码片段" }); };
		const filter = () => { const previous = select.value; select.empty(); const term = search.value.trim().toLowerCase(); for (const item of evidence.filter(e => (e.label + " " + e.text).toLowerCase().includes(term))) select.createEl("option", { value: item.id, text: item.label }); if ([...select.options].some(o => o.value === previous)) select.value = previous; show(); };
		search.oninput = filter; select.onchange = show; filter();
	}
	private bindQuestion(code: HTMLElement, evidence: ReadingEvidence, box: HTMLElement): void {
		const session = this.service.repository.get(this.session.id);
		const parent = session.nodes.find(n => n.id === session.ui.selectedId && n.status === "done") || [...session.nodes].reverse().find(n => !n.branchId && n.status === "done");
		const label = box.createEl("small", { text: parent ? "新建支线 · " + parent.title + " · 划选上方代码后提问" : "完成首个主线讲解后，即可划选源码追问" });
		if (!parent) return;
		const prepare = box.createEl("button", { text: "追问选中代码", attr: { "aria-label": "追问选中代码" } }); prepare.disabled = true;
		const composer = box.createDiv(); let range: { start: number; end: number } | undefined; let sending = false;
		const capture = () => {
			if (sending) return;
			const selection = code.ownerDocument.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return;
			const selected = selection.getRangeAt(0); if (!code.contains(selected.startContainer) || !code.contains(selected.endContainer)) return;
			try {
				const before = selected.cloneRange(); before.selectNodeContents(code); before.setEnd(selected.startContainer, selected.startOffset);
				const after = selected.cloneRange(); after.selectNodeContents(code); after.setStart(selected.endContainer, selected.endOffset);
				range = codeSelectionOffsets(evidence.text, before.toString(), selected.toString(), after.toString()); prepare.disabled = false;
			} catch (error) { range = undefined; prepare.disabled = true; label.textContent = String(error); }
		};
		code.onmouseup = capture; code.onkeyup = capture;
		prepare.onclick = () => {
			if (!range || sending) return; const selected = { ...range }; const quote = codeQuote(evidence, selected.start, selected.end);
			composer.empty(); const draftKey = "code:" + parent.id + ":" + evidence.id + ":" + selected.start + ":" + selected.end;
			label.textContent = "新建支线 · " + parent.title + " · " + evidence.path + ":" + quote.startLine + "–" + quote.endLine;
			composer.createEl("pre", { cls: "reading-code-selection", text: quote.text });
			const input = composer.createEl("textarea", { placeholder: "这段代码你想了解什么？", attr: { "aria-label": "源码追问", rows: "2", maxlength: "4000" } });
			input.value = this.service.repository.get(session.id).ui.drafts[draftKey] || "";
			const status = composer.createEl("small", { attr: { role: "status" } });
			input.oninput = () => { const value = input.value; void this.service.repository.transact(session.id, s => { s.ui.drafts[draftKey] = value; }).catch(error => { status.textContent = "草稿保存失败：" + String(error); }); };
			const send = composer.createEl("button", { text: "建立支线", cls: "mod-cta", attr: { "aria-label": "建立源码支线" } });
			send.onclick = () => {
				if (sending || !input.value.trim()) return; sending = true; send.disabled = true; prepare.disabled = true; input.disabled = true; status.textContent = "正在核对代码版本…";
				void this.service.askCode(session.id, parent.id, evidence.id, selected.start, selected.end, input.value).then(id => {
					void this.service.repository.transact(session.id, s => { delete s.ui.drafts[draftKey]; }).catch(() => undefined);
					this.close(); this.onCreated?.(id);
				}).catch(error => { status.textContent = String(error); sending = false; send.disabled = false; prepare.disabled = false; input.disabled = false; });
			}; input.focus();
		};
	}
}
