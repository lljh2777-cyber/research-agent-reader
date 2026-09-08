import { loadPrism, Modal, type App } from "obsidian";
import type { ReadingEvidence, ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";

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
	constructor(app: App, private service: ReadingWorkspaceService, private session: ReadingSession) { super(app); }
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
		const show = () => { body.empty(); const item = evidence.find(e => e.id === select.value); if (item) { body.createEl("p", { text: item.label }); renderCodeEvidence(body, item); } else body.createEl("p", { text: "没有匹配的代码片段" }); };
		const filter = () => { const previous = select.value; select.empty(); const term = search.value.trim().toLowerCase(); for (const item of evidence.filter(e => (e.label + " " + e.text).toLowerCase().includes(term))) select.createEl("option", { value: item.id, text: item.label }); if ([...select.options].some(o => o.value === previous)) select.value = previous; show(); };
		search.oninput = filter; select.onchange = show; filter();
	}
}
