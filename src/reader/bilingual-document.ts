import { bytesDigest } from "../papers/identity";
import { excerptRevision, type ExcerptRevision } from "../annotations/excerpt";
import type { SourceStorage } from "../sources/storage";
import { markdownImagePattern } from "./markdown-images";

export type BilingualLanguage = "en" | "zh-CN";
export type BilingualBlockKind = "heading" | "paragraph" | "image" | "table" | "list" | "quote" | "code" | "math" | "footnote" | "reference" | "rule";
export interface BilingualBlock {
	id: string; kind: BilingualBlockKind; start: number; end: number; lineStart: number; lineEnd: number;
	chapter: string; signature: string;
}
export interface BilingualFile {
	path: string; text: string; digest: string; revision: ExcerptRevision; bodyStart: number; blocks: BilingualBlock[];
}
export interface BilingualPair { id: string; en: BilingualBlock; "zh-CN": BilingualBlock; }
export interface BilingualDocument {
	root: string; metadataPath: string; metadataDigest: string; title: string; status: string; humanReview: string;
	sourceVersion: string | null; stale: boolean; syncAvailable: boolean; issues: string[];
	files: Record<BilingualLanguage, BilingualFile>; pairs: BilingualPair[];
}
export const BILINGUAL_MARKDOWN_LIMIT = 16 * 1024 * 1024;
const MAX_BLOCKS = 10000;
const pathParts = (value: string): boolean => value.length <= 600 && !/[\\<>:"|?*\x00-\x1f]/.test(value)
	&& value.split("/").every(p => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p));

/** Entry names are fixed. Metadata never chooses an arbitrary filesystem target. */
export function bilingualPaths(path: string): { root: string; en: string; zh: string; metadata: string } {
	if (!pathParts(path) || !/^Clippings\/.+\/(?:paper\.md|paper\.zh-CN\.md)$/.test(path)) throw new Error("双语阅读仅支持 Clippings/ 内的规范 paper.md 与 paper.zh-CN.md");
	const root = path.slice(0, path.lastIndexOf("/"));
	return { root, en: root + "/paper.md", zh: root + "/paper.zh-CN.md", metadata: root + "/translation.json" };
}
export function isBilingualEntry(path: string): boolean { try { bilingualPaths(path); return true; } catch { return false; } }

