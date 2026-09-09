import { randomUUID } from "node:crypto";
import type { App } from "obsidian";
import type { PaperIngestFlowOptions, PaperIngestIdentity } from "../agent/paper-ingest-flow";
import { renderAuthorizedPdfIdentityPage, type AuthorizedPdfSnapshot } from "../agent/pdf-identity";
import { MineruPackageLoader } from "../mineru/package-loader";
import { normalizePagesValue } from "../agent/mineru-publish";
import type { AcquisitionService } from "../fulltext/service";
import { confirmSourceIdentity } from "./identity-modal";
import { validateSourceConfirmation, type SourceConfirmation } from "./confirmation";
import { SourceCatalog } from "./catalog";
import { identityRelation, objectDigest, safeCitekey } from "./identity";
import { loadPdfSource } from "../sources/pdf-package";

export interface DeterministicIntake {identity:PaperIngestIdentity;sourcePath:string;analysisPath:string;extractionPackageKey:string;confirmation:SourceConfirmation;}
export function conversionOptions(options:PaperIngestFlowOptions) {
	return {mode:"precision-extract",formats:["md","json"],model:options.mineruModel,language:options.mineruLanguage,ocr:options.mineruOcr,formula:options.mineruFormula,table:options.mineruTable,pages:normalizePagesValue(options.mineruPages)||null,include_source_pdf:options.mineruIncludeSourcePdf};
}
export async function catalogIntake(app:App,catalog:SourceCatalog,acquisition:AcquisitionService,options:PaperIngestFlowOptions,authorized:AuthorizedPdfSnapshot,signal:AbortSignal):Promise<DeterministicIntake> {
	if(!options.acquisitionSource)throw new Error("v2 入库缺少来源快照");
	const {snapshot,bytes}=await acquisition.preview(options.acquisitionSource.jobId);
	if(authorized.sha256!==snapshot.artifact.sha256 || authorized.size!==snapshot.artifact.byteLength || snapshot.id!==options.acquisitionSource.snapshotId)throw new Error("v2 身份与授权 PDF 不一致");
	const plan=await catalog.prepare(snapshot),analysis=plan.legacy.filter(p=>p.kind==="wiki");if(new Set(analysis.map(p=>p.path)).size>1)throw new Error("同论文存在多个 Wiki，请先核对");
	let sourcePath="";let total=0;const projectionOptions=conversionOptions(options);
	// Reuse a validated fixed projection only with the same source and requested parameters.
	for(const entry of await catalog.storage.list("papers")){
		if(!entry.directory)continue;const root="papers/"+entry.name;
		if((await catalog.storage.list(root)).some(e=>e.name==="_source"))continue;
		const raw=await catalog.storage.read(root+"/_extraction/manifest.json");if(!raw)continue;total+=raw.length;if(total>8*1024*1024)throw new Error("转换目录元数据超过预算");
		const m=JSON.parse(Buffer.from(raw).toString("utf8"));if(m.source?.sha256!==authorized.sha256 || m.source?.size!==authorized.size || objectDigest(m.options||{})!==objectDigest(projectionOptions))continue;
		await new MineruPackageLoader(app).load(root+"/article.md");sourcePath=root+"/article.md";break;
	}
	signal.throwIfAborted();const requestId="r-"+randomUUID(),confirmation=await confirmSourceIdentity(app,requestId,snapshot,signal,page=>renderAuthorizedPdfIdentityPage(authorized,page,{signal,bytes}));
	if(!confirmation)throw new Error("原文身份确认已停止");validateSourceConfirmation(confirmation,requestId,snapshot);signal.throwIfAborted();
	const fresh=await catalog.prepare(snapshot);if(fresh.citekey!==plan.citekey || objectDigest(fresh.legacy)!==objectDigest(plan.legacy) || objectDigest(fresh.packages)!==objectDigest(plan.packages))throw new Error("确认期间文献目录发生变化，请重新核对");
	const duplicates=[...plan.packages.map(p=>`papers/${p.packageKey}/source.pdf`),...plan.legacy.map(p=>p.path)];
	return {identity:{status:"verified",duplicateStatus:duplicates.length?"exact":"none",citekey:plan.citekey,title:snapshot.identity.title,title_zh:"",authors:snapshot.identity.authors.join("; "),year:snapshot.identity.year,doi:snapshot.identity.identifiers.doi||"",duplicates,conflicts:[],notes:["身份与分层去重由来源目录确定；已完成 v2 标题页确认",...plan.warnings]},sourcePath,analysisPath:analysis[0]?.path||"",extractionPackageKey:`${plan.citekey.slice(0,50)}--mineru--${objectDigest({sha256:authorized.sha256,options:projectionOptions}).slice(0,32)}`,confirmation};
}

/** Legacy v1 keeps its receipts; new PDF packages supply canonical paper association, not fake Markdown hits. */
export async function legacyCatalogAssociation(catalog:SourceCatalog,identity:PaperIngestIdentity):Promise<{citekey?:string;notes:string[]}> {
	if(!identity.doi)return {notes:[]};const found=(await catalog.list()).packages.filter(p=>identityRelation({doi:identity.doi},p.identity.identifiers)==="same");
	if(!found.length)return {notes:[]};if(found.length>40)throw new Error("论文来源版本过多，请先核对");
	for(const p of found)await loadPdfSource(catalog.storage,p.packageKey);
	const keys=new Set(found.map(p=>p.citekey));if(keys.size!==1 || !safeCitekey([...keys][0]))throw new Error("正式原文目录的书目关联冲突");
	return {citekey:[...keys][0],notes:[`确定性来源目录发现 ${found.length} 个 PDF 原文包；模型查重建议为 ${identity.duplicateStatus}。PDF 包不代表已存在正文 Markdown 或 Wiki。`]};
}
