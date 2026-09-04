import { createHash } from "node:crypto";

import type {
	MineruViewerBlock,
	MineruViewerIndex,
	MineruVisualRepair,
	MineruVisualRepairGroup,
	NormalizedBbox,
} from "./types";

type JsonScalar = string | number | boolean | null;

export interface MineruVisualCandidateGeometry {
	block_id: string;
	page_idx: number;
	page_order: number;
	bbox_norm: NormalizedBbox;
	role: string;
}

export interface MineruFragmentCandidate {
	candidate_id: string;
	kind: "fragment_group";
	review_state: "review";
	repair_group_id: string;
	page_idx: number;
	member_block_ids: string[];
	replacement_mode: "existing_asset" | "pdf_crop";
	base_confidence: number;
	evidence: {
		member_geometry: MineruVisualCandidateGeometry[];
		caption_anchor_block_ids: string[];
		signals: Record<string, JsonScalar>;
		reason_codes: string[];
		warning_codes: string[];
	};
}

export interface MineruVisualCandidates {
	schema_version: 1;
	contract: "mineru-visual-candidates";
	status: "ready" | "empty" | "invalid";
	inputs: {
		article: { sha256: string };
		mineru_result: { sha256: string };
		viewer_index_sha256: string;
		visual_repair_sha256: string;
	};
	policy: {
		allowed_verdicts: ["accept", "reject", "abstain"];
		minimum_accept_confidence: 0.85;
	};
	candidates: MineruFragmentCandidate[];
	issues: string[];
	candidate_package_sha256: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
const SIGNAL_KEYS = new Set([
	"member_count",
	"representative_count",
	"adjacent_pair_count",
	"caption_char_count",
	"long_caption_anchor_count",
	"figure_caption_anchor_count",
	"panel_label_count",
	"markdown_references_contiguous",
	"markdown_reference_coverage",
	"max_markdown_gap_chars",
	"union_area_fraction",
	"caption_anchored_component_count",
	"visual_only_page_exact_coverage",
]);

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("规范 JSON 不允许非有限数字");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("规范 JSON 含不支持的值");
}

function canonicalSha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function visualCandidatePackageSha256(
	value: Omit<MineruVisualCandidates, "candidate_package_sha256"> | MineruVisualCandidates,
): string {
	const material = { ...(value as MineruVisualCandidates) } as Partial<MineruVisualCandidates>;
	delete material.candidate_package_sha256;
	return canonicalSha256(material);
}

function inputHash(index: MineruViewerIndex | MineruVisualRepair, key: "article" | "mineru_result"): string {
	const value = String(index.inputs?.[key]?.sha256 || "").toLowerCase();
	return SHA256_RE.test(value) ? value : "";
}

function safeCodes(values: readonly string[] | undefined): string[] {
	return [...new Set((values || [])
		.map((value) => String(value || "").trim().toLowerCase())
		.filter((value) => SAFE_CODE_RE.test(value)))]
		.sort();
}

function safeSignals(value: Record<string, unknown> | undefined): Record<string, JsonScalar> {
	const result: Record<string, JsonScalar> = {};
	for (const key of [...SIGNAL_KEYS].sort()) {
		const item = value?.[key];
		if (item === null || typeof item === "string" || typeof item === "boolean") result[key] = item;
		else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
	}
	return result;
}

function geometry(block: MineruViewerBlock, pageIdx: number): MineruVisualCandidateGeometry | null {
	if (!block.bbox_norm) return null;
	return {
		block_id: block.id,
		page_idx: pageIdx,
		page_order: block.page_order,
		bbox_norm: [...block.bbox_norm] as NormalizedBbox,
		role: block.role,
	};
}

