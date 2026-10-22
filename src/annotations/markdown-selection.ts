/** Exact UTF-16 source spans behind rendered Markdown. Never replace source text with display text. */
interface Span { start: number; end: number; }
interface Projection<T> { text: string; spans: T[]; }
const FOOTNOTE = "\ufffc";
export const MAX_RAW_SELECTION = 2400;
const FOOTNOTE_SELECTOR = ".footnote-ref, a.footnote-link, a[data-footref], a[data-footnote-ref]";

function normalized<T>(text: string, spans: T[]): Projection<T> {
	let value = ""; const mapped: T[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = /\s/.test(text[i]) ? " " : text[i];
		if (char === " " && (!value || value.endsWith(" "))) continue;
		value += char; mapped.push(spans[i]);
	}
	if (value.endsWith(" ")) { value = value.slice(0, -1); mapped.pop(); }
	return { text: value, spans: mapped };
}

function delimiters(text: string): Map<number, number> {
	const pairs = new Map<number, number>(), brackets: number[] = [], parentheses: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\\") { i++; continue; }
		if (text[i] === "[") brackets.push(i);
		if (text[i] === "(") parentheses.push(i);
		const start = text[i] === "]" ? brackets.pop() : text[i] === ")" ? parentheses.pop() : undefined;
		if (start !== undefined) pairs.set(start, i);
	}
	return pairs;
}

function entity(value: string): string {
	const numeric = /^&#(x[0-9a-f]+|[0-9]+);$/i.exec(value);
	if (numeric) { const n = numeric[1][0].toLowerCase() === "x" ? parseInt(numeric[1].slice(1), 16) : Number(numeric[1]); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : value; }
	return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": "\u00a0" } as Record<string, string>)[value] || value;
}

