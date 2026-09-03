import { createHash } from "node:crypto";

import { App, TFile, normalizePath } from "obsidian";

import {
	buildRuntimeViewerIndex,
	MINERU_VIEWER_LIMITS,
	normalizeAssetPath,
	normalizeBbox,
	reclassifyRuntimeRunningHeaders,
} from "./normalization";
import {
	mergeStandaloneCaptionRepairGroups,
	resolveVisualCaptionDetails,
	visualLabelFromCaption,
} from "./reader-markdown";
import {
	buildRuntimeVisualRepair,
	CURRENT_VISUAL_REPAIR_ALGORITHM,
	isSupportedVisualRepairAlgorithm,
	validateVisualContracts,
} from "./visual-repair";
import { MINERU_RESOURCE_LIMITS, parseBoundedJson } from "./resource-limits";
import { assertPassiveMineruMarkdown } from "../security/safe-markdown";
import { readTrustedVaultFile, resolveTrustedVaultPath } from "../runtime/trusted-vault-fs";
import type { VaultFilesystemAdapter } from "../runtime/trusted-vault-fs";
import type {
	MineruReaderPackage,
	MineruReaderVisual,
	MineruRepairDecision,
	MineruReplacementMode,
	MineruCaptionLink,
	MineruCaptionPart,
	MineruNextPagePlaceholder,
	MineruViewerBlock,
	MineruViewerIndex,
	MineruViewerPage,
	MineruVisualRepair,
	MineruVisualRepairGroup,
	NormalizedBbox,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const MIB = 1024 * 1024;
const MAX_ARTICLE_BYTES = MINERU_RESOURCE_LIMITS.articleBytes;
const MAX_MINERU_JSON_BYTES = MINERU_RESOURCE_LIMITS.mineruJsonBytes;
const MAX_CONTRACT_BYTES = MINERU_RESOURCE_LIMITS.contractBytes;
const MAX_MANIFEST_BYTES = MINERU_RESOURCE_LIMITS.manifestBytes;
const MAX_VALIDATION_BYTES = MINERU_RESOURCE_LIMITS.validationBytes;
const MAX_PDF_BYTES = MINERU_RESOURCE_LIMITS.pdfBytes;
const MAX_OUTPUT_ASSET_BYTES = MINERU_RESOURCE_LIMITS.outputAssetBytes;
const MAX_MANIFEST_RECORDS = MINERU_RESOURCE_LIMITS.manifestRecords;
const MAX_PACKAGE_TOTAL_BYTES = MINERU_RESOURCE_LIMITS.packageTotalBytes;
const MAX_IMAGE_COUNT = MINERU_RESOURCE_LIMITS.imageCount;
const MAX_IMAGE_TOTAL_BYTES = MINERU_RESOURCE_LIMITS.imageTotalBytes;
const MAX_IMAGE_PIXELS = MINERU_RESOURCE_LIMITS.imagePixels;
const MAX_IMAGE_TOTAL_PIXELS = MINERU_RESOURCE_LIMITS.imageTotalPixels;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as UnknownRecord
		: {};
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	if (value.length > MINERU_VIEWER_LIMITS.maxNestedStrings) {
		throw new Error("Viewer Index 嵌套字符串数组超过安全上限");
	}
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length > 2_000) {
			throw new Error("Viewer Index 嵌套字符串值无效或过长");
		}
		const text = item.trim();
		if (text) result.push(text);
	}
	return result;
}

const CAPTION_PART_KINDS = new Set<MineruCaptionPart["kind"]>([
	"formal-caption",
	"next-page-placeholder",
	"panel-label",
	"caption-continuation",
	"other",
]);

function normalizeCaptionParts(
	value: unknown,
	fallback: readonly MineruCaptionPart[] = [],
): MineruCaptionPart[] | null {
	if (value === undefined) return fallback.map((part) => ({ ...part }));
	if (!Array.isArray(value) || value.length > MINERU_VIEWER_LIMITS.maxNestedStrings) return null;
	const parts: MineruCaptionPart[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const record = asRecord(value[index]);
		const rawText = record.text;
		if (typeof rawText !== "string" || rawText.length > 2_000) return null;
		const text = rawText.trim();
		const kind = String(record.kind || "") as MineruCaptionPart["kind"];
		const declaredIndex = record.index;
		if (
			!text
			|| !CAPTION_PART_KINDS.has(kind)
			|| (declaredIndex !== undefined && Number(declaredIndex) !== index)
		) return null;
		parts.push({ text, kind });
	}
	return parts;
}

function normalizeNextPagePlaceholders(
	value: unknown,
	fallback: readonly MineruNextPagePlaceholder[] = [],
): MineruNextPagePlaceholder[] | null {
	if (value === undefined) return (fallback || []).map((placeholder) => ({ ...placeholder }));
	if (!Array.isArray(value) || value.length > MINERU_VIEWER_LIMITS.maxNestedStrings) return null;
	const placeholders: MineruNextPagePlaceholder[] = [];
	for (const item of value) {
		const record = asRecord(item);
		const index = Number(record.index);
		const text = String(record.text || "").trim();
		const figureKey = String(record.figure_key || "").trim().toLowerCase();
		if (
			!Number.isInteger(index)
			|| index < 0
			|| !text
			|| !/^(?:figure|extended-data-figure|supplementary-figure|supporting-figure|图):[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(figureKey)
		) return null;
		placeholders.push({ index, text, figure_key: figureKey });
	}
	return placeholders;
}

function normalizeMarkdownTextRange(
	value: unknown,
	fallback?: MineruViewerBlock["markdown_text_range"],
): MineruViewerBlock["markdown_text_range"] | null | undefined {
	if (value === undefined) return fallback ? { ...fallback } : undefined;
	const record = asRecord(value);
	const start = Number(record.start);
	const end = Number(record.end);
	if (
		record.offset_unit !== "utf16-code-unit"
		|| !Number.isInteger(start)
		|| !Number.isInteger(end)
		|| start < 0
		|| end <= start
	) return null;
	return { offset_unit: "utf16-code-unit", start, end };
}

function issueText(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 2_000);
	const record = asRecord(value);
	return String(record.message || record.code || "不受支持的 issue 记录").slice(0, 2_000);
}

function boundedStringArray(value: unknown, maxItems: number, maxChars = 2_000): string[] | null {
	if (!Array.isArray(value) || value.length > maxItems) return null;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length > maxChars) return null;
		const text = item.trim();
		if (text) result.push(text);
	}
	return result;
}

