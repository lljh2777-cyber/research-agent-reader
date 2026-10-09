import { Modal, Notice } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import { ACTION_BY_ID } from "../actions";
import { ingestTaskResult } from "../agent/ingest-task-result";
import type { PaperIngestFlowOptions } from "../agent/paper-ingest-flow";
import type { IngestRequest } from "../agent/ingest-records";
import type { TaskRun } from "../types/contracts";
import { TaskResultModal } from "../modals/task-result";
import { prepareAcquiredIntake, validateAcquiredIntake } from "./intake-adapter";
import type { SavedPdfRef } from "../papers/saved-pdf";
import type { PdfSourceSnapshot } from "../sources/pdf-snapshot";
import { validateIngestRequestForTask } from "../agent/ingest-records";
import { objectDigest } from "../papers/identity";

export async function openAcquiredIntake(plugin:AgentDashboardPlugin,id:string,previous?:IngestRequest):Promise<void> {
	const source=await prepareAcquiredIntake(plugin.getAcquisitionService(),id);
	openPdfIntake(plugin,source,{acquisitionSource:source.reference},previous);
}
export async function openSavedPdfIntake(plugin:AgentDashboardPlugin,ref:SavedPdfRef,previous?:IngestRequest,signal=new AbortController().signal):Promise<void> {
	const source=await plugin.readSavedPdf(ref,signal); signal.throwIfAborted();
	openPdfIntake(plugin,source,{savedPdfSource:source.reference},previous);
}
function openPdfIntake(plugin:AgentDashboardPlugin,source:{path:string;snapshot:PdfSourceSnapshot},binding:Pick<PaperIngestFlowOptions,"acquisitionSource"|"savedPdfSource">,previous?:IngestRequest):void {
	const modal=new Modal(plugin.app);
	let closed=false,busy=false;modal.onClose=()=>{closed=true;};if(!plugin.trackAcquisitionDialog(modal))throw new Error("插件已关闭，请重新打开入库");
	modal.modalEl.addClass("rar-fulltext-modal","rar-pdf-process-modal");modal.setTitle("转换正文 / 生成初始笔记");
	modal.contentEl.createEl("h3",{text:source.snapshot.identity.title});
	modal.contentEl.createEl("p",{text:"复用所选 PDF，先核对原文身份与已有输出，再展示标题页供你确认。只转换正文无需模型；生成初始笔记会将所需论文片段或页面发送至所选模型。已有原文和笔记不会覆盖。"});
	modal.contentEl.createEl("code",{text:source.path,cls:"rar-pdf-process-path"});
	const modelField=modal.contentEl.createEl("label",{text:"初始笔记模型",cls:"rar-pdf-process-model"});
	const select=modelField.createEl("select",{attr:{"aria-label":"入库模型"}});
	for(const profile of plugin.getVerifiedProviderProfiles())select.createEl("option",{value:profile.id,text:profile.name+" · "+profile.model});
	if([...select.options].some(o=>o.value===(previous?.profileId||plugin.settings.activeProviderId)))select.value=previous?.profileId||plugin.settings.activeProviderId;
	if(!select.options.length)modal.contentEl.createEl("p",{text:"未配置可用模型，仍可单独转换正文。生成初始笔记需要已通过连接测试的 Direct API。"});
	const checkbox=(title:string,checked:boolean)=>{const label=modal.contentEl.createEl("label",{cls:"rar-fulltext-choice"}),input=label.createEl("input",{type:"checkbox"});input.checked=checked;label.createSpan({text:title});return input;};
	const article=checkbox("生成原文 Markdown（需要 MinerU）",previous?.options.createArticleMarkdown??false);
	const wiki=checkbox("生成文章 Wiki",previous?.options.createArticleWiki??true);
	const wikiSource=modal.contentEl.createEl("select",{attr:{"aria-label":"初始笔记的证据来源"}});
	wikiSource.createEl("option",{value:"pdf",text:"使用所选 PDF"});wikiSource.createEl("option",{value:"article",text:"使用本次转换或可复用的原文 Markdown"});
	wikiSource.value=previous?.options.articleWikiSource==="article"?"article":"pdf";
	const consent=checkbox("如需生成原文 Markdown，同意将这份 PDF 发送至配置的 MinerU 服务",false);
	const saved=previous?.options, settings=plugin.settings;
	const conversion={mineruModel:saved?.mineruModel??settings.mineruDefaultModel,mineruLanguage:saved?.mineruLanguage??settings.mineruDefaultLanguage,mineruOcr:saved?.mineruOcr??settings.mineruDefaultOcr,mineruFormula:saved?.mineruFormula??settings.mineruDefaultFormula,mineruTable:saved?.mineruTable??settings.mineruDefaultTable,mineruPages:saved?.mineruPages??"",mineruTimeoutSeconds:saved?.mineruTimeoutSeconds??settings.mineruDefaultTimeoutSeconds,mineruIncludeSourcePdf:saved?.mineruIncludeSourcePdf??settings.mineruDefaultIncludeSourcePdf};
	const conversionSummary=modal.contentEl.createEl("p",{text:`转换参数${saved?"（沿用上次请求）":""}：${conversion.mineruModel}，语言 ${conversion.mineruLanguage || "自动"}，页码 ${conversion.mineruPages || "全部"}，OCR ${conversion.mineruOcr?"开启":"关闭"}，公式 ${conversion.mineruFormula?"开启":"关闭"}，表格 ${conversion.mineruTable?"开启":"关闭"}，超时 ${conversion.mineruTimeoutSeconds} 秒，${conversion.mineruIncludeSourcePdf?"附带":"不附带"}原始 PDF。`});
	const notes=modal.contentEl.createEl("textarea",{cls:"rar-fulltext-notes",attr:{"aria-label":"入库补充说明",placeholder:"可选：研究关注点",maxlength:"4000"}});notes.value=previous?.options.requestNotes||"";
	const status=modal.contentEl.createEl("p",{attr:{"aria-live":"polite"}}),start=modal.contentEl.createEl("button",{text:"核对并开始所选步骤",cls:"mod-cta",attr:{"data-fulltext-action":"intake-start"}});
	if(binding.savedPdfSource) {
		const history=modal.contentEl.createEl("details");history.createEl("summary",{text:"此原文的处理记录"});history.open=true;
		const rows=history.createDiv();rows.setText("正在读取处理记录…");
		void (async()=>{
			const runs=plugin.getTaskRuns().filter(r=>r.actionId==="paper-ingest").slice(0,100);let found=0,unreadable=0;rows.empty();
			for(const run of runs){if(closed)return;try{
				const raw=await plugin.getIngestRecords().read("request",run.id);if(closed)return;if(!raw)continue;
				const request=validateIngestRequestForTask(raw,run);if(!request.options.savedPdfSource||objectDigest(request.options.savedPdfSource)!==objectDigest(binding.savedPdfSource))continue;
				found++;const open=rows.createEl("button",{text:run.summary+" · "+({done:"已完成",failed:"未完成",interrupted:"已中断",running:"进行中",queued:"等待中"}[run.status]||run.status)});
				open.onclick=()=>new TaskResultModal(plugin.app,plugin,run,null).open();
			}catch{unreadable++;}}
			if(!found)rows.createEl("p",{text:"当前任务历史中没有此原文的处理记录。"});
			if(unreadable)rows.createEl("p",{text:`${unreadable} 条请求无法读取或核验，未推断归属。`});
			if(runs.length===100)rows.createEl("p",{text:"仅检查最近 100 条入库任务；更早记录可从工作台任务历史查看。"});
		})().catch(error=>{if(!closed)rows.setText("处理记录读取失败："+String(error));});
	}
	const update=()=>{if(closed)return;consent.parentElement!.hidden=conversionSummary.hidden=!article.checked;modelField.hidden=!wiki.checked||!select.options.length;select.disabled=!wiki.checked||busy;wikiSource.hidden=!wiki.checked;start.disabled=busy||wiki.checked&&!select.value||(!article.checked&&!wiki.checked);};article.onchange=wiki.onchange=select.onchange=update;update();
	start.onclick=async()=>{
		if(start.disabled)return;
		const profile=plugin.getProviderProfile(select.value);
		if(wiki.checked&&(!profile || !plugin.getVerifiedProviderProfiles().some(p=>p.id===profile.id)) || plugin.isActionRunning("paper-ingest")){status.setText("生成笔记请选择可用模型，并等待当前入库任务结束");return;}
		if(article.checked&&!consent.checked){status.setText("请确认 PDF 的远程转换");return;}
		busy=true;start.disabled=true;let run:TaskRun|undefined;
		try {
			const options:PaperIngestFlowOptions={...conversion,identityMode:"source-v2",sourcePdfPath:source.path,...binding,requestNotes:notes.value.slice(0,4000),identityCandidateTitle:source.snapshot.identity.title,identityCandidateDoi:source.snapshot.identity.identifiers.doi||"",createArticleMarkdown:article.checked,createArticleWiki:wiki.checked,articleWikiSource:wikiSource.value as "pdf"|"article",remoteUploadConfirmed:article.checked&&consent.checked};
			if(binding.savedPdfSource)await plugin.validateSavedPdfIntake(options);
			else await validateAcquiredIntake(plugin.getAcquisitionService(),options);
			if(closed)return;
			const modelProfile=options.createArticleWiki?profile:undefined;
			run=await plugin.startTaskRun(ACTION_BY_ID.get("paper-ingest")!,"处理原文："+source.snapshot.identity.title,modelProfile?{backend:"direct-api",providerId:modelProfile.id,providerName:modelProfile.name,model:modelProfile.model,reasoningEffort:null,serviceTier:null}:null,binding.acquisitionSource,binding.savedPdfSource);
			if(binding.acquisitionSource)await plugin.getAcquisitionService().linkIntake(binding.acquisitionSource.jobId,binding.acquisitionSource.snapshotId,run.id);
			modal.close();new Notice("已开始处理，可在工作台任务结果中查看和继续");
			const outcome=await plugin.runLightPaperIngest(run.id,options,modelProfile?.id||"");
			const finished=await plugin.finishTaskRun(run.id,ingestTaskResult(outcome));if(finished)new TaskResultModal(plugin.app,plugin,finished,null).open();
		} catch(error) {const message=error instanceof Error?error.message:"入库未完成";if(run){const failed=await plugin.finishTaskRun(run.id,{status:"failed",error:message});if(failed)new TaskResultModal(plugin.app,plugin,failed,null).open();}status.setText(message);new Notice(message);}
		finally{busy=false;update();}
	};modal.open();
}
