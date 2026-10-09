import * as path from "node:path";
import { decodeIntakeRef, type AcquisitionIntakeRef } from "./contracts";
import type { AcquisitionService } from "./service";
import type { PaperIngestFlowOptions } from "../agent/paper-ingest-flow";

export async function prepareAcquiredIntake(service:AcquisitionService,id:string) {
	const source=await service.intakeSource(id);
	const reference:AcquisitionIntakeRef={jobId:id,snapshotId:source.snapshot.id,sha256:source.snapshot.artifact.sha256,byteLength:source.snapshot.artifact.byteLength};
	return {...source,reference};
}
export async function validateAcquiredIntake(service:AcquisitionService,options:PaperIngestFlowOptions):Promise<void> {
	if(!options.acquisitionSource)return;
	const expected=decodeIntakeRef(options.acquisitionSource), actual=await prepareAcquiredIntake(service,expected.jobId);
	if(actual.reference.snapshotId!==expected.snapshotId || actual.reference.sha256!==expected.sha256 || actual.reference.byteLength!==expected.byteLength || path.resolve(options.sourcePdfPath)!==path.resolve(actual.path))throw new Error("入库参数与已获取 PDF 快照不一致，请重新打开继续入库");
}
