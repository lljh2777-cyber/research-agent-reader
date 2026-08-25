import { App, TFile, loadPdfJs } from "obsidian";

import { paddedBbox } from "./normalization";
import type { NormalizedBbox } from "./types";

interface PdfViewport {
	width: number;
	height: number;
	convertToViewportPoint?(x: number, y: number): [number, number];
}

interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

interface PdfPageProxy {
	getViewport(options: { scale: number }): PdfViewport;
	getTextContent(): Promise<{
		items: Array<{
			str?: string;
			transform?: number[];
			width?: number;
			height?: number;
			hasEOL?: boolean;
		}>;
	}>;
	render(options: {
		canvasContext: CanvasRenderingContext2D;
		viewport: PdfViewport;
		transform?: number[];
		background?: string;
	}): PdfRenderTask;
	cleanup?(): void;
}

interface PdfDocumentProxy {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
	destroy(): Promise<void>;
}

interface PdfLoadingTask {
	promise: Promise<PdfDocumentProxy>;
	destroy?(): Promise<void>;
}

export interface PdfPageRenderResult {
	width: number;
	height: number;
}

function outputScale(quality: "standard" | "high"): number {
	const density = window.devicePixelRatio || 1;
	return quality === "high"
		? Math.max(1, Math.min(3, density * 1.5))
		: Math.max(1, Math.min(2, density));
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	const context = canvas.getContext("2d", { alpha: false });
	if (!context) throw new Error("当前环境无法创建 PDF Canvas");
	return context;
}

function isCancelledRender(error: unknown): boolean {
	const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /RenderingCancelled|cancelled|canceled/i.test(message);
}

export class MineruPdfRenderer {
	private document: PdfDocumentProxy | null = null;
	private loadingTask: PdfLoadingTask | null = null;
	private readonly pageTasks = new Set<PdfRenderTask>();
	private readonly cropTasks = new Set<PdfRenderTask>();
	private generation = 0;
	private pageGeneration = 0;
	private cropGeneration = 0;
	private renderQuality: "standard" | "high" = "standard";

	setRenderQuality(value: "standard" | "high"): void {
		this.renderQuality = value === "high" ? "high" : "standard";
	}

	get numPages(): number {
		return this.document?.numPages || 0;
	}

	async load(app: App, pdfPath: string): Promise<void> {
		const generation = ++this.generation;
		await this.clearResources();
		if (generation !== this.generation) return;
		const file = app.vault.getAbstractFileByPath(pdfPath);
		if (!(file instanceof TFile)) throw new Error(`未找到阅读器 PDF：${pdfPath}`);
		const bytes = new Uint8Array(await app.vault.readBinary(file));
		if (generation !== this.generation) return;
		const pdfjs = await loadPdfJs();
		if (generation !== this.generation) return;
		const loadingTask = pdfjs.getDocument({ data: bytes }) as PdfLoadingTask;
		this.loadingTask = loadingTask;
		const document = await loadingTask.promise;
		if (generation !== this.generation) {
			await document.destroy();
			return;
		}
		if (this.loadingTask === loadingTask) this.loadingTask = null;
		this.document = document;
	}

	async renderPage(
		pageNumber: number,
		canvas: HTMLCanvasElement,
		availableWidth: number,
		zoom: number,
	): Promise<PdfPageRenderResult> {
		const document = this.document;
		if (!document) throw new Error("PDF 尚未加载");
		const generation = this.pageGeneration;
		const documentGeneration = this.generation;
		const page = await document.getPage(Math.max(1, Math.min(document.numPages, pageNumber)));
		if (generation !== this.pageGeneration || documentGeneration !== this.generation || document !== this.document) {
			throw new DOMException("PDF page render superseded", "AbortError");
		}
		const baseViewport = page.getViewport({ scale: 1 });
		const fitScale = Math.max(0.25, availableWidth / Math.max(1, baseViewport.width));
		const viewport = page.getViewport({ scale: fitScale * Math.max(0.4, Math.min(4, zoom)) });
		const ratio = outputScale(this.renderQuality);
		canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
		canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
		canvas.style.width = `${Math.floor(viewport.width)}px`;
		canvas.style.height = `${Math.floor(viewport.height)}px`;
		const task = page.render({
			canvasContext: getCanvasContext(canvas),
			viewport,
			transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
			background: "#ffffff",
		});
		this.pageTasks.add(task);
		try {
			await task.promise;
		} catch (error) {
			if (isCancelledRender(error)) throw new DOMException("PDF page render cancelled", "AbortError");
			throw error;
		} finally {
			this.pageTasks.delete(task);
		}
		if (generation !== this.pageGeneration || documentGeneration !== this.generation) {
			throw new DOMException("PDF page render superseded", "AbortError");
		}
		return { width: viewport.width, height: viewport.height };
	}

