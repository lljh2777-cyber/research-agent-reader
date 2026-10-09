/** Bounded, non-validating XML reader. No DTD/entity resolution, network, or DOM execution. */
export interface XmlNode { name:string; attrs:Record<string,string>; children:Array<XmlNode|string>; path:string; start:number; end:number; }
export const XML_LIMITS = { bytes:8*1024*1024, nodes:100000, depth:96, attributes:64, text:8*1024*1024 };
const namePattern = /^[A-Za-z_][\w.:-]*/;
function entities(value:string):string {
	return value.replace(/&([^;\s<]{1,32});|&/g,(whole,key:string|undefined)=>{
		const fixed:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
		if(key&&Object.prototype.hasOwnProperty.call(fixed,key))return fixed[key];
		if(key&&/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(key)){
			const n=key[1]==="x"?parseInt(key.slice(2),16):Number(key.slice(1));
			if(n===9||n===10||n===13||(n>=32&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)&&n!==0xfffe&&n!==0xffff))return String.fromCodePoint(n);
		}
		throw new Error("XML 含未定义或禁止的实体："+whole.slice(0,40));
	});
}
export function parseXml(bytes:Uint8Array):XmlNode {
	if(!bytes.length||bytes.length>XML_LIMITS.bytes)throw new Error("XML 超过 8 MiB 上限或为空");
	const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
	if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error("XML 含非法控制字符");
	const stack:XmlNode[]=[],counts=new WeakMap<XmlNode,Map<string,number>>();let root:XmlNode|undefined,i=0,nodes=0,characters=0,doctype=false;
	const append=(value:string)=>{characters+=value.length;if(characters>XML_LIMITS.text)throw new Error("XML 文本超限");if(stack.length)stack[stack.length-1].children.push(value);else if(value.trim())throw new Error("XML 根节点外存在文本");};
	while(i<text.length){
		if(text[i]!=="<"){const end=text.indexOf("<",i);const next=end<0?text.length:end,value=text.slice(i,next);if(value.includes("]]>"))throw new Error("XML 文本包含非法 CDATA 结束符");append(entities(value));i=next;continue;}
		if(text.startsWith("<!--",i)){const end=text.indexOf("-->",i+4);if(end<0||text.slice(i+4,end).includes("--"))throw new Error("XML 注释未闭合");i=end+3;continue;}
		if(text.startsWith("<![CDATA[",i)){if(!stack.length)throw new Error("CDATA 不在文章内");const end=text.indexOf("]]>",i+9);if(end<0)throw new Error("CDATA 未闭合");append(text.slice(i+9,end));i=end+3;continue;}
		if(text.startsWith("<?",i)){const end=text.indexOf("?>",i+2);if(end<0)throw new Error("XML 指令未闭合");const instruction=text.slice(i+2,end);if(/^xml\s/.test(instruction)&&/encoding\s*=/.test(instruction)&&! /encoding\s*=\s*['"]utf-8['"]/i.test(instruction))throw new Error("仅支持 UTF-8 XML");i=end+2;continue;}
		let end=i+1,quote="";for(;end<text.length;end++){const c=text[end];if(quote){if(c===quote)quote="";}else if(c==='"'||c==="'")quote=c;else if(c===">")break;}
		if(end===text.length)throw new Error("XML 标签未闭合");
		const tag=text.slice(i+1,end);
		if(tag.startsWith("!DOCTYPE")){
			if(root||doctype||!/^!DOCTYPE\s+article\s+(?:SYSTEM\s+['"][^'"<>\[\]]+['"]|PUBLIC\s+['"][^'"<>\[\]]+['"]\s+['"][^'"<>\[\]]+['"])\s*$/.test(tag))throw new Error("禁止 XML 内部 DTD、实体或未知声明");
			doctype=true;i=end+1;continue;
		}
		if(tag.startsWith("!"))throw new Error("禁止 XML 实体或声明");
		if(tag.startsWith("/")){const node=stack.pop();if(!node||tag.slice(1).trim()!==node.name)throw new Error("XML 结束标签不匹配");node.end=end+1;i=end+1;continue;}
		const name=namePattern.exec(tag)?.[0];if(!name)throw new Error("XML 标签名无效");
		const empty=/\/\s*$/.test(tag),tail=tag.slice(name.length,empty?tag.lastIndexOf("/"):tag.length),attrs:Record<string,string>=Object.create(null);let at=0;
		while(at<tail.length){const space=/^\s+/.exec(tail.slice(at));if(!space){if(tail.slice(at).trim())throw new Error("XML 属性缺少分隔");break;}at+=space[0].length;if(at===tail.length)break;
			const match=/^([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(tail.slice(at));
			if(!match||match[3].includes("<")||Object.prototype.hasOwnProperty.call(attrs,match[1])||Object.keys(attrs).length>=XML_LIMITS.attributes)throw new Error("XML 属性重复、无效或超限");attrs[match[1]]=entities(match[3]);at+=match[0].length;
		}
		if(++nodes>XML_LIMITS.nodes||stack.length>=XML_LIMITS.depth)throw new Error("XML 节点或嵌套深度超限");
		const parent=stack[stack.length-1],siblings=parent?(counts.get(parent)||new Map<string,number>()):new Map<string,number>(),number=(siblings.get(name)||0)+1;siblings.set(name,number);if(parent)counts.set(parent,siblings);
		const node:XmlNode={name,attrs,children:[],path:(parent?.path||"")+"/"+name+"["+number+"]",start:i,end:end+1};
		if(parent)parent.children.push(node);else{if(root)throw new Error("XML 含多个根文章");root=node;}if(!empty)stack.push(node);i=end+1;
	}
	if(stack.length||!root)throw new Error("XML 文档不完整");return root;
}
export const localName=(node:XmlNode):string=>node.name.split(":").pop()!;
export const childNodes=(node:XmlNode):XmlNode[]=>node.children.filter((c):c is XmlNode=>typeof c!=="string");
export const children=(node:XmlNode,name:string):XmlNode[]=>childNodes(node).filter(c=>localName(c)===name);
export const child=(node:XmlNode,name:string):XmlNode|undefined=>children(node,name)[0];
export function descendants(node:XmlNode,name:string):XmlNode[]{const result:XmlNode[]=[];for(const c of childNodes(node)){if(localName(c)===name)result.push(c);result.push(...descendants(c,name));}return result;}
export function xmlText(node:XmlNode|undefined):string {return node?node.children.map(c=>typeof c==="string"?c:xmlText(c)).join("").replace(/\s+/g," ").trim():"";}
