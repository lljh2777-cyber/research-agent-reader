import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { tokenizeForLexicalRetrieval } from "../query/lexical-retrieval";
import type { AgentTool, AgentToolCallReceipt } from "./types";
import type { LocalPdfIdentityEvidence } from "./pdf-identity";
export {
	buildDraftSystemPrompt,
	buildDraftUserMessage,
	buildIdentitySystemPrompt,
	buildIdentityUserMessage,
	describeSourceForModel,
	parsePaperIngestInput,
	stripMatchingQuotes,
} from "./paper-ingest-prompts";
import {
	createCrossrefDoiTool,
	createCrossrefSearchTool,
	createBoundArticleReadTool,
	createIdentityVaultCandidateTools,
	createVaultDoiSearchTool,
	createWebSearchTool,
	mineruReadiness,
	runAuthorizedMineruExtract,
	commitSourceNote,
	VaultWriteJournal,
	type HttpToolDeps,
	type MineruPackageReceipt,
	type MineruToolDeps,
	type SourceNoteFields,
	type TavilySearchDeps,
	type VaultToolDeps,
} from "./tools";

/**
 * The ingest workflow is a plugin-driven state machine. Each phase exposes a
 * different tool allowlist, so the model can never call a write tool before
 * identity and dedup gates have passed — the order is enforced in code, not
 * left to prompt compliance.
 */
export type PaperIngestPhase = "identity" | "draft";

export interface PaperIngestFlowOptions {
	sourcePdfPath: string;
	requestNotes: string;
	createArticleMarkdown: boolean;
	createArticleWiki: boolean;
	articleWikiSource: "auto" | "pdf" | "article";
	mineruModel: string;
	mineruLanguage: string;
	mineruOcr: boolean;
	mineruFormula: boolean;
	mineruTable: boolean;
	mineruPages: string;
	mineruTimeoutSeconds: number;
	mineruIncludeSourcePdf: boolean;
	remoteUploadConfirmed: boolean;
}

/** Structured identity/dedup contract the first phase must produce. */
export interface PaperIngestIdentity {
	status: "verified" | "conflict";
	duplicateStatus: "none" | "exact" | "possible";
	citekey: string;
	title: string;
	title_zh: string;
	authors: string;
	year: string;
	doi: string;
	duplicates: string[];
	conflicts: string[];
	notes: string[];
}

export interface HumanIdentityConfirmationReceipt {
	schemaVersion: 1;
	taskId: string;
	snapshotSha256: string;
	snapshotSize: number;
	pageNumber: number;
	rasterSha256: string;
	renderEngine: "obsidian-pdfjs";
	renderEngineVersion: string;
	viewportWidth: number;
	viewportHeight: number;
	scale: number;
	confirmedTitle: string;
	confirmedDoi: string | null;
	crossrefRecordHash: string;
	confirmationMode: "human-visual";
}

export function crossrefRecordHash(identity: Pick<PaperIngestIdentity, "title" | "doi" | "authors" | "year">): string {
	return createHash("sha256").update(JSON.stringify({
		title: String(identity.title || "").trim(),
		doi: normalizeIdentityDoi(identity.doi || ""),
		authors: String(identity.authors || "").trim(),
		year: String(identity.year || "").trim(),
	}), "utf8").digest("hex");
}

/** Validate the non-replayable receipt immediately before any write phase. */
export function validateHumanIdentityConfirmation(
	receipt: HumanIdentityConfirmationReceipt | null,
	expected: {
		taskId: string;
		snapshotSha256: string;
		snapshotSize: number;
		identity: PaperIngestIdentity;
	},
): string[] {
	if (!receipt) return ["没有人工视觉身份确认回执"];
	const problems: string[] = [];
	if (receipt.schemaVersion !== 1 || receipt.confirmationMode !== "human-visual") problems.push("人工身份确认回执版本或模式无效");
	if (receipt.taskId !== expected.taskId) problems.push("人工身份确认回执属于另一任务");
	if (receipt.snapshotSha256 !== expected.snapshotSha256 || receipt.snapshotSize !== expected.snapshotSize) {
		problems.push("人工身份确认回执未绑定本次授权 PDF 快照");
	}
	if (!Number.isInteger(receipt.pageNumber) || receipt.pageNumber < 1 || receipt.pageNumber > 3
		|| !Number.isFinite(receipt.viewportWidth) || receipt.viewportWidth <= 0
		|| !Number.isFinite(receipt.viewportHeight) || receipt.viewportHeight <= 0
		|| !Number.isFinite(receipt.scale) || receipt.scale <= 0
		|| !/^[a-f0-9]{64}$/i.test(receipt.rasterSha256)) {
		problems.push("人工身份确认回执的页面栅格信息无效");
	}
	if (receipt.renderEngine !== "obsidian-pdfjs" || !receipt.renderEngineVersion.trim()) {
		problems.push("人工身份确认回执缺少渲染引擎信息");
	}
	if (receipt.confirmedTitle !== expected.identity.title
		|| normalizeIdentityDoi(receipt.confirmedDoi || "") !== normalizeIdentityDoi(expected.identity.doi || "")) {
		problems.push("人工确认的标题或 DOI 与插件锁定的 Crossref 记录不一致");
	}
	if (receipt.crossrefRecordHash !== crossrefRecordHash(expected.identity)) {
		problems.push("人工身份确认回执未绑定当前 Crossref 结构化记录");
	}
	return problems;
}

/** Structured note-field contract the draft phase must produce. */
/** Bibliographic metadata comes from phase 1; the draft only supplies prose. */
export interface PaperIngestNoteDraft {
	status: "completed" | "insufficient-evidence";
	title: string;
	title_zh: string;
	researchQuestion: string;
	conclusion: string;
	motivation: string;
	evidenceGaps: string;
	notes: string[];
}

