/** Reserved literal learning blocks are retained for readers, excluded from factual evidence.
 * Offsets always refer to the original file. An unfinished block stays excluded through EOF. */
export const LEARNING_BLOCK_LANGUAGE = "rar-learning-note";
export function learningBlockRanges(text: string): { start: number; end: number }[] {
	if (!text.includes(LEARNING_BLOCK_LANGUAGE)) return [];
	const ranges: { start: number; end: number }[] = []; let fence = "", start = -1;
	for (const line of text.matchAll(/^.*(?:\n|$)/gm)) {
		if (!line[0]) continue;
		if (fence) {
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line[0]);
			if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { if (start >= 0) ranges.push({ start, end: line.index + line[0].length }); fence = ""; start = -1; }
		} else {
			const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line[0]);
			if (open) { fence = open[1]; if (open[2].trim().split(/\s/)[0] === LEARNING_BLOCK_LANGUAGE) start = line.index; }
		}
	}
	if (start >= 0) ranges.push({ start, end: text.length }); return ranges;
}
export function overlapsLearningBlock(text: string, start: number, end: number): boolean { return learningBlockRanges(text).some(r => start < r.end && end > r.start); }
export function maskLearningBlocks(text: string): string {
	for (const r of learningBlockRanges(text).reverse()) text = text.slice(0, r.start) + text.slice(r.start, r.end).replace(/[^\r\n]/g, " ") + text.slice(r.end);
	return text;
}
export function literalLearningBlock(text: string): string {
	let width = 3; for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
	const fence = "`".repeat(width); return fence + LEARNING_BLOCK_LANGUAGE + "\n" + text + "\n" + fence;
}
