import { App, Modal } from "obsidian";
import { filterPending, PENDING_CATEGORIES, type PendingItem, type PendingResult } from "../services/pending-center";
import { PendingController } from "../services/pending-controller";
export interface PendingCenterHost { inspectPendingCenter(signal: AbortSignal): Promise<PendingResult>; openPendingItem(item: PendingItem, signal: AbortSignal): Promise<void>; }

export class PendingCenterModal extends Modal {
	private readonly controller: PendingController;
	private closed = true;
	private action?: AbortController;
	private query = "";
	private category = "all";
	private limit = 40;
	private notice = "";
	private status!: HTMLElement;
	private list!: HTMLElement;
	private refresh!: HTMLButtonElement;
	private cancel!: HTMLButtonElement;
	private filter!: HTMLSelectElement;
	constructor(app: App, private readonly host: PendingCenterHost, private readonly didClose?: () => void) {
		super(app); this.controller = new PendingController(signal => this.host.inspectPendingCenter(signal), () => this.render());
	}
	onOpen(): void {
		this.closed = false; this.setTitle("待处理中心"); this.modalEl.addClass("rar-pending-modal");
		this.contentEl.createEl("p", { text: "汇总本地保存记录中的缺口。刷新只读取记录；回到原功能后，再核对并决定下一步。", cls: "rar-library-muted" });
		const tools = this.contentEl.createDiv("rar-pending-tools");
		const search = tools.createEl("input", { type: "search", placeholder: "搜索文献、路径或待处理事项", attr: { "aria-label": "搜索待处理记录", maxlength: "500" } });
		search.oninput = () => { this.query = search.value; this.limit = 40; this.render(); };
		this.filter = tools.createEl("select", { attr: { "aria-label": "待处理阶段" } }); this.filter.createEl("option", { value: "all", text: "全部阶段" });
		for (const [value, text] of Object.entries(PENDING_CATEGORIES)) this.filter.createEl("option", { value, text });
		this.filter.onchange = () => { this.category = this.filter.value; this.limit = 40; this.render(); };
		this.refresh = this.button(tools, "刷新待处理", () => { this.notice = ""; void this.controller.refresh(); });
		this.cancel = this.button(tools, "取消读取", () => { if (this.action) this.action.abort(); else this.controller.cancel(); });
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.list = this.contentEl.createEl("section", { attr: { "aria-label": "待处理记录" } });
		void this.controller.refresh();
	}
	onClose(): void { this.closed = true; this.controller.dispose(); this.action?.abort(); this.contentEl.empty(); this.didClose?.(); }
	private button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement { const button = parent.createEl("button", { text, attr: { type: "button" } }); button.onclick = run; return button; }
	private render(): void {
		if (this.closed) return;
		const state = this.controller.state, result = state.result, busy = this.controller.busy || Boolean(this.action);
		this.contentEl.setAttribute("aria-busy", String(busy)); this.refresh.disabled = busy; this.cancel.hidden = !busy; this.cancel.setText(this.action ? "取消打开" : "取消读取");
		this.status.empty();
		const phase = ({ idle: "", loading: "正在读取各阶段记录…", ready: "", failed: "读取失败：" + state.error, cancelled: "读取已取消" })[state.phase];
		if (phase) this.status.createEl("p", { text: phase + (result ? "；以下保留上次结果，刷新后再打开。" : "") });
		if (this.notice) this.status.createEl("p", { text: this.notice });
		if (result) {
			this.status.createEl("p", { text: `${result.items.length} 条已读取的待处理记录 · ${new Date(result.scannedAt).toLocaleTimeString()}${result.issues.length ? " · 读取不完整，请核对提示" : ""}` });
			for (const option of Array.from(this.filter.options)) option.text = option.value === "all" ? "全部阶段" : PENDING_CATEGORIES[option.value as keyof typeof PENDING_CATEGORIES] + `（${result.items.filter(item => item.category === option.value).length}）`;
			if (result.issues.length) {
				const details = this.status.createEl("details"); details.createEl("summary", { text: `查看 ${result.issues.length} 条读取提示` });
				for (const issue of result.issues.slice(0, 100)) details.createEl("p", { text: issue });
				if (result.issues.length > 100) details.createEl("p", { text: "仅展示前 100 条提示，其余记录保留在原功能。" });
			}
		}
		this.list.empty(); const rows = filterPending(result?.items || [], this.query, this.category);
		if (!rows.length && state.phase === "ready") this.list.createEl("p", { text: result?.issues.length ? "当前筛选下没有可展示记录，请先核对读取提示。" : "当前筛选下没有待处理记录；这不代表全部原文或科学结论已审阅。" });
		for (const item of rows.slice(0, this.limit)) {
			const row = this.list.createEl("article", { cls: "rar-pending-row", attr: { "data-pending-key": item.key } });
			row.createEl("small", { text: PENDING_CATEGORIES[item.category] }); row.createEl("h3", { text: item.title });
			row.createEl("p", { text: item.detail }); row.createEl("p", { text: item.location, cls: "rar-library-muted" });
			const button = this.button(row, item.next, () => void this.openItem(item)); button.disabled = busy || state.phase !== "ready";
		}
		if (rows.length > this.limit) this.button(this.list, `显示更多（共 ${rows.length} 条匹配）`, () => { this.limit += 40; this.render(); });
	}
	private async openItem(item: PendingItem): Promise<void> {
		if (this.closed || this.action || this.controller.busy || this.controller.state.phase !== "ready") return;
		const controller = this.action = new AbortController(); this.notice = "正在核对所选记录…"; this.render();
		try { await this.host.openPendingItem(structuredClone(item), controller.signal); if (!this.closed && !controller.signal.aborted) this.close(); }
		catch (error) { if (!this.closed && !controller.signal.aborted) this.notice = error instanceof Error ? error.message : String(error); }
		finally { if (!this.closed && this.action === controller) { if (controller.signal.aborted) this.notice = "已取消打开"; this.action = undefined; this.render(); } }
	}
}
