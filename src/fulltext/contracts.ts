import { oaUrl } from "./url-policy";
export type AcquisitionMode = "production" | "demo";
export const ACQUISITION_PHASES = ["queued", "resolving", "discovering", "awaiting_selection", "downloading", "verifying", "acquired", "no_match", "needs_configuration", "conflict", "failed", "cancelled", "interrupted"] as const;
export type AcquisitionPhase = typeof ACQUISITION_PHASES[number];
export type DemoScenario = "success" | "selection" | "failure" | "conflict" | "no_match";
export interface AcquisitionInput { kind: "doi" | "pmid" | "pmcid"; value: string; }
export interface AcquisitionRequest { input: AcquisitionInput; goal: "pdf"; versionPolicy: "record_only" | "record_preferred_allow_manuscript"; scenario?: DemoScenario; useUnpaywall?: boolean; }
export interface ResolvedIdentity {
	title: string; authors: string[]; year: string; identifiers: { doi?: string; pmid?: string; pmcid?: string };
	publicationTypes: string[]; evidence: Array<{ provider: "europe-pmc" | "crossref"; recordId: string; observedAt: string; fields: string[] }>;
	warnings: string[];
}
export interface PmcLocator {
	pmcid: string; sourceVersionId: string; pdfKey: string; md5: string; manifestSha256: string; license: string; retracted: boolean; observedAt: string;
}
export interface OaLocator { doi: string; origin: string; urlSha256: string; recordSha256: string; license: string; hostType: "publisher" | "repository"; observedAt: string; }
export interface AcquisitionCandidate { id: string; title: string; providerId: string; version: "version_of_record" | "accepted_manuscript"; pmc?: PmcLocator; oa?: OaLocator; }
export interface AcquisitionIntakeRef { jobId: string; snapshotId: string; sha256: string; byteLength: number; }
export interface AcquisitionJob {
	schemaVersion: 1; id: string; revision: number; attemptId: string; mode: AcquisitionMode; deviceId: string;
	request: AcquisitionRequest; phase: AcquisitionPhase; createdAt: string; updatedAt: string;
	detail: string; error: string; candidates: AcquisitionCandidate[]; selectedId?: string;
	receivedBytes?: number; totalBytes?: number; snapshotId?: string; storageWarning?: string;
	identity?: ResolvedIdentity; identityCheck?: "verified" | "needs_confirmation"; errorCode?: string;
	intakeRunIds?: string[];
}
/** A demo receipt cannot be read or imported as a real source file. M2 adds real artifact contracts. */
export interface DemoSnapshot { schemaVersion: 1; id: string; jobId: string; attemptId: string; mode: "demo"; simulated: true; input: AcquisitionInput; candidateId: string; createdAt: string; }
export interface PdfArtifact { filename: string; byteLength: number; sha256: string; md5: string; }
export interface PdfValidation { pageCount: number; firstPageText: string; doiCandidates: string[]; identityCheck: "verified" | "needs_confirmation"; bodyCheck: "not_checked"; }
export interface PdfSnapshot {
	schemaVersion: 2; id: string; jobId: string; attemptId: string; mode: "production"; input: AcquisitionInput; candidateId: string; createdAt: string;
	identity: ResolvedIdentity; candidate: AcquisitionCandidate; artifact: PdfArtifact; validation: PdfValidation;
}
export type AcquisitionSnapshot = DemoSnapshot | PdfSnapshot;
export const acquisitionId = (value: unknown): value is string => typeof value === "string" && /^[as]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const acquisitionActive = (phase: AcquisitionPhase): boolean => ["queued", "resolving", "discovering", "awaiting_selection", "downloading", "verifying"].includes(phase);
export const acquisitionRetryable = (phase: AcquisitionPhase): boolean => ["failed", "cancelled", "interrupted", "needs_configuration"].includes(phase);
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("全文获取记录格式无效");
	return value as Record<string, unknown>;
};
function string(value: unknown, max = 500): string { if (typeof value !== "string" || value.length > max || /[\u0000-\u0008]/.test(value)) throw new Error("全文获取字段无效"); return value; }
function date(value: unknown): string { const result = string(value, 40); if (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error("全文获取时间无效"); return result; }
function id(value: unknown): string { if (!acquisitionId(value)) throw new Error("全文获取标识无效"); return value; }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("全文获取计数无效"); return Number(value); }
export function parseAcquisitionInput(raw: string): AcquisitionInput {
	let value = string(raw, 1024).trim().replace(/^<([^<>]+)>$/, "$1");
	if (/^https?:\/\//i.test(value)) {
		const url = new URL(value);
		if (url.username || url.password || url.port) throw new Error("请使用不含认证信息的论文标识链接");
		const host = url.hostname.toLowerCase();
		if (["doi.org", "dx.doi.org"].includes(host)) value = decodeURIComponent(url.pathname.slice(1));
		else if (host === "pubmed.ncbi.nlm.nih.gov" && /^\/\d+\/?$/.test(url.pathname)) value = "PMID:" + url.pathname.replace(/\//g, "");
		else if (host === "pmc.ncbi.nlm.nih.gov" && /^\/articles\/PMC\d+\/?$/i.test(url.pathname)) value = url.pathname.split("/")[2];
		else throw new Error("目前只识别 DOI、PubMed 和 PMC 官方论文链接");
	}
	value = value.replace(/^doi:\s*/i, "").trim();
	if (/^10\.\d{4,9}\/\S+$/i.test(value) && !/[<>\u0000-\u0020]/.test(value)) return { kind: "doi", value: value.toLowerCase() };
	const pmid = /^(?:pmid:\s*)?([1-9]\d{0,11})$/i.exec(value);
	if (pmid) return { kind: "pmid", value: pmid[1] };
	const pmcid = /^(?:pmcid:\s*)?(PMC[1-9]\d{0,11})$/i.exec(value);
	if (pmcid) return { kind: "pmcid", value: pmcid[1].toUpperCase() };
	throw new Error("请输入 DOI、PMID、PMCID 或对应的官方链接");
}
export function decodeInput(value: unknown): AcquisitionInput {
	const r = record(value), kind = string(r.kind), text = string(r.value, 1024);
	const parsed = parseAcquisitionInput((kind === "pmid" ? "PMID:" : kind === "pmcid" ? "PMCID:" : "") + text);
	if (parsed.kind !== kind || parsed.value !== text) throw new Error("论文标识尚未规范化"); return parsed;
}
export function decodeRequest(value: unknown, mode: AcquisitionMode): AcquisitionRequest {
	const r = record(value); if (r.goal !== "pdf" || !["record_only", "record_preferred_allow_manuscript"].includes(String(r.versionPolicy)) || (mode === "demo" && r.versionPolicy !== "record_only")) throw new Error("暂不支持这类获取请求");
	if (r.scenario !== undefined && (mode !== "demo" || !["success", "selection", "failure", "conflict", "no_match"].includes(String(r.scenario)))) throw new Error("演示参数不能用于正式获取");
	if (r.useUnpaywall !== undefined && (mode === "demo" || typeof r.useUnpaywall !== "boolean")) throw new Error("开放来源配置无效");
	return { input: decodeInput(r.input), goal: "pdf", versionPolicy: r.versionPolicy as AcquisitionRequest["versionPolicy"], ...(r.useUnpaywall ? {useUnpaywall:true} : {}), ...(mode === "demo" ? { scenario: (r.scenario || "success") as DemoScenario } : {}) };
}
export function decodeCandidates(value: unknown): AcquisitionCandidate[] {
	if (!Array.isArray(value) || value.length > 20) throw new Error("全文候选过多或格式无效");
	const result = value.map(item => { const r = record(item); const candidate: AcquisitionCandidate = { id: string(r.id, 80), title: string(r.title, 2000), providerId: string(r.providerId, 80), version: r.version as AcquisitionCandidate["version"] };
		if (!/^c-[a-z0-9-]+$/.test(candidate.id) || !candidate.title.trim() || !/^[a-z0-9-]+$/.test(candidate.providerId) || !["version_of_record", "accepted_manuscript"].includes(candidate.version)) throw new Error("全文候选字段无效");
		if (r.pmc !== undefined) candidate.pmc = decodePmcLocator(r.pmc); if (r.oa !== undefined) candidate.oa = decodeOaLocator(r.oa); if (candidate.pmc && candidate.oa) throw new Error("全文候选来源混用"); return candidate; });
	if (new Set(result.map(c => c.id)).size !== result.length) throw new Error("全文候选标识重复"); return result;
}
export function decodeJob(value: unknown, mode: AcquisitionMode): AcquisitionJob {
	const r = record(value);
	if (r.schemaVersion !== 1 || r.mode !== mode || !ACQUISITION_PHASES.includes(r.phase as AcquisitionPhase)) throw new Error("全文获取记录版本或来源无效");
	const job: AcquisitionJob = { schemaVersion: 1, id: id(r.id), revision: count(r.revision), attemptId: id(r.attemptId), mode, deviceId: string(r.deviceId, 100), request: decodeRequest(r.request, mode), phase: r.phase as AcquisitionPhase,
		createdAt: date(r.createdAt), updatedAt: date(r.updatedAt), detail: string(r.detail), error: string(r.error), candidates: decodeCandidates(r.candidates) };
	if (!job.revision || !job.deviceId || job.id[0] !== "a" || job.attemptId[0] !== "a") throw new Error("全文任务身份无效");
	if (r.selectedId !== undefined) { job.selectedId = string(r.selectedId, 80); if (!job.candidates.some(c => c.id === job.selectedId)) throw new Error("所选候选不属于本任务"); }
	if (r.receivedBytes !== undefined) job.receivedBytes = count(r.receivedBytes);
	if (r.totalBytes !== undefined) { job.totalBytes = count(r.totalBytes); if (job.totalBytes === 0 || (job.receivedBytes || 0) > job.totalBytes) throw new Error("下载进度无效"); }
	if (r.snapshotId !== undefined) { job.snapshotId = id(r.snapshotId); if (job.snapshotId[0] !== "s") throw new Error("快照标识无效"); }
	if (job.phase === "acquired" && !job.snapshotId) throw new Error("完成记录缺少快照");
	if (r.storageWarning !== undefined) job.storageWarning = string(r.storageWarning);
	if (r.identity !== undefined) { if (mode !== "production") throw new Error("演示不能携带真实身份"); job.identity = decodeIdentity(r.identity); }
	if (r.identityCheck !== undefined) { if (!["verified", "needs_confirmation"].includes(String(r.identityCheck))) throw new Error("身份校验状态无效"); job.identityCheck = r.identityCheck as AcquisitionJob["identityCheck"]; }
	if (r.errorCode !== undefined) job.errorCode = string(r.errorCode, 80);
	if (r.intakeRunIds !== undefined) { job.intakeRunIds = strings(r.intakeRunIds, 100, 200); if (job.intakeRunIds.some(v=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v)) || new Set(job.intakeRunIds).size !== job.intakeRunIds.length || mode !== "production") throw new Error("入库任务关联无效"); }
	if (mode === "production" && job.candidates.some(c => !(c.providerId === "pmc-cloud" && c.pmc) && !(c.providerId === "unpaywall" && c.oa && job.request.useUnpaywall) || (job.request.versionPolicy === "record_only" && c.version !== "version_of_record"))) throw new Error("正式获取候选与来源策略不一致");
	if (mode === "demo" && job.candidates.some(c => c.providerId !== "demo" || c.pmc || c.oa)) throw new Error("演示候选混入真实来源");
	return job;
}
export function decodeSnapshot(value: unknown): AcquisitionSnapshot {
	if (record(value).schemaVersion === 2) return decodePdfSnapshot(value);
	const r = record(value); if (r.schemaVersion !== 1 || r.mode !== "demo" || r.simulated !== true) throw new Error("M1 仅支持明确标记的模拟快照");
	const result: DemoSnapshot = { schemaVersion: 1, id: id(r.id), jobId: id(r.jobId), attemptId: id(r.attemptId), mode: "demo", simulated: true, input: decodeInput(r.input), candidateId: string(r.candidateId, 80), createdAt: date(r.createdAt) };
	if (result.id[0] !== "s" || result.jobId[0] !== "a" || result.attemptId[0] !== "a" || !/^c-[a-z0-9-]+$/.test(result.candidateId)) throw new Error("快照绑定无效"); return result;
}
export function requestKey(request: AcquisitionRequest): string { return JSON.stringify(request); }

