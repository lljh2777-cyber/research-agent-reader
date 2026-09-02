import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadPdfJs } from "obsidian";

const FIRST_PAGE_TEXT_LIMIT = 8_000;
export const MAX_LOCAL_PDF_BYTES = 128 * 1024 * 1024;
const PDF_PREFLIGHT_TIMEOUT_MS = 20_000;
const SNAPSHOT_COPY_CHUNK_BYTES = 1024 * 1024;
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;

interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
	transform?: number[];
	width?: number;
	height?: number;
}
interface PdfPageProxy {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
	getViewport(options: { scale: number }): { width: number; height: number };
	render?(options: {
		canvasContext: CanvasRenderingContext2D;
		viewport: { width: number; height: number };
	}): { promise: Promise<void>; cancel?(): void };
	getOperatorList?(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
	cleanup?(): void;
}

interface PdfMetadataBag {
	get?(name: string): unknown;
	getAll?(): Record<string, unknown>;
}

interface PdfDocumentProxy {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
	getMetadata?(): Promise<{
		info?: Record<string, unknown>;
		metadata?: PdfMetadataBag | null;
		contentDispositionFilename?: string;
	}>;
	destroy(): Promise<void>;
}

interface PdfLoadingTask {
	promise: Promise<PdfDocumentProxy>;
	destroy?(): Promise<void>;
}

interface PdfJsApi {
	getDocument(options: { data: Uint8Array; isEvalSupported: boolean }): PdfLoadingTask;
	OPS?: Record<string, number>;
}

export interface LocalPdfIdentityEvidence {
	status: "available" | "unavailable";
	fileName: string;
	pageCount: number;
	metadataTitle: string;
	trustedMetadataTitle: string;
	metadataAuthors: string;
	doiCandidates: string[];
	firstPageText: string;
	firstPageTitleCandidates: string[];
	warning: string;
}

export interface LocalPdfIdentityDeps {
	statFile(sourcePath: string): Promise<{ size: number; isFile: boolean }>;
	readFile(sourcePath: string, signal?: AbortSignal): Promise<Uint8Array>;
	loadPdfJs(): Promise<PdfJsApi>;
	/** Test seam; production always raster-verifies the candidate against page 1. */
	verifyTitleCandidates?: (
		candidates: readonly { text: string; boxes: readonly [number, number, number, number][] }[],
	) => Promise<string[]>;
}

export interface AuthorizedPdfSnapshot {
	path: string;
	directory: string;
	originalFileName: string;
	size: number;
	sha256: string;
}

function safeFileName(sourcePath: string): string {
	return String(sourcePath || "")
		.replace(/\\/g, "/")
		.split("/")
		.filter(Boolean)
		.pop() || "未命名 PDF";
}

function cleanPdfText(value: unknown, maxLength: number): string {
	return String(value || "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, maxLength);
}

function metadataValue(
	info: Record<string, unknown>,
	metadata: PdfMetadataBag | null | undefined,
	keys: readonly string[],
): string {
	for (const key of keys) {
		const direct = info[key];
		if (typeof direct === "string" && direct.trim()) return cleanPdfText(direct, 1_000);
		const embedded = metadata?.get?.(key);
		if (typeof embedded === "string" && embedded.trim()) return cleanPdfText(embedded, 1_000);
	}
	return "";
}

function metadataStrings(
	info: Record<string, unknown>,
	metadata: PdfMetadataBag | null | undefined,
): string[] {
	const values = Object.values(info).filter((value): value is string => typeof value === "string");
	const all = metadata?.getAll?.();
	if (all && typeof all === "object") {
		values.push(...Object.values(all).filter((value): value is string => typeof value === "string"));
	}
	return values;
}

/**
 * DOI candidates are observations, not verified identities. Preserve legal
 * suffix punctuation and let the exact Crossref endpoint decide whether a
 * candidate exists; only strip punctuation that unambiguously closes prose.
 */
export function extractPdfDoiCandidates(texts: readonly string[]): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const text of texts) {
		for (const match of String(text || "").matchAll(DOI_PATTERN)) {
			const doi = String(match[0] || "")
				.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
				.replace(/[\],}>]+$/g, "")
				.trim();
			const key = doi.toLowerCase();
			if (!doi || seen.has(key)) continue;
			seen.add(key);
			candidates.push(doi);
			if (candidates.length >= 5) return candidates;
		}
	}
	return candidates;
}

