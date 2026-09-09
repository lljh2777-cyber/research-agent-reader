import { createHash } from "node:crypto";
import type { AcquisitionCandidate,AcquisitionRequest,ResolvedIdentity } from "../fulltext/contracts";
import type { SourceTransport } from "../fulltext/transport";
import { pmcVersions } from "../fulltext/pmc-provider";
import { canonicalTitle,metadataJson,object } from "../fulltext/identity-resolver";
import { SourceError } from "../fulltext/errors";
import { bytesDigest,objectDigest } from "../papers/identity";
import type { SourceStorage } from "../sources/storage";
import { decodeJatsBundle,decodeJatsLocator,decodeJatsSnapshot,JATS_LIMITS,type JatsBundle,type JatsFile,type JatsLocator,type JatsSnapshot,type JatsValidation } from "./contracts";
import { graphicReferences,projectJats,type JatsAsset } from "./projection";
import { assetFor } from "./media";
import { validateJatsProjection } from "./validation";

const BUCKET="https://pmc-oa-opendata.s3.amazonaws.com/",flag=(v:unknown)=>v===true||v==="yes";
function s3File(value:unknown,version:string) {
	if(typeof value!=="string")throw new Error("PMC 文件地址缺失");const url=new URL(value);
	if(url.protocol!=="s3:"||url.hostname!=="pmc-oa-opendata"||url.username||url.password||url.hash||url.port||url.searchParams.getAll("md5").length!==1||[...url.searchParams.keys()].some(k=>k!=="md5")||!url.pathname.startsWith("/"+version+"/"))throw new Error("PMC JATS 文件不属于同版本清单");
	return {key:url.pathname.slice(1),md5:url.searchParams.get("md5")!};
}
export function jatsCandidate(value:unknown,bytes:Uint8Array,version:string,identity:ResolvedIdentity,request:AcquisitionRequest):AcquisitionCandidate|undefined {
	const r=object(value);if(r.pmcid!==identity.identifiers.pmcid||`${r.pmcid}.${r.version}`!==version)throw new SourceError("jats_identity","PMC JATS 清单身份不一致","conflict");
	if(canonicalTitle(String(r.title||""))!==canonicalTitle(identity.title))throw new SourceError("jats_identity","PMC JATS 清单标题不一致","conflict");
	for(const k of ["doi","pmid"] as const)if(r[k]&&identity.identifiers[k]&&String(r[k]).toLowerCase()!==identity.identifiers[k])throw new SourceError("jats_identity","PMC JATS 清单标识冲突","conflict");
	if(![true,false,"yes","no"].includes(r.is_manuscript as boolean)||(!flag(r.is_pmc_openaccess)&&!flag(r.is_manuscript))||request.versionPolicy==="record_only"&&flag(r.is_manuscript)||!r.xml_url)return;
	if(!Array.isArray(r.media_urls)||r.media_urls.length>256)throw new Error("PMC 媒体清单缺失或超限");
	const loc=decodeJatsLocator({pmcid:r.pmcid,sourceVersionId:version,manifestSha256:bytesDigest(bytes),xml:s3File(r.xml_url,version),media:r.media_urls.map(v=>s3File(v,version)),license:typeof r.license_code==="string"?r.license_code:"未提供",retracted:flag(r.is_retracted),observedAt:new Date().toISOString()});
	return {id:"c-jats-"+objectDigest({version,manifest:loc.manifestSha256}).slice(0,24),title:String(r.title),providerId:"pmc-jats",version:flag(r.is_manuscript)?"accepted_manuscript":"version_of_record",jats:loc};
}
export class JatsProvider {
	constructor(readonly transport:SourceTransport,readonly storage:SourceStorage){}
	async discover(request:AcquisitionRequest,identity:ResolvedIdentity,signal:AbortSignal):Promise<AcquisitionCandidate[]> {
		const pmcid=identity.identifiers.pmcid;if(!pmcid)throw new SourceError("no_jats","此记录没有 PMC 标识，当前 XML 来源仅支持 PMC","no_match");
		if(identity.publicationTypes.some(t=>/preprint|posted-content/i.test(t)))throw new SourceError("unsupported_version","JATS 暂不接收预印本","no_match");
		const listing=await this.transport.metadata(BUCKET+"?"+new URLSearchParams({"list-type":"2",prefix:pmcid+".",delimiter:"/","max-keys":"11"}),signal);if(listing.status!==200)throw new SourceError("http_"+listing.status,"PMC 版本查询失败");
		const candidates:AcquisitionCandidate[]=[];for(const version of pmcVersions(new TextDecoder("utf-8",{fatal:true}).decode(listing.bytes),pmcid)){
			const result=await this.transport.metadata(BUCKET+"metadata/"+version+".json",signal);if(result.status===404)continue;const candidate=jatsCandidate(metadataJson(result),result.bytes,version,identity,request);if(candidate)candidates.push(candidate);
		}if(!candidates.length)throw new SourceError("no_jats","未找到符合版本范围的 PMC XML","no_match");return candidates;
	}
	async download(candidate:AcquisitionCandidate,request:AcquisitionRequest,identity:ResolvedIdentity,attemptId:string,signal:AbortSignal,progress:(n:number)=>void,budget:{received:number;limit:number}):Promise<{artifact:JatsBundle;validation:JatsValidation}> {
		const loc=candidate.jats!;const current=await this.transport.metadata(BUCKET+"metadata/"+loc.sourceVersionId+".json",signal),refreshed=jatsCandidate(metadataJson(current),current.bytes,loc.sourceVersionId,identity,request);
		if(!refreshed||refreshed.id!==candidate.id)throw new SourceError("manifest_changed","PMC XML / 媒体清单发生变化，请重新选择");
		const dir="jats/"+attemptId;await this.storage.mkdir("jats");await this.storage.mkdir(dir,true);const files:JatsFile[]=[],issues:string[]=[],content=new Map<string,Uint8Array>();let received=0;
		const retain=async(path:string,ref:string,role:JatsFile["role"],bytes:Uint8Array)=>{signal.throwIfAborted();await this.storage.create(path,bytes);files.push({path,ref,role,byteLength:bytes.length,sha256:bytesDigest(bytes),md5:createHash("md5").update(bytes).digest("hex")});content.set(ref,bytes);};
		await retain(dir+"/metadata.json","metadata.json","metadata",current.bytes);
		const get=async(file:{key:string;md5:string},resource:"xml"|"media"):Promise<Uint8Array>=>{const chunks:Uint8Array[]=[];let size=0;await this.transport.download(BUCKET+file.key,signal,{write:async b=>{size+=b.length;received+=b.length;if(size>(resource==="xml"?JATS_LIMITS.xml:JATS_LIMITS.media)||received>JATS_LIMITS.total)throw new SourceError("total_size_limit","JATS 文件累计超过 64 MiB");chunks.push(b);}},()=>progress(received),{resource,budget});const bytes=Buffer.concat(chunks);if(createHash("md5").update(bytes).digest("hex")!==file.md5)throw new SourceError("checksum_mismatch","JATS 文件与同版本清单 MD5 不一致");return bytes;};
		const xml=await get(loc.xml,"xml");await retain(dir+"/article.xml","article.xml","xml",xml);projectJats(xml,identity,[]);
		const refs=graphicReferences(xml);if(refs.length>JATS_LIMITS.assets)throw new SourceError("too_many_assets","正文引用图片超过 64 项");
		if(request.includeFigures)for(const [i,ref]of refs.entries()){
			const file=loc.media.find(m=>m.key===loc.sourceVersionId+"/"+ref),extension=ref.split(".").pop()?.toLowerCase();
			if(!file||!extension||! /^(png|jpg|jpeg|webp|tif|tiff|svg)$/.test(extension)){issues.push("未找到同版本、受支持的媒体定位："+ref);continue;}
			try{await retain(`${dir}/m${i}.${extension}`,ref,"media",await get(file,"media"));}catch(error){signal.throwIfAborted();if(error instanceof SourceError&&["checksum_mismatch","total_size_limit","timeout"].includes(error.code))throw error;issues.push("图片获取未完成："+ref);}
		}
		const artifact=decodeJatsBundle({kind:"jats",files,issues,includeFigures:!!request.includeFigures});return {artifact,validation:this.project(xml,identity,artifact,content).validation};
	}
	project(xml:Uint8Array,identity:ResolvedIdentity,artifact:JatsBundle,content:Map<string,Uint8Array>) {
		const assets:JatsAsset[]=graphicReferences(xml).map(ref=>content.has(ref)?assetFor(ref,content.get(ref)!):{ref,issue:artifact.includeFigures?"同版本图片缺失："+ref:"本次未请求图片："+ref});
		const projection=projectJats(xml,identity,assets),validation=validateJatsProjection(artifact,projection);
		return {projection,validation};
	}
	async read(snapshot:JatsSnapshot) {
		decodeJatsSnapshot(snapshot);const content=new Map<string,Uint8Array>();for(const f of snapshot.artifact.files){const bytes=await this.storage.read(f.path,f.byteLength);if(!bytes||bytes.length!==f.byteLength||bytesDigest(bytes)!==f.sha256)throw new Error("JATS 获取文件缺失或已修改");content.set(f.ref,bytes);}
		const result=this.project(content.get("article.xml")!,snapshot.identity,snapshot.artifact,content);if(objectDigest(result.validation)!==objectDigest(snapshot.validation))throw new Error("JATS 验证记录与文件不一致");return {...result,content};
	}
}
