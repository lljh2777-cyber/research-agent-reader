import { acquisitionId,decodeIdentity,decodeInput,decodeCandidates,type AcquisitionCandidate,type AcquisitionInput,type ResolvedIdentity } from "../fulltext/contracts";
import { jatsConverter } from "./converter-version";
export const JATS_LIMITS={xml:8*1024*1024,media:16*1024*1024,total:64*1024*1024,assets:64};
export interface JatsFileLocator {key:string;md5:string;}
export interface JatsLocator {pmcid:string;sourceVersionId:string;manifestSha256:string;xml:JatsFileLocator;media:JatsFileLocator[];license:string;retracted:boolean;observedAt:string;}
export interface JatsFile {path:string;ref:string;role:"xml"|"metadata"|"media";sha256:string;md5:string;byteLength:number;}
export interface JatsBundle {kind:"jats";files:JatsFile[];issues:string[];includeFigures:boolean;converter?:string;}
export interface JatsValidation {kind:"jats";identityCheck:"verified";bodyCheck:"usable"|"partial";assetCheck:"not_requested"|"complete"|"partial";requestSatisfaction:"satisfied"|"partial";issues:string[];}
export interface JatsSnapshot {schemaVersion:3;mode:"production";id:string;jobId:string;attemptId:string;input:AcquisitionInput;candidateId:string;createdAt:string;identity:ResolvedIdentity;candidate:AcquisitionCandidate;artifact:JatsBundle;validation:JatsValidation;}
const rec=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v))throw new Error("JATS 记录无效");return v as Record<string,unknown>;};
const text=(v:unknown,n=500):string=>{if(typeof v!=="string"||v.length>n||/[\x00-\x08]/.test(v))throw new Error("JATS 字段超限或无效");return v;};
const hash=(v:unknown,n=64):string=>{const s=text(v,n);if(!new RegExp(`^[a-f0-9]{${n}}$`).test(s))throw new Error("JATS 校验值无效");return s;};
const date=(v:unknown):string=>{const s=text(v,40);if(!/^\d{4}-\d\d-\d\dT/.test(s)||!Number.isFinite(Date.parse(s)))throw new Error("JATS 日期无效");return s;};
const list=(v:unknown,n:number):unknown[]=>{if(!Array.isArray(v)||v.length>n)throw new Error("JATS 列表超限");return v;};
export const jatsIssues=(v:unknown):string[]=>list(v,200).map(s=>text(s,500));
export function decodeJatsLocator(v:unknown):JatsLocator {
	const r=rec(v),pmcid=decodeInput({kind:"pmcid",value:r.pmcid}).value,sourceVersionId=text(r.sourceVersionId,40);
	if(!new RegExp(`^${pmcid}\\.[1-9]\\d{0,5}$`).test(sourceVersionId)||typeof r.retracted!=="boolean")throw new Error("JATS 版本无效");
	const locator=(value:unknown)=>{const f=rec(value),key=text(f.key,250);if(!key.startsWith(sourceVersionId+"/")||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(key.slice(sourceVersionId.length+1)))throw new Error("JATS 资源不属于同版本清单");return {key,md5:hash(f.md5,32)};};
	const xml=locator(r.xml),media=list(r.media,256).map(locator);if(xml.key!==`${sourceVersionId}/${sourceVersionId}.xml`||new Set(media.map(m=>m.key)).size!==media.length)throw new Error("JATS XML 或媒体清单无效");
	return {pmcid,sourceVersionId,manifestSha256:hash(r.manifestSha256),xml,media,license:text(r.license,100),retracted:r.retracted,observedAt:date(r.observedAt)};
}
export function decodeJatsBundle(v:unknown):JatsBundle {
	const r=rec(v);if(r.kind!=="jats"||typeof r.includeFigures!=="boolean")throw new Error("JATS 文件包无效");
	jatsConverter(r.converter);
	const files=list(r.files,JATS_LIMITS.assets+2).map(value=>{const f=rec(value),path=text(f.path,180),role=f.role as JatsFile["role"],byteLength=f.byteLength as number;
		if(!/^jats\/a-[a-f0-9-]{36}\/(?:article\.xml|metadata\.json|m\d+\.[a-z0-9]{1,8})$/.test(path)||!["xml","metadata","media"].includes(role)||!Number.isSafeInteger(byteLength)||byteLength<1||byteLength>(role==="xml"?JATS_LIMITS.xml:role==="metadata"?2*1024*1024:JATS_LIMITS.media))throw new Error("JATS 文件路径或大小无效");
		const ref=text(f.ref,200),name=path.split("/").pop()!;
		if(role==="xml"&&(name!=="article.xml"||ref!==name)||role==="metadata"&&(name!=="metadata.json"||ref!==name)||role==="media"&&(!/^m\d+\.[a-z0-9]{1,8}$/.test(name)||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(ref)||["article.xml","metadata.json"].includes(ref)))throw new Error("JATS 文件角色与路径不一致");
		return {path,role,byteLength,ref,sha256:hash(f.sha256),md5:hash(f.md5,32)};});
	if(files.filter(f=>f.role==="xml").length!==1||files.filter(f=>f.role==="metadata").length!==1||new Set(files.map(f=>f.path)).size!==files.length||files.reduce((n,f)=>n+f.byteLength,0)>JATS_LIMITS.total)throw new Error("JATS 文件包缺少核心文件或超限");
	if(new Set(files.map(f=>f.ref)).size!==files.length||!r.includeFigures&&files.some(f=>f.role==="media"))throw new Error("JATS 媒体引用重复或超出请求");
	return {kind:"jats",files,issues:jatsIssues(r.issues),includeFigures:r.includeFigures,...(r.converter===undefined?{}:{converter:r.converter as string})};
}
export function decodeJatsValidation(v:unknown):JatsValidation {const r=rec(v);if(r.kind!=="jats"||r.identityCheck!=="verified"||!["usable","partial"].includes(String(r.bodyCheck))||!["not_requested","complete","partial"].includes(String(r.assetCheck))||!["satisfied","partial"].includes(String(r.requestSatisfaction)))throw new Error("JATS 验证结果无效");return {kind:"jats",identityCheck:"verified",bodyCheck:r.bodyCheck as JatsValidation["bodyCheck"],assetCheck:r.assetCheck as JatsValidation["assetCheck"],requestSatisfaction:r.requestSatisfaction as JatsValidation["requestSatisfaction"],issues:jatsIssues(r.issues)};}
export function decodeJatsSnapshot(v:unknown):JatsSnapshot {
	const r=rec(v);if(r.schemaVersion!==3||r.mode!=="production")throw new Error("JATS 快照版本无效");
	const result:JatsSnapshot={schemaVersion:3,mode:"production",id:text(r.id),jobId:text(r.jobId),attemptId:text(r.attemptId),input:decodeInput(r.input),candidateId:text(r.candidateId),createdAt:date(r.createdAt),identity:decodeIdentity(r.identity),candidate:decodeCandidates([r.candidate])[0],artifact:decodeJatsBundle(r.artifact),validation:decodeJatsValidation(r.validation)};
	const loc=result.candidate.jats,xml=result.artifact.files.find(f=>f.role==="xml")!,metadata=result.artifact.files.find(f=>f.role==="metadata")!;
	if(!acquisitionId(result.id)||result.id[0]!=="s"||!acquisitionId(result.jobId)||result.jobId[0]!=="a"||!acquisitionId(result.attemptId)||result.attemptId[0]!=="a"||result.candidateId!==result.candidate.id||!loc||result.candidate.providerId!=="pmc-jats"||result.identity.identifiers.pmcid!==loc.pmcid||result.identity.identifiers[result.input.kind]!==result.input.value||xml.md5!==loc.xml.md5||metadata.sha256!==loc.manifestSha256)throw new Error("JATS 快照身份或源清单绑定不一致");
	for(const f of result.artifact.files){if(!f.path.startsWith("jats/"+result.attemptId+"/"))throw new Error("JATS 文件不属于本次尝试");if(f.role==="media"&&!loc.media.some(m=>m.key===loc.sourceVersionId+"/"+f.ref&&m.md5===f.md5))throw new Error("JATS 图片与同版本清单不一致");}
	return result;
}
