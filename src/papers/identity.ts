import { createHash } from "node:crypto";

/** Exact source metadata; independent of model-generated prose and Crossref availability. */
export interface ResolvedIdentity {
	title: string; authors: string[]; year: string;
	identifiers: { doi?: string; pmid?: string; pmcid?: string };
	publicationTypes: string[];
	evidence: Array<{ provider: "europe-pmc" | "crossref"; recordId: string; observedAt: string; fields: string[] }>;
	warnings: string[];
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
	if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a<b?-1:a>b?1:0).map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
	return JSON.stringify(value);
}
export const bytesDigest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const objectDigest = (value: unknown): string => bytesDigest(canonicalJson(value));
export const identityDigest = (identity: ResolvedIdentity): string => objectDigest(identity);
export function identityRelation(a: ResolvedIdentity["identifiers"], b: ResolvedIdentity["identifiers"]): "same" | "conflict" | "unrelated" {
	const keys = ["doi", "pmid", "pmcid"] as const;
	if (!keys.some(k => a[k] && a[k] === b[k])) return "unrelated";
	return keys.some(k => a[k] && b[k] && a[k] !== b[k]) ? "conflict" : "same";
}
export const safeCitekey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
export function sourceCitekey(identity: ResolvedIdentity): string {
	const author = (identity.authors[0] || "paper").normalize("NFKD").replace(/[^a-zA-Z0-9 ]/g, "").trim().split(/\s+/).pop() || "paper";
	return `${author.slice(0,24).toLowerCase()}_${identity.year || "undated"}_${objectDigest(identity.identifiers).slice(0,8)}`;
}
