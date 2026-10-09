"use strict";
// Pure memory integration of metadata, local PDF and acquisition; no external requests or cleanup.
const assert=require("node:assert/strict"),path=require("node:path"),{randomUUID}=require("node:crypto");
const {loadReading}=require("./reading-test-helpers"),f=require("./source-intake-fixtures.cjs"),base=require("./fulltext-pmc-fixtures.cjs"),{memory,waitFor}=require("./fulltext-fixtures.cjs");
const {MetadataIntakeService}=loadReading("library/metadata-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts");
const {JournalPaperRecordStore,readPaperRecordIdentities}=loadReading("library/record-store.ts");
const {LocalPdfIntakeService}=loadReading("papers/local-pdf-intake.ts"),{AcquisitionService}=loadReading("fulltext/service.ts"),{AcquisitionRepository}=loadReading("fulltext/repository.ts");
const {PmcAcquisitionBackend}=loadReading("fulltext/pmc-backend.ts"),{decodeJob}=loadReading("fulltext/contracts.ts");
const {MetadataIntakeModal}=loadReading("views/metadata-intake.ts",{obsidian:{Modal:class{}}});
const services=[],signal=()=>new AbortController().signal,file=path.resolve("intake","selected.pdf");
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
const check=async(name,run)=>{await run();console.log("PASS paper intake: "+name);};
function setup(){
 const storage=f.storage(),journal=f.storage(),records=new JournalPaperRecordStore(journal),catalog=new SourceCatalog(storage,undefined,()=>readPaperRecordIdentities(journal));
 const metadata=new MetadataIntakeService({resolve:async()=>structuredClone(base.identity)},catalog,records);
 const local=new LocalPdfIntakeService({deviceId:f.sha("intake-device"),catalog,journal,index:f.index(),resolver:{resolve:async()=>{throw new Error("unexpected metadata requery");}},read:async()=>Buffer.from(base.bytes),pdfLoader:base.pdfLoader(),render:async()=>f.raster(),link:async()=>{}});
 services.push(metadata,local);return{storage,journal,records,catalog,metadata,local};
}
async function known(x){const preview=await x.metadata.prepare(base.ids.doi,signal()),saved=await x.metadata.save(preview,signal());return{preview,saved,context:await x.metadata.context(preview,signal(),saved.paperId)};}
function acq(storage=memory(),backend){
 const observed=[];backend ||= {mode:"production",resolve:async()=>{throw new Error("must not requery confirmed identity");},discover:async(_r,_s,identity)=>{observed.push(identity);return[];}};
 const service=new AcquisitionService(new AcquisitionRepository(storage,"production"),"test-device",backend);services.push(service);return{service,storage,backend,observed};
}
(async()=>{try{
 await check("private confirmed metadata is detached, read-only handoff requires a saved owner, changed owners and forged previews fail",async()=>{
  const x=setup(),preview=await x.metadata.prepare(base.ids.doi,signal());await assert.rejects(x.metadata.context(preview,signal()),/先保存/);assert.equal(x.journal.files.size,0);
  preview.identity.title="UI mutation";const saved=await x.metadata.save(preview,signal()),context=await x.metadata.context(preview,signal(),saved.paperId);
  assert.deepEqual(context.identity,base.identity);context.identity.title="caller mutation";assert.equal((await x.metadata.context(preview,signal())).identity.title,base.title);
  await assert.rejects(x.metadata.context({...preview},signal()),/失效/);await assert.rejects(x.metadata.context(preview,signal(),"p-"+randomUUID()),/关联/);
  const other="p-"+randomUUID();await x.records.append({kind:"record",id:other,paperId:other,title:base.title,identifiers:base.ids,readingState:"unmarked"},[]);
  await assert.rejects(x.metadata.context(preview,signal()),/多个/);
 });
 await check("confirmed metadata continues into real local publication without a resolver or an extra paper identity",async()=>{
  const x=setup(),{context,saved}=await known(x),plan=await x.local.prepareForPaper(file,context,"unknown",signal());assert.equal(plan.paperId,saved.paperId);
  const displayed=await x.local.present(plan.requestId);assert.equal((await x.local.save(plan.requestId,displayed.digest)).phase,"saved");
  assert.equal((await x.records.read(saved.paperId)).revisions.length,1);assert.deepEqual((await x.records.read(saved.paperId)).current.record.bibliography,base.identity);
  const stale={...context,paperId:"p-"+randomUUID()},before=new Map(x.journal.files);await assert.rejects(x.local.prepareForPaper(file,stale,"unknown",signal()),/关联已变化/);assert.deepEqual(x.journal.files,before);
 });
 await check("existing original actions are read-only and bound to the preview's exact manifest and paper",async()=>{
  const x=setup(),{context}=await known(x),plan=await x.local.prepareForPaper(file,context,"unknown",signal()),shown=await x.local.present(plan.requestId);await x.local.save(plan.requestId,shown.digest);
  const preview=await x.metadata.prepare(base.ids.doi,signal()),before=new Map(x.journal.files);assert.equal(preview.sources.length,1);assert.match(preview.sources[0].label,/本地 PDF.*未核验/);
  const key=preview.sources[0].packageKey;preview.sources[0].path="wrong.pdf";
  assert.equal((await x.metadata.source(preview,key,signal())).path,`papers/${key}/source.pdf`);assert.deepEqual(x.journal.files,before);
  await assert.rejects(x.metadata.source(preview,"unrelated",signal()),/不属于/);
  x.storage.files.set(`papers/${key}/source.pdf`,Buffer.from("modified"));await assert.rejects(x.metadata.source(preview,key,signal()),/修改|大小|limit/);
 });
 await check("confirmed acquisition persists the identity, deduplicates clicks and preserves explicit disabled fallback",async()=>{
  const a=acq();a.backend.unpaywallEnabled=true;const original=structuredClone(base.identity),req={...base.request(),useUnpaywall:false};
  const first=a.service.startConfirmed(req,original);original.title="mutated after dispatch";
  const [one,two]=await Promise.all([first,a.service.startConfirmed(req,base.identity)]);assert.equal(one.id,two.id);
  await waitFor(()=>a.service.get(one.id).phase==="no_match");const job=a.service.get(one.id);assert.deepEqual(job.identity,base.identity);assert.deepEqual(job.confirmedIdentity,base.identity);assert.equal(job.request.useUnpaywall,undefined);assert.equal(a.observed.length,1);
  const changed={...job,identity:{...base.identity,title:"different"}};assert.throws(()=>decodeJob(changed,"production"),/已确认/);
  assert.throws(()=>decodeJob({...job,request:{...job.request,input:{kind:"doi",value:"10.1234/other"}}},"production"),/已确认/);
  await assert.rejects(a.service.startConfirmed({...req,input:{kind:"doi",value:"10.1234/other"}},base.identity),/不一致/);
 });
 await check("retry after process restart keeps confirmed identity and performs no background lookup on load",async()=>{
  const gate=deferred(),a=acq(undefined,{mode:"production",resolve:async()=>{throw new Error("requery");},discover:()=>gate.promise});
  const job=await a.service.startConfirmed(base.request(),base.identity);await waitFor(()=>a.service.get(job.id).phase==="discovering");await a.service.dispose();gate.resolve([]);
  const next=acq(a.storage);await next.service.ready();assert.equal(next.observed.length,0);assert.equal(next.service.get(job.id).phase,"interrupted");
  await next.service.retry(job.id);await waitFor(()=>next.service.get(job.id).phase==="no_match");assert.deepEqual(next.observed[0],base.identity);
 });
 await check("real provider discovery and PDF validation use the confirmed identity with no metadata requests; identical saved snapshots reuse",async()=>{
  const transport=base.transport(),store=base.store(),backend=new PmcAcquisitionBackend(transport,store,base.pdfLoader()),a=acq(store,backend);
  const job=await a.service.startConfirmed(base.request(),base.identity);await waitFor(()=>a.service.get(job.id).phase==="awaiting_selection");
  assert.ok(transport.calls.length);assert.ok(!transport.calls.some(url=>/ebi.ac.uk|crossref.org/.test(url)));assert.equal(transport.downloads,0);
  await a.service.choose(job.id,a.service.get(job.id).candidates[0].id);await waitFor(()=>a.service.get(job.id).phase==="acquired");assert.equal(transport.downloads,1);
  const calls=transport.calls.length,repeat=await a.service.startConfirmed(base.request(),base.identity);assert.equal(repeat.id,job.id);assert.equal(transport.calls.length,calls);
  const different={...base.identity,identifiers:{...base.ids,doi:"10.1234/other"}},other=await a.service.startConfirmed(base.request(),different);
  assert.notEqual(other.id,job.id);await waitFor(()=>["conflict","no_match","failed"].includes(a.service.get(other.id).phase));assert.equal(transport.downloads,1);
 });
 await check("late handoff after modal close never opens another window; downstream failure keeps saved metadata retryable",async()=>{
  for(const close of [false,true]){
   const gate=deferred(),preview={},view=Object.create(MetadataIntakeModal.prototype);let opens=0;
   Object.assign(view,{closed:false,saving:false,generation:1,preview,saved:{paperId:"p-existing"},validateButtons(){},status:{text:"",setText(s){this.text=s;}},close(){this.closed=true;}});
   const pending=view.runAction(preview,async signal=>{await gate.promise;signal.throwIfAborted();opens++;throw new Error("downstream unavailable");});
   if(close){view.closed=true;view.generation++;view.request.abort();}gate.resolve();await pending;
   assert.equal(opens,close?0:1);if(!close){assert.match(view.status.text,/书目信息已保留/);assert.equal(view.saving,false);assert.equal(view.saved.paperId,"p-existing");}
  }
 });
 await check("confirmed JATS retains the selected format, figure policy and identity through acquisition and explicit refresh",async()=>{
  const j=require("./jats-fixtures.cjs").fixture(),backend={mode:"production",resolve:async()=>{throw new Error("must not requery JATS identity");},
   discover:(request,signal,identity)=>j.provider.discover(request,identity,signal),
   downloadJats:(candidate,signal,progress,context)=>j.provider.download(candidate,context.request,context.identity,context.attemptId,signal,progress,context.budget),readJatsSnapshot:s=>j.provider.read(s)};
  const a=acq(undefined,backend),job=await a.service.startConfirmed({...j.request,includeFigures:false},j.identity);
  await waitFor(()=>a.service.get(job.id).phase==="awaiting_selection");await a.service.choose(job.id,a.service.get(job.id).candidates[0].id);
  await waitFor(()=>["acquired","failed"].includes(a.service.get(job.id).phase));assert.equal(a.service.get(job.id).phase,"acquired",a.service.get(job.id).error);
  const preview=await a.service.previewJats(job.id);assert.equal(preview.snapshot.artifact.includeFigures,false);assert.deepEqual(preview.snapshot.identity,j.identity);
  const refreshed=await a.service.refreshJats(job.id);assert.notEqual(refreshed.id,job.id);assert.deepEqual(refreshed.confirmedIdentity,j.identity);assert.equal(refreshed.request.includeFigures,false);
  await waitFor(()=>a.service.get(refreshed.id).phase==="awaiting_selection");a.service.stop(refreshed.id);await a.service.settled();
 });
 console.log("PAPER_INTAKE_OK (8 groups; memory stores, simulated transport/parser/raster, no external calls)");
}finally{await Promise.all(services.map(s=>s.dispose()));}})().catch(error=>{console.error(error);process.exitCode=1;});
