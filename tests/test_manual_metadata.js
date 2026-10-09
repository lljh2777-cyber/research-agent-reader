"use strict";
// Real validation, journal and library on memory storage; no model, network, disk or cleanup.
const assert=require("node:assert/strict"),path=require("node:path"),{loadReading}=require("./reading-test-helpers"),f=require("./source-intake-fixtures.cjs"),{identity}=require("./fulltext-pmc-fixtures.cjs");
const {MetadataIntakeService}=loadReading("library/metadata-intake.ts"),{JournalPaperRecordStore,readPaperRecordIdentities,validatePaperRecord}=loadReading("library/record-store.ts"),{SourceCatalog}=loadReading("papers/catalog.ts"),{readPaperLibrary}=loadReading("library/reader.ts"),{filterLibrary,associationLabel}=loadReading("library/browser.ts"),{continuationBlockReason}=loadReading("library/paper-continuation.ts"),{projectLibrary}=loadReading("library/projection.ts");
const signal=()=>new AbortController().signal,input={title:identity.title,authors:"User Author\nSecond Author",year:"2026",reference:identity.identifiers.doi,notes:"Personal clue, not source evidence."};
function setup(){const plugin=f.storage(),vault=f.storage(),store=new JournalPaperRecordStore(plugin);let calls=0;const resolver={async resolve(){calls++;return structuredClone(identity);}},catalog=new SourceCatalog(vault,undefined,()=>readPaperRecordIdentities(plugin)),service=new MetadataIntakeService(resolver,catalog,store);return {plugin,vault,store,service,catalog,resolver,calls:()=>calls,scan:()=>readPaperLibrary(vault,plugin,{vaultRoot:path.resolve("manual-memory"),parseYaml:JSON.parse})};}
const check=async(name,fn)=>{await fn();console.log("PASS manual metadata: "+name);};
(async()=>{
 await check("explicit preview is detached, local and retryable; persisted records reload as unverified",async()=>{
  const x=setup(),p=x.service.prepareManual(input);assert.equal(x.plugin.files.size,0);assert.equal(x.calls(),0);p.title="changed UI";p.manualBibliography.reference="changed UI";
  const results=await Promise.all([x.service.saveManual(p,signal()),x.service.saveManual(p,signal())]);assert.equal(results[0].paperId,results[1].paperId);assert.equal(results[1].reused,true);assert.equal(x.plugin.files.size,2);assert.equal(x.vault.files.size,0);
  const state=await new JournalPaperRecordStore(x.plugin).read(results[0].paperId);assert.equal(state.current.record.title,input.title);assert.equal(state.current.record.manualBibliography.reference,input.reference);assert.deepEqual(state.current.record.identifiers,{});assert.equal(state.current.record.bibliography,undefined);
  const scan=await x.scan(),paper=scan.papers[0];assert.equal(scan.papers.length,1);assert.equal(paper.association,"unidentified");assert.match(associationLabel(paper),/未核验/);assert.equal(filterLibrary(scan.papers,input.reference,"issues").length,1);assert.equal(filterLibrary(scan.papers,"Second Author 2026","all").length,1);assert.match(continuationBlockReason(paper,scan),/尚未核验/);
  const restarted=new MetadataIntakeService(x.resolver,x.catalog,new JournalPaperRecordStore(x.plugin));assert.deepEqual(await restarted.manualReference(paper.objects[0],signal()),{title:input.title,reference:input.reference});assert.equal(x.calls(),0);
 });
 await check("manual text never claims a DOI or merges a matching confirmed title; separate manual submissions stay separate",async()=>{
  const x=setup(),manual=await x.service.saveManual(x.service.prepareManual(input),signal()),other=await x.service.saveManual(x.service.prepareManual({...input,notes:"different clue"}),signal());assert.notEqual(manual.paperId,other.paperId);
  const before=new Map(x.plugin.files),plan=await x.service.prepare(input.reference,signal());assert.equal(plan.existing,false);const verified=await x.service.save(plan,signal());assert.notEqual(verified.paperId,manual.paperId);
  const scan=await x.scan();assert.equal(scan.papers.length,3);assert.equal(scan.papers.filter(p=>p.association==="identified").length,1);for(const[k,v]of before)assert.deepEqual(x.plugin.files.get(k),v);
  const match=await x.catalog.associate(identity);assert.equal(match.existingPaperId,verified.paperId);assert.equal(scan.papers.find(p=>p.paperId===manual.paperId).objects.length,1);
 });
 await check("schema rejects false verification, hidden IDs and invalid fields; old identity snapshots cannot be rewritten",async()=>{
  const x=setup();for(const bad of [{title:" "},{year:"abcd"},{year:"0000"},{reference:"x".repeat(1025)},{notes:"bad\u0000text"},{authors:"x\n".repeat(101)}])assert.throws(()=>x.service.prepareManual({...input,...bad}));
  const p=x.service.prepareManual(input),saved=await x.service.saveManual(p,signal()),current=(await x.store.read(saved.paperId)).current,record=current.record;
  for(const bad of [{bibliography:identity},{identifiers:identity.identifiers},{citekey:"test_2026"},{primaryNoteId:"wiki/sources/a.md"},{manualBibliography:{...record.manualBibliography,status:"verified"}}]){assert.throws(()=>validatePaperRecord({...record,...bad}));assert.throws(()=>projectLibrary([{...record,...bad}]));}
  await assert.rejects(x.store.append({...record,manualBibliography:{...record.manualBibliography,year:"2025"}},[current.digest]),/身份快照/);
  await assert.rejects(x.service.saveManual({...p},signal()),/预览已失效/);assert.equal(x.plugin.files.size,2);
 });
 await check("cancel, interrupted marker and committed-but-unreported saves preserve content and recover explicitly",async()=>{
  const x=setup(),p=x.service.prepareManual(input),c=new AbortController();c.abort();await assert.rejects(x.service.saveManual(p,c.signal));assert.equal(x.plugin.files.size,0);
  let first=true;x.plugin.before=async key=>{if(first&&key.endsWith(".ready")){first=false;throw new Error("disk full");}};await assert.rejects(x.service.saveManual(p,signal()),/disk full/);assert.equal(x.plugin.files.size,1);const retained=new Map(x.plugin.files);x.plugin.before=undefined;
  const saved=await x.service.saveManual(p,signal());const state=await x.store.read(saved.paperId);assert.equal(state.pending.length,1);assert.equal(state.revisions.length,1);for(const[k,v]of retained)assert.deepEqual(x.plugin.files.get(k),v);
  const y=setup(),q=y.service.prepareManual(input);let thrown=false;y.plugin.after=async key=>{if(!thrown&&key.endsWith(".ready")){thrown=true;throw new Error("acknowledgement failed");}};await assert.rejects(y.service.saveManual(q,signal()),/acknowledgement/);y.plugin.after=undefined;assert.equal((await y.service.saveManual(q,signal())).reused,true);assert.equal(y.plugin.files.size,2);
  await y.service.dispose();assert.throws(()=>y.service.prepareManual(input),/已关闭/);await assert.rejects(y.service.saveManual(q,signal()),/已关闭/);
 });
 await check("fresh continuation refuses changed or missing manual records without lookup",async()=>{
  const x=setup();await x.service.saveManual(x.service.prepareManual(input),signal());const item=(await x.scan()).papers[0].objects[0];await assert.rejects(x.service.manualReference({...item,manualBibliography:{...item.manualBibliography,reference:"other"}},signal()),/已变化/);
  const missing={...item,paperId:"p-00000000-0000-0000-0000-000000000000"};await assert.rejects(x.service.manualReference(missing,signal()),/已变化/);
  const ac=new AbortController();ac.abort();await assert.rejects(x.service.manualReference(item,ac.signal));assert.equal(x.calls(),0);
 });
 console.log("MANUAL_METADATA_OK (5 groups; memory storage and simulated resolver only)");
})().catch(e=>{console.error(e);process.exitCode=1;});