interface VisiblePdfTextItem {
	text: string;
	x: number;
	top: number;
	bottom: number;
	fontHeight: number;
	right: number;
	order: number;
}

function visibleFirstPageItems(
	items: readonly PdfTextItem[],
	viewport: { width: number; height: number },
): VisiblePdfTextItem[] {
	if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
		|| viewport.width <= 0 || viewport.height <= 0) return [];
	return items.flatMap((item, order) => {
		const text = cleanPdfText(item.str, 1_000);
		const transform = item.transform;
		if (!text || !transform || transform.length < 6) return [];
		const x = Number(transform[4]);
		const baselineY = Number(transform[5]);
		const itemWidth = Math.max(0, Number(item.width || 0));
		const fontHeight = Math.max(
			1,
			Number(item.height || 0),
			Math.abs(Number(transform[3] || 0)),
			Math.hypot(Number(transform[2] || 0), Number(transform[3] || 0)),
		);
		if (![x, baselineY, itemWidth, fontHeight].every(Number.isFinite)) return [];
		const left = x;
		const right = x + Math.max(itemWidth, fontHeight * 0.25);
		const top = viewport.height - baselineY - fontHeight;
		const bottom = viewport.height - baselineY + fontHeight * 0.25;
		if (right <= 0 || left >= viewport.width || bottom <= 0 || top >= viewport.height) return [];
		return [{
			text,
			x,
			right: Math.min(viewport.width, right),
			top: Math.max(0, top),
			bottom: Math.min(viewport.height, bottom),
			fontHeight,
			order,
		}];
	});
}

function pageTextFromVisibleItems(items: readonly VisiblePdfTextItem[]): string {
	const ordered = [...items].sort((left, right) => (
		left.top - right.top || left.x - right.x || left.order - right.order
	));
	const lines: Array<{ top: number; height: number; items: VisiblePdfTextItem[] }> = [];
	for (const item of ordered) {
		const line = lines[lines.length - 1];
		if (!line || Math.abs(line.top - item.top) > Math.max(line.height, item.fontHeight) * 0.65) {
			lines.push({ top: item.top, height: item.fontHeight, items: [item] });
			continue;
		}
		line.items.push(item);
		line.height = Math.max(line.height, item.fontHeight);
	}
	return cleanPdfText(lines.map((line) => line.items
		.sort((left, right) => left.x - right.x || left.order - right.order)
		.map((item) => item.text).join(" ")).join("\n"), FIRST_PAGE_TEXT_LIMIT);
}

