import { Component, MarkdownRenderer, Notice } from "obsidian";
import { type AnnotationService, readAnnotationRecords } from "../annotations/annotation-service";
import type { AnnotationRecord, AnnotationSelection } from "../annotations/types";
import { annotationDisplayText, revealMarkdownRange } from "../annotations/markdown-selection";
import type { BilingualLanguage } from "../reader/bilingual-document";
import { readingAnnotationOrigin } from "../reading/navigation";
import { safeReadingMarkdown } from "../reading/export";
import type { AnnotationOrigin, ReadingBranch, ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";
import type { BilingualReader } from "./bilingual-reader";

interface Passage { lang: BilingualLanguage; start: number; end: number; digest: string }
interface Place { passage: Passage; element: HTMLElement; blockStart: number; blockEnd: number }
type Composer = { place: Place; selection?: AnnotationSelection; parent?: string; child?: boolean; value: string };
function button(host: HTMLElement, label: string, run: () => void, cls = "") {
	const b = host.createEl("button", { text: label, cls, attr: { type: "button" } }); b.onclick = run; return b;
}

/** The document owns the layout; all discussion history lives in the regular reading repository. */
export class InlinePaperReading {
	private key = "";
	private paths: string[] = [];
	private opened = "";
	private composer?: Composer;
	private busy = false;
	private signature = "";
	private notes: AnnotationRecord[] = [];
	private readonly targets = new Map<string, HTMLElement>();
	private readonly mounts = new Map<HTMLElement, HTMLElement>();
	private readonly index: HTMLDetailsElement;
	private readonly links: HTMLElement;
	private renderer = new Component();
	constructor(readonly reader: BilingualReader, toolbar: HTMLElement, private annotations: AnnotationService,
		private workspace: ReadingWorkspaceService, private canonical: () => Promise<{ key: string; aliases: string[] }>,
		private edit: (record: AnnotationRecord, rect: DOMRect) => void) {
		this.index = toolbar.createEl("details", {cls:"rar-paper-index"});
		this.index.createEl("summary", {text:"本文思路"});
		this.links = this.index.createDiv();
		this.renderer.load();
		this.indexTargets();
	}
	get doc() { return this.reader.options.document; }
	private get signal() { return this.reader.options.signal; }
	private get session() {
		const digest = this.doc.files.en.revision.digest;
		return [...this.workspace.repository.sessions.values()].filter(s => !s.demo && !s.archived && s.source.path === this.key &&
			(s.source.fingerprint === digest || (/^papers\/[^/]+\/article\.md$/.test(this.key) && s.branches.some(b => b.annotation?.englishDigest === digest))))
			.sort((a,b) => Number(!!b.paperSpace)-Number(!!a.paperSpace) || b.updatedAt.localeCompare(a.updatedAt))[0];
	}
	private indexTargets() {
		for (const [lang,pane] of this.reader.panes) {
			let block = "";
			for (const e of pane.article.querySelectorAll<HTMLElement>("[data-bilingual-anchor],p,h1,h2,h3,h4,h5,h6,li,table,blockquote,pre")) {
				if (e.dataset.bilingualAnchor) { block = pane.anchors.get(e.dataset.bilingualAnchor) === e ? e.dataset.bilingualAnchor : ""; continue; }
				if (block && !e.classList.contains("agent-bilingual-marker") && !e.querySelector("[data-bilingual-anchor]")) this.targets.set(lang+block,e.closest<HTMLElement>("table,ul,ol,blockquote") || e);
			}
		}
	}
	async start() {
		const {app} = this.reader.options;
		const clean = () => { this.renderer.unload(); for (const mount of this.mounts.values()) mount.remove(); this.index.remove(); };
		this.signal.addEventListener("abort",clean,{once:true});
		const { key, aliases } = await this.canonical();
		this.key = key;
		this.paths = [this.doc.files.en.path, this.doc.files["zh-CN"].path, key, key.replace(/\/paper\.md$/, "/paper.zh-CN.md"), ...aliases];
		await this.workspace.ready();
		if (this.signal.aborted) return;
		this.opened = this.session?.ui.inlineBranchId || "";
		const unsub = this.workspace.repository.subscribe(id => { if (this.session?.id === id) this.render(); });
		let timer = 0, revision = 0;
		const loadNotes = async () => {
			const version = ++revision;
			const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith("wiki/annotations/"));
			const notes: AnnotationRecord[] = [];
			for (const f of files) {
				if (this.signal.aborted || version !== revision) return;
				const meta = app.metadataCache.getFileCache(f)?.frontmatter?.source;
				if (typeof meta === "string" && !this.paths.some(p => meta === p || meta === p.replace(/\.md$/,""))) continue;
				for (const r of readAnnotationRecords(await app.vault.cachedRead(f),f.path).records)
					if (this.paths.includes(r.sourcePath) && r.bilingual) notes.push(r);
			}
			if (!this.signal.aborted && version === revision) { this.notes=notes; this.render(true); }
		};
		const reload = () => { void loadNotes().catch(e => {if (!this.signal.aborted) new Notice(String(e));}); };
		const changed = (f: {path:string}) => { if(f.path.startsWith("wiki/annotations/")) {window.clearTimeout(timer); timer=window.setTimeout(reload,200);} };
		const refs = [app.vault.on("create",changed),app.vault.on("modify",changed),app.vault.on("delete",changed)];
		this.signal.addEventListener("abort",()=>{unsub();window.clearTimeout(timer);refs.forEach(r=>app.vault.offref(r));},{once:true});
		this.render(true); reload();
	}
	contains(el: Element) { return [...this.reader.panes.values()].some(p=>p.article.contains(el)); }
	private place(p: Passage | undefined): Place | undefined {
		if (!p || this.reader.stale) return;
		const file=this.doc.files[p.lang];
		if (!file || file.revision.digest!==p.digest) return;
		const block=file.blocks.find(b=>b.start<=p.start && p.start<b.end && p.end<=b.end);
		const element=block && this.targets.get(p.lang+block.id);
		if (block && element) return {passage:p,element,blockStart:block.start,blockEnd:block.end};
	}
	private originPlace(a: AnnotationOrigin) {
		if (a.englishDigest!==this.doc.files.en.revision.digest) return;
		if (a.selection) return this.place(a.selection);
		const lang=a.chinese?"zh-CN":"en", file=this.doc.files[lang];
		const end=file.text.startsWith(a.selected,a.at)?a.at+a.selected.length:a.at;
		return this.place({lang,start:a.at,end,digest:a.digest});
	}
	private notePlace(r: AnnotationRecord) {
		const p=r.bilingual;
		if (!p || p.digests[p.language] !== this.doc.files[p.language].digest) return;
		return this.place({lang:p.language,...p.selection,digest:this.doc.files[p.language].revision.digest});
	}
	private mount(place: Place) {
		let m=this.mounts.get(place.element);
		if(!m){m=document.createElement("aside");m.className="rar-inline-thread";place.element.after(m);this.mounts.set(place.element,m);}
		return m;
	}
	private focus(place: Place, select=false) {
		const {lang,start,end}=place.passage;
		const range = select && end > start
			? revealMarkdownRange(place.element, this.doc.files[lang].text, place.blockStart, place.blockEnd, start, end)
			: undefined;
		if (range) {
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		this.reader.focusDiscussion(lang, place.element, range || undefined);
	}
	private remember(id:string) {
		this.opened=id;const s=this.session;
		if(s && s.ui.inlineBranchId!==id) void this.workspace.repository.transact(s.id,d=>{d.ui.inlineBranchId=id; d.lastOpenedAt=new Date().toISOString();}).catch(e=>new Notice(String(e)));
	}
	reveal(sessionId:string,nodeId:string):boolean {
		const s=this.session;if (!s || s.id!==sessionId) return false;
		const b=s.branches.find(b=>b.nodeIds.includes(nodeId)), origin=readingAnnotationOrigin(s,nodeId), place=origin && this.originPlace(origin);
		if (!b || !place) return false;
		this.composer=undefined;this.remember(b.id);this.index.open=false;this.render(true);this.focus(place);return true;
	}
	async composeSelection() {
		const selection=await this.annotations.captureSelection(), proof=selection.bilingual;
		if(!proof || this.signal.aborted) return;
		const place=this.place({lang:proof.language,...proof.selection,digest:this.doc.files[proof.language].revision.digest});
		if(!place) throw new Error("请在可定位的原文段落中划选");
		const record=await this.annotations.findAnnotationForSelection(selection);
		if(this.signal.aborted) return;
		const s=this.session, old=s?.branches.find(b=>record && b.annotation?.id===record.id);
		if(s && old && this.reveal(s.id,old.nodeIds[old.nodeIds.length-1]))return;
		this.composer={place,selection,value:""};this.opened="";this.render(true);this.mount(place).querySelector("textarea")?.focus();
	}
	private render(force=false) {
		if(this.signal.aborted)return;
		const s=this.session;
		const signature=JSON.stringify(s?.nodes.map(n=>[n.id,n.status,n.title,n.content.length,n.error]));
		if(!force && signature===this.signature)return;
		this.signature=signature || "";this.renderer.unload();this.renderer=new Component();this.renderer.load();
		for(const m of this.mounts.values())m.remove();this.mounts.clear();this.links.empty();
		const indexed=new Set<string>();
		for(const branch of s?.branches || []) {
			const first=s!.nodes.find(n=>n.id===branch.nodeIds[0]);if(!first)continue;
			const origin=readingAnnotationOrigin(s!,first.id),place=origin && this.originPlace(origin);
			if(!place || !origin)continue;
			indexed.add(origin.id);
			const label=first.question||first.title;
			const open=()=>this.reveal(s!.id,branch.nodeIds[branch.nodeIds.length-1]);
			const link=button(this.links,label,open);if(!branch.annotation)link.classList.add("is-child");
			if (this.opened === branch.id) link.setAttribute("aria-current", "true");
			if(branch.annotation)button(this.mount(place),label+" · "+branch.nodeIds.length+" 轮",open,"rar-thread-chip");
			if(this.opened===branch.id)this.renderThread(this.mount(place),place,s!,branch,origin);
		}
		if(!this.links.children.length)this.links.createSpan({text:"本篇还没有讨论分支"});
		for(const r of this.notes) {
			const place=this.notePlace(r);if(!place || indexed.has(r.id) && !r.manualText && !r.aiText)continue;
			const b=button(this.mount(place),"批注 · "+annotationDisplayText(r.selectedText).slice(0,22),()=>this.edit(r,b.getBoundingClientRect()),"rar-note-chip");
		}
		if(this.composer)this.renderForm(this.mount(this.composer.place),this.composer);
	}
	private renderThread(m:HTMLElement,place:Place,s:ReadingSession,b:ReadingBranch,origin:AnnotationOrigin) {
		const body=m.createDiv({cls:"rar-discussion"}); body.dataset.branchId=b.id;
		body.createEl("blockquote",{text:annotationDisplayText(origin.selected)});
		for(const id of b.nodeIds){
			const n=s.nodes.find(n=>n.id===id)!;body.createEl("strong",{text:n.question});
			if(n.status==="done") {
				void MarkdownRenderer.render(this.reader.options.app,safeReadingMarkdown(n.content,n.evidence.map(e=>e.id)),body.createDiv(),s.source.path,this.renderer);
				if(n.evidence.length){const d=body.createEl("details");d.createEl("summary",{text:"原文依据 · "+n.evidence.length});for(const e of n.evidence)d.createEl("p",{text:e.label+" · "+e.text});}
				button(body,"另开子分支",()=>this.composeTurn(place,n.id,true),"rar-thread-action");
			} else {
				body.createEl("p",{text:n.error || "Codex 正在阅读原文…",attr:{role:"status"}});
				if(n.status==="failed" || n.status==="interrupted")button(body,"重试",()=>void this.workspace.generate(s.id,n.id).catch(e=>new Notice(String(e))));
				else button(body,"停止",()=>this.workspace.stop(s.id,n.id));
			}
		}
		const tail=b.nodeIds[b.nodeIds.length-1],actions=body.createDiv({cls:"rar-thread-actions"});
		if(s.nodes.find(n=>n.id===tail)?.status==="done")button(actions,"继续追问",()=>this.composeTurn(place,tail,false));
		if(b.parentNodeId && s.branches.some(x=>x.nodeIds.includes(b.parentNodeId!)))button(actions,"上一级讨论",()=>this.reveal(s.id,b.parentNodeId!));
		for(const child of s.branches.filter(x=>x.parentNodeId && b.nodeIds.includes(x.parentNodeId)))button(actions,"↳ "+s.nodes.find(n=>n.id===child.nodeIds[0])!.question,()=>this.reveal(s.id,child.nodeIds[child.nodeIds.length-1]));
		button(actions,"收起，回原句",()=>{this.composer=undefined;this.remember("");this.render(true);this.focus(place,true);});
	}
	private composeTurn(place:Place,parent:string,child:boolean) {
		this.composer={place,parent,child,value:""};this.render(true);this.mount(place).querySelector("textarea")?.focus();
	}
	private renderForm(m:HTMLElement,f:Composer) {
		const form=m.createEl("form",{cls:"rar-discussion-form"});
		if(f.selection)form.createEl("blockquote",{text:annotationDisplayText(f.selection.selectedText)});
		const input=form.createEl("textarea",{attr:{"aria-label":"分支问题",placeholder:f.child?"从这个回答展开什么新问题？":"你想弄清什么？",maxlength:"4000",rows:"2"}});
		input.value=f.value;input.oninput=()=>{f.value=input.value;};input.disabled=this.busy;
		form.createEl("button",{text:f.parent?(f.child?"创建子分支":"发送追问"):"创建分支",attr:{type:"submit"}}).disabled=this.busy;
		button(form,"取消",()=>{if(!this.busy){this.composer=undefined;this.render(true);}});
		form.onsubmit=e=>{e.preventDefault();if(!this.busy && f.value.trim())void this.send(f);};
	}
	private async send(f:Composer) {
		this.busy=true;this.render(true);
		try {
			if(this.reader.stale)throw new Error("原文已变化，请重新打开核对");
			let target:{sessionId:string;nodeId:string};
			if(f.selection){
				const record=await this.annotations.findAnnotationForSelection(f.selection) || await this.annotations.saveSelectionAnnotation(f.selection,{manualText:""},true);
				this.signal.throwIfAborted();
				target=await this.annotations.attachForReading(record,f.value,record.aiText,this.signal,record.manualText);
			}else{
				const s=this.session!;const parent=s.nodes.find(n=>n.id===f.parent)!;
				target={sessionId:s.id,nodeId:await this.workspace.ask(s.id,parent.id,f.value,f.child?undefined:parent.branchId!)};
			}
			if(!this.signal.aborted)this.reveal(target.sessionId,target.nodeId);
		}catch(e){if(!this.signal.aborted)new Notice(String(e));}finally{this.busy=false;if(!this.signal.aborted)this.render(true);}
	}
}
