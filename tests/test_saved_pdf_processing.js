"use strict";
// Memory packages and journals, simulated model/extractor, no external calls or file deletion.
const assert=require("node:assert/strict"),path=require("node:path"),{randomUUID}=require("node:crypto");
const {loadReading}=require("./reading-test-helpers"),f=require("./source-intake-fixtures.cjs"),base=require("./fulltext-pmc-fixtures.cjs");
const {SourceIntakeService}=loadReading("papers/source-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts"),{prepareLocalPdf}=loadReading("papers/local-pdf.ts");
const {readSavedPdf,decodeSavedPdfRef}=loadReading("papers/saved-pdf.ts"),{loadPdfSource}=loadReading("sources/pdf-package.ts"),{sourceConfirmation}=loadReading("papers/confirmation.ts"),{bytesDigest}=loadReading("papers/identity.ts");
const {validateIngestRequest,validateIngestRequestForTask}=loadReading("agent/ingest-records.ts");
const root=path.resolve("saved-vault"),signal=()=>new AbortController().signal,all=[];
const check=async(name,fn)=>{await fn();console.log("PASS saved PDF: "+name);};
async function setup(local){
 const storage=f.storage(),catalog=new SourceCatalog(storage),journal=f.storage();
 const input=local?await prepareLocalPdf(path.resolve("selected.pdf"),base.identity,signal(),{read:async()=>Buffer.from(base.bytes),pdfLoader:base.pdfLoader()}):f.source();
 const service=new SourceIntakeService({deviceId:f.sha("device"),catalog,journal,index:f.index(),readSource:async()=>input,render:async()=>f.raster(),link:async()=>{}});all.push(service);
 const plan=await service.prepare(input.snapshot.jobId||input.snapshot.id),shown=await service.present(plan.requestId),saved=await service.save(plan.requestId,shown.digest);assert.equal(saved.phase,"saved",saved.error);
 const pkg=await loadPdfSource(storage,saved.packageKey),m=pkg.manifest;
 const ref={packageKey:m.packageKey,manifestDigest:m.digest,paperId:m.paperId,sha256:m.files[0].sha256,byteLength:m.files[0].byteLength};
 return{storage,catalog,journal,ref,pkg};
}
const optionsFor=x=>({identityMode:"source-v2",savedPdfSource:x.ref,sourcePdfPath:path.join(root,"papers",x.ref.packageKey,"source.pdf"),requestNotes:"",identityCandidateTitle:base.title,identityCandidateDoi:base.ids.doi,createArticleMarkdown:true,createArticleWiki:false,articleWikiSource:"pdf",mineruModel:"vlm",mineruLanguage:"en",mineruOcr:false,mineruFormula:true,mineruTable:true,mineruPages:"",mineruTimeoutSeconds:600,mineruIncludeSourcePdf:false,remoteUploadConfirmed:true});
const {catalogIntake}=loadReading("papers/agent-intake.ts",{"./identity-modal":{confirmSourceIdentity:async(_app,id,snapshot)=>{const{rasterDataUrl,...r}=f.raster();return sourceConfirmation(id,snapshot,{...r,kind:"pdf",pngSha256:bytesDigest(Buffer.from(rasterDataUrl.slice(22),"base64"))});}}});
(async()=>{try{
 for(const local of [false,true])await check((local?"local":"online")+" package is processed independently of downloads and preserves its exact identity",async()=>{
  const x=await setup(local),before=new Map(x.storage.files),read=await readSavedPdf(x.catalog,root,x.ref,signal());
  assert.deepEqual(read.snapshot,x.pkg.snapshot);assert.equal(read.path,path.join(root,"papers",x.ref.packageKey,"source.pdf"));
  const options=optionsFor(x),authorized={path:read.path,sha256:x.ref.sha256,size:x.ref.byteLength};
  const decision=await catalogIntake({},x.catalog,undefined,options,authorized,signal(),root);assert.equal(decision.identity.citekey,x.pkg.manifest.citekey);assert.equal(decision.identity.title,x.pkg.manifest.identity.title);assert.equal(decision.confirmation.snapshotId,x.pkg.snapshot.id);
  assert.deepEqual(x.storage.files,before);const req={version:1,runId:"saved",profileId:"",options};assert.deepEqual(validateIngestRequest(req,"saved"),req);
  const task={id:"saved",savedPdfSource:x.ref};assert.deepEqual(validateIngestRequestForTask(req,task),req);
  assert.deepEqual(validateIngestRequestForTask({...req,options:{...options,savedPdfSource:Object.fromEntries(Object.entries(x.ref).reverse())}},task),req);
  assert.throws(()=>validateIngestRequestForTask({...req,options:{...options,savedPdfSource:{...x.ref,sha256:"0".repeat(64)}}},task),/任务绑定/);
  assert.throws(()=>validateIngestRequestForTask({...req,options:{...options,savedPdfSource:undefined,identityMode:undefined}},task),/任务绑定/);
  for(const bad of [{...x.ref,manifestDigest:"a".repeat(64)},{...x.ref,paperId:"p-"+randomUUID()},{...x.ref,sha256:"0".repeat(64)}])await assert.rejects(readSavedPdf(x.catalog,root,bad,signal()),/变化/);
  assert.throws(()=>decodeSavedPdfRef({...x.ref,packageKey:"../other"}));assert.throws(()=>validateIngestRequest({...req,options:{...options,identityMode:undefined}},"saved"));
  assert.throws(()=>validateIngestRequest({...req,options:{...options,acquisitionSource:{}}},"saved"));
  const ac=new AbortController();ac.abort();await assert.rejects(readSavedPdf(x.catalog,root,x.ref,ac.signal));
  x.storage.files.set(`papers/${x.ref.packageKey}/source.pdf`,Buffer.from("changed"));await assert.rejects(readSavedPdf(x.catalog,root,x.ref,signal()),/修改/);
 });
 await check("model-free conversion skips provider resolution and preserves staging; a changed source blocks publication",async()=>{
  const x=await setup(true),options=optionsFor(x),authorized={path:options.sourcePdfPath,sha256:x.ref.sha256,size:x.ref.byteLength};
  const decision=await catalogIntake({},x.catalog,undefined,options,authorized,signal(),root);let providerCalls=0,modelCalls=0,extractions=0,verifications=0,retained=false,lateChange=false,publications=0;
  const flow=loadReading("agent/paper-ingest-flow.ts");
  const {AgentLoopService}=loadReading("agent/agent-loop-service.ts",{"./paper-ingest-flow":{...flow,mineruReadiness:()=>({ready:true}),runAuthorizedMineruExtract:async(_deps,_args,context)=>{extractions++;retained=context.retainStaging;await context.verifySourceBeforePublish();publications++;throw new Error("simulation ends before publishing");}},"./loop":{runBoundedAgentLoop:async()=>{modelCalls++;throw new Error("simulated model failure");}},"./pdf-identity":{createAuthorizedPdfSnapshot:async(_p,o)=>{assert.equal(o.retainFiles,true);assert.deepEqual(o.expected,x.ref);return authorized;},disposeAuthorizedPdfSnapshot:async()=>{},extractLocalPdfIdentityEvidence:async()=>({status:"available",doiCandidates:[],pageCount:2,warning:""})}});
  const deps={app:{vault:{adapter:{}}},getSettings:()=>({}),getProvider:()=>{providerCalls++;return null;},getLexicalRetriever:()=>({}),getVaultRoot:()=>root,getTavilySecret:()=>"",prepareSourceIntake:async()=>decision,verifySavedSource:async()=>{verifications++;if(lateChange&&verifications===3)throw new Error("source changed before publication");await readSavedPdf(x.catalog,root,x.ref,signal());}};
  const service=new AgentLoopService(deps);all.push({dispose:()=>service.shutdown()});
  deps.prepareSourceIntake=async()=>({...decision,sourcePath:"papers/converted/article.md"});const existing=await service.runPaperIngest("reuse",options,"");assert.equal(existing.exitCode,0,existing.stdout);assert.equal(providerCalls,0);assert.equal(existing.executionConfig.model,"");
  deps.prepareSourceIntake=async()=>decision;const result=await service.runPaperIngest("new",options,"");assert.equal(result.exitCode,1);assert.equal(extractions,1);assert.equal(retained,true);assert.ok(verifications>=4);assert.equal(providerCalls+modelCalls,0);
  lateChange=true;verifications=0;const published=publications;const late=await service.runPaperIngest("late-change",options,"");assert.equal(late.exitCode,1);assert.equal(extractions,2);assert.equal(verifications,3);assert.equal(publications,published);assert.match(late.stdout,/source changed before publication/);
  const before=extractions;deps.verifySavedSource=async()=>{throw new Error("source changed");};const changed=await service.runPaperIngest("changed",options,"");assert.equal(changed.exitCode,1);assert.equal(extractions,before);
  await assert.rejects(service.runPaperIngest("wiki",{...options,createArticleWiki:true},"missing"),/Direct API/);
  await assert.rejects(service.runPaperIngest("legacy",{...options,savedPdfSource:undefined,identityMode:undefined},"missing"),/Direct API/);
 });
 await check("saved task bindings survive retention/reload and reject a different continuation before request writes",async()=>{
  const x=await setup(true);class Base{};const obsidian={Plugin:Base,PluginSettingTab:Base,Component:Base,ItemView:Base,Modal:Base,TFile:Base,FileSystemAdapter:Base,Notice:Base,normalizePath:p=>p.replace(/\\/g,"/")};
  const Plugin=loadReading("plugin.ts",{obsidian,electron:{}}).default,plugin=new Plugin();plugin.settings={taskHistoryLimit:5};plugin.saveSettings=async()=>{};plugin.persistTaskRunOutput=async()=>"";plugin.deleteTaskRunOutput=async()=>{throw new Error("must not delete");};plugin.taskRuns=Array.from({length:8},(_,i)=>({id:"old-"+i,actionId:"old",status:"done"}));
  const run=await plugin.startTaskRun({id:"paper-ingest",label:"intake",agent:"intake"},"saved",null,undefined,x.ref);await plugin.finishTaskRun(run.id,{status:"failed",error:"simulated"});assert.equal(plugin.taskRuns.length,9);
  const{normalizeStoredTaskRuns}=loadReading("runtime/persistence.ts");assert.deepEqual(normalizeStoredTaskRuns(plugin.taskRuns,5).find(r=>r.id===run.id).savedPdfSource,x.ref);
  let writes=0;plugin.validateSavedPdfIntake=async()=>{};plugin.getIngestRecords=()=>({write:async()=>{writes++;}});
  await assert.rejects(plugin.runLightPaperIngest(run.id,{...optionsFor(x),savedPdfSource:{...x.ref,sha256:"0".repeat(64)}},""),/任务绑定/);assert.equal(writes,0);
 });
 console.log("SAVED_PDF_PROCESSING_OK (4 groups; memory stores, simulated extraction, no model/network calls)");
}finally{await Promise.all(all.map(s=>s.dispose()));}})().catch(e=>{console.error(e);process.exitCode=1;});
