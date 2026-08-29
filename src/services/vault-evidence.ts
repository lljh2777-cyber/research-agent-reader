import { TFile, type App } from "obsidian";

import type { RetrievalTrace, VaultEvidencePacket } from "../query/direct-query-service";

const MAX_EVIDENCE_PACKETS = 8;
const MAX_EVIDENCE_TOTAL_CHARS = 48_000;
const MAX_EVIDENCE_FILE_CHARS = 9_000;

/**
 * Reads Direct API evidence packets through the active Vault API only.
 * Candidate paths come from retrieval traces (toolkit script or in-plugin
 * lexical fallback) and can never escape the Vault because
 * `getAbstractFileByPath` resolves inside it; traversal segments simply fail
 * to resolve and are skipped. The `knowledge-base/` prefix strip keeps
 * evidence paths recorded by older toolkit-era sessions readable.
 */
export async function readVaultEvidencePackets(
	app: App,
	trace: RetrievalTrace,
): Promise<VaultEvidencePacket[]> {
	const candidates = Array.isArray(trace?.candidate_paths) ? trace.candidate_paths : [];
	const evidence: VaultEvidencePacket[] = [];
	const seen = new Set<string>();
	let remaining = MAX_EVIDENCE_TOTAL_CHARS;
	for (const candidate of candidates) {
		if (evidence.length >= MAX_EVIDENCE_PACKETS || remaining <= 0) break;
		const relativePath = String(candidate || "")
			.replace(/\\/g, "/")
			.replace(/^knowledge-base\//i, "")
			.replace(/^\/+/, "");
		if (
			!relativePath
			|| relativePath.split("/").includes("..")
			|| !/\.md$/i.test(relativePath)
			|| seen.has(relativePath.toLowerCase())
		) {
			continue;
		}
		const file = app?.vault?.getAbstractFileByPath?.(relativePath);
		if (!(file instanceof TFile)) continue;
		let raw = "";
		try {
			raw = await app.vault.cachedRead(file);
		} catch {
			continue;
		}
		const content = raw.slice(0, Math.min(MAX_EVIDENCE_FILE_CHARS, remaining));
		if (!content.trim()) continue;
		seen.add(relativePath.toLowerCase());
		remaining -= content.length;
		evidence.push({
			path: relativePath,
			wikilink: `[[${relativePath.replace(/\.md$/i, "")}]]`,
			content,
		});
	}
	return evidence;
}