export const PHASE_LABELS: Record<AcquisitionPhase, string> = {
	queued: "等待开始", resolving: "识别论文", discovering: "寻找全文", awaiting_selection: "等待选择来源", downloading: "获取文件", verifying: "校验与保存",
	acquired: "文件已获取", no_match: "未找到合适全文", needs_configuration: "需要配置来源", conflict: "身份存在冲突", failed: "获取未完成", cancelled: "已停止", interrupted: "上次获取已中断",
};

export const PDF_MAX_BYTES = 64 * 1024 * 1024;
function strings(value: unknown, max: number, length: number): string[] { if (!Array.isArray(value) || value.length > max) throw new Error("文献字段列表超限"); return value.map(v => string(v, length)); }
function digest(value: unknown, length: number): string { const text = string(value, length); if (!(new RegExp(`^[a-f0-9]{${length}}$`)).test(text)) throw new Error("文件校验值无效"); return text; }
export function decodeIdentity(value: unknown): ResolvedIdentity {
	const r = record(value), rawIds = record(r.identifiers), identifiers: ResolvedIdentity["identifiers"] = {};
	for (const kind of ["doi", "pmid", "pmcid"] as const) if (rawIds[kind] !== undefined) identifiers[kind] = decodeInput({ kind, value: rawIds[kind] }).value;
	if (!Object.keys(identifiers).length) throw new Error("缺少精确文献标识");
	if (!Array.isArray(r.evidence) || !r.evidence.length || r.evidence.length > 10) throw new Error("缺少可追溯身份依据");
	const evidence = r.evidence.map(value => { const e = record(value); if (!["europe-pmc", "crossref"].includes(String(e.provider))) throw new Error("身份依据来源无效"); return { provider: e.provider as "europe-pmc" | "crossref", recordId: string(e.recordId, 1024), observedAt: date(e.observedAt), fields: strings(e.fields, 10, 40) }; });
	const title = string(r.title, 2000); if (!title.trim()) throw new Error("缺少论文标题");
	const year = string(r.year, 4); if (year && !/^\d{4}$/.test(year)) throw new Error("年份格式无效");
	return { title, authors: strings(r.authors, 500, 300), year, identifiers, publicationTypes: strings(r.publicationTypes, 30, 100), evidence, warnings: strings(r.warnings, 10, 300) };
}
export function decodePmcLocator(value: unknown): PmcLocator {
	const r = record(value), pmcid = decodeInput({ kind: "pmcid", value: r.pmcid }).value, sourceVersionId = string(r.sourceVersionId, 40), pdfKey = string(r.pdfKey, 220);
	if (!(new RegExp(`^${pmcid}\\.[1-9]\\d{0,5}$`)).test(sourceVersionId) || !pdfKey.startsWith(sourceVersionId + "/") || !/^[A-Za-z0-9._-]+\.pdf$/i.test(pdfKey.slice(sourceVersionId.length + 1))) throw new Error("PDF 不属于所选 PMC 版本");
	if (typeof r.retracted !== "boolean") throw new Error("版本状态无效");
	return { pmcid, sourceVersionId, pdfKey, md5: digest(r.md5, 32), manifestSha256: digest(r.manifestSha256, 64), license: string(r.license, 100), retracted: r.retracted, observedAt: date(r.observedAt) };
}
export function decodeArtifact(value: unknown): PdfArtifact {
	const r = record(value), filename = string(r.filename, 50), byteLength = count(r.byteLength);
	if (!filename.endsWith(".pdf") || !acquisitionId(filename.slice(0, -4)) || filename[0] !== "a" || byteLength < 16 || byteLength > PDF_MAX_BYTES) throw new Error("PDF 快照文件无效或超限");
	return { filename, byteLength, sha256: digest(r.sha256, 64), md5: digest(r.md5, 32) };
}
export function decodePdfValidation(value: unknown): PdfValidation {
	const r = record(value), pageCount = count(r.pageCount);
	if (!pageCount || pageCount > 2048 || !["verified", "needs_confirmation"].includes(String(r.identityCheck)) || r.bodyCheck !== "not_checked") throw new Error("PDF 验证记录无效");
	return { pageCount, firstPageText: string(r.firstPageText, 8000), doiCandidates: strings(r.doiCandidates, 30, 1024), identityCheck: r.identityCheck as PdfValidation["identityCheck"], bodyCheck: "not_checked" };
}
export function decodePdfSnapshot(value: unknown): PdfSnapshot {
	const r = record(value); if (r.schemaVersion !== 2 || r.mode !== "production" || r.simulated !== undefined) throw new Error("真实快照格式无效");
	const result: PdfSnapshot = { schemaVersion: 2, id: id(r.id), jobId: id(r.jobId), attemptId: id(r.attemptId), mode: "production", input: decodeInput(r.input), candidateId: string(r.candidateId, 80), createdAt: date(r.createdAt), identity: decodeIdentity(r.identity), candidate: decodeCandidates([r.candidate])[0], artifact: decodeArtifact(r.artifact), validation: decodePdfValidation(r.validation) };
	const sourceMatches = result.candidate.providerId === "pmc-cloud" && result.candidate.pmc && result.identity.identifiers.pmcid === result.candidate.pmc.pmcid && result.artifact.md5 === result.candidate.pmc.md5
		|| result.candidate.providerId === "unpaywall" && result.candidate.oa && result.identity.identifiers.doi === result.candidate.oa.doi;
	if (result.id[0] !== "s" || result.jobId[0] !== "a" || result.attemptId[0] !== "a" || result.artifact.filename !== result.attemptId + ".pdf" || result.candidateId !== result.candidate.id || !sourceMatches || result.identity.identifiers[result.input.kind] !== result.input.value) throw new Error("真实快照与任务/身份/文件不匹配");
	return result;
}

export function decodeOaLocator(value: unknown): OaLocator {
	const r=record(value), origin=string(r.origin,300), url=oaUrl(origin);
	if (url.origin !== origin || !["publisher","repository"].includes(String(r.hostType))) throw new Error("开放来源定位无效");
	return {doi:decodeInput({kind:"doi",value:r.doi}).value,origin,urlSha256:digest(r.urlSha256,64),recordSha256:digest(r.recordSha256,64),license:string(r.license,300),hostType:r.hostType as OaLocator["hostType"],observedAt:date(r.observedAt)};
}
export function decodeIntakeRef(value: unknown): AcquisitionIntakeRef {
	const r=record(value), jobId=id(r.jobId), snapshotId=id(r.snapshotId), byteLength=count(r.byteLength);
	if(jobId[0]!=="a" || snapshotId[0]!=="s" || byteLength<16 || byteLength>PDF_MAX_BYTES) throw new Error("入库来源绑定无效");
	return {jobId,snapshotId,byteLength,sha256:digest(r.sha256,64)};
}
