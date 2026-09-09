"use strict";
// Read and render an already acquired public PDF. All publication, confirmations,
// acquisition links and index writes are isolated in memory; no model or MinerU.
module.exports=async function(app){
 const assert=require("node:assert/strict"),{setTimeout}=require("node:timers"),f=require("./source-intake-fixtures.cjs"),{memory}=require("./fulltext-fixtures.cjs");
 const plugin=app.plugins.plugins["research-agent-reader"],previous=plugin.getAcquisitionService();await previous.ready();
 if(plugin.isActionRunning("paper-ingest")||plugin.acquisitionDialogs.size)throw new Error("Close intake dialogs and finish current intake before QA");
 const job=previous.list().find(j=>j.phase==="acquired"&&j.identity?.identifiers?.doi==="10.21105/joss.01143")||previous.list().find(j=>j.phase==="acquired");
 if(!job)throw new Error("An acquired public PDF is needed");
 const snapshot=await previous.repository.snapshot(job.snapshotId),acqStorage=memory();acqStorage.jobs.set(job.id,structuredClone(job));acqStorage.snapshots.set(snapshot.id,structuredClone(snapshot));
 const acquisition=new previous.constructor(new previous.repository.constructor(acqStorage,"production"),previous.deviceId,previous.backend);await acquisition.ready();
 const originalSource=plugin.getSourceIntakeService(),catalog= new (plugin.getSourceCatalog().constructor)(f.storage()),journal=f.storage(),index=f.index();
 const deps={...originalSource.deps,catalog,journal,index,link:(id,key)=>acquisition.linkSourcePackage(id,key)};
 let source=new originalSource.constructor(deps);const checks=[],settings=JSON.stringify(plugin.settings),oldProfiles=plugin.getVerifiedProviderProfiles,oldCatalog=plugin.getSourceCatalog;
 const transport=previous.backend.transport,oldMetadata=transport.metadata,oldDownload=transport.download;let off,acqModal;
 const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
 const wait=async(fn,label)=>{for(let i=0;i<600;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error("Timeout: "+label);};
 const dialog=()=>[...plugin.acquisitionDialogs].find(m=>m.modalEl.matches(".rar-source-save-modal"));
 const open=async()=>{acqModal.contentEl.querySelector(`[data-job-id="${job.id}"] [data-fulltext-action="save-source"]`)?.click();if(!dialog())acqModal.contentEl.querySelector('[data-fulltext-action="save-source"]')?.click();await wait(()=>dialog(),"source dialog");return dialog();};
 try{
  transport.metadata=transport.download=async()=>{throw new Error("Native M4 QA must not use the network");};
  plugin.acquisitionServices.set("production",acquisition);plugin.sourceIntakeService=source;plugin.getSourceCatalog=()=>catalog;plugin.getVerifiedProviderProfiles=()=>[];
  off=acquisition.subscribe(()=>plugin.notifyTaskRuns());plugin.openFulltextAcquisition("production",job.id);acqModal=[...plugin.acquisitionModals].find(m=>m.service===acquisition);
  await wait(()=>acqModal.contentEl.querySelector('[data-fulltext-action="save-source"]'),"source entry");
  let modal=await open(),button=modal.contentEl.querySelector('[data-source-action="save"]');check(button.disabled,"confirmation starts disabled before actual raster display");
  await wait(()=>!button.disabled,"PDF raster");check(modal.contentEl.querySelector("img").naturalWidth>100,"real local PDF rendered at useful resolution");check(catalog.storage.writes.length+journal.writes.length===0,"displaying title page is read-only");
  for(const width of [360,680]){modal.modalEl.style.width=width+"px";await new Promise(r=>setTimeout(r,50));check(modal.contentEl.scrollWidth<=modal.contentEl.clientWidth+2,"source confirmation fits width "+width);}
  modal.close();check(plugin.acquisitionDialogs.size===0,"closing releases the tracked dialog");check(catalog.storage.writes.length===0,"cancel leaves no official files");
  modal=await open();button=modal.contentEl.querySelector('[data-source-action="save"]');await wait(()=>!button.disabled,"second PDF raster");
  index.fail=true;const first=button.onclick();await button.onclick();await first;
  check(modal.contentEl.textContent.includes("登记待完成"),"index failure is distinct from successful publication");
  const paths=[...catalog.storage.files.keys()],manifestPath=paths.find(p=>p.endsWith("/_source/manifest.json")),manifest=JSON.parse(catalog.storage.files.get(manifestPath));
  check(catalog.storage.writes.at(-1)===manifestPath,"manifest is the final official write");check(paths.filter(p=>p.endsWith("/source.pdf")).length===1&&!paths.some(p=>p.endsWith("/article.md")),"one PDF source without invented body or Wiki");
  const validation=JSON.parse(catalog.storage.files.get(manifestPath.replace("manifest.json","validation.json")));check(validation.confirmation.schemaVersion===2&&validation.confirmation.primaryArtifactHash===snapshot.artifact.sha256,"v2 confirmation binds real PDF bytes in memory only");
  check(acquisition.get(job.id).sourcePackages.includes(manifest.packageKey),"acquisition links the committed source independently of index status");
  check(catalog.storage.writes.filter(p=>p.endsWith("/source.pdf")).length===1,"double click never copies twice");modal.close();
  await source.dispose();source=new originalSource.constructor(deps);plugin.sourceIntakeService=source;index.fail=false;index.text="# QA index\n\nUser text to preserve\n";
  modal=await open();button=modal.contentEl.querySelector('[data-source-action="save"]');check(!button.disabled&&modal.contentEl.querySelector("img").hidden,"restart recognizes an already confirmed package");await button.onclick();
  check(modal.contentEl.textContent.includes("原文已保存并登记"),"registration retry completes without PDF copying");check(index.text.includes("User text to preserve")&&index.text.includes(manifest.packageKey),"index repair preserves existing text");modal.close();
  check(catalog.storage.writes.filter(p=>p.endsWith("/source.pdf")).length===1,"restart reuses the immutable package");
  const sourceRef=await acquisition.intakeSource(job.id),controller=new AbortController();
  const options={identityMode:"source-v2",acquisitionSource:{jobId:job.id,snapshotId:snapshot.id,sha256:snapshot.artifact.sha256,byteLength:snapshot.artifact.byteLength},sourcePdfPath:sourceRef.path,createArticleMarkdown:false,createArticleWiki:true,articleWikiSource:"pdf",mineruModel:"auto",mineruLanguage:"en",mineruOcr:false,mineruFormula:true,mineruTable:true,mineruPages:"",mineruIncludeSourcePdf:false};
  const confirmation=plugin.agentLoopService.deps.prepareSourceIntake(options,{path:sourceRef.path,sha256:snapshot.artifact.sha256,size:snapshot.artifact.byteLength},controller.signal);
  await wait(()=>document.querySelector('[data-source-action="confirm-identity"]'),"v2 identity presenter");const confirm=document.querySelector('[data-source-action="confirm-identity"]');await wait(()=>!confirm.disabled,"v2 actual raster");confirm.click();const decision=await confirmation;
  check(decision.confirmation.schemaVersion===2&&decision.identity.citekey===manifest.citekey,"new intake uses canonical catalog identity and actual v2 presenter");check(decision.sourcePath===""&&decision.analysisPath==="","PDF source does not imply converted body or Wiki");
  check(JSON.stringify(plugin.settings)===settings,"settings are unchanged");check(plugin.acquisitionDialogs.size===0,"all tracked source dialogs are released");
  return{ok:true,checks,realModelCalls:0,realMineruCalls:0,realNetworkCalls:0,officialPublication:"memory-only",pdfPageCount:snapshot.validation.pageCount};
 }finally{
  for(const modal of [...plugin.acquisitionDialogs])modal.close();document.querySelector('[data-source-action="confirm-identity"]')?.closest(".modal-container")?.querySelector(".modal-close-button")?.click();acqModal?.close();off?.();
  plugin.sourceIntakeService=originalSource;plugin.getSourceCatalog=oldCatalog;plugin.getVerifiedProviderProfiles=oldProfiles;plugin.acquisitionServices.set("production",previous);transport.metadata=oldMetadata;transport.download=oldDownload;await source.dispose();await acquisition.dispose();plugin.notifyTaskRuns();
 }
};