function fragmentCandidate(
	group: MineruVisualRepairGroup,
	blocks: ReadonlyMap<string, { block: MineruViewerBlock; pageIdx: number }>,
	inputs: MineruVisualCandidates["inputs"],
): MineruFragmentCandidate | null {
	if (group.decision !== "review" || !["existing_asset", "pdf_crop"].includes(group.replacement.mode)) return null;
	const located = group.member_block_ids.map((id) => blocks.get(id));
	if (located.some((entry) => !entry || entry.pageIdx !== group.page_idx)) return null;
	const memberGeometry = located.map((entry) => geometry(entry!.block, entry!.pageIdx));
	if (memberGeometry.some((entry) => !entry)) return null;
	const material = {
		kind: "fragment_group" as const,
		review_state: "review" as const,
		repair_group_id: group.id,
		page_idx: group.page_idx,
		member_block_ids: [...group.member_block_ids],
		replacement_mode: group.replacement.mode as "existing_asset" | "pdf_crop",
		base_confidence: Number(group.confidence.toFixed(6)),
		evidence: {
			member_geometry: memberGeometry as MineruVisualCandidateGeometry[],
			caption_anchor_block_ids: [...(group.caption_anchor_block_ids || [])],
			signals: safeSignals(group.signals),
			reason_codes: safeCodes(group.reason_codes),
			warning_codes: safeCodes(group.warning_codes),
		},
	};
	return {
		candidate_id: `candidate:${canonicalSha256({ material, inputs }).slice(0, 32)}`,
		...material,
	};
}

/**
 * Produce a bounded, prose-free review packet. It is never applied by the
 * reader; a future adjudicator may only refer to candidate IDs and return a
 * verdict. Auto groups and raw asset paths are deliberately excluded.
 */
export function buildVisualCandidates(
	viewerIndex: MineruViewerIndex,
	visualRepair: MineruVisualRepair,
): MineruVisualCandidates {
	const articleHash = inputHash(viewerIndex, "article");
	const mineruHash = inputHash(viewerIndex, "mineru_result");
	const issues: string[] = [];
	if (!articleHash || !mineruHash) issues.push("missing_viewer_input_hash");
	if (inputHash(visualRepair, "article") !== articleHash) issues.push("article_hash_mismatch");
	if (inputHash(visualRepair, "mineru_result") !== mineruHash) issues.push("mineru_result_hash_mismatch");
	const inputs: MineruVisualCandidates["inputs"] = {
		article: { sha256: articleHash },
		mineru_result: { sha256: mineruHash },
		viewer_index_sha256: canonicalSha256(viewerIndex),
		visual_repair_sha256: canonicalSha256(visualRepair),
	};
	const blocks = new Map<string, { block: MineruViewerBlock; pageIdx: number }>();
	viewerIndex.pages.forEach((page) => page.blocks.forEach((block) => blocks.set(block.id, { block, pageIdx: page.page_idx })));
	const candidates: MineruFragmentCandidate[] = [];
	if (!issues.length) {
		for (const group of visualRepair.groups) {
			if (group.decision !== "review") continue;
			const candidate = fragmentCandidate(group, blocks, inputs);
			if (candidate) candidates.push(candidate);
			else issues.push("review_group_not_locatable");
		}
	}
	candidates.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
	const material: Omit<MineruVisualCandidates, "candidate_package_sha256"> = {
		schema_version: 1,
		contract: "mineru-visual-candidates",
		status: issues.length ? "invalid" : candidates.length ? "ready" : "empty",
		inputs,
		policy: {
			allowed_verdicts: ["accept", "reject", "abstain"],
			minimum_accept_confidence: 0.85,
		},
		candidates,
		issues: [...new Set(issues)].sort(),
	};
	return { ...material, candidate_package_sha256: visualCandidatePackageSha256(material) };
}

/** Rebuild the complete expected packet; self-consistent but stale edits fail. */
export function validateVisualCandidates(
	payload: MineruVisualCandidates,
	viewerIndex: MineruViewerIndex,
	visualRepair: MineruVisualRepair,
): string[] {
	const errors: string[] = [];
	let expected: MineruVisualCandidates;
	try {
		expected = buildVisualCandidates(viewerIndex, visualRepair);
		const { candidate_package_sha256: _digest, ...material } = payload;
		if (!SHA256_RE.test(payload.candidate_package_sha256)
			|| visualCandidatePackageSha256(material) !== payload.candidate_package_sha256) {
			errors.push("视觉候选契约规范哈希不匹配");
		}
		if (canonicalJson(payload) !== canonicalJson(expected)) errors.push("视觉候选契约不是由当前输入规范重建所得");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
		return errors;
	}
	if (payload.status === "invalid") errors.push("视觉候选契约输入无效");
	if (payload.candidates.length > 4096) errors.push("视觉候选数超过安全上限");
	if (new Set(payload.candidates.map((candidate) => candidate.candidate_id)).size !== payload.candidates.length) {
		errors.push("视觉候选 ID 重复");
	}
	return [...new Set(errors)];
}
