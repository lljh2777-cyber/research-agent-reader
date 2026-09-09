export type AcquisitionMode = "production" | "demo";
export const ACQUISITION_PHASES = ["queued", "resolving", "discovering", "awaiting_selection", "downloading", "verifying", "acquired", "no_match", "needs_configuration", "conflict", "failed", "cancelled", "interrupted"] as const;
export type AcquisitionPhase = typeof ACQUISITION_PHASES[number];
export type DemoScenario = "success" | "selection" | "failure" | "conflict" | "no_match";
export interface AcquisitionInput { kind: "doi" | "pmid" | "pmcid"; value: string; }
export interface AcquisitionRequest { input: AcquisitionInput; goal: "pdf"; versionPolicy: "record_only"; scenario?: DemoScenario; }
export interface AcquisitionCandidate { id: string; title: string; providerId: string; version: "version_of_record"; }
export interface AcquisitionJob {
	schemaVersion: 1; id: string; revision: number; attemptId: string; mode: AcquisitionMode; deviceId: string;
	request: AcquisitionRequest; phase: AcquisitionPhase; createdAt: string; updatedAt: string;
	detail: string; error: string; candidates: AcquisitionCandidate[]; selectedId?: string;
	receivedBytes?: number; totalBytes?: number; snapshotId?: string; storageWarning?: string;
}
/** A demo receipt cannot be read or imported as a real source file. M2 adds real artifact contracts. */
export interface AcquisitionSnapshot { schemaVersion: 1; id: string; jobId: string; attemptId: string; mode: "demo"; simulated: true; input: AcquisitionInput; candidateId: string; createdAt: string; }
export const acquisitionId = (value: unknown): value is string => typeof value === "string" && /^[as]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const acquisitionActive = (phase: AcquisitionPhase): boolean => ["queued", "resolving", "discovering", "awaiting_selection", "downloading", "verifying"].includes(phase);
export const acquisitionRetryable = (phase: AcquisitionPhase): boolean => ["failed", "cancelled", "interrupted"].includes(phase);
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
	const r = record(value); if (r.goal !== "pdf" || r.versionPolicy !== "record_only") throw new Error("暂不支持这类获取请求");
	if (r.scenario !== undefined && (mode !== "demo" || !["success", "selection", "failure", "conflict", "no_match"].includes(String(r.scenario)))) throw new Error("演示参数不能用于正式获取");
	return { input: decodeInput(r.input), goal: "pdf", versionPolicy: "record_only", ...(mode === "demo" ? { scenario: (r.scenario || "success") as DemoScenario } : {}) };
}
export function decodeCandidates(value: unknown): AcquisitionCandidate[] {
	if (!Array.isArray(value) || value.length > 20) throw new Error("全文候选过多或格式无效");
	const result = value.map(item => { const r = record(item); const candidate = { id: string(r.id, 80), title: string(r.title), providerId: string(r.providerId, 80), version: "version_of_record" as const };
		if (!/^c-[a-z0-9-]+$/.test(candidate.id) || !candidate.title.trim() || !/^[a-z0-9-]+$/.test(candidate.providerId) || r.version !== candidate.version) throw new Error("全文候选字段无效"); return candidate; });
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
	return job;
}
export function decodeSnapshot(value: unknown): AcquisitionSnapshot {
	const r = record(value); if (r.schemaVersion !== 1 || r.mode !== "demo" || r.simulated !== true) throw new Error("M1 仅支持明确标记的模拟快照");
	const result: AcquisitionSnapshot = { schemaVersion: 1, id: id(r.id), jobId: id(r.jobId), attemptId: id(r.attemptId), mode: "demo", simulated: true, input: decodeInput(r.input), candidateId: string(r.candidateId, 80), createdAt: date(r.createdAt) };
	if (result.id[0] !== "s" || result.jobId[0] !== "a" || result.attemptId[0] !== "a" || !/^c-[a-z0-9-]+$/.test(result.candidateId)) throw new Error("快照绑定无效"); return result;
}
export function requestKey(request: AcquisitionRequest): string { return JSON.stringify(request); }

export const PHASE_LABELS: Record<AcquisitionPhase, string> = {
	queued: "等待开始", resolving: "识别论文", discovering: "寻找全文", awaiting_selection: "等待选择来源", downloading: "获取文件", verifying: "校验与保存",
	acquired: "文件已获取", no_match: "未找到合适全文", needs_configuration: "来源尚未接入", conflict: "身份存在冲突", failed: "获取未完成", cancelled: "已停止", interrupted: "上次获取已中断",
};
