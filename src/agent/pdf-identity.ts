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
	statFile(sourcePath: string): Promise<{ size: number; isFile: boolean }>;
	readFile(sourcePath: string, signal?: AbortSignal): Promise<Uint8Array>;
	loadPdfJs(): Promise<PdfJsApi>;
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
