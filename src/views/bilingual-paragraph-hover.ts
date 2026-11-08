import type { BilingualDocument, BilingualFile, BilingualLanguage } from "../reader/bilingual-document";
import type { BilingualPane } from "./bilingual-reader";

const PAINT = "agent-bilingual-paragraph-hover";
const EXCLUDED = ".agent-bilingual-marker, .footnotes, [data-footnote-id], figure, figcaption, table, blockquote, li, pre, .callout, .markdown-embed";
const FIGURE_LABEL = "(?:(?:(?:extended data|supplementary)\\s+)?(?:figs?\\.?|figures?|tables?)\\s+|(?:(?:扩展数据|补充)\\s*)?[图表]\\s*)s?\\d+";
const CAPTION_HEADING = new RegExp("^" + FIGURE_LABEL, "iu");
const CAPTION = new RegExp("^" + FIGURE_LABEL + "\\s*(?:[:：|｜]|\\.(?=\\s))", "iu");
const PANEL_CAPTION = /^\(?[a-z](?:\s*[-–]\s*[a-z])?\)?\s*[,，:：]/u;
const CAPTION_SECTION = /^(?:extended data(?: figures(?: and tables)?)?|扩展数据(?:图(?:和表|与表)?)?)$/iu;
type Pane = Pick<BilingualPane, "article" | "anchors" | "scroller">;
type HoverPair = Record<BilingualLanguage, HTMLElement>;

function isCaption(text: string): boolean {
	const lead = text.trimStart().replace(/^([*_]{1,3})(.+?)\1/u, "$2");
	return CAPTION.test(lead) || PANEL_CAPTION.test(lead);
}

export function eligibleParagraphBlocks(file: BilingualFile): Set<string> {
	const eligible = new Set<string>(); let captionLevel = 0;
	for (const [i, block] of file.blocks.entries()) {
		if (block.kind !== "heading" && block.kind !== "paragraph") continue;
		const text = file.text.slice(block.start, block.end);
		if (block.kind === "heading") {
			const heading = /^\s*(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/u.exec(text);
			if (!heading) continue;
			if (heading[1].length <= captionLevel) captionLevel = 0;
			if (!captionLevel && (CAPTION_SECTION.test(heading[2]) || CAPTION_HEADING.test(heading[2]))) captionLevel = heading[1].length;
		} else if (!captionLevel && file.blocks[i - 1]?.kind !== "image" && !isCaption(text)) eligible.add(block.id);
	}
	return eligible;
}

function paragraphs(file: BilingualFile, pane: Pane) {
	const eligible = eligibleParagraphBlocks(file);
	const unique = new Map<string, HTMLElement | null>(), seen = new Set<string>(), ambiguous = new Set<string>();
	let id: string | undefined;
	for (const element of pane.article.querySelectorAll<HTMLElement>("[data-bilingual-anchor], p")) {
		const anchor = element.dataset.bilingualAnchor;
		if (anchor) {
			if (seen.has(anchor)) ambiguous.add(anchor);
			seen.add(anchor);
			id = pane.anchors.get(anchor) === element && eligible.has(anchor) ? anchor : undefined;
			continue;
		}
		if (!id || element.tagName !== "P" || element.closest(EXCLUDED)) continue;
		unique.set(id, unique.has(id) ? null : element);
	}
	for (const [id, element] of unique) {
		if (!element?.textContent?.trim() || ambiguous.has(id) || isCaption(element.textContent)) unique.set(id, null);
	}
	return { targets: unique, eligible };
}

/** Use the same block IDs as linked scrolling, never a DOM ordinal or a scroll percentage. */
export function indexBilingualParagraphHover(doc: BilingualDocument, en: Pane, zh: Pane) {
	const owners = new WeakMap<Element, HoverPair>(), pairs: HoverPair[] = [];
	const counts = { en: 0, "zh-CN": 0 };
	let eligiblePairs = 0;
	if (!doc.syncAvailable || doc.stale) return { owners, pairs, counts, eligiblePairs };
	const english = paragraphs(doc.files.en, en), chinese = paragraphs(doc.files["zh-CN"], zh);
	counts.en = english.eligible.size; counts["zh-CN"] = chinese.eligible.size;
	for (const block of doc.pairs) {
		if (!english.eligible.has(block.en.id) || !chinese.eligible.has(block["zh-CN"].id)) continue;
		eligiblePairs++;
		const left = english.targets.get(block.en.id), right = chinese.targets.get(block["zh-CN"].id);
		if (!left || !right) continue;
		const pair = { en: left, "zh-CN": right };
		pairs.push(pair);
		owners.set(left, pair); owners.set(right, pair);
	}
	return { owners, pairs, counts, eligiblePairs };
}

/** Temporary background only: no text selection, focus, scrolling or source edits. */
export class BilingualParagraphHover {
	private index?: ReturnType<typeof indexBilingualParagraphHover>;
	private enabled = false;
	private active?: HoverPair;
	private readonly document: Document;

	constructor(private readonly doc: BilingualDocument, private readonly en: Pane, private readonly zh: Pane, private readonly signal: AbortSignal) {
		this.document = en.article.ownerDocument;
		for (const pane of [en, zh]) {
			pane.article.addEventListener("pointermove", event => {
				if (!this.enabled) return;
				if (event.pointerType !== "mouse" || event.buttons !== 0 || this.hasSelection()) { this.clear(); return; }
				const paragraph = (event.target as Element | null)?.closest?.("p");
				const pair = paragraph && pane.article.contains(paragraph) ? this.index?.owners.get(paragraph) : undefined;
				if (!pair || !pair.en.isConnected || !pair["zh-CN"].isConnected) { this.clear(); return; }
				if (this.active === pair) return;
				this.clear();
				this.active = pair;
				pair.en.classList.add(PAINT); pair["zh-CN"].classList.add(PAINT);
			}, { signal, passive: true });
			pane.article.addEventListener("pointerleave", this.clear, { signal });
			pane.article.addEventListener("pointerdown", this.clear, { signal, capture: true });
			pane.scroller.addEventListener("scroll", this.clear, { signal, passive: true });
		}
		this.document.addEventListener("selectionchange", () => { if (this.hasSelection()) this.clear(); }, { signal });
		this.document.defaultView?.addEventListener("blur", this.clear, { signal });
		signal.addEventListener("abort", this.clear, { once: true });
	}

	setEnabled(enabled: boolean): number {
		this.enabled = enabled && !this.signal.aborted;
		if (!this.enabled) { this.clear(); return 0; }
		this.index ??= indexBilingualParagraphHover(this.doc, this.en, this.zh);
		return this.index.pairs.length;
	}

	clear = (): void => {
		this.active?.en.classList.remove(PAINT); this.active?.["zh-CN"].classList.remove(PAINT);
		this.active = undefined;
	};

	private hasSelection(): boolean { return this.document.getSelection()?.isCollapsed === false; }
}
