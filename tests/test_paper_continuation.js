"use strict";
// Real journal/catalog/intake logic with memory files and simulated PDF data; no cleanup/network.
const assert=require("node:assert/strict"),path=require("node:path"),{randomUUID}=require("node:crypto");
const {loadReading}=require("./reading-test-helpers"),f=require("./source-intake-fixtures.cjs"),base=require("./fulltext-pmc-fixtures.cjs");
const {MetadataIntakeService}=loadReading("library/metadata-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts");
const {JournalPaperRecordStore,readPaperRecordIdentities}=loadReading("library/record-store.ts"),{projectLibrary}=loadReading("library/projection.ts");
const {savedPaperContext,continuationBlockReason}=loadReading("library/paper-continuation.ts"),{LocalPdfIntakeService}=loadReading("papers/local-pdf-intake.ts");
class Element {
 constructor(tag="div",opts={}){this.tag=tag;this.children=[];this.attrs=opts.attr||{};this.textContent=opts.text||"";this.dataset={};}
 createEl(tag,opts){const e=new Element(tag,opts);this.children.push(e);return e;}
 createDiv(opts){return this.createEl("div",typeof opts==="string"?{}:opts);}
 empty(){this.children=[];} addClass(){} contains(){return false;} addEventListener(event,fn){this[event]=fn;}
 querySelectorAll(){return [];} all(){return this.children.flatMap(e=>[e,...e.all()]);}
}
const {FulltextAcquisitionModal}=loadReading("fulltext/modal.ts",{obsidian:{Modal:class{},Notice:class{}}});
const services=[],signal=()=>new AbortController().signal,check=async(name,fn)=>{await fn();console.log("PASS continuation: "+name);};
function setup(){
 const storage=f.storage(),journal=f.storage(),records=new JournalPaperRecordStore(journal),catalog=new SourceCatalog(storage,undefined,()=>readPaperRecordIdentities(journal));
 const metadata=new MetadataIntakeService({resolve:async()=>structuredClone(base.identity)},catalog,records);
 const local=new LocalPdfIntakeService({deviceId:f.sha("continuation"),catalog,journal,index:f.index(),resolver:{resolve:async()=>{throw new Error("unexpected lookup");}},read:async()=>Buffer.from(base.bytes),pdfLoader:base.pdfLoader(),render:async()=>f.raster(),link:async()=>{}});
 services.push(metadata,local);return{storage,journal,records,catalog,metadata,local};
}
async function saved(x){const preview=await x.metadata.prepare(base.ids.doi,signal()),result=await x.metadata.save(preview,signal());return x.metadata.context(preview,signal(),result.paperId);}
async function data(x,id){const state=await x.records.read(id);return{...projectLibrary([state.current.record]),readIssues:[],recordStates:[{paperId:id,heads:state.heads,blocked:false,pending:[]}],complete:true};}
async function saveLocal(x,context){const plan=await x.local.prepareForPaper(path.resolve("fixtures","paper.pdf"),context,"unknown",signal()),shown=await x.local.present(plan.requestId);await x.local.save(plan.requestId,shown.digest);x.local.cancel(plan.requestId);return plan;}
(async()=>{try{
 await check("saved detail resolves without lookup or writes and retains decisions",async()=>{
  const x=setup(),context=await saved(x),state=await x.records.read(context.paperId);await x.records.append({...state.current.record,readingState:"revisit"},state.heads);
  const before=new Map(x.journal.files),fresh=await data(x,context.paperId);x.metadata.resolver.resolve=async()=>{throw new Error("no lookup");};
  assert.equal(continuationBlockReason(fresh.papers[0],fresh),undefined);
  const next=await x.metadata.savedContext(savedPaperContext(fresh.papers[0],fresh),signal());assert.deepEqual(next,context);next.identity.title="mutated";
  assert.deepEqual(await x.metadata.savedContext(context,signal()),context);assert.deepEqual(x.journal.files,before);
 });
 await check("stale, missing, legacy, conflicting and incomplete detail cannot continue",async()=>{
  const x=setup(),context=await saved(x),fresh=await data(x,context.paperId),paper=fresh.papers[0];
  for(const variant of [{...paper,association:"conflict"},{...paper,paperId:undefined},{...paper,objects:paper.objects.map(o=>({...o,bibliography:undefined}))}]) assert.ok(continuationBlockReason(variant,fresh));
  assert.throws(()=>savedPaperContext({...paper,objects:paper.objects.map(o=>({...o,bibliography:{...o.bibliography,title:"old"}}))},fresh),/变化/);
  assert.throws(()=>savedPaperContext(paper,{...fresh,papers:[]}),/变化/);
  assert.throws(()=>savedPaperContext(paper,{...fresh,papers:[paper,paper]}),/变化/);
  assert.throws(()=>savedPaperContext(paper,{...fresh,readIssues:[{area:"records",message:"invalid"}]}),/不完整/);
  assert.throws(()=>savedPaperContext(paper,{...fresh,recordStates:[{paperId:context.paperId,heads:["a","b"]}]}),/并发/);
  await assert.rejects(x.metadata.savedContext({...context,identity:{...context.identity,title:"forged"}},signal()),/变化/);
  const abort=new AbortController();abort.abort();await assert.rejects(x.metadata.savedContext(context,abort.signal));
  const state=await x.records.read(context.paperId),branch=f.storage();for(const dir of x.journal.dirs)branch.dirs.add(dir);for(const [key,value] of x.journal.files)branch.files.set(key,value);
  await new JournalPaperRecordStore(branch).append({...state.current.record,readingState:"reading"},state.heads);
  await x.records.append({...state.current.record,readingState:"completed"},state.heads);
  for(const [key,value] of branch.files)if(!x.journal.files.has(key))x.journal.files.set(key,value);
  await assert.rejects(x.metadata.savedContext(context,signal()),/唯一/);
 });
 await check("late cancellation and changed catalog owner cannot open a continuation",async()=>{
  const x=setup(),context=await saved(x),original=x.catalog.associate.bind(x.catalog),abort=new AbortController();
  x.catalog.associate=async i=>{const result=await original(i);abort.abort();return result;};await assert.rejects(x.metadata.savedContext(context,abort.signal));
  x.catalog.associate=async i=>({...await original(i),existingPaperId:"p-"+randomUUID()});await assert.rejects(x.metadata.savedContext(context,signal()),/关联/);
 });
 await check("local history is scoped by exact IDs; resume retains its snapshot and requires the same paper owner",async()=>{
  const x=setup(),context=await saved(x),plan=await saveLocal(x,context),all=await x.local.history();assert.equal(all.length,1);
  assert.equal((await x.local.history(context.identity))[0].id,plan.jobId);
  const unrelated={...context.identity,identifiers:{doi:"10.1234/unrelated"}},conflict={...context.identity,identifiers:{...context.identity.identifiers,pmid:"99999999"}};
  assert.equal((await x.local.history(unrelated)).length,0);assert.equal((await x.local.history(conflict)).length,0);
  const before=new Map(x.journal.files);await assert.rejects(x.local.resume(plan.jobId,signal(),undefined,{...context,identity:unrelated}),/不属于/);
  await assert.rejects(x.local.resume(plan.jobId,signal(),undefined,{...context,paperId:"p-"+randomUUID()}),/关联/);
  const resumed=await x.local.resume(plan.jobId,signal(),undefined,context);assert.equal(resumed.paperId,context.paperId);assert.equal(resumed.jobId,plan.jobId);assert.deepEqual(resumed.snapshot.identity,context.identity);x.local.cancel(resumed.requestId);
  assert.deepEqual(x.journal.files,before);
 });
 await check("unreadable local records stay visible as unassigned warnings and cannot be resumed",async()=>{
  const x=setup(),context=await saved(x),plan=await saveLocal(x,context);x.journal.files.set(`local-pdf-intake/${plan.jobId}.json`,Buffer.from("{"));
  const rows=await x.local.history(context.identity);assert.equal(rows[0].state,"unavailable");assert.match(rows[0].title,/归属/);await assert.rejects(x.local.resume(plan.jobId,signal(),undefined,context));
 });
 await check("fulltext history excludes unrelated/conflicting papers and retries the selected old ID without replacing metadata",async()=>{
  const oldDocument=global.document;global.document={activeElement:null};
  try{
   const jobs=[{id:"old",identity:{...base.identity,title:"Earlier metadata"}},{id:"unresolved"},{id:"unrelated",identity:{...base.identity,identifiers:{doi:"10.1234/other"}}},{id:"conflict",identity:{...base.identity,identifiers:{...base.ids,pmid:"99999999"}}}].map(j=>({mode:"production",request:base.request(),phase:"cancelled",detail:"stopped",...j}));
   const retried=[],service={mode:"production",list:()=>jobs,diagnostics:[],owned:()=>true,retry:async id=>retried.push(id)};
   const view=new FulltextAcquisitionModal({},service,undefined,undefined,undefined,undefined,base.identity);view.jobsEl=new Element();view.renderJobs();
   assert.deepEqual(view.jobsEl.all().filter(e=>e.attrs["data-job-id"]).map(e=>e.attrs["data-job-id"]),["old","unresolved"]);
   const retry=view.jobsEl.all().find(e=>e.attrs["data-fulltext-key"]==="old:retry");retry.click();await new Promise(r=>setImmediate(r));assert.deepEqual(retried,["old"]);assert.equal(jobs[0].identity.title,"Earlier metadata");
   const legacy=new FulltextAcquisitionModal({},service);legacy.jobsEl=new Element();legacy.renderJobs();assert.equal(legacy.jobsEl.all().filter(e=>e.attrs["data-job-id"]).length,4);
  }finally{global.document=oldDocument;}
 });
 console.log("PAPER_CONTINUATION_OK (6 groups; no external calls or filesystem writes)");
}finally{await Promise.all(services.map(s=>s.dispose()));}})().catch(e=>{console.error(e);process.exitCode=1;});
