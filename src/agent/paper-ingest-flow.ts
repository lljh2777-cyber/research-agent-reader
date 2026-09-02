import * as fs from "node:fs";
import * as path from "node:path";

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
	createVaultDoiSearchTool,
	createVaultListTool,
	createVaultReadTool,
	createVaultSearchTool,
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
	localPdfEvidence?: Pick<LocalPdfIdentityEvidence, "doiCandidates">,
): AgentTool[] {
	let vaultSearchCompleted = false;
	const localDoiCandidates = [...new Set((localPdfEvidence?.doiCandidates || [])
		.map((doi) => String(doi || "").trim().toLowerCase())
		.filter(Boolean))];
	const attemptedLocalDois = new Set<string>();
	let verifiedLocalDoi = "";
	const vaultSearchBase = createVaultSearchTool(deps.lexicalRetriever, PAPER_INGEST_READ_PREFIXES);
	const vaultSearch: AgentTool = {
		...vaultSearchBase,
		description: `${vaultSearchBase.description} 身份阶段必须首先调用本工具，再访问 Crossref。`,
		async execute(args, context) {
			const result = await vaultSearchBase.execute(args, context);
			vaultSearchCompleted = true;
			return result;
		},
	};
	const afterVaultPreflight = (tool: AgentTool): AgentTool => ({
		...tool,
		async execute(args, context) {
			if (!vaultSearchCompleted) {
				throw new Error(`必须先调用 vault_search 检查本地原文层与分析层，再调用 ${tool.name}`);
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
			if (localDoiCandidates.includes(doi)) attemptedLocalDois.add(doi);
			const result = await crossrefDoiBase.execute(args, context);
			if (localDoiCandidates.includes(doi)) verifiedLocalDoi = doi;
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
			if (verifiedLocalDoi) {
				throw new Error(`本地 PDF 的 DOI ${verifiedLocalDoi} 已被 Crossref 精确查到；请比较该记录与 PDF 标题并继续 Vault 查重，若不一致则返回 conflict，不得再做模糊搜索`);
			}
			const pending = localDoiCandidates.filter((doi) => !attemptedLocalDois.has(doi));
			if (pending.length) {
				throw new Error(`本地 PDF 已提取 DOI 候选 ${pending.join("、")}；必须先逐个调用 crossref_doi 精确核验，不能提前模糊搜索`);
			}
			return crossrefSearchBase.execute(args, context);
		},
	});
	const tools: AgentTool[] = [
		vaultSearch,
		createVaultReadTool(deps.vault, PAPER_INGEST_READ_PREFIXES),
		crossrefSearch,
		crossrefDoi,
		createVaultDoiSearchTool(deps.vault, PAPER_INGEST_READ_PREFIXES),
		createVaultListTool(deps.vault, PAPER_INGEST_READ_PREFIXES),
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
	return [
		createVaultReadTool(deps.vault, PAPER_INGEST_READ_PREFIXES),
		createVaultSearchTool(deps.lexicalRetriever, PAPER_INGEST_READ_PREFIXES),
	];
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
	const dedupCalls = successful(["vault_search", "vault_doi_search", "vault_list", "vault_read"]);
	if (!metadataCalls.length) {
		problems.push("未执行任何元数据查询（crossref/web_search）");
	} else if (!bibliographicObservations.length) {
		problems.push("元数据查询没有返回任何结构化候选，不能据此确认文献身份");
	} else if (!matchingCrossrefRecords.length) {
		problems.push("Crossref 结构化回执不包含模型声明的原文标题；网页结果不能单独作为 verified 身份凭据");
	}
	if (!dedupCalls.length) {
		problems.push("未执行任何去重检索（vault 查询）");
	} else if (["exact", "possible"].includes(identity.duplicateStatus)) {
		const declaredPaths = identity.duplicates.flatMap(extractDuplicatePaths);
		if (!declaredPaths.length) {
			problems.push(`${identity.duplicateStatus} 重复判定没有提供已有文献的 Vault 路径`);
		} else if (!dedupCalls.some((call) => declaredPaths.some((declaredPath) => (
			receiptContainsPath(call, declaredPath)
		)))) {
			problems.push(`${identity.duplicateStatus} 重复判定未被 Vault 检索回执支持`);
		} else if (identity.duplicateStatus === "exact" && !dedupCalls.some((call) => (
			declaredPaths.some((declaredPath) => receiptSupportsExactDuplicate(call, declaredPath, identity))
		))) {
			problems.push("exact 重复判定缺少同路径下的标题或 DOI 一致证据");
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
	if (call.tool !== "vault_search") return false;
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
	if (call.tool !== "vault_read" || !call.ok) return false;
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
		return ["vault_read", "vault_doi_search"].includes(call.tool)
			&& receiptContainsPath(call, declaredPath)
			&& (call.data?.dois || [])
				.some((doi) => normalizeIdentityDoi(doi) === normalizedDoi);
	}
	if (call.tool === "vault_search") {
		return (call.data?.candidates || []).some((candidate) => (
			pathsReferToSameRecord(candidate.path, declaredPath)
			&& normalizeIdentityText(candidate.title) === normalizeIdentityText(identity.title)
		));
	}
	if (call.tool !== "vault_read" || !receiptContainsPath(call, declaredPath)) return false;
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
}

/**
 * Classify exact duplicate evidence by file role using tool-owned receipts.
 * A model-authored path alone never satisfies either output layer.
 */
export function resolveExactDuplicateLayers(
	identity: Pick<PaperIngestIdentity, "title" | "doi" | "citekey">,
	toolCalls: ReadonlyArray<AgentToolCallReceipt>,
): ExactDuplicateLayers {
	const exactPaths: string[] = [];
	const normalizedTitle = normalizeBibliographicTitle(identity.title);
	const normalizedDoi = normalizeIdentityDoi(identity.doi);
	const add = (value: string): void => {
		const path = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (!path || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) return;
		if (!exactPaths.some((existing) => normalizeReceiptPath(existing) === normalizeReceiptPath(path))) {
			exactPaths.push(path);
		}
	};
	for (const call of toolCalls) {
		if (!call.ok) continue;
		if (call.tool === "vault_doi_search"
			&& normalizedDoi
			&& normalizeIdentityDoi(call.data?.query || "") === normalizedDoi) {
			(call.data?.candidates || []).forEach((candidate) => add(candidate.path));
			continue;
		}
		if (call.tool === "vault_search") {
			(call.data?.candidates || []).forEach((candidate) => {
				if (normalizeBibliographicTitle(candidate.title) === normalizedTitle
					|| candidatePathMatchesCitekey(candidate.path, identity.citekey)) add(candidate.path);
			});
			continue;
		}
		if (call.tool === "vault_read") {
			const titleMatches = (call.data?.titles || [])
				.some((title) => normalizeBibliographicTitle(title) === normalizedTitle);
			const doiMatches = Boolean(normalizedDoi) && (call.data?.dois || [])
				.some((doi) => normalizeIdentityDoi(doi) === normalizedDoi);
			if (titleMatches || doiMatches) (call.data?.paths || []).forEach(add);
		}
	}
	const analysisPaths = exactPaths.filter((value) => normalizeReceiptPath(value).startsWith("wiki/sources/") && /\.md$/i.test(value));
	const sourcePaths = exactPaths.filter((value) => {
		const path = normalizeReceiptPath(value);
		return /\.md$/i.test(value) && (path.startsWith("papers/") || path.startsWith("clippings/"));
	});
	const preferredSource = sourcePaths.find((value) => /^papers\/[^/]+\/article\.md$/i.test(value))
		|| sourcePaths.find((value) => normalizeReceiptPath(value).startsWith("clippings/"))
		|| sourcePaths[0]
		|| "";
	return { sourcePath: preferredSource, analysisPath: analysisPaths[0] || "" };
}

/**
 * Reuse the citekey named by the receipt-backed duplicate path so filling a
 * missing output cannot fork one paper into a new suffixed record.
 */
export function resolveExactDuplicateCitekey(identity: Pick<PaperIngestIdentity, "citekey" | "duplicates">): string {
	const citekeys = extractDuplicatePaths(identity.duplicates.join("\n"))
		.map((duplicatePath) => {
			const normalized = String(duplicatePath || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
			const comparison = normalized.toLowerCase();
			if (comparison.startsWith("wiki/sources/")) {
				return normalized.split("/").pop()?.replace(/\.md$/i, "") || "";
			}
			if (comparison.startsWith("papers/")) return normalized.split("/")[1] || "";
			return "";
		})
		.filter((citekey) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(citekey));
	const unique = [...new Set(citekeys)];
	const current = unique.find((citekey) => citekey.toLowerCase() === identity.citekey.toLowerCase());
	return current || (unique.length === 1 ? unique[0] : "");
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
