import type { BilingualDocument, BilingualLanguage } from "../reader/bilingual-document";
import { matchReadingSentences, readingSentences, type ExplicitSentencePair, type ReadingSentence, type SentenceMark } from "../reader/bilingual-sentences";
import type { BilingualPane } from "./bilingual-reader";

const NAME = "agent-bilingual-sentence-hover";
const EXCLUDED = ".agent-bilingual-marker, .footnotes, [data-footnote-id], figure, figcaption, table, blockquote, li, pre, .callout, .markdown-embed";
const CAPTION = /^(?:(?:(?:extended data|supplementary)\s+)?(?:fig(?:ure)?\.?|table)\s+|(?:(?:扩展数据|补充)\s*)?[图表]\s*)s?\d/iu;
const PANEL_CAPTION = /^\(?[a-z](?:\s*[-–]\s*[a-z])?\)?\s*[,，:：]/u;
const CAPTION_SECTION = /^(?:extended data(?: figures(?: and tables)?)?|扩展数据(?:图(?:和表|与表)?)?)$/iu;
type Pane = Pick<BilingualPane, "article" | "anchors" | "scroller">;
interface Part { node: Text; start: number; end: number; }
interface Paragraph { parts: Part[]; sentences: ReadingSentence[]; }
interface TextBounds { from: Text; to: Text; start: number; end: number; }
interface HoverPair { en: TextBounds; "zh-CN": TextBounds; }
interface Hit { start: number; end: number; own: TextBounds; pair: HoverPair; }
interface TextOwner { start: number; hits: Hit[]; }

