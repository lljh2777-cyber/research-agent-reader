import { findSourceAnchorOffset } from "./annotation-service";
import { bilingualSelectionContext } from "./bilingual";
import { revealMarkdownRange } from "./markdown-selection";
import type { AnnotationRecord } from "./types";

const SOURCE = "[data-agent-annotation-source]";
const BLOCK = "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6";

function lineOffset(text: string, line: number): number {
	let at = 0;
	for (let n = 0; n < line; n++) { const next = text.indexOf("\n", at); if (next < 0) return text.length; at = next + 1; }
	return at;
}

export function renderedAnnotationRanges(roots: HTMLElement[], content: string, record: AnnotationRecord): Range[] {
	const ranges: Range[] = [];
	if (!record.sourceAnchor) return ranges;
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
