import { App, TFile, loadPdfJs, type WorkspaceLeaf } from "obsidian";
import { bytesDigest } from "../papers/identity";
import { PDF_EXCERPT_MAX_BYTES, PDF_EXCERPT_MAX_PAGES, pdfPageText, pdfReceipt, pdfRecordSelection, preparePdfExcerpt, supportsPdfExcerpt, type PdfPageText } from "./pdf-excerpt";
import type { AnnotationRecord, AnnotationSelection } from "./types";

interface PdfDocument {
	numPages: number;
	getData(): Promise<Uint8Array>;
	getPage(page: number): Promise<{ getTextContent(options: { disableNormalization: true }): Promise<{ items: unknown[] }> }>;
}
interface NativePdf {
	getViewType(): string;
	file?: TFile;
	contentEl: HTMLElement;
	viewer?: { child?: { pdfViewer?: { pdfDocument?: PdfDocument; pdfViewer?: { getPageView(index: number): { div: HTMLElement } | undefined; currentPageNumber: number } } } };
}
const element = (node: Node): Element | null => node.nodeType === 1 ? node as Element : node.parentElement;
const failure = (): Error => new Error("请在原生 PDF 同一页的文字层中重新划选文字；跨页、扫描图片或不兼容的文字层暂不支持");
function native(leaf: WorkspaceLeaf | null | undefined): NativePdf | undefined {
	const view = leaf?.view as unknown as NativePdf | undefined;
	return view?.getViewType() === "pdf" && view.file instanceof TFile && supportsPdfExcerpt(view.file.path) ? view : undefined;
}
export function hasNativePdfSelection(app: App): boolean {
	const view = native(app.workspace.activeLeaf), selection = view?.contentEl.ownerDocument.defaultView?.getSelection();
	return Boolean(view && selection?.rangeCount === 1 && !selection.isCollapsed && view.contentEl.contains(selection.getRangeAt(0).startContainer)
		&& element(selection.getRangeAt(0).startContainer)?.closest(".textLayer"));
}
export async function readPdfBytes(app: App, sourcePath: string, signal?: AbortSignal): Promise<Uint8Array> {
	signal?.throwIfAborted();
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!supportsPdfExcerpt(sourcePath) || !(file instanceof TFile)) throw new Error("PDF 原文已缺失或路径不受支持；保留历史摘录，需复查");
	if (file.stat?.size > PDF_EXCERPT_MAX_BYTES) throw new Error("PDF 超过 64 MiB 摘录核对上限");
	const bytes = new Uint8Array(await app.vault.readBinary(file)); signal?.throwIfAborted();
	if (!bytes.length || bytes.length > PDF_EXCERPT_MAX_BYTES) throw new Error("PDF 文件为空或超过 64 MiB 上限");
	if (file.path !== sourcePath || app.vault.getAbstractFileByPath(sourcePath) !== file) throw new Error("PDF 在读取时已移动或替换，请重新打开");
	return bytes;
}
function boundary(layer: HTMLElement, page: PdfPageText, node: Node, offset: number): number {
	const span = element(node)?.closest<HTMLElement>("[data-idx]");
	if (!span || !layer.contains(span) || !/^\d+$/.test(span.dataset.idx || "")) throw failure();
	const index = Number(span.dataset.idx), item = page.items[index];
	if (!item || span.textContent !== item.str) throw failure();
	const before = layer.ownerDocument.createRange(); before.selectNodeContents(span); before.setEnd(node, offset);
	const local = before.toString().length;
	if (local > item.str.length) throw failure();
	return page.starts[index] + local;
}
/** data-idx is an Obsidian runtime adapter, checked against every item before it can identify an occurrence. */
function validateLayer(layer: HTMLElement, page: PdfPageText): void {
	const nodes = [...layer.querySelectorAll<HTMLElement>("[data-idx]")], seen = new Set<number>(); let previous = -1;
	for (const node of nodes) {
		if (!/^\d+$/.test(node.dataset.idx || "")) throw failure();
		const i = Number(node.dataset.idx);
		if (i <= previous || seen.has(i) || !page.items[i] || node.textContent !== page.items[i].str) throw failure();
		seen.add(i); previous = i;
	}
	if (page.items.some((item, i) => item.str && !seen.has(i))) throw failure();
}
export async function captureNativePdfSelection(app: App): Promise<AnnotationSelection> {
	const leaf = app.workspace.activeLeaf, view = native(leaf), selection = view?.contentEl.ownerDocument.defaultView?.getSelection();
	if (!view?.file || !selection || selection.rangeCount !== 1 || selection.isCollapsed) throw failure();
	const range = selection.getRangeAt(0).cloneRange(), layer = element(range.startContainer)?.closest<HTMLElement>(".textLayer"), last = element(range.endContainer)?.closest(".textLayer");
	const pageEl = layer?.closest<HTMLElement>(".page[data-page-number]"), doc = view.viewer?.child?.pdfViewer?.pdfDocument, sourcePath = view.file.path;
	if (!layer || layer !== last || !pageEl || !view.contentEl.contains(layer) || !doc || typeof doc.getData !== "function") throw failure();
	const page = Number(pageEl.dataset.pageNumber);
	if (!Number.isSafeInteger(page) || page < 1 || page > doc.numPages || doc.numPages > PDF_EXCERPT_MAX_PAGES) throw failure();
	const anchorRect = range.getBoundingClientRect(), bytes = await readPdfBytes(app, sourcePath);
	const shown = await doc.getData();
	if (shown.length !== bytes.length || bytesDigest(shown) !== bytesDigest(bytes)) throw new Error("阅读器仍显示另一版本的 PDF，请关闭此页并重新打开后划选");
	const text = pdfPageText((await (await doc.getPage(page)).getTextContent({ disableNormalization: true })).items);
	if (app.workspace.activeLeaf !== leaf || view.file?.path !== sourcePath || view.viewer?.child?.pdfViewer?.pdfDocument !== doc || !layer.isConnected) throw new Error("PDF 阅读视图已变化，请重新选择");
	validateLayer(layer, text);
	const start = boundary(layer, text, range.startContainer, range.startOffset), end = boundary(layer, text, range.endContainer, range.endOffset);
	if (end - start > 600) throw new Error("单次最多保存 600 个字符，请缩小 PDF 选区");
	const result: AnnotationSelection = { sourcePath, selectedText: text.text.slice(start, end), sourceStart: start, sourceEnd: end,
		prefix: text.text.slice(Math.max(0, start - 80), start), suffix: text.text.slice(end, end + 80), section: `PDF 第 ${page} 页（文件页码）`,
		context: "", isTableCell: false, anchorRect, pdfExcerpt: pdfReceipt(bytes, page, doc.numPages, text, start, end) };
	preparePdfExcerpt(result, bytes, text, doc.numPages);
	result.context = result.pdfExcerpt!.context;
	return result;
}
export async function verifyPdfSelection(app: App, selection: AnnotationSelection, signal?: AbortSignal): Promise<ReturnType<typeof preparePdfExcerpt>> {
	const bytes = await readPdfBytes(app, selection.sourcePath, signal), r = selection.pdfExcerpt;
	if (!r || bytes.length !== r.byteLength || bytesDigest(bytes) !== r.digest) throw new Error("PDF 文件版本已变化；保留历史摘录，需复查");
	const pdfjs = await loadPdfJs(); signal?.throwIfAborted();
	const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
	const abort = () => { void Promise.resolve(task.destroy()).catch(() => {}); };
	signal?.addEventListener("abort", abort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const operation = async () => {
			const doc: PdfDocument = await task.promise; signal?.throwIfAborted();
			if (doc.numPages !== r.pageCount || doc.numPages > PDF_EXCERPT_MAX_PAGES) throw new Error("PDF 页数与摘录凭据不一致");
			const page = pdfPageText((await (await doc.getPage(r.page)).getTextContent({ disableNormalization: true })).items); signal?.throwIfAborted();
			return preparePdfExcerpt(selection, bytes, page, doc.numPages);
		};
		return await Promise.race([operation(), new Promise<never>((_, reject) => { timeout = setTimeout(() => { abort(); reject(new Error("PDF 页内核对超时，请稍后重试")); }, 15000); })]);
	} finally { if (timeout) clearTimeout(timeout); signal?.removeEventListener("abort", abort); await task.destroy(); }
}
export async function pdfExcerptStatus(app: App, record: AnnotationRecord, signal?: AbortSignal): Promise<string> {
	const prepared = await verifyPdfSelection(app, pdfRecordSelection(record), signal);
	if (prepared.id !== record.id) throw new Error("PDF 摘录 ID 与保存位置不一致，需复查");
	return `PDF 文件版本与第 ${record.pdfExcerpt!.page} 页选区一致；科学结论需另行审阅`;
}
function pointAt(layer: HTMLElement, page: PdfPageText, at: number, end: boolean): { node: Node; offset: number } {
	const indexes = page.items.map((_, i) => i); if (end) indexes.reverse();
	for (const i of indexes) {
		const item = page.items[i], offset = at - page.starts[i];
		if (!item.str || offset < 0 || offset > item.str.length) continue;
		const span = layer.querySelector<HTMLElement>(`[data-idx="${i}"]`); if (!span) continue;
		const walker = layer.ownerDocument.createTreeWalker(span, 4); let node: Node | null, remaining = offset;
		while ((node = walker.nextNode())) { if (remaining <= (node.textContent || "").length) return { node, offset: remaining }; remaining -= (node.textContent || "").length; }
	}
	throw failure();
}
export async function openPdfExcerpt(app: App, record: AnnotationRecord, recheck: () => Promise<void>, signal?: AbortSignal): Promise<void> {
	const stable = structuredClone(record); await pdfExcerptStatus(app, stable, signal); await recheck(); signal?.throwIfAborted();
	const file = app.vault.getAbstractFileByPath(stable.sourcePath); if (!(file instanceof TFile)) throw failure();
	const leaf = app.workspace.getLeaf("tab");
	await leaf.openFile(file, { active: true });
	const deadline = Date.now() + 8000;
	let view: NativePdf | undefined, layer: HTMLElement | null = null, doc: PdfDocument | undefined;
	while (Date.now() < deadline) {
		signal?.throwIfAborted(); view = native(leaf);
		if (view?.file?.path !== stable.sourcePath) throw new Error("PDF 打开期间视图已切换，未定位选区");
		const viewer = view.viewer?.child?.pdfViewer;
		if (viewer?.pdfDocument && viewer.pdfViewer?.getPageView) {
			// pdfDocument becomes available before the viewer has constructed its page views.
			const pageView = viewer.pdfViewer.getPageView(stable.pdfExcerpt!.page - 1);
			if (pageView) {
				doc = viewer.pdfDocument;
				if (viewer.pdfViewer.currentPageNumber !== stable.pdfExcerpt!.page) viewer.pdfViewer.currentPageNumber = stable.pdfExcerpt!.page;
				layer = pageView.div.querySelector<HTMLElement>(".textLayer") || null;
				if (layer?.querySelector("[data-idx]")) break;
			}
		}
		await new Promise(resolve => setTimeout(resolve, 80));
	}
	if (!view || !doc || !layer) throw new Error("PDF 已打开，但文字层尚不可定位，请加载后重试");
	const shown = await doc.getData(), text = pdfPageText((await (await doc.getPage(stable.pdfExcerpt!.page)).getTextContent({ disableNormalization: true })).items);
	const prepared = preparePdfExcerpt(pdfRecordSelection(stable), shown, text, doc.numPages);
	if (prepared.id !== stable.id) throw new Error("PDF 当前显示的文件与历史摘录不一致，未定位");
	await recheck(); const current = await readPdfBytes(app, stable.sourcePath, signal);
	if (bytesDigest(current) !== stable.pdfExcerpt!.digest || app.workspace.activeLeaf !== leaf || view.file?.path !== stable.sourcePath || view.viewer?.child?.pdfViewer?.pdfDocument !== doc || !layer.isConnected) throw new Error("PDF 或摘录在打开期间变化，未定位选区");
	signal?.throwIfAborted(); validateLayer(layer, text);
	const start = pointAt(layer, text, stable.sourceAnchor!.start, false), end = pointAt(layer, text, stable.sourceAnchor!.end, true);
	const range = layer.ownerDocument.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
	const selection = layer.ownerDocument.defaultView?.getSelection(); if (!selection) throw failure();
	selection.removeAllRanges(); selection.addRange(range); element(start.node)?.scrollIntoView({ block: "center" });
}