function firstPageTitleCandidateGroups(
	items: readonly VisiblePdfTextItem[],
	viewport: { width: number; height: number },
): Array<{ text: string; items: VisiblePdfTextItem[] }> {
	const upper = items.filter((item) => item.top <= viewport.height * 0.58);
	if (!upper.length) return [];
	const largest = Math.max(...upper.map((item) => item.fontHeight));
	const threshold = Math.max(10, largest * 0.72);
	const titleItems = upper.filter((item) => (
		item.fontHeight >= threshold
		&& !/^(?:article|research|review|abstract|doi\b|https?:|www\.|received|accepted|published)$/i.test(item.text.trim())
	));
	if (!titleItems.length) return [];
	const ordered = [...titleItems].sort((left, right) => left.top - right.top || left.x - right.x || left.order - right.order);
	const lines: Array<{ top: number; bottom: number; height: number; text: string }> = [];
	for (const item of ordered) {
		const line = lines[lines.length - 1];
		if (!line || Math.abs(line.top - item.top) > Math.max(line.height, item.fontHeight) * 0.65) {
			lines.push({ top: item.top, bottom: item.bottom, height: item.fontHeight, text: item.text });
		} else {
			line.text = `${line.text} ${item.text}`.replace(/\s+/g, " ").trim();
			line.bottom = Math.max(line.bottom, item.bottom);
			line.height = Math.max(line.height, item.fontHeight);
		}
	}
	const groups: Array<{ text: string; items: VisiblePdfTextItem[] }> = [];
	let current: typeof lines = [];
	for (const line of lines) {
		const previous = current[current.length - 1];
		if (previous && line.top - previous.bottom > Math.max(previous.height, line.height) * 1.8) {
			const members = titleItems.filter((item) => current.some((entry) => (
				Math.abs(entry.top - item.top) <= Math.max(entry.height, item.fontHeight) * 0.65
			)));
			groups.push({ text: current.map((item) => item.text).join(" "), items: members });
			current = [];
		}
		current.push(line);
	}
	if (current.length) {
		const members = titleItems.filter((item) => current.some((entry) => (
			Math.abs(entry.top - item.top) <= Math.max(entry.height, item.fontHeight) * 0.65
		)));
		groups.push({ text: current.map((item) => item.text).join(" "), items: members });
	}
	const plausible = groups
		.map((group) => ({ ...group, text: cleanPdfText(group.text, 500) }))
		.filter((group) => group.text.length >= 20 && group.text.split(/\s+/).length >= 4)
		.filter((group) => {
			const members = new Set(group.items);
			return !upper.some((other) => {
				if (members.has(other)) return false;
				return group.items.some((item) => {
					const overlapWidth = Math.max(0, Math.min(item.right, other.right) - Math.max(item.x, other.x));
					const overlapHeight = Math.max(0, Math.min(item.bottom, other.bottom) - Math.max(item.top, other.top));
					const overlap = overlapWidth * overlapHeight;
					const smaller = Math.min(
						Math.max(1, (item.right - item.x) * (item.bottom - item.top)),
						Math.max(1, (other.right - other.x) * (other.bottom - other.top)),
					);
					return overlap / smaller >= 0.2;
				});
			});
		});
	// More than one dominant block is ambiguous (for example a visible title
	// plus injected off-order text). Do not let the model choose between them.
	return plausible.length === 1 ? plausible : [];
}

async function rasterVerifiedTitleCandidates(
	page: PdfPageProxy,
	groups: readonly { text: string; items: readonly VisiblePdfTextItem[] }[],
	viewport: { width: number; height: number },
	signal: AbortSignal,
): Promise<string[]> {
	if (!groups.length || !page.render || typeof document === "undefined") return [];
	const scale = Math.min(2, 1600 / Math.max(viewport.width, viewport.height));
	const renderedViewport = page.getViewport({ scale });
	if (!Number.isFinite(renderedViewport.width) || !Number.isFinite(renderedViewport.height)) return [];
	const width = Math.max(1, Math.ceil(renderedViewport.width));
	const height = Math.max(1, Math.ceil(renderedViewport.height));
	if (width * height > 4_000_000) return [];
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return [];
	context.save();
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, width, height);
	context.restore();
	const task = page.render({ canvasContext: context, viewport: renderedViewport });
	try {
		await waitForAbortable(task.promise, signal, "本地 PDF 标题可见性验证已取消");
		const upperHeight = Math.max(1, Math.min(height, Math.ceil(height * 0.62)));
		const upper = context.getImageData(0, 0, width, upperHeight).data;
		let nearWhite = 0;
		let sampled = 0;
		for (let index = 0; index < upper.length; index += 4 * 16) {
			sampled += 1;
			if (upper[index] >= 245 && upper[index + 1] >= 245 && upper[index + 2] >= 245 && upper[index + 3] >= 245) nearWhite += 1;
		}
		// Automatic identity binding is intentionally limited to ordinary light
		// paper title pages. Covers or image-backed titles require manual review.
		if (!sampled || nearWhite / sampled < 0.72) return [];
		return groups.filter((group) => group.items.length > 0 && group.items.every((item) => {
			const left = Math.max(0, Math.floor(item.x * scale));
			const top = Math.max(0, Math.floor(item.top * scale));
			const right = Math.min(width, Math.ceil(item.right * scale));
			const bottom = Math.min(height, Math.ceil(item.bottom * scale));
			if (right <= left || bottom <= top) return false;
			const pixels = context.getImageData(left, top, right - left, bottom - top).data;
			let ink = 0;
			for (let index = 0; index < pixels.length; index += 4) {
				if (pixels[index + 3] >= 245
					&& Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) <= 225) ink += 1;
			}
			return ink >= Math.max(3, Math.ceil((pixels.length / 4) * 0.0015));
		})).map((group) => group.text);
	} finally {
		try { task.cancel?.(); } catch { /* Rendering already settled. */ }
		canvas.width = 1;
		canvas.height = 1;
	}
}

