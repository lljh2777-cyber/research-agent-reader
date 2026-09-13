import { createHash } from "node:crypto";
import { decodeCandidates, parseAcquisitionInput, type AcquisitionCandidate, type AcquisitionRequest, type ResolvedIdentity } from "./contracts";
import { metadataJson, object } from "./identity-resolver";
import { SourceError } from "./errors";
import { contactEmail, oaUrl } from "./url-policy";
import type { SourceTransport } from "./transport";

export interface UnpaywallConfig { enabled: boolean; email: string; }
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
/** URLs exist only during discovery/refresh; persistent provenance uses an origin and digests. */
export function unpaywallLocations(json: unknown, bytes: Uint8Array, identity: ResolvedIdentity, request: AcquisitionRequest): Array<{candidate: AcquisitionCandidate; url: string}> {
	const r=object(json), doi=identity.identifiers.doi;
	if (!doi || typeof r.doi!=="string" || parseAcquisitionInput(r.doi).value!==doi) throw new SourceError("unpaywall_identity", "Unpaywall 返回的 DOI 与论文不一致", "conflict");
	if (!Array.isArray(r.oa_locations) || r.oa_locations.length>100) throw new SourceError("unpaywall_locations", "开放来源列表无效或超过 100 个位置");
	const found = new Map<string,{candidate:AcquisitionCandidate;url:string}>();
	for(const raw of r.oa_locations) {
		const location=object(raw);
		const version=location.version==="publishedVersion"?"version_of_record":location.version==="acceptedVersion"?"accepted_manuscript":undefined;
		if(!version || (version==="accepted_manuscript" && request.versionPolicy==="record_only") || !["publisher","repository"].includes(location.host_type) || typeof location.url_for_pdf!=="string" || !location.url_for_pdf) continue;
		let url:URL;try{url=oaUrl(location.url_for_pdf);}catch{continue;}
		const urlSha256=hash(url.href), id="c-oa-"+hash(urlSha256+":"+version).slice(0,24);
		if(found.has(id))continue;
		const candidate=decodeCandidates([{id,title:identity.title,providerId:"unpaywall",version,oa:{doi,origin:url.origin,urlSha256,recordSha256:hash(bytes),license:typeof location.license==="string"?location.license:"未提供（请核对使用范围）",hostType:location.host_type,observedAt:new Date().toISOString()}}])[0];
		found.set(id,{candidate,url:url.href});
	}
	if(found.size>20) throw new SourceError("candidate_limit", "符合策略的开放 PDF 超过 20 个，请缩小版本范围");
	return [...found.values()].sort((a,b)=>Number(a.candidate.version==="accepted_manuscript")-Number(b.candidate.version==="accepted_manuscript") || Number(a.candidate.oa!.hostType==="repository")-Number(b.candidate.oa!.hostType==="repository"));
}
export class UnpaywallProvider {
	constructor(private transport:SourceTransport, private config:()=>UnpaywallConfig){}
	private async lookup(identity:ResolvedIdentity,request:AcquisitionRequest,signal:AbortSignal) {
		const config=this.config();
		if(!request.useUnpaywall || !config.enabled)throw new SourceError("unpaywall_disabled","PMC 未提供可用 PDF；Unpaywall 回退未启用", "needs_configuration");
		const email=contactEmail(config.email), doi=identity.identifiers.doi;
		if(!doi)throw new SourceError("unpaywall_no_doi","论文没有 DOI，无法查询 Unpaywall", "no_match");
		const url=new URL("https://api.unpaywall.org/v2/"+encodeURIComponent(doi));url.searchParams.set("email",email);
		const response=await this.transport.metadata(url.href,signal);
		if(response.status===404)throw new SourceError("unpaywall_miss","Unpaywall 未收录此 DOI", "no_match");
		return unpaywallLocations(metadataJson(response),response.bytes,identity,request);
	}
	async discover(identity:ResolvedIdentity,request:AcquisitionRequest,signal:AbortSignal):Promise<AcquisitionCandidate[]> {
		const locations=await this.lookup(identity,request,signal);
		if(!locations.length)throw new SourceError("unpaywall_no_pdf","Unpaywall 本次没有符合稿件类型与 HTTPS 策略的直接 PDF；落地页、签名地址和预印本未作为候选", "no_match");
		return locations.map(x=>x.candidate);
	}
	async refresh(candidate:AcquisitionCandidate,identity:ResolvedIdentity,request:AcquisitionRequest,signal:AbortSignal):Promise<string> {
		const found=(await this.lookup(identity,request,signal)).find(x=>x.candidate.id===candidate.id);
		if(!found || found.candidate.oa!.recordSha256!==candidate.oa!.recordSha256 || found.candidate.version!==candidate.version)throw new SourceError("manifest_changed","开放来源位置或版本已变化，请重新查询候选");
		return found.url;
	}
}
