import { decodeSourceManifest,loadPdfSource,type SourceManifest } from "./pdf-package";
import { decodeJatsManifest,loadJatsSource,type JatsManifest } from "./jats-package";
import type { SourceStorage } from "./storage";
export type SourcePackageManifest=SourceManifest|JatsManifest;
export function decodePackageManifest(value:unknown):SourcePackageManifest {return (value as {packageKind?:string})?.packageKind==="jats-source"?decodeJatsManifest(value):decodeSourceManifest(value);}
export async function loadSourcePackage(storage:SourceStorage,key:string){const raw=await storage.read(`papers/${key}/_source/manifest.json`);if(!raw)throw new Error("原文包尚未提交");const manifest=decodePackageManifest(JSON.parse(Buffer.from(raw).toString("utf8")));return manifest.packageKind==="jats-source"?loadJatsSource(storage,key):loadPdfSource(storage,key);}
