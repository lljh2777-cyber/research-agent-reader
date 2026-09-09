import { decodeIdentity, decodePdfSnapshot, type PdfSnapshot } from "../fulltext/contracts";
import { bytesDigest, objectDigest, safeCitekey } from "../papers/identity";
import { validateSourceConfirmation, type SourceConfirmation } from "../papers/confirmation";
import type { SourceStorage } from "./storage";

export const SOURCE_FILES = ["source.pdf","_source/transaction.json","_source/acquisition.json","_source/validation.json","_source/identity-page.png"] as const;
export interface SourceManifest {
	schemaVersion:1;packageKind:"pdf-source";state:"committed";packageKey:string;paperId:string;citekey:string;
	snapshotId:string;requestId:string;createdAt:string;version:PdfSnapshot["candidate"]["version"];sourceVersionId:string;
	identity:PdfSnapshot["identity"];capabilities:{pdf:true;body:false;figures:false};
	files:Array<{path:typeof SOURCE_FILES[number];sha256:string;byteLength:number}>;digest:string;
}
export interface PdfSourcePackage {manifest:SourceManifest;snapshot:PdfSnapshot;confirmation:SourceConfirmation;}
export const packageKeyValid=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(v)&&v.includes("--pdf--");
export function sealManifest(value:Omit<SourceManifest,"digest">):SourceManifest {return {...value,digest:objectDigest(value)};}
export function decodeSourceManifest(value:unknown):SourceManifest {
	const m=value as SourceManifest;if(!m || m.schemaVersion!==1 || m.packageKind!=="pdf-source" || m.state!=="committed" || !packageKeyValid(m.packageKey) || !safeCitekey(m.citekey) || !/^p-[a-f0-9-]{36}$/.test(m.paperId) || !/^r-[a-f0-9-]{36}$/.test(m.requestId) || !/^s-[a-f0-9-]{36}$/.test(m.snapshotId) || !["version_of_record","accepted_manuscript"].includes(m.version) || typeof m.sourceVersionId!=="string" || m.sourceVersionId.length>100 || !Number.isFinite(Date.parse(m.createdAt)) || objectDigest(m.capabilities)!==objectDigest({pdf:true,body:false,figures:false}) || !Array.isArray(m.files) || m.files.length!==SOURCE_FILES.length)throw new Error("原文包清单版本、类型或能力无效");
	if(m.files.some((f,i)=>f.path!==SOURCE_FILES[i] || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.byteLength) || f.byteLength<=0 || f.byteLength>(f.path==="source.pdf"?64*1024*1024:f.path.endsWith(".png")?16*1024*1024:256*1024)))throw new Error("原文包文件清单无效");
	decodeIdentity(m.identity);const {digest,...rest}=m;if(digest!==objectDigest(rest))throw new Error("原文包清单摘要不一致");return structuredClone(m);
}
export const sourceVersion=(snapshot:PdfSnapshot):string=>snapshot.candidate.pmc?.sourceVersionId || snapshot.candidate.oa?.recordSha256 || "";
export const representationDigest=(snapshot:PdfSnapshot):string=>objectDigest({identifiers:snapshot.identity.identifiers,version:snapshot.candidate.version,sourceVersionId:sourceVersion(snapshot),sha256:snapshot.artifact.sha256});

/** Unknown/damaged _source packages never fall through to Markdown/MinerU. */
export async function loadPdfSource(storage:SourceStorage,key:string):Promise<PdfSourcePackage> {
	if(!packageKeyValid(key))throw new Error("原文包路径无效");const root="papers/"+key;
	const raw=await storage.read(root+"/_source/manifest.json");if(!raw)throw new Error("原文包尚未提交");
	const manifest=decodeSourceManifest(JSON.parse(Buffer.from(raw).toString("utf8")));if(manifest.packageKey!==key)throw new Error("原文包目录绑定不一致");
	const values=new Map<string,Uint8Array>();
	for(const file of manifest.files){const bytes=await storage.read(root+"/"+file.path,file.byteLength);if(!bytes || bytes.length!==file.byteLength || bytesDigest(bytes)!==file.sha256)throw new Error("原文包文件缺失或已修改："+file.path);values.set(file.path,bytes);}
	const expected=new Set(["source.pdf","_source"]);for(const e of await storage.list(root))if(!expected.has(e.name))throw new Error("原文包包含未登记文件");
	const inner=new Set(SOURCE_FILES.filter(f=>f.startsWith("_source/")).map(f=>f.slice(8)).concat("manifest.json"));for(const e of await storage.list(root+"/_source"))if(!inner.has(e.name)||e.directory)throw new Error("原文包包含未登记资源");
	const json=(name:string)=>JSON.parse(Buffer.from(values.get(name)!).toString("utf8"));
	const snapshot=decodePdfSnapshot(json("_source/acquisition.json")),validation=json("_source/validation.json"),transaction=json("_source/transaction.json");
	validateSourceConfirmation(validation.confirmation,manifest.requestId,snapshot);
	if(snapshot.id!==manifest.snapshotId || objectDigest(snapshot.identity)!==objectDigest(manifest.identity) || manifest.version!==snapshot.candidate.version || manifest.sourceVersionId!==sourceVersion(snapshot) || snapshot.artifact.sha256!==manifest.files[0].sha256 || snapshot.artifact.byteLength!==manifest.files[0].byteLength || validation.confirmation.evidence.pngSha256!==manifest.files[manifest.files.length-1].sha256 || objectDigest(validation.validation)!==objectDigest(snapshot.validation) || transaction.requestId!==manifest.requestId || transaction.packageKey!==key || transaction.paperId!==manifest.paperId || transaction.citekey!==manifest.citekey || transaction.snapshotId!==snapshot.id)throw new Error("原文包身份、确认、事务或文件绑定不一致");
	return {manifest,snapshot,confirmation:validation.confirmation};
}
