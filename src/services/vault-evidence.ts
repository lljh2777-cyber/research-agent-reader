import { TFile, type App } from "obsidian";

import type { RetrievalTrace, VaultEvidencePacket } from "../query/direct-query-service";
import { contentHash, inKnowledgeScope } from "../retrieval/chunks";
import { ROLE_LABELS } from "../retrieval/types";

const MAX_EVIDENCE_PACKETS = 8;
const MAX_EVIDENCE_TOTAL_CHARS = 48_000;
const MAX_EVIDENCE_FILE_CHARS = 9_000;

function resolveVaultFile(app: App, relativePath: string): TFile | null {
	const file = app?.vault?.getAbstractFileByPath?.(relativePath);
	return file instanceof TFile ? file : null;
}

export interface ResolvedVaultSourcePath {
	path: string;
	file: TFile | null;
}

/**
 * Resolves a source path against the active Vault: the exact path wins; the
 * legacy `knowledge-base/` prefix strip only applies when the exact path does
 * not exist (older toolkit-era sessions recorded vault paths under that
 * prefix). Unresolvable paths keep their exact form.
 */
export function resolveVaultSourceFile(
	app: App,
	rawPath: string,
): ResolvedVaultSourcePath {
	const exactPath = String(rawPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
	const exactFile = resolveVaultFile(app, exactPath);
	if (exactFile) return { path: exactPath, file: exactFile };
	const legacyPath = exactPath.replace(/^knowledge-base\//i, "");
	if (legacyPath && legacyPath !== exactPath) {
		const legacyFile = resolveVaultFile(app, legacyPath);
		if (legacyFile) return { path: legacyPath, file: legacyFile };
	}
	return { path: exactPath, file: null };
}

/** Path-only variant for source normalization before dedupe and display. */
export function makeVaultSourcePathResolver(app: App): (rawPath: string) => string {
	return (rawPath) => resolveVaultSourceFile(app, rawPath).path;
}

/**
 * Reads Direct API evidence packets through the active Vault API only.
 * Candidate paths come from retrieval traces (toolkit script or in-plugin
 * lexical fallback) and can never escape the Vault because
 * `getAbstractFileByPath` resolves inside it; traversal segments simply fail
 * to resolve and are skipped. Paths are resolved via `resolveVaultSourceFile`
 * so a vault that genuinely contains a top-level `knowledge-base/` folder is
 * read correctly.
 */
export async function readVaultEvidencePackets(
	app: App,
	trace: RetrievalTrace,
): Promise<VaultEvidencePacket[]> {
	if (Array.isArray(trace.knowledge_passages)) {
		const groups = new Map<string, VaultEvidencePacket>(); const texts = new Map<string, string>();
		for (const hit of trace.knowledge_passages.slice(0, 20)) {
			if (!hit || typeof hit.path !== "string" || !Array.isArray(hit.origins)) continue;
			if (!inKnowledgeScope(hit.path) || trace.knowledge?.scope && !trace.knowledge.scope.includes(hit.path)) continue;
			const file = resolveVaultFile(app, hit.path); if (!file) continue;
			let raw = texts.get(hit.path); if (raw === undefined) { try { raw = await app.vault.cachedRead(file); texts.set(hit.path, raw); } catch { continue; } }
			if (contentHash(raw) !== hit.hash || !Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end > raw.length || hit.end <= hit.start || hit.end - hit.start > 2000) continue;
			const content = "章节：" + hit.heading + "\n内容角色：" + (ROLE_LABELS[hit.role] || "未标注") + "；深度：" + hit.depth + "；来源类型：" + hit.basis + "\n原始来源：" + (hit.origins.join("、") || "未标注独立来源") + "\n" + raw.slice(hit.start, hit.end);
			const prior = groups.get(hit.path);
			if (prior) { if (prior.content.length + content.length < MAX_EVIDENCE_FILE_CHARS) prior.content += "\n\n" + content; }
			else if (groups.size < MAX_EVIDENCE_PACKETS) groups.set(hit.path, { path: hit.path, wikilink: `[[${hit.path.replace(/\.md$/i, "")}]]`, content,
				role: ROLE_LABELS[hit.role], heading: hit.heading, origins: hit.origins, depth: hit.depth, hash: hit.hash, start: hit.start, end: hit.end });
		}
		return [...groups.values()];
	}
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
		const resolved = resolveVaultSourceFile(app, normalizedPath);
		if (!resolved.file || seen.has(resolved.path.toLowerCase())) continue;
		let raw = "";
		try {
			raw = await app.vault.cachedRead(resolved.file);
		} catch {
			continue;
		}
		const content = raw.slice(0, Math.min(MAX_EVIDENCE_FILE_CHARS, remaining));
		if (!content.trim()) continue;
		seen.add(resolved.path.toLowerCase());
		remaining -= content.length;
		evidence.push({
			path: resolved.path,
			wikilink: `[[${resolved.path.replace(/\.md$/i, "")}]]`,
			content,
		});
	}
	return evidence;
}
