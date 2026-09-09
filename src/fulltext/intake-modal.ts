import { Modal, Notice } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { ACTION_BY_ID } from "../actions";
import { ingestTaskResult } from "../agent/ingest-task-result";
import type { PaperIngestFlowOptions } from "../agent/paper-ingest-flow";
import type { IngestRequest } from "../agent/ingest-records";
import type { TaskRun } from "../types/contracts";
import { TaskResultModal } from "../modals/task-result";
import { prepareAcquiredIntake, validateAcquiredIntake } from "./intake-adapter";

export async function openAcquiredIntake(plugin:AgentDashboardPlugin,id:string,previous?:IngestRequest):Promise<void> {
	const service=plugin.getAcquisitionService(), source=await prepareAcquiredIntake(service,id), modal=new Modal(plugin.app);
	let closed=false,busy=false;modal.onClose=()=>{closed=true;};if(!plugin.trackAcquisitionDialog(modal))throw new Error("插件已关闭，请重新打开入库");
	modal.modalEl.addClass("rar-fulltext-modal");modal.setTitle("继续入库");
	modal.contentEl.createEl("h3",{text:source.snapshot.identity.title});
	modal.contentEl.createEl("p",{text:"复用已获取的 PDF，不重新下载。插件先核对来源身份与已有文件，并展示标题页供你确认；生成 Wiki 时才会将所需论文片段或页面发送至所选模型。"});
	const select=modal.contentEl.createEl("select",{attr:{"aria-label":"入库模型"}});
	for(const profile of plugin.getVerifiedProviderProfiles())select.createEl("option",{value:profile.id,text:profile.name+" · "+profile.model});
	if([...select.options].some(o=>o.value===(previous?.profileId||plugin.settings.activeProviderId)))select.value=previous?.profileId||plugin.settings.activeProviderId;
	if(!select.options.length)modal.contentEl.createEl("p",{text:"请先在 Direct API 设置中配置并测试模型；已获取 PDF 仍可预览。"});
	const checkbox=(title:string,checked:boolean)=>{const label=modal.contentEl.createEl("label",{cls:"rar-fulltext-choice"}),input=label.createEl("input",{type:"checkbox"});input.checked=checked;label.createSpan({text:title});return input;};
	const article=checkbox("生成原文 Markdown（需要 MinerU）",previous?.options.createArticleMarkdown??false);
	const wiki=checkbox("生成文章 Wiki",previous?.options.createArticleWiki??true);
	const consent=checkbox("如需生成原文 Markdown，同意将这份 PDF 发送至配置的 MinerU 服务",false);
	const saved=previous?.options, settings=plugin.settings;
	const conversion={mineruModel:saved?.mineruModel??settings.mineruDefaultModel,mineruLanguage:saved?.mineruLanguage??settings.mineruDefaultLanguage,mineruOcr:saved?.mineruOcr??settings.mineruDefaultOcr,mineruFormula:saved?.mineruFormula??settings.mineruDefaultFormula,mineruTable:saved?.mineruTable??settings.mineruDefaultTable,mineruPages:saved?.mineruPages??"",mineruTimeoutSeconds:saved?.mineruTimeoutSeconds??settings.mineruDefaultTimeoutSeconds,mineruIncludeSourcePdf:saved?.mineruIncludeSourcePdf??settings.mineruDefaultIncludeSourcePdf};
	const conversionSummary=modal.contentEl.createEl("p",{text:`转换参数${saved?"（沿用上次请求）":""}：${conversion.mineruModel}，语言 ${conversion.mineruLanguage || "自动"}，页码 ${conversion.mineruPages || "全部"}，OCR ${conversion.mineruOcr?"开启":"关闭"}，公式 ${conversion.mineruFormula?"开启":"关闭"}，表格 ${conversion.mineruTable?"开启":"关闭"}，超时 ${conversion.mineruTimeoutSeconds} 秒，${conversion.mineruIncludeSourcePdf?"附带":"不附带"}原始 PDF。`});
	const notes=modal.contentEl.createEl("textarea",{cls:"rar-fulltext-notes",attr:{"aria-label":"入库补充说明",placeholder:"可选：研究关注点",maxlength:"4000"}});notes.value=previous?.options.requestNotes||"";
	const status=modal.contentEl.createEl("p",{attr:{"aria-live":"polite"}}),start=modal.contentEl.createEl("button",{text:"核对并入库",cls:"mod-cta",attr:{"data-fulltext-action":"intake-start"}});
	const update=()=>{consent.parentElement!.hidden=conversionSummary.hidden=!article.checked;start.disabled=busy||!select.value||(!article.checked&&!wiki.checked);};article.onchange=wiki.onchange=select.onchange=update;update();
	start.onclick=async()=>{
		if(start.disabled)return;
		const profile=plugin.getProviderProfile(select.value);
		if(!profile || !plugin.getVerifiedProviderProfiles().some(p=>p.id===profile.id) || plugin.isActionRunning("paper-ingest")){status.setText("请选择可用模型，并等待当前入库任务结束");return;}
		if(article.checked&&!consent.checked){status.setText("请确认 PDF 的远程转换");return;}
		busy=true;start.disabled=true;let run:TaskRun|undefined;
		try {
			const options:PaperIngestFlowOptions={...conversion,identityMode:"source-v2",sourcePdfPath:source.path,acquisitionSource:source.reference,requestNotes:notes.value.slice(0,4000),identityCandidateTitle:source.snapshot.identity.title,identityCandidateDoi:source.snapshot.identity.identifiers.doi||"",createArticleMarkdown:article.checked,createArticleWiki:wiki.checked,articleWikiSource:article.checked?(saved?.articleWikiSource??"article"):"pdf",remoteUploadConfirmed:article.checked&&consent.checked};
			await validateAcquiredIntake(service,options);
			if(closed)return;
			run=await plugin.startTaskRun(ACTION_BY_ID.get("paper-ingest")!,"获取后入库："+source.snapshot.identity.title,{backend:"direct-api",providerId:profile.id,providerName:profile.name,model:profile.model,reasoningEffort:null,serviceTier:null},source.reference);
			await service.linkIntake(id,source.reference.snapshotId,run.id);
			modal.close();new Notice("已开始入库，可在获取记录中查看关联任务");
			const outcome=await plugin.runLightPaperIngest(run.id,options,profile.id);
			const finished=await plugin.finishTaskRun(run.id,ingestTaskResult(outcome));if(finished)new TaskResultModal(plugin.app,plugin,finished,null).open();
		} catch(error) {const message=error instanceof Error?error.message:"入库未完成";if(run){const failed=await plugin.finishTaskRun(run.id,{status:"failed",error:message});if(failed)new TaskResultModal(plugin.app,plugin,failed,null).open();}status.setText(message);new Notice(message);}
		finally{busy=false;update();}
	};modal.open();
}
