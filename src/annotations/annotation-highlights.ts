import { Component, TFile, type App } from "obsidian";
import { ANNOTATION_COLORS, type AnnotationColor } from "./colors";
import { findSourceAnchorOffset, readAnnotationRecords } from "./annotation-service";
import { bilingualSelectionContext } from "./bilingual";
import { revealMarkdownRange } from "./markdown-selection";
import type { AnnotationRecord } from "./types";

const SOURCE = "[data-agent-annotation-source]";
const BLOCK = "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6";
const ROOT = "wiki/annotations/";
const name = (color: string) => "agent-annotation-" + color;
type PaintWindow = Window & { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown; MutationObserver: typeof MutationObserver };

function lineOffset(text: string, line: number): number {
	let at = 0;
	for (let n = 0; n < line; n++) { const next = text.indexOf("\n", at); if (next < 0) return text.length; at = next + 1; }
	return at;
}

/** Return a proven range only. Duplicate rendered targets and stale sources stay unpainted. */
export function annotationHighlightRanges(roots: HTMLElement[], content: string, record: AnnotationRecord): Range[] {
	const ranges: Range[] = [];
	if (!record.color || record.pdfExcerpt) return ranges;
	if (!record.sourceAnchor) {
		// Existing inline annotations keep their original source link; color is only a view decoration.
		for (const root of roots) for (const link of root.querySelectorAll<HTMLAnchorElement>("a.internal-link[data-href]")) {
			if (link.closest(SOURCE) !== root) continue;
			if (link.dataset.href !== record.annotationPath.replace(/\.md$/i, "") + "#^" + record.id) continue;
			const range = root.ownerDocument.createRange(); range.selectNodeContents(link); ranges.push(range);
		}
		return ranges;
	}
	const start = findSourceAnchorOffset(content, record.selectedText, record.sourceAnchor);
	if (start === null) return ranges;
	for (const root of roots) {
		const candidates = root.matches(BLOCK) ? [root, ...root.querySelectorAll<HTMLElement>(BLOCK)] : [...root.querySelectorAll<HTMLElement>(BLOCK)];
		const matches: Range[] = [];
		for (const block of candidates) {
			if (block.closest(SOURCE) !== root || block.querySelector(BLOCK) || block.closest("pre, code, .markdown-embed, .agent-annotation-popover")) continue;
			try {
				const bilingual = bilingualSelectionContext(block);
				if (bilingual && (bilingual.document.files[bilingual.language].path !== record.sourcePath || bilingual.document.files[bilingual.language].text !== content)) continue;
				if (bilingual && record.bilingual && (record.bilingual.language !== bilingual.language || record.bilingual.digests[bilingual.language] !== bilingual.document.files[bilingual.language].digest)) continue;
				const from = Number(root.dataset.agentAnnotationLineStart), to = Number(root.dataset.agentAnnotationLineEnd);
				const segmentStart = bilingual?.block.start ?? (Number.isSafeInteger(from) && from >= 0 ? lineOffset(content, from) : 0);
				const segmentEnd = bilingual?.block.end ?? (Number.isSafeInteger(to) && to >= 0 ? lineOffset(content, to + 1) : content.length);
				if (start < segmentStart || start + record.selectedText.length > segmentEnd) continue;
				const range = revealMarkdownRange(block, content, segmentStart, segmentEnd, start, start + record.selectedText.length);
				if (range) matches.push(range);
			} catch { /* Invalidated reader bindings must never paint a guessed location. */ }
		}
		if (matches.length === 1) ranges.push(matches[0]);
	}
	return ranges;
}

