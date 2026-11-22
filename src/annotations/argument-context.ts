import { evidenceSentences } from "./cli-evidence-scope";
import { parseBilingualMarkdown } from "../reader/bilingual-document";
// Normalize the figure number across caption and panel references (Fig. 3b → fig:3).
function referenceKeys(value: string): string[] {
	const keys = new Set<string>();
	for (const match of value.matchAll(/(?:\b(fig(?:ure)?s?|tables?)\.?|([图表]))\s*[*_[]*(S?\d+)[a-z]?(?![a-z\d])/gi)) {
		const table = match[2] === "表" || match[1]?.toLowerCase().startsWith("table");
		keys.add((table ? "table:" : "fig:") + match[3].toLowerCase());
	}
	return [...keys];
}

function methodTerms(value: string): Set<string> {
	const common = new Set(["this","that","with","from","were","using","used","method","methods","analysis","figure","results","these","which","between","showed","sample","table","based","performed"]);
	return new Set((value.toLowerCase().match(/[a-z][a-z\d-]{3,}|[\u3400-\u9fff]{2,}/g) || []).filter(word => !common.has(word)));
}

export function argumentPassages(text: string, selected: string, offset?: number, question = ""): string[] {
	const blocks = parseBilingualMarkdown(text).blocks;
	const first = text.indexOf(selected);
	const start = offset ?? (first >= 0 && text.indexOf(selected, first + selected.length) < 0 ? first : -1);
	if (start < 0 || text.slice(start, start + selected.length) !== selected) return [];
	const at = blocks.findIndex(block => block.start <= start && start < block.end);
	if (at < 0) return [];
	const raw = blocks.map(block => text.slice(block.start, block.end).trim());
	const keys = new Set(referenceKeys([raw[at], question].join(" ")));
	const terms = methodTerms(selected + " " + question);
	const headings: string[] = [];
	const ranked: { index: number; score: number }[] = [];
	let overview = false;
	let captionBody = false;
	for (const [index, block] of blocks.entries()) {
		const line = raw[index];
		if (block.kind === "heading") {
			const level = /^#+/.exec(line)?.[0].length || 1;
			headings.length = level - 1;
			headings.push(line);
			overview = /abstract|conclu|limitation|discussion|摘要|结论|局限|讨论/i.test(line);
		}
		let score = captionBody && block.kind === "paragraph" ? 78 : 0;
		captionBody = false;
		const references = referenceKeys(line);
		if (references.some(key => keys.has(key))) {
			const caption = /^[#\s>*_]*(fig(?:ure)?s?\.?|table|图|表)\s*[*_[]*S?\d/i.test(line);
			score = Math.max(score, caption ? 80 : 55);
			captionBody = caption && (block.kind === "heading" || line.length < 240);
		}
		if (block.kind === "paragraph") {
			if (headings.some(h => /methods?|procedures?|experimental|方法|实验流程/i.test(h))) {
				const words = methodTerms(headings.join(" ") + " " + line);
				const matches = [...terms].filter(term => words.has(term)).length;
				if (matches) score = Math.max(score, 60 + Math.min(matches, 16));
			}
			if (overview) score = Math.max(score, 20);
			overview = false;
		}
		if (Math.abs(index - at) <= 2) score = Math.max(score, 48 - Math.abs(index - at));
		if (score || at === index) ranked.push({index, score: index === at ? 100 : score});
	}
	return ranked.sort((a,b) => b.score - a.score || Math.abs(a.index-at) - Math.abs(b.index-at))
		.slice(0,12).sort((a,b) => a.index-b.index).map(({index}) => {
			const local = index === at ? raw[index].indexOf(selected, Math.max(0, start - blocks[at].start - 16)) : -1;
			const from = local > 1700 ? Math.max(0, local - 350) : 0;
			return "[段 " + (index+1) + "] " + raw[index].slice(from, from+Math.max(2300, index === at ? selected.length+350 : 0));
		});
}

/** The host supplies and displays original sentences, so models only copy their IDs. */
export function contextSentences(passages: string[]): Map<string, string> {
	const sentences = new Map<string, string>();
	for (const passage of passages) {
		const match = /^\[段 (\d+)\] ([\s\S]+)$/.exec(passage);
		if (!match) continue;
		evidenceSentences(match[2]).forEach((sentence, i) => sentences.set("[段 " + match[1] + " 句 " + (i + 1) + "]", sentence));
	}
	return sentences;
}

export function attachContextQuotes(text: string, sentences: Map<string, string>): string {
	// Chinese punctuation and contiguous ranges represent the same supplied sentence IDs.
	text = text.replace(/[［【\[]\s*段\s*(\d+)\s*句\s*(\d+)(?:\s*[-–—至]\s*(\d+))?\s*[］】\]]/gu,
		(_match, paragraph: string, first: string, last?: string) => {
			const start = Number(first), end = Number(last || first);
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end-start > 16) throw new Error("段句引用范围无效，请重试");
			const ids = Array.from({length:end-start+1},(_,i)=>"[段 "+paragraph+" 句 "+(start+i)+"]");
			if (ids.some(id=>!sentences.has(id))) throw new Error("上下文解释引用了未知段句，请重试");
			return ids.join("");
		});
	if (/[［【]\s*段/u.test(text)) throw new Error("上下文解释包含无法核对的段句引用，请重试");
	const refs = [...new Set(text.match(/\[段[^\]\n]*\]/g))];
	if (!refs.length || refs.some(ref => !sentences.has(ref))) throw new Error("上下文解释引用了未知段句，或缺少原文引用，请重试");
	const quotes = refs.map(ref => sentences.get(ref)!);
	const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
	for (const match of text.matchAll(/[“"]([^“”"\n]+)[”"]/g)) {
		if (/[a-z]{2,}\s+[a-z]{2,}/i.test(match[1]) && !quotes.some(q => normalize(q).includes(normalize(match[1]))))
			throw new Error("上下文解释的英文引句与所引原句不符，请重试");
	}
	return text + "\n\n原文依据\n" + refs.map((ref, i) => ref + " " + quotes[i]).join("\n\n");
}
export const EXPLANATION_DIVIDER="\n\n### 上下文解释\n\n";

export function quoteOffset(text: string, paragraph: number, quote: string): number {
	const block = parseBilingualMarkdown(text).blocks[paragraph - 1];
	const raw = block && text.slice(block.start, block.end);
	const at = raw?.indexOf(quote) ?? -1;
	if (!block || !quote || at < 0 || raw!.indexOf(quote, at + 1) >= 0)
		throw new Error("当前原文无法唯一核对这句引文，请重新展开解释");
	return block.start + at;
}

export function annotationEvidence(explanation: string, original: string, currentBlock: string): string[] {
	const quotes = new Set<string>();
	for (const part of explanation.split(EXPLANATION_DIVIDER)) {
		const footer = "\n\n原文依据\n", at = part.lastIndexOf(footer);
		if (at >= 0) {
			for (const row of part.slice(at + footer.length).trim().split(/\n\n(?=\[段 )/)) {
				const match = /^\[段 (\d+) 句 \d+\] ([\s\S]+)$/.exec(row);
				if (!match) throw new Error("批注引句格式已变化，请重新展开解释");
				const quote = match[2].trim();
				quoteOffset(original, Number(match[1]), quote);
				quotes.add(quote);
			}
		}
		const marker = "\n\n对应原文：\n", start = part.lastIndexOf(marker);
		if (start >= 0) {
			for (const block of part.slice(start + marker.length, at >= 0 ? at : undefined).trim().split(/\n\n(?=> )/)) {
				const lines = block.split("\n");
				const quote = lines.map(line => line.replace(/^> /, "")).join("\n");
				if (lines.some(line => !line.startsWith("> ")) || !quote || !currentBlock.includes(quote))
					throw new Error("批注中的对应引句与当前原文不符，请重新核对");
				quotes.add(quote);
			}
		}
	}
	return [...quotes];
}