function operatorText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(operatorText).join("");
	if (value && typeof value === "object") {
		const record = value as { unicode?: unknown; fontChar?: unknown };
		if (typeof record.unicode === "string") return record.unicode;
		if (typeof record.fontChar === "string") return record.fontChar;
	}
	return "";
}

function operatorTextMatches(candidate: string, corpus: string): boolean {
	const normalize = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	const expected = normalize(candidate);
	const actual = normalize(corpus);
	if (!expected || !actual) return false;
	if (actual.includes(expected)) return true;
	const terms = expected.split(/\s+/).filter(Boolean);
	const actualTerms = new Set(actual.split(/\s+/).filter(Boolean));
	return terms.length >= 4 && terms.filter((term) => actualTerms.has(term)).length / terms.length >= 0.9;
}

function operatorColorNumbers(args: readonly unknown[]): number[] {
	const values: number[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "number" && Number.isFinite(value)) values.push(value);
		else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
			for (const item of Array.from(value as ArrayLike<unknown>)) visit(item);
		}
	};
	for (const arg of args) visit(arg);
	return values;
}

function normalizedColor(value: number): number {
	return Math.max(0, Math.min(1, value > 1 ? value / 255 : value));
}

async function operatorVerifiedTitleCandidates(
	page: PdfPageProxy,
	groups: readonly { text: string }[],
	api: PdfJsApi,
	signal: AbortSignal,
): Promise<string[]> {
	const ops = api.OPS;
	if (!page.getOperatorList || !ops) return [];
	const list = await waitForAbortable(page.getOperatorList(), signal, "本地 PDF 标题绘制状态验证已取消");
	let renderMode = 0;
	let fillAlpha = 1;
	let strokeAlpha = 1;
	let fillDark = true;
	let strokeDark = true;
	let clipActive = false;
	const stateStack: Array<{
		renderMode: number; fillAlpha: number; strokeAlpha: number;
		fillDark: boolean; strokeDark: boolean; clipActive: boolean;
	}> = [];
	const visible: string[] = [];
	const hidden: string[] = [];
	for (let index = 0; index < list.fnArray.length; index += 1) {
		const fn = list.fnArray[index];
		const args = list.argsArray[index] || [];
		if (fn === ops.save) {
			stateStack.push({ renderMode, fillAlpha, strokeAlpha, fillDark, strokeDark, clipActive });
			continue;
		}
		if (fn === ops.restore) {
			const restored = stateStack.pop();
			if (restored) ({ renderMode, fillAlpha, strokeAlpha, fillDark, strokeDark, clipActive } = restored);
			continue;
		}
		if (fn === ops.setTextRenderingMode) {
			renderMode = Math.max(0, Math.min(7, Number(args[0]) || 0));
			continue;
		}
		if (fn === ops.setGState) {
			const entries = Array.isArray(args[0]) ? args[0] : args;
			for (const entry of entries) {
				if (!Array.isArray(entry) || entry.length < 2) continue;
				if (entry[0] === "ca") fillAlpha = Number(entry[1]);
				if (entry[0] === "CA") strokeAlpha = Number(entry[1]);
			}
			continue;
		}
		if (fn === ops.clip || fn === ops.eoClip) {
			clipActive = true;
			continue;
		}
		if (fn === ops.setFillGray || fn === ops.setStrokeGray) {
			const gray = normalizedColor(operatorColorNumbers(args)[0] ?? 1);
			if (fn === ops.setFillGray) fillDark = gray <= 0.82;
			else strokeDark = gray <= 0.82;
			continue;
		}
		if (fn === ops.setFillRGBColor || fn === ops.setStrokeRGBColor) {
			const [red = 1, green = 1, blue = 1] = operatorColorNumbers(args).map(normalizedColor);
			const dark = (0.2126 * red + 0.7152 * green + 0.0722 * blue) <= 0.82;
			if (fn === ops.setFillRGBColor) fillDark = dark;
			else strokeDark = dark;
			continue;
		}
		if (fn === ops.setFillCMYKColor || fn === ops.setStrokeCMYKColor) {
			const [cyan = 0, magenta = 0, yellow = 0, black = 0] = operatorColorNumbers(args).map(normalizedColor);
			const red = 1 - Math.min(1, cyan + black);
			const green = 1 - Math.min(1, magenta + black);
			const blue = 1 - Math.min(1, yellow + black);
			const dark = (0.2126 * red + 0.7152 * green + 0.0722 * blue) <= 0.82;
			if (fn === ops.setFillCMYKColor) fillDark = dark;
			else strokeDark = dark;
			continue;
		}
		if (fn === ops.setFillColorSpace || fn === ops.setFillColor || fn === ops.setFillColorN) {
			fillDark = false;
			continue;
		}
		if (fn === ops.setStrokeColorSpace || fn === ops.setStrokeColor || fn === ops.setStrokeColorN) {
			strokeDark = false;
			continue;
		}
		const isText = fn === ops.showText || fn === ops.showSpacedText
			|| fn === ops.nextLineShowText || fn === ops.nextLineSetSpacingShowText;
		if (!isText) continue;
		const text = operatorText(args);
		if (!text.trim()) continue;
		const paintsFill = !clipActive && [0, 2].includes(renderMode) && fillAlpha > 0.01 && fillDark;
		const paintsStroke = !clipActive && [1, 2].includes(renderMode) && strokeAlpha > 0.01 && strokeDark;
		(paintsFill || paintsStroke ? visible : hidden).push(text);
	}
	const visibleText = visible.join(" ");
	const hiddenText = hidden.join(" ");
	return groups.filter((group) => (
		operatorTextMatches(group.text, visibleText)
		&& !operatorTextMatches(group.text, hiddenText)
	)).map((group) => group.text);
}