/** CSS ranges leave Markdown, links, text nodes, selection and scroll geometry unchanged. */
export class AnnotationHighlights extends Component {
	private readonly documents = new Map<Document, MutationObserver>();
	private readonly cache = new Map<string, AnnotationRecord[]>();
	private timer?: ReturnType<typeof setTimeout>;
	private version = 0;
	private stopped = false;
	constructor(private readonly app: App) { super(); }
	onload(): void {
		this.observe(document);
		const changed = (file: { path: string }) => {
			if (!file.path.endsWith(".md")) return;
			this.cache.delete(file.path);
			this.schedule(true);
		};
		this.registerEvent(this.app.vault.on("modify", changed));
		this.registerEvent(this.app.vault.on("create", changed));
		this.registerEvent(this.app.vault.on("delete", changed));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { this.cache.delete(oldPath); changed(file); this.schedule(); }));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.schedule()));
	}
	observe(doc: Document): void {
		if (this.stopped || this.documents.has(doc) || !doc.body) return;
		const win = doc.defaultView as PaintWindow | null;
		if (!win?.CSS?.highlights || !win.Highlight) return;
		const observer = new win.MutationObserver(mutations => {
			if (mutations.some(m => m.type === "attributes" || [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1 && ((n as Element).matches(SOURCE) || (n as Element).querySelector(SOURCE))) || (m.target.nodeType === 1 && (m.target as Element).closest(SOURCE)))) this.schedule(mutations.some(m => m.type === "attributes" || m.type === "characterData"));
		});
		observer.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-agent-annotation-source"] });
		this.documents.set(doc, observer); this.schedule();
	}
	private clear(doc: Document): void {
		const api = (doc.defaultView as PaintWindow | null)?.CSS?.highlights;
		for (const color of Object.keys(ANNOTATION_COLORS)) api?.delete(name(color));
	}
	private schedule(clear = false): void {
		if (this.stopped) return;
		this.version++;
		if (clear) for (const doc of this.documents.keys()) this.clear(doc);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(error => console.warn("Annotation colors could not be refreshed", error)); }, 120);
	}
	async refresh(): Promise<void> {
		if (this.stopped) return;
		const version = this.version;
		const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(ROOT));
		const existing = new Set(files.map(f => f.path));
		for (const key of this.cache.keys()) if (!existing.has(key)) this.cache.delete(key);
		for (const file of files) if (!this.cache.has(file.path)) {
			let records: AnnotationRecord[] = [];
			try { records = readAnnotationRecords(await this.app.vault.read(file), file.path).records.filter(r => r.color && !r.pdfExcerpt); }
			catch { /* A damaged/unreadable annotation file must not suppress other marks. */ }
			if (this.stopped || version !== this.version) return;
			this.cache.set(file.path, records);
		}
		const bySource = new Map<string, AnnotationRecord[]>();
		for (const records of this.cache.values()) for (const record of records) bySource.set(record.sourcePath, [...(bySource.get(record.sourcePath) || []), record]);
		const texts = new Map<string, string>();
		for (const [doc, observer] of this.documents) {
			const win = doc.defaultView as PaintWindow | null;
			if (!win || win.closed) { observer.disconnect(); this.documents.delete(doc); continue; }
			const roots = [...doc.querySelectorAll<HTMLElement>(SOURCE)].filter(el => el.isConnected && !el.closest(".markdown-embed"));
			const colors = new Map<AnnotationColor, Range[]>();
			for (const [path, records] of bySource) {
				const targets = roots.filter(el => el.dataset.agentAnnotationSource === path);
				if (!targets.length) continue;
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				if (!texts.has(path)) texts.set(path, await this.app.vault.read(file));
				if (this.stopped || version !== this.version) return;
				for (const record of records) colors.set(record.color!, [...(colors.get(record.color!) || []), ...annotationHighlightRanges(targets, texts.get(path)!, record)]);
			}
			if (this.stopped || version !== this.version) return;
			this.clear(doc);
			for (const [color, ranges] of colors) if (ranges.length) win.CSS!.highlights!.set(name(color), new win.Highlight!(...ranges));
		}
	}
	onunload(): void {
		this.stopped = true; this.version++;
		if (this.timer) clearTimeout(this.timer);
		for (const [doc, observer] of this.documents) { observer.disconnect(); this.clear(doc); }
		this.documents.clear(); this.cache.clear();
	}
}
