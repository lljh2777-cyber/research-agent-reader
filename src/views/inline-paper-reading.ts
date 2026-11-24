import { renderReadingCitations } from "./reading-citations";
import { Component, MarkdownRenderer, Notice } from "obsidian";
import { type AnnotationService, readAnnotationRecords } from "../annotations/annotation-service";
import type { AnnotationRecord, AnnotationSelection } from "../annotations/types";
import { annotationDisplayText, revealMarkdownRange } from "../annotations/markdown-selection";
import type { BilingualLanguage } from "../reader/bilingual-document";
import { readingAnnotationOrigin } from "../reading/navigation";
import { safeReadingMarkdown } from "../reading/export";
import type { AnnotationOrigin, ReadingBranch, ReadingNode, ReadingSession } from "../reading/types";
import type { ReadingWorkspaceService } from "../reading/workspace";
import type { BilingualReader } from "./bilingual-reader";

import { PaperDiscussionMap, type MapPassage } from "./paper-discussion-map";

import { conclusionTitle, guideParent, GuideEvidenceIndex, MAIN_GUIDE, type GuideTarget } from "../reading/inline-guide";

interface Passage { lang: BilingualLanguage; start: number; end: number; digest: string }
interface Place { passage: Passage; element: HTMLElement; blockStart: number; blockEnd: number }
type Composer = { place?: Place; selection?: AnnotationSelection; parent?: string; child?: boolean; evidenceLabel?: string; target?: ReadingNode["paperTarget"]; value: string };
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
	private selected = "";
	private readonly profileSelect: HTMLSelectElement;
	private readonly guideIndex: GuideEvidenceIndex;
	private readonly guideFallback: HTMLElement;
	private guideLinks = new Map<string, GuideTarget[]>();
	private inspecting?: {nodeId: string; link: GuideTarget};
	private guideStarting = false;
	private readonly map: PaperDiscussionMap;
	private readonly origins = new Map<string, Place>();
	private readonly turns = new Map<string, HTMLElement>();
	private answerLayouts: Promise<void>[] = [];
	private renderer = new Component();
	constructor(readonly reader: BilingualReader, toolbar: HTMLElement, private annotations: AnnotationService,
		private workspace: ReadingWorkspaceService, private canonical: () => Promise<{ key: string; aliases: string[] }>,
		private edit: (record: AnnotationRecord, rect: DOMRect) => void,
		private models: { profiles(): {id:string;name:string;model:string}[]; resolve(id?:string):string }) {
		this.profileSelect = toolbar.createEl("select",{attr:{"aria-label":"本篇论文的阅读模型",title:"本篇论文后续回答使用的 API"}});
		this.profileSelect.createEl("option",{value:"",text:"选择阅读模型"});
		for (const profile of models.profiles()) this.profileSelect.createEl("option",{value:profile.id,text:profile.name+" · "+profile.model});
		this.profileSelect.onchange = () => { void this.changeModel().catch(e=>new Notice(String(e))); };

		const body = reader.options.host.querySelector<HTMLElement>(".agent-bilingual-workspace")!;
		this.guideIndex = new GuideEvidenceIndex(this.doc.files.en);
		this.guideFallback = document.createElement("div");
		this.guideFallback.className = "rar-guide-fallback";
		toolbar.after(this.guideFallback);
		this.map = new PaperDiscussionMap(toolbar, body, (id, kind, link) => {
			if (link) { this.showEvidence(id, link); return; }
			if (kind === "guide") { void this.openGuide().catch(error => this.showGuideError(error)); return; }
			if (kind === "turn" && this.session) this.reveal(this.session.id, id);
			if (kind === "passage") this.revealPassage(id);
		});
		this.renderer.load();
		this.indexTargets();
	}
	private async changeModel() {
		const profileId = this.profileSelect.value;
		if (!profileId || !this.key || this.reader.stale) return;
		const {id} = this.session || await this.workspace.open("article",this.key,profileId,"");
		await (await this.workspace.document(id)).verify();
		if (this.session?.id !== id) throw new Error("论文版本已变化，请重新核对正文");
		await this.workspace.repository.transact(id,draft=>{draft.backend=profileId; draft.model="";});
	}
	get doc() { return this.reader.options.document; }
	private get signal() { return this.reader.options.signal; }
	private get session() {
		const digest = this.doc.files.en.revision.digest;
		return [...this.workspace.repository.sessions.values()].filter(s => !s.demo && s.purpose !== "test" && !s.archived && s.source.path === this.key &&
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
		const clean = () => { this.renderer.unload(); this.profileSelect.remove(); for (const mount of this.mounts.values()) mount.remove(); this.map.dispose(); this.guideFallback.remove(); };
		this.signal.addEventListener("abort",clean,{once:true});
		const { key, aliases } = await this.canonical();
		this.key = key;
		this.paths = [this.doc.files.en.path, this.doc.files["zh-CN"].path, key, key.replace(/\/paper\.md$/, "/paper.zh-CN.md"), ...aliases];
		await this.workspace.ready();
		if (this.signal.aborted) return;
		const current = this.session;
		this.profileSelect.value = this.models.resolve(current?.backend);
		this.opened = current?.ui.inlineBranchId || "";
		const branch = current?.branches.find(b => b.id === this.opened);
		this.selected = current?.ui.inlineFocusId || branch?.nodeIds[branch.nodeIds.length - 1] || current?.ui.selectedId || "";
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
		this.render(true);
		await loadNotes();
		if (current?.ui.inlineFocusId && this.selected === current.ui.inlineFocusId) {
			const resumeId = this.selected;
			this.reader.restoreDiscussion(() => {
				if (this.selected === resumeId && !this.inspecting && !this.composer && !this.reader.stale && this.turns.has(resumeId)) this.reveal(current.id, resumeId);
			});
		}
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
		if (!file.text.startsWith(a.selected, a.at) && this.doc.files.en.text.startsWith(a.selected, a.englishStart)) {
			return this.place({lang:"en",start:a.englishStart,end:a.englishStart+a.selected.length,digest:a.englishDigest});
		}
		const end=file.text.startsWith(a.selected,a.at)?a.at+a.selected.length:a.at;
		return this.place({lang,start:a.at,end,digest:a.digest});
	}
	private notePlace(r: AnnotationRecord) {
		const p=r.bilingual;
		if (!p || p.digests[p.language] !== this.doc.files[p.language].digest) return;
		return this.place({lang:p.language,...p.selection,digest:this.doc.files[p.language].revision.digest});
	}
	private mount(place?: Place) {
		if (!place) return this.guideFallback;
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
		if (select && !range) new Notice("已定位段落，无法唯一高亮原选句");
		this.reader.focusDiscussion(lang, place.element, range || undefined);
	}
	private remember(branchId: string, focusId: string) {
		this.opened = branchId;
		this.selected = focusId;
		const s = this.session;
		if (!s || (s.ui.inlineBranchId === branchId && s.ui.inlineFocusId === focusId)) return;
		void this.workspace.repository.transact(s.id, draft => {
			draft.ui.inlineBranchId = branchId;
			draft.ui.inlineFocusId = focusId;
			draft.lastOpenedAt = new Date().toISOString();
		}).catch(e => new Notice(String(e)));
	}
	private revealPassage(id: string) {
		const place = this.origins.get(id);
		if (!place || this.reader.stale) { new Notice("原文已变化，请重新打开核对"); return; }
		this.composer = undefined;
		this.inspecting = undefined;
		this.remember("", id);
		this.render(true);
		this.focus(place, true);
	}
	private evidencePlace(link: GuideTarget): Place | undefined {
		return this.place({lang:"en", start:link.start, end:link.end, digest:this.doc.files.en.revision.digest});
	}
	private mainPlace(id: string) {
		const links = this.guideLinks.get(id) || [];
		for (const link of [...links].sort((a,b) => Number(b.kind === "text") - Number(a.kind === "text"))) {
			const en = this.evidencePlace(link);
			if (!en) continue;
			const zh = this.doc.syncAvailable && this.doc.pairs.find(p => p.en.id === link.block.id)?.["zh-CN"];
			return zh && this.place({lang:"zh-CN",start:zh.start,end:zh.end,digest:this.doc.files["zh-CN"].revision.digest}) || en;
		}
	}
	private showGuideError(error: unknown): void {
		if (this.workspace.repository.isCloseError(error, this.workspace.closeReason)) return;
		new Notice(String(error));
	}
	async openGuide() {
		if (this.reader.stale || !this.key) throw new Error("请重新打开论文后开始带读");
		const s = this.session;
		const id = s && (guideParent(s,this.selected)?.id || s.mainIds[s.mainIds.length-1]);
		if (s && id) this.reveal(s.id,id);
		else await this.advanceGuide();
	}
	private async advanceGuide(previous?: string) {
		if (this.guideStarting || this.reader.stale) return;
		this.guideStarting = true;
		try {
			const {id} = await this.workspace.open("article", this.key, this.profileSelect.value, "");
			if (this.session?.id !== id) throw new Error("论文版本已变化，请核对正文后继续");
			let started = "";
			await this.workspace.advance(id, {expectedParentId:previous, prepared:async nodeId => {
				started = nodeId;
				if (!this.signal.aborted) this.reveal(id,nodeId);
			}});
			if (!this.signal.aborted && this.selected === started) this.reveal(id,started);
		} finally { this.guideStarting = false; }
	}
	private showEvidence(nodeId: string, link: GuideTarget) {
		const place = this.evidencePlace(link);
		if (!place) { new Notice("无法核对这条原文位置"); return; }
		this.composer = undefined;
		this.remember(this.session?.nodes.find(n=>n.id===nodeId)?.branchId || "",nodeId);
		this.inspecting = {nodeId,link};
		this.render(true);
		const target = place.element;
		target.addClass("rar-guide-highlight");
		if (link.kind === "text") this.focus(place,true);
		else this.reader.focusDiscussion("en",target);
	}
	reveal(sessionId:string,nodeId:string):boolean {
		const s=this.session;if (!s || s.id!==sessionId) return false;
		const b = s.branches.find(b=>b.nodeIds.includes(nodeId));
		const origin = readingAnnotationOrigin(s,nodeId);
		const main = guideParent(s,nodeId);
		const place = origin ? this.originPlace(origin) : main && this.mainPlace(main.id);
		if (!main && (!b || !place)) return false;
		this.inspecting = undefined;
		this.composer = undefined;
		this.remember(b?.id || "", nodeId);
		this.render(true);
		const focusTurn = () => {
			const turn = this.turns.get(nodeId);
			if (this.inspecting || this.selected !== nodeId || this.reader.stale || !turn?.isConnected) return;
			if (place) this.reader.focusDiscussion(place.passage.lang, turn);
			else turn.scrollIntoView({block:"nearest"});
		};
		this.turns.get(nodeId)?.focus({preventScroll: true});
		focusTurn();
		void Promise.all(this.answerLayouts).then(() => requestAnimationFrame(focusTurn));
		return true;
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
		this.inspecting=undefined;this.composer={place,selection,value:""};this.opened="";this.render(true);this.mount(place).querySelector("textarea")?.focus();
	}
	private render(force=false) {
		if(this.signal.aborted)return;
		const s=this.session;
		const signature=JSON.stringify(s?.nodes.map(n=>[n.id,n.status,n.title,n.content.length,n.error]));
		if(!force && signature===this.signature)return;
		this.signature=signature || "";this.renderer.unload();this.renderer=new Component();this.renderer.load();
		for(const m of this.mounts.values())m.remove();this.mounts.clear();
		this.guideFallback.empty();
		for (const pane of this.reader.panes.values()) pane.article.querySelector(".rar-guide-highlight")?.classList.remove("rar-guide-highlight");
		this.origins.clear();
		this.turns.clear();
		this.answerLayouts = [];
		const passages: MapPassage[] = [];
		for (const id of s?.mainIds || []) {
			const node = s!.nodes.find(n => n.id === id)!;
			if (node.status === "done" && !this.guideLinks.has(id)) {
				this.guideLinks.set(id,this.guideIndex.forTurn(node, this.paths).filter(link => this.evidencePlace(link)));
			}
			const place = this.mainPlace(id);
			if (place) button(this.mount(place),"带读 · "+node.title,()=>this.reveal(s!.id,id),"rar-thread-chip");
			if (this.selected === id && !this.opened && !this.inspecting) this.renderThread(this.mount(place),place,s!,undefined,undefined,node);
		}
		const indexed=new Set<string>();
		for(const branch of s?.branches || []) {
			const first=s!.nodes.find(n=>n.id===branch.nodeIds[0]);if(!first)continue;
			const origin=readingAnnotationOrigin(s!,first.id),place=origin && this.originPlace(origin);
			if (!origin) {
				const main = guideParent(s!,first.id);
				if (main && this.opened === branch.id) {
					const anchor = this.mainPlace(main.id);
					this.renderThread(this.mount(anchor),anchor,s!,branch,undefined,main);
				}
				continue;
			}
			if (!place) continue;
			indexed.add(origin.id);
			const label=first.question||first.title;
			const open=()=>this.reveal(s!.id,branch.nodeIds[branch.nodeIds.length-1]);
			if (branch.annotation) {
				this.origins.set(origin.id, place);
				const file = this.doc.files[place.passage.lang];
				const block = file.blocks.find(b => b.start === place.blockStart);
				const heading = block && file.blocks.find(b => b.kind === "heading" && b.chapter === block.chapter);
				const chapter = heading ? annotationDisplayText(file.text.slice(heading.start, heading.end)).replace(/^#+\s*/, "").trim() : "";
				passages.push({id: origin.id, quote: annotationDisplayText(origin.selected), chapter: chapter || "正文", order: origin.englishStart});
				button(this.mount(place),label+" · "+branch.nodeIds.length+" 轮",open,"rar-thread-chip");
			}
			if(this.opened===branch.id)this.renderThread(this.mount(place),place,s!,branch,origin);
		}
		this.map.update(s, passages, this.selected, this.guideLinks);
		if (s && this.inspecting && this.inspecting.nodeId === this.selected) {
			const {nodeId,link} = this.inspecting, place = this.evidencePlace(link);
			if (place) {
				place.element.addClass("rar-guide-highlight");
				const actions = this.guideFallback.createDiv({cls:"rar-thread-actions rar-evidence-actions"});
				button(actions,"回到这一轮",() => this.reveal(s.id,nodeId));
				button(actions,"从这轮提问",() => this.composeTurn(place,nodeId,true,link));
			}
		}
		for(const r of this.notes) {
			const place=this.notePlace(r);if(!place || indexed.has(r.id) && !r.manualText && !r.aiText)continue;
			const b=button(this.mount(place),"批注 · "+annotationDisplayText(r.selectedText).slice(0,22),()=>this.edit(r,b.getBoundingClientRect()),"rar-note-chip");
		}
		if(this.composer)this.renderForm(this.mount(this.composer.place),this.composer);
	}
	private renderThread(m:HTMLElement,place:Place | undefined,s:ReadingSession,b?:ReadingBranch,origin?:AnnotationOrigin,main?:ReadingNode) {
		const body=m.createDiv({cls:"rar-discussion"}); if (b) body.dataset.branchId=b.id;
		if (origin) body.createEl("blockquote",{text:annotationDisplayText(origin.selected)});
		const ids = b?.nodeIds || [main!.id];
		for(const id of ids){
			const n=s.nodes.find(n=>n.id===id)!;
			const heading = body.createEl("strong",{text:b ? n.question : "第 "+(s.mainIds.indexOf(id)+1)+" 轮 · "+conclusionTitle(n)});
			heading.dataset.turnId = id;
			heading.tabIndex = -1;
			if (this.selected === id) heading.classList.add("is-current-turn");
			this.turns.set(id, heading);
			if(n.status==="done") {
				const links = this.guideLinks.get(id) || this.guideIndex.forTurn(n,this.paths).filter(link=>this.evidencePlace(link));
				const answer = body.createDiv();
				const ids = n.evidence.map(e => e.id);
				this.answerLayouts.push(MarkdownRenderer.render(this.reader.options.app, safeReadingMarkdown(n.content,ids), answer, s.source.path, this.renderer)
					.then(() => renderReadingCitations(answer, ids, n.content, (group, evidenceId) => {
						const e = n.evidence.find(item => item.id === evidenceId)!;
						if (e.kind !== "paper" || e.start === undefined || !this.paths.includes(e.path) || !this.doc.files.en.text.startsWith(e.text,e.start)) return false;
						const link = links.find(l => l.start >= e.start! && l.start < e.start! + e.text.length && (e.asset ? l.kind === "figure" && l.block.kind === "image" : l.kind !== "figure"));
						if (!link) return false;
						const label = link.figureNumber || (link.kind === "figure" ? "原图" : link.kind === "table" ? "表格" : "原文");
						const control = button(group, label, () => this.showEvidence(id,link));
						control.title = link.label;
						return true;
					}))
					.catch(error => { if (!this.signal.aborted) new Notice(String(error)); }));
				{
					if (!links.length) body.createEl("p",{text:"本轮没有可核对的正文位置。"});
					for (const link of links) button(body,(link.kind === "text" ? "原文" : link.kind === "figure" ? "图" : "表")+" · "+link.label.slice(0,70),()=>this.showEvidence(id,link),"rar-guide-link");
				}
				button(body,b ? "另开子分支" : "从这轮提问",()=>this.composeTurn(place,n.id,true),"rar-thread-action");
			} else {
				body.createEl("p",{text:n.error || "正在读取本文证据…",attr:{role:"status"}});
				if(n.status==="failed" || n.status==="interrupted")button(body,"重试",()=>void this.workspace.generate(s.id,n.id).catch(e=>new Notice(String(e))));
				else button(body,"停止",()=>this.workspace.stop(s.id,n.id));
			}
		}
		const actions=body.createDiv({cls:"rar-thread-actions"});
		if (!b) {
			const id = main!.id, next = s.mainIds[s.mainIds.indexOf(id)+1];
			if (next) button(actions,"下一轮",()=>this.reveal(s.id,next));
			else if (main!.status === "done" && !s.completed) button(actions,"继续主线",()=>void this.advanceGuide(id).catch(error => this.showGuideError(error)));
			for (const child of s.branches.filter(x=>x.parentNodeId===id && !x.annotation)) {
				const first = s.nodes.find(n=>n.id===child.nodeIds[0]);
				if (first) button(actions,"↳ "+first.question,()=>this.reveal(s.id,first.id));
			}
			return;
		}
		const tail=b.nodeIds[b.nodeIds.length-1];
		if(s.nodes.find(n=>n.id===tail)?.status==="done")button(actions,"继续追问",()=>this.composeTurn(place,tail,false));
		if(b.parentNodeId && s.branches.some(x=>x.nodeIds.includes(b.parentNodeId!)))button(actions,"上一级讨论",()=>this.reveal(s.id,b.parentNodeId!));
		for(const child of s.branches.filter(x=>x.parentNodeId && b.nodeIds.includes(x.parentNodeId)))button(actions,"↳ "+s.nodes.find(n=>n.id===child.nodeIds[0])!.question,()=>this.reveal(s.id,child.nodeIds[child.nodeIds.length-1]));
		if (origin) button(actions,"收起，回原句",()=>this.revealPassage(origin.id));
		else if (main) button(actions,"回到主线",()=>this.reveal(s.id,main.id));
	}
	private composeTurn(place:Place | undefined,parent:string,child:boolean,link?: GuideTarget) {
		const evidenceLabel = link && ((link.kind === "figure" ? "图 · " : link.kind === "table" ? "表 · " : "原文 · ") + link.label.slice(0,100));
		const cited = link && this.session?.nodes.find(n=>n.id===parent)?.evidence.find(e=>e.start!==undefined && e.end!==undefined && e.start <= link.start && link.end <= e.end && (!!e.asset === (link.kind==="figure")));
		this.composer={place,parent,child,evidenceLabel,target:link ? {id:cited?.id || "",kind:link.kind,start:link.start,end:link.end,label:link.label}:undefined,value:""};this.render(true);this.mount(place).querySelector("textarea")?.focus();
	}
	private renderForm(m:HTMLElement,f:Composer) {
		const form=m.createEl("form",{cls:"rar-discussion-form"});
		if(f.evidenceLabel)form.createEl("blockquote",{text:f.evidenceLabel});
		if(f.selection)form.createEl("blockquote",{text:annotationDisplayText(f.selection.selectedText)});
		const input=form.createEl("textarea",{attr:{"aria-label":"分支问题",placeholder:f.child?"从这个回答展开什么新问题？":"你想弄清什么？",maxlength:String(4000 - (f.evidenceLabel ? f.evidenceLabel.length+1 : 0)),rows:"2"}});
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
				target=await this.annotations.attachForReading(record,f.value,record.aiText,this.signal,record.manualText,this.profileSelect.value);
			}else{
				const s=this.session!;const parent=s.nodes.find(n=>n.id===f.parent)!;
				const question = f.evidenceLabel ? f.evidenceLabel + "\n" + f.value : f.value;
				target={sessionId:s.id,nodeId:await this.workspace.ask(s.id,parent.id,question,f.child?undefined:parent.branchId!,undefined,false,f.target)};
			}
			if(!this.signal.aborted)this.reveal(target.sessionId,target.nodeId);
		}catch(e){if(!this.signal.aborted)new Notice(String(e));}finally{this.busy=false;if(!this.signal.aborted)this.render(true);}
	}
}
