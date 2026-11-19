import { evidenceSentences } from "./cli-evidence-scope";
import { parseBilingualMarkdown } from "../reader/bilingual-document";
export function argumentPassages(text: string, selected: string, offset?: number): string[] {
	const blocks=parseBilingualMarkdown(text).blocks;
	const first=text.indexOf(selected), start=offset ?? (first>=0 && text.indexOf(selected,first+selected.length)<0 ? first : -1);
	if (start < 0 || text.slice(start, start + selected.length) !== selected) return [];
	const at=blocks.findIndex(b=>start>=b.start && start<b.end);
	if(at<0)return [];
	const chosen=new Set<number>();
	for(let i=Math.max(0,at-2);i<=Math.min(blocks.length-1,at+2);i++)chosen.add(i);
	for(let i=0;i<blocks.length;i++) if(blocks[i].kind==="heading" && /abstract|conclu|limitation|discussion|摘要|结论|局限|讨论/i.test(text.slice(blocks[i].start,blocks[i].end))){
		const next=blocks.findIndex((b,j)=>j>i && b.kind==="paragraph" && b.chapter===blocks[i].chapter);
		if(next>=0)chosen.add(next);
	}
	return [...chosen].sort((a,b)=>a-b).slice(0,12).map(i=>{const b=blocks[i];return "[段 "+(i+1)+"] "+text.slice(b.start,b.end).trim().slice(0,2300);});
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
