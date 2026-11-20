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
			captionBody = caption && block.kind === "heading";
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
