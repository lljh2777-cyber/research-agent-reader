import { parseYaml, type App, TFile } from "obsidian";
import { parseAcquisitionInput } from "../fulltext/contracts";
import { readTrustedVaultFile, type VaultFilesystemAdapter } from "../runtime/trusted-vault-fs";
import { SourceCatalog, type LegacySource, type CatalogIdentityRecord } from "./catalog";
import { safeCitekey, type ResolvedIdentity } from "./identity";
import { FileSourceStorage } from "../sources/storage";
import type { SourceIndexIO } from "./source-intake";

export function createVaultCatalog(app:App,root:string,recordIdentities?:()=>Promise<CatalogIdentityRecord[]>):SourceCatalog {
	return new SourceCatalog(new FileSourceStorage(root),async()=>{
		const files=app.vault.getMarkdownFiles().filter(f=>/^wiki\/sources\/[^/]+\.md$|^papers\/[^/]+\/article\.md$|^Clippings\/.+\.md$/i.test(f.path));
		if(files.length>2000 || files.reduce((n,f)=>n+f.stat.size,0)>64*1024*1024)throw new Error("旧文献目录超过查重预算");
		const records:LegacySource[]=[];let total=0;
		for(const file of files){
			const text=(await readTrustedVaultFile(app.vault.adapter as VaultFilesystemAdapter,file.path,16*1024*1024,root)).toString("utf8");total+=Buffer.byteLength(text);if(total>64*1024*1024)throw new Error("旧文献查重读取超过预算");
			const match=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text);if(!match)continue;
			const metadata=parseYaml(match[1]);if(!metadata || typeof metadata!=="object"||Array.isArray(metadata))throw new Error("旧文献属性无效："+file.path);
			const identifiers:ResolvedIdentity["identifiers"]={};
			for(const kind of ["doi","pmid","pmcid"] as const){if(!metadata[kind])continue;const parsed=parseAcquisitionInput((kind==="doi"?"":kind+":")+String(metadata[kind]));if(parsed.kind!==kind)throw new Error("旧文献标识类型不一致");identifiers[kind]=parsed.value;}
			const kind=file.path.startsWith("wiki/")?"wiki":file.path.startsWith("papers/")?"mineru":"markdown";
			const candidate=metadata.citekey || (kind==="wiki"?file.basename:undefined),citekey=safeCitekey(candidate)?candidate:undefined;
			records.push({path:file.path,kind,identifiers,title:String(metadata.title||""),citekey});
			// An authored note can route to an older body; it remains version-unknown until explicitly validated.
			if(kind==="wiki"&&/^papers\/[^/]+\/article\.md$/.test(metadata.source_path||""))records.push({path:metadata.source_path,kind:"mineru",identifiers,title:String(metadata.title||""),citekey});
		}
		return records;
	},recordIdentities);
}
export function sourceIndexIO(app:App,root:string):SourceIndexIO {
	const storage=new FileSourceStorage(root),filePath="papers/index.md";
	const read=async()=>{const bytes=await storage.read(filePath,64*1024);return bytes?Buffer.from(bytes).toString("utf8"):null;};
	return {read,async apply(before,after){const current=await read();if(current===after)return;if(current!==before)throw new Error("原文已保存，索引在预览后发生变化；请重新打开保存状态补登记");if(Buffer.byteLength(after)>64*1024)throw new Error("原文索引超过登记上限");
		if(before===null){await storage.create(filePath,Buffer.from(after,"utf8"));}
		else{const file=app.vault.getAbstractFileByPath(filePath);if(!(file instanceof TFile))throw new Error("原文已保存，索引尚未被 Vault 识别；请稍后补登记");await app.vault.process(file,value=>{if(value!==before)throw new Error("原文索引已编辑，未覆盖");return after;});}
		if(await read()!==after)throw new Error("原文索引保存后核对失败");
	}};
}
