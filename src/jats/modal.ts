import { Modal,Notice } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
export async function openJatsSave(plugin:AgentDashboardPlugin,jobId:string) {
	const service=plugin.getJatsIntakeService(),plan=await service.prepare(jobId),modal=new Modal(plugin.app);let closed=false,busy=false;
	modal.onClose=()=>{closed=true;service.cancel(plan.requestId);};if(!plugin.trackAcquisitionDialog(modal)){service.cancel(plan.requestId);throw new Error("插件已关闭");}
	modal.modalEl.addClass("rar-fulltext-modal","rar-jats-save-modal");modal.setTitle("核对并保存 JATS 图文原文");
	modal.contentEl.createEl("h3",{text:plan.acquired.snapshot.identity.title});modal.contentEl.createEl("p",{text:"来源：PubMed Central（NLM）。本地转换不调用模型或 MinerU；确认后保存 XML、正文、同版本图片及原文索引。"});
	modal.contentEl.createEl("p",{text:`${plan.acquired.snapshot.candidate.jats!.sourceVersionId} · ${plan.acquired.snapshot.candidate.version==="version_of_record"?"出版版本":"作者接受稿"} · 许可：${plan.acquired.snapshot.candidate.jats!.license}`});
	if(plan.acquired.snapshot.candidate.jats!.retracted)modal.contentEl.createEl("p",{text:"来源清单标记为已撤稿，请核对使用目的。",cls:"rar-fulltext-error"});
	modal.contentEl.createEl("p",{text:"来源记录作者："+plan.acquired.snapshot.identity.authors.join("；")});
	modal.contentEl.createEl("p",{text:"XML 主文章标题："+plan.evidence.title});modal.contentEl.createEl("p",{text:"XML 主文章作者："+plan.evidence.authors.join("；")});modal.contentEl.createEl("p",{text:Object.entries(plan.evidence.identifiers).map(([k,v])=>k.toUpperCase()+"："+v).join(" · ")});
	const raw=modal.contentEl.createEl("details");raw.createEl("summary",{text:"查看对应 XML 主文章元数据"+(plan.evidence.excerptTruncated?"（前 20000 字符）":"")});raw.createEl("pre",{text:plan.evidence.excerpt,cls:"rar-jats-xml-evidence"});
	modal.contentEl.createEl("code",{text:`papers/${plan.packageKey}/article.md`});
	for(const issue of [...plan.warnings,...plan.acquired.snapshot.validation.issues])modal.contentEl.createEl("p",{text:issue,cls:"rar-fulltext-muted"});
	modal.contentEl.createEl("p",{text:`正文块 ${plan.acquired.projection.blocks.length} 个；可显示图片 ${plan.acquired.projection.assets.filter(a=>a.path).length}/${plan.acquired.projection.assets.length}。JATS 暂不提供 PDF 页码同步、交互深读或 Wiki 生成。`});
	const preview=modal.contentEl.createEl("details");preview.createEl("summary",{text:"查看正文投影预览（最多 20000 字符）"});preview.createEl("pre",{text:plan.acquired.projection.markdown.slice(0,20000),cls:"rar-jats-xml-evidence"});
	const partial=plan.acquired.snapshot.validation.requestSatisfaction==="partial",label=modal.contentEl.createEl("label",{cls:"rar-jats-partial"});label.hidden=!partial||plan.existing;const checkbox=label.createEl("input",{type:"checkbox",attr:{"data-jats-action":"accept-partial"}});label.appendText("我已核对缺口，接受当前部分结果并保存");
	const status=modal.contentEl.createEl("p",{attr:{"aria-live":"polite"}}),button=modal.contentEl.createEl("button",{text:plan.existing?"核对并补登记原文":plan.recovering?"确认并继续保存":"确认 XML 主文章身份，保存原文",cls:"mod-cta",attr:{"data-jats-action":"save"}});button.disabled=partial&&!plan.existing;checkbox.onchange=()=>{button.disabled=busy||(partial&&!checkbox.checked&&!plan.existing);};
	button.onclick=async()=>{if(busy||button.disabled)return;busy=true;button.disabled=true;try{const result=await service.save(plan.requestId,plan.evidenceDigest,checkbox.checked);if(closed)return;if(result.phase==="saved"){status.setText("JATS 原文已保存并登记");button.setText("已完成");new Notice("JATS 图文原文已保存");const open=modal.contentEl.createEl("button",{text:"打开图文阅读器",attr:{"data-jats-action":"read"}});open.onclick=()=>void plugin.activateMineruReaderView(`papers/${result.packageKey}/article.md`);}else{status.setText((result.phase==="registration_pending"?"原文已保存，登记待完成：":"保存未完成：")+result.error);button.setText("重新核对并重试");button.disabled=false;}}catch(error){status.setText(error instanceof Error?error.message:"保存未完成");button.disabled=false;}finally{busy=false;}};
	modal.open();
}
