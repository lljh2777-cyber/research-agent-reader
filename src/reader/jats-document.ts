import type { SourceStorage } from "../sources/storage";
import { loadJatsSource } from "../sources/jats-package";
import { imageInfo } from "../jats/media";
import { buildMarkdownReaderPackage } from "./clipping-markdown";
import { adaptReaderDocument } from "./document";
export async function loadJatsDocument(storage:SourceStorage,key:string) {
	const loaded=await loadJatsSource(storage,key),pkg=buildMarkdownReaderPackage(loaded.projection.markdown,`papers/${key}/article.md`);pkg.sourceKind="jats";pkg.title=loaded.projection.title;pkg.issues=[...loaded.snapshot.validation.issues,"JATS 支持按章节和正文块交互深读；没有 PDF 页码映射；正式 Wiki 生成尚未接入"];
	for(const a of loaded.projection.assets){if(!a.path)continue;const bytes=loaded.files.get(a.path)!;const info=imageInfo(bytes,a.path);if(!info)throw new Error("JATS 图像验证失败");pkg.verifiedAssetBlobs.set(a.path,new Blob([new Uint8Array(bytes)],{type:info.mime}));}
	const occurrences=new Map<string,number>();
	for(const v of pkg.visuals){v.pageIdx=-1;v.pageRange=[-1,-1];v.captionPageIdx=undefined;const candidates=loaded.projection.blocks.flatMap(b=>loaded.projection.markdown.slice(b.start,b.end).split("]("+v.anchorAssetPath+")").slice(1).map(()=>b)),ordinal=occurrences.get(v.anchorAssetPath)||0,block=candidates[ordinal];occurrences.set(v.anchorAssetPath,ordinal+1);if(!block)throw new Error("JATS 图像缺少对应源块");if(block.label)v.label=block.label;v.caption=block.caption||"";v.captionParts=v.caption?[v.caption]:[];v.captionSourceBlockIds=block.caption?[block.id]:[];v.memberBlockIds=[block.id];v.samePageCaptionProjections=[];}
	return adaptReaderDocument(pkg,loaded.projection);
}