export interface PaperIngestToolDeps {
	vault: VaultToolDeps;
	http: HttpToolDeps;
	mineru: MineruToolDeps;
	tavily: TavilySearchDeps;
	lexicalRetriever: {
		retrieve(
			question: string,
			expandedTerms?: string[],
			options?: { allowedPrefixes?: string[] },
		): Promise<Record<string, unknown>>;
	};
}

/** Independent dedup surfaces: analysis notes plus both equivalent source roots. */
export const PAPER_INGEST_READ_PREFIXES = ["wiki/sources", "papers", "Clippings"] as const;

export function buildIdentityTools(
	deps: PaperIngestToolDeps,
	localPdfEvidence?: LocalPdfIdentityEvidence,
): AgentTool[] {
	let vaultSearchCompleted = false;
	const exactDoiCandidates = new Set((localPdfEvidence?.doiCandidates || [])
		.map((doi) => String(doi || "").trim().toLowerCase())
		.filter(Boolean));
	const attemptedExactDois = new Set<string>();
	const trustedTitles = localPdfEvidence ? localPdfTitleCandidates(localPdfEvidence) : [];
	const fileHint = String(localPdfEvidence?.fileName || "")
		.replace(/\.pdf$/i, "")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const fixedQueries = trustedTitles.length ? trustedTitles : fileHint ? [fileHint] : [];
	const candidateTools = createIdentityVaultCandidateTools(
		deps.vault,
		deps.lexicalRetriever,
		fixedQueries,
		PAPER_INGEST_READ_PREFIXES,
	);
	const vaultCandidatesBase = candidateTools[0];
	const vaultCandidates: AgentTool = {
		...vaultCandidatesBase,
		description: `${vaultCandidatesBase.description} 身份阶段必须首先调用本工具，再访问 Crossref。`,
		async execute(args, context) {
			const result = await vaultCandidatesBase.execute(args, context);
			for (const doi of result.receiptData?.dois || []) {
				const normalized = String(doi || "").trim().toLowerCase();
				if (normalized) exactDoiCandidates.add(normalized);
			}
			vaultSearchCompleted = true;
			return result;
		},
	};
	const vaultCandidateReadBase = candidateTools[1];
	const vaultCandidateRead: AgentTool = {
		...vaultCandidateReadBase,
		async execute(args, context) {
			const result = await vaultCandidateReadBase.execute(args, context);
			for (const doi of result.receiptData?.dois || []) {
				const normalized = String(doi || "").trim().toLowerCase();
				if (normalized) exactDoiCandidates.add(normalized);
			}
			return result;
		},
	};
	const afterVaultPreflight = (tool: AgentTool): AgentTool => ({
		...tool,
		async execute(args, context) {
			if (!vaultSearchCompleted) {
				throw new Error(`必须先调用 vault_candidates 检查本地原文层与分析层，再调用 ${tool.name}`);
			}
			return tool.execute(args, context);
		},
	});
	const crossrefDoiBase = createCrossrefDoiTool(deps.http);
	const crossrefDoi: AgentTool = afterVaultPreflight({
		...crossrefDoiBase,
		async execute(args, context) {
			const doi = String(args.doi || "")
				.trim()
				.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
				.toLowerCase();
			if (!exactDoiCandidates.has(doi)) {
				throw new Error("crossref_doi 只接受本地 PDF、当前 Vault 候选或本次 crossref_search 回执中的 DOI");
			}
			if (exactDoiCandidates.has(doi)) attemptedExactDois.add(doi);
			const result = await crossrefDoiBase.execute(args, context);
			return result;
		},
	});
	const crossrefSearchBase = limitToolAttempts(
		createCrossrefSearchTool(deps.http),
		2,
		"crossref_search 本阶段最多调用两次。请优先使用 Vault 候选中的 DOI；否则从已有 Crossref 候选选择 DOI 并调用 crossref_doi，若候选均不匹配则返回 conflict。",
	);
	const crossrefSearch: AgentTool = afterVaultPreflight({
		...crossrefSearchBase,
		async execute(args, context) {
			const pending = [...exactDoiCandidates].filter((doi) => !attemptedExactDois.has(doi));
			if (pending.length) {
				throw new Error(`本地 PDF 已提取 DOI 候选 ${pending.join("、")}；必须先逐个调用 crossref_doi 精确核验，不能提前模糊搜索`);
			}
			const result = await crossrefSearchBase.execute(args, context);
			for (const doi of [
				...(result.receiptData?.dois || []),
				...(result.receiptData?.bibliographicRecords || []).map((record) => record.doi),
			]) {
				const normalized = String(doi || "").trim().toLowerCase();
				if (normalized) exactDoiCandidates.add(normalized);
			}
			return result;
		},
	});
	const verifiedCrossrefDois = new Set<string>();
	const crossrefDoiTracked: AgentTool = {
		...crossrefDoi,
		async execute(args, context) {
			const result = await crossrefDoi.execute(args, context);
			const doi = String(args.doi || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
			if ((result.receiptData?.bibliographicRecords || []).some((record) => (
				String(record.doi || "").trim().toLowerCase() === doi
			))) verifiedCrossrefDois.add(doi);
			return result;
		},
	};
	const vaultDoiBase = createVaultDoiSearchTool(deps.vault, PAPER_INGEST_READ_PREFIXES);
	const vaultDoi: AgentTool = {
		...vaultDoiBase,
		async execute(args, context) {
			const doi = String(args.doi || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
			if (!verifiedCrossrefDois.has(doi)) {
				throw new Error("vault_doi_search 只接受本次已由 crossref_doi 精确核验的 DOI");
			}
			return vaultDoiBase.execute(args, context);
		},
	};
	const tools: AgentTool[] = [
		vaultCandidates,
		vaultCandidateRead,
		crossrefSearch,
		crossrefDoiTracked,
		vaultDoi,
	];
	if (deps.tavily.apiKey) tools.push(afterVaultPreflight(createWebSearchTool(deps.tavily)));
	return tools;
}

function limitToolAttempts(tool: AgentTool, maxAttempts: number, exhaustedMessage: string): AgentTool {
	let attempts = 0;
	return {
		...tool,
		description: `${tool.description} 本阶段最多调用 ${maxAttempts} 次。`,
		async execute(args, context) {
			if (attempts >= maxAttempts) throw new Error(exhaustedMessage);
			attempts += 1;
			return tool.execute(args, context);
		},
	};
}


export function buildDraftTools(deps: PaperIngestToolDeps, articleVaultPath = ""): AgentTool[] {
	if (articleVaultPath) {
		return [createBoundArticleReadTool(deps.vault, articleVaultPath)];
	}
	return [];
}

/**
 * A draft sourced from MinerU is accepted only when the model actually read
 * the overview produced by the path-bound article tool. Model claims and a
 * generic vault_read receipt cannot satisfy this gate.
 */
export function validateDraftReceipts(
	articleVaultPath: string,
	expectedTitle: string,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): string[] {
	if (!articleVaultPath) return [];
	const expected = normalizeReceiptPath(articleVaultPath);
	const normalizedTitle = normalizeBibliographicTitle(expectedTitle);
	const observed = toolCalls.some((call) => (
		call.tool === "article_read"
		&& call.ok
		&& (call.data?.paths || []).some((path) => normalizeReceiptPath(path) === expected)
		&& (call.data?.queryTerms || []).includes("overview")
		&& (call.data?.titles || []).some((title) => normalizeBibliographicTitle(title) === normalizedTitle)
	));
	return observed
		? []
		: ["未成功读取插件绑定且标题一致的原文 Markdown 摘要证据包"];
}

/** Validates the identity phase output; throws with a readable reason. */
export function parseIdentityResult(
	final: Record<string, unknown> | null,
): PaperIngestIdentity | null {
	if (!final) return null;
	const status = String(final.status || "").toLowerCase();
	if (!["verified", "conflict"].includes(status)) return null;
	const duplicateStatusRaw = String(final.duplicateStatus || final.duplicate_status || "").toLowerCase();
	if (!["none", "exact", "possible"].includes(duplicateStatusRaw)) return null;
	const normalizeTextArray = (value: unknown): string[] => Array.isArray(value)
		? value.map((item) => String(item || "").trim()).filter(Boolean)
		: [];
	const citekey = String(final.citekey || "").trim();
	if (status === "verified" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(citekey)) {
		throw new Error(`模型返回的 citekey 不合法：${citekey}`);
	}
	const title = String(final.title || "").trim();
	if (status === "verified" && title.replace(/[\s\p{P}]+/gu, "").length < 4) {
		throw new Error("模型未返回可信的原文标题，已拒绝 verified 结果");
	}
	const year = String(final.year || "").trim();
	if (status === "verified" && year && !/^\d{4}$/.test(year)) {
		throw new Error(`模型返回的年份不是四位数字：${year}`);
	}
	return {
		status: status as PaperIngestIdentity["status"],
		duplicateStatus: duplicateStatusRaw as PaperIngestIdentity["duplicateStatus"],
		citekey,
		title,
		title_zh: String(final.title_zh || "").trim(),
		authors: String(final.authors || "").trim().slice(0, 400),
		year,
		doi: String(final.doi || "").trim().replace(/^https?:\/\/doi\.org\//i, ""),
		duplicates: normalizeTextArray(final.duplicates),
		conflicts: normalizeTextArray(final.conflicts),
		notes: normalizeTextArray(final.notes),
	};
}

/**
 * Plugin-side gate on phase 1: a "verified" identity is only accepted when
 * the loop's tool receipts prove the required work actually happened — at
 * least one successful metadata lookup, at least one successful dedup
 * lookup, and (when a DOI is claimed) a successful exact DOI verification.
 */
export function validateIdentityReceipts(
	identity: PaperIngestIdentity,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
	localPdfEvidence?: LocalPdfIdentityEvidence,
): string[] {
	if (identity.status !== "verified") return [];
	// Dedup must use the same canonical title/DOI that the plugin will commit.
	// A punctuation or width variant from the model must not be able to produce
	// different query terms and then be canonicalized only after the search.
	identity = bindIdentityMetadataFromReceipts({ ...identity }, toolCalls);
	const problems: string[] = [];
	const successful = (names: string[]): AgentToolCallReceipt[] =>
		toolCalls.filter((call) => names.includes(call.tool) && call.ok);
	const metadataCalls = successful(["crossref_search", "crossref_doi", "web_search"]);
	const bibliographicObservations = collectBibliographicObservations(toolCalls);
	const matchingCrossrefRecords = bibliographicObservations
		.filter((observation) => ["crossref_search", "crossref_doi"].includes(observation.call.tool))
		.filter((observation) => (
			normalizeBibliographicTitle(observation.record.title)
			=== normalizeBibliographicTitle(identity.title)
		));
	const dedupCalls = successful(["vault_candidates", "vault_candidate_read", "vault_doi_search"]);
	if (localPdfEvidence) {
		if (localPdfEvidence.status !== "available") {
			problems.push("本地 PDF 预检不可用，不能进入最终栅格人工确认");
		} else if (!toolCalls.some((call) => (
			call.ok
			&& call.tool === "vault_candidates"
		))) {
			problems.push("未完成固定范围的 Vault 候选预检");
		}
	}
	if (!metadataCalls.length) {
		problems.push("未执行任何元数据查询（crossref/web_search）");
	} else if (!bibliographicObservations.length) {
		problems.push("元数据查询没有返回任何结构化候选，不能据此确认文献身份");
	} else if (!matchingCrossrefRecords.length) {
		problems.push("Crossref 结构化回执不包含模型声明的原文标题；网页结果不能单独作为 verified 身份凭据");
	}
	if (!dedupCalls.length) {
		problems.push("未执行任何去重检索（vault 查询）");
	} else if (identity.duplicateStatus === "exact") {
		const trusted = collectTrustedExactDuplicateRecords(identity, toolCalls);
		if (!trusted.length) {
			problems.push("exact 重复判定未被 Vault 检索回执支持：缺少标题或 DOI 一致证据路径");
		}
		const citekeys = trusted.map((record) => record.citekey).filter(Boolean);
		if (new Set(citekeys.map((value) => value.toLowerCase())).size > 1) {
			problems.push("工具回执中的 exact 重复层导出不同 citekey");
		}
	} else if (identity.duplicateStatus === "possible") {
		const declaredPaths = identity.duplicates.flatMap(extractDuplicatePaths);
		if (!declaredPaths.length) {
			problems.push(`${identity.duplicateStatus} 重复判定没有提供已有文献的 Vault 路径`);
		} else if (!dedupCalls.some((call) => declaredPaths.some((declaredPath) => (
			receiptContainsPath(call, declaredPath)
		)))) {
			problems.push(`${identity.duplicateStatus} 重复判定未被 Vault 检索回执支持`);
		}
	} else {
		if (identity.duplicates.length) {
			problems.push("duplicateStatus 为 none，但仍声明了重复文献");
		}
		const titleSearchCalls = dedupCalls.filter((call) => receiptQuerySupportsTitle(call, identity.title));
		const doiSearchCalls = identity.doi
			? dedupCalls.filter((call) => receiptDoiSearchSupportsIdentity(call, identity.doi))
			: [];
		if (!titleSearchCalls.length) {
			problems.push("none 重复判定没有让 Vault 检索器实际使用完整原文标题的检索词");
		} else if (identity.doi && !doiSearchCalls.length) {
			problems.push("none 重复判定没有用 vault_doi_search 精确检索已核验 DOI");
		} else if (doiSearchCalls.some((call) => (call.data?.candidates || []).length > 0)) {
		problems.push("none 重复判定与 DOI 精确查重回执冲突：已存在同 DOI 的原文或分析 Markdown");
		} else if (dedupCalls.some((call) => receiptContainsMatchingCandidate(call, identity))) {
			problems.push("none 重复判定与 Vault 检索回执冲突：已发现同标题或同 citekey 候选");
		} else if (dedupCalls.some((call) => receiptReadMatchesIdentity(call, identity))) {
			problems.push("none 重复判定与 Vault 读取回执冲突：已有记录的标题或 DOI 一致");
		}
	}
	if (identity.doi) {
		const normalizedDoi = normalizeIdentityDoi(identity.doi);
		const matchingDoiCalls = toolCalls
			.filter((call) => call.tool === "crossref_doi" && call.ok)
			.filter((call) => normalizeIdentityDoi(call.data?.query || "") === normalizedDoi)
			.filter((call) => (call.data?.bibliographicRecords || []).some((record) => (
				normalizeIdentityDoi(record.doi) === normalizedDoi
				&& normalizeBibliographicTitle(record.title) === normalizeBibliographicTitle(identity.title)
			)));
		if (!matchingDoiCalls.length) {
			problems.push(`声明了 DOI ${identity.doi}，但没有对应标题的 crossref_doi 核验记录`);
		}
	} else if (matchingCrossrefRecords.some((observation) => normalizeIdentityDoi(observation.record.doi))) {
		problems.push("Crossref 的同标题记录包含 DOI，但模型将 DOI 留空；必须按 DOI 精确核验后再标记 verified");
	}
	return problems;
}

function localPdfTitleCandidates(evidence: LocalPdfIdentityEvidence): string[] {
	if (evidence.status !== "available") return [];
	const candidates: string[] = [];
	const add = (value: string): void => {
		const text = String(value || "").replace(/\s+/g, " ").trim();
		const normalized = normalizeBibliographicTitle(text);
		if (normalized.length < 12 || candidates.some((item) => normalizeBibliographicTitle(item) === normalized)) return;
		candidates.push(text.slice(0, 500));
	};
	// These values only seed deterministic searches. Neither metadata nor the
	// PDF text layer is an identity authority; the human raster receipt is.
	for (const candidate of evidence.firstPageTitleCandidates || []) add(candidate);
	return candidates;
}

function bibliographicTitlesMatch(left: string, right: string): boolean {
	const a = normalizeBibliographicTitle(left);
	const b = normalizeBibliographicTitle(right);
	if (!a || !b) return false;
	if (a === b) return true;
	const aTerms = a.split(/\s+/).filter(Boolean);
	const bTerms = b.split(/\s+/).filter(Boolean);
	if (Math.min(aTerms.length, bTerms.length) < 4) return false;
	const bSet = new Set(bTerms);
	const overlap = aTerms.filter((term) => bSet.has(term)).length;
	const coverage = overlap / Math.min(aTerms.length, bTerms.length);
	const lengthRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
	return coverage >= 0.9 && lengthRatio >= 0.72;
}

interface BibliographicObservation {
	call: AgentToolCallReceipt;
	record: { title: string; doi: string; authors: string; year: string };
}

function collectBibliographicObservations(
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): BibliographicObservation[] {
	return toolCalls.flatMap((call) => {
		if (!call.ok) return [];
		return (call.data?.bibliographicRecords || []).map((record) => ({ call, record }));
	});
}

/**
 * Replace model-authored bibliographic fields with one trusted Crossref record
 * after validateIdentityReceipts has accepted the run. title_zh and citekey
 * remain model/internal fields; title, DOI, authors and year are tool-owned.
 */
export function bindIdentityMetadataFromReceipts(
	identity: PaperIngestIdentity,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): PaperIngestIdentity {
	if (identity.status !== "verified") return identity;
	const normalizedTitle = normalizeBibliographicTitle(identity.title);
	const normalizedDoi = normalizeIdentityDoi(identity.doi);
	const matching = collectBibliographicObservations(toolCalls)
		.filter((observation) => ["crossref_search", "crossref_doi"].includes(observation.call.tool))
		.filter((observation) => normalizeBibliographicTitle(observation.record.title) === normalizedTitle);
	const exactDoi = normalizedDoi
		? matching.find((observation) => (
			observation.call.tool === "crossref_doi"
			&& normalizeIdentityDoi(observation.call.data?.query || "") === normalizedDoi
			&& normalizeIdentityDoi(observation.record.doi) === normalizedDoi
		))
		: undefined;
	const selected = exactDoi || matching.find((observation) => observation.call.tool === "crossref_search");
	if (!selected) return identity;
	identity.title = decodeBibliographicMarkup(selected.record.title).replace(/\s+/g, " ").trim();
	identity.doi = normalizeIdentityDoi(selected.record.doi);
	identity.authors = decodeBibliographicMarkup(selected.record.authors).replace(/\s+/g, " ").trim().slice(0, 400);
	identity.year = /^\d{4}$/.test(String(selected.record.year || "").trim())
		? String(selected.record.year).trim()
		: "";
	return identity;
}

function normalizeIdentityDoi(value: string): string {
	return String(value || "")
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.toLowerCase();
}

function decodeBibliographicMarkup(value: string): string {
	return String(value || "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;|&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

export function normalizeBibliographicTitle(value: string): string {
	return decodeBibliographicMarkup(value)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function normalizeIdentityText(value: string): string {
	return normalizeBibliographicTitle(value);
}

function receiptSupportsTitle(call: AgentToolCallReceipt, title: string): boolean {
	const normalizedTitle = normalizeIdentityText(title);
	if (!normalizedTitle) return false;
	return (call.data?.titles || [])
		.some((candidate) => normalizeIdentityText(candidate) === normalizedTitle);
}

function normalizeReceiptPath(value: string): string {
	return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function pathsReferToSameRecord(observed: string, declared: string): boolean {
	const observedPath = normalizeReceiptPath(observed);
	const declaredPath = normalizeReceiptPath(declared);
	return Boolean(observedPath && declaredPath)
		&& (observedPath === declaredPath || observedPath.startsWith(`${declaredPath}/`));
}

function receiptContainsPath(call: AgentToolCallReceipt, declaredPath: string): boolean {
	const observedPaths = [
		...(call.data?.paths || []),
		...(call.data?.candidates || []).map((candidate) => candidate.path),
	];
	return observedPaths.some((path) => pathsReferToSameRecord(path, declaredPath));
}

function receiptQuerySupportsTitle(
	call: AgentToolCallReceipt,
	title: string,
): boolean {
	if (call.tool !== "vault_candidates") return false;
	const expectedTitleTerms = tokenizeForLexicalRetrieval(title, 24).map(normalizeLexicalTerm);
	return receiptTermsCover(call, expectedTitleTerms);
}

function normalizeLexicalTerm(value: string): string {
	return String(value || "").normalize("NFKC").toLowerCase().trim();
}

function receiptTermsCover(call: AgentToolCallReceipt, expectedTerms: string[]): boolean {
	const observedTerms = new Set((call.data?.queryTerms || []).map(normalizeLexicalTerm).filter(Boolean));
	return expectedTerms.length > 0 && expectedTerms.every((term) => observedTerms.has(term));
}

function receiptDoiSearchSupportsIdentity(
	call: AgentToolCallReceipt,
	doi: string,
): boolean {
	return call.tool === "vault_doi_search"
		&& normalizeIdentityDoi(call.data?.query || "") === normalizeIdentityDoi(doi);
}

function candidatePathMatchesCitekey(candidatePath: string, citekey: string): boolean {
	const normalizedPath = normalizeReceiptPath(candidatePath);
	const normalizedCitekey = String(citekey || "").trim().toLowerCase();
	if (!normalizedPath || !normalizedCitekey) return false;
	if (normalizedPath.startsWith("wiki/sources/")) {
		const basename = normalizedPath.split("/").pop()?.replace(/\.md$/i, "") || "";
		return basename === normalizedCitekey;
	}
	if (normalizedPath.startsWith("papers/")) {
		return normalizedPath.split("/")[1] === normalizedCitekey;
	}
	return false;
}

function receiptContainsMatchingCandidate(
	call: AgentToolCallReceipt,
	identity: Pick<PaperIngestIdentity, "title" | "citekey">,
): boolean {
	const normalizedTitle = normalizeBibliographicTitle(identity.title);
	return (call.data?.candidates || []).some((candidate) => (
		candidatePathMatchesCitekey(candidate.path, identity.citekey)
		|| (Boolean(normalizedTitle)
			&& normalizeBibliographicTitle(candidate.title) === normalizedTitle)
	));
}

function receiptReadMatchesIdentity(
	call: AgentToolCallReceipt,
	identity: Pick<PaperIngestIdentity, "title" | "doi">,
): boolean {
	if (call.tool !== "vault_candidate_read" || !call.ok) return false;
	const normalizedTitle = normalizeBibliographicTitle(identity.title);
	const normalizedDoi = normalizeIdentityDoi(identity.doi);
	const titleMatches = (call.data?.titles || [])
		.some((title) => normalizeBibliographicTitle(title) === normalizedTitle);
	const doiMatches = Boolean(normalizedDoi) && (call.data?.dois || [])
		.some((doi) => normalizeIdentityDoi(doi) === normalizedDoi);
	return titleMatches || doiMatches;
}

function receiptSupportsExactDuplicate(
	call: AgentToolCallReceipt,
	declaredPath: string,
	identity: Pick<PaperIngestIdentity, "title" | "doi">,
): boolean {
	const normalizedDoi = normalizeIdentityDoi(identity.doi);
	if (normalizedDoi) {
		return ["vault_candidate_read", "vault_doi_search"].includes(call.tool)
			&& receiptContainsPath(call, declaredPath)
			&& (call.data?.dois || [])
				.some((doi) => normalizeIdentityDoi(doi) === normalizedDoi);
	}
	if (call.tool === "vault_candidates") {
		return (call.data?.candidates || []).some((candidate) => (
			pathsReferToSameRecord(candidate.path, declaredPath)
			&& normalizeIdentityText(candidate.title) === normalizeIdentityText(identity.title)
		));
	}
	if (call.tool !== "vault_candidate_read" || !receiptContainsPath(call, declaredPath)) return false;
	return (call.data?.titles || [])
		.some((title) => normalizeIdentityText(title) === normalizeIdentityText(identity.title));
}

function extractDuplicatePaths(value: string): string[] {
	const text = String(value || "").replace(/\\/g, "/");
	const rawCandidates = [
		...[...text.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]),
		// Compatibility for older unquoted values. Stop at a Markdown filename;
		// paths with spaces/Unicode that name a directory must use backticks.
		...[...text.matchAll(
			/(?:^|[\s'"（(])((?:wiki\/sources|papers|Clippings)\/[^\r\n`'"<>|?*]+?\.md)(?=$|[\s（(，,；;。])/gu,
		)].map((match) => match[1]),
		...[...text.matchAll(
			/(?:^|[\s'"（(])((?:wiki\/sources|papers|Clippings)\/[A-Za-z0-9._/-]+)/g,
		)].map((match) => match[1]),
	];
	const paths = rawCandidates
		.map(normalizeDuplicatePathCandidate)
		.filter(Boolean);
	return [...new Set(paths)];
}

function normalizeDuplicatePathCandidate(value: string): string {
	const candidate = String(value || "")
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/[.,;:，；。]+$/u, "");
	if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return "";
	if (candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")) return "";
	const comparison = candidate.toLowerCase();
	if (!(comparison.startsWith("wiki/sources/")
		|| comparison.startsWith("papers/")
		|| comparison.startsWith("clippings/"))) return "";
	return candidate;
}

/** Validates the draft phase output into note fields. */
export function parseNoteDraft(final: Record<string, unknown> | null): PaperIngestNoteDraft | null {
	if (!final) return null;
	const status = String(final.status || "completed").toLowerCase();
	if (!["completed", "insufficient-evidence"].includes(status)) return null;
	const normalizeTextArray = (value: unknown): string[] => Array.isArray(value)
		? value.map((item) => String(item || "").trim()).filter(Boolean)
		: [];
	const section = (value: unknown): string => String(value || "").trim().slice(0, 6000);
	return {
		status: status as PaperIngestNoteDraft["status"],
		title: String(final.title || "").trim(),
		title_zh: String(final.title_zh || "").trim(),
		researchQuestion: section(final.researchQuestion ?? final.research_question),
		conclusion: section(final.conclusion),
		motivation: section(final.motivation),
		evidenceGaps: section(final.evidenceGaps ?? final.evidence_gaps),
		notes: normalizeTextArray(final.notes),
	};
}

/**
 * Resolves the vault-relative article path from where the helper ACTUALLY
 * published (receipt.packagePath), not from the citekey. The published
 * article must sit inside the active vault, or there is no receipt — a
 * same-citekey package that already existed in the vault is never claimed.
 * Case is folded only on case-insensitive platforms (Windows); on POSIX,
 * /A and /a are different directories.
 */
export function deriveArticleVaultPath(
	publishedPackagePath: string,
	vaultRoot: string,
	platform: string = process.platform,
): string {
	const normalizedPackage = String(publishedPackagePath || "").replace(/\\/g, "/");
	const normalizedRoot = String(vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalizedPackage || !normalizedRoot) return "";
	const publishedArticle = `${normalizedPackage.replace(/\/+$/, "")}/article.md`;
	const prefix = `${normalizedRoot}/`;
	const fold = (value: string): string => platform === "win32" ? value.toLowerCase() : value;
	if (!fold(publishedArticle).startsWith(fold(prefix))) return "";
	const relative = publishedArticle.slice(prefix.length);
	if (relative.split("/").some((segment) => segment === ".." || segment === "")) return "";
	return relative;
}

/**
 * Resolves the vault-relative article path from where the helper ACTUALLY
 * published (receipt.packagePath), not from the citekey. Binding prefers
 * real filesystem paths (symlink/case/separator safe via realpath +
 * path.relative) and falls back to the pure string derivation; the article
 * must sit inside the active vault, or there is no receipt — a
 * same-citekey package that already existed in the vault is never claimed.
 */
export async function resolveArticleVaultPath(
	deps: VaultToolDeps,
	publishedPackagePath: string,
	vaultRoot: string,
	platform: string = process.platform,
): Promise<string> {
	const relative = bindPublishedArticle(publishedPackagePath, vaultRoot, platform);
	if (!relative) return "";
	const exists = await deps.app.vault.adapter.exists(normalizeVaultPath(relative), true);
	return exists ? relative : "";
}

function bindPublishedArticle(
	publishedPackagePath: string,
	vaultRoot: string,
	platform: string,
): string {
	try {
		const vaultReal = realpathNative(vaultRoot);
		const articleReal = realpathNative(path.join(publishedPackagePath, "article.md"));
		const relative = path.relative(vaultReal, articleReal);
		if (
			!relative
			|| relative === ".."
			|| relative.startsWith(`..${path.sep}`)
			|| path.isAbsolute(relative)
		) {
			return "";
		}
		return relative.split(path.sep).join("/");
	} catch {
		return deriveArticleVaultPath(publishedPackagePath, vaultRoot, platform);
	}
}

function realpathNative(value: string): string {
	return fs.realpathSync.native(path.resolve(value));
}

function normalizeVaultPath(value: string): string {
	return String(value || "").replace(/\\/g, "/");
}

export interface PaperIngestReceipts {
	/** Present when this run published a validated MinerU package. */
	mineruPackage: MineruPackageReceipt | null;
	/** Vault-relative article.md verified to exist after publish. */
	articleVaultPath: string;
	/** Receipts of files the plugin itself wrote. */
	writes: ReturnType<VaultWriteJournal["receipts"]>;
}

export interface ExactDuplicateOutputPlan {
	needsMarkdown: boolean;
	needsWiki: boolean;
	noOp: boolean;
}

/** Exact bibliographic duplicates are completed per requested output. */
export function planExactDuplicateOutputs(
	options: Pick<PaperIngestFlowOptions, "createArticleMarkdown" | "createArticleWiki">,
	existing: { sourcePath: string; analysisPath: string },
): ExactDuplicateOutputPlan {
	const needsMarkdown = options.createArticleMarkdown && !existing.sourcePath;
	const needsWiki = options.createArticleWiki && !existing.analysisPath;
	return { needsMarkdown, needsWiki, noOp: !needsMarkdown && !needsWiki };
}

export interface ExactDuplicateLayers {
	/** Existing Markdown original in papers/ or Clippings/. */
	sourcePath: string;
	/** Existing analysis note in wiki/sources/. */
	analysisPath: string;
	/** Receipt-derived citekey when papers/ or wiki/sources supplies one. */
	citekey: string;
	/** Non-empty when trusted source/analysis receipts disagree on citekey. */
	conflict: string;
}

export interface TrustedExactDuplicateRecord {
	path: string;
	layer: "source" | "analysis";
	citekey: string;
	evidence: "doi" | "title";
}

function trustedPathRecord(pathValue: string, evidence: "doi" | "title"): TrustedExactDuplicateRecord | null {
	const pathValueNormalized = String(pathValue || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!pathValueNormalized || pathValueNormalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
	const comparison = pathValueNormalized.toLowerCase();
	if (/^papers\/[^/]+\/article\.md$/i.test(pathValueNormalized)) {
		const citekey = pathValueNormalized.split("/")[1] || "";
		return {
			path: pathValueNormalized,
			layer: "source",
			citekey: CITEKEY_PATTERN_FOR_RECEIPT.test(citekey) ? citekey : "",
			evidence,
		};
	}
	if (comparison.startsWith("clippings/") && /\.md$/i.test(pathValueNormalized)) {
		return { path: pathValueNormalized, layer: "source", citekey: "", evidence };
	}
	if (comparison.startsWith("wiki/sources/") && /\.md$/i.test(pathValueNormalized)) {
		const citekey = pathValueNormalized.split("/").pop()?.replace(/\.md$/i, "") || "";
		return {
			path: pathValueNormalized,
			layer: "analysis",
			citekey: CITEKEY_PATTERN_FOR_RECEIPT.test(citekey) ? citekey : "",
			evidence,
		};
	}
	return null;
}

const CITEKEY_PATTERN_FOR_RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function collectTrustedExactDuplicateRecords(
	identity: Pick<PaperIngestIdentity, "title" | "doi">,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): TrustedExactDuplicateRecord[] {
	const normalizedTitle = normalizeBibliographicTitle(identity.title);
	const normalizedDoi = normalizeIdentityDoi(identity.doi);
	const records: TrustedExactDuplicateRecord[] = [];
	const add = (pathValue: string, evidence: "doi" | "title"): void => {
		const record = trustedPathRecord(pathValue, evidence);
		if (!record) return;
		const key = normalizeReceiptPath(record.path);
		const existing = records.find((item) => normalizeReceiptPath(item.path) === key);
		if (!existing) records.push(record);
		else if (evidence === "doi") existing.evidence = "doi";
	};
	for (const call of toolCalls) {
		if (!call.ok) continue;
		if (call.tool === "vault_doi_search"
			&& normalizedDoi
			&& normalizeIdentityDoi(call.data?.query || "") === normalizedDoi
			&& (call.data?.dois || []).some((doi) => normalizeIdentityDoi(doi) === normalizedDoi)) {
			(call.data?.candidates || []).forEach((candidate) => add(candidate.path, "doi"));
			continue;
		}
		if (call.tool === "vault_candidates") {
			if (!receiptQuerySupportsTitle(call, identity.title)) continue;
			(call.data?.candidates || []).forEach((candidate) => {
				if (normalizeBibliographicTitle(candidate.title) === normalizedTitle) add(candidate.path, "title");
			});
			continue;
		}
		if (call.tool === "vault_candidate_read") {
			const doiMatches = Boolean(normalizedDoi) && (call.data?.dois || [])
				.some((doi) => normalizeIdentityDoi(doi) === normalizedDoi);
			const titleMatches = (call.data?.titles || [])
				.some((title) => normalizeBibliographicTitle(title) === normalizedTitle);
			if (doiMatches || titleMatches) {
				(call.data?.paths || []).forEach((pathValue) => add(pathValue, doiMatches ? "doi" : "title"));
			}
		}
	}
	return records;
}

/**
 * Classify exact duplicate evidence by file role using tool-owned receipts.
 * A model-authored path alone never satisfies either output layer.
 */
export function resolveExactDuplicateLayers(
	identity: Pick<PaperIngestIdentity, "title" | "doi">,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): ExactDuplicateLayers {
	const trusted = collectTrustedExactDuplicateRecords(identity, toolCalls);
	const analysisPaths = trusted.filter((record) => record.layer === "analysis").map((record) => record.path);
	const sourcePaths = trusted.filter((record) => record.layer === "source").map((record) => record.path);
	const citekeys = [...new Set(trusted.map((record) => record.citekey).filter(Boolean))];
	const preferredSource = sourcePaths.find((value) => /^papers\/[^/]+\/article\.md$/i.test(value))
		|| sourcePaths.find((value) => normalizeReceiptPath(value).startsWith("clippings/"))
		|| sourcePaths[0]
		|| "";
	return {
		sourcePath: preferredSource,
		analysisPath: analysisPaths[0] || "",
		citekey: citekeys.length === 1 ? citekeys[0] : "",
		conflict: citekeys.length > 1 ? `同一文献的工具回执导出多个 citekey：${citekeys.join("、")}` : "",
	};
}

/**
 * Reuse the citekey named by the receipt-backed duplicate path so filling a
 * missing output cannot fork one paper into a new suffixed record.
 */
export function resolveExactDuplicateCitekey(
	identity: Pick<PaperIngestIdentity, "title" | "doi">,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): string {
	return resolveExactDuplicateLayers(identity, toolCalls).citekey;
}

/**
 * Deterministic fallback for legacy Clippings whose path carries no citekey.
 * Inputs are the Crossref-bound bibliographic fields, never model duplicate
 * prose. The service still applies active-Vault uniqueness before writing.
 */
export function deriveBibliographicCitekey(
	identity: Pick<PaperIngestIdentity, "authors" | "title" | "year">,
): string {
	const asciiSlug = (value: string): string => String(value || "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	const firstAuthor = String(identity.authors || "").split(";")[0]?.trim() || "";
	const surnameRaw = firstAuthor.includes(",")
		? firstAuthor.split(",")[0]
		: firstAuthor.split(/\s+/)[0];
	const surname = asciiSlug(surnameRaw) || "paper";
	const stopWords = new Set(["a", "an", "and", "of", "on", "the", "to", "for", "in", "with"]);
	const titleTerms = asciiSlug(identity.title).split("_").filter((term) => term && !stopWords.has(term));
	const keyword = titleTerms.slice(0, 2).join("_") || "source";
	const year = /^\d{4}$/.test(String(identity.year || "")) ? String(identity.year) : "undated";
	return `${surname}_${keyword}_${year}`.slice(0, 120).replace(/_+$/g, "");
}

/**
 * Whether the draft phase may run given the actual extraction receipt.
 * Strict "article" mode without a verified package must not produce a wiki.
 */
export function evaluateDraftPhase(
	options: PaperIngestFlowOptions,
	articleVaultPath: string,
	titleConflict: boolean,
): { run: boolean; blocker: string; downgradeNote: string } {
	if (!options.createArticleWiki || titleConflict) return { run: false, blocker: "", downgradeNote: "" };
	if (options.createArticleMarkdown && !articleVaultPath) {
		return {
			run: false,
			blocker: "已要求生成 MinerU 原文包并据此创建文章 Wiki，但本次没有有效 article.md 回执；原文包与摘要笔记均不做静默降级",
			downgradeNote: "",
		};
	}
	if (options.articleWikiSource === "article" && !articleVaultPath) {
		return {
			run: false,
			blocker: "文章 Wiki 内容来源为「已有 article.md」，但本次没有已验证的 article 包，未创建 Wiki",
			downgradeNote: "",
		};
	}
	const downgradeNote = articleVaultPath
		? ""
		: options.articleWikiSource === "pdf"
			? "轻量方式不读取 PDF 正文：内容来源已降级为文献元数据与用户说明"
			: options.articleWikiSource === "auto"
				? "未找到已验证 article 包：内容来源回退为文献元数据与用户说明"
				: "";
	return { run: true, blocker: "", downgradeNote };
}

/**
 * Outcome status precedence: user cancellation and technical errors are
 * failures (never dressed up as conflicts); genuine identity/title/
 * authorization blockers are conflicts; otherwise receipts decide.
 */
export function computeIngestOutcomeStatus(input: {
	cancelled: boolean;
	conflicts: string[];
	errors: string[];
	identityConflict: boolean;
	markdownSatisfied: boolean;
	wikiSatisfied: boolean;
}): "completed" | "conflict" | "failed" {
	if (input.cancelled) return "failed";
	if (input.errors.length > 0) return "failed";
	if (input.conflicts.length > 0 || input.identityConflict) return "conflict";
	return input.markdownSatisfied && input.wikiSatisfied ? "completed" : "failed";
}

/**
 * Deterministic citekey uniqueness: suffixes -2..-9 when the active Vault
 * already contains the base citekey.
 */
export async function resolveUniqueCitekey(
	base: string,
	exists: (citekey: string) => Promise<boolean>,
): Promise<{ citekey: string; renamed: boolean }> {
	if (!(await exists(base))) return { citekey: base, renamed: false };
	for (let suffix = 2; suffix <= 9; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!(await exists(candidate))) return { citekey: candidate, renamed: true };
	}
	throw new Error(`citekey ${base} 及其 -2..-9 后缀均已被占用，请改用其他 citekey`);
}

export { runAuthorizedMineruExtract, commitSourceNote, mineruReadiness, VaultWriteJournal };
