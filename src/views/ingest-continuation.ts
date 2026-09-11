import { Modal, Notice } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { ACTION_BY_ID } from "../actions";
import { validateIngestRequest } from "../agent/ingest-records";
import { TaskResultModal } from "../modals/task-result";
import { ingestTaskResult } from "../agent/ingest-task-result";
import type { TaskRun } from "../types/contracts";
import { openAcquiredIntake } from "../fulltext/intake-modal";

export async function openIngestContinuation(plugin: AgentDashboardPlugin, previous: TaskRun): Promise<void> {
	const request = validateIngestRequest(await plugin.getIngestRecords().read("request", previous.id), previous.id);
	if(request.options.acquisitionSource){await openAcquiredIntake(plugin,request.options.acquisitionSource.jobId,request);return;}
	const modal = new Modal(plugin.app); modal.setTitle("继续完成入库");
	modal.contentEl.createEl("p", { text: "重新核对原文身份，并复用已存在且校验通过的原文与 Wiki，只生成缺失的输出。身份核验仍需确认，已存在的文件不会覆盖。" });
	modal.contentEl.createEl("pre", { text: request.options.sourcePdfPath + "\n所需输出：" + [request.options.createArticleMarkdown ? "原文 Markdown" : "", request.options.createArticleWiki ? "论文笔记" : ""].filter(Boolean).join("、") });
	const select = modal.contentEl.createEl("select", { attr: { "aria-label": "续办模型" } });
	for (const profile of plugin.getVerifiedProviderProfiles()) select.createEl("option", { text: profile.name + " · " + profile.model, value: profile.id });
	if ([...select.options].some(o => o.value === request.profileId)) select.value = request.profileId;
	const consent = modal.contentEl.createEl("label");
	const remote = consent.createEl("input", { type: "checkbox" }); consent.createSpan({ text: "如需补建原文包，同意将 PDF 发送至配置的 MinerU 服务" }); consent.hidden = !request.options.createArticleMarkdown;
	const status = modal.contentEl.createEl("p");
	const start = modal.contentEl.createEl("button", { cls: "mod-cta", text: "核对并继续" }); start.type = "button";
	start.onclick = async () => {
		if (start.disabled) return;
		if (!select.value || plugin.isActionRunning("paper-ingest")) { status.textContent = "请选择可用模型，并等待当前入库任务结束"; return; }
		if (request.options.createArticleMarkdown && !remote.checked) { status.textContent = "请确认可能需要的远程转换"; return; }
		start.disabled = true; let run: TaskRun | undefined;
		try {
			const profile = plugin.getProviderProfile(select.value)!; const action = ACTION_BY_ID.get("paper-ingest")!;
			run = await plugin.startTaskRun(action, "续办：" + request.options.sourcePdfPath, { backend: "direct-api", providerId: profile.id, providerName: profile.name, model: profile.model, reasoningEffort: null, serviceTier: null });
			modal.close();
			new Notice("已开始续办入库，可在控制台查看新任务或点击文献入库停止");
			const outcome = await plugin.runLightPaperIngest(run.id, { ...request.options, remoteUploadConfirmed: remote.checked }, profile.id);
			const result = await plugin.finishTaskRun(run.id, ingestTaskResult(outcome));
			if (result) new TaskResultModal(plugin.app, plugin, result, null).open();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const result = run ? await plugin.finishTaskRun(run.id, { status: "failed", error: message }) : null;
			if (result) new TaskResultModal(plugin.app, plugin, result, null).open();
			status.textContent = message; new Notice(message);
		}
		finally { start.disabled = false; }
	}; modal.open();
}
