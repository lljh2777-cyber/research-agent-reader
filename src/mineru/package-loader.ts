import { createHash } from "node:crypto";

import { App, TFile, normalizePath } from "obsidian";

import {
	buildRuntimeViewerIndex,
	normalizeAssetPath,
	normalizeBbox,
	reclassifyRuntimeRunningHeaders,
} from "./normalization";
import {
	captionLinkMatchesBlocks,
	mergeStandaloneCaptionRepairGroups,
	resolveVisualCaptionDetails,
	visualLabelFromCaption,
} from "./reader-markdown";
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
const MAX_ARTICLE_BYTES = 64 * MIB;
const MAX_MINERU_JSON_BYTES = 256 * MIB;
const MAX_CONTRACT_BYTES = 32 * MIB;
const MAX_PDF_BYTES = 768 * MIB;
const MAX_OUTPUT_ASSET_BYTES = 256 * MIB;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as UnknownRecord
		: {};
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item || "").trim()).filter(Boolean);
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
	if (!Array.isArray(value)) return null;
	const parts: MineruCaptionPart[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const record = asRecord(value[index]);
		const text = String(record.text || "").trim();
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
	if (!Array.isArray(value)) return null;
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
	if (typeof value === "string") return value;
	const record = asRecord(value);
	return String(record.message || record.code || JSON.stringify(value));
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(value: ArrayBuffer | Uint8Array): string {
	return new TextDecoder("utf-8").decode(value instanceof Uint8Array ? value : new Uint8Array(value));
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
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

async function readRequiredBinary(
	app: App,
	path: string,
	label: string,
	maxBytes = MAX_MINERU_JSON_BYTES,
): Promise<{ file: TFile; bytes: Uint8Array; text: string }> {
	const file = findTFile(app, path);
	if (!file) throw new Error(`缺少 ${label}：${path}`);
	if (file.stat.size > maxBytes) {
		throw new Error(`${label} 超过阅读器安全上限（${Math.round(maxBytes / MIB)} MiB）：${path}`);
	}
	const buffer = await app.vault.readBinary(file);
	return { file, bytes: new Uint8Array(buffer), text: decodeUtf8(buffer) };
}

async function readOptionalJson(
	app: App,
	path: string,
	maxBytes = MAX_CONTRACT_BYTES,
): Promise<unknown | null> {
	const file = findTFile(app, path);
	if (!file) return null;
	if (file.stat.size > maxBytes) throw new Error(`${path} 超过阅读器安全上限`);
	return parseJson(await app.vault.read(file), path);
}

async function readOptionalDerivedJson(
	app: App,
	path: string,
	issues: string[],
	manifestRecord?: UnknownRecord,
): Promise<unknown | null> {
	try {
		const file = findTFile(app, path);
		if (!file) {
			if (manifestRecord) throw new Error("manifest.json 已登记该文件，但文件不存在");
			return null;
		}
		if (!manifestRecord) throw new Error("manifest.json 未登记该派生文件");
		if (file.stat.size > MAX_CONTRACT_BYTES || Number(manifestRecord.size) !== file.stat.size) {
			throw new Error("文件大小与 manifest.json 不一致或超过安全上限");
		}
		const bytes = new Uint8Array(await app.vault.readBinary(file));
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
	const textRecord = asRecord(record.text);
	const blockText = String(textRecord.text || fallback?.text?.text || "").trim();
	const textFigureKeys = asStringArray(textRecord.figure_keys).length
		? asStringArray(textRecord.figure_keys)
		: [...(fallback?.text?.figure_keys || [])];
	const textLeadingFigureKey = String(
		textRecord.leading_figure_key || fallback?.text?.leading_figure_key || "",
	).trim().toLowerCase();
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
	if (Number(record.schema_version) !== 1 || !Array.isArray(record.pages)) return null;
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
		pages: pages.sort((a, b) => a.page_idx - b.page_idx),
		issues: Array.isArray(record.issues) ? record.issues.map(issueText) : [],
	};
}

function normalizeDecision(value: unknown): MineruRepairDecision {
	if (value === "auto") return "auto";
	if (value === "review") return "review";
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
	if (Number(record.schema_version) !== 1 || !Array.isArray(record.groups)) return null;
	const algorithmVersion = String(record.algorithm_version || "");
	if (!["visual-repair-v1.1", "visual-repair-v1.2", "visual-repair-v1.3", "visual-repair-v1.4", "visual-repair-v1.5", "visual-repair-v1.6"].includes(algorithmVersion)) return null;
	const groups = record.groups.map((value): MineruVisualRepairGroup | null => {
		const group = asRecord(value);
		const replacement = asRecord(group.replacement);
		const id = String(group.id || "").trim();
		const pageIdx = Number(group.page_idx);
		const memberBlockIds = asStringArray(group.member_block_ids);
		if (!id || !Number.isInteger(pageIdx) || pageIdx < 0 || memberBlockIds.length < 2) return null;
		const bbox = normalizeBbox(replacement.bbox_norm ?? replacement.bbox);
		const assetPath = normalizeAssetPath(
			replacement.asset_path ?? replacement.existing_asset_path,
		);
		return {
			id,
			page_idx: pageIdx,
			member_block_ids: memberBlockIds,
			member_markdown_image_ids: asStringArray(group.member_markdown_image_ids),
			decision: normalizeDecision(group.decision),
			confidence: Math.max(0, Math.min(1, Number(group.confidence || 0))),
			replacement: {
				mode: normalizeReplacementMode(replacement.mode),
				block_id: String(replacement.block_id || "").trim() || undefined,
				...(bbox ? { bbox_norm: bbox } : {}),
				padding_norm: Math.max(0, Math.min(40, Number(replacement.padding_norm || 0))),
				...(assetPath ? { asset_path: assetPath } : {}),
			},
			caption_anchor_block_ids: asStringArray(group.caption_anchor_block_ids),
			signals: asRecord(group.signals),
			reason_codes: asStringArray(group.reason_codes),
			fallback: String(group.fallback || "original_assets"),
		};
	}).filter((group): group is MineruVisualRepairGroup => Boolean(group));
	const rawCaptionLinks = Array.isArray(record.caption_links) ? record.caption_links : [];
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
		issues: Array.isArray(record.issues) ? record.issues.map(issueText) : [],
	};
}

function bboxArea(bbox: NormalizedBbox | null): number {
	return bbox ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : 0;
}

function manifestRecords(value: unknown, label: string): Map<string, UnknownRecord> {
	if (!Array.isArray(value)) throw new Error(`manifest.json 缺少 ${label} 文件清单`);
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
): Promise<void> {
	if (Number(manifest.schema_version) !== 1) throw new Error("manifest.json 版本不受支持");
	const records = manifestRecords(manifest.outputs, "outputs");
	const knownBytes = new Map<string, Uint8Array>([
		["article.md", article.bytes],
		["mineru-result.json", mineru.bytes],
	]);
	for (const required of knownBytes.keys()) {
		if (!records.has(required)) throw new Error(`manifest.json 未登记核心文件：${required}`);
	}
	for (const [relativePath, record] of records) {
		const resolvedPath = resolvePackageAssetPath(packagePath, relativePath);
		const file = findTFile(app, resolvedPath);
		if (!resolvedPath || !file) throw new Error(`manifest.json 登记的文件不存在：${relativePath}`);
		const expectedSize = Number(record.size);
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || file.stat.size !== expectedSize) {
			throw new Error(`原文包文件大小与 manifest.json 不一致：${relativePath}`);
		}
		const maxBytes = relativePath === "article.md"
			? MAX_ARTICLE_BYTES
			: relativePath === "mineru-result.json"
				? MAX_MINERU_JSON_BYTES
				: MAX_OUTPUT_ASSET_BYTES;
		if (file.stat.size > maxBytes) throw new Error(`原文包文件超过阅读器安全上限：${relativePath}`);
		const bytes = knownBytes.get(relativePath)
			|| new Uint8Array(await app.vault.readBinary(file));
		const expectedHash = String(record.sha256 || "").toLowerCase();
		if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(bytes) !== expectedHash) {
			throw new Error(`原文包文件哈希与 manifest.json 不一致：${relativePath}`);
		}
	}
	if (pdfPath) {
		const file = findTFile(app, pdfPath);
		const source = asRecord(manifest.source);
		const expectedHash = String(source.sha256 || "").toLowerCase();
		if (!file || file.stat.size > MAX_PDF_BYTES) throw new Error("包内 source.pdf 缺失或超过安全上限");
		const bytes = new Uint8Array(await app.vault.readBinary(file));
		if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(bytes) !== expectedHash) {
			throw new Error("包内 source.pdf 与 manifest.json 来源哈希不一致");
		}
	}
}

