import { ItemView, MarkdownRenderer, Notice, type Component, type App, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { CLIPPER_PREFIX, requireClipper } from "../library/clipper";
import { loadBilingualDocument, parseBilingualMarkdown, imagePath } from "../reader/bilingual-document";
import { markdownImagePattern } from "../reader/markdown-images";
import { BilingualReader, bilingualRenderMarkdown } from "./bilingual-reader";
import type { BilingualReadingState } from "../reader/bilingual-position";
import type { AnnotationRecord } from "../annotations/types";
import { verifyBilingual } from "../annotations/bilingual";
import { excerptMatches } from "../annotations/excerpt";

export const CLIPPER_READER = "paper-clipper-local-reader";
export interface ClipProgress { title: string; date: string; position?: BilingualReadingState; top?: number; digest: string; section: string; days: string[]; visited?: {lang: "en" | "zh-CN"; digest: string; block: string}[]; }
interface Host {
	settings: { clipperProgress: Record<string, ClipProgress>; mineruReaderBilingualLinked: boolean; mineruReaderBilingualSplitRatio: number };
	saveSettings(): Promise<void>;
	openSelectionAnnotation(): Promise<void>;
	startClippedReading(path: string): Promise<void>;
}
export async function renderClip(app: App, markdown: string, article: HTMLElement, source: string, owner: Component, signal: AbortSignal): Promise<void> {
	const directory = requireClipper(app), assets: Array<{ relative: string; alt: string }> = [];
	const display = markdown.replace(markdownImagePattern(), (_match: string, alt: string, angle: string, raw: string, html: string) => {
		assets.push({ relative: angle || raw || html, alt: alt || "论文配图" });
		return '<span data-clip-figure="' + (assets.length - 1) + '"></span>';
	});
	await MarkdownRenderer.render(app, display, article, source, owner);
	for (const marker of article.querySelectorAll<HTMLElement>("[data-clip-figure]")) {
		signal.throwIfAborted();
		const asset = assets[Number(marker.dataset.clipFigure)];
		if (!asset) continue;
		try {
			const name = imagePath(source.slice(0, source.lastIndexOf("/")), asset.relative);
			const bytes = await directory.read(name, 12 * 1024 * 1024);
			if (!bytes) throw new Error("图片缺失");
			signal.throwIfAborted();
			const ext = name.split(".").pop()!.toLowerCase(), type = "image/" + (ext === "jpg" ? "jpeg" : ext);
			const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type }));
			signal.addEventListener("abort", () => URL.revokeObjectURL(url), { once: true });
			marker.createEl("img", { attr: { src: url, alt: asset.alt } });
		} catch (error) { signal.throwIfAborted(); marker.setText(asset.alt + " · " + String(error)); }
	}
}

