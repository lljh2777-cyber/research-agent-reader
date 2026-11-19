import { parseBilingualMarkdown } from "../reader/bilingual-document";
export function argumentPassages(text: string, selected: string, offset?: number): string[] {
	const blocks=parseBilingualMarkdown(text).blocks;
	const first=text.indexOf(selected), start=offset ?? (first>=0 && text.indexOf(selected,first+selected.length)<0 ? first : -1);
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
export const EXPLANATION_DIVIDER="\n\n### 上下文解释\n\n";
