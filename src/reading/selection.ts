import type { ReadingQuote } from "./types";
function compact(value: string): string { return value.replace(/[*_`~\\]/g, "").replace(/\s+/g, " ").trim(); }
/** Map rendered selection to raw answer offsets; ambiguity is rejected, never guessed. */
export function resolveReadingQuote(nodeId: string, markdown: string, selected: string, before = "", after = ""): ReadingQuote {
	const normalized = compact(selected); if (!normalized) throw new Error("请选择文字");
	const offsets: number[] = []; let plain = ""; let whitespace = false;
	for (let i = 0; i < markdown.length; i++) {
		const ch = markdown[i]; if (/[*_`~\\]/.test(ch)) continue;
		if (/\s/.test(ch)) { if (!whitespace) { plain += " "; offsets.push(i); } whitespace = true; }
		else { whitespace = false; plain += ch; offsets.push(i); }
	}
	const prefix = compact(before).slice(-60); const suffix = compact(after).slice(0, 60);
	const candidates: Array<{ start: number; end: number; score: number }> = [];
	let found = plain.indexOf(normalized);
	while (found >= 0) {
		const left = plain.slice(Math.max(0, found - 80), found).trimEnd(); const right = plain.slice(found + normalized.length, found + normalized.length + 80).trimStart();
		let score = 0;
		for (let size = 1; size <= prefix.length; size++) if (left.endsWith(prefix.slice(-size))) score = Math.max(score, size);
		let rightScore = 0;
		for (let size = 1; size <= suffix.length; size++) if (right.startsWith(suffix.slice(0, size))) rightScore = Math.max(rightScore, size);
		candidates.push({ start: offsets[found], end: offsets[found + normalized.length - 1] + 1, score: score + rightScore });
		found = plain.indexOf(normalized, found + 1);
	}
	candidates.sort((a, b) => b.score - a.score);
	if (!candidates.length || (candidates.length > 1 && candidates[0].score === candidates[1].score)) throw new Error("无法唯一定位选中文字，请选择更完整的一段");
	const { start, end } = candidates[0]; return { nodeId, text: markdown.slice(start, end), start, end };
}
