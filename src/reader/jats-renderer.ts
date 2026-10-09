import { MarkdownRenderer,type App,type Component } from "obsidian";
import type { MineruReaderPackage } from "../mineru/types";
/** Only generated passive Markdown and a fixed DOM table vocabulary reach the view. */
export async function renderJatsBody(app:App,pkg:MineruReaderPackage,container:HTMLElement,component:Component,current:()=>boolean=()=>true) {
	const projection=pkg.document?.structured;if(!projection)throw new Error("JATS 缺少已验证的结构映射");
	const nav=container.createEl("select",{attr:{"aria-label":"JATS 章节导航"}});nav.createEl("option",{value:"",text:"跳转到章节或图表"});
	for(const b of projection.blocks)if(["section","figure","table"].includes(b.kind))nav.createEl("option",{value:b.id,text:b.label.slice(0,160)});
	nav.onchange=()=>container.querySelector<HTMLElement>(`#${CSS.escape(nav.value)}`)?.scrollIntoView({block:"start",behavior:"smooth"});
	for(const b of projection.blocks){
		if(!current())return;
		const el=container.createDiv({cls:"rar-jats-block",attr:{id:b.id,"data-jats-kind":b.kind,"data-jats-block":b.id}}),markdown=projection.markdown.slice(b.start,b.end);
		if(b.table){await MarkdownRenderer.render(app,markdown.split("\n\n")[0],el,pkg.articlePath,component);const table=el.createEl("table",{cls:"rar-jats-table"}),body=table.createEl("tbody");for(const row of b.table){const tr=body.createEl("tr");for(const cell of row)tr.createEl(cell.header?"th":"td",{text:cell.text,attr:{rowspan:String(cell.rowspan),colspan:String(cell.colspan)}});}}
		else await MarkdownRenderer.render(app,markdown.replace(/!\[[^\n]*?\]\(images\/[a-f0-9]{64}\.(?:png|jpg|webp)\)/g,""),el,pkg.articlePath,component);
		if(b.table&&markdown.trim().split("\n\n").length>2)await MarkdownRenderer.render(app,markdown.trim().split("\n\n").slice(2).join("\n\n"),el,pkg.articlePath,component);
		for(const visual of pkg.visuals.filter(v=>markdown.includes("]("+v.anchorAssetPath+")")))el.createEl("button",{text:"查看 "+visual.label,cls:"rar-jats-figure-link",attr:{"data-visual-id":visual.id}});
	}
	for(const link of container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))link.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();const id=link.getAttribute("href")!.slice(1);container.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({block:"center",behavior:"smooth"});});
}