function safeScalarSignals(value: unknown): Record<string, string | number | boolean | null> | null {
	const record = asRecord(value);
	const entries = Object.entries(record);
	if (entries.length > 64) return null;
	const result: Record<string, string | number | boolean | null> = {};
	for (const [key, item] of entries) {
		if (!/^[a-z0-9_.-]{1,80}$/i.test(key)) return null;
		if (typeof item === "string") {
			if (item.length > 500) return null;
			result[key] = item;
		} else if (typeof item === "number") {
			if (!Number.isFinite(item)) return null;
			result[key] = item;
		} else if (typeof item === "boolean" || item === null) {
			result[key] = item;
		} else {
			return null;
		}
	}
	return result;
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(value: ArrayBuffer | Uint8Array): string {
	return new TextDecoder("utf-8").decode(value instanceof Uint8Array ? value : new Uint8Array(value));
}

function parseJson(value: string, label: string): unknown {
	return parseBoundedJson(value, label);
}

function normalizePackageArticlePath(value: string): string {
	const path = normalizePath(value.trim());
	if (!/^papers\/[^/]+\/article\.md$/i.test(path)) {
		throw new Error("MinerU 阅读器只能打开 papers/<citekey>/article.md");
	}
	return path;
}

function packagePathFromArticle(articlePath: string): string {
	return articlePath.slice(0, -"/article.md".length);
}

export function resolvePackageAssetPath(packagePath: string, rawPath: string): string {
	const assetPath = normalizeAssetPath(rawPath);
	if (!assetPath) return "";
	const resolved = normalizePath(`${packagePath}/${assetPath}`);
	return resolved.startsWith(`${packagePath}/`) ? resolved : "";
}

function findTFile(app: App, path: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	return file instanceof TFile ? file : null;
}

function filesystemAdapter(app: App): VaultFilesystemAdapter {
	return app.vault.adapter as unknown as VaultFilesystemAdapter;
}

async function assertPackageFileNoFollow(app: App, packagePath: string, file: TFile): Promise<void> {
	const normalizedFile = normalizePath(file.path);
	if (!normalizedFile.startsWith(`${packagePath}/`)) throw new Error(`原文包资产越出包根：${file.path}`);
	await resolveTrustedVaultPath(filesystemAdapter(app), packagePath, { expectedType: "directory" });
	await resolveTrustedVaultPath(filesystemAdapter(app), normalizedFile, { expectedType: "file" });
}

async function readRequiredBinary(
	app: App,
	path: string,
	label: string,
	maxBytes = MAX_MINERU_JSON_BYTES,
	packagePath = "",
): Promise<{ file: TFile; bytes: Uint8Array; text: string }> {
	const file = findTFile(app, path);
	if (!file) throw new Error(`缺少 ${label}：${path}`);
	if (packagePath) await assertPackageFileNoFollow(app, packagePath, file);
	if (file.stat.size > maxBytes) {
		throw new Error(`${label} 超过阅读器安全上限（${Math.round(maxBytes / MIB)} MiB）：${path}`);
	}
	const bytes = new Uint8Array(await readTrustedVaultFile(filesystemAdapter(app), path, maxBytes));
	return { file, bytes, text: decodeUtf8(bytes) };
}

async function readOptionalJson(
	app: App,
	path: string,
	maxBytes = MAX_CONTRACT_BYTES,
	packagePath = "",
): Promise<unknown | null> {
	const file = findTFile(app, path);
	if (!file) return null;
	if (packagePath) await assertPackageFileNoFollow(app, packagePath, file);
	if (file.stat.size > maxBytes) throw new Error(`${path} 超过阅读器安全上限`);
	const bytes = new Uint8Array(await readTrustedVaultFile(filesystemAdapter(app), path, maxBytes));
	if (bytes.byteLength > maxBytes) throw new Error(`${path} 实际读取结果超过阅读器安全上限`);
	return parseJson(decodeUtf8(bytes), path);
}

async function readOptionalDerivedJson(
	app: App,
	path: string,
	issues: string[],
	manifestRecord?: UnknownRecord,
	packagePath = "",
): Promise<unknown | null> {
	try {
		const file = findTFile(app, path);
		if (!file) {
			if (manifestRecord) throw new Error("manifest.json 已登记该文件，但文件不存在");
			return null;
		}
		if (packagePath) await assertPackageFileNoFollow(app, packagePath, file);
		if (!manifestRecord) throw new Error("manifest.json 未登记该派生文件");
		if (file.stat.size > MAX_CONTRACT_BYTES || Number(manifestRecord.size) !== file.stat.size) {
			throw new Error("文件大小与 manifest.json 不一致或超过安全上限");
		}
		const bytes = new Uint8Array(await readTrustedVaultFile(filesystemAdapter(app), path, MAX_CONTRACT_BYTES));
		if (bytes.byteLength > MAX_CONTRACT_BYTES || bytes.byteLength !== file.stat.size) {
			throw new Error("文件实际读取长度与记录不一致或超过安全上限");
		}
		const expectedHash = String(manifestRecord.sha256 || "").toLowerCase();
		if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(bytes) !== expectedHash) {
			throw new Error("文件哈希与 manifest.json 不一致");
		}
		return parseJson(decodeUtf8(bytes), path);
	} catch (error) {
		issues.push(`${path} 无法解析，已回退到原始 MinerU 产物：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function normalizeBlock(value: unknown, fallback?: MineruViewerBlock): MineruViewerBlock | null {
	const record = asRecord(value);
	const id = String(record.id || fallback?.id || "").trim();
	const sourceIndex = Number(record.source_index ?? fallback?.source_index ?? -1);
	const pageOrder = Number(record.page_order ?? fallback?.page_order ?? 0);
	if (!id || !Number.isInteger(sourceIndex) || sourceIndex < 0) return null;
	const captionRecord = asRecord(record.caption);
	const captionParts = normalizeCaptionParts(
		captionRecord.items ?? captionRecord.parts,
		fallback?.caption?.parts || [],
	);
	if (captionParts === null) return null;
	const captionNextPagePlaceholders = normalizeNextPagePlaceholders(
		captionRecord.next_page_placeholders,
		fallback?.caption?.next_page_placeholders,
	);
	if (captionNextPagePlaceholders === null) return null;
	const markdownTextRange = normalizeMarkdownTextRange(
		record.markdown_text_range,
		fallback?.markdown_text_range,
	);
	if (markdownTextRange === null) return null;
	// Table ranges are always recomputed from the verified article.md fallback.
	// A stored derived contract may inherit that range, but cannot introduce one.
	const markdownTableRange = fallback?.markdown_table_range
		? { ...fallback.markdown_table_range }
		: undefined;
	const captionText = String(captionRecord.text || fallback?.caption?.text || "").trim()
		|| captionParts.map((part) => part.text).join(" ").replace(/\s+/g, " ").trim();
	const captionFigureKeys = asStringArray(captionRecord.figure_keys).length
		? asStringArray(captionRecord.figure_keys)
		: [...(fallback?.caption?.figure_keys || [])];
	const captionLeadingFigureKey = String(
		captionRecord.leading_figure_key || fallback?.caption?.leading_figure_key || "",
	).trim().toLowerCase();
	const captionNextPageMarker = typeof captionRecord.next_page_marker === "boolean"
		? captionRecord.next_page_marker
		: Boolean(fallback?.caption?.next_page_marker);
	const captionNextPageFigureKeys = asStringArray(captionRecord.next_page_figure_keys).length
		? asStringArray(captionRecord.next_page_figure_keys)
		: [...(fallback?.caption?.next_page_figure_keys || [])];
	const captionFormalFigureKeys = asStringArray(captionRecord.formal_figure_caption_keys).length
		? asStringArray(captionRecord.formal_figure_caption_keys)
		: [...(fallback?.caption?.formal_figure_caption_keys || [])];
	const textRecord = asRecord(record.text);
	const blockText = String(textRecord.text || fallback?.text?.text || "").trim();
	const textFigureKeys = asStringArray(textRecord.figure_keys).length
		? asStringArray(textRecord.figure_keys)
		: [...(fallback?.text?.figure_keys || [])];
	const textLeadingFigureKey = String(
		textRecord.leading_figure_key || fallback?.text?.leading_figure_key || "",
	).trim().toLowerCase();
	const textFormalFigureKeys = asStringArray(textRecord.formal_figure_caption_keys).length
		? asStringArray(textRecord.formal_figure_caption_keys)
		: [...(fallback?.text?.formal_figure_caption_keys || [])];
	const assetPath = normalizeAssetPath(record.asset_path ?? fallback?.asset_path);
	const bbox = normalizeBbox(record.bbox_norm ?? record.bbox, false) || fallback?.bbox_norm || null;
	const rawRole = String(record.role || fallback?.role || "other");
	const role = (rawRole === "marginalia" ? "discarded" : rawRole) as MineruViewerBlock["role"];
	return {
		id,
		source_index: sourceIndex,
		page_order: Number.isFinite(pageOrder) ? pageOrder : 0,
		source_type: String(record.source_type || fallback?.source_type || "unknown"),
		role: ["text", "title", "visual", "table", "equation", "discarded", "other"].includes(role)
			? role
			: "other",
		bbox_norm: bbox,
		...(assetPath ? { asset_path: assetPath } : {}),
		...(captionText || captionParts.length || fallback?.caption
			? {
				caption: {
					text: captionText,
					parts: captionParts,
					char_count: Number(captionRecord.char_count || captionText.length || fallback?.caption?.char_count || 0),
					item_count: Number(captionRecord.item_count || fallback?.caption?.item_count || 0),
					figure_keys: captionFigureKeys,
					leading_figure_key: captionLeadingFigureKey || undefined,
					formal_figure_caption_keys: captionFormalFigureKeys,
					leading_formal_figure_caption_key: String(
						captionRecord.leading_formal_figure_caption_key
						|| fallback?.caption?.leading_formal_figure_caption_key
						|| "",
					).trim().toLowerCase() || undefined,
					next_page_marker: captionNextPageMarker,
					next_page_figure_keys: captionNextPageFigureKeys,
					next_page_placeholders: captionNextPagePlaceholders,
					ends_with_terminal_punctuation: typeof captionRecord.ends_with_terminal_punctuation === "boolean"
						? captionRecord.ends_with_terminal_punctuation
						: fallback?.caption?.ends_with_terminal_punctuation,
					starts_with_lowercase: typeof captionRecord.starts_with_lowercase === "boolean"
						? captionRecord.starts_with_lowercase
						: fallback?.caption?.starts_with_lowercase,
					starts_with_panel_label: typeof captionRecord.starts_with_panel_label === "boolean"
						? captionRecord.starts_with_panel_label
						: fallback?.caption?.starts_with_panel_label,
					long_item_count: Number(captionRecord.long_item_count ?? fallback?.caption?.long_item_count ?? 0),
					figure_anchor_count: Number(captionRecord.figure_anchor_count ?? fallback?.caption?.figure_anchor_count ?? 0),
					panel_label_count: Number(captionRecord.panel_label_count ?? fallback?.caption?.panel_label_count ?? 0),
					next_page_reference_count: Number(
						captionRecord.next_page_reference_count
						?? fallback?.caption?.next_page_reference_count
						?? (captionNextPageMarker ? 1 : 0),
					),
				},
			}
			: {}),
		...(blockText || fallback?.text
			? {
				text: {
					text: blockText,
					char_count: Number(textRecord.char_count || blockText.length || fallback?.text?.char_count || 0),
					item_count: Number(textRecord.item_count || fallback?.text?.item_count || 0),
					figure_keys: textFigureKeys,
					leading_figure_key: textLeadingFigureKey || undefined,
					formal_figure_caption_keys: textFormalFigureKeys,
					leading_formal_figure_caption_key: String(
						textRecord.leading_formal_figure_caption_key
						|| fallback?.text?.leading_formal_figure_caption_key
						|| "",
					).trim().toLowerCase() || undefined,
					next_page_marker: typeof textRecord.next_page_marker === "boolean"
						? textRecord.next_page_marker
						: Boolean(fallback?.text?.next_page_marker),
					next_page_figure_keys: asStringArray(textRecord.next_page_figure_keys).length
						? asStringArray(textRecord.next_page_figure_keys)
						: [...(fallback?.text?.next_page_figure_keys || [])],
					starts_with_lowercase: typeof textRecord.starts_with_lowercase === "boolean"
						? textRecord.starts_with_lowercase
						: fallback?.text?.starts_with_lowercase,
					starts_with_panel_label: typeof textRecord.starts_with_panel_label === "boolean"
						? textRecord.starts_with_panel_label
						: fallback?.text?.starts_with_panel_label,
					ends_with_terminal_punctuation: typeof textRecord.ends_with_terminal_punctuation === "boolean"
						? textRecord.ends_with_terminal_punctuation
						: fallback?.text?.ends_with_terminal_punctuation,
				},
			}
			: {}),
		markdown_image_ids: asStringArray(record.markdown_image_ids).length
			? asStringArray(record.markdown_image_ids)
			: [...(fallback?.markdown_image_ids || [])],
		...(markdownTextRange ? { markdown_text_range: markdownTextRange } : {}),
		...(markdownTableRange ? { markdown_table_range: markdownTableRange } : {}),
	};
}

function normalizeViewerIndex(value: unknown, fallback: MineruViewerIndex): MineruViewerIndex | null {
	const record = asRecord(value);
	if (
		Number(record.schema_version) !== 1
		|| !Array.isArray(record.pages)
		|| record.pages.length === 0
		|| record.pages.length > MINERU_VIEWER_LIMITS.maxPages
		|| (Array.isArray(record.markdown_images)
			&& record.markdown_images.length > MINERU_VIEWER_LIMITS.maxMarkdownImages)
		|| (Array.isArray(record.issues) && record.issues.length > MINERU_VIEWER_LIMITS.maxIssues)
	) return null;
	let totalBlocks = 0;
	for (const pageValue of record.pages) {
		const blocks = asRecord(pageValue).blocks;
		if (!Array.isArray(blocks) || blocks.length > MINERU_VIEWER_LIMITS.maxBlocksPerPage) return null;
		totalBlocks += blocks.length;
		if (totalBlocks > MINERU_VIEWER_LIMITS.maxSourceElements) return null;
	}
	const fallbackBySource = new Map<number, MineruViewerBlock>();
	fallback.pages.forEach((page) => page.blocks.forEach((block) => fallbackBySource.set(block.source_index, block)));
	const pages: MineruViewerPage[] = [];
	for (const pageValue of record.pages) {
		const pageRecord = asRecord(pageValue);
		const pageIdx = Number(pageRecord.page_idx);
		if (!Number.isInteger(pageIdx) || pageIdx < 0 || !Array.isArray(pageRecord.blocks)) continue;
		const normalizedBlocks = pageRecord.blocks
			.map((blockValue) => {
				const sourceIndex = Number(asRecord(blockValue).source_index);
				return normalizeBlock(blockValue, fallbackBySource.get(sourceIndex));
			});
		if (normalizedBlocks.some((block) => block === null)) return null;
		const blocks = normalizedBlocks as MineruViewerBlock[];
		pages.push({ page_idx: pageIdx, blocks });
	}
	if (!pages.length) return null;
	const markdownImages = Array.isArray(record.markdown_images)
		? record.markdown_images.map((value, order) => {
			const image = asRecord(value);
			return {
				id: String(image.id || `md-img-${String(order).padStart(4, "0")}`),
				order: Number(image.order ?? order),
				asset_path: normalizeAssetPath(image.asset_path),
				occurrence: Number(image.occurrence || 0),
				char_start: Number.isInteger(image.char_start) ? Number(image.char_start) : undefined,
				char_end: Number.isInteger(image.char_end) ? Number(image.char_end) : undefined,
			};
		}).filter((image) => image.asset_path)
		: fallback.markdown_images;
	return {
		schema_version: 1,
		status: record.status === "unavailable" ? "unavailable" : record.status === "partial" ? "partial" : "complete",
		inputs: asRecord(record.inputs) as MineruViewerIndex["inputs"],
		coordinate_system: asRecord(record.coordinate_system) as MineruViewerIndex["coordinate_system"],
		pdf_source: asRecord(record.pdf_source) as MineruViewerIndex["pdf_source"],
		markdown_images: markdownImages,
		// Markdown caption ranges are always rebuilt from the verified article.md;
		// a stored sidecar cannot introduce or rewrite logical figure ownership.
		markdown_captions: [...(fallback.markdown_captions || [])],
		pages: pages.sort((a, b) => a.page_idx - b.page_idx),
		issues: Array.isArray(record.issues) ? record.issues.map(issueText) : [],
	};
}

function normalizeDecision(value: unknown): MineruRepairDecision {
	if (value === "auto") return "auto";
	if (value === "review") return "review";
	if (value === "skip") return "skip";
	return "keep-original";
}

function normalizeReplacementMode(value: unknown): MineruReplacementMode {
	if (value === "existing_asset") return "existing_asset";
	if (value === "pdf_crop") return "pdf_crop";
	return "none";
}

function normalizeCaptionLink(value: unknown): MineruCaptionLink | null {
	const record = asRecord(value);
	const visualBlockId = String(record.visual_block_id || "").trim();
	const captionBlockIds = asStringArray(record.caption_block_ids);
	const sourcePageIdx = Number(record.source_page_idx);
	const targetPageIdx = Number(record.target_page_idx);
	const figureKey = String(record.figure_key || "").trim().toLowerCase();
	const relation = String(record.relation || "");
	const status = record.status === "partial" ? "partial" : record.status === "complete" ? "complete" : "";
	if (
		!visualBlockId
		|| !captionBlockIds.length
		|| !Number.isInteger(sourcePageIdx)
		|| !Number.isInteger(targetPageIdx)
		|| sourcePageIdx < 0
		|| targetPageIdx !== sourcePageIdx + 1
		|| !/^(?:figure|extended-data-figure|supplementary-figure|supporting-figure|图):[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(figureKey)
		|| relation !== "next_page_figure_caption"
		|| !status
	) return null;
	return {
		visual_block_id: visualBlockId,
		caption_block_ids: captionBlockIds,
		source_page_idx: sourcePageIdx,
		target_page_idx: targetPageIdx,
		figure_key: figureKey,
		relation: "next_page_figure_caption",
		status,
	};
}

function normalizeRepair(value: unknown): MineruVisualRepair | null {
	const record = asRecord(value);
	if (Number(record.schema_version) !== 1
		|| !Array.isArray(record.groups)
		|| record.groups.length > 4_096) return null;
	const algorithmVersion = String(record.algorithm_version || "");
	if (!isSupportedVisualRepairAlgorithm(algorithmVersion)) return null;
	const groups = record.groups.map((value): MineruVisualRepairGroup | null => {
		const group = asRecord(value);
		const replacement = asRecord(group.replacement);
		const id = String(group.id || "").trim();
		const pageIdx = Number(group.page_idx);
		const memberBlockIds = boundedStringArray(group.member_block_ids, 512);
		const memberAssetPaths = boundedStringArray(group.member_asset_paths ?? [], 512);
		const memberMarkdownImageIds = boundedStringArray(group.member_markdown_image_ids ?? [], 512);
		const captionAnchorBlockIds = boundedStringArray(group.caption_anchor_block_ids ?? [], 512);
		const reasonCodes = boundedStringArray(group.reason_codes ?? [], 256, 200);
		const warningCodes = boundedStringArray(group.warning_codes ?? [], 256, 200);
		const signals = safeScalarSignals(group.signals);
		if (!memberBlockIds || !memberAssetPaths || !memberMarkdownImageIds
			|| !captionAnchorBlockIds || !reasonCodes || !warningCodes || !signals) return null;
		if (!id || !Number.isInteger(pageIdx) || pageIdx < 0 || memberBlockIds.length < 2) return null;
		const bbox = normalizeBbox(replacement.bbox_norm ?? replacement.bbox);
		const assetPath = normalizeAssetPath(
			replacement.asset_path ?? replacement.existing_asset_path,
		);
		return {
			id,
			page_idx: pageIdx,
			figure_key: String(group.figure_key || "").trim().toLowerCase() || undefined,
			member_block_ids: memberBlockIds,
			member_asset_paths: memberAssetPaths,
			member_markdown_image_ids: memberMarkdownImageIds,
			decision: normalizeDecision(group.decision),
			confidence: Math.max(0, Math.min(1, Number(group.confidence || 0))),
			replacement: {
				mode: normalizeReplacementMode(replacement.mode),
				block_id: String(replacement.block_id || "").trim() || undefined,
				...(bbox ? { bbox_norm: bbox } : {}),
				padding_norm: Math.max(0, Math.min(40, Number(replacement.padding_norm || 0))),
				...(assetPath ? { asset_path: assetPath } : {}),
			},
			caption_anchor_block_ids: captionAnchorBlockIds,
			signals,
			reason_codes: reasonCodes,
			warning_codes: warningCodes,
			fallback: String(group.fallback || "original_assets"),
		};
	}).filter((group): group is MineruVisualRepairGroup => Boolean(group));
	const rawCaptionLinks = Array.isArray(record.caption_links) ? record.caption_links : [];
	if (rawCaptionLinks.length > 4_096) return null;
	const captionLinks = rawCaptionLinks
		.map(normalizeCaptionLink)
		.filter((link): link is MineruCaptionLink => Boolean(link));
	if (rawCaptionLinks.length !== captionLinks.length) return null;
	return {
		schema_version: 1,
		algorithm_version: algorithmVersion,
		viewer_index: String(record.viewer_index || "viewer-index.json"),
		status: record.status === "unavailable" ? "unavailable" : record.status === "partial" ? "partial" : "complete",
		inputs: asRecord(record.inputs) as MineruVisualRepair["inputs"],
		groups,
		caption_links: captionLinks,
		issues: Array.isArray(record.issues) && record.issues.length <= 4_096
			? record.issues.map(issueText)
			: [],
	};
}

function bboxArea(bbox: NormalizedBbox | null): number {
	return bbox ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : 0;
}

function manifestRecords(value: unknown, label: string): Map<string, UnknownRecord> {
	if (!Array.isArray(value)) throw new Error(`manifest.json 缺少 ${label} 文件清单`);
	if (value.length > MAX_MANIFEST_RECORDS) {
		throw new Error(`manifest.json 的 ${label} 记录数超过 ${MAX_MANIFEST_RECORDS}`);
	}
	const records = new Map<string, UnknownRecord>();
	for (const item of value) {
		const record = asRecord(item);
		const path = normalizeAssetPath(record.path);
		if (!path || records.has(path)) throw new Error(`manifest.json 含无效或重复路径：${String(record.path || "")}`);
		records.set(path, record);
	}
	return records;
}

function optionalManifestRecords(value: unknown): Map<string, UnknownRecord> {
	return Array.isArray(value) ? manifestRecords(value, "derived_contracts") : new Map();
}

async function verifyManifestOutputs(
	app: App,
	packagePath: string,
	manifest: UnknownRecord,
	article: { bytes: Uint8Array },
	mineru: { bytes: Uint8Array },
	pdfPath: string | null,
): Promise<{ verifiedAssetBlobs: Map<string, Blob>; verifiedPdfBytes: Uint8Array | null }> {
	if (Number(manifest.schema_version) !== 1) throw new Error("manifest.json 版本不受支持");
	const records = manifestRecords(manifest.outputs, "outputs");
	const derivedRecords = optionalManifestRecords(manifest.derived_contracts);
	if (records.size + derivedRecords.size > MAX_MANIFEST_RECORDS) {
		throw new Error("manifest.json 总记录数超过安全上限");
	}
	let packageTotalBytes = 0;
	let imageCount = 0;
	let imageTotalBytes = 0;
	for (const [relativePath, record] of [...records, ...derivedRecords]) {
		const size = Number(record.size);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error(`manifest.json 含无效大小：${relativePath}`);
		packageTotalBytes += size;
		if (isRasterImagePath(relativePath)) {
			imageCount += 1;
			imageTotalBytes += size;
		}
	}
	if (packageTotalBytes > MAX_PACKAGE_TOTAL_BYTES) throw new Error(`原文包累计大小超过 ${Math.round(MAX_PACKAGE_TOTAL_BYTES / MIB)} MiB`);
	if (imageCount > MAX_IMAGE_COUNT) throw new Error(`原文包图片数超过 ${MAX_IMAGE_COUNT}`);
	if (imageTotalBytes > MAX_IMAGE_TOTAL_BYTES) throw new Error(`原文包图片累计大小超过 ${Math.round(MAX_IMAGE_TOTAL_BYTES / MIB)} MiB`);
	const knownBytes = new Map<string, Uint8Array>([
		["article.md", article.bytes],
		["mineru-result.json", mineru.bytes],
	]);
	for (const required of knownBytes.keys()) {
		if (!records.has(required)) throw new Error(`manifest.json 未登记核心文件：${required}`);
	}
	let decodedPixels = 0;
	let sourcePdfOutputHash = "";
	const verifiedAssetBlobs = new Map<string, Blob>();
	let verifiedPdfBytes: Uint8Array | null = null;
	for (const [relativePath, record] of records) {
		const resolvedPath = resolvePackageAssetPath(packagePath, relativePath);
		const file = findTFile(app, resolvedPath);
		if (!resolvedPath || !file) throw new Error(`manifest.json 登记的文件不存在：${relativePath}`);
		await assertPackageFileNoFollow(app, packagePath, file);
		const expectedSize = Number(record.size);
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || file.stat.size !== expectedSize) {
			throw new Error(`原文包文件大小与 manifest.json 不一致：${relativePath}`);
		}
		const maxBytes = relativePath === "article.md"
			? MAX_ARTICLE_BYTES
			: relativePath === "mineru-result.json"
				? MAX_MINERU_JSON_BYTES
				: relativePath === "_extraction/source.pdf"
					? MAX_PDF_BYTES
					: MAX_OUTPUT_ASSET_BYTES;
		if (file.stat.size > maxBytes) throw new Error(`原文包文件超过阅读器安全上限：${relativePath}`);
		const expectedHash = String(record.sha256 || "").toLowerCase();
		if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
			throw new Error(`原文包文件哈希与 manifest.json 不一致：${relativePath}`);
		}
		const bytes = knownBytes.get(relativePath)
			|| new Uint8Array(await readTrustedVaultFile(filesystemAdapter(app), resolvedPath, maxBytes));
		if (bytes.byteLength !== expectedSize || bytes.byteLength > maxBytes) {
			throw new Error(`原文包文件实际读取长度不一致或超过安全上限：${relativePath}`);
		}
		if (sha256(bytes) !== expectedHash) {
			throw new Error(`原文包文件哈希与 manifest.json 不一致：${relativePath}`);
		}
		if (relativePath === "_extraction/source.pdf") {
			sourcePdfOutputHash = expectedHash;
			verifiedPdfBytes = bytes;
		}
		if (isRasterImagePath(relativePath)) {
			const dimensions = rasterImageDimensions(bytes, relativePath);
			const pixels = dimensions.width * dimensions.height;
			if (pixels <= 0 || pixels > MAX_IMAGE_PIXELS) {
				throw new Error(`图片解码像素超过安全上限：${relativePath}`);
			}
			decodedPixels += pixels;
			if (decodedPixels > MAX_IMAGE_TOTAL_PIXELS) throw new Error("原文包图片累计解码像素超过安全上限");
			// Blob becomes the single retained authority representation. The
			// transient verification buffer is released after this loop iteration.
			if (!(bytes.buffer instanceof ArrayBuffer)
				|| bytes.byteOffset !== 0
				|| bytes.byteLength !== bytes.buffer.byteLength) {
				throw new Error(`图片验证缓冲区不是独占 ArrayBuffer：${relativePath}`);
			}
			verifiedAssetBlobs.set(relativePath, new Blob(
				[bytes.buffer],
				{ type: rasterImageMime(relativePath) },
			));
		}
	}
	if (pdfPath) {
		const file = findTFile(app, pdfPath);
		const source = asRecord(manifest.source);
		const expectedHash = String(source.sha256 || "").toLowerCase();
		if (!file || file.stat.size > MAX_PDF_BYTES) throw new Error("包内 source.pdf 缺失或超过安全上限");
		if (!records.has("_extraction/source.pdf") || !sourcePdfOutputHash) {
			throw new Error("manifest.json 未登记包内 source.pdf");
		}
		if (!/^[a-f0-9]{64}$/.test(expectedHash) || sourcePdfOutputHash !== expectedHash) {
			throw new Error("包内 source.pdf 与 manifest.json 来源哈希不一致");
		}
	}
	return { verifiedAssetBlobs, verifiedPdfBytes };
}

function isRasterImagePath(value: string): boolean {
	return /\.(?:png|jpe?g|gif|webp)$/i.test(value);
}

function rasterImageMime(value: string): string {
	if (/\.png$/i.test(value)) return "image/png";
	if (/\.webp$/i.test(value)) return "image/webp";
	return "image/jpeg";
}

function rasterImageDimensions(bytes: Uint8Array, label: string): { width: number; height: number } {
	if (bytes.length >= 24
		&& bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
		for (let offset = 8; offset + 12 <= bytes.length;) {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const length = view.getUint32(offset);
			if (length > bytes.length - offset - 12) throw new Error(`PNG chunk 长度无效：${label}`);
			const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
			if (type === "acTL") throw new Error(`阅读器拒绝动画 PNG：${label}`);
			offset += 12 + length;
			if (type === "IEND") break;
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (bytes.length >= 10 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF") {
		throw new Error(`阅读器拒绝 GIF（无法在解码前可靠核算动画帧像素）：${label}`);
	}
	if (bytes.length >= 30
		&& String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
		&& String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
		const kind = String.fromCharCode(...bytes.slice(12, 16));
		if (kind === "VP8X") {
			let hasAnimationFrame = false;
			for (let offset = 12; offset + 8 <= bytes.length;) {
				const chunkSize = bytes[offset + 4]
					| (bytes[offset + 5] << 8)
					| (bytes[offset + 6] << 16)
					| (bytes[offset + 7] << 24);
				if (chunkSize < 0 || chunkSize > bytes.length - offset - 8) {
					throw new Error(`WebP chunk 长度无效：${label}`);
				}
				if (bytes[offset] === 0x41 && bytes[offset + 1] === 0x4e
					&& bytes[offset + 2] === 0x4d && bytes[offset + 3] === 0x46) {
					hasAnimationFrame = true;
					break;
				}
				offset += 8 + chunkSize + (chunkSize & 1);
			}
			if ((bytes[20] & 0x02) !== 0 || hasAnimationFrame) {
				throw new Error(`阅读器拒绝动画 WebP：${label}`);
			}
			const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
			const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
			return { width, height };
		}
		if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
			return {
				width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
				height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
			};
		}
		if (kind === "VP8L" && bytes[20] === 0x2f) {
			return {
				width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
				height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
			};
		}
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = bytes[offset + 1];
			if (marker === 0xd8 || marker === 0xd9) {
				offset += 2;
				continue;
			}
			const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
			if (length < 2 || offset + 2 + length > bytes.length) break;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
				return {
					width: (bytes[offset + 7] << 8) | bytes[offset + 8],
					height: (bytes[offset + 5] << 8) | bytes[offset + 6],
				};
			}
			offset += 2 + length;
		}
	}
	throw new Error(`图片格式或尺寸头不受支持：${label}`);
}

function assertViewerAssetsManifested(
	records: Map<string, UnknownRecord>,
	indexes: readonly MineruViewerIndex[],
): void {
	const referenced = new Set<string>();
	for (const index of indexes) {
		for (const image of index.markdown_images || []) if (image.asset_path) referenced.add(image.asset_path);
		for (const page of index.pages || []) {
			for (const block of page.blocks || []) if (block.asset_path) referenced.add(block.asset_path);
		}
	}
	for (const rawPath of referenced) {
		const path = normalizeAssetPath(rawPath);
		if (!path || !records.has(path)) throw new Error(`阅读器引用资产未登记在 manifest.json：${rawPath}`);
		if (!isRasterImagePath(path)) {
			throw new Error(`阅读器拒绝不受像素预算保护的图片格式：${rawPath}`);
		}
	}
}

function markdownOrderForAsset(index: MineruViewerIndex, assetPath: string): number {
	return index.markdown_images.find((image) => image.asset_path === assetPath)?.order ?? Number.MAX_SAFE_INTEGER;
}

function buildVisuals(
	index: MineruViewerIndex,
	repair: MineruVisualRepair | null,
	verifiedAssetBlobs: ReadonlyMap<string, Blob>,
	pdfPath: string | null,
	issues: string[],
): MineruReaderVisual[] {
	const blocks = index.pages.flatMap((page) => page.blocks);
	const blockById = new Map(blocks.map((block) => [block.id, block]));
	const consumed = new Set<string>();
	const visuals: MineruReaderVisual[] = [];
	const repairGroups = mergeStandaloneCaptionRepairGroups(repair?.groups || [], blocks);
	for (const group of repairGroups) {
		if (group.decision !== "auto") continue;
		const members = group.member_block_ids
			.map((id) => blockById.get(id))
			.filter((block): block is MineruViewerBlock => Boolean(block));
		if (members.length < 2) continue;
		const rawAssetPaths = [...new Set(members.map((block) => block.asset_path || "").filter(Boolean))];
		const assetPaths = rawAssetPaths.filter((assetPath) => {
			const available = verifiedAssetBlobs.has(normalizeAssetPath(assetPath));
			if (!available) issues.push(`视觉修复跳过缺失图片：${assetPath}`);
			return available;
		});
		if (!assetPaths.length) continue;
		let display: MineruReaderVisual["display"];
		if (group.replacement.mode === "pdf_crop" && group.replacement.bbox_norm && pdfPath) {
			display = {
				mode: "pdf-crop",
				bbox: group.replacement.bbox_norm,
				padding: Number(group.replacement.padding_norm || 0),
			};
		} else if (group.replacement.mode === "existing_asset") {
			const replacementAsset = group.replacement.asset_path
				|| [...members].sort((a, b) => bboxArea(b.bbox_norm) - bboxArea(a.bbox_norm))[0]?.asset_path
				|| assetPaths[0];
			const availableReplacement = assetPaths.includes(replacementAsset)
				? replacementAsset
				: assetPaths[0];
			display = { mode: "asset", assetPath: availableReplacement };
		} else {
			display = { mode: "fragment-set", assetPaths };
		}
		members.forEach((block) => consumed.add(block.id));
		const orderedAssets = [...assetPaths].sort(
			(a, b) => markdownOrderForAsset(index, a) - markdownOrderForAsset(index, b),
		);
		const captions = resolveVisualCaptionDetails(members, blocks, repair, group.page_idx, index);
		visuals.push({
			id: group.id,
			pageIdx: group.page_idx,
			label: "",
			...captions,
			memberBlockIds: members.map((block) => block.id),
			memberAssetPaths: orderedAssets,
			memberMarkdownImageIds: [...new Set(
				(group.member_markdown_image_ids?.length
					? group.member_markdown_image_ids
					: members.flatMap((block) => block.markdown_image_ids || [])),
			)],
			anchorAssetPath: orderedAssets[0],
			display,
			repairDecision: "auto",
			confidence: group.confidence,
		});
	}
	for (const block of blocks) {
		if (consumed.has(block.id) || !["visual", "table"].includes(block.role) || !block.asset_path) continue;
		const assetPath = block.asset_path;
		if (!verifiedAssetBlobs.has(normalizeAssetPath(assetPath))) {
			issues.push(`阅读器跳过缺失图片：${assetPath}`);
			continue;
		}
		visuals.push({
			id: `visual-${block.id}`,
			pageIdx: index.pages.find((page) => page.blocks.includes(block))?.page_idx || 0,
			label: "",
			...resolveVisualCaptionDetails(
				[block],
				blocks,
				repair,
				index.pages.find((page) => page.blocks.includes(block))?.page_idx || 0,
				index,
			),
			memberBlockIds: [block.id],
			memberAssetPaths: [assetPath],
			memberMarkdownImageIds: [...(block.markdown_image_ids || [])],
			anchorAssetPath: assetPath,
			display: { mode: "asset", assetPath },
			repairDecision: "keep-original",
			confidence: 1,
		});
	}
	visuals.sort((a, b) => {
		const aOrder = markdownOrderForAsset(index, a.anchorAssetPath);
		const bOrder = markdownOrderForAsset(index, b.anchorAssetPath);
		return aOrder - bOrder || a.pageIdx - b.pageIdx || a.id.localeCompare(b.id);
	});
	visuals.forEach((visual, index) => {
		visual.label = visualLabelFromCaption(visual.caption, index + 1);
	});
	return visuals;
}

function titleFromMarkdown(markdown: string, packagePath: string): string {
	const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.replace(/<[^>]+>/g, "").trim();
	return heading || packagePath.split("/").pop() || "MinerU 文献";
}

function viewerHashesMatch(
	index: MineruViewerIndex,
	articleHash: string,
	mineruHash: string,
): boolean {
	const expectedArticle = String(index.inputs?.article?.sha256 || "").toLowerCase();
	const expectedMineru = String(index.inputs?.mineru_result?.sha256 || "").toLowerCase();
	return /^[a-f0-9]{64}$/.test(expectedArticle)
		&& /^[a-f0-9]{64}$/.test(expectedMineru)
		&& expectedArticle === articleHash.toLowerCase()
		&& expectedMineru === mineruHash.toLowerCase();
}

function visualRepairPlanMatches(
	stored: MineruVisualRepair,
	active: MineruVisualRepair,
): boolean {
	return stored.algorithm_version === active.algorithm_version
		&& JSON.stringify(stored.groups) === JSON.stringify(active.groups)
		&& JSON.stringify(stored.caption_links || []) === JSON.stringify(active.caption_links || []);
}

export class MineruPackageLoader {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	async load(rawArticlePath: string): Promise<MineruReaderPackage> {
		const articlePath = normalizePackageArticlePath(rawArticlePath);
		const packagePath = packagePathFromArticle(articlePath);
		const article = await readRequiredBinary(this.app, articlePath, "article.md", MAX_ARTICLE_BYTES, packagePath);
		const mineru = await readRequiredBinary(
			this.app,
			`${packagePath}/mineru-result.json`,
			"mineru-result.json",
			MAX_MINERU_JSON_BYTES,
			packagePath,
		);
		const manifestValue = await readOptionalJson(
			this.app,
			`${packagePath}/_extraction/manifest.json`,
			MAX_MANIFEST_BYTES,
			packagePath,
		);
		const manifest = asRecord(manifestValue);
		const outputRecords = manifestRecords(manifest.outputs, "outputs");
		const manifestedImages = new Set(
			[...outputRecords.keys()].filter((relativePath) => isRasterImagePath(relativePath)),
		);
		assertPassiveMineruMarkdown(article.text, manifestedImages);
		const derivedRecords = optionalManifestRecords(manifest.derived_contracts);
		const validationValue = await readOptionalJson(
			this.app,
			`${packagePath}/_extraction/validation.json`,
			MAX_VALIDATION_BYTES,
			packagePath,
		);
		const validation = asRecord(validationValue);
		if (validation.status !== "passed") {
			throw new Error("该 MinerU 包未通过 _extraction/validation.json 验证，阅读器拒绝加载");
		}
		const pdfPathCandidate = `${packagePath}/_extraction/source.pdf`;
		const pdfPath = findTFile(this.app, pdfPathCandidate) ? pdfPathCandidate : null;
		const verified = await verifyManifestOutputs(this.app, packagePath, manifest, article, mineru, pdfPath);
		const articleHash = sha256(article.bytes);
		const mineruHash = sha256(mineru.bytes);
		const mineruPayload = parseJson(mineru.text, "mineru-result.json");
		const fallbackIndex = buildRuntimeViewerIndex(mineruPayload, article.text, {
			articleSha256: articleHash,
			mineruResultSha256: mineruHash,
			packagedSourcePdf: Boolean(pdfPath),
		});
		const issues = [...fallbackIndex.issues];
		const contractValue = await readOptionalDerivedJson(
			this.app,
			`${packagePath}/_extraction/viewer-index.json`,
			issues,
			derivedRecords.get("_extraction/viewer-index.json"),
			packagePath,
		);
		let viewerIndex: MineruViewerIndex | null = null;
		if (contractValue) {
			try {
				viewerIndex = normalizeViewerIndex(contractValue, fallbackIndex);
			} catch (error) {
				issues.push(
					`viewer-index.json 超过结构复杂度上限，已从原始 MinerU JSON 临时重建：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (contractValue && !viewerIndex) {
			issues.push("viewer-index.json 结构不受支持，已从原始 MinerU JSON 临时重建");
		}
		if (viewerIndex && !viewerHashesMatch(viewerIndex, articleHash, mineruHash)) {
			issues.push("viewer-index.json 与原始文件哈希不一致，已从原始 MinerU JSON 临时重建");
			viewerIndex = null;
		}
		viewerIndex ||= fallbackIndex;
		viewerIndex = reclassifyRuntimeRunningHeaders(viewerIndex);
		assertViewerAssetsManifested(outputRecords, [fallbackIndex, viewerIndex]);
		issues.push(...viewerIndex.issues);
		const repairValue = await readOptionalDerivedJson(
			this.app,
			`${packagePath}/_extraction/visual-repair.json`,
			issues,
			derivedRecords.get("_extraction/visual-repair.json"),
			packagePath,
		);
		const storedVisualRepair = repairValue ? normalizeRepair(repairValue) : null;
		if (repairValue && !storedVisualRepair) {
			issues.push("visual-repair.json 结构或算法版本不受支持，已保留 MinerU 原图显示");
		}
		if (storedVisualRepair && storedVisualRepair.algorithm_version !== CURRENT_VISUAL_REPAIR_ALGORITHM) {
			issues.push(`visual-repair.json 使用旧逻辑（${storedVisualRepair.algorithm_version}），已按当前规则重新计算 Figure 所有权`);
		}
		if (storedVisualRepair?.algorithm_version === CURRENT_VISUAL_REPAIR_ALGORITHM) {
			const storedErrors = validateVisualContracts({
				viewerIndex,
				visualRepair: storedVisualRepair,
				sourceIndex: fallbackIndex,
				articleHash,
				mineruHash,
			});
			if (storedErrors.length) {
				issues.push(`visual-repair.json 来源绑定失败，已忽略该缓存：${storedErrors.slice(0, 3).join("；")}`);
			}
		}

		// visual-repair.json is a cache, never a second source of truth. Always
		// derive the active plan from the verified article.md + MinerU JSON so a
		// package created by an older plugin cannot keep old grouping behavior.
		let visualRepair: MineruVisualRepair | null = buildRuntimeVisualRepair(viewerIndex);
		let runtimeErrors = validateVisualContracts({
			viewerIndex,
			visualRepair,
			sourceIndex: fallbackIndex,
			articleHash,
			mineruHash,
		});
		if (runtimeErrors.length && viewerIndex !== fallbackIndex) {
			issues.push(`Viewer Index 派生数据未通过来源绑定，已从原始 MinerU JSON 重建：${runtimeErrors.slice(0, 3).join("；")}`);
			viewerIndex = fallbackIndex;
			visualRepair = buildRuntimeVisualRepair(viewerIndex);
			runtimeErrors = validateVisualContracts({
				viewerIndex,
				visualRepair,
				sourceIndex: fallbackIndex,
				articleHash,
				mineruHash,
			});
		}
		if (runtimeErrors.length) {
			issues.push(`运行时视觉重建未通过来源绑定，已保留 MinerU 原图：${runtimeErrors.slice(0, 3).join("；")}`);
			visualRepair = null;
		} else if (!storedVisualRepair) {
			issues.push(pdfPath
				? "未找到视觉修复缓存，阅读器已从已验证的 MinerU 产物生成当前显示计划"
				: "未找到视觉修复缓存，阅读器已生成当前碎图组合计划（无 source.pdf，不启用 PDF 裁剪）");
		} else if (
			storedVisualRepair.algorithm_version === CURRENT_VISUAL_REPAIR_ALGORITHM
			&& !visualRepairPlanMatches(storedVisualRepair, visualRepair)
		) {
			issues.push("visual-repair.json 与当前确定性规则不一致，已忽略缓存并使用运行时计划");
		}
		if (visualRepair) issues.push(...visualRepair.issues);
		const externalPdfRecorded = Boolean(asRecord(manifest.source).path);
		return {
			sourceKind: "mineru",
			packagePath,
			articlePath,
			title: titleFromMarkdown(article.text, packagePath),
			articleMarkdown: article.text,
			mineruPayload,
			viewerIndex,
			visualRepair,
			visuals: buildVisuals(viewerIndex, visualRepair, verified.verifiedAssetBlobs, pdfPath, issues),
			pdfPath,
			verifiedAssetBlobs: verified.verifiedAssetBlobs,
			verifiedPdfBytes: verified.verifiedPdfBytes,
			externalPdfRecorded,
			issues: [...new Set(issues.filter(Boolean))],
		};
	}
}