function sourceProjection(source: string, definitions = source, base = 0, depth = 0, references?: Set<string>, display = false, preserveScripts = false): Projection<Span> {
	let text = ""; const spans: Span[] = [];
	const add = (value: string, start: number, end: number): void => { text += value; for (let n = 0; n < value.length; n++) spans.push({ start: base + start, end: base + end }); };
	const label = (value: string, start: number, end: number): void => add(depth < 8 ? sourceProjection(value, definitions, 0, depth + 1, refs, display, preserveScripts).text : value, start, end);
	const refs = references || new Set([...definitions.matchAll(/^ {0,3}\[([^\]^][^\]]*)\]:[^\S\n]*\S[^\n]*$/gm)].map(m => m[1].trim().replace(/\s+/g, " ").toLowerCase()));
	const pairs = delimiters(source);
	for (let i = 0; i < source.length;) {
		const tail = source.slice(i);
		const footnoteDefinition = (i === 0 || source[i - 1] === "\n") && /^ {0,3}\[\^[^\]]+\]:[^\S\n]*/.exec(tail);
		if (footnoteDefinition) { i += footnoteDefinition[0].length; continue; }
		const definition = (i === 0 || source[i - 1] === "\n") && /^ {0,3}\[[^\]]+\]:[^\n]*(?:\n|$)/.exec(tail);
		if (definition) { i += definition[0].length; continue; }
		const comment = tail.startsWith("<!--") ? source.indexOf("-->", i + 4) : -1;
		if (comment >= 0) { i = comment + 3; continue; }
		if (source[i] === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(source[i + 1] || "")) { add(source[i + 1], i, i + 2); i += 2; continue; }
		const encoded = /^&(?:#x[0-9a-f]+|#[0-9]+|[a-z]+);/i.exec(tail);
		if (encoded) { add(entity(encoded[0]), i, i + encoded[0].length); i += encoded[0].length; continue; }
		if (source[i] === "[" && !pairs.has(i)) { add("[", i, i + 1); i++; continue; }
		const foot = /^\[\^[^\]\r\n]+\]/.exec(tail);
		if (foot) { add(display ? "[" + foot[0].slice(2, -1) + "]" : FOOTNOTE, i, i + foot[0].length); i += foot[0].length; continue; }
		const wiki = /^\[\[([^\]\r\n]+)\]\]/.exec(tail);
		if (wiki) { const parts = wiki[1].split("|"); const name = parts.length > 1 ? parts.slice(1).join("|") : parts[0].split("/").pop()!.replace(/\.md(?=#|$)/i, ""); label(name, i, i + wiki[0].length); i += wiki[0].length; continue; }
		if (source[i] === "[") {
			const endLabel = pairs.get(i) ?? -1;
			if (endLabel >= 0) {
				let end = -1;
				if (source[endLabel + 1] === "(") { const dest = pairs.get(endLabel + 1) ?? -1; if (dest >= 0) end = dest + 1; }
				else if (source[endLabel + 1] === "[") { const refEnd = source.indexOf("]", endLabel + 2); const key = source.slice(endLabel + 2, refEnd) || source.slice(i + 1, endLabel); if (refEnd >= 0 && refs.has(key.trim().replace(/\s+/g, " ").toLowerCase())) end = refEnd + 1; }
				else if (refs.has(source.slice(i + 1, endLabel).trim().replace(/\s+/g, " ").toLowerCase())) end = endLabel + 1;
				if (end >= 0) { label(source.slice(i + 1, endLabel), i, end); i = end; continue; }
			}
		}
		const auto = /^<(https?:\/\/[^<>\s]+|[^<>\s]+@[^<>\s]+)>/.exec(tail);
		if (auto) { add(auto[1], i, i + auto[0].length); i += auto[0].length; continue; }
		const htmlLink = /^<a\b[^>]*>([\s\S]*?)<\/a\s*>/i.exec(tail);
		if (htmlLink) { label(htmlLink[1], i, i + htmlLink[0].length); i += htmlLink[0].length; continue; }
		// Preserve position, without guessing whether a number is a citation or an
		// exponent. DOM alignment still uses plain text; model evidence keeps only
		// these attribute-free tags so Xenium<sup>5</sup> cannot become Xenium5.
		const script = preserveScripts && /^<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(tail);
		if (script && depth < 8) {
			const tag = script[1].toLowerCase(), body = sourceProjection(script[2], definitions, 0, depth + 1, refs, display, true).text;
			add(`<${tag}>${body}</${tag}>`, i, i + script[0].length); i += script[0].length; continue;
		}
		const tag = /^<\/?[a-z][^>]*>/i.exec(tail);
		if (tag) { i += tag[0].length; continue; }
		const code = /^(`+)([^`]+)\1(?!`)/.exec(tail);
		if (code) { add(code[2].replace(/\n/g, " "), i, i + code[0].length); i += code[0].length; continue; }
		const format = /^(\*\*|__|~~|==|\*|_)(?=\S)/.exec(tail);
		if (format && !(format[0] === "_" && /[\p{L}\p{N}]/u.test(source[i - 1] || ""))) {
			const end = source.indexOf(format[0], i + format[0].length);
			if (end > i + format[0].length) { label(source.slice(i + format[0].length, end), i, end + format[0].length); i = end + format[0].length; continue; }
		}
		add(source[i], i, i + 1); i++;
	}
	return { text, spans };
}

/** Text for UI only. Source receipts continue to use the exact raw slice. */
export function annotationDisplayText(raw: string): string {
	return sourceProjection(raw, raw, 0, 0, undefined, true).text.replace(/\s+/g, " ").trim();
}
/** Model prose retains superscript/subscript position; source receipts retain the raw slice. */
export function annotationEvidenceText(raw: string, definitions = raw): string {
	return sourceProjection(raw, definitions, 0, 0, undefined, true, true).text.replace(/\r\n/g, "\n");
}
export const markdownNeedsDetached = (raw: string): boolean => /[\r\n|\[\]<>`*_~]/.test(raw);
export function validSelectionSize(raw: string): boolean {
	if (raw.length > MAX_RAW_SELECTION) return false;
	const visible = annotationDisplayText(raw).length; return visible > 0 && visible <= 600;
}

interface DomSpan extends Span { first: Text; firstOffset: number; last: Text; lastOffset: number; }
function domProjection(block: HTMLElement): Projection<DomSpan> {
	const doc = block.ownerDocument, walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	let text = "", cursor = 0; const spans: DomSpan[] = []; const footnotes = new Map<Element, DomSpan>();
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const value = node.data, foot = node.parentElement?.closest(FOOTNOTE_SELECTOR);
		if (node.parentElement?.closest(".footnote-backref")) { cursor += value.length; continue; }
		if (foot && block.contains(foot) && value.length) {
			const previous = footnotes.get(foot);
			if (previous) { previous.end = cursor + value.length; previous.last = node; previous.lastOffset = value.length; }
			else { const span = { start: cursor, end: cursor + value.length, first: node, firstOffset: 0, last: node, lastOffset: value.length }; footnotes.set(foot, span); text += FOOTNOTE; spans.push(span); }
		} else for (let i = 0; i < value.length; i++) { text += value[i]; spans.push({ start: cursor + i, end: cursor + i + 1, first: node, firstOffset: i, last: node, lastOffset: i + 1 }); }
		cursor += value.length;
	}
	return normalized(text, spans);
}

function align(block: HTMLElement, content: string, start: number, end: number): { source: Projection<Span>; dom: Projection<DomSpan>; at: number } {
	if (content.length > 32 * 1024 * 1024 || end - start > 128 * 1024) throw new Error("段落范围过大，请在原文编辑器中重新划选");
	const raw = sourceProjection(content.slice(start, end), content, start), source = normalized(raw.text, raw.spans), dom = domProjection(block);
	const at = dom.text ? source.text.indexOf(dom.text) : -1;
	if (at < 0) throw new Error("选区的渲染内容无法与原文准确对应，请在原文编辑器中重新划选");
	if (source.text.indexOf(dom.text, at + 1) >= 0) throw new Error("段落内容重复，无法唯一定位；请在原文编辑器中划选");
	return { source, dom, at };
}

/** A link label is an indivisible source atom: partial labels include the complete link. */
export function captureMarkdownRange(block: HTMLElement, range: Range, content: string, start: number, end: number): Span & { expanded: boolean } {
	const { source, dom, at } = align(block, content, start, end);
	const before = block.ownerDocument.createRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset); const from = before.toString().length;
	before.setEnd(range.endContainer, range.endOffset); const to = before.toString().length;
	let first = dom.spans.findIndex(span => span.end > from && span.start < to), last = dom.spans.length - 1;
	if (first < 0) throw new Error("选区中没有可批注的文字");
	while (last >= first && (dom.spans[last].start >= to || dom.spans[last].end <= from)) last--;
	while (first <= last && dom.text[first] === " ") first++;
	while (last >= first && dom.text[last] === " ") last--;
	if (first < 0 || last < first) throw new Error("选区中没有可批注的文字");
	const rawStart = source.spans[at + first].start, rawEnd = source.spans[at + last].end;
	const expanded = (first > 0 && source.spans[at + first - 1].start === rawStart) || (last + 1 < dom.spans.length && source.spans[at + last + 1].end === rawEnd);
	return { start: rawStart, end: rawEnd, expanded };
}

