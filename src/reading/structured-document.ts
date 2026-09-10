import * as path from "node:path";
import { loadJatsSource, verifyLoadedJatsSource } from "../sources/jats-package";
import { FileSourceStorage, type SourceStorage } from "../sources/storage";
import { objectDigest } from "../papers/identity";
import { imageInfo } from "../jats/media";
import { readingCatalog, type ReadingDocument } from "./document";
import { structuredEvidenceId, structuredFingerprint, type StructuredReadingLocation, type StructuredReadingSnapshot } from "./structured-source";
import type { ReadingEvidence, ReadingSource } from "./types";
import { setTimeout, clearTimeout } from "node:timers";

/** Decode the verified image before marking visual evidence available to a model. */
export async function renderStructuredImage(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const image = new Image(), url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); image.onload = image.onerror = null; error ? reject(error) : resolve(); };
			const abort = (): void => finish(new Error("图像读取已停止"));
			const timer = setTimeout(() => finish(new Error("图像解码超时，图像尚未核验")), 15_000);
			signal?.addEventListener("abort", abort, { once: true });
			image.onload = () => finish(); image.onerror = () => finish(new Error("原文图像无法解码，图像尚未核验")); image.src = url;
		});
		signal?.throwIfAborted();
		if (!image.naturalWidth || !image.naturalHeight) throw new Error("原文图像没有有效尺寸");
		const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
		const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		try { const context = canvas.getContext("2d"); if (!context) throw new Error("图像画布不可用"); context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL("image/png"); }
		finally { canvas.width = canvas.height = 0; }
	} finally { image.src = ""; URL.revokeObjectURL(url); }
}

export function structuredSourcePath(vaultRoot: string, rawPath: string): string {
	const relative = path.relative(vaultRoot, path.resolve(vaultRoot, rawPath)).replace(/\\/g, "/");
	if (!/^papers\/[^/]+--jats--[^/]+\/article\.md$/.test(relative)) throw new Error("请选择当前 Vault 中已保存的 JATS article.md");
	return relative;
}

export async function openStructuredDocument(vaultRoot: string, rawPath: string, storage: SourceStorage = new FileSourceStorage(vaultRoot), renderImage = renderStructuredImage): Promise<ReadingDocument> {
	const articlePath = structuredSourcePath(vaultRoot, rawPath), key = articlePath.split("/")[1];
	const loaded = await loadJatsSource(storage, key), { projection, manifest } = loaded;
	const snapshot: StructuredReadingSnapshot = { version: 1, format: "jats", manifest };
	const fingerprint = structuredFingerprint(snapshot);
	const verifiedManifest = structuredClone(manifest);
	const source: ReadingSource = { kind: "structured", path: articlePath, title: manifest.identity.title, fingerprint, structured: snapshot };
	const evidence: ReadingEvidence[] = []; let heading = projection.title;
	for (const block of projection.blocks) {
		if (block.kind === "section") heading = block.label;
		const location: StructuredReadingLocation = { packageKey: key, projectionId: projection.projectionId, blockId: block.id, xmlPath: block.xmlPath,
			xmlStart: block.sourceStart, xmlEnd: block.sourceEnd, blockStart: block.start, blockEnd: block.end };
		const make = (start: number, end: number, resourceId?: string): ReadingEvidence => {
			const structured = { ...location, ...(resourceId ? { resourceId } : {}) };
			return { id: structuredEvidenceId(structured, start), kind: "paper", path: articlePath, sourceHash: fingerprint, structured, heading,
				label: (block.label || heading) + (resourceId ? " · 图像" : " · " + block.kind), text: projection.markdown.slice(start, end), start, end, ...(resourceId ? { asset: resourceId } : {}) };
		};
		for (let start = block.start; start < block.end; start += 4500) if (projection.markdown.slice(start, Math.min(start + 4500, block.end)).trim()) evidence.push(make(start, Math.min(start + 4500, block.end)));
		const body = projection.markdown.slice(block.start, block.end);
		for (const asset of new Set([...body.matchAll(/!\[[^\n]*?\]\((images\/[a-f0-9]{64}\.(?:png|jpg|webp))\)/g)].map(m => m[1]))) evidence.push(make(block.start, Math.min(block.end, block.start + 4500), asset));
	}
	const catalog = readingCatalog(evidence) + "\nJATS 来源：无 PDF 页码。" + (projection.issues.length ? "原文缺口：" + projection.issues.join("；").slice(0, 4000) : "");
	// Bind captions and referencing paragraphs to actual image resources, without inventing page adjacency.
	const blockEvidence = new Map<string, ReadingEvidence[]>();
	for (const e of evidence) { const id=e.structured!.blockId; const group=blockEvidence.get(id)||[]; group.push(e); blockEvidence.set(id,group); }
	for (const e of evidence) {
		const loc = e.structured!, body = projection.markdown.slice(loc.blockStart, loc.blockEnd);
		const targets = new Set([loc.blockId, ...[...body.matchAll(/\]\(#(b-[a-f0-9]{24})\)/g)].map(m => m[1])]);
		e.relatedIds = [...targets].flatMap(id => blockEvidence.get(id)||[]).filter(other => other.id !== e.id && (e.asset ? !other.asset : !!other.asset)).map(other => other.id);
	}
	const canonical = new Map(evidence.map(e => [e.id, structuredClone(e)]));
	let destroyed = false;
	const verify = async (): Promise<void> => {
		if (destroyed) throw new Error("JATS 阅读来源已关闭");
		await verifyLoadedJatsSource(storage, verifiedManifest);
	};
	return { source, evidence, catalog, sourceWarnings: [...projection.issues], verify,
		async destroy() { destroyed = true; loaded.files.clear(); canonical.clear(); },
		async image(item, signal) {
			signal?.throwIfAborted(); if (!item.asset) return null;
			const original = canonical.get(item.id);
			if (!original || item.sourceHash !== fingerprint || item.asset !== original.asset || objectDigest(item.structured) !== objectDigest(original.structured)) throw new Error("JATS 图像证据与固定来源不一致");
			await verify(); signal?.throwIfAborted();
			const bytes = loaded.files.get(original.asset!)!, info = imageInfo(bytes, original.asset!);
			if (!info) throw new Error("JATS 图像格式不可显示");
			const dataUrl = await renderImage(bytes, info.mime, signal); await verify(); signal?.throwIfAborted();
			return { evidenceId: original.id, dataUrl };
		} };
}
