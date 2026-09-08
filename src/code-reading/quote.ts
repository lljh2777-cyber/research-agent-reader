import type { ReadingCodeQuote, ReadingEvidence, ReadingNode } from "../reading/types";

/** Offsets are in the original decoded file, including CRLF; never strip code punctuation. */
export function codeQuote(evidence: ReadingEvidence, start: number, end: number): ReadingCodeQuote {
	if (evidence.kind !== "code" || evidence.start === undefined || !evidence.startLine || !evidence.sourceHash
		|| !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > evidence.text.length
		|| !evidence.text.slice(start, end).trim()) throw new Error("源码选区无效，请重新划选");
	const lineAt = (offset: number) => evidence.startLine! + [...evidence.text.slice(0, offset).matchAll(/\r\n|\r|\n/g)].length;
	const text = evidence.text.slice(start, end);
	return { evidenceId: evidence.id, path: evidence.path, sourceHash: evidence.sourceHash, text,
		start: evidence.start + start, end: evidence.start + end, startLine: lineAt(start), endLine: lineAt(end - (text.match(/(?:\r\n|\r|\n)$/)?.[0].length || 0)) };
}
export function verifyCodeQuote(quote: ReadingCodeQuote, evidence?: ReadingEvidence): void {
	if (!evidence) throw new Error("源码选区依据缺失");
	const expected = codeQuote(evidence, quote.start - evidence.start!, quote.end - evidence.start!);
	if (Object.keys(expected).some(key => expected[key as keyof ReadingCodeQuote] !== quote[key as keyof ReadingCodeQuote])) throw new Error("源码选区与保存的依据不一致");
}
/** Browser selection may normalize line endings. Prefix/suffix anchor repeated snippets exactly. */
export function codeSelectionOffsets(source: string, before: string, selected: string, after: string): { start: number; end: number } {
	const normalize = (s: string) => s.replace(/\r\n|\r/g, "\n");
	const text = normalize(source), prefix = normalize(before), selection = normalize(selected), suffix = normalize(after);
	if (!selection.trim() || prefix + selection + suffix !== text) throw new Error("源码选区已变化，请重新划选");
	const positions = [0]; for (let i = 0; i < source.length;) { i += source[i] === "\r" && source[i + 1] === "\n" ? 2 : 1; positions.push(i); }
	return { start: positions[prefix.length], end: positions[prefix.length + selection.length] };
}
export function codeFence(text: string, language = "text"): string {
	const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
	return fence + (["python", "r", "text"].includes(language) ? language : "text") + "\n" + text + (text.endsWith("\n") ? "" : "\n") + fence;
}
export function readingQuestionContext(node: ReadingNode): string {
	const q = node.codeQuote;
	return node.question + (q ? "\n历史源码选区（事实仍须核对本轮依据）：" + q.path + ":" + q.startLine + "–" + q.endLine + "\n" + codeFence(q.text) : "");
}
