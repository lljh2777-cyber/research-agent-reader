import { loadPdfJs } from "obsidian";

import { paddedBbox } from "./normalization";
import type { NormalizedBbox } from "./types";
import { MINERU_RESOURCE_LIMITS } from "./resource-limits";

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
	private readonly canvasPixels = new Map<HTMLCanvasElement, number>();
	private activeCanvasPixels = 0;

	setRenderQuality(value: "standard" | "high"): void {
		this.renderQuality = value === "high" ? "high" : "standard";
	}

	get numPages(): number {
		return this.document?.numPages || 0;
	}

	async loadBytes(sourceBytes: Uint8Array): Promise<void> {
		const generation = ++this.generation;
		await this.clearResources();
		if (generation !== this.generation) return;
		if (!sourceBytes.byteLength || sourceBytes.byteLength > MINERU_RESOURCE_LIMITS.pdfBytes) {
			throw new Error("阅读器 PDF 为空或超过安全上限");
		}
		const bytes = sourceBytes.slice();
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
		if (!Number.isInteger(document.numPages) || document.numPages < 1
			|| document.numPages > MINERU_RESOURCE_LIMITS.pdfPages) {
			await document.destroy();
			throw new Error(`PDF 页数无效或超过 ${MINERU_RESOURCE_LIMITS.pdfPages} 页安全上限`);
		}
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
		this.assertViewport(baseViewport);
		const fitScale = Math.max(0.25, availableWidth / Math.max(1, baseViewport.width));
		const viewport = page.getViewport({ scale: fitScale * Math.max(0.4, Math.min(4, zoom)) });
		this.assertViewport(viewport);
		const ratio = outputScale(this.renderQuality);
		this.allocateCanvas(canvas, viewport.width * ratio, viewport.height * ratio);
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
		this.assertViewport(baseViewport);
		const crop = paddedBbox(bbox, padding);
		const cropWidthAtOne = baseViewport.width * (crop[2] - crop[0]) / 1000;
		const scale = Math.max(0.5, Math.min(4, availableWidth / Math.max(1, cropWidthAtOne)));
		const viewport = page.getViewport({ scale });
		this.assertViewport(viewport);
		const left = viewport.width * crop[0] / 1000;
		const top = viewport.height * crop[1] / 1000;
		const width = viewport.width * (crop[2] - crop[0]) / 1000;
		const height = viewport.height * (crop[3] - crop[1]) / 1000;
		const ratio = outputScale(this.renderQuality);
		this.allocateCanvas(canvas, width * ratio, height * ratio);
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
		this.releaseCanvasResources();
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
		this.releaseCanvasResources();
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
		this.releaseCanvasResources();
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

	private assertViewport(viewport: PdfViewport): void {
		const { width, height } = viewport;
		if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
			throw new Error("PDF 页面尺寸无效");
		}
		const aspect = Math.max(width / height, height / width);
		if (aspect > MINERU_RESOURCE_LIMITS.pageAspectRatio) throw new Error("PDF 页面长宽比超过安全上限");
	}

	private allocateCanvas(canvas: HTMLCanvasElement, rawWidth: number, rawHeight: number): void {
		const width = Math.max(1, Math.floor(rawWidth));
		const height = Math.max(1, Math.floor(rawHeight));
		const pixels = width * height;
		if (width > MINERU_RESOURCE_LIMITS.canvasDimension
			|| height > MINERU_RESOURCE_LIMITS.canvasDimension
			|| !Number.isSafeInteger(pixels)
			|| pixels > MINERU_RESOURCE_LIMITS.canvasPixels) {
			throw new Error("PDF Canvas 尺寸或像素数超过安全上限");
		}
		const previous = this.canvasPixels.get(canvas) || 0;
		if (this.activeCanvasPixels - previous + pixels > MINERU_RESOURCE_LIMITS.activeCanvasPixels) {
			throw new Error("PDF 活动画布累计像素超过安全上限");
		}
		this.activeCanvasPixels = this.activeCanvasPixels - previous + pixels;
		this.canvasPixels.set(canvas, pixels);
		canvas.width = width;
		canvas.height = height;
	}

	private releaseCanvasResources(): void {
		for (const canvas of this.canvasPixels.keys()) {
			canvas.width = 0;
			canvas.height = 0;
		}
		this.canvasPixels.clear();
		this.activeCanvasPixels = 0;
	}
}
