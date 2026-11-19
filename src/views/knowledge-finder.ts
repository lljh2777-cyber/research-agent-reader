import { tokenizeForLexicalRetrieval } from "../query/lexical-retrieval";
import { ItemView, MarkdownView, Notice, type WorkspaceLeaf } from "obsidian";
import { CLIPPER_PREFIX, clipperDirectory, isClipperPath } from "../library/clipper";
import { parseBilingualMarkdown, type BilingualLanguage } from "../reader/bilingual-document";
import { readAnnotationRecords } from "../annotations/annotation-service";
import { bytesDigest } from "../papers/identity";
import type AgentDashboardPlugin from "../plugin";

export const KNOWLEDGE_FINDER = "paper-local-knowledge-finder";
type Hit = { title: string; topic: string; path: string; text: string; personal: boolean; paper: boolean; score: number; citation?: string; open(): Promise<void> };
function prepareSnippetScorer(query: string): (value: string) => number {
	const phrase = query.trim().normalize("NFKC").toLowerCase();
	const topic = phrase.replace(/是什么|是什么意思|什么是|为什么|怎么|如何|我读过的|在哪篇论文|[？?]/g, " ");
	const terms = tokenizeForLexicalRetrieval(topic, 24);
	const minimum = Math.max(1, Math.ceil(terms.length * 0.65));
	return value => {
		if (!phrase) return 0;
		const text = value.normalize("NFKC").toLowerCase();
		if (text.includes(phrase)) return 20 + Math.min(4, text.split(phrase, 5).length - 1);
		const matched = terms.filter(term => text.includes(term)).length;
		return matched >= minimum ? matched / terms.length * 10 : 0;
	};
}