function trustedMetadataTitle(value: string, fileName: string): string {
	const title = cleanPdfText(value, 1_000);
	const normalized = title.toLowerCase().replace(/[\s._-]+/g, " ").trim();
	const fileStem = safeFileName(fileName).replace(/\.pdf$/i, "").toLowerCase().replace(/[\s._-]+/g, " ").trim();
	if (normalized.length < 12 || normalized === fileStem) return "";
	if (/^(?:untitled|document|paper|article|manuscript|full ?text|download|microsoft word|acrobat|adobe pdf|latex|texput|scanner)$/i.test(normalized)) return "";
	return title;
}

function unavailable(fileName: string, warning: string): LocalPdfIdentityEvidence {
	return {
		status: "unavailable",
		fileName,
		pageCount: 0,
		metadataTitle: "",
		trustedMetadataTitle: "",
		metadataAuthors: "",
		doiCandidates: [],
		firstPageText: "",
		firstPageTitleCandidates: [],
		warning,
	};
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
	if (signal.aborted) throw abortError(message);
	let onAbort: (() => void) | null = null;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortError(message));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function sameOpenedFile(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
	return before.dev === after.dev
		&& before.ino === after.ino
		&& before.size === after.size
		&& before.mtimeNs === after.mtimeNs
		&& before.ctimeNs === after.ctimeNs;
}

/**
 * Copies the user-selected PDF once into a private, random task directory.
 * The copy is the authorization object used by both local identity parsing
 * and MinerU, so later replacement of the original path cannot change what
 * is uploaded. The copy loop is bounded and observes the run AbortSignal.
 */
