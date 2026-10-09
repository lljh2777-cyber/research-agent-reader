import type { TaskRun } from "../types/contracts";
import { INGEST_STAGES, ingestProgressDisplay } from "../agent/ingest-progress";

export function renderIngestProgress(parent: HTMLElement, run: TaskRun | null, actions: { stop?: () => void; result?: () => void; stopping?: boolean } = {}): void {
	const restoreStopFocus = parent.querySelector("button") === parent.ownerDocument.activeElement;
	parent.empty();
	const display = run && ingestProgressDisplay(run);
	parent.hidden = !display;
	if (!display || !run?.ingestProgress) return;
	const stopping = display.active && actions.stopping;
	parent.className = "ingest-progress";
	parent.dataset.runId = run.id;
	parent.dataset.state = stopping ? "stopping" : display.waiting ? "waiting" : run.status;
	const header = parent.createDiv({ cls: "ingest-progress-header" });
	const copy = header.createDiv({ cls: "ingest-progress-copy", attr: { role: "status", "aria-live": "polite" } });
	copy.createEl("strong", { text: stopping ? "正在停止入库" : display.status });
	copy.createSpan({ cls: "ingest-progress-position", text: display.position });
	if (display.active && actions.stop || !display.active && actions.result) {
		const button = header.createEl("button", { cls: "ingest-progress-action", text: display.active ? stopping ? "停止中" : "停止" : "查看结果" });
		button.type = "button"; button.disabled = Boolean(stopping);
		button.onclick = display.active ? actions.stop! : actions.result!;
		if (restoreStopFocus && !button.disabled) button.focus({ preventScroll: true });
	}
	const bar = parent.createEl("progress", { attr: { max: String(display.total), "aria-label": "文献入库阶段进度", "aria-valuetext": display.status + "，" + display.position, title: "按实际阶段推进，不代表剩余时间或文件处理百分比" } });
	if (!display.indeterminate) bar.value = display.value;
	if (run.ingestProgress.stage !== "cli") {
		const steps = parent.createEl("ol", { cls: "ingest-progress-steps", attr: { "aria-label": "入库阶段" } });
		run.ingestProgress.steps.forEach((stage, index) => {
			const item = steps.createEl("li", { text: INGEST_STAGES[stage] });
			if (run.status === "done" || index < display.index) item.addClass("is-past");
			if (run.status !== "done" && index === display.index) { item.addClass("is-current"); item.setAttr("aria-current", "step"); }
		});
	}
	parent.createEl("p", { cls: "ingest-progress-detail", text: stopping ? "正在取消请求并结束当前阶段，请稍候。" : display.detail });
}