function marker(node: Text): { owner: Element; key?: string } | undefined {
	const parent = node.parentElement, link = parent?.closest<HTMLAnchorElement>("a[href]");
	const ref = link?.dataset.footref;
	if (ref && ref.length <= 80) return { owner: link!, key: "ref:" + ref };
	const href = link?.getAttribute("href") ?? "", label = link?.textContent?.replace(/\s+/g, "").toLowerCase();
	if (link && href.length <= 600 && /^https?:\/\/[^#]+#(?:fig(?:ure)?|tab(?:le)?)[-_]?\d+[a-z]?$/i.test(href)
		&& label && /^s?\d+[a-z0-9,–—-]*$/i.test(label)) return { owner: link, key: "fig:" + href + "|" + label };
	const script = parent?.closest("sup, sub");
	return script ? { owner: script, key: "script:" + script.localName + ":" + script.textContent?.replace(/\s+/g, "") } : undefined;
}

function paragraphs(file: BilingualDocument["files"][BilingualLanguage], pane: Pane): Map<string, Paragraph> {
	const eligible = new Set<string>(); let captionLevel = 0;
	for (const [i, block] of file.blocks.entries()) {
		if (block.kind === "heading") {
			const heading = /^\s*(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/u.exec(file.text.slice(block.start, block.end));
			if (heading) {
				if (heading[1].length <= captionLevel) captionLevel = 0;
				if (!captionLevel && (CAPTION_SECTION.test(heading[2]) || CAPTION.test(heading[2]))) captionLevel = heading[1].length;
			}
		}
		if (!captionLevel && block.kind === "paragraph" && file.blocks[i - 1]?.kind !== "image") eligible.add(block.id);
	}
	const unique = new Map<string, HTMLElement | null>();
	let id: string | undefined;
	for (const element of pane.article.querySelectorAll<HTMLElement>("[data-bilingual-anchor], p")) {
		const anchor = element.dataset.bilingualAnchor;
		if (anchor && pane.anchors.get(anchor) === element) {
			id = eligible.has(anchor) ? anchor : undefined;
			continue;
		}
		if (!id || element.tagName !== "P" || element.closest(EXCLUDED)) continue;
		unique.set(id, unique.has(id) ? null : element);
	}
	const result = new Map<string, Paragraph>();
	for (const [id, element] of unique) {
		if (!element || element.querySelector("img, math, mjx-container, .math, .katex, [hidden], [aria-hidden=true]")) continue;
		const text = element.textContent ?? "";
		if (!text.trim() || text.length > 8000 || CAPTION.test(text.trimStart()) || PANEL_CAPTION.test(text.trimStart())) continue;
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const parts: Part[] = [], marks: SentenceMark[] = []; let offset = 0, lastOwner: Element | undefined;
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			if (!node.length) continue;
			const end = offset + node.length;
			parts.push({ node, start: offset, end });
			const inline = marker(node);
			if (inline && lastOwner === inline.owner) marks[marks.length - 1].end = end;
			else if (inline) marks.push({ start: offset, end, key: inline.key });
			lastOwner = inline?.owner;
			offset += node.length;
		}
		if (offset === text.length) result.set(id, { parts, sentences: readingSentences(text, marks) });
	}
	return result;
}

function toBounds(paragraph: Paragraph, sentence: ReadingSentence): TextBounds | undefined {
	const from = paragraph.parts.find(p => p.start <= sentence.start && sentence.start < p.end);
	const to = paragraph.parts.find(p => p.start < sentence.end && sentence.end <= p.end);
	if (!from || !to) return;
	return { from: from.node, to: to.node, start: sentence.start - from.start, end: sentence.end - to.start };
}

function resolveRange(bounds: TextBounds): Range | undefined {
	const { from, to, start, end } = bounds;
	if (!from.isConnected || !to.isConnected || start >= from.length || end > to.length) return;
	// A live Range can collapse when the workspace moves an article (such as swapping panes).
	const range = from.ownerDocument.createRange();
	range.setStart(from, start);
	range.setEnd(to, end);
	return range.collapsed ? undefined : range;
}

export function indexBilingualHover(doc: BilingualDocument, en: Pane, zh: Pane) {
	const owners = new WeakMap<Node, TextOwner>(), pairs: HoverPair[] = [];
	const counts = { en: 0, "zh-CN": 0 };
	if (!doc.syncAvailable || doc.stale) return { owners, pairs, counts };
	const english = paragraphs(doc.files.en, en), chinese = paragraphs(doc.files["zh-CN"], zh);
	const explicit = new Map<string, ExplicitSentencePair[]>();
	for (const pair of doc.sentenceAlignment ?? []) {
		const list = explicit.get(pair.blockId);
		if (list) list.push(pair); else explicit.set(pair.blockId, [pair]);
	}
	for (const block of doc.pairs) {
		const left = english.get(block.en.id), right = chinese.get(block["zh-CN"].id);
		if (left) counts.en += left.sentences.filter(sentence => sentence.complete).length;
		if (right) counts["zh-CN"] += right.sentences.filter(sentence => sentence.complete).length;
		if (!left || !right) continue;
		const enHits: Hit[] = [], zhHits: Hit[] = [];
		for (const [from, to] of matchReadingSentences(left.sentences, right.sentences, explicit.get(block.id))) {
			const en = toBounds(left, from), zh = toBounds(right, to);
			if (!en || !zh) continue;
			const pair = { en, "zh-CN": zh };
			pairs.push(pair);
			enHits.push({ start: from.start, end: from.end, own: en, pair });
			zhHits.push({ start: to.start, end: to.end, own: zh, pair });
		}
		if (enHits.length) for (const part of left.parts) owners.set(part.node, { start: part.start, hits: enHits });
		if (zhHits.length) for (const part of right.parts) owners.set(part.node, { start: part.start, hits: zhHits });
	}
	return { owners, pairs, counts };
}

type HighlightWindow = Window & typeof globalThis;
const windowOf = (doc: Document): HighlightWindow | null => doc.defaultView as HighlightWindow | null;

export function supportsBilingualHover(doc: Document): boolean {
	const view = windowOf(doc);
	return typeof view?.Highlight === "function" && !!view.CSS?.highlights && typeof doc.caretRangeFromPoint === "function";
}

/** Paint only. Does not select text, focus the pane, or drive reading positions. */
export class BilingualSentenceHover {
	private index?: ReturnType<typeof indexBilingualHover>;
	private enabled = false;
	private frame = 0;
	private pending?: { pane: Pane; x: number; y: number };
	private active?: HoverPair;
	private paint?: Highlight;
	private readonly document: Document;
	private readonly view: HighlightWindow;

	constructor(private readonly doc: BilingualDocument, private readonly en: Pane, private readonly zh: Pane, private readonly signal: AbortSignal) {
		this.document = en.article.ownerDocument;
		this.view = windowOf(this.document)!;
		for (const pane of [en, zh]) {
			pane.article.addEventListener("pointermove", event => {
				if (!this.enabled) return;
				if (event.pointerType !== "mouse" || event.buttons !== 0) { this.clear(); return; }
				this.pending = { pane, x: event.clientX, y: event.clientY };
				if (!this.frame) this.frame = this.view.requestAnimationFrame(() => this.draw());
			}, { signal, passive: true });
			pane.article.addEventListener("pointerleave", this.clear, { signal });
			pane.article.addEventListener("pointerdown", this.clear, { signal, capture: true });
			pane.scroller.addEventListener("scroll", this.clear, { signal, passive: true });
		}
		this.document.addEventListener("selectionchange", () => { if (this.hasSelection()) this.clear(); }, { signal });
		this.view.addEventListener("blur", this.clear, { signal });
		signal.addEventListener("abort", this.clear, { once: true });
	}

	setEnabled(enabled: boolean): number {
		this.enabled = enabled && !this.signal.aborted;
		if (!this.enabled) { this.clear(); return 0; }
		this.index ??= indexBilingualHover(this.doc, this.en, this.zh);
		return this.index.pairs.length;
	}

	clear = (): void => {
		if (this.frame) this.view.cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.pending = undefined;
		// Several reader tabs can share this window. Do not erase another view's paint.
		const registry = this.view.CSS.highlights;
		if (this.paint && registry.get(NAME) === this.paint) registry.delete(NAME);
		this.active = undefined;
		this.paint = undefined;
	};

	private hasSelection(): boolean { return this.document.getSelection()?.isCollapsed === false; }

	private draw(): void {
		this.frame = 0;
		const point = this.pending; this.pending = undefined;
		if (!point || !this.enabled || this.signal.aborted || this.hasSelection()) { this.clear(); return; }
		const { pane, x, y } = point;
		const caret = this.document.caretRangeFromPoint(x, y);
		const owner = caret && pane.article.contains(caret.startContainer) ? this.index?.owners.get(caret.startContainer) : undefined;
		if (!caret || !owner) { this.clear(); return; }
		const offset = owner.start + caret.startOffset;
		// Caret hit testing snaps to the nearest character even in blank space.
		const hit = owner.hits.find(hit => {
			if (offset < hit.start || offset > hit.end) return false;
			const range = resolveRange(hit.own);
			return range && Array.from(range.getClientRects()).some(rect => rect.left <= x && x < rect.right && rect.top <= y && y < rect.bottom);
		});
		if (!hit) { this.clear(); return; }
		const registry = this.view.CSS.highlights;
		if (this.active === hit.pair && registry.get(NAME) === this.paint) return;
		const en = resolveRange(hit.pair.en), zh = resolveRange(hit.pair["zh-CN"]);
		if (!en || !zh) { this.clear(); return; }
		this.active = hit.pair;
		this.paint = new this.view.Highlight(en, zh);
		registry.set(NAME, this.paint);
	}
}
