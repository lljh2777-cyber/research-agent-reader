import { bytesDigest,objectDigest,safeCitekey,canonicalJson } from "../papers/identity";
import { decodeIdentity,type ResolvedIdentity } from "../fulltext/contracts";
import { decodeJatsSnapshot,type JatsSnapshot } from "../jats/contracts";
import { projectJats,graphicReferences,type JatsProjection } from "../jats/projection";
import { jatsConverter } from "../jats/converter-version";
import { assetFor } from "../jats/media";
import { validateJatsProjection } from "../jats/validation";
import { validateJatsConfirmation,type JatsConfirmation } from "../jats/confirmation";
import type { SourceStorage } from "./storage";

export interface JatsManifest {schemaVersion:1;packageKind:"jats-source";state:"committed";packageKey:string;paperId:string;citekey:string;snapshotId:string;requestId:string;createdAt:string;version:"version_of_record"|"accepted_manuscript";sourceVersionId:string;identity:ResolvedIdentity;projectionId:string;converter:string;capabilities:{pdf:false;body:true;figures:boolean};files:Array<{path:string;sha256:string;byteLength:number}>;digest:string;}
export const jatsKey=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(v)&&v.includes("--jats--");
const fixed=["article.md","_source/transaction.json","_source/article.xml","_source/source-map.json","_source/acquisition.json","_source/metadata.json","_source/validation.json"];
const filePath=(p:string)=>fixed.includes(p)||/^images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(p)||/^_source\/original-assets\/m\d+\.[a-z0-9]{1,8}$/.test(p);
export function decodeJatsManifest(value:unknown):JatsManifest {
	const m=value as JatsManifest;
	if(!m||m.schemaVersion!==1||m.packageKind!=="jats-source"||m.state!=="committed"||!jatsKey(m.packageKey)||!safeCitekey(m.citekey)||!/^p-[a-f0-9-]{36}$/.test(m.paperId)||!/^r-[a-f0-9-]{36}$/.test(m.requestId)||!/^s-[a-f0-9-]{36}$/.test(m.snapshotId)||!Number.isFinite(Date.parse(m.createdAt))||!["version_of_record","accepted_manuscript"].includes(m.version)||!/^PMC[1-9]\d{0,11}\.[1-9]\d{0,5}$/.test(m.sourceVersionId)||typeof m.converter!=="string"||jatsConverter(m.converter)!==m.converter||!/^[a-f0-9]{64}$/.test(m.projectionId)||m.capabilities?.pdf!==false||m.capabilities.body!==true||typeof m.capabilities.figures!=="boolean"||!Array.isArray(m.files)||m.files.length>135)throw new Error("JATS 原文包清单无效或版本不支持");
	decodeIdentity(m.identity);const {digest,...rest}=m;if(digest!==objectDigest(rest)||new Set(m.files.map(f=>f.path)).size!==m.files.length||fixed.some(p=>!m.files.some(f=>f.path===p)))throw new Error("JATS 清单摘要或文件集不一致");
	for(const f of m.files)if(typeof f.path!=="string"||!filePath(f.path)||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.byteLength)||f.byteLength<=0||f.byteLength>16*1024*1024)throw new Error("JATS 清单文件路径或大小无效");
	if(m.files.reduce((n,f)=>n+f.byteLength,0)>128*1024*1024)throw new Error("JATS 包总量超过 128 MiB");return structuredClone(m);
}
export function sourcePayloads(snapshot:JatsSnapshot,content:Map<string,Uint8Array>,projection:JatsProjection,confirmation:JatsConfirmation,transaction:unknown):Map<string,Uint8Array> {
	const encode=(v:unknown)=>Buffer.from(canonicalJson(v),"utf8"),files=new Map<string,Uint8Array>([["article.md",Buffer.from(projection.markdown,"utf8")],["_source/article.xml",content.get("article.xml")!],["_source/metadata.json",content.get("metadata.json")!],["_source/acquisition.json",encode(snapshot)],["_source/source-map.json",encode(projection)],["_source/validation.json",encode({confirmation,validation:snapshot.validation})],["_source/transaction.json",encode(transaction)]]);
	for(const f of snapshot.artifact.files.filter(f=>f.role==="media")){const bytes=content.get(f.ref)!;files.set("_source/original-assets/"+f.path.split("/").pop()!,bytes);const a=assetFor(f.ref,bytes);if(a.path)files.set(a.path,bytes);}
	return files;
}
async function readJatsFiles(storage:SourceStorage,key:string,expected?:JatsManifest) {
	if(!jatsKey(key))throw new Error("JATS 包目录无效");const root="papers/"+key,raw=await storage.read(root+"/_source/manifest.json");if(!raw)throw new Error("JATS 原文包尚未提交");
	const manifest=decodeJatsManifest(JSON.parse(Buffer.from(raw).toString("utf8")));if(manifest.packageKey!==key)throw new Error("JATS 清单与目录不一致");const files=new Map<string,Uint8Array>();
	if(expected&&manifest.digest!==expected.digest)throw new Error("JATS 原文版本已变化，请重新核对来源");
	for(const f of manifest.files){const bytes=await storage.read(root+"/"+f.path,f.byteLength);if(!bytes||bytes.length!==f.byteLength||bytesDigest(bytes)!==f.sha256)throw new Error("JATS 原文文件缺失或已修改："+f.path);files.set(f.path,bytes);}
	const dirs=["","_source","_source/original-assets","images"],allowed=new Set([...manifest.files.map(f=>f.path),"_source/manifest.json",...dirs.filter(Boolean)]);
	for(const d of dirs)for(const e of await storage.list(root+(d?"/"+d:""))){const p=(d?d+"/":"")+e.name;if(!allowed.has(p)||e.directory!==dirs.includes(p))throw new Error("JATS 包包含未登记资源");}
	return {manifest,files};
}
/** Only for a package already fully loaded and validated. Recheck every byte and directory;
 * identical immutable bytes need no repeated XML parsing or projection construction. */