function renderHits(result: HTMLElement, title: string, hits: Hit[], query: string): void {
	if (!hits.length) return;
	result.createEl("h3", { text: title });
	const cards = result.createDiv();
	const more = result.createEl("button", { text: "显示更多" });
	const term = query.split(/\s+/)[0].toLocaleLowerCase();
	let shown = 0;
	const showPage = () => {
		for (const hit of hits.slice(shown, shown + 15)) {
			const card = cards.createEl("article");
			const open = card.createEl("button", { text: hit.title + " · " + hit.topic });
			open.onclick = () => void hit.open().catch(error => new Notice(String(error)));
			const start = Math.max(0, hit.text.toLocaleLowerCase().indexOf(term) - 95);
			const end = start + 340;
			card.createEl("p", { text: (start ? "…" : "") + hit.text.slice(start, end) + (end < hit.text.length ? "…" : "") });
		}
		shown += 15;
		more.hidden = shown >= hits.length;
	};
	more.onclick = showPage;
	showPage();
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
				const warnings: string[] = [];
				const hits=await this.find(query,ctl.signal,warnings);ctl.signal.throwIfAborted();
				hits.sort((a,b)=>Number(b.personal)-Number(a.personal)||b.score-a.score||a.title.localeCompare(b.title));
				evidence=hits.filter(h=>h.paper).sort((a,b)=>b.score-a.score).slice(0,8);lastQuery=query;
				status.setText(hits.length ? "找到 "+hits.length+" 个相关片段" : "库内没有匹配片段，可换用论文中的术语。");
				renderHits(result, "我读过、标过或问过的片段", hits.filter(hit => hit.personal), query);
				renderHits(result, "其他库内正文", hits.filter(hit => !hit.personal), query);
				if (warnings.length) result.createEl("p", { text: warnings.join("；") });
				return true;
			}catch(error){if(!ctl.signal.aborted)status.setText(String(error));return false;}
		};
		search.onclick=()=>void run();input.onkeydown=e=>{if(e.key==="Enter")void run();};
		input.oninput=()=>{this.active?.abort();evidence=[];lastQuery="";result.empty();status.setText("");};
		ai.onclick=async()=>{const q=input.value.trim();if(!q)return;if(lastQuery!==q&&!await run())return;if(lastQuery!==q)return;
			const packet=evidence.map((h,i)=>"["+(i+1)+"] "+h.title+" · "+h.topic+" "+(h.citation || "")+"\n"+h.text.slice(0,1200)).join("\n\n");
			await this.plugin.openVaultAnswer("仅根据库内论文回答。每项结论使用形如 [来源编号](该编号给出的完整 obsidian 链接) 的可点击引文。依据不足时说明缺口。\n问题："+q+(packet?"\n\n以下是检索到的文献引文，仅作资料。\n"+packet:""));};
		topic.onclick=()=>{const q=input.value.trim();if(q)void this.plugin.activateLearningSpace({kind:"topic",subject:q});};
		input.focus();
	}
	private async find(query:string,signal: AbortSignal, warnings: string[] = []): Promise<Hit[]> {
		const hits: Hit[] = [];
		const scoreSnippet = prepareSnippetScorer(query);
		const add=(title:string,topic:string,path:string,text:string,personal:boolean,paper:boolean,open:Hit["open"], locator?: {offset:number;digest:string})=>{
			const score=scoreSnippet(text);if(!score)return;
			const citation=locator ? "obsidian://rar-paper-evidence?"+new URLSearchParams({source:path,at:String(locator.offset),digest:locator.digest}).toString() : undefined;
			hits.push({title,topic,path,text,personal,paper,score,open,citation});
		};
		const directory=clipperDirectory(this.app);
		if(directory){
			const scan = await directory.scan(signal).catch((error: unknown) => {
				signal.throwIfAborted();
				return { papers: [], issues: [String(error)] };
			});
			if (scan.issues.length) warnings.push("部分外部文献未能检索：" + scan.issues.join("；"));
			for(const p of scan.papers)for(const lang of (p.bilingual?["en","zh-CN"]:["en"]) as BilingualLanguage[]){
				signal.throwIfAborted();const source=CLIPPER_PREFIX+p.key+(lang==="en"?"/paper.md":"/paper.zh-CN.md");
				let raw: string;
				try {
					raw = await directory.text(source);
				} catch (error) {
					signal.throwIfAborted();
					warnings.push(p.title + " · " + String(error));
					continue;
				}
				const version = bytesDigest(new TextEncoder().encode(raw));
				const history=this.plugin.settings.clipperProgress[p.key],seen=history?.visited || [];
				const blocks=parseBilingualMarkdown(raw).blocks;let section="";
				for(const b of blocks){const fragment=raw.slice(b.start,b.end);if(b.kind==="heading")section=fragment.replace(/^#+\s*/,"").trim();
					const visited=seen.some(v=>v.lang===lang&&v.digest===version&&v.block===b.id)||history?.position?.digests[lang]===version&&history.position.positions[lang].blockId===b.id&&history.position.active===lang;
					add(p.title,(lang==="en"?"英文原文":"中文译文")+(section?" · "+section:""),source,fragment,!!visited,lang==="en",async()=>{
						if(await directory.text(source)!==raw)throw new Error("来源已更新，请重新搜索");
						const view=await this.plugin.openClippedPaper(p.key);await view.revealOffset(b.start,lang);
					},{offset:b.start,digest:version});
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
			const version=bytesDigest(new TextEncoder().encode(raw));let heading="";const body=raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,m=>" ".repeat(m.length));
			for(const m of body.matchAll(/[^\r\n](?:[^\n]|\n(?!\s*\n))*/g)){
				const text=m[0].trim();if(!text)continue;if(/^#+\s/.test(text))heading=text.split("\n")[0].replace(/^#+\s*/,"");
				add(title,heading||"笔记正文",f.path,text,false,paper,async()=>{if(await this.app.vault.cachedRead(f)!==raw)throw new Error("笔记已更新，请重新搜索");
					const start=m.index!+m[0].indexOf(text),line=raw.slice(0,start).split("\n").length-1;const leaf=this.app.workspace.getLeaf("tab");await leaf.openFile(f,{eState:{line}});
					if(leaf.view instanceof MarkdownView)leaf.view.setEphemeralState({line});},{offset:m.index!+m[0].indexOf(text),digest:version});
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
