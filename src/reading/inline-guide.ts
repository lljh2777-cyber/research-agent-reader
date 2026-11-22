import type { ReadingNode, ReadingSession } from "./types";
import type { BilingualBlock, BilingualFile } from "../reader/bilingual-document";
import { markdownImagePattern } from "../reader/markdown-images";
import { readingTrail } from "./navigation";

export const MAIN_GUIDE = "paper-guide-main";
export interface GuideTarget {
	id: string; label: string; kind: "figure" | "table" | "text"; start: number; end: number; block: BilingualBlock;
}
export function guideParent(session: ReadingSession, id: string): ReadingNode | undefined {
	const trail = readingTrail(session, id);
	if (trail.some(n => session.branches.some(b => b.id === n.branchId && b.annotation))) return;
	return trail.find(n => !n.branchId && session.mainIds.includes(n.id));
}
export function conclusionTitle(node: ReadingNode): string {
	const clean = node.content.replace(/^\s*(?:#+\s*)?(?:\*\*)?(?:本轮结论|核心结论|结论)[：:]\s*/, "").replace(/\*\*|\[[\w-]+\]/g, "").trim();
	return clean.match(/^[^\n。！？]+[。！？]?/u)?.[0]?.trim() || node.title;
}

/** Resolve only saved paper evidence against the exact English text currently displayed. */
export class GuideEvidenceIndex {
	private images = new Map<string, BilingualBlock | null>();
	private captionImages = new Map<string,BilingualBlock>();
	private captions = new Map<string, BilingualBlock | null>();
	constructor(private file: BilingualFile) {
		for (const b of file.blocks.filter(b => b.kind === "image")) {
			const m = markdownImagePattern().exec(file.text.slice(b.start, b.end));
			const path = m && (m[2] || m[3] || m[4]);
			if (path) this.images.set(path, this.images.has(path) ? null : b);
		}
		for (const [i,b] of file.blocks.entries()) {
			const raw = file.text.slice(b.start,b.end);
			const caption = (b.kind === "image" ? markdownImagePattern().exec(raw)?.[1] : raw)?.trim().replace(/^[#*_ ]+/, "");
			const m = /^(?:(Extended Data |Supplementary )?)(Fig(?:ure)?\.?|Table)\s*(S?\d+)\b(?=\s*[:.|–—-])/i.exec(caption || "");
			if (!m) continue;
			const kind = /^table/i.test(m[2]) ? "table" : "image";
			const key = this.captionKey((m[1] || "") + m[2],m[3]);
			const adjacent = kind === "table" ? file.blocks[i+1] : file.blocks[i-1];
			const adjacentMatches = adjacent?.kind === kind && (kind === "table" || this.captions.get(key)?.id === adjacent.id);
			const target = b.kind !== kind && adjacentMatches ? adjacent : b;
			if (!this.captions.has(key)) this.captions.set(key,target);
			else if (this.captions.get(key)?.id !== target.id) this.captions.set(key,null);
		}
		for (const [i,b] of file.blocks.entries()) {
			const title = file.blocks[i-1], image = file.blocks[i-2];
			if (image?.kind !== "image" || !title || !/^\s*\*\*[a-z]\*\*[,.:]/i.test(file.text.slice(b.start,b.end))) continue;
			const alt = markdownImagePattern().exec(file.text.slice(image.start,image.end))?.[1]?.trim();
			if (alt && alt === file.text.slice(title.start,title.end).trim()) this.captionImages.set(b.id,image);
		}
	}
	private captionKey(prefix: string, number: string) {
		return prefix.toLowerCase().replace(/fig(?:ure)?\.?/, "fig").replace(/\s+/g, "") + number.toLowerCase();
	}
	forTurn(node: ReadingNode, paths: string[]): GuideTarget[] {
		const found = new Map<string, GuideTarget>();
		const { text, blocks } = this.file;
		const references = new Map<string, Set<string>>();
		const citedImages = new Set<number>(node.evidence.filter(e => e.kind === "paper" && e.asset && e.start !== undefined && paths.includes(e.path) && text.startsWith(e.text,e.start)).map(e => e.start!));
		const add = (kind: GuideTarget["kind"], b: BilingualBlock, start: number, end: number, label: string) => {
			const id = kind + "-" + start + "-" + end;
			if (end <= start) return;
			if (kind === "figure" && b.kind === "image") {
				const alt = markdownImagePattern().exec(text.slice(b.start,b.end))?.[1];
				if (alt) label = alt;
			}
			if (!found.has(id)) found.set(id, { id, label, kind, start, end, block: b });
		};
		const citationOrder = (id: string) => {
			const index = node.content.indexOf("[" + id + "]");
			return index < 0 ? Infinity : index;
		};
		const quoted = [...node.content.matchAll(/[“"]([^“”"\n]{8,420})[”"]/g)].map(m => m[1]);
		for (const e of [...node.evidence].sort((a,b) => citationOrder(a.id) - citationOrder(b.id))) {
			if (e.kind !== "paper" || !paths.includes(e.path) || e.start === undefined || !e.text.trim() || !text.startsWith(e.text, e.start)) continue;
			const limit = e.start + e.text.length;
			for (const b of blocks) {
				if (b.start >= limit) break;
				if (b.end <= e.start) continue;
				const chunkStart = Math.max(b.start, e.start);
				const raw = text.slice(b.start, b.end);
				if (b.kind === "image") {
					const label = markdownImagePattern().exec(raw)?.[1] || e.label;
					add("figure", b, b.start, b.end, label);
					continue;
				}
				const captionImage = this.captionImages.get(b.id);
				if (captionImage) add("figure",captionImage,captionImage.start,captionImage.end,e.label);
				const chunk = text.slice(chunkStart, Math.min(limit, b.end));
				const start = chunkStart + chunk.length - chunk.trimStart().length;
				const exact = b.kind === "paragraph" ? quoted.filter(q => chunk.includes(q) && chunk.indexOf(q) === chunk.lastIndexOf(q)) : [];
				if (exact.length) {
					for (const quote of exact) {
						const at = chunkStart + chunk.indexOf(quote);
						add("text", b, at, at + quote.length, quote);
					}
				} else add(b.kind === "table" ? "table" : "text", b, start, start + chunk.trim().length, chunk.trim().replace(/\s+/g, " "));
				for (const match of chunk.matchAll(/(?<!!)\[([^\]\n]+)\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
					const img = this.images.get(match[2] || match[3]);
					if (!img) continue;
					add("figure", img, img.start, img.end, match[1]);
					if (!references.has(img.id)) references.set(img.id,new Set());
					references.get(img.id)!.add(match[1]);
				}
				for (const m of chunk.matchAll(/\b(Extended Data |Supplementary )?(Fig(?:ure)?\.?|Table)\s*(S?\d+)([a-z])?\b/gi)) {
					const dest = this.captions.get(this.captionKey((m[1] || "") + m[2], m[3]));
					if (!dest) continue;
					const kind = /^table/i.test(m[2]) ? "table" : "figure";
					add(kind,dest,dest.start,dest.end,m[0] + (dest.kind === "paragraph" || dest.kind === "heading" ? " · 标题" : ""));
					if (m[4]) {
						if (!references.has(dest.id)) references.set(dest.id,new Set());
						references.get(dest.id)!.add(m[3]+m[4]);
					}
				}
			}
		}
		for (const target of found.values()) {
			const refs = references.get(target.block.id);
			if (target.kind === "figure") {
				if (refs?.size) target.label = "对照 " + [...refs].join("、") + " · " + target.label;
				if (!citedImages.has(target.block.start)) target.label = "文段所引 · " + target.label;
			}
		}
		return [...found.values()];
	}
}
