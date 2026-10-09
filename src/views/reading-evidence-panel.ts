import type { App } from "obsidian";
import { setTimeout, clearTimeout } from "node:timers";
import type AgentDashboardPlugin from "../plugin";
import type { ReadingWorkspaceService } from "../reading/workspace";
import type { ReadingSession } from "../reading/types";
import { contentHash } from "../retrieval/chunks";
import { CodeSourceModal, renderCodeEvidence } from "./code-evidence";

/** One non-modal, resizable source window. Navigating answers does not replace it. */
export class ReadingEvidencePanel {
	private el?: HTMLElement; private signature = ""; private controller?: AbortController;
	private resize?: ResizeObserver; private timer?: ReturnType<typeof setTimeout>; private cleanupDrag?: () => void;
	constructor(private app: App, private service: ReadingWorkspaceService, private plugin: AgentDashboardPlugin) {}
	dispose(): void { this.controller?.abort(); this.resize?.disconnect(); clearTimeout(this.timer); this.cleanupDrag?.(); this.el?.remove(); this.el = undefined; this.signature = ""; }
	sync(session: ReadingSession | undefined, root: HTMLElement): void {
		const pane = session?.ui.evidenceView;
		if (!session || !pane) { this.dispose(); return; }
		const ref = pane.history[pane.cursor]; const node = session.nodes.find(n => n.id === ref.nodeId); const evidence = node?.evidence.find(e => e.id === ref.evidenceId);
		if (!node || !evidence) { this.dispose(); return; }
		const signature = JSON.stringify([session.id, pane.cursor, pane.history, node.reviewedEvidence, evidence]);
		if (signature === this.signature && this.el) { root.append(this.el); return; }
		this.dispose(); this.signature = signature; const controller = this.controller = new AbortController();
		const panel = this.el = root.createEl("section", { cls: "reading-evidence-panel", attr: { role: "dialog", "aria-label": "固定原文对照" } });
		const width = Math.min(pane.width, Math.max(300, root.clientWidth - 24)); const height = Math.min(pane.height, Math.max(220, root.clientHeight - 64));
		panel.style.width = width + "px"; panel.style.height = height + "px";
		panel.style.left = Math.max(0, Math.min(pane.x, root.clientWidth - width)) + "px"; panel.style.top = Math.max(0, Math.min(pane.y, root.clientHeight - height)) + "px";
		const header = panel.createDiv("reading-evidence-panel-header"); header.createEl("strong", { text: "原文对照" });
		const act = (parent: HTMLElement, label: string, run: () => void) => { const b = parent.createEl("button", { text: label, attr: { "aria-label": label } }); b.onclick = run; return b; };
		const edit = (fn: (s: ReadingSession) => void) => { void this.service.repository.transact(session.id, fn).catch(error => { if (panel.isConnected) status.textContent = String(error); }); };
		act(header, "上一处", () => edit(s => { s.ui.evidenceView!.cursor--; })).disabled = pane.cursor === 0;
		act(header, "下一处", () => edit(s => { s.ui.evidenceView!.cursor++; })).disabled = pane.cursor === pane.history.length - 1;
		act(header, "关闭对照", () => edit(s => { s.ui.evidenceView = undefined; }));
		const body = panel.createDiv("reading-evidence-panel-body"); body.createEl("h3", { text: evidence.label });
		body.createEl("p", { cls: "reading-evidence-location", text: evidence.path + (evidence.structured ? " · JATS 块 " + evidence.structured.blockId + " · 投影字符 " + evidence.start + "–" + evidence.end + " · 无 PDF 页码" : evidence.startLine ? " · 第 " + evidence.startLine + "–" + evidence.endLine + " 行" : evidence.page ? " · 第 " + evidence.page + " 页" : " · 页码未唯一定位") });
		body.createEl("p", { cls: "reading-evidence-location", text: [evidence.kind === "code" ? "项目代码 · 静态阅读" : evidence.kind === "paper" ? "本文原文" : "知识库补充", evidence.role, evidence.heading, evidence.visualInspected ? "图像已提供给模型" : "本轮引用文本"].filter(Boolean).join(" · ") });
		if (evidence.kind === "code") renderCodeEvidence(body, evidence); else body.createEl("pre", { cls: "reading-evidence-text", text: evidence.text });
		const status = body.createEl("p", { cls: "reading-evidence-location", text: "正在核对来源完整性…", attr: { role: "status" } });
		const footer = panel.createDiv("reading-evidence-panel-footer"); const label = footer.createEl("label"); const checked = label.createEl("input", { type: "checkbox" }); checked.disabled = true;
		checked.checked = !!node.reviewedEvidence?.includes(evidence.id); label.appendText("我已对照此处原文");
		const verify = async () => {
			if (evidence.kind === "paper" || evidence.kind === "code") { const source = await this.service.document(session.id); await source.verify(); return source; }
			const file = this.app.vault.getFileByPath(evidence.path);
			if (!file || !evidence.sourceHash || contentHash(await this.app.vault.cachedRead(file)) !== evidence.sourceHash) throw new Error("来源缺失、已变化或旧引用未记录指纹；保留历史片段，暂不能标记核对");
			return undefined;
		};
		checked.onchange = () => { const value = checked.checked; checked.disabled = true; void verify().then(() => {
			if (controller.signal.aborted) return;
			return this.service.repository.transact(session.id, s => { const n = s.nodes.find(n => n.id === node.id)!; n.reviewedEvidence = [...new Set([...(n.reviewedEvidence || []).filter(id => id !== evidence.id), ...(value ? [evidence.id] : [])])]; });
		}).catch(error => { if (!controller.signal.aborted) { status.textContent = String(error); checked.checked = !value; checked.disabled = false; } }); };
		const open = act(footer, "打开来源", () => { void verify().then(() => {
			if (controller.signal.aborted) return;
			if (evidence.kind === "vault") return this.plugin.openVaultFile(evidence.path);
			if (evidence.kind === "code") { this.plugin.showCurationModal(new CodeSourceModal(this.app, this.service, session, id => { void this.plugin.openLearningRecord(session.id, id).catch(error => { status.textContent = String(error); }); })); return; }
			if (["article", "structured"].includes(session.source.kind)) return this.plugin.openReadingEvidence(evidence.path, evidence.page, evidence.structured?.blockId);
			return (require("electron") as { shell: { openPath(path: string): Promise<string> } }).shell.openPath(session.source.path).then(error => { if (error) throw new Error(error); });
		}).catch(error => { status.textContent = String(error); }); }); open.disabled = true;
		void verify().then(async source => {
			if (controller.signal.aborted) return; checked.disabled = false; open.disabled = false; status.textContent = "来源指纹一致；个人核对标记不改变论文深读状态。";
			if (source) { const img = await source.image(source.source.kind === "pdf" && evidence.page ? { ...evidence, asset: "pdf-page" } : evidence, controller.signal);
				if (img && !controller.signal.aborted) body.createEl("img", { attr: { src: img.dataUrl, alt: evidence.label } }); }
		}).catch(error => { if (!controller.signal.aborted) status.textContent = "历史引用：" + String(error); });
		const saveGeometry = () => { if (controller.signal.aborted) return; const x = parseFloat(panel.style.left); const y = parseFloat(panel.style.top); const w = panel.offsetWidth; const h = panel.offsetHeight;
			edit(s => { if (s.ui.evidenceView) Object.assign(s.ui.evidenceView, { x, y, width: w, height: h }); }); };
		header.onpointerdown = event => {
			if (event.button || (event.target as HTMLElement).closest("button")) return; event.preventDefault(); this.cleanupDrag?.();
			const x = event.clientX; const y = event.clientY; const left = parseFloat(panel.style.left); const top = parseFloat(panel.style.top);
			const move = (e: PointerEvent) => { panel.style.left = Math.max(0, Math.min(root.clientWidth - panel.offsetWidth, left + e.clientX - x)) + "px"; panel.style.top = Math.max(0, Math.min(root.clientHeight - 44, top + e.clientY - y)) + "px"; };
			const done = () => { this.cleanupDrag?.(); saveGeometry(); }; this.cleanupDrag = () => { root.ownerDocument.removeEventListener("pointermove", move); root.ownerDocument.removeEventListener("pointerup", done); root.ownerDocument.removeEventListener("pointercancel", done); };
			root.ownerDocument.addEventListener("pointermove", move); root.ownerDocument.addEventListener("pointerup", done, { once: true }); root.ownerDocument.addEventListener("pointercancel", done, { once: true });
		};
		this.resize = new ResizeObserver(() => { clearTimeout(this.timer); this.timer = setTimeout(saveGeometry, 250); }); this.resize.observe(panel);
	}
}
