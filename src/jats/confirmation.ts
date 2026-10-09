import type { JatsSnapshot } from "./contracts";
import { jatsFront } from "./projection";
import { parseXml } from "./xml";
import { objectDigest } from "../papers/identity";
export function displayedJatsIdentity(xml:Uint8Array) {
	const front=jatsFront(parseXml(xml));return {kind:"jats" as const,title:front.title,authors:front.authors,identifiers:front.identifiers,xmlPath:front.meta.path,sourceStart:front.meta.start,sourceEnd:front.meta.end,excerpt:new TextDecoder("utf-8",{fatal:true}).decode(xml).slice(front.meta.start,Math.min(front.meta.end,front.meta.start+20000)),excerptTruncated:front.meta.end-front.meta.start>20000};
}
export interface JatsConfirmation {schemaVersion:2;requestId:string;snapshotId:string;primaryArtifactHash:string;identityDigest:string;displayedEvidenceDigest:string;confirmationMode:"human-structured";acceptedPartial:boolean;}
export function confirmJats(id:string,snapshot:JatsSnapshot,xml:Uint8Array,acceptedPartial:boolean):JatsConfirmation {
	return {schemaVersion:2,requestId:id,snapshotId:snapshot.id,primaryArtifactHash:snapshot.artifact.files.find(f=>f.role==="xml")!.sha256,identityDigest:objectDigest(snapshot.identity),displayedEvidenceDigest:objectDigest({identity:snapshot.identity,evidence:displayedJatsIdentity(xml)}),confirmationMode:"human-structured",acceptedPartial};
}
export function validateJatsConfirmation(receipt:JatsConfirmation,id:string,snapshot:JatsSnapshot,xml:Uint8Array):void {
	if(!/^r-[a-f0-9-]{36}$/.test(id)||typeof receipt?.acceptedPartial!=="boolean"||snapshot.validation.requestSatisfaction==="partial"&&!receipt.acceptedPartial||objectDigest(receipt)!==objectDigest(confirmJats(id,snapshot,xml,receipt.acceptedPartial)))throw new Error("JATS 确认与主文章、快照或部分结果接受不一致");
}
