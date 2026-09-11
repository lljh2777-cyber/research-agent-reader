import { randomUUID } from "node:crypto";
import { decodePdfSourceSnapshot, isLocalPdfSnapshot, pdfSourceVersion, type PdfSourceSnapshot } from "../sources/pdf-snapshot";
import type { AuthorizedPdfPageRaster } from "../agent/pdf-identity";
import { bytesDigest, canonicalJson, objectDigest } from "./identity";
import { sourceConfirmation, validateSourceConfirmation, type PdfDisplayedEvidence, type SourceConfirmation } from "./confirmation";
import { SourceCatalog, type CatalogPlan } from "./catalog";
import { decodeSourceManifest, loadPdfSource, representationDigest, sealManifest, sourceVersion, sourceFiles, type SourceManifest } from "../sources/pdf-package";
import type { SourceStorage } from "../sources/storage";

export interface SourceIndexIO {read():Promise<string|null>;apply(before:string|null,after:string):Promise<void>;}
export interface AcquiredSource {snapshot:PdfSourceSnapshot;bytes:Uint8Array;path:string;}
export interface SourceIntakeDeps {
	deviceId:string;catalog:SourceCatalog;journal:SourceStorage;index:SourceIndexIO;
	readSource(jobId:string):Promise<AcquiredSource>;
	render(source:AcquiredSource,page:number,signal:AbortSignal):Promise<AuthorizedPdfPageRaster>;
	link(jobId:string,packageKey:string):Promise<void>;
}
interface SavedPlan {schemaVersion:1;deviceId:string;manifest:SourceManifest;snapshot:PdfSourceSnapshot;confirmation:SourceConfirmation;indexBefore:string|null;indexAfter:string;}
export interface SourceSavePlan {
	requestId:string;jobId:string;snapshot:PdfSourceSnapshot;packageKey:string;paperId:string;citekey:string;warnings:string[];
	phase:"prepared"|"ready"|"saving"|"saved"|"registration_pending"|"cancelled"|"failed";
	existing:boolean;recovering:boolean;error:string;
}
interface ActivePlan {view:SourceSavePlan;source:AcquiredSource;catalog:CatalogPlan;controller:AbortController;committing:boolean;committed:boolean;saved?:SavedPlan;png?:Uint8Array;evidence?:PdfDisplayedEvidence;generation:number;}
const encode=(value:unknown)=>Buffer.from(canonicalJson(value),"utf8");
function assertSource(source:AcquiredSource):void {
	decodePdfSourceSnapshot(source.snapshot);
	if(source.bytes.length!==source.snapshot.artifact.byteLength || bytesDigest(source.bytes)!==source.snapshot.artifact.sha256)throw new Error("原文内容与获取快照不一致");
}
function indexAfter(before:string|null,manifest:SourceManifest):string {
	const version=manifest.version==="unknown"?"版本未核验":(manifest.schemaVersion===2?"用户声明的":"")+(manifest.version==="version_of_record"?"出版版本":"作者接受稿");
	const marker=`<!-- rar-source:${manifest.digest} -->`,line=`- \`papers/${manifest.packageKey}/source.pdf\` — PDF 原文（${manifest.schemaVersion===2?"本地文件；":""}${version}；metadata-only） ${marker}`;
	if(before?.split(/\r?\n/).includes(line))return before;
	if(before?.includes(marker))throw new Error("此原文的索引行已被编辑，请先核对");
	return (before||"# 原文包索引\n").trimEnd()+"\n\n"+line+"\n";
}
function payloads(saved:SavedPlan,pdf:Uint8Array,png:Uint8Array):Uint8Array[] {
	const m=saved.manifest;
	return [pdf,encode({schemaVersion:1,requestId:m.requestId,packageKey:m.packageKey,paperId:m.paperId,citekey:m.citekey,snapshotId:m.snapshotId,createdAt:m.createdAt}),encode(saved.snapshot),encode({confirmation:saved.confirmation,validation:saved.snapshot.validation}),png];
}

