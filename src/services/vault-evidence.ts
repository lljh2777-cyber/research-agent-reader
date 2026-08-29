import { TFile, type App } from "obsidian";

import type { RetrievalTrace, VaultEvidencePacket } from "../query/direct-query-service";

const MAX_EVIDENCE_PACKETS = 8;
const MAX_EVIDENCE_TOTAL_CHARS = 48_000;
const MAX_EVIDENCE_FILE_CHARS = 9_000;

function resolveVaultFile(app: App, relativePath: string): TFile | null {
	const file = app?.vault?.getAbstractFileByPath?.(relativePath);
	return file instanceof TFile ? file : null;
}

/**
 * Reads Direct API evidence packets through the active Vault API only.
 * Candidate paths come from retrieval traces (toolkit script or in-plugin
 * lexical fallback) and can never escape the Vault because
 * `getAbstractFileByPath` resolves inside it; traversal segments simply fail
 * to resolve and are skipped. Each path is resolved as-is first, so a vault
 * that genuinely contains a top-level `knowledge-base/` folder is read
 * correctly; the legacy prefix strip only applies when the exact path does not
 * exist (older toolkit-era sessions recorded vault paths under that prefix).
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
		const normalizedPath = String(candidate || "")
			.replace(/\\/g, "/")
			.replace(/^\/+/, "")
			.slice(0, 1000);
		if (
			!normalizedPath
			|| normalizedPath.split("/").includes("..")
			|| !/\.md$/i.test(normalizedPath)
		) {
			continue;
		}
		let resolvedPath = normalizedPath;
		let file = resolveVaultFile(app, resolvedPath);
		if (!file) {
			const legacyPath = normalizedPath.replace(/^knowledge-base\//i, "");
			if (legacyPath && legacyPath !== normalizedPath) {
				file = resolveVaultFile(app, legacyPath);
				if (file) resolvedPath = legacyPath;
			}
		}
		if (!file || seen.has(resolvedPath.toLowerCase())) continue;
		let raw = "";
		try {
			raw = await app.vault.cachedRead(file);
		} catch {
			continue;
		}
		const content = raw.slice(0, Math.min(MAX_EVIDENCE_FILE_CHARS, remaining));
		if (!content.trim()) continue;
		seen.add(resolvedPath.toLowerCase());
		remaining -= content.length;
		evidence.push({
			path: resolvedPath,
			wikilink: `[[${resolvedPath.replace(/\.md$/i, "")}]]`,
			content,
		});
	}
	return evidence;
}
