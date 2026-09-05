import { TFile, loadPdfJs, type App } from "obsidian";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { MineruPackageLoader } from "../mineru/package-loader";
import { MINERU_RESOURCE_LIMITS } from "../mineru/resource-limits";
import { tokenizeForLexicalRetrieval } from "../query/lexical-retrieval";
import type { ReadingEvidence, ReadingImage, ReadingSource } from "./types";

interface PdfPage {
	getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
	getViewport(options: { scale: number }): { width: number; height: number };
	render(options: unknown): { promise: Promise<void>; cancel(): void };
}
interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPage>; destroy(): Promise<void> }
export interface ReadingDocument {
	source: ReadingSource;
	evidence: ReadingEvidence[];
	catalog: string;
	image(evidence: ReadingEvidence, signal?: AbortSignal): Promise<ReadingImage | null>;
	verify(): Promise<void>;
	destroy(): Promise<void>;
}
export const readingHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export function readingCatalog(evidence: ReadingEvidence[]): string {
	// Preserve every location even when a paper needs shorter preview snippets.
	const locations = evidence.map((item) => item.id + (item.asset ? " [图像] " : " ") + item.label.slice(0, 100));
	const remaining = 48_000 - locations.join("\n").length - evidence.length;
	if (remaining < 0) throw new Error("原文证据目录超过本轮支持范围，请选择较小的论文文件");
	const previewLength = Math.min(240, Math.floor(remaining / Math.max(1, evidence.length)));
	return locations.map((location, index) => location + " " + evidence[index].text.replace(/\s+/g, " ").slice(0, previewLength)).join("\n");
}
export function textEvidence(text: string, sourcePath: string, page?: number): ReadingEvidence[] {
	const blocks: ReadingEvidence[] = [];
	let section = page ? "第 " + page + " 页" : "正文";
	const lines = text.split(/(?<=\n)/);
	let start = 0; let chunkStart = 0; let chunk = "";
	const flush = (): void => {
		if (chunk.trim()) blocks.push({ id: "text-" + (page || 0) + "-" + chunkStart, kind: "paper", path: sourcePath,
			label: section, text: chunk, start: chunkStart, end: chunkStart + chunk.length, ...(page ? { page } : {}) });
		chunk = "";
	};
	for (const line of lines) {
		if (/^#{1,6}\s/.test(line)) { flush(); section = line.replace(/^#+\s*/, "").trim().slice(0, 180); chunkStart = start; }
		for (let offset = 0; offset < line.length; offset += 3000) {
			const part = line.slice(offset, offset + 3000);
			if (chunk.length + part.length > 4500) { flush(); chunkStart = start + offset; }
			if (!chunk) chunkStart = start + offset;
			chunk += part;
		}
		start += line.length;
	}
	flush(); return blocks;
}
export function uniqueEvidencePage(item: ReadingEvidence, locations: Array<{ page: number; start: number; end: number }>): number | undefined {
	if (item.start === undefined || item.end === undefined) return undefined;
	const pages = new Set(locations.filter((range) => range.start < item.end! && range.end > item.start!).map((range) => range.page));
	return pages.size === 1 ? [...pages][0] : undefined;
}
export function selectReadingEvidence(document: ReadingDocument, query: string, step: number, preferredIds: string[] = []): ReadingEvidence[] {
	const terms = tokenizeForLexicalRetrieval(query, 60);
	const textItems = document.evidence.filter((item) => !item.asset);
	const focus = Math.min(textItems.length - 1, Math.max(0, step));
	const ranked = document.evidence.map((item, index) => {
		const haystack = (item.label + " " + item.text).toLowerCase();
		const score = terms.reduce((sum, term) => sum + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0)
			+ (preferredIds.includes(item.id) ? 1000 : 0) + (textItems[focus]?.id === item.id ? 0.1 : 0);
		return { item, score, index };
	}).sort((a, b) => b.score - a.score || a.index - b.index);
	const selected: ReadingEvidence[] = [];
	let chars = 0;
	for (const { item } of ranked) {
		if (selected.length >= 12 || chars + item.text.length > 38_000) continue;
		selected.push({ ...item }); chars += item.text.length;
	}
	// A text block's page or adjacent extracted image is evidence for visual questions.
	const pages = new Set(selected.map((item) => item.page).filter(Boolean));
	for (const item of document.evidence.filter((item) => item.asset && item.page && pages.has(item.page)).slice(0, 3)) {
		if (!selected.some((current) => current.id === item.id)) selected.push({ ...item });
	}
	return selected;
}
export class ReadingDocumentLoader {
	constructor(private readonly app: App, private readonly vaultRoot: string) {}
	async open(kind: ReadingSource["kind"], rawPath: string): Promise<ReadingDocument> {
		return kind === "pdf" ? this.pdf(rawPath) : this.article(rawPath.replace(/\\/g, "/"));
	}
	private async pdf(rawPath: string): Promise<ReadingDocument> {
		const filename = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(this.vaultRoot, rawPath);
		if (!/\.pdf$/i.test(filename)) throw new Error("请选择 PDF 文件");
		const read = async (): Promise<Uint8Array> => {
			const handle = await fs.open(filename, "r");
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > MINERU_RESOURCE_LIMITS.pdfBytes) throw new Error("PDF 无效或超过 64 MiB");
				const bytes = new Uint8Array(await handle.readFile());
				if (!bytes.length || bytes.length > MINERU_RESOURCE_LIMITS.pdfBytes) throw new Error("PDF 为空或过大");
				return bytes;
			} finally { await handle.close(); }
		};
		const bytes = await read(); const fingerprint = readingHash(bytes);
		const api = await loadPdfJs();
		const loading = api.getDocument({ data: bytes, isEvalSupported: false });
		const pdf = await loading.promise as PdfDocument;
		try {
			if (!pdf.numPages || pdf.numPages > MINERU_RESOURCE_LIMITS.pdfPages) throw new Error("PDF 页数超过支持范围");
			const evidence: ReadingEvidence[] = [];
			for (let number = 1; number <= pdf.numPages; number++) {
				const page = await pdf.getPage(number);
				const content = await page.getTextContent();
				const text = content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("");
				evidence.push(...textEvidence(text, filename, number));
				evidence.push({ id: "page-" + number, kind: "paper", path: filename, label: "PDF 第 " + number + " 页图像",
					page: number, text: text.trim() ? text.slice(0, 1200) : "此页无可用文本层，需要视觉读取。", asset: "pdf-page" });
			}
			const source: ReadingSource = { kind: "pdf", path: filename, fingerprint, title: path.basename(filename, path.extname(filename)) };
			return { source, evidence, catalog: readingCatalog(evidence),
				verify: async () => { if (readingHash(await read()) !== fingerprint) throw new Error("原始 PDF 已变化，请保留旧会话并重新选择来源创建会话"); },
				destroy: () => pdf.destroy(), image: async (item, signal) => {
					signal?.throwIfAborted();
					if (!item.asset || !item.page) return null;
					const page = await pdf.getPage(item.page); const original = page.getViewport({ scale: 1 });
					const scale = Math.min(2, 1600 / Math.max(original.width, original.height));
					const viewport = page.getViewport({ scale });
					if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error("PDF 页面尺寸无效");
					const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
					try {
						const context = canvas.getContext("2d"); if (!context) throw new Error("PDF 图像渲染不可用");
						// Evidence is offscreen: print intent avoids waiting for a foreground animation frame.
						const render = page.render({ canvasContext: context, viewport, background: "white", intent: "print" });
						const cancel = (): void => render.cancel(); signal?.addEventListener("abort", cancel, { once: true });
						try { if (signal?.aborted) cancel(); await render.promise; signal?.throwIfAborted(); }
						finally { signal?.removeEventListener("abort", cancel); }
						return { evidenceId: item.id, dataUrl: canvas.toDataURL("image/png") };
					} finally { canvas.width = 0; canvas.height = 0; }
				} };
		} catch (error) { await pdf.destroy(); throw error; }
	}
	private async article(articlePath: string): Promise<ReadingDocument> {
		if (!/^papers\/[^/]+\/article\.md$/.test(articlePath)) throw new Error("请选择 papers/<citekey>/article.md 已验证原文包");
		const loader = new MineruPackageLoader(this.app);
		const fingerprint = async (): Promise<string> => {
			const file = this.app.vault.getAbstractFileByPath(articlePath);
			const manifest = this.app.vault.getAbstractFileByPath(articlePath.replace(/article\.md$/, "_extraction/manifest.json"));
			if (!(file instanceof TFile) || !(manifest instanceof TFile)) throw new Error("原文或清单不存在");
			return readingHash(Buffer.concat([Buffer.from(await this.app.vault.readBinary(file)), Buffer.from(await this.app.vault.readBinary(manifest))]));
		};
		const hash = await fingerprint();
		const loaded = await loader.load(articlePath);
		if (await fingerprint() !== hash) throw new Error("读取期间原文包已变化，请重新选择来源");
		const evidence = textEvidence(loaded.articleMarkdown, articlePath);
		const locations = loaded.viewerIndex.pages.flatMap((page) => page.blocks.flatMap((block) => [block.markdown_text_range, block.markdown_table_range]
			.filter((range) => range !== undefined).map((range) => ({ page: page.page_idx + 1, start: range!.start, end: range!.end }))));
		for (const item of evidence) item.page = uniqueEvidencePage(item, locations);
		loaded.visuals.forEach((visual, index) => {
			const assets = visual.memberAssetPaths.length ? visual.memberAssetPaths : [visual.anchorAssetPath];
			assets.filter((asset) => loaded.verifiedAssetBlobs.has(asset)).forEach((asset, part) => evidence.push({
				id: "figure-" + index + "-" + part, kind: "paper", path: articlePath, label: visual.label,
				text: visual.caption, page: visual.pageIdx + 1, asset,
			}));
		});
		return { source: { kind: "article", path: articlePath, fingerprint: hash, title: loaded.title }, evidence,
			catalog: readingCatalog(evidence),
			verify: async () => { await loader.load(articlePath); if (await fingerprint() !== hash) throw new Error("原文包已变化，请重新选择来源创建会话"); },
			destroy: async () => { loaded.verifiedAssetBlobs.clear(); loaded.verifiedPdfBytes = null; },
			image: async (item) => {
				const blob = item.asset ? loaded.verifiedAssetBlobs.get(item.asset) : null;
				if (!blob) return null;
				if (blob.size > 12 * 1024 * 1024) throw new Error("图像超过单轮读取上限");
				return { evidenceId: item.id, dataUrl: "data:" + (blob.type || "image/png") + ";base64," + Buffer.from(await blob.arrayBuffer()).toString("base64") };
			} };
	}
}
