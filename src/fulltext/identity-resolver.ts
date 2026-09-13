import { decodeIdentity, parseAcquisitionInput, type AcquisitionInput, type ResolvedIdentity } from "./contracts";
import { SourceError } from "./errors";
import type { SourceTransport, ByteResponse } from "./transport";
import { parseBoundedJson } from "../mineru/resource-limits";

export const object = (value: unknown): Record<string, any> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SourceError("invalid_metadata", "来源元数据格式无效"); return value as Record<string, any>;
};
export function metadataJson(response: ByteResponse): Record<string, any> {
	if (response.status !== 200) throw new SourceError("http_" + response.status, `元数据来源返回 HTTP ${response.status}`);
	return object(parseBoundedJson(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes), "来源元数据"));
}
export function canonicalTitle(title: string): string { return title.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
function observedId(kind: AcquisitionInput["kind"], value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	try { const id = parseAcquisitionInput((kind === "doi" ? "" : kind + ":") + String(value)); if (id.kind === kind) return id.value; } catch { /* Fail on non-empty malformed bibliographic IDs. */ }
	throw new SourceError("invalid_identifier", "来源返回了无效论文标识");
}
export function europeIdentity(json: unknown, input: AcquisitionInput): ResolvedIdentity | undefined {
	const root = object(json), results = root.resultList?.result;
	if (!Array.isArray(results) || !Number.isSafeInteger(root.hitCount) || root.hitCount < 0) throw new SourceError("invalid_metadata", "Europe PMC 返回格式无效");
	if (root.hitCount === 0 && !results.length) return undefined;
	if (root.hitCount > 5 || results.length > 5) throw new SourceError("ambiguous_identity", "精确标识返回多个记录，需要核对", "conflict");
	const matches = results.map(raw => {
		const r = object(raw); return { r, identifiers: { doi: observedId("doi", r.doi), pmid: observedId("pmid", r.pmid || (r.source === "MED" ? r.id : undefined)), pmcid: observedId("pmcid", r.pmcid) } };
	}).filter(({identifiers}) => identifiers[input.kind] === input.value);
	if (matches.length !== 1) throw new SourceError("identity_mismatch", "Europe PMC 记录与输入标识不唯一或不匹配", "conflict");
	const {r, identifiers} = matches[0];
	return decodeIdentity({ title: r.title, authors: (r.authorList?.author || []).map((a: Record<string, unknown>) => String(a.fullName || [a.firstName, a.lastName].filter(Boolean).join(" "))), year: r.pubYear || "", identifiers,
		publicationTypes: r.pubTypeList?.pubType || [], warnings: [], evidence: [{ provider: "europe-pmc", recordId: String(r.source) + ":" + String(r.id), observedAt: new Date().toISOString(), fields: ["identifiers", "title", "authors", "year", "publicationTypes"] }] });
}
/** Uses the same exact Crossref works endpoint as the existing intake tool, without its abbreviated author display. */
export function crossrefIdentity(json: unknown, doi: string): ResolvedIdentity {
	const r = object(object(json).message), returned = observedId("doi", r.DOI);
	if (returned !== doi) throw new SourceError("crossref_mismatch", "Crossref 返回的 DOI 与请求不匹配", "conflict");
	return decodeIdentity({ title: r.title?.[0], authors: (r.author || []).map((a: Record<string, unknown>) => String(a.name || [a.given, a.family].filter(Boolean).join(" "))), year: String(r.issued?.["date-parts"]?.[0]?.[0] || ""), identifiers: { doi }, publicationTypes: r.type ? [String(r.type)] : [], warnings: [],
		evidence: [{ provider: "crossref", recordId: doi, observedAt: new Date().toISOString(), fields: ["identifiers", "title", "authors", "year", "publicationTypes"] }] });
}
export class IdentityResolver {
	constructor(private transport: SourceTransport) {}
	async resolve(input: AcquisitionInput, signal: AbortSignal): Promise<ResolvedIdentity> {
		const query = input.kind === "pmid" ? `EXT_ID:${input.value} AND SRC:MED` : input.kind === "pmcid" ? `PMCID:${input.value}` : `DOI:"${input.value.replace(/([\\"])/g, "\\$1")}"`;
		const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search"); url.search = new URLSearchParams({ query, format: "json", resultType: "core", pageSize: "5" }).toString();
		let identity = europeIdentity(metadataJson(await this.transport.metadata(url.href, signal)), input);
		const doi = identity?.identifiers.doi || (input.kind === "doi" ? input.value : undefined);
		if (doi) {
			try {
				const response = await this.transport.metadata("https://api.crossref.org/works/" + encodeURIComponent(doi), signal);
				if (response.status === 404) { if (identity) identity.warnings.push("Crossref 未收录此 DOI；保留 Europe PMC 的精确记录依据"); }
				else {
					const crossref = crossrefIdentity(metadataJson(response), doi);
					if (identity && canonicalTitle(identity.title) !== canonicalTitle(crossref.title)) identity.warnings.push("Europe PMC 与 Crossref 的标题存在差异，预览时请核对原文标题");
					if (!identity) identity = crossref;
					else { identity.evidence.push(...crossref.evidence); if (!identity.authors.length) identity.authors = crossref.authors; }
				}
			} catch (error) {
				signal.throwIfAborted(); if (!identity || (error instanceof SourceError && error.outcome === "conflict")) throw error;
				identity.warnings.push("Crossref 本次查询未完成；使用 Europe PMC 精确记录，未将两个接口计为独立身份验证");
			}
		}
		if (!identity) throw new SourceError("identity_not_found", "在本次查询的 Europe PMC/Crossref 范围内未找到精确论文记录", "no_match");
		return decodeIdentity(identity);
	}
}
