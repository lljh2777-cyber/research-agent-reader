import { randomUUID } from "node:crypto";
import type { AcquisitionService } from "../fulltext/service";
import { bytesDigest,objectDigest,canonicalJson } from "../papers/identity";
import type { SourceCatalog } from "../papers/catalog";
import type { SourceIndexIO } from "../papers/source-intake";
import type { SourceStorage } from "../sources/storage";
import { decodeJatsManifest,loadJatsSource,sourcePayloads,type JatsManifest } from "../sources/jats-package";
import { confirmJats,displayedJatsIdentity,validateJatsConfirmation,type JatsConfirmation } from "./confirmation";

type Acquired=Awaited<ReturnType<AcquisitionService["previewJats"]>>;
export interface JatsIntakeDeps {deviceId:string;catalog:SourceCatalog;journal:SourceStorage;index:SourceIndexIO;read(jobId:string):Promise<Acquired>;link(jobId:string,key:string):Promise<void>;}
interface Durable {schemaVersion:1;deviceId:string;manifest:JatsManifest;confirmation:JatsConfirmation;indexBefore:string|null;indexAfter:string;}
export interface JatsPlan {requestId:string;jobId:string;packageKey:string;paperId:string;citekey:string;acquired:Acquired;evidence:ReturnType<typeof displayedJatsIdentity>;evidenceDigest:string;existing:boolean;recovering:boolean;warnings:string[];phase:"ready"|"saving"|"saved"|"registration_pending"|"cancelled"|"failed";error:string;}
interface Active {view:JatsPlan;cancelled:boolean;committing:boolean;committed:boolean;durable?:Durable;}
const encode=(v:unknown)=>Buffer.from(canonicalJson(v),"utf8");
function nextIndex(before:string|null,m:JatsManifest):string {const marker=`<!-- rar-source:${m.digest} -->`,line=`- \`papers/${m.packageKey}/article.md\` — JATS 原文（${m.sourceVersionId}；conversion-only） ${marker}`;if(before?.split(/\r?\n/).includes(line))return before;if(before?.includes(marker))throw new Error("此原文索引行已被编辑，请先核对");return(before||"# 原文包索引\n").trimEnd()+"\n\n"+line+"\n";}
export class JatsIntakeService {
	private plans=new Map<string,Active>();private queue:Promise<unknown>=Promise.resolve();private closed=false;
	constructor(readonly deps:JatsIntakeDeps){if(!/^[a-f0-9]{64}$/.test(deps.deviceId))throw new Error("JATS 保存设备无效");}
	async prepare(jobId:string):Promise<JatsPlan> {
		if(this.closed)throw new Error("JATS 保存服务已关闭");const active=[...this.plans.values()].find(p=>p.view.jobId===jobId&&["ready","saving"].includes(p.view.phase));if(active)return active.view;
		if(this.plans.size>=100)throw new Error("保存计划过多，请重载插件");
		const acquired=await this.deps.read(jobId),association=await this.deps.catalog.associate(acquired.snapshot.identity),evidence=displayedJatsIdentity(acquired.content.get("article.xml")!);
		if([...this.plans.values()].reduce((n,p)=>n+[...p.view.acquired.content.values()].reduce((a,b)=>a+b.length,0),[...acquired.content.values()].reduce((n,b)=>n+b.length,0))>64*1024*1024)throw new Error("请先关闭其他原文保存窗口");
		const same=association.packages.find((p):p is JatsManifest=>p.packageKind==="jats-source"&&p.projectionId===acquired.projection.projectionId&&p.sourceVersionId===acquired.snapshot.candidate.jats!.sourceVersionId&&p.version===acquired.snapshot.candidate.version&&p.files.some(f=>f.path==="_source/metadata.json"&&f.sha256===acquired.snapshot.candidate.jats!.manifestSha256));
		let requestId="r-"+randomUUID(),packageKey=same?.packageKey||association.citekey+"--jats--"+objectDigest({snapshot:acquired.snapshot.artifact,projection:acquired.projection.projectionId}).slice(0,24),durable:Durable|undefined;
		if(!same)for(const e of await this.deps.journal.list("jats-intake")){if(!e.directory||!/^r-[a-f0-9-]{36}$/.test(e.name))continue;const raw=await this.deps.journal.read(`jats-intake/${e.name}/plan.json`);if(!raw)continue;const p=JSON.parse(Buffer.from(raw).toString("utf8")) as Durable;if(p.manifest?.snapshotId!==acquired.snapshot.id)continue;
			decodeJatsManifest(p.manifest);if(p.schemaVersion!==1||p.deviceId!==this.deps.deviceId||p.manifest.requestId!==e.name||p.indexAfter!==nextIndex(p.indexBefore,p.manifest)||p.manifest.projectionId!==acquired.projection.projectionId)throw new Error("JATS 恢复计划已变化或属于另一设备");validateJatsConfirmation(p.confirmation,e.name,acquired.snapshot,acquired.content.get("article.xml")!);durable=p;requestId=e.name;packageKey=p.manifest.packageKey;break;
		}
		if(!same&&!durable&&(await this.deps.catalog.storage.list("papers")).some(e=>e.name===packageKey)){packageKey=association.citekey+"--jats--"+objectDigest({snapshot:acquired.snapshot.artifact,projection:acquired.projection.projectionId});if((await this.deps.catalog.storage.list("papers")).some(e=>e.name===packageKey))throw new Error("JATS 目标目录已占用");}
		const view:JatsPlan={requestId,jobId,packageKey,paperId:durable?.manifest.paperId||association.paperId,citekey:association.citekey,acquired,evidence,evidenceDigest:objectDigest({identity:acquired.snapshot.identity,evidence}),existing:!!same,recovering:!!durable,warnings:association.warnings,phase:"ready",error:""};
		if(this.closed)throw new Error("JATS 保存服务已关闭");this.plans.set(requestId,{view,durable,cancelled:false,committing:false,committed:false});return view;
	}
	save(id:string,evidenceDigest:string,acceptedPartial:boolean):Promise<JatsPlan> {const task=this.queue.then(()=>this.commit(id,evidenceDigest,acceptedPartial));this.queue=task.catch(()=>undefined);return task;}
	private live(id:string):Active {const p=this.plans.get(id);if(!p||this.closed||p.cancelled)throw new Error("JATS 保存已停止");return p;}
	private release(p:Active):void{const a=p.view.acquired;p.view.acquired={...a,content:new Map(),projection:{...a.projection,markdown:"",blocks:[],assets:[],references:[],issues:[]}};p.view.evidence={...p.view.evidence,excerpt:""};}
	private async register(p:Active):Promise<JatsPlan>{const pkg=await loadJatsSource(this.deps.catalog.storage,p.view.packageKey),before=await this.deps.index.read(),after=nextIndex(before,pkg.manifest);this.live(p.view.requestId);p.committing=true;p.committed=true;p.view.phase="registration_pending";await this.deps.link(p.view.jobId,p.view.packageKey);await this.deps.index.apply(before,after);p.view.phase="saved";p.view.error="";return p.view;}
	private async commit(id:string,digest:string,acceptedPartial:boolean):Promise<JatsPlan> {
		const p=this.live(id),v=p.view;if(v.phase==="saved")return v;
		try{
			if(v.existing)return await this.register(p);
			if(digest!==v.evidenceDigest)throw new Error("请先核对当前显示的 XML 主文章信息");
			const current=await this.deps.read(v.jobId);this.live(id);if(objectDigest(current.snapshot)!==objectDigest(v.acquired.snapshot)||current.projection.projectionId!==v.acquired.projection.projectionId)throw new Error("JATS 快照或投影已变化");
			const assoc=await this.deps.catalog.associate(current.snapshot.identity);if(assoc.citekey!==v.citekey||(assoc.packages.length&&assoc.paperId!==v.paperId))throw new Error("JATS 文献关联已变化，请重新核对");
			const existing=assoc.packages.find(a=>a.packageKind==="jats-source"&&a.projectionId===current.projection.projectionId&&a.sourceVersionId===current.snapshot.candidate.jats!.sourceVersionId&&a.version===current.snapshot.candidate.version&&a.files.some(f=>f.path==="_source/metadata.json"&&f.sha256===current.snapshot.candidate.jats!.manifestSha256));if(existing){v.packageKey=existing.packageKey;v.existing=true;return await this.register(p);}
			const confirmation=p.durable?.confirmation||confirmJats(id,current.snapshot,current.content.get("article.xml")!,acceptedPartial);validateJatsConfirmation(confirmation,id,current.snapshot,current.content.get("article.xml")!);
			if(current.snapshot.validation.requestSatisfaction==="partial"&&!acceptedPartial)throw new Error("请明确接受当前缺图或部分内容结果");
			const createdAt=p.durable?.manifest.createdAt||new Date().toISOString(),transaction={schemaVersion:1,requestId:id,packageKey:v.packageKey,paperId:v.paperId,citekey:v.citekey,snapshotId:current.snapshot.id,createdAt};
			const files=sourcePayloads(current.snapshot,current.content,current.projection,confirmation,transaction);
			if(!p.durable){const base:Omit<JatsManifest,"digest">={schemaVersion:1,packageKind:"jats-source",state:"committed",packageKey:v.packageKey,paperId:v.paperId,citekey:v.citekey,snapshotId:current.snapshot.id,requestId:id,createdAt,version:current.snapshot.candidate.version,sourceVersionId:current.snapshot.candidate.jats!.sourceVersionId,identity:current.snapshot.identity,projectionId:current.projection.projectionId,converter:current.projection.converter,capabilities:{pdf:false,body:true,figures:current.projection.assets.some(a=>!!a.path)},files:[...files].map(([path,b])=>({path,sha256:bytesDigest(b),byteLength:b.length}))};const manifest=decodeJatsManifest({...base,digest:objectDigest(base)}),before=await this.deps.index.read(),durable:Durable={schemaVersion:1,deviceId:this.deps.deviceId,manifest,confirmation,indexBefore:before,indexAfter:nextIndex(before,manifest)};
				if(encode(durable).length>256*1024)throw new Error("JATS 保存计划超限");this.live(id);await this.deps.journal.mkdir("jats-intake");await this.deps.journal.mkdir("jats-intake/"+id,true);await this.deps.journal.create(`jats-intake/${id}/plan.json`,encode(durable));p.durable=durable;
			}
			const manifest=p.durable.manifest;for(const f of manifest.files)if(!files.has(f.path)||bytesDigest(files.get(f.path)!)!==f.sha256)throw new Error("JATS 恢复内容与原计划不一致");
			const storage=this.deps.catalog.storage,root="papers/"+v.packageKey;this.live(id);v.phase="saving";await storage.mkdir("papers");const occupied=(await storage.list("papers")).some(e=>e.name===v.packageKey);
			if(occupied){const ownership=await storage.read(root+"/_source/transaction.json");if(!v.recovering||!ownership||bytesDigest(ownership)!==bytesDigest(files.get("_source/transaction.json")!))throw new Error("JATS 目录缺少本事务所有权，未接管");}
			else{await storage.mkdir(root,true);await storage.mkdir(root+"/_source",true);}
			const dirs=["","_source","_source/original-assets","images"],allowed=new Set([...files.keys(),...dirs]);for(const d of dirs)for(const e of await storage.list(root+(d?"/"+d:"")))if(!allowed.has((d?d+"/":"")+e.name))throw new Error("JATS 恢复目录含未知文件");
			for(const[name,b]of files){const old=await storage.read(root+"/"+name,b.length);if(old&&bytesDigest(old)!==bytesDigest(b))throw new Error("JATS 恢复文件被修改，未覆盖");}
			for(const d of dirs.slice(2))if([...files.keys()].some(k=>k.startsWith(d+"/")))await storage.mkdir(root+"/"+d);
			const order=["_source/transaction.json",...[...files.keys()].filter(k=>k!=="_source/transaction.json")];for(const name of order){this.live(id);const b=files.get(name)!;if(!await storage.read(root+"/"+name,b.length))await storage.create(root+"/"+name,b);const saved=await storage.read(root+"/"+name,b.length);if(!saved||bytesDigest(saved)!==bytesDigest(b))throw new Error("JATS 文件写入后校验失败");}
			this.live(id);p.committing=true;await storage.create(root+"/_source/manifest.json",encode(manifest));await loadJatsSource(storage,v.packageKey);p.committed=true;v.phase="registration_pending";
			await this.deps.link(v.jobId,v.packageKey);await this.deps.index.apply(p.durable.indexBefore,p.durable.indexAfter);v.phase="saved";v.error="";return v;
		}catch(error){v.phase=p.committed?"registration_pending":p.cancelled?"cancelled":"failed";p.committing=false;v.recovering=!!p.durable;v.error=error instanceof Error?error.message:"JATS 保存未完成";return v;}
		finally{if(v.phase==="saved"||v.phase==="cancelled")this.release(p);}
	}
	cancel(id:string):boolean {const p=this.plans.get(id);if(!p||p.committing||p.view.phase==="saved")return false;p.cancelled=true;p.view.phase="cancelled";this.release(p);return true;}
	async dispose(){this.closed=true;for(const p of this.plans.values())if(!p.committing)p.cancelled=true;await this.queue;this.plans.clear();}
}
