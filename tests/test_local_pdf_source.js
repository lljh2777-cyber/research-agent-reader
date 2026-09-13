"use strict";
// Shared publication and recovery in memory; real file fixtures are retained, never deleted.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{randomUUID}=require("node:crypto");
const {loadReading}=require("./reading-test-helpers"),f=require("./source-intake-fixtures.cjs"),base=require("./fulltext-pmc-fixtures.cjs");
const {prepareLocalPdf,rereadLocalPdf,readLocalPdfFile}=loadReading("papers/local-pdf.ts");
const {decodeLocalPdfSnapshot,decodePdfSourceSnapshot,pdfSourceVersionLabel}=loadReading("sources/pdf-snapshot.ts");
const {decodePdfSnapshot}=loadReading("fulltext/contracts.ts");
const {SourceIntakeService}=loadReading("papers/source-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts");
const {loadPdfSource,decodeSourceManifest,representationDigest}=loadReading("sources/pdf-package.ts");
const {objectDigest}=loadReading("papers/identity.ts");
const {readPaperLibrary}=loadReading("library/reader.ts"),{JournalPaperRecordStore,readPaperRecordIdentities}=loadReading("library/record-store.ts");
const signal=()=>new AbortController().signal,check=async(name,fn)=>{await fn();console.log("PASS local PDF: "+name);};
const sources=[],file=path.resolve("local-fixtures","selected.pdf");
const local=(options={})=>prepareLocalPdf(file,base.identity,signal(),{read:async()=>Buffer.from(base.bytes),pdfLoader:base.pdfLoader(),...options});
function setup(source,storage=f.storage(),journal=f.storage(),index=f.index(),records=f.storage()){
 const catalog=new SourceCatalog(storage,undefined,()=>readPaperRecordIdentities(records));
 const deps={deviceId:f.sha("local-test-device"),catalog,journal,index,readSource:async()=>structuredClone(source),render:async()=>f.raster(),link:async()=>{}};
 const service=new SourceIntakeService(deps);sources.push(service);return{source,storage,journal,index,records,catalog,deps,service};
}
const shown=async x=>{const plan=await x.service.prepare(x.source.snapshot.id),display=await x.service.present(plan.requestId);return{plan,display};};
const save=async x=>{const {plan,display}=await shown(x);return x.service.save(plan.requestId,display.digest);};
(async()=>{try{
 await check("local preparation preserves real provenance and an unknown version without provider claims",async()=>{
  const source=await local();assert.equal(source.snapshot.kind,"local-pdf");assert.equal(source.snapshot.origin.fileName,"selected.pdf");assert.equal(source.snapshot.version,"unknown");
  assert.equal(source.snapshot.origin.versionBasis,"unspecified");assert.equal(source.snapshot.validation.bodyCheck,"not_checked");assert.equal(source.snapshot.artifact.sha256,f.sha(base.bytes));
  assert.deepEqual(decodePdfSourceSnapshot(source.snapshot),source.snapshot);assert.throws(()=>decodePdfSnapshot(source.snapshot));
  assert.match(pdfSourceVersionLabel(source.snapshot),/未核验/);
  const declared=await local({version:"accepted_manuscript"});assert.equal(declared.snapshot.origin.versionBasis,"user-declared");assert.match(pdfSourceVersionLabel(declared.snapshot),/用户声明/);
  for(const override of [{candidate:{providerId:"pmc-cloud"}},{jobId:"a-"+randomUUID()},{license:"CC BY"},{version:"preprint"},{origin:{...source.snapshot.origin,versionBasis:"publisher-verified"}},{origin:{...source.snapshot.origin,fileName:"../secret.pdf"}}])assert.throws(()=>decodeLocalPdfSnapshot({...source.snapshot,...override}));
 });
 await check("PDF mismatch, encrypted content, cancelled reads and changed selected bytes stop before publication",async()=>{
  await assert.rejects(local({pdfLoader:base.pdfLoader("Other title 10.1234/other")}),/冲突/);
  await assert.rejects(local({pdfLoader:async()=>({getDocument:()=>({promise:Promise.reject(new Error("password")),destroy:async()=>{}})})}),/无法解析/);
  const c=new AbortController();c.abort();let reads=0;await assert.rejects(prepareLocalPdf(file,base.identity,c.signal,{read:async()=>{reads++;return base.bytes;}}));assert.equal(reads,0);
  const source=await local();await assert.rejects(rereadLocalPdf(file,source.snapshot,signal(),async()=>Buffer.from("changed local PDF")),/已变化/);
  assert.deepEqual((await rereadLocalPdf(file,source.snapshot,signal(),async()=>Buffer.from(base.bytes))).snapshot,source.snapshot);
 });
 await check("the shared confirmation and publisher create only a PDF package with a local receipt",async()=>{
  const x=setup(await local()),{plan,display}=await shown(x);assert.equal(x.storage.files.size+x.journal.files.size,0);
  assert.equal((await x.service.save(plan.requestId,"forged")).phase,"failed");assert.equal(x.storage.files.size,0);
  const saved=await x.service.save(plan.requestId,display.digest);assert.equal(saved.phase,"saved",saved.error);const pkg=await loadPdfSource(x.storage,saved.packageKey);
  assert.equal(pkg.manifest.schemaVersion,2);assert.equal(pkg.manifest.version,"unknown");assert.equal(pkg.snapshot.kind,"local-pdf");assert.equal(pkg.confirmation.schemaVersion,2);
  assert.ok(x.storage.files.has(`papers/${saved.packageKey}/_source/local.json`));assert.ok(!x.storage.files.has(`papers/${saved.packageKey}/_source/acquisition.json`));
  assert.ok(![...x.storage.files.keys()].some(p=>p.endsWith("article.md")));assert.match(x.index.text,/本地文件；版本未核验；metadata-only/);
  assert.equal(x.storage.writes.at(-1),`papers/${saved.packageKey}/_source/manifest.json`);
  const scan=await readPaperLibrary(x.storage,x.records,{vaultRoot:path.resolve("local-memory"),parseYaml:JSON.parse});
  assert.equal(scan.papers[0].objects[0].source.verification.state,"verified");assert.equal(scan.papers[0].objects[0].capabilities.openOriginal.available,true);
  assert.equal(scan.papers[0].readingState,"unmarked");assert.equal(scan.papers[0].objects[0].source.format,"pdf");
  assert.throws(()=>decodeSourceManifest({...pkg.manifest,license:"CC BY"}),/不支持/);
 });
 await check("repeat selections reuse identical local bytes; manuscript declarations and online origins remain separate",async()=>{
  const x=setup(await local()),first=await save(x),writes=x.storage.writes.length;
  const repeat=setup(await local(),x.storage,f.storage(),x.index),second=await save(repeat);assert.equal(second.phase,"saved",second.error);assert.equal(second.packageKey,first.packageKey);assert.equal(x.storage.writes.length,writes);
  const declared=setup(await local({version:"accepted_manuscript"}),x.storage,f.storage(),x.index),other=await save(declared);assert.equal(other.phase,"saved",other.error);assert.notEqual(other.packageKey,first.packageKey);assert.equal(other.paperId,first.paperId);
  const online=f.source(),third=setup(online,x.storage,f.storage(),x.index),net=await save(third);assert.equal(net.phase,"saved",net.error);assert.notEqual(net.packageKey,first.packageKey);
  assert.equal((await loadPdfSource(x.storage,net.packageKey)).manifest.schemaVersion,1);assert.equal((await x.catalog.list()).packages.length,3);
  assert.equal(representationDigest(online.snapshot),objectDigest({identifiers:online.snapshot.identity.identifiers,version:online.snapshot.candidate.version,sourceVersionId:online.snapshot.candidate.pmc.sourceVersionId,sha256:online.snapshot.artifact.sha256}),"online representation keys remain unchanged");
 });
 await check("metadata-only identity is reused; a new owner appearing during preview stops the old save",async()=>{
  const x=setup(await local()),store=new JournalPaperRecordStore(x.records),pid="p-"+randomUUID();
  const record={kind:"record",id:pid,paperId:pid,title:base.title,identifiers:base.ids,citekey:"known_local",readingState:"revisit"};
  await store.append(record,[]);const saved=await save(x);assert.equal(saved.paperId,pid);assert.equal((await store.read(pid)).current.record.readingState,"revisit");
  const y=setup(await local()),prepared=await shown(y),other="p-"+randomUUID();
  await new JournalPaperRecordStore(y.records).append({...record,id:other,paperId:other,citekey:prepared.plan.citekey},[]);
  const stopped=await y.service.save(prepared.plan.requestId,prepared.display.digest);assert.equal(stopped.phase,"failed");assert.match(stopped.error,/关联/);assert.equal(y.storage.files.size,0);
 });
 await check("interrupted local publication resumes the frozen snapshot and never overwrites altered bytes",async()=>{
  for(const mutate of [false,true]){
   const x=setup(await local());x.storage.before=async p=>{if(p.endsWith("_source/validation.json"))throw new Error("disk interruption");};
   const interrupted=await save(x);assert.equal(interrupted.phase,"failed");await assert.rejects(loadPdfSource(x.storage,interrupted.packageKey),/尚未提交/);
   x.storage.before=undefined;const pdf=`papers/${interrupted.packageKey}/source.pdf`;
   if(mutate)x.storage.files.set(pdf,Buffer.from("hand-edited bytes"));const original=new Map(x.storage.files);
   const next=setup(x.source,x.storage,x.journal,x.index),{plan,display}=await shown(next);assert.equal(plan.recovering,true);const result=await next.service.save(plan.requestId,display.digest);
   assert.equal(result.phase,mutate?"failed":"saved",result.error);for(const [p,b]of original)assert.deepEqual(x.storage.files.get(p),b);
   if(!mutate)assert.equal(x.storage.writes.filter(p=>p.endsWith("source.pdf")).length,1);
  }
 });
 await check("index failure preserves the committed PDF and later registration preserves edited index text",async()=>{
  const x=setup(await local());x.index.fail=true;const pending=await save(x);assert.equal(pending.phase,"registration_pending");await loadPdfSource(x.storage,pending.packageKey);
  x.index.fail=false;x.index.text="# Kept index\n\nUser content\n";const bytes=new Map(x.storage.files),next=setup(x.source,x.storage,x.journal,x.index);
  const plan=await next.service.prepare(next.source.snapshot.id);assert.equal(plan.existing,true);assert.equal((await next.service.save(plan.requestId,"")).phase,"saved");
  assert.deepEqual(x.storage.files,bytes);assert.match(x.index.text,/User content/);
 });
 await check("local receipts cannot be replaced with acquired receipts or detached from the committed bytes",async()=>{
  const x=setup(await local()),saved=await save(x),pkg=await loadPdfSource(x.storage,saved.packageKey);
  const localPath=`papers/${saved.packageKey}/_source/local.json`;x.storage.files.set(localPath,Buffer.from(JSON.stringify(f.source().snapshot)));
  await assert.rejects(loadPdfSource(x.storage,saved.packageKey),/修改|limit/);
  const wrong={...pkg.manifest,files:pkg.manifest.files.map(f=>({...f,path:f.path==="_source/local.json"?"_source/acquisition.json":f.path}))};assert.throws(()=>decodeSourceManifest(wrong),/清单/);
  const y=setup(await local()),prepared=await shown(y);y.source.snapshot.origin.fileName="another.pdf";
  const changed=await y.service.save(prepared.plan.requestId,prepared.display.digest);assert.equal(changed.phase,"failed");assert.match(changed.error,/快照已变化/);assert.equal(y.storage.files.size,0);
 });
 await check("real bounded file reads and snapshot replay preserve the original and reject unsafe selections",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rar-local-pdf-")),original=path.join(root,"original.pdf");await fs.writeFile(original,base.bytes,{flag:"wx"});
  const source=await prepareLocalPdf(original,base.identity,signal(),{pdfLoader:base.pdfLoader()});assert.deepEqual(await fs.readFile(original),base.bytes);
  assert.equal((await rereadLocalPdf(original,source.snapshot,signal())).snapshot.id,source.snapshot.id);assert.deepEqual(await fs.readdir(root),["original.pdf"]);
  await assert.rejects(readLocalPdfFile("relative.pdf",signal()),/绝对路径/);await assert.rejects(readLocalPdfFile(path.join(root,"missing.txt"),signal()),/绝对路径/);
  const large=path.join(root,"oversized.pdf"),h=await fs.open(large,"wx");try{await h.truncate(64*1024*1024+1);}finally{await h.close();}
  await assert.rejects(readLocalPdfFile(large,signal()),/64 MiB/);assert.deepEqual(await fs.readFile(original),base.bytes);
  console.log("Retained local PDF fixture: "+root);
 });
 console.log("LOCAL_PDF_SOURCE_OK (9 groups; no models/network, PDF parser/raster simulated; file fixtures retained)");
}finally{await Promise.all(sources.map(s=>s.dispose()));}})().catch(error=>{console.error(error);process.exitCode=1;});
