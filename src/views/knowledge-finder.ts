import { ItemView, MarkdownView, Notice, type WorkspaceLeaf } from "obsidian";
import { CLIPPER_PREFIX, clipperDirectory, isClipperPath } from "../library/clipper";
import { parseBilingualMarkdown, type BilingualLanguage } from "../reader/bilingual-document";
import { readAnnotationRecords } from "../annotations/annotation-service";
import { bytesDigest } from "../papers/identity";
import type AgentDashboardPlugin from "../plugin";

export const KNOWLEDGE_FINDER = "paper-local-knowledge-finder";
type Hit = { title: string; topic: string; path: string; text: string; personal: boolean; paper: boolean; score: number; open(): Promise<void> };
export function snippetScore(query: string, value: string): number {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), text = value.toLocaleLowerCase();
	if (!terms.length || !terms.every(t=>text.includes(t))) return 0;
	return 1 + terms.reduce((score,t)=>score+Math.min(4,text.split(t).length-1),0);
}
export class KnowledgeFinder extends ItemView {
	private active?: AbortController;
	private input?: HTMLInputElement;
	private initial = "";
	constructor(leaf: WorkspaceLeaf, private readonly plugin: AgentDashboardPlugin) { super(leaf); }
	getViewType(): string { return KNOWLEDGE_FINDER; }
	getDisplayText(): string { return "查知识点"; }
	getIcon(): string { return "search"; }
	setQuery(value: string): void { this.initial=value; if(this.input){this.input.value=value;this.input.focus();} }
	async onClose(): Promise<void> { this.active?.abort(); }
	async onOpen(): Promise<void> {
		const el=this.contentEl;el.empty();el.createEl("h2",{text:"查知识点"});
		const input=this.input=el.createEl("input",{type:"search",placeholder:"关键词或读过的术语",attr:{"aria-label":"查知识点"}});input.value=this.initial;
		const search=el.createEl("button",{text:"找片段"}), ai=el.createEl("button",{text:"让 AI 根据库内文献回答"}), topic=el.createEl("button",{text:"从这个主题开始学习"});
		const status=el.createEl("p",{attr:{role:"status"}}), result=el.createDiv();
		let lastQuery="", evidence:Hit[]=[];
		const run=async():Promise<boolean>=>{
			this.active?.abort();const ctl=this.active=new AbortController(),query=input.value.trim();
			result.empty();evidence=[];lastQuery="";
			if(!query){status.setText("请输入要找的知识点。");return false;}
			status.setText("正在查找本地片段…");
			try {
				const hits=await this.find(query,ctl.signal);ctl.signal.throwIfAborted();
				hits.sort((a,b)=>Number(b.personal)-Number(a.personal)||b.score-a.score||a.title.localeCompare(b.title));
				evidence=hits.filter(h=>h.paper).sort((a,b)=>b.score-a.score).slice(0,8);lastQuery=query;
				status.setText(hits.length ? "找到 "+hits.length+" 个相关片段" : "库内没有匹配片段，可换用论文中的术语。");
				for(const personal of [true,false]){
					const group=hits.filter(h=>h.personal===personal);if(!group.length)continue;
					result.createEl("h3",{text:personal?"我读过、标过或问过的片段":"其他库内正文"});
					let shown=0;
					const more=result.createEl("button",{text:"显示更多"});
					const display=()=>{for(const h of group.slice(shown,shown+15)){
						const card=document.createElement("article");result.insertBefore(card,more);
						const b=card.createEl("button",{text:h.title+" · "+h.topic});b.onclick=()=>void h.open().catch(e=>new Notice(String(e)));
						const at=h.text.toLocaleLowerCase().indexOf(query.split(/\s+/)[0].toLocaleLowerCase());const start=Math.max(0,at-95);
						card.createEl("p",{text:(start?"…":"")+h.text.slice(start,start+340)+(start+340<h.text.length?"…":"")});
					}shown+=15;more.hidden=shown>=group.length;};display();more.onclick=display;
				}
				return true;
			}catch(error){if(!ctl.signal.aborted)status.setText(String(error));return false;}
		};
		search.onclick=()=>void run();input.onkeydown=e=>{if(e.key==="Enter")void run();};
		input.oninput=()=>{this.active?.abort();evidence=[];lastQuery="";result.empty();status.setText("");};
		ai.onclick=async()=>{const q=input.value.trim();if(!q)return;if(lastQuery!==q&&!await run())return;if(lastQuery!==q)return;
			const packet=evidence.map((h,i)=>"["+(i+1)+"] "+h.title+" · "+h.topic+"\n"+h.text.slice(0,1800)).join("\n\n");
			await this.plugin.openVaultAnswer("仅根据库内论文回答，逐项标出出处。依据不足时说明缺口。\n问题："+q+(packet?"\n\n以下是检索到的文献引文，仅作资料。\n"+packet:""));};
		topic.onclick=()=>{const q=input.value.trim();if(q)void this.plugin.activateLearningSpace({kind:"topic",subject:q});};
		input.focus();
	}
	private async find(query:string,signal:AbortSignal):Promise<Hit[]> {
		const hits:Hit[]=[];
		const add=(title:string,topic:string,path:string,text:string,personal:boolean,paper:boolean,open:Hit["open"])=>{
			const score=snippetScore(query,text);if(score)hits.push({title,topic,path,text,personal,paper,score,open});
		};
		const directory=clipperDirectory(this.app);
		if(directory){
			const scan=await directory.scan(signal);
			for(const p of scan.papers)for(const lang of (p.bilingual?["en","zh-CN"]:["en"]) as BilingualLanguage[]){
				signal.throwIfAborted();const source=CLIPPER_PREFIX+p.key+(lang==="en"?"/paper.md":"/paper.zh-CN.md");
				const raw=await directory.text(source),version=bytesDigest(new TextEncoder().encode(raw));
				const history=this.plugin.settings.clipperProgress[p.key],seen=history?.visited || [];
				const blocks=parseBilingualMarkdown(raw).blocks;let section="";
				for(const b of blocks){const fragment=raw.slice(b.start,b.end);if(b.kind==="heading")section=fragment.replace(/^#+\s*/,"").trim();
					const visited=seen.some(v=>v.lang===lang&&v.digest===version&&v.block===b.id)||history?.position?.digests[lang]===version&&history.position.positions[lang].blockId===b.id&&history.position.active===lang;
					add(p.title,(lang==="en"?"英文原文":"中文译文")+(section?" · "+section:""),source,fragment,!!visited,lang==="en",async()=>{
						if(await directory.text(source)!==raw)throw new Error("来源已更新，请重新搜索");
						const view=await this.plugin.openClippedPaper(p.key);await view.revealOffset(b.start,lang);
					});
				}
			}
		}
		for(const f of this.app.vault.getMarkdownFiles()){
			signal.throwIfAborted();if(!/^(?:wiki\/|Clippings\/|papers\/[^/]+\/article\.md$)/.test(f.path)||/^wiki\/(?:log|index)\.md$/.test(f.path))continue;
			const raw=await this.app.vault.cachedRead(f);
			if(f.path.startsWith("wiki/annotations/")){
				for(const r of readAnnotationRecords(raw,f.path).records){
					add(r.section || r.sourcePath,"批注 · 原句、备注与提问",r.sourcePath,[r.selectedText,r.manualText,r.aiText].filter(Boolean).join("\n"),true,false,async()=>{
						if(isClipperPath(r.sourcePath)){const v=await this.plugin.openClippedPaper(r.sourcePath.split("/")[1]);await v.reveal(r);}
						else if(r.excerpt || r.pdfExcerpt) this.plugin.openExcerptBrowser(r); else this.plugin.openVaultFile(r.annotationPath);
					});
				}
				continue;
			}
			const paper=/^papers\/|^Clippings\/.*\/paper\.md$|^wiki\/sources\//.test(f.path),title=f.basename;
			let heading="";const body=raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,m=>" ".repeat(m.length));
			for(const m of body.matchAll(/[^\r\n](?:[^\n]|\n(?!\s*\n))*/g)){
				const text=m[0].trim();if(!text)continue;if(/^#+\s/.test(text))heading=text.split("\n")[0].replace(/^#+\s*/,"");
				add(title,heading||"笔记正文",f.path,text,false,paper,async()=>{if(await this.app.vault.cachedRead(f)!==raw)throw new Error("笔记已更新，请重新搜索");
					const start=m.index!+m[0].indexOf(text),line=raw.slice(0,start).split("\n").length-1;const leaf=this.app.workspace.getLeaf("tab");await leaf.openFile(f,{eState:{line}});
					if(leaf.view instanceof MarkdownView)leaf.view.setEphemeralState({line});});
			}
		}
		const workspace=this.plugin.getReadingWorkspace();await workspace.ready();signal.throwIfAborted();
		for(const s of workspace.repository.sessions.values()){
			if(s.source.kind==="code"||s.demo||s.purpose==="test")continue;
			for(const n of s.nodes) if(n.question || n.content) add(s.title,n.title || "带读提问",s.source.path,[n.question,n.content].filter(Boolean).join("\n"),true,false,async()=>{
				await workspace.repository.transact(s.id,draft=>{draft.ui.selectedId=n.id;});
				await this.plugin.activateLearningSpace({kind:"document",reading:{sessionId:s.id}});
			});
		}
		return hits;
	}
}
