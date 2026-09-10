import { parseAcquisitionInput, type ResolvedIdentity } from "../fulltext/contracts";
import { canonicalTitle } from "../fulltext/identity-resolver";
import { bytesDigest, objectDigest } from "../papers/identity";
import { child,children,childNodes,descendants,localName,parseXml,xmlText,type XmlNode } from "./xml";

import { JATS_CONVERTER, JATS_LEGACY_CONVERTER, jatsConverter } from "./converter-version";
export { JATS_CONVERTER } from "./converter-version";
export interface JatsAsset {ref:string;path?:string;issue?:string;}
export interface JatsBlock {id:string;kind:"title"|"section"|"paragraph"|"list"|"figure"|"table"|"formula"|"reference";xmlPath:string;xmlId?:string;sourceStart:number;sourceEnd:number;start:number;end:number;label:string;level:number;caption?:string;table?:Array<Array<{text:string;header:boolean;rowspan:number;colspan:number}>>;}
export interface JatsProjection {schemaVersion:1;converter:string;xmlSha256:string;projectionId:string;title:string;authors:string[];identifiers:ResolvedIdentity["identifiers"];markdown:string;blocks:JatsBlock[];references:Array<{id:string;target:string}>;assets:JatsAsset[];issues:string[];bodyCheck:"usable"|"partial";}
const escape=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[\\`*_[\]{}()#+.!|~$-]/g,"\\$&");
const readableText=(n:XmlNode|undefined):string=>n?n.children.map(c=>typeof c==="string"?c:localName(c)==="sup"?"^("+readableText(c)+")":localName(c)==="sub"?"_("+readableText(c)+")":readableText(c)+(["p","title","label","name"].includes(localName(c))?" ":"")).join("").replace(/\s+/g," ").trim():"";
const authorName=(n:XmlNode):string=>{const name=child(n,"name");return name?[xmlText(child(name,"given-names")),xmlText(child(name,"surname"))].filter(Boolean).join(" "):xmlText(child(n,"collab"));};
export function jatsFront(root:XmlNode) {
	if(localName(root)!=="article")throw new Error("JATS 必须是单篇 article");
	const fronts=children(root,"front"),metas=fronts.length===1?children(fronts[0],"article-meta"):[];
	if(metas.length!==1)throw new Error("JATS 缺少唯一主文章元数据");const meta=metas[0],title=xmlText(child(child(meta,"title-group")||meta,"article-title"));if(!title||title.length>2000)throw new Error("JATS 缺少主文章标题");
	const identifiers:ResolvedIdentity["identifiers"]={};for(const node of children(meta,"article-id")){
		let kind=node.attrs["pub-id-type"];if(kind==="pmc")kind="pmcid";if(!["doi","pmid","pmcid"].includes(kind))continue;
		let value=xmlText(node);if(kind==="pmcid"&&!/^PMC/i.test(value))value="PMC"+value;
		const parsed=parseAcquisitionInput((kind==="doi"?"":kind+":")+value),key=kind as keyof typeof identifiers;
		if(parsed.kind!==kind||(identifiers[key]&&identifiers[key]!==parsed.value))throw new Error("JATS 主文章标识冲突");identifiers[key]=parsed.value;
	}
	const authors=children(meta,"contrib-group").flatMap(group=>children(group,"contrib").filter(n=>!n.attrs["contrib-type"]||n.attrs["contrib-type"]==="author").map(authorName)).filter(Boolean);
	return {meta,title,identifiers,authors};
}
export function graphicReferences(bytes:Uint8Array,converter=JATS_CONVERTER):string[] {
	jatsConverter(converter);
	const root=parseXml(bytes),refs=new Set<string>();
	const visit=(n:XmlNode)=>{if(["sub-article","response","supplementary-material"].includes(localName(n)))return;if(["graphic","inline-graphic"].includes(localName(n))){const ref=n.attrs["xlink:href"]||n.attrs.href;if(ref)refs.add(ref);}for(const c of childNodes(n))visit(c);};
	for(const abstract of children(jatsFront(root).meta,"abstract"))visit(abstract);for(const part of [child(root,"body"),child(root,"back"),...(converter===JATS_LEGACY_CONVERTER?[]:children(root,"floats-group"))])if(part)visit(part);return [...refs];
}
export function projectJats(bytes:Uint8Array,identity:ResolvedIdentity,assets:JatsAsset[],converter=JATS_CONVERTER):JatsProjection {
	jatsConverter(converter);
	const root=parseXml(bytes),front=jatsFront(root),xmlSha256=bytesDigest(bytes),issues:string[]=[],blocks:JatsBlock[]=[],refs:Array<{id:string;target:string}>=[];let markdown="";
	if(!Object.keys(front.identifiers).some(k=>front.identifiers[k as keyof typeof front.identifiers]===identity.identifiers[k as keyof typeof front.identifiers]))throw new Error("JATS 主文章缺少共同精确标识");
	for(const k of ["doi","pmid","pmcid"] as const)if(front.identifiers[k]&&identity.identifiers[k]&&front.identifiers[k]!==identity.identifiers[k])throw new Error("JATS 主文章与来源记录标识冲突");
	if(canonicalTitle(front.title)!==canonicalTitle(identity.title))throw new Error("JATS 主文章标题与来源记录不一致");
	if(!child(root,"body"))throw new Error("JATS 不含正文 body，未生成全文投影");
	const idMap=new Map<string,string>(),seen=new Set<string>();
	const blockId=(n:XmlNode)=>"b-"+objectDigest({xmlSha256,path:n.path}).slice(0,24);
	const indexIds=(n:XmlNode)=>{if(n.attrs.id){if(seen.has(n.attrs.id))throw new Error("JATS 源节点 ID 重复");seen.add(n.attrs.id);idMap.set(n.attrs.id,blockId(n));}for(const c of childNodes(n))indexIds(c);};indexIds(root);
	let bodyPartial=false;
	const issue=(s:string,body=true)=>{if(body)bodyPartial=true;if(!issues.includes(s)){if(issues.length>=200)throw new Error("JATS 缺口过多");issues.push(s.slice(0,500));}};
	const mathCommands=new Set("frac dfrac tfrac sqrt sum prod int iint iiint lim log ln exp sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh min max inf sup det dim gcd mod bmod pmod alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega times cdot div pm mp le leq ge geq ne neq approx sim simeq equiv propto in notin subset subseteq supset supseteq cup cap setminus forall exists partial nabla infty lto to mapsto rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow ldots cdots vdots ddots left right big Big bigg Bigg lvert rvert langle rangle lbrace rbrace vert Vert overline underline hat widehat bar vec dot ddot tilde widetilde text mathrm mathbf mathit mathsf mathtt mathcal mathbb boldsymbol operatorname overbrace underbrace overset underset begin end quad qquad thinspace enspace displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits hline cr backslash percent lt gt".split(" "));
	const formula=(n:XmlNode):string=>{const tex=descendants(n,"tex-math")[0];if(tex){const original=xmlText(tex),value=original.replace(/^\$+|\$+$/g,"");if(value.length>10000||/[`$<>]/.test(value)||[...value.matchAll(/\\([A-Za-z]+)/g)].some(m=>!mathCommands.has(m[1]))){issue("公式包含不支持的指令或分隔符："+n.path);return escape(original);}return "$"+value+"$";}
		const math=descendants(n,"math")[0];if(math){issue("MathML 以文本顺序展示，布局可能缺失："+n.path);return escape(xmlText(math));}issue("公式缺少可显示的 TeX / MathML："+n.path);return escape(xmlText(n));};
	const inline=(n:XmlNode):string=>n.children.map(c=>{
		if(typeof c==="string")return escape(c.replace(/\s+/g," "));const name=localName(c);
		if(name==="xref"){const target=idMap.get(c.attrs.rid||""),label=escape(xmlText(c));if(target){refs.push({id:blockId(n),target});return `[${label}](#${target})`;}issue("未解析的交叉引用："+(c.attrs.rid||c.path));return label;}
		if(name==="inline-formula"||name==="disp-formula"&&converter===JATS_LEGACY_CONVERTER)return formula(c);
		if(["graphic","inline-graphic","fig","table-wrap","list","boxed-text","disp-formula"].includes(name))return "";
		if(name==="sup")return "^("+inline(c)+")";if(name==="sub")return "_("+inline(c)+")";
		if(name==="p")return inline(c)+" ";
		if(name==="bold")return "**"+inline(c)+"**";if(name==="italic")return "*"+inline(c)+"*";
		if(["script","style","iframe","object"].includes(name)){issue("已跳过活动内容："+c.path);return "";}
		return inline(c);
	}).join("").trim();
	const graphic=(n:XmlNode):string=>{const ref=n.attrs["xlink:href"]||n.attrs.href||"",asset=assets.find(a=>a.ref===ref);if(asset?.path)return `![原文图像](${asset.path})`;issue(asset?.issue||"缺少同版本可显示图片："+ref,false);return `［图片未显示：${escape(ref)}］`;};
	const add=(n:XmlNode,kind:JatsBlock["kind"],text:string,label="",level=0,table?:JatsBlock["table"],caption?:string)=>{
		if(blocks.length>=20000||markdown.length+text.length>8*1024*1024)throw new Error("JATS 正文投影超过预算");
		const start=markdown.length;markdown+=text.trim()+"\n\n";blocks.push({id:blockId(n),kind,xmlPath:n.path,...(n.attrs.id?{xmlId:n.attrs.id}:{}),sourceStart:n.start,sourceEnd:n.end,start,end:markdown.length,label,level,...(table?{table}:{}),...(caption?{caption}:{})});
	};
	const walk=(n:XmlNode,level=1):void=>{
		const name=localName(n);
		if(name==="sec"||name==="abstract"){const title=child(n,"title"),label=xmlText(title)||(name==="abstract"?"Abstract":"Section");add(n,"section","#".repeat(Math.min(6,level+1))+" "+escape(label),label,level);for(const c of childNodes(n))if(c!==title)walk(c,level+1);return;}
		if(name==="p"){add(n,"paragraph",inline(n));nestedBlocks(n,level);return;}
		if(name==="list"){const rows=children(n,"list-item");add(n,"list",rows.map((c,i)=>(n.attrs["list-type"]==="order"?`${i+1}. `:"- ")+inline(c)).join("\n"));for(const row of rows)nestedBlocks(row,level);return;}
		if(name==="graphic"||name==="inline-graphic"){add(n,"figure",graphic(n),"图像");return;}
		if(name==="fig"){const label=xmlText(child(n,"label"))||"图像",caption=readableText(child(n,"caption"));add(n,"figure",[...descendants(n,"graphic").map(graphic),"**"+escape(label)+"** "+escape(caption)].join("\n\n"),label,0,undefined,caption);return;}
		if(name==="table-wrap"){
			const table=descendants(n,"table")[0],label=xmlText(child(n,"label"))||"Table",caption=readableText(child(n,"caption")),foot=readableText(child(n,"table-wrap-foot"));
			if(!table){issue("表格只有图像或缺少结构："+n.path);add(n,"table",escape(label+" "+caption)+"\n\n"+descendants(n,"graphic").map(graphic).join("\n\n"),label);return;}
			const rows=descendants(table,"tr").map(row=>childNodes(row).filter(c=>["th","td"].includes(localName(c))).map(c=>{
				const rowspan=Number(c.attrs.rowspan||1),colspan=Number(c.attrs.colspan||1);if(!Number.isInteger(rowspan)||!Number.isInteger(colspan)||rowspan<1||rowspan>100||colspan<1||colspan>100)throw new Error("表格跨度无效");
				if(descendants(c,"math").length||descendants(c,"tex-math").length)issue("表格内公式以文本顺序保留："+c.path);
				return {text:readableText(c),header:localName(c)==="th",rowspan,colspan};}));
			if(rows.length>500||rows.some(r=>r.length>100)||rows.flat().length>10000)throw new Error("JATS 表格过大");
			const simple=rows.length>0&&rows.every(r=>r.length===rows[0].length&&r.every(c=>c.rowspan===1&&c.colspan===1));
			const lines=simple?rows.map((r,i)=>"| "+r.map(c=>escape(c.text)).join(" | ")+" |"+(i===0?"\n| "+r.map(()=>"---").join(" | ")+" |":"")):["［复杂表格：阅读器保留跨行跨列；纯 Markdown 以下按行降级］",...rows.map(r=>r.map(c=>escape(c.text)+`（${c.rowspan}×${c.colspan}）`).join("；"))];
			add(n,"table",escape(label+" "+caption)+"\n\n"+lines.join("\n")+(foot?"\n\n"+escape(foot):""),label,0,simple?undefined:rows);return;
		}
		if(name==="disp-formula"){add(n,"formula",formula(n),xmlText(child(n,"label")));return;}
		if(name==="ref"){add(n,"reference",escape(readableText(n)),xmlText(child(n,"label")));return;}
		if(["sub-article","response","supplementary-material"].includes(name)){issue("未展开附属文章或补充材料："+n.path);return;}
		if(["script","style","iframe","object"].includes(name)){issue("已跳过活动内容："+n.path);return;}
		for(const c of childNodes(n))walk(c,level);
	};
	const nestedBlocks=(n:XmlNode,level:number):void=>{for(const c of childNodes(n)){if(["graphic","inline-graphic","fig","table-wrap","list","boxed-text","disp-formula"].includes(localName(c)))walk(c,level);else if(localName(c)!=="inline-formula")nestedBlocks(c,level);}};
	add(child(child(front.meta,"title-group")||front.meta,"article-title")!,"title","# "+escape(front.title),front.title);
	for(const group of children(front.meta,"contrib-group"))add(group,"paragraph",escape(children(group,"contrib").filter(n=>!n.attrs["contrib-type"]||n.attrs["contrib-type"]==="author").map(authorName).filter(Boolean).join("; ")));
	for(const permission of children(front.meta,"permissions"))add(permission,"paragraph",escape(xmlText(permission)));
	for(const abstract of children(front.meta,"abstract"))walk(abstract);
	walk(child(root,"body")!);const back=child(root,"back");if(back)walk(back);
	if(converter!==JATS_LEGACY_CONVERTER)for(const floats of children(root,"floats-group"))walk(floats);
	for(const a of assets)if(a.issue)issue(a.issue,false);
	const emitted=new Set(blocks.map(b=>b.id));for(const r of refs)if(!emitted.has(r.target))issue("引用目标没有独立正文块："+r.target);
	if(!blocks.some(b=>b.kind==="paragraph"&&b.xmlPath.includes("/body[")))throw new Error("JATS 没有可读正文段落");
	const payload={schemaVersion:1 as const,converter,xmlSha256,title:front.title,authors:front.authors,identifiers:front.identifiers,markdown,blocks,references:refs,assets,issues,bodyCheck:bodyPartial?"partial" as const:"usable" as const};
	return {...payload,projectionId:objectDigest(payload)};
}