function markdownOrderForAsset(index: MineruViewerIndex, assetPath: string): number {
	return index.markdown_images.find((image) => image.asset_path === assetPath)?.order ?? Number.MAX_SAFE_INTEGER;
}

function buildVisuals(
	index: MineruViewerIndex,
	repair: MineruVisualRepair | null,
	packagePath: string,
	app: App,
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
			const available = Boolean(findTFile(app, resolvePackageAssetPath(packagePath, assetPath)));
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
		const captions = resolveVisualCaptionDetails(members, blocks, repair, group.page_idx);
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
		if (!findTFile(app, resolvePackageAssetPath(packagePath, assetPath))) {
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

function bboxContains(container: NormalizedBbox, child: NormalizedBbox): boolean {
	return container[0] <= child[0] + 0.01
		&& container[1] <= child[1] + 0.01
		&& container[2] + 0.01 >= child[2]
		&& container[3] + 0.01 >= child[3];
}

function repairMatchesIndex(
	repair: MineruVisualRepair,
	index: MineruViewerIndex,
	articleHash: string,
	mineruHash: string,
): boolean {
	if (!viewerHashesMatch({ ...index, inputs: repair.inputs }, articleHash, mineruHash)) return false;
	const blockById = new Map<string, { block: MineruViewerBlock; pageIdx: number }>();
	index.pages.forEach((page) => page.blocks.forEach((block) => {
		blockById.set(block.id, { block, pageIdx: page.page_idx });
	}));
	const markdownImageIds = new Set(index.markdown_images.map((image) => image.id));
	const consumed = new Set<string>();
	for (const group of repair.groups) {
		const memberIds = group.member_block_ids;
		if (memberIds.length < 2 || new Set(memberIds).size !== memberIds.length) return false;
		const members = memberIds.map((id) => blockById.get(id));
		if (members.some((member) => !member || member.pageIdx !== group.page_idx)) return false;
		if (memberIds.some((id) => consumed.has(id))) return false;
		memberIds.forEach((id) => consumed.add(id));
		if ((group.member_markdown_image_ids || []).some((id) => !markdownImageIds.has(id))) return false;
		if ((group.caption_anchor_block_ids || []).some((id) => !memberIds.includes(id))) return false;
		if (group.replacement.mode === "existing_asset") {
			if (!group.replacement.block_id || !memberIds.includes(group.replacement.block_id)) return false;
			const memberAssets = new Set(members.map((member) => member?.block.asset_path).filter(Boolean));
			if (!group.replacement.asset_path || !memberAssets.has(group.replacement.asset_path)) return false;
		} else if (group.replacement.mode === "pdf_crop") {
			const crop = group.replacement.bbox_norm;
			if (!crop || members.some((member) => member?.block.bbox_norm && !bboxContains(crop, member.block.bbox_norm))) {
				return false;
			}
		} else {
			return false;
		}
	}
	const linkedVisuals = new Set<string>();
	const linkedCaptionBlocks = new Set<string>();
	for (const link of repair.caption_links || []) {
		if (linkedVisuals.has(link.visual_block_id)) return false;
		linkedVisuals.add(link.visual_block_id);
		const visual = blockById.get(link.visual_block_id);
		if (
			!visual
			|| visual.pageIdx !== link.source_page_idx
			|| visual.block.role !== "visual"
			|| link.target_page_idx !== link.source_page_idx + 1
			|| new Set(link.caption_block_ids).size !== link.caption_block_ids.length
		) return false;
		const captionBlocks = link.caption_block_ids.map((id) => blockById.get(id));
		if (
			captionBlocks.some((entry) => (
				!entry
				|| entry.pageIdx !== link.target_page_idx
				|| !["text", "title"].includes(entry.block.role)
				|| !String(entry.block.text?.text || "").trim()
			))
			|| link.caption_block_ids.some((id) => consumed.has(id))
			|| link.caption_block_ids.some((id) => linkedCaptionBlocks.has(id))
			|| !captionLinkMatchesBlocks(
				link,
				visual.block,
				index.pages.find((page) => page.page_idx === link.target_page_idx)?.blocks || [],
			)
		) return false;
		link.caption_block_ids.forEach((id) => linkedCaptionBlocks.add(id));
	}
	return true;
}

export class MineruPackageLoader {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	async load(rawArticlePath: string): Promise<MineruReaderPackage> {
		const articlePath = normalizePackageArticlePath(rawArticlePath);
		const packagePath = packagePathFromArticle(articlePath);
		const article = await readRequiredBinary(this.app, articlePath, "article.md", MAX_ARTICLE_BYTES);
		const mineru = await readRequiredBinary(
			this.app,
			`${packagePath}/mineru-result.json`,
			"mineru-result.json",
			MAX_MINERU_JSON_BYTES,
		);
		const validationValue = await readOptionalJson(
			this.app,
			`${packagePath}/_extraction/validation.json`,
		);
		const validation = asRecord(validationValue);
		if (validation.status !== "passed") {
			throw new Error("该 MinerU 包未通过 _extraction/validation.json 验证，阅读器拒绝加载");
		}
		const manifestValue = await readOptionalJson(
			this.app,
			`${packagePath}/_extraction/manifest.json`,
		);
		const manifest = asRecord(manifestValue);
		const derivedRecords = optionalManifestRecords(manifest.derived_contracts);
		const pdfPathCandidate = `${packagePath}/_extraction/source.pdf`;
		const pdfPath = findTFile(this.app, pdfPathCandidate) ? pdfPathCandidate : null;
		await verifyManifestOutputs(this.app, packagePath, manifest, article, mineru, pdfPath);
		const mineruPayload = parseJson(mineru.text, "mineru-result.json");
		const fallbackIndex = buildRuntimeViewerIndex(mineruPayload, article.text);
		const issues = [...fallbackIndex.issues];
		const articleHash = sha256(article.bytes);
		const mineruHash = sha256(mineru.bytes);
		const contractValue = await readOptionalDerivedJson(
			this.app,
			`${packagePath}/_extraction/viewer-index.json`,
			issues,
			derivedRecords.get("_extraction/viewer-index.json"),
		);
		let viewerIndex = contractValue ? normalizeViewerIndex(contractValue, fallbackIndex) : null;
		if (contractValue && !viewerIndex) {
			issues.push("viewer-index.json 结构不受支持，已从原始 MinerU JSON 临时重建");
		}
		if (viewerIndex && !viewerHashesMatch(viewerIndex, articleHash, mineruHash)) {
			issues.push("viewer-index.json 与原始文件哈希不一致，已从原始 MinerU JSON 临时重建");
			viewerIndex = null;
		}
		viewerIndex ||= fallbackIndex;
		viewerIndex = reclassifyRuntimeRunningHeaders(viewerIndex);
		issues.push(...viewerIndex.issues);
		const repairValue = await readOptionalDerivedJson(
			this.app,
			`${packagePath}/_extraction/visual-repair.json`,
			issues,
			derivedRecords.get("_extraction/visual-repair.json"),
		);
		let visualRepair = repairValue ? normalizeRepair(repairValue) : null;
		if (repairValue && !visualRepair) {
			issues.push("visual-repair.json 结构或算法版本不受支持，已保留 MinerU 原图显示");
		}
		if (visualRepair && !repairMatchesIndex(visualRepair, viewerIndex, articleHash, mineruHash)) {
			issues.push("visual-repair.json 与当前原文或阅读索引不一致，已保留 MinerU 原图显示");
			visualRepair = null;
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
			visuals: buildVisuals(viewerIndex, visualRepair, packagePath, this.app, pdfPath, issues),
			pdfPath,
			externalPdfRecorded,
			issues: [...new Set(issues.filter(Boolean))],
		};
	}
}
