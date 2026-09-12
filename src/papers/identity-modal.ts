import { Modal, type App } from "obsidian";
import type { PdfSourceSnapshot } from "../sources/pdf-snapshot";
import type { AuthorizedPdfPageRaster } from "../agent/pdf-identity";
import { bytesDigest } from "./identity";
import { sourceConfirmation, validateSourceConfirmation, type PdfDisplayedEvidence, type SourceConfirmation } from "./confirmation";

/** V2 has a source-neutral record, an actual raster presenter and a separate validator. */
export function confirmSourceIdentity(app:App,requestId:string,snapshot:PdfSourceSnapshot,signal:AbortSignal,render:(page:number)=>Promise<AuthorizedPdfPageRaster>):Promise<SourceConfirmation|null> {
	if(signal.aborted)return Promise.resolve(null);
	return new Promise(resolve=>{
		const modal=new Modal(app);let settled=false,generation=0,evidence:PdfDisplayedEvidence|undefined;
		const finish=(receipt:SourceConfirmation|null)=>{if(settled)return;settled=true;signal.removeEventListener("abort",abort);resolve(receipt);modal.close();};
		const abort=()=>finish(null);signal.addEventListener("abort",abort,{once:true});modal.onClose=()=>finish(null);
		modal.modalEl.addClass("rar-fulltext-modal","rar-source-save-modal");modal.setTitle("确认 PDF 与来源身份");
		modal.contentEl.createEl("h3",{text:snapshot.identity.title});
		modal.contentEl.createEl("p",{text:`作者：${snapshot.identity.authors.join("；")}\n年份：${snapshot.identity.year}\n${Object.entries(snapshot.identity.identifiers).map(([k,v])=>`${k.toUpperCase()}：${v}`).join(" · ")}`});
		modal.contentEl.createEl("p",{text:"请亲眼核对 PDF 页面与以上来源记录。身份和去重由插件确定；确认后才会按已选输出调用转换服务或正文模型。"});
		for(const w of snapshot.identity.warnings)modal.contentEl.createEl("p",{text:w,cls:"rar-fulltext-muted"});
		const select=modal.contentEl.createEl("select",{attr:{"aria-label":"v2 标题页"}});for(let n=1;n<=Math.min(3,snapshot.validation.pageCount);n++)select.createEl("option",{text:`第 ${n} 页`,value:String(n)});
		const image=modal.contentEl.createEl("img",{cls:"rar-source-identity-page",attr:{alt:"授权 PDF 标题页"}}),status=modal.contentEl.createEl("p",{attr:{"aria-live":"polite"}}),button=modal.contentEl.createEl("button",{text:"确认页面与来源记录一致",cls:"mod-cta",attr:{"data-source-action":"confirm-identity"}});button.disabled=true;
		const load=async()=>{const own=++generation;button.disabled=true;evidence=undefined;status.setText("正在渲染本地标题页…");try{const raster=await render(Number(select.value));if(settled||own!==generation)return;image.src=raster.rasterDataUrl;await image.decode();if(settled||own!==generation)return;const {rasterDataUrl,...rest}=raster;evidence={...rest,kind:"pdf",pngSha256:bytesDigest(Buffer.from(rasterDataUrl.slice(22),"base64"))};validateSourceConfirmation(sourceConfirmation(requestId,snapshot,evidence),requestId,snapshot);button.disabled=false;status.setText("页面已展示，请核对后确认");}catch(error){if(!settled)status.setText(error instanceof Error?error.message:"页面无法展示");}};
		select.onchange=()=>void load();button.onclick=()=>{if(!button.disabled&&evidence)finish(sourceConfirmation(requestId,snapshot,evidence));};modal.open();void load();
	});
}
