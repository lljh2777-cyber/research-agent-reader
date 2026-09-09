import * as path from "node:path";
import { FileSourceStorage } from "./storage";
import { loadPdfSource, type SourceManifest } from "./pdf-package";

export async function validateSourcePackageFile(vaultRoot:string,filename:string):Promise<SourceManifest|undefined> {
	const relative=path.relative(vaultRoot,filename).replace(/\\/g,"/"),parts=relative.split("/");
	if(parts[0].toLowerCase()!=="papers" || parts.length<3)return;
	const storage=new FileSourceStorage(vaultRoot),root=`${parts[0]}/${parts[1]}`;
	if(!(await storage.list(root)).some(e=>e.name==="_source"))return;
	if(parts.length!==3||parts[2]!=="source.pdf")throw new Error("此原文包没有可用的正文投影，请选择 source.pdf");
	return (await loadPdfSource(storage,parts[1])).manifest;
}