export function revealMarkdownRange(block: HTMLElement, content: string, segmentStart: number, segmentEnd: number, start: number, end: number): Range | null {
	try {
		const { source, dom, at } = align(block, content, segmentStart, segmentEnd);
		const indices = dom.spans.map((_, i) => i).filter(i => source.spans[at + i].end > start && source.spans[at + i].start < end);
		if (!indices.length || source.spans[at + indices[0]].start !== start || source.spans[at + indices[indices.length - 1]].end !== end) return null;
		const first = dom.spans[indices[0]], last = dom.spans[indices[indices.length - 1]], range = block.ownerDocument.createRange();
		range.setStart(first.first, first.firstOffset); range.setEnd(last.last, last.lastOffset); return range;
	} catch { return null; }
}

export function expandMarkdownSelection(content: string, start: number, end: number): Span {
	const lineStart = content.lastIndexOf("\n", start - 1) + 1, next = content.indexOf("\n", end), lineEnd = next < 0 ? content.length : next;
	if (content.length > 32 * 1024 * 1024 || lineEnd - lineStart > 128 * 1024) throw new Error("段落范围过大，请缩小原文后重新划选");
	const projection = sourceProjection(content.slice(lineStart, lineEnd), content, lineStart);
	for (const span of projection.spans) if (span.start < end && span.end > start) { start = Math.min(start, span.start); end = Math.max(end, span.end); }
	return { start, end };
}