interface Line { text: string; start: number; end: number; index: number; }
function linesOf(text: string): Line[] {
	const result: Line[] = []; let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline + 1;
		result.push({ text: text.slice(start, newline < 0 ? end : newline).replace(/\r$/, ""), start, end, index: result.length }); start = end;
	}
	return result;
}
const imagesOf = (text: string): string[] => [...text.matchAll(markdownImagePattern())].map(m => m[2] || m[3] || m[4]);
const footnotesOf = (text: string): string[] => [...text.matchAll(/\[\^([^\]\r\n]+)\](?!:)/g)].map(m => m[1]);
const tableRule = (line: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
const begins = (line: string): boolean => /^(?:#{1,6}\s|`{3,}|~{3,}|\$\$\s*$|>\s?|[-+*]\s|\d+[.)]\s|\[\^[^\]]+\]:|\[[^\]]+\]:)/.test(line);

/** UTF-16 ranges always refer to the complete unmodified source, including frontmatter. */
export function parseBilingualMarkdown(text: string): { bodyStart: number; blocks: BilingualBlock[] } {
	const lines = linesOf(text), blocks: BilingualBlock[] = []; let cursor = 0, bodyStart = text.startsWith("\uFEFF") ? 1 : 0;
	if (lines[0]?.text.replace(/^\uFEFF/, "") === "---") {
		const close = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l.text));
		if (close < 0) throw new Error("Markdown 前置信息未结束");
		cursor = close + 1; bodyStart = lines[close].end;
	}
	let chapter = "root", headingIndex = 0;
	while (cursor < lines.length) {
		if (!lines[cursor].text.trim()) { cursor++; continue; }
		if (blocks.length >= MAX_BLOCKS) throw new Error("双语正文块超过 10000 个，请缩小资料范围");
		const first = cursor, line = lines[cursor].text; let kind: BilingualBlockKind = "paragraph", key = "";
		const heading = /^\s{0,3}(#{1,6})\s+/.exec(line), fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (heading) { kind = "heading"; key = String(heading[1].length); chapter = "h-" + headingIndex++; cursor++; }
		else if (fence || /^\s*\$\$\s*$/.test(line)) {
			kind = fence ? "code" : "math"; key = fence ? line.slice(fence[0].length).trim() : "";
			const close = fence ? new RegExp("^\\s{0,3}" + fence[1][0] + "{" + fence[1].length + ",}\\s*$") : /^\s*\$\$\s*$/;
			cursor++; while (cursor < lines.length && !close.test(lines[cursor].text)) cursor++;
			if (cursor === lines.length) throw new Error("代码或公式块未结束"); cursor++;
		} else if (/^\s{0,3}\[\^[^\]]+\]:/.test(line)) {
			kind = "footnote"; key = /^\s{0,3}\[\^([^\]]+)\]:/.exec(line)![1]; cursor++;
			while (cursor < lines.length && /^(?: {4}|\t)\S|^(?: {4}|\t)\s+/.test(lines[cursor].text)) cursor++;
		} else if (/^\s{0,3}\[[^\]]+\]:/.test(line)) { kind = "reference"; key = line.trim(); cursor++; }
		else if (cursor + 1 < lines.length && tableRule(lines[cursor + 1].text)) {
			kind = "table"; cursor += 2; while (cursor < lines.length && lines[cursor].text.trim() && lines[cursor].text.includes("|")) cursor++;
		} else if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) { kind = "rule"; cursor++; }
		else {
			if (/^\s{0,3}(?:[-+*]|\d+[.)])\s/.test(line)) kind = "list";
			else if (/^\s{0,3}>/.test(line)) kind = "quote";
			cursor++;
			while (cursor < lines.length && lines[cursor].text.trim()) {
				const next = lines[cursor].text;
				if (kind === "list" && /^\s*(?:[-+*]|\d+[.)])\s/.test(next) || kind === "quote" && /^\s*>/.test(next)) { cursor++; continue; }
				if (begins(next)) break; cursor++;
			}
		}
		const start = Math.max(bodyStart, lines[first].start), end = lines[cursor - 1].end, raw = text.slice(start, end).trim();
		const images = imagesOf(raw);
		if (kind === "paragraph" && images.length === 1 && markdownImagePattern().exec(raw)?.[0] === raw) kind = "image";
		// Citation identifiers and common image paths give additional structural checks, not semantic verification.
		const signature = JSON.stringify([kind, key, images, footnotesOf(raw)]);
		blocks.push({ id: "b-" + blocks.length, kind, start, end, lineStart: lines[first].index, lineEnd: lines[cursor - 1].index, chapter, signature });
	}
	return { bodyStart, blocks };
}
function decode(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
export function createBilingualDocument(entry: string, enBytes: Uint8Array, zhBytes: Uint8Array, metadataBytes: Uint8Array): BilingualDocument {
	const paths = bilingualPaths(entry);
	if (enBytes.length > BILINGUAL_MARKDOWN_LIMIT || zhBytes.length > BILINGUAL_MARKDOWN_LIMIT || metadataBytes.length > 256 * 1024) throw new Error("双语资料超过读取上限");
	const meta = JSON.parse(decode(metadataBytes).replace(/^\uFEFF/, "")) as Record<string, unknown>;
	if (!meta || Array.isArray(meta) || meta.schemaVersion !== 1 || meta.sourceFile !== "paper.md" || meta.translationFile !== "paper.zh-CN.md") throw new Error("双语元数据格式或配对文件名不匹配");
	const file = (path: string, bytes: Uint8Array): BilingualFile => { const text = decode(bytes); return { path, text, digest: bytesDigest(bytes), revision: excerptRevision(text), ...parseBilingualMarkdown(text) }; };
	const en = file(paths.en, enBytes), zh = file(paths.zh, zhBytes), issues: string[] = [];
	const version = meta.sourceVersion as Record<string, unknown> | undefined;
	const sourceVersion = version?.algorithm === "sha256" && typeof version.value === "string" && /^[a-f0-9]{64}$/.test(version.value) ? version.value : null;
	const stale = meta.stale === true || !!sourceVersion && sourceVersion !== en.digest;
	if (!sourceVersion) issues.push("译文英语来源版本未确认，暂停同步");
	if (stale) issues.push("译文对应的英语来源已过期，暂停同步");
	if (!en.blocks.length || en.blocks.length !== zh.blocks.length) issues.push("两份正文块数量不一致或正文为空，暂停同步");
	else if (en.blocks.some((b, i) => b.signature !== zh.blocks[i].signature)) issues.push("标题、块类型、图片或脚注结构不一致，暂停同步");
	const pairs = issues.length ? [] : en.blocks.map((block, i) => ({ id: "p-" + i, en: block, "zh-CN": zh.blocks[i] }));
	const status = ["not-started", "in-progress", "needs-review", "reviewed", "failed"].includes(String(meta.status)) ? String(meta.status) : "unknown";
	return { root: paths.root, metadataPath: paths.metadata, metadataDigest: bytesDigest(metadataBytes), title: typeof meta.title === "string" ? meta.title.slice(0, 1000) : "双语文献",
		status, humanReview: meta.humanReview === "reviewed" ? "reviewed" : meta.humanReview === "not-reviewed" ? "not-reviewed" : "unknown",
		sourceVersion, stale, syncAvailable: pairs.length > 0, issues, files: { en, "zh-CN": zh }, pairs };
}
function imagePath(root: string, relative: string): string {
	let decoded: string; try { decoded = decodeURIComponent(relative); } catch { throw new Error("图片路径编码无效"); }
	if (!pathParts(decoded) || !/^images\/.+\.(?:png|jpe?g|webp|gif)$/i.test(decoded)) throw new Error("双语资料仅支持 images/ 内的本地图片");
	return root + "/" + decoded;
}
/** Bounded read-only IO; production callers supply the existing link-checked FileSourceStorage. */
export async function loadBilingualDocument(io: Pick<SourceStorage, "read">, entry: string, signal?: AbortSignal): Promise<BilingualDocument> {
	const p = bilingualPaths(entry), inputs = [p.en, p.zh, p.metadata], limits = [BILINGUAL_MARKDOWN_LIMIT, BILINGUAL_MARKDOWN_LIMIT, 256 * 1024];
	const bytes: Uint8Array[] = [];
	for (let i = 0; i < inputs.length; i++) { signal?.throwIfAborted(); const b = await io.read(inputs[i], limits[i]); if (!b) throw new Error("双语配对文件缺失：" + inputs[i]); bytes.push(b); }
	const doc = createBilingualDocument(entry, bytes[0], bytes[1], bytes[2]);
	const assets = [...new Set(Object.values(doc.files).flatMap(f => imagesOf(f.text)))];
	if (assets.length > 256) throw new Error("双语资料图片超过 256 张");
	for (const asset of assets) { signal?.throwIfAborted(); if (!await io.read(imagePath(p.root, asset), 12 * 1024 * 1024)) doc.issues.push("本地图片缺失：" + asset); }
	// Re-read only the three inputs; do not trust a pair assembled across edits.
	for (let i = 0; i < inputs.length; i++) { signal?.throwIfAborted(); const after = await io.read(inputs[i], limits[i]); if (!after || !Buffer.from(after).equals(Buffer.from(bytes[i]))) throw new Error("双语资料在加载期间变化，请重新打开"); }
	signal?.throwIfAborted(); if (doc.issues.length) { doc.syncAvailable = false; doc.pairs = []; } return doc;
}