	/**
	 * Read only the PDF text intersecting one normalized MinerU box. PDF.js text
	 * transforms use PDF page coordinates, including crop-box offsets and page
	 * rotation, so always pass them through the viewport before comparing them
	 * with MinerU's top-left normalized coordinates.
	 */
	async extractTextInBbox(pageNumber: number, bbox: NormalizedBbox): Promise<string> {
		const document = this.document;
		if (!document) return "";
		const documentGeneration = this.generation;
		const page = await document.getPage(Math.max(1, Math.min(document.numPages, pageNumber)));
		if (documentGeneration !== this.generation || document !== this.document) return "";
		const viewport = page.getViewport({ scale: 1 });
		const content = await page.getTextContent();
		if (documentGeneration !== this.generation || document !== this.document) return "";
		const target = {
			left: viewport.width * bbox[0] / 1000,
			top: viewport.height * bbox[1] / 1000,
			right: viewport.width * bbox[2] / 1000,
			bottom: viewport.height * bbox[3] / 1000,
		};
		const tolerance = Math.max(3, Math.min(viewport.width, viewport.height) * 0.008);
		const selected = content.items.flatMap((item, order) => {
			const text = String(item.str || "").trim();
			const transform = item.transform;
			if (!text || !transform || transform.length < 6) return [];
			const x = Number(transform[4]);
			const baselineY = Number(transform[5]);
			const itemWidth = Math.max(0, Number(item.width || 0));
			const itemHeight = Math.max(1, Number(item.height || Math.abs(transform[3]) || 1));
			if (![x, baselineY, itemWidth, itemHeight].every(Number.isFinite)) return [];
			const convert = viewport.convertToViewportPoint?.bind(viewport);
			const start = convert ? convert(x, baselineY) : [x, viewport.height - baselineY] as [number, number];
			const end = convert
				? convert(x + itemWidth, baselineY)
				: [x + itemWidth, viewport.height - baselineY] as [number, number];
			const left = Math.min(start[0], end[0]);
			const right = Math.max(start[0], end[0]);
			const baselineTop = Math.min(start[1], end[1]);
			const top = baselineTop - itemHeight;
			const bottom = baselineTop + Math.max(1, itemHeight * 0.2);
			if (
				right < target.left - tolerance
				|| left > target.right + tolerance
				|| bottom < target.top - tolerance
				|| top > target.bottom + tolerance
			) return [];
			return [{
				text,
				x: left,
				y: baselineTop,
				height: itemHeight,
				order,
			}];
		});
		if (!selected.length) return "";
		selected.sort((left, right) => left.y - right.y || left.x - right.x || left.order - right.order);
		const lines: Array<{ y: number; height: number; items: typeof selected }> = [];
		for (const item of selected) {
			const line = lines[lines.length - 1];
			if (!line || Math.abs(line.y - item.y) > Math.max(line.height, item.height) * 0.65) {
				lines.push({ y: item.y, height: item.height, items: [item] });
				continue;
			}
			line.items.push(item);
			line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
			line.height = Math.max(line.height, item.height);
		}
		return lines
			.flatMap((line) => line.items.sort((left, right) => left.x - right.x || left.order - right.order))
			.map((item) => item.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}

	async renderCrop(
		pageNumber: number,
		bbox: NormalizedBbox,
		padding: number,
		canvas: HTMLCanvasElement,
		availableWidth: number,
	): Promise<PdfPageRenderResult> {
		const document = this.document;
		if (!document) throw new Error("缺少 PDF，无法重建完整图");
		this.cancelCropRender();
		const generation = ++this.cropGeneration;
		const documentGeneration = this.generation;
		const page = await document.getPage(Math.max(1, Math.min(document.numPages, pageNumber)));
		if (generation !== this.cropGeneration || documentGeneration !== this.generation || document !== this.document) {
			throw new DOMException("PDF crop render superseded", "AbortError");
		}
		const baseViewport = page.getViewport({ scale: 1 });
		const crop = paddedBbox(bbox, padding);
		const cropWidthAtOne = baseViewport.width * (crop[2] - crop[0]) / 1000;
		const scale = Math.max(0.5, Math.min(4, availableWidth / Math.max(1, cropWidthAtOne)));
		const viewport = page.getViewport({ scale });
		const left = viewport.width * crop[0] / 1000;
		const top = viewport.height * crop[1] / 1000;
		const width = viewport.width * (crop[2] - crop[0]) / 1000;
		const height = viewport.height * (crop[3] - crop[1]) / 1000;
		const ratio = outputScale(this.renderQuality);
		canvas.width = Math.max(1, Math.floor(width * ratio));
		canvas.height = Math.max(1, Math.floor(height * ratio));
		canvas.style.width = `${Math.floor(width)}px`;
		canvas.style.height = `${Math.floor(height)}px`;
		const task = page.render({
			canvasContext: getCanvasContext(canvas),
			viewport,
			transform: [ratio, 0, 0, ratio, -left * ratio, -top * ratio],
			background: "#ffffff",
		});
		this.cropTasks.add(task);
		try {
			await task.promise;
		} catch (error) {
			if (isCancelledRender(error)) throw new DOMException("PDF crop render cancelled", "AbortError");
			throw error;
		} finally {
			this.cropTasks.delete(task);
		}
		if (generation !== this.cropGeneration || documentGeneration !== this.generation) {
			throw new DOMException("PDF crop render superseded", "AbortError");
		}
		return { width, height };
	}

	cancelPageRender(): void {
		this.pageGeneration += 1;
		for (const task of this.pageTasks) {
			try {
				task.cancel();
			} catch {
				// PDF.js can throw when a completed task is cancelled during teardown.
			}
		}
		this.pageTasks.clear();
	}

	cancelCropRender(): void {
		this.cropGeneration += 1;
		for (const task of this.cropTasks) {
			try {
				task.cancel();
			} catch {
				// See cancelPageRender.
			}
		}
		this.cropTasks.clear();
	}

	async destroy(): Promise<void> {
		this.generation += 1;
		await this.clearResources();
	}

	private async clearResources(): Promise<void> {
		this.cancelPageRender();
		this.cancelCropRender();
		const document = this.document;
		const loadingTask = this.loadingTask;
		this.document = null;
		this.loadingTask = null;
		if (document) {
			try {
				await document.destroy();
			} catch {
				// The document may already be destroyed by a cancelled loading task.
			}
		} else if (loadingTask?.destroy) {
			try {
				await loadingTask.destroy();
			} catch {
				// Ignore teardown races.
			}
		}
	}
}