export async function createAuthorizedPdfSnapshot(
	sourcePath: string,
	options: { signal?: AbortSignal; stageRoot?: string } = {},
): Promise<AuthorizedPdfSnapshot> {
	if (!sourcePath || !/\.pdf$/i.test(sourcePath)) throw new Error("未提供可读取的 PDF");
	if (options.signal?.aborted) throw abortError("PDF 授权快照已取消");
	const requested = path.resolve(sourcePath);
	const requestedStats = await fs.promises.lstat(requested, { bigint: true });
	if (requestedStats.isSymbolicLink() || !requestedStats.isFile()) {
		throw new Error("来源 PDF 必须是用户直接选择的普通文件，不能是符号链接或 junction");
	}
	const canonical = await fs.promises.realpath(requested);
	const initial = await fs.promises.stat(canonical, { bigint: true });
	if (!initial.isFile() || !sameOpenedFile(requestedStats, initial)) {
		throw new Error("来源 PDF 在路径解析期间发生变化");
	}
	if (initial.size <= 0n) throw new Error("来源 PDF 为空");
	if (initial.size > BigInt(MAX_LOCAL_PDF_BYTES)) {
		throw new Error("来源 PDF 超过 128 MiB 安全上限，未读取或上传");
	}

	const directory = await fs.promises.mkdtemp(path.join(options.stageRoot || os.tmpdir(), "research-reader-pdf-"));
	const snapshotPath = path.join(directory, "authorized.pdf");
	let source: fs.promises.FileHandle | null = null;
	let destination: fs.promises.FileHandle | null = null;
	try {
		source = await fs.promises.open(canonical, "r");
		const openedBefore = await source.stat({ bigint: true });
		if (!openedBefore.isFile() || !sameOpenedFile(initial, openedBefore)) {
			throw new Error("来源 PDF 在授权快照建立前发生变化");
		}
		destination = await fs.promises.open(snapshotPath, "wx", 0o600);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
		let position = 0;
		while (true) {
			if (options.signal?.aborted) throw abortError("PDF 授权快照已取消");
			const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
			if (!bytesRead) break;
			position += bytesRead;
			if (position > MAX_LOCAL_PDF_BYTES) {
				throw new Error("来源 PDF 在复制期间超过 128 MiB 安全上限");
			}
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			await destination.write(chunk);
		}
		await destination.sync();
		const openedAfter = await source.stat({ bigint: true });
		if (!sameOpenedFile(openedBefore, openedAfter) || BigInt(position) !== openedAfter.size) {
			throw new Error("来源 PDF 在授权快照复制期间发生变化");
		}
		return {
			path: snapshotPath,
			directory,
			originalFileName: safeFileName(sourcePath),
			size: position,
			sha256: hash.digest("hex"),
		};
	} catch (error) {
		try { await destination?.close(); } catch { /* Best effort. */ }
		destination = null;
		try { await source?.close(); } catch { /* Best effort. */ }
		source = null;
		try { await fs.promises.unlink(snapshotPath); } catch { /* File may not exist. */ }
		try { await fs.promises.rmdir(directory); } catch { /* Keep unexpected contents for inspection. */ }
		throw error;
	} finally {
		try { await destination?.close(); } catch { /* Best effort. */ }
		try { await source?.close(); } catch { /* Best effort. */ }
	}
}

export async function disposeAuthorizedPdfSnapshot(snapshot: AuthorizedPdfSnapshot | null): Promise<void> {
	if (!snapshot) return;
	try { await fs.promises.unlink(snapshot.path); } catch { /* Best effort. */ }
	try { await fs.promises.rmdir(snapshot.directory); } catch (error) {
		console.warn("Could not remove authorized PDF snapshot directory", error);
	}
}

/**
 * Reads PDF metadata and page 1 locally through Obsidian's bundled PDF.js.
 * Only the basename and bounded extracted evidence leave this function; the
 * absolute path is never included in the returned model-visible structure.
 */