export async function verifyLoadedJatsSource(storage:SourceStorage,expected:JatsManifest):Promise<void> {
	await readJatsFiles(storage,expected.packageKey,expected);
}
export async function loadJatsSource(storage:SourceStorage,key:string) {
	const {manifest,files}=await readJatsFiles(storage,key);
	const json=(p:string)=>JSON.parse(Buffer.from(files.get(p)!).toString("utf8")),snapshot=decodeJatsSnapshot(json("_source/acquisition.json")),validation=json("_source/validation.json"),transaction=json("_source/transaction.json"),xml=files.get("_source/article.xml")!;
	validateJatsConfirmation(validation.confirmation,manifest.requestId,snapshot,xml);
	const content=new Map<string,Uint8Array>([["article.xml",xml],["metadata.json",files.get("_source/metadata.json")!]]);
	for(const f of snapshot.artifact.files){const bytes=f.role==="media"?files.get("_source/original-assets/"+f.path.split("/").pop()!):content.get(f.ref);if(!bytes||bytes.length!==f.byteLength||bytesDigest(bytes)!==f.sha256)throw new Error("JATS 正式包与获取快照字节不一致");content.set(f.ref,bytes);}
	if(jatsConverter(snapshot.artifact.converter)!==manifest.converter)throw new Error("JATS 获取与原文包转换器版本不一致");
	const assets=graphicReferences(xml,manifest.converter).map(ref=>content.has(ref)?assetFor(ref,content.get(ref)!):{ref,issue:snapshot.artifact.includeFigures?"同版本图片缺失："+ref:"本次未请求图片："+ref}),projection=projectJats(xml,snapshot.identity,assets,manifest.converter);
	if(objectDigest(validateJatsProjection(snapshot.artifact,projection))!==objectDigest(snapshot.validation))throw new Error("JATS 正文或图片验证与源文件不一致");
	if(objectDigest(projection)!==objectDigest(json("_source/source-map.json"))||projection.markdown!==Buffer.from(files.get("article.md")!).toString("utf8")||projection.projectionId!==manifest.projectionId||snapshot.id!==manifest.snapshotId||objectDigest(manifest.identity)!==objectDigest(snapshot.identity)||manifest.version!==snapshot.candidate.version||manifest.sourceVersionId!==snapshot.candidate.jats!.sourceVersionId||objectDigest(validation.validation)!==objectDigest(snapshot.validation)||transaction.requestId!==manifest.requestId||transaction.paperId!==manifest.paperId||transaction.citekey!==manifest.citekey||transaction.packageKey!==key||transaction.snapshotId!==snapshot.id||manifest.capabilities.figures!==assets.some(a=>!!a.path))throw new Error("JATS 投影、身份、能力或事务绑定不一致");
	const expected=sourcePayloads(snapshot,content,projection,validation.confirmation,transaction);if(expected.size!==files.size)throw new Error("JATS 固定投影文件集不一致");for(const[p,b]of expected)if(!files.has(p)||bytesDigest(b)!==bytesDigest(files.get(p)!))throw new Error("JATS 投影资源不一致："+p);
	return {manifest,snapshot,projection,files,confirmation:validation.confirmation as JatsConfirmation};
}
