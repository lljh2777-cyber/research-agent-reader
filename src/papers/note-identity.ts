import type { ResolvedIdentity } from "./identity";

/** Normalize note properties before comparison; no matching digest may override a conflicting ID. */
export function noteIdentifiers(metadata: Record<string, unknown>): ResolvedIdentity["identifiers"] {
	return {
		doi: String(metadata.doi || "").trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").trim().toLowerCase(),
		pmid: String(metadata.pmid || "").trim().replace(/^PMID:\s*/i, "").trim(),
		pmcid: String(metadata.pmcid || "").trim().replace(/^PMCID:\s*/i, "").trim().toUpperCase(),
	};
}
export function conflictingNoteIdentifiers(identity: ResolvedIdentity, metadata: Record<string, unknown>): boolean {
	const ids = noteIdentifiers(metadata);
	return (["doi", "pmid", "pmcid"] as const).some(k => !!ids[k] && !!identity.identifiers[k] && ids[k] !== identity.identifiers[k]);
}