export async function extractLocalPdfIdentityEvidence(
	sourcePath: string,
	options: { signal?: AbortSignal; deps?: LocalPdfIdentityDeps; displayFileName?: string } = {},
): Promise<LocalPdfIdentityEvidence> {
	const fileName = options.displayFileName || safeFileName(sourcePath);
	if (!sourcePath || !/\.pdf$/i.test(sourcePath)) return unavailable(fileName, "未提供可读取的 PDF");
	const deps = options.deps || {
		statFile: async (value: string) => {
			const stat = await fs.promises.lstat(value);
			return { size: stat.size, isFile: stat.isFile() };
		},
		readFile: async (value: string, signal?: AbortSignal) => new Uint8Array(
			await fs.promises.readFile(value, { signal }),
		),
		loadPdfJs: async () => await loadPdfJs() as PdfJsApi,
	};
	let loadingTask: PdfLoadingTask | null = null;
	let document: PdfDocumentProxy | null = null;
	const deadlineController = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		deadlineController.abort();
	}, PDF_PREFLIGHT_TIMEOUT_MS);
	const onOuterAbort = (): void => deadlineController.abort();
	if (options.signal?.aborted) deadlineController.abort();
	else options.signal?.addEventListener("abort", onOuterAbort, { once: true });
	try {
		if (options.signal?.aborted) throw abortError("本地 PDF 身份预检已取消");
		const stat = await waitForAbortable(
			deps.statFile(sourcePath),
			deadlineController.signal,
			"本地 PDF 身份预检已取消",
		);
		if (!stat.isFile) return unavailable(fileName, "PDF 路径不是普通文件");
		if (stat.size > MAX_LOCAL_PDF_BYTES) return unavailable(fileName, "PDF 超过本地身份预检的 128 MiB 上限");
		const bytes = await waitForAbortable(
			deps.readFile(sourcePath, deadlineController.signal),
			deadlineController.signal,
			"本地 PDF 身份预检已取消",
		);
		if (!bytes.length) return unavailable(fileName, "PDF 文件为空");
		if (bytes.byteLength > MAX_LOCAL_PDF_BYTES) return unavailable(fileName, "PDF 实际读取结果超过 128 MiB 上限");
		const pdfjs = await waitForAbortable(deps.loadPdfJs(), deadlineController.signal, "本地 PDF 身份预检已取消");
		loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
		document = await waitForAbortable(loadingTask.promise, deadlineController.signal, "本地 PDF 身份预检已取消");
		const metadataResult = document.getMetadata
			? await waitForAbortable(
				document.getMetadata().catch(() => ({ info: {}, metadata: null })),
				deadlineController.signal,
				"本地 PDF 身份预检已取消",
			)
			: { info: {}, metadata: null };
		const info = metadataResult.info || {};
		const metadata = metadataResult.metadata;
		const page = await waitForAbortable(document.getPage(1), deadlineController.signal, "本地 PDF 身份预检已取消");
		const content = await waitForAbortable(page.getTextContent(), deadlineController.signal, "本地 PDF 身份预检已取消");
		const viewport = page.getViewport({ scale: 1 });
		const visibleItems = visibleFirstPageItems(content.items || [], viewport);
		const pageText = pageTextFromVisibleItems(visibleItems);
		const titleGroups = firstPageTitleCandidateGroups(visibleItems, viewport);
		const testCandidates = titleGroups.map((group) => ({
			text: group.text,
			boxes: group.items.map((item) => [item.x, item.top, item.right, item.bottom] as [number, number, number, number]),
		}));
		const titleCandidates = options.deps?.verifyTitleCandidates
			? await waitForAbortable(
				options.deps.verifyTitleCandidates(testCandidates),
				deadlineController.signal,
				"本地 PDF 标题可见性验证已取消",
			)
			: await (async () => {
				const rasterTitles = await rasterVerifiedTitleCandidates(page, titleGroups, viewport, deadlineController.signal);
				const rasterGroups = titleGroups.filter((group) => rasterTitles.includes(group.text));
				return await operatorVerifiedTitleCandidates(page, rasterGroups, pdfjs, deadlineController.signal);
			})();
		page.cleanup?.();
		const title = metadataValue(info, metadata, ["Title", "dc:title", "title"]);
		const authors = metadataValue(info, metadata, ["Author", "dc:creator", "creator", "author"]);
		const doiCandidates = extractPdfDoiCandidates([
			...metadataStrings(info, metadata),
			pageText,
		]);
		return {
			status: "available",
			fileName,
			pageCount: Math.max(1, Math.round(Number(document.numPages) || 1)),
			metadataTitle: title,
			trustedMetadataTitle: trustedMetadataTitle(title, fileName),
			metadataAuthors: authors,
			doiCandidates,
			firstPageText: pageText,
			firstPageTitleCandidates: titleCandidates,
			warning: pageText
				? titleCandidates.length || trustedMetadataTitle(title, fileName)
					? ""
					: "第一页没有唯一的高置信标题块；文件名只用于检索，不参与自动身份确认"
				: "第一页没有可见的可提取文本，可能是扫描件；文件名只用于检索，不能自动确认身份",
		};
	} catch (error) {
		if (options.signal?.aborted && error instanceof Error && error.name === "AbortError") throw error;
		if (timedOut) return unavailable(fileName, "本地 PDF 身份预检超过 20 秒，底层读取已取消");
		return unavailable(fileName, "本地 PDF 元数据或第一页无法解析，将回退到 Vault 与书目服务核验");
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onOuterAbort);
		if (document) {
			try { await document.destroy(); } catch { /* Best-effort PDF.js cleanup. */ }
		} else if (loadingTask?.destroy) {
			try { await loadingTask.destroy(); } catch { /* Best-effort PDF.js cleanup. */ }
		}
	}
}
