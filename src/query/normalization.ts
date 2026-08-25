import path from "node:path";

import {
	MAX_QUERY_IMAGE_ATTACHMENTS,
	VAULT_IMAGE_MIME_TYPES,
} from "../config";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

export interface VaultImageAttachment {
	path: string;
	name: string;
	mimeType: string;
	size: number;
	sourceNotePath: string;
}

export function normalizeVaultImageAttachment(value: unknown): VaultImageAttachment | null {
	const source = asRecord(value);
	const attachmentPath = String(source.path || "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+/, "");
	const extension = path.posix.extname(attachmentPath).toLowerCase();
	const mimeType = VAULT_IMAGE_MIME_TYPES[extension] || "";
	if (!attachmentPath || !mimeType) return null;
	const size = Number(source.size || 0);
	const sourceNotePath = String(source.sourceNotePath || "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+/, "");
	return {
		path: attachmentPath.slice(0, 1000),
		name: String(source.name || path.posix.basename(attachmentPath)).slice(0, 240),
		mimeType,
		size: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
		sourceNotePath: sourceNotePath.toLowerCase().endsWith(".md")
			? sourceNotePath.slice(0, 1000)
			: "",
	};
}

export function normalizeVaultImageAttachments(values: unknown): VaultImageAttachment[] {
	const seen = new Set<string>();
	const normalized: VaultImageAttachment[] = [];
	for (const value of Array.isArray(values) ? values : []) {
		const attachment = normalizeVaultImageAttachment(value);
		if (!attachment) continue;
		const key = attachment.path.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(attachment);
		if (normalized.length >= MAX_QUERY_IMAGE_ATTACHMENTS) break;
	}
	return normalized;
}

export interface QueryVaultSource {
	path: string;
	title: string;
	cited: boolean;
}

export function normalizeQueryVaultSources(values: unknown): QueryVaultSource[] {
	const seen = new Set<string>();
	const normalized: QueryVaultSource[] = [];
	for (const value of Array.isArray(values) ? values : []) {
		const source = asRecord(value);
		let sourcePath = String(source.path || "")
			.trim()
			.replace(/\\/g, "/")
			.replace(/^knowledge-base\//i, "")
			.replace(/^\/+/, "");
		if (!sourcePath || seen.has(sourcePath.toLowerCase())) continue;
		seen.add(sourcePath.toLowerCase());
		normalized.push({
			path: sourcePath.slice(0, 1000),
			title: String(source.title || path.posix.basename(sourcePath, path.posix.extname(sourcePath)))
				.trim()
				.slice(0, 500),
			cited: source.cited === true,
		});
		if (normalized.length >= 30) break;
	}
	return normalized;
}

export interface QueryWebSource {
	title: string;
	url: string;
	domain: string;
	publisher: string;
	publishedAt: string;
	cited: boolean;
	eventVerified: boolean;
	verification: "event" | "structured" | "model";
}

export function normalizeQueryWebSources(values: unknown): QueryWebSource[] {
	const seen = new Set<string>();
	const normalized: QueryWebSource[] = [];
	for (const value of Array.isArray(values) ? values : []) {
		const source = asRecord(value);
		let parsed: URL;
		try {
			parsed = new URL(String(source.url || "").trim());
		} catch {
			continue;
		}
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
		parsed.hash = "";
		const sourceUrl = parsed.toString();
		const key = sourceUrl.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const verification = source.verification;
		normalized.push({
			title: String(source.title || parsed.hostname).trim().slice(0, 500),
			url: sourceUrl.slice(0, 3000),
			domain: parsed.hostname.toLowerCase().slice(0, 300),
			publisher: String(source.publisher || "").trim().slice(0, 300),
			publishedAt: String(source.published_at || source.publishedAt || "").trim().slice(0, 100),
			cited: source.cited === true,
			eventVerified: source.event_verified === true || source.eventVerified === true,
			verification: verification === "event" || verification === "model"
				? verification
				: "structured",
		});
		if (normalized.length >= 30) break;
	}
	return normalized;
}

export function extractModelProvidedWebSources(text: unknown): QueryWebSource[] {
	const matches: UnknownRecord[] = [];
	const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)/gi;
	for (const match of String(text || "").matchAll(pattern)) {
		matches.push({
			title: String(match[1] || "").trim(),
			url: String(match[2] || "").trim(),
			publisher: "",
			published_at: "",
			cited: true,
			event_verified: false,
			verification: "model",
		});
	}
	return normalizeQueryWebSources(matches);
}

export interface QueryRetrievalPath {
	stage: string;
	inspectedVaultPaths: string[];
	webQueries: string[];
	fallbackReason: string;
}

export function normalizeQueryRetrievalPath(value: unknown): QueryRetrievalPath {
	const source = asRecord(value);
	return {
		stage: String(source.stage || "").slice(0, 200),
		inspectedVaultPaths: (Array.isArray(source.inspected_vault_paths)
			? source.inspected_vault_paths
			: Array.isArray(source.inspectedVaultPaths)
				? source.inspectedVaultPaths
				: [])
			.map((item) => String(item || "").trim().replace(/\\/g, "/").slice(0, 1000))
			.filter(Boolean)
			.slice(0, 30),
		webQueries: (Array.isArray(source.web_queries)
			? source.web_queries
			: Array.isArray(source.webQueries)
				? source.webQueries
				: [])
			.map((item) => String(item || "").trim().slice(0, 500))
			.filter(Boolean)
			.slice(0, 20),
		fallbackReason: String(source.fallback_reason || source.fallbackReason || "").slice(0, 1000),
	};
}

export type CitationValidationStatus =
	| "verified"
	| "structured"
	| "unverified"
	| "partial"
	| "invalid"
	| "not-applicable";

export interface QueryCitationValidation {
	status: CitationValidationStatus;
	sourceCount: number;
	citedCount: number;
	eventVerifiedCount: number;
	vaultSourceCount: number;
	vaultCitedCount: number;
	unlistedCitations: string[];
	uncitedSources: string[];
	unlistedVaultCitations: string[];
	uncitedVaultSources: string[];
	warnings: string[];
}

export function normalizeQueryCitationValidation(value: unknown): QueryCitationValidation {
	const source = asRecord(value);
	const allowedStatuses = new Set<CitationValidationStatus>([
		"verified",
		"structured",
		"unverified",
		"partial",
		"invalid",
		"not-applicable",
	]);
	const rawStatus = String(source.status || "") as CitationValidationStatus;
	const status = allowedStatuses.has(rawStatus) ? rawStatus : "not-applicable";
	const strings = (snakeCase: string, camelCase?: string, limit = 3000): string[] => {
		const snakeValue = source[snakeCase];
		const camelValue = camelCase ? source[camelCase] : undefined;
		const values = Array.isArray(snakeValue)
			? snakeValue
			: Array.isArray(camelValue)
				? camelValue
				: [];
		return values.map((item) => String(item || "").slice(0, limit)).slice(0, 20);
	};
	return {
		status,
		sourceCount: Math.max(0, Number(source.source_count ?? source.sourceCount) || 0),
		citedCount: Math.max(0, Number(source.cited_count ?? source.citedCount) || 0),
		eventVerifiedCount: Math.max(
			0,
			Number(source.event_verified_count ?? source.eventVerifiedCount) || 0,
		),
		vaultSourceCount: Math.max(
			0,
			Number(source.vault_source_count ?? source.vaultSourceCount) || 0,
		),
		vaultCitedCount: Math.max(
			0,
			Number(source.vault_cited_count ?? source.vaultCitedCount) || 0,
		),
		unlistedCitations: strings("unlisted_citations", "unlistedCitations"),
		uncitedSources: strings("uncited_sources", "uncitedSources"),
		unlistedVaultCitations: strings(
			"unlisted_vault_citations",
			"unlistedVaultCitations",
			1000,
		),
		uncitedVaultSources: strings(
			"uncited_vault_sources",
			"uncitedVaultSources",
			1000,
		),
		warnings: strings("warnings", undefined, 1000).filter(Boolean),
	};
}
