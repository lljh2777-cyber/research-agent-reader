import { randomUUID } from "node:crypto";
import type { PdfSnapshot } from "../fulltext/contracts";
import { decodeSourceManifest, loadPdfSource, sourceVersion, type SourceManifest } from "../sources/pdf-package";
import type { SourceStorage } from "../sources/storage";
import { safeCitekey, sourceCitekey, type ResolvedIdentity } from "./identity";
import { decodePackageManifest,loadSourcePackage,type SourcePackageManifest } from "../sources/package";
import { inspectSourcePackages } from "./catalog-reader";

export interface LegacySource {path:string;kind:"mineru"|"markdown"|"wiki";identifiers:ResolvedIdentity["identifiers"];title:string;citekey?:string;}
export interface CatalogPlan {paperId:string;citekey:string;packages:SourcePackageManifest[];legacy:LegacySource[];reuse?:SourceManifest;warnings:string[];}
export interface CatalogIdentityRecord {paperId:string;citekey?:string;identifiers:ResolvedIdentity["identifiers"];}
export class SourceCatalog {
	constructor(readonly storage:SourceStorage,private legacySources:()=>Promise<LegacySource[]>=async()=>[],private recordIdentities:()=>Promise<CatalogIdentityRecord[]>=async()=>[]){}
	inspect() { return inspectSourcePackages(this.storage); }
	async list():Promise<{packages:SourcePackageManifest[];warnings:string[]}> {
		const packages:SourcePackageManifest[]=[],warnings:string[]=[];let total=0;
		for(const entry of await this.storage.list("papers")){
			if(!entry.directory)continue;const dir="papers/"+entry.name;
			if(!(await this.storage.list(dir)).some(e=>e.name==="_source"))continue;
			const bytes=await this.storage.read(dir+"/_source/manifest.json");
			if(!bytes){warnings.push("尚未提交的原文目录："+dir);continue;}
			total+=bytes.length;if(total>8*1024*1024)throw new Error("原文目录元数据超过读取预算");
			const manifest=decodePackageManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));if(manifest.packageKey!==entry.name)throw new Error("原文目录与清单不一致："+dir);packages.push(manifest);
		}
		return {packages,warnings};
	}
	async prepare(snapshot:PdfSnapshot):Promise<CatalogPlan> {
		const plan=await this.associate(snapshot.identity),reuse=plan.packages.find((p):p is SourceManifest=>p.packageKind==="pdf-source"&&p.version===snapshot.candidate.version&&p.sourceVersionId===sourceVersion(snapshot)&&p.files[0].sha256===snapshot.artifact.sha256);return {...plan,reuse};
	}
	async associate(identity:ResolvedIdentity):Promise<CatalogPlan> {
		const listed = await this.list(), allLegacy = await this.legacySources(), persisted = await this.recordIdentities();
		const entries = [
			...listed.packages.map(item => ({ item, kind: "package" as const, paperId: item.paperId, identifiers: item.identity.identifiers })),
			...allLegacy.map(item => ({ item, kind: "legacy" as const, paperId: undefined, identifiers: item.identifiers })),
			...persisted.map(item => ({ item, kind: "record" as const, paperId: item.paperId, identifiers: item.identifiers })),
		];
		if (entries.length > 10000) throw new Error("文献身份目录超过关联上限");
		const tokens = (ids: ResolvedIdentity["identifiers"], paperId?: string) => [
			...(["doi", "pmid", "pmcid"] as const).filter(kind => ids[kind]).map(kind => JSON.stringify([kind, ids[kind]])),
			...(paperId ? [JSON.stringify(["paperId", paperId])] : []),
		];
		const index = new Map<string, number[]>();
		entries.forEach((entry, i) => { for (const token of tokens(entry.identifiers, entry.paperId)) { if (!index.has(token)) index.set(token, []); index.get(token)!.push(i); } });
		const selected = new Set<number>(), visited = new Set<string>(), queue = tokens(identity.identifiers);
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const token = queue[cursor]; if (visited.has(token)) continue; visited.add(token);
			for (const i of index.get(token) || []) if (!selected.has(i)) { selected.add(i); queue.push(...tokens(entries[i].identifiers, entries[i].paperId)); }
		}
		const related = [...selected].map(i => entries[i]);
		const packages = related.filter(entry => entry.kind === "package").map(entry => entry.item);
		const legacy = related.filter(entry => entry.kind === "legacy").map(entry => entry.item);
		const records = related.filter(entry => entry.kind === "record").map(entry => entry.item);
		if (packages.length > 40) throw new Error("该论文关联来源超过 40 个，请先核对");
		const merged = { ...identity.identifiers };
		for (const entry of related) for (const kind of ["doi", "pmid", "pmcid"] as const) {
			if (merged[kind] && entry.identifiers[kind] && merged[kind] !== entry.identifiers[kind]) throw new Error("文献记录中的精确标识冲突");
			if (entry.identifiers[kind]) merged[kind] = entry.identifiers[kind];
		}
		const ids = new Set([...packages.map(p => p.paperId), ...records.map(p => p.paperId)]);
		if (ids.size > 1) throw new Error("相同标识关联多个论文记录，请先核对");
		const keys = new Set(related.map(entry => entry.item.citekey).filter(safeCitekey));
		if (keys.size > 1) throw new Error("相同论文存在不同 citekey，请先核对");
		const citekey = [...keys][0] || sourceCitekey(identity);
		if (listed.packages.some(p => p.citekey === citekey && !packages.includes(p))) throw new Error("原文 citekey 被另一论文占用");
		if (persisted.some(p => p.citekey === citekey && !records.includes(p))) throw new Error("文献记录 citekey 被另一论文占用");
		for (const item of packages) await loadSourcePackage(this.storage, item.packageKey);
		return { paperId: [...ids][0] || "p-" + randomUUID(), citekey, packages, legacy,
			warnings: [...listed.warnings, ...legacy.filter(p => p.kind !== "wiki").map(p => "旧来源版本未知，未自动替代本次来源：" + p.path)] };
	}
}