/** Owns PDF-only publication and index recovery. Models cannot issue confirmations or decide duplicates. */
export class SourceIntakeService {
	private plans=new Map<string,ActivePlan>();private queue:Promise<unknown>=Promise.resolve();private closed=false;
	constructor(readonly deps:SourceIntakeDeps){if(!/^[a-f0-9]{64}$/.test(deps.deviceId))throw new Error("原文保存设备标识无效");}
	get(id:string):SourceSavePlan {const p=this.plans.get(id);if(!p)throw new Error("原文保存计划已关闭");return structuredClone(p.view);}
	private live(id:string):ActivePlan {const p=this.plans.get(id);if(!p || this.closed || p.controller.signal.aborted)throw new Error("原文保存已停止");return p;}
	async prepare(jobId:string):Promise<SourceSavePlan> {
		if(this.closed)throw new Error("原文保存服务已关闭");
		const active=[...this.plans.values()].find(p=>p.view.jobId===jobId&&!["saved","failed","cancelled","registration_pending"].includes(p.view.phase));if(active)return this.get(active.view.requestId);
		if(this.plans.size>=100)throw new Error("本次打开的原文计划过多，请重新加载插件");
		const source=await this.deps.readSource(jobId);assertSource(source);
		if([...this.plans.values()].reduce((n,p)=>n+p.source.bytes.length+(p.png?.length||0),source.bytes.length)>128*1024*1024)throw new Error("正在核对的原文超过内存预算，请先关闭其他保存窗口");
		const catalog=await this.deps.catalog.prepare(source.snapshot);
		let requestId="r-"+randomUUID(),packageKey=catalog.reuse?.packageKey||`${catalog.citekey}--pdf--${representationDigest(source.snapshot).slice(0,24)}`,saved:SavedPlan|undefined,png:Uint8Array|undefined;
		// Only explicitly resuming this acquisition can reuse a durable transaction plan.
		if(!catalog.reuse)for(const entry of (await this.deps.journal.list("source-intake")).reverse()){
			if(!entry.directory||!/^r-[a-f0-9-]{36}$/.test(entry.name))continue;
			const bytes=await this.deps.journal.read(`source-intake/${entry.name}/plan.json`);if(!bytes)continue;
			const candidate=JSON.parse(Buffer.from(bytes).toString("utf8")) as SavedPlan;
			if(candidate.snapshot?.id!==source.snapshot.id)continue;
			this.validateSaved(candidate,source.snapshot);if(candidate.manifest.requestId!==entry.name)throw new Error("原文恢复记录与目录不一致");
			png=await this.deps.journal.read(`source-intake/${entry.name}/evidence.png`,16*1024*1024)||undefined;
			if(!png||bytesDigest(png)!==candidate.confirmation.evidence.pngSha256)throw new Error("保存前的页面证据已变化");
			saved=candidate;requestId=entry.name;packageKey=candidate.manifest.packageKey;break;
		}
		if(this.closed)throw new Error("原文保存服务已关闭");
		if(!saved&&!catalog.reuse&&(await this.deps.catalog.storage.list("papers")).some(e=>e.name===packageKey)){
			packageKey=`${catalog.citekey}--pdf--${representationDigest(source.snapshot)}`;
			if((await this.deps.catalog.storage.list("papers")).some(e=>e.name===packageKey))throw new Error("原文目录摘要已被占用，请核对保留的目录");
		}
		const view:SourceSavePlan={requestId,jobId,snapshot:source.snapshot,packageKey,paperId:saved?.manifest.paperId||catalog.paperId,citekey:catalog.citekey,warnings:catalog.warnings,phase:catalog.reuse?"registration_pending":"prepared",existing:!!catalog.reuse,recovering:!!saved,error:""};
		this.plans.set(requestId,{view,source,catalog,controller:new AbortController(),committing:false,committed:false,saved,png,generation:0});return this.get(requestId);
	}
	private validateSaved(saved:SavedPlan,snapshot:PdfSourceSnapshot):void {
		if(saved.deviceId!==this.deps.deviceId)throw new Error("该原文保存计划属于另一设备，未接管");
		if(encode(saved).length>256*1024)throw new Error("原文保存计划超过读取上限");
		if(saved.schemaVersion!==1)throw new Error("原文保存计划版本无效");decodeSourceManifest(saved.manifest);decodePdfSourceSnapshot(saved.snapshot);validateSourceConfirmation(saved.confirmation,saved.manifest.requestId,snapshot);
		if(saved.manifest.schemaVersion!==(isLocalPdfSnapshot(snapshot)?2:1) || saved.manifest.version!==pdfSourceVersion(snapshot) || saved.manifest.sourceVersionId!==sourceVersion(snapshot))throw new Error("原文恢复计划的来源类型或版本不一致");
		if(objectDigest(saved.snapshot)!==objectDigest(snapshot)||saved.manifest.snapshotId!==snapshot.id || objectDigest(saved.manifest.identity)!==objectDigest(snapshot.identity)||saved.indexAfter!==indexAfter(saved.indexBefore,saved.manifest))throw new Error("原文恢复计划与快照或登记内容不一致");
	}
	async present(id:string,page=1):Promise<{dataUrl:string;digest:string}> {
		const p=this.live(id),generation=++p.generation;p.evidence=undefined;
		if(p.saved){const evidence=p.saved.confirmation.evidence;p.evidence=evidence;p.view.phase="ready";return {dataUrl:"data:image/png;base64,"+Buffer.from(p.png!).toString("base64"),digest:objectDigest({identity:p.source.snapshot.identity,evidence})};}
		const raster=await this.deps.render(p.source,page,p.controller.signal);this.live(id);if(generation!==p.generation)throw new Error("页面选择已变化");
		if(!raster.rasterDataUrl.startsWith("data:image/png;base64,"))throw new Error("标题页图像类型无效");
		const png=Buffer.from(raster.rasterDataUrl.slice(22),"base64");if(png.length>16*1024*1024 || !png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error("标题页图像无效或过大");
		const {rasterDataUrl,...details}=raster,evidence:PdfDisplayedEvidence={...details,kind:"pdf",pngSha256:bytesDigest(png)};
		validateSourceConfirmation(sourceConfirmation(id,p.source.snapshot,evidence),id,p.source.snapshot);p.png=png;p.evidence=evidence;p.view.phase="ready";
		return {dataUrl:rasterDataUrl,digest:objectDigest({identity:p.source.snapshot.identity,evidence})};
	}
	/** Called only by the explicit confirmation button after the displayed image has decoded. */
	save(id:string,displayedDigest:string):Promise<SourceSavePlan> {
		const task=this.queue.then(()=>this.commit(id,displayedDigest));this.queue=task.catch(()=>undefined);return task;
	}
	private async commit(id:string,displayedDigest:string):Promise<SourceSavePlan> {
		const p=this.live(id);if(p.view.phase==="saved")return this.get(id);
		try{
			if(p.view.existing)return await this.registerExisting(p);
			if(!p.evidence || displayedDigest!==objectDigest({identity:p.source.snapshot.identity,evidence:p.evidence}))throw new Error("请先核对当前展示的 PDF 页面");
			const source=await this.deps.readSource(p.view.jobId);assertSource(source);this.live(id);if(objectDigest(source.snapshot)!==objectDigest(p.source.snapshot))throw new Error("待保存的获取快照已变化");
			const current=await this.deps.catalog.prepare(source.snapshot);this.live(id);
			if(current.citekey!==p.view.citekey || (current.existingPaperId&&current.paperId!==p.view.paperId))throw new Error("论文关联或 citekey 已变化，请重新核对");
			if(current.reuse){p.catalog=current;p.view.existing=true;p.view.packageKey=current.reuse.packageKey;return await this.registerExisting(p);}
			p.view.phase="saving";
			let saved=p.saved;
			if(!saved){
				const confirmation=sourceConfirmation(id,source.snapshot,p.evidence),createdAt=new Date().toISOString();
				const manifest:SourceManifest={schemaVersion:isLocalPdfSnapshot(source.snapshot)?2:1,packageKind:"pdf-source",state:"committed",packageKey:p.view.packageKey,paperId:p.view.paperId,citekey:p.view.citekey,snapshotId:source.snapshot.id,requestId:id,createdAt,version:pdfSourceVersion(source.snapshot),sourceVersionId:sourceVersion(source.snapshot),identity:source.snapshot.identity,capabilities:{pdf:true,body:false,figures:false},files:[],digest:""};
				saved={schemaVersion:1,deviceId:this.deps.deviceId,manifest,snapshot:source.snapshot,confirmation,indexBefore:await this.deps.index.read(),indexAfter:""};
				const bytes=payloads(saved,source.bytes,p.png!);manifest.files=sourceFiles(source.snapshot).map((path,i)=>({path,sha256:bytesDigest(bytes[i]),byteLength:bytes[i].length}));const {digest,...unsigned}=manifest;saved.manifest=sealManifest(unsigned);saved.indexAfter=indexAfter(saved.indexBefore,saved.manifest);
				this.validateSaved(saved,source.snapshot);this.live(id);
				await this.deps.journal.mkdir("source-intake");await this.deps.journal.mkdir("source-intake/"+id,true);
				await this.deps.journal.create(`source-intake/${id}/evidence.png`,p.png!);await this.deps.journal.create(`source-intake/${id}/plan.json`,encode(saved));p.saved=saved;
			}
			const root="papers/"+saved.manifest.packageKey,storage=this.deps.catalog.storage;this.live(id);
			await storage.mkdir("papers");
			const existing=(await storage.list("papers")).find(e=>e.name===saved!.manifest.packageKey);
			if(!existing){await storage.mkdir(root,true);await storage.mkdir(root+"/_source",true);}
			else if(!p.view.recovering)throw new Error("正式目录已被占用，请重新核对；未覆盖已有内容");
			const values=payloads(saved,source.bytes,p.png!);
			const files=sourceFiles(saved.snapshot);
			if(existing){const ownership=await storage.read(root+"/_source/transaction.json");if(!ownership||bytesDigest(ownership)!==bytesDigest(values[1]))throw new Error("现有目录缺少本事务的所有权记录，未接管");}
			// Preflight all existing content before any recovery write. Partial/mutated bytes are never repaired in place.
			const allowed=new Set(["source.pdf","_source"]);for(const e of await storage.list(root))if(!allowed.has(e.name))throw new Error("恢复目录含未知文件，已停止");
			const inner=new Set(files.slice(1).map(s=>s.slice(8)));for(const e of await storage.list(root+"/_source"))if(!inner.has(e.name))throw new Error("恢复目录含未知或已提交清单，请重新打开");
			for(let i=0;i<files.length;i++){const before=await storage.read(root+"/"+files[i],values[i].length);if(before && bytesDigest(before)!==bytesDigest(values[i]))throw new Error("恢复文件已修改，未覆盖："+files[i]);}
			// Ownership transaction precedes the PDF. Every write is exclusive and verified before the commit marker.
			for(const i of [1,0,2,3,4]){this.live(id);const name=root+"/"+files[i];if(!await storage.read(name,values[i].length))await storage.create(name,values[i]);const check=await storage.read(name,values[i].length);if(!check||bytesDigest(check)!==saved.manifest.files[i].sha256)throw new Error("原文文件写入后校验失败");}
			this.live(id);p.committing=true;await storage.create(root+"/_source/manifest.json",encode(saved.manifest));
			await loadPdfSource(storage,saved.manifest.packageKey);p.committed=true;p.view.phase="registration_pending";
			await this.deps.link(p.view.jobId,saved.manifest.packageKey);
			await this.deps.index.apply(saved.indexBefore,saved.indexAfter);p.view.phase="saved";p.view.error="";this.releaseBytes(p);return this.get(id);
		}catch(error){p.view.phase=p.committed?"registration_pending":p.controller.signal.aborted?"cancelled":"failed";p.committing=false;p.view.recovering=!!p.saved;p.view.error=error instanceof Error?error.message:"原文保存未完成";return this.get(id);}
	}
	private async registerExisting(p:ActivePlan):Promise<SourceSavePlan> {
		const pkg=await loadPdfSource(this.deps.catalog.storage,p.view.packageKey),before=await this.deps.index.read(),after=indexAfter(before,pkg.manifest);
		this.live(p.view.requestId);p.committing=true;p.committed=true;p.view.phase="registration_pending";
		await this.deps.link(p.view.jobId,p.view.packageKey);await this.deps.index.apply(before,after);p.view.phase="saved";p.view.error="";this.releaseBytes(p);return this.get(p.view.requestId);
	}
	private releaseBytes(p:ActivePlan):void {p.source={...p.source,bytes:new Uint8Array()};p.png=undefined;}
	cancel(id:string):boolean {const p=this.plans.get(id);if(!p||p.committing||p.view.phase==="saved")return false;p.controller.abort();p.view.phase="cancelled";this.releaseBytes(p);return true;}
	async dispose():Promise<void>{this.closed=true;for(const p of this.plans.values())if(!p.committing)p.controller.abort();await this.queue;this.plans.clear();}
}
