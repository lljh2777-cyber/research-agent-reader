import * as fs from "node:fs";

import { loadPdfJs } from "obsidian";

const FIRST_PAGE_TEXT_LIMIT = 8_000;
const MAX_LOCAL_PDF_BYTES = 512 * 1024 * 1024;
const PDF_PREFLIGHT_TIMEOUT_MS = 20_000;
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;

interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
}
interface PdfPageProxy {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
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
}

export interface LocalPdfIdentityEvidence {
	status: "available" | "unavailable";
	fileName: string;
	pageCount: number;
	metadataTitle: string;
	metadataAuthors: string;
	doiCandidates: string[];
	firstPageText: string;
	warning: string;
}

export interface LocalPdfIdentityDeps {
	readFile(sourcePath: string): Promise<Uint8Array>;
	loadPdfJs(): Promise<PdfJsApi>;
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

function firstPageText(items: readonly PdfTextItem[]): string {
	let output = "";
	for (const item of items) {
		const text = cleanPdfText(item.str, 1_000);
		if (!text) continue;
		output += `${output && !output.endsWith("\n") ? " " : ""}${text}${item.hasEOL ? "\n" : ""}`;
		if (output.length >= FIRST_PAGE_TEXT_LIMIT * 2) break;
	}
	return cleanPdfText(output, FIRST_PAGE_TEXT_LIMIT);
}

function unavailable(fileName: string, warning: string): LocalPdfIdentityEvidence {
	return {
		status: "unavailable",
		fileName,
		pageCount: 0,
		metadataTitle: "",
		metadataAuthors: "",
		doiCandidates: [],
		firstPageText: "",
		warning,
	};
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

async function withDeadline<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let onAbort: (() => void) | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("本地 PDF 身份预检超过 20 秒")), PDF_PREFLIGHT_TIMEOUT_MS);
	});
	const aborted = new Promise<never>((_, reject) => {
		if (!signal) return;
		onAbort = () => reject(abortError("本地 PDF 身份预检已取消"));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, timeout, aborted]);
	} finally {
		if (timer !== null) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Reads PDF metadata and page 1 locally through Obsidian's bundled PDF.js.
 * Only the basename and bounded extracted evidence leave this function; the
 * absolute path is never included in the returned model-visible structure.
 */
export async function extractLocalPdfIdentityEvidence(
	sourcePath: string,
	options: { signal?: AbortSignal; deps?: LocalPdfIdentityDeps } = {},
): Promise<LocalPdfIdentityEvidence> {
	const fileName = safeFileName(sourcePath);
	if (!sourcePath || !/\.pdf$/i.test(sourcePath)) return unavailable(fileName, "未提供可读取的 PDF");
	const deps = options.deps || {
		readFile: async (value: string) => new Uint8Array(await fs.promises.readFile(value)),
		loadPdfJs: async () => await loadPdfJs() as PdfJsApi,
	};
	let loadingTask: PdfLoadingTask | null = null;
	let document: PdfDocumentProxy | null = null;
	try {
		if (options.signal?.aborted) throw abortError("本地 PDF 身份预检已取消");
		const bytes = await withDeadline(deps.readFile(sourcePath), options.signal);
		if (!bytes.length) return unavailable(fileName, "PDF 文件为空");
		if (bytes.length > MAX_LOCAL_PDF_BYTES) return unavailable(fileName, "PDF 超过本地身份预检的 512 MB 上限");
		const pdfjs = await withDeadline(deps.loadPdfJs(), options.signal);
		loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
		document = await withDeadline(loadingTask.promise, options.signal);
		const metadataResult = document.getMetadata
			? await withDeadline(document.getMetadata().catch(() => ({ info: {}, metadata: null })), options.signal)
			: { info: {}, metadata: null };
		const info = metadataResult.info || {};
		const metadata = metadataResult.metadata;
		const page = await withDeadline(document.getPage(1), options.signal);
		const content = await withDeadline(page.getTextContent(), options.signal);
		const pageText = firstPageText(content.items || []);
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
			metadataAuthors: authors,
			doiCandidates,
			firstPageText: pageText,
			warning: pageText ? "" : "第一页没有可提取文本，可能是扫描件；仍可使用 PDF 元数据和文件名",
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		return unavailable(fileName, "本地 PDF 元数据或第一页无法解析，将回退到 Vault 与书目服务核验");
	} finally {
		if (document) {
			try { await document.destroy(); } catch { /* Best-effort PDF.js cleanup. */ }
		} else if (loadingTask?.destroy) {
			try { await loadingTask.destroy(); } catch { /* Best-effort PDF.js cleanup. */ }
		}
	}
}
