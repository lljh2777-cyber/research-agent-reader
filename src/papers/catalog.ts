import { randomUUID } from "node:crypto";
import type { PdfSnapshot } from "../fulltext/contracts";
import { decodeSourceManifest, loadPdfSource, sourceVersion, type SourceManifest } from "../sources/pdf-package";
import type { SourceStorage } from "../sources/storage";
import { identityRelation, safeCitekey, sourceCitekey, type ResolvedIdentity } from "./identity";

export interface LegacySource {path:string;kind:"mineru"|"markdown"|"wiki";identifiers:ResolvedIdentity["identifiers"];title:string;citekey?:string;}
export interface CatalogPlan {paperId:string;citekey:string;packages:SourceManifest[];legacy:LegacySource[];reuse?:SourceManifest;warnings:string[];}
export class SourceCatalog {
	constructor(readonly storage:SourceStorage,private legacySources:()=>Promise<LegacySource[]>=async()=>[]){}
	async list():Promise<{packages:SourceManifest[];warnings:string[]}> {
		const packages:SourceManifest[]=[],warnings:string[]=[];let total=0;
		for(const entry of await this.storage.list("papers")){
			if(!entry.directory)continue;const dir="papers/"+entry.name;
			if(!(await this.storage.list(dir)).some(e=>e.name==="_source"))continue;
			const bytes=await this.storage.read(dir+"/_source/manifest.json");
			if(!bytes){warnings.push("尚未提交的原文目录："+dir);continue;}
			total+=bytes.length;if(total>8*1024*1024)throw new Error("原文目录元数据超过读取预算");
			const manifest=decodeSourceManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));if(manifest.packageKey!==entry.name)throw new Error("原文目录与清单不一致："+dir);packages.push(manifest);
		}
		return {packages,warnings};
	}
	async prepare(snapshot:PdfSnapshot):Promise<CatalogPlan> {
		const listed=await this.list(), packages=listed.packages.filter(p=>identityRelation(snapshot.identity.identifiers,p.identity.identifiers)!=="unrelated");
		if(packages.length>40)throw new Error("该论文关联来源超过 40 个，请先核对");
		for(const p of packages){if(identityRelation(snapshot.identity.identifiers,p.identity.identifiers)==="conflict")throw new Error("原文目录中的精确标识冲突");await loadPdfSource(this.storage,p.packageKey);}
		const legacy=(await this.legacySources()).filter(p=>identityRelation(snapshot.identity.identifiers,p.identifiers)!=="unrelated");
		if(legacy.some(p=>identityRelation(snapshot.identity.identifiers,p.identifiers)==="conflict"))throw new Error("旧文献记录的精确标识冲突");
		const ids=new Set(packages.map(p=>p.paperId));if(ids.size>1)throw new Error("相同标识关联多个论文记录，请先核对");
		const keys=new Set([...packages.map(p=>p.citekey),...legacy.map(p=>p.citekey).filter(safeCitekey)]);if(keys.size>1)throw new Error("相同论文存在不同 citekey，请先核对");
		const citekey=[...keys][0]||sourceCitekey(snapshot.identity);
		if(listed.packages.some(p=>p.citekey===citekey&&!packages.includes(p)))throw new Error("原文 citekey 被另一论文占用");
		const reuse=packages.find(p=>p.version===snapshot.candidate.version&&p.sourceVersionId===sourceVersion(snapshot)&&p.files[0].sha256===snapshot.artifact.sha256);
		return {paperId:[...ids][0]||"p-"+randomUUID(),citekey,packages,legacy,reuse,warnings:[...listed.warnings,...legacy.filter(p=>p.kind!=="wiki").map(p=>"旧来源版本未知，未自动替代本次 PDF："+p.path)]};
	}
}
