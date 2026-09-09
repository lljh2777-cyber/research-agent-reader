import type { AuthorizedPdfPageRaster } from "../agent/pdf-identity";
import type { PdfSnapshot } from "../fulltext/contracts";
import { identityDigest, objectDigest } from "./identity";

export interface PdfDisplayedEvidence extends Omit<AuthorizedPdfPageRaster,"rasterDataUrl"> { kind:"pdf";pngSha256:string; }
export interface SourceConfirmation {
	schemaVersion:2;requestId:string;snapshotId:string;primaryArtifactHash:string;identityDigest:string;
	displayedEvidenceDigest:string;evidence:PdfDisplayedEvidence;confirmationMode:"human-visual";
}
export function sourceConfirmation(requestId:string,snapshot:PdfSnapshot,evidence:PdfDisplayedEvidence):SourceConfirmation {
	return {schemaVersion:2,requestId,snapshotId:snapshot.id,primaryArtifactHash:snapshot.artifact.sha256,identityDigest:identityDigest(snapshot.identity),displayedEvidenceDigest:objectDigest({identity:snapshot.identity,evidence}),evidence,confirmationMode:"human-visual"};
}
export function validateSourceConfirmation(receipt:SourceConfirmation,requestId:string,snapshot:PdfSnapshot):void {
	if(!receipt || receipt.schemaVersion!==2 || receipt.confirmationMode!=="human-visual" || !/^r-[a-f0-9-]{36}$/.test(requestId))throw new Error("缺少 v2 原文身份确认回执");
	const e=receipt.evidence;
	if(!e || e.kind!=="pdf" || e.pageCount!==snapshot.validation.pageCount || !Number.isInteger(e.pageNumber) || e.pageNumber<1 || e.pageNumber>Math.min(3,e.pageCount) || ![e.pngSha256,e.rasterSha256].every(s=>/^[a-f0-9]{64}$/.test(s)) || e.renderEngine!=="obsidian-pdfjs" || typeof e.renderEngineVersion!=="string" || !e.renderEngineVersion || e.renderEngineVersion.length>100 || !Number.isFinite(e.scale) || e.scale<=0 || e.scale>2 || ![e.viewportWidth,e.viewportHeight].every(n=>Number.isInteger(n)&&n>0&&n<=1601))throw new Error("原文确认的页面证据无效");
	if(objectDigest(receipt)!==objectDigest(sourceConfirmation(requestId,snapshot,e)))throw new Error("原文确认与任务、快照或所展示的身份不一致");
}
