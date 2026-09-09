import { Modal, Notice } from "obsidian";
import type AgentDashboardPlugin from "../plugin";
import type { SourceSavePlan } from "./source-intake";

/** No automatic confirmation: enable the commit button only after the bound raster is displayed. */
export async function openSourceSave(plugin:AgentDashboardPlugin,jobId:string):Promise<void> {
	const service=plugin.getSourceIntakeService(),plan=await service.prepare(jobId),modal=new Modal(plugin.app);
	let closed=false,busy=false,digest="",generation=0;
	modal.onClose=()=>{closed=true;service.cancel(plan.requestId);};modal.modalEl.addClass("rar-fulltext-modal","rar-source-save-modal");modal.setTitle("仅保存 PDF 原文");
	if(!plugin.trackAcquisitionDialog(modal)){service.cancel(plan.requestId);throw new Error("插件已关闭");}
	modal.contentEl.createEl("h3",{text:plan.snapshot.identity.title});
	modal.contentEl.createEl("p",{text:"核对原文身份后保存 PDF，并登记原文索引。此操作不调用模型或 MinerU，也不生成文章 Wiki。"});
	modal.contentEl.createEl("p",{text:[plan.snapshot.identity.authors.join("；"),plan.snapshot.identity.year,Object.entries(plan.snapshot.identity.identifiers).map(([k,v])=>`${k.toUpperCase()}：${v}`).join(" · ")].filter(Boolean).join("\n")});
	modal.contentEl.createEl("p",{text:`稿件类型：${plan.snapshot.candidate.version==="version_of_record"?"出版版本":"作者接受稿"}；身份依据：${plan.snapshot.identity.evidence.map(e=>e.provider).join("、")}`});
	modal.contentEl.createEl("code",{text:`papers/${plan.packageKey}/source.pdf`});
	modal.contentEl.createEl("p",{text:"索引登记：在 papers/index.md 添加此原文的普通路径记录，保留现有内容。"});
	for(const warning of [...plan.snapshot.identity.warnings,...plan.warnings])modal.contentEl.createEl("p",{text:warning,cls:"rar-fulltext-muted"});
	const page=modal.contentEl.createEl("select",{attr:{"aria-label":"原文确认页码"}});
	for(let n=1;n<=Math.min(3,plan.snapshot.validation.pageCount);n++)page.createEl("option",{text:`第 ${n} 页`,value:String(n)});
	page.disabled=plan.recovering;page.hidden=plan.existing;
	const image=modal.contentEl.createEl("img",{cls:"rar-source-identity-page",attr:{alt:"本次快照的标题页，请核对标题、作者和标识"}});image.hidden=plan.existing;
	const status=modal.contentEl.createEl("p",{attr:{"aria-live":"polite"}}),commit=modal.contentEl.createEl("button",{text:plan.existing?"核对并补登记原文":plan.recovering?"确认页面，继续保存":"确认页面与记录一致，保存原文",cls:"mod-cta",attr:{"data-source-action":"save"}});commit.disabled=!plan.existing;
	const show=(next:SourceSavePlan)=>{status.setText(next.phase==="saved"?"原文已保存并登记；尚未转换正文或生成 Wiki":next.phase==="registration_pending"?"原文已保存，登记待完成："+next.error:next.phase==="cancelled"?"已停止；未完成文件保留":next.error||"正在保存原文…");};
	const render=async()=>{const own=++generation;commit.disabled=true;digest="";status.setText("正在渲染本地标题页…");try{const display=await service.present(plan.requestId,Number(page.value));if(closed||own!==generation)return;image.src=display.dataUrl;await image.decode();if(closed||own!==generation)return;digest=display.digest;commit.disabled=false;status.setText(plan.recovering?"展示上次已登记的确认页面；继续时逐个核验保留文件":"请亲眼核对页面与上方的身份记录");}catch(error){if(!closed)status.setText(error instanceof Error?error.message:"页面无法展示");}};
	page.onchange=()=>void render();
	commit.onclick=async()=>{if(busy||commit.disabled)return;busy=true;commit.disabled=true;page.disabled=true;status.setText("正在保存原文…");try{const result=await service.save(plan.requestId,digest);if(closed)return;show(result);if(result.phase==="saved"){new Notice("PDF 原文已保存并登记");commit.setText("已完成");}else{commit.setText(result.phase==="registration_pending"?"重新核对并补登记":"核对后重试保存");commit.disabled=false;}}catch(error){if(!closed){status.setText(error instanceof Error?error.message:"保存未完成");commit.disabled=false;}}finally{busy=false;}};
	modal.open();if(plan.existing)status.setText("已存在经过确认的同版本、同内容 PDF，将核验原文并补齐索引");else void render();
}
