import { createHash } from "node:crypto";
import { decodeCandidates, decodePmcLocator, parseAcquisitionInput, type AcquisitionCandidate, type AcquisitionRequest, type ResolvedIdentity } from "./contracts";
import { canonicalTitle, metadataJson, object } from "./identity-resolver";
import { SourceError } from "./errors";
import type { SourceTransport } from "./transport";

const BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com/";
export function pmcVersions(text: string, pmcid: string): string[] {
	if (!/^PMC[1-9]\d{0,11}$/.test(pmcid) || /<!|&/.test(text) || !/<ListBucketResult(?:\s|>)/.test(text) || !/<Name>pmc-oa-opendata<\/Name>/.test(text) || !text.includes(`<Prefix>${pmcid}.</Prefix>`) || !/<IsTruncated>false<\/IsTruncated>/.test(text)) throw new SourceError("version_list", "PMC 版本列表无效或超过本次查询范围");
	const prefixes = [...text.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)].map(m => m[1]);
	if (prefixes.length !== (text.match(/<CommonPrefixes>/g) || []).length || prefixes.length > 10 || new Set(prefixes).size !== prefixes.length || prefixes.some(v => !(new RegExp(`^${pmcid}\\.[1-9]\\d{0,5}/$`)).test(v))) throw new SourceError("version_list", "PMC 版本前缀无效或超过十个版本");
	return prefixes.map(v => v.slice(0,-1));
}
const flag = (value: unknown): boolean | undefined => value === true || value === "yes" ? true : value === false || value === "no" ? false : undefined;
export function pmcCandidate(json: unknown, bytes: Uint8Array, version: string, identity: ResolvedIdentity, request: AcquisitionRequest): AcquisitionCandidate | undefined {
	const r = object(json), pmcid = identity.identifiers.pmcid;
	if (!pmcid || r.pmcid !== pmcid || `${r.pmcid}.${r.version}` !== version) throw new SourceError("pmc_identity", "PMC 清单的论文或版本标识不一致", "conflict");
	for (const kind of ["doi", "pmid"] as const) if (r[kind] && identity.identifiers[kind]) {
		const observed = parseAcquisitionInput((kind === "doi" ? "" : "PMID:") + r[kind]);
		if (observed.kind !== kind || observed.value !== identity.identifiers[kind]) throw new SourceError("pmc_identity", "PMC 清单与已解析论文的标识冲突", "conflict");
	}
	if (typeof r.title !== "string" || !r.title.trim()) throw new SourceError("pmc_metadata", "PMC 清单缺少论文标题");
	// Exact punctuation-normalized titles are strong supporting evidence, not a substitute for identifiers.
	if (!r.doi && !r.pmid && canonicalTitle(r.title) !== canonicalTitle(identity.title)) throw new SourceError("pmc_identity", "PMC 缺少交叉标识且标题不一致", "conflict");
	const manuscript = flag(r.is_manuscript), openAccess = flag(r.is_pmc_openaccess);
	if (manuscript === undefined || (request.versionPolicy === "record_only" && manuscript) || (!openAccess && !manuscript) || typeof r.pdf_url !== "string" || !r.pdf_url) return undefined;
	const url = new URL(r.pdf_url);
	if (url.protocol !== "s3:" || url.hostname !== "pmc-oa-opendata" || url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some(k => k !== "md5") || url.searchParams.getAll("md5").length !== 1) throw new SourceError("pmc_locator", "PMC PDF 文件清单地址无效");
	const locator = decodePmcLocator({ pmcid, sourceVersionId: version, pdfKey: url.pathname.slice(1), md5: url.searchParams.get("md5"), manifestSha256: createHash("sha256").update(bytes).digest("hex"), license: typeof r.license_code === "string" ? r.license_code : "未提供", retracted: flag(r.is_retracted) === true, observedAt: new Date().toISOString() });
	return decodeCandidates([{ id: "c-pmc-" + createHash("sha256").update(version + ":" + locator.md5).digest("hex").slice(0,24), title: r.title, providerId: "pmc-cloud", version: manuscript ? "accepted_manuscript" : "version_of_record", pmc: locator }])[0];
}
export class PmcProvider {
	constructor(private transport: SourceTransport) {}
	async discover(request: AcquisitionRequest, identity: ResolvedIdentity, signal: AbortSignal): Promise<AcquisitionCandidate[]> {
		const pmcid = identity.identifiers.pmcid;
		if (!pmcid) throw new SourceError("no_pmc", "已找到论文元数据，但没有 PMC 标识；当前来源范围仅包含 PMC PDF", "no_match");
		if (identity.publicationTypes.some(t => /preprint|posted-content/i.test(t))) throw new SourceError("unsupported_version", "此记录是预印本，本阶段仅支持出版版本或明确选择的接受稿", "no_match");
		const listing = await this.transport.metadata(BUCKET + "?" + new URLSearchParams({ "list-type": "2", prefix: pmcid + ".", delimiter: "/", "max-keys": "11" }), signal);
		if (listing.status !== 200) throw new SourceError("http_" + listing.status, `PMC 版本查询返回 HTTP ${listing.status}`);
		const versions = pmcVersions(new TextDecoder("utf-8", { fatal: true }).decode(listing.bytes), pmcid);
		const candidates: AcquisitionCandidate[] = [];
		// Transport globally limits metadata concurrency to two; chunks avoid a large queued fan-out.
		for (let offset = 0; offset < versions.length; offset += 2) {
			const found = await Promise.all(versions.slice(offset, offset + 2).map(async version => {
				const response = await this.transport.metadata(BUCKET + "metadata/" + version + ".json", signal);
				if (response.status === 404) return undefined;
				return pmcCandidate(metadataJson(response), response.bytes, version, identity, request);
			}));
			candidates.push(...found.filter((candidate): candidate is AcquisitionCandidate => !!candidate));
		}
		if (!candidates.length) throw new SourceError("no_pdf", "本次 PMC 版本清单中没有符合所选版本策略的 PDF。可能仅有 XML 或该文件未提供；可在官方页面查看或使用已有本地 PDF", "no_match");
		return candidates.sort((a,b) => Number(a.version === "accepted_manuscript") - Number(b.version === "accepted_manuscript"));
	}
	async refresh(candidate: AcquisitionCandidate, identity: ResolvedIdentity, request: AcquisitionRequest, signal: AbortSignal): Promise<string> {
		const locator = candidate.pmc!;
		const response = await this.transport.metadata(BUCKET + "metadata/" + locator.sourceVersionId + ".json", signal);
		const current = pmcCandidate(metadataJson(response), response.bytes, locator.sourceVersionId, identity, request);
		if (!current || current.id !== candidate.id || current.pmc!.manifestSha256 !== locator.manifestSha256 || current.pmc!.pdfKey !== locator.pdfKey || current.version !== candidate.version) throw new SourceError("manifest_changed", "PMC 版本清单已变化，请重试并重新核对候选");
		return BUCKET + locator.pdfKey;
	}
}