export class ClipperReaderView extends ItemView {
	key = "";
	private opened = false;
	private active?: AbortController;
	private bilingual?: BilingualReader;
	private timer?: number;
	private heading = "外部论文";
	private mono?: HTMLElement;
	constructor(leaf: WorkspaceLeaf, private readonly plugin: Host) { super(leaf); }
	getViewType(): string { return CLIPPER_READER; }
	getDisplayText(): string { return this.heading; }
	getIcon(): string { return "book-open"; }
	getState(): Record<string, unknown> { return { key: this.key }; }
	async setState(raw: unknown, _result: ViewStateResult): Promise<void> {
		const key = (raw as { key?: string })?.key;
		if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return;
		this.key = key; if (this.opened) await this.renderPaper();
	}
	async onOpen(): Promise<void> { this.opened = true; if (this.key) await this.renderPaper(); }
	async onClose(): Promise<void> { this.opened = false; this.stop(); if (this.timer) { window.clearTimeout(this.timer); await this.plugin.saveSettings(); } }
	private stop(): void { this.active?.abort(); if (this.bilingual) this.removeChild(this.bilingual); this.bilingual = undefined; this.mono = undefined; }
	private track(title: string, digest: string, state?: BilingualReadingState, top?: number, section = "正文", monoBlock?: string): void {
		const date = new Date(), day = [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
		const history = this.plugin.settings.clipperProgress, old = history[this.key];
		const visit = state ? {lang:state.active,digest:state.digests[state.active],block:state.positions[state.active].blockId} : monoBlock ? {lang:"en" as const,digest,block:monoBlock} : undefined;
		const seen = old?.visited || [], visited = visit ? [...seen.filter(v=>v.lang!==visit.lang || v.digest!==visit.digest || v.block!==visit.block),visit].slice(-500) : seen;
		history[this.key] = { ...(old?.digest === digest ? old : {}), title, digest, visited, date: date.toISOString(), section, days: [...new Set([...(old?.days || []), day])].slice(-45), ...(state ? { position: state } : {}), ...(top !== undefined ? { top } : {}) };
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => { this.timer = undefined; void this.plugin.saveSettings().catch(e => new Notice(String(e))); }, 400);
	}
	private async renderPaper(): Promise<void> {
		this.stop(); const ctl = this.active = new AbortController(), signal = ctl.signal;
		const host = this.contentEl; host.empty(); host.removeClass("rar-clip-paired");
		try {
			const dir = requireClipper(this.app), paper = await dir.paper(this.key); signal.throwIfAborted(); this.heading = paper.title;
			const source = CLIPPER_PREFIX + paper.key + "/paper.md", saved = this.plugin.settings.clipperProgress[this.key];
			const header = host.createDiv("rar-clip-header");
			header.createEl("h2", { text: paper.title, attr: { title: paper.title } });
			header.createEl("button", { text: "AI 带读全文" }).onclick = () => void this.plugin.startClippedReading(source).catch(e => new Notice(String(e)));
			if (paper.bilingual) {
				const pairedHost = host.createDiv();
				try {
					const doc = await loadBilingualDocument(dir, source, signal); signal.throwIfAborted();
					host.addClass("rar-clip-paired");
					const b = new BilingualReader({ app: this.app, host: pairedHost, document: doc, signal, ordinary: () => {}, hideOrdinary: true,
						annotate: () => this.plugin.openSelectionAnnotation(), outlineLeaf: this.leaf, state: saved?.position, defaultLinked: this.plugin.settings.mineruReaderBilingualLinked,
						ratio: this.plugin.settings.mineruReaderBilingualSplitRatio, renderMarkdown: renderClip, onState: state => {
							const file = doc.files[state.active], block = file.blocks.find(x => x.id === state.positions[state.active].blockId);
							const h = block && file.blocks.find(x => x.chapter === block.chapter && x.kind === "heading");
							this.track(paper.title, paper.englishDigest, state, undefined, h ? file.text.slice(h.start,h.end).replace(/^#+\s*/, "").trim() : "正文");
						} });
					this.bilingual = b; this.addChild(b); await b.render(); return;
				} catch (error) {
					signal.throwIfAborted();
					if (this.bilingual) this.removeChild(this.bilingual);
					this.bilingual = undefined;
					pairedHost.remove();
					host.removeClass("rar-clip-paired");
					host.createEl("p", { text: "对照资料暂不可用，已打开英文原文。 " + String(error) });
				}
			}
			const text = await dir.text(source); signal.throwIfAborted();
			const wrapper = host.createDiv("markdown-reading-view"), article = wrapper.createEl("article", { cls: "markdown-rendered" });
			this.mono = article;
			await renderClip(this.app, bilingualRenderMarkdown({text,...parseBilingualMarkdown(text)}), article, source, this, signal); signal.throwIfAborted();
			article.dataset.agentAnnotationSource = source;
			const top = saved?.digest === paper.englishDigest ? saved.top || 0 : 0; host.scrollTop = top;
			const remember = () => { const edge=host.getBoundingClientRect().top+60; const headings=Array.from(article.querySelectorAll("h1,h2,h3,h4")).filter(h=>h.getBoundingClientRect().top<=edge); this.track(paper.title,paper.englishDigest,undefined,host.scrollTop,headings.pop()?.textContent || "正文",Array.from(article.querySelectorAll<HTMLElement>("[data-bilingual-anchor]")).filter(el=>el.getBoundingClientRect().top<=edge).pop()?.dataset.bilingualAnchor); };
			host.addEventListener("scroll", remember, { signal, passive: true }); remember();
		} catch (error) { if (!signal.aborted) host.createEl("p", { text: String(error) }); }
	}
	async revealOffset(offset: number, lang: "en" | "zh-CN" = "en"): Promise<void> {
		const source = CLIPPER_PREFIX + this.key + (lang === "en" ? "/paper.md" : "/paper.zh-CN.md");
		const text = await requireClipper(this.app).text(source);
		const blocks = parseBilingualMarkdown(text).blocks;
		const block = blocks.find(b => offset >= b.start && offset < b.end);
		const article = this.bilingual?.panes.get(lang)?.article ?? (lang === "en" ? this.mono : undefined);
		const el = block && article?.querySelector('[data-bilingual-anchor="' + block.id + '"]');
		if (!el) throw new Error("不能确认这个证据段落的位置，请刷新后核对");
		el.scrollIntoView({ block: "center" });
	}
	async reveal(record: AnnotationRecord): Promise<void> {
		if (this.bilingual && record.bilingual) { await verifyBilingual(this.app, record); this.bilingual.reveal(record); return; }
		const text = await requireClipper(this.app).text(record.sourcePath);
		if (!record.excerpt || !excerptMatches(record,text) || !record.sourceAnchor) throw new Error("历史选段的来源版本已变化，请核对");
		const article = this.mono || this.bilingual?.panes.get("en")?.article;
		if (!article) throw new Error("原文未就绪");
		const block = parseBilingualMarkdown(text).blocks.find(b => b.start <= record.sourceAnchor!.start && record.sourceAnchor!.end <= b.end);
		if (!block) throw new Error("无法定位原文段落");
		const elements = article.querySelectorAll("p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6");
		const hits = Array.from(elements).filter(el => (el.textContent || "").includes(record.selectedText));
		if (hits.length !== 1) { await this.revealOffset(record.sourceAnchor.start); return; }
		hits[0].scrollIntoView({block:"center"});
	}
}
