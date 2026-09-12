"use strict";
// Real catalog and PDF package validation in memory. No network, model calls or file cleanup.
const assert=require("node:assert/strict"),path=require("node:path"),{randomUUID}=require("node:crypto");
const {loadReading}=require("./reading-test-helpers"),f=require("./source-intake-fixtures.cjs"),base=require("./fulltext-pmc-fixtures.cjs");
const {SourceIntakeService}=loadReading("papers/source-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts");
const {prepareLocalPdf}=loadReading("papers/local-pdf.ts"),{loadPdfSource}=loadReading("sources/pdf-package.ts");
const {readPaperLibrary}=loadReading("library/reader.ts"),{matchMineruOrigin,pdfOriginKey}=loadReading("library/mineru-origin.ts");
const {libraryNavigation}=loadReading("library/browser.ts"),{createReadingSession}=loadReading("reading/session.ts");
const root=path.resolve("memory-origin"),options={vaultRoot:root,parseYaml:JSON.parse};
const put=(st,name,content)=>{const pieces=name.split("/");for(let i=1;i<pieces.length;i++)st.dirs.add(pieces.slice(0,i).join("/"));st.files.set(name,Buffer.from(typeof content==="string"?content:JSON.stringify(content)));};
const readonly=st=>({read:st.read.bind(st),list:st.list.bind(st)});
const find=(result,id)=>result.papers.find(p=>p.objects.some(o=>o.id===id));
const object=(result,id)=>find(result,id).objects.find(o=>o.id===id);
let count=0;const check=async(name,fn)=>{await fn();console.log("PASS MinerU origin: "+name);count++;};
(async()=>{
 const st=f.storage(),ps=f.storage(),catalog=new SourceCatalog(st),pdfs=[];
 for(const local of [false,true]){
  const input=local?await prepareLocalPdf(path.join(root,"input.pdf"),base.identity,new AbortController().signal,{read:async()=>base.bytes,pdfLoader:base.pdfLoader()}):f.source();
  const service=new SourceIntakeService({deviceId:f.sha("device"),catalog,journal:f.storage(),index:f.index(),readSource:async()=>input,render:async()=>f.raster(),link:async()=>{}});
  try{const plan=await service.prepare(input.snapshot.jobId||input.snapshot.id),shown=await service.present(plan.requestId),saved=await service.save(plan.requestId,shown.digest);assert.equal(saved.phase,"saved",saved.error);pdfs.push((await loadPdfSource(st,saved.packageKey)).manifest);}finally{await service.dispose();}
 }
 const articlePath="papers/arbitrary-name/article.md",manifestPath="papers/arbitrary-name/_extraction/manifest.json",article="# Converted content\n\nEvidence body.\n";
 const manifest={schema_version:1,extractor:"mineru-open-api",source:{path:"../../external.pdf",sha256:pdfs[0].files[0].sha256,size:pdfs[0].files[0].byteLength},outputs:[{path:"article.md",size:Buffer.byteLength(article),sha256:f.sha(article)}]};
 put(st,articlePath,article);put(st,manifestPath,manifest);
 const index=new Map([[pdfOriginKey(manifest.source.sha256,manifest.source.size),pdfs.map(manifest=>({manifest,verified:true}))]]);
 const match=(m=manifest,a=article,ix=index,meta={identifiers:{}})=>matchMineruOrigin(Buffer.from(JSON.stringify(m)),Buffer.from(a),ix,meta);
 const read=extra=>readPaperLibrary(readonly(st),readonly(ps),{...options,...extra});
 await check("ordinary scans associate equal input bytes across local/online copies, retain separate versions and do not fully verify conversions",async()=>{
  const before=new Map(st.files),writes=st.writes.length,first=await read(),item=object(first,articlePath);
  assert.equal(first.papers.length,1);assert.equal(first.papers[0].objects.length,3);
  assert.equal(item.paperId,pdfs[0].paperId);assert.equal(item.title,pdfs[0].identity.title);
  assert.deepEqual(item.identifiers,pdfs[0].identity.identifiers);assert.equal(item.source.pdfOrigin.sourceIds.length,2);
  assert.equal(item.source.verification.state,"unverified");assert.equal(item.capabilities.openOriginal.available,false);
  assert.deepEqual(st.files,before);assert.equal(st.writes.length,writes);assert.deepEqual((await read()).papers,first.papers);
 });
 let verified;
 await check("explicit selected verification preserves the original fingerprint and only then enables source/session navigation",async()=>{
  let calls=0;const verifyMineru=async name=>{assert.equal(name,articlePath);calls++;};
  verified=await read({verifyMineruPath:articlePath,verifyMineru});const item=object(verified,articlePath);
  assert.equal(calls,1);assert.equal(item.source.verification.fingerprint,f.sha(article+JSON.stringify(manifest)));
  assert.equal(libraryNavigation(item,verified).path,articlePath);
  const session=createReadingSession({kind:"article",path:articlePath,title:item.title,fingerprint:item.source.verification.fingerprint});put(ps,"reading-sessions/"+session.id+".json",session);
  const withSession=await read({verifyMineruPath:articlePath,verifyMineru});assert.equal(find(withSession,articlePath).key,find(withSession,session.id).key);assert.equal(object(withSession,session.id).binding.state,"matched");
 });
 await check("damaged PDFs and changed conversions cannot inherit a current valid origin",async()=>{
  const file="papers/"+pdfs[0].packageKey+"/source.pdf",bytes=st.files.get(file);st.files.set(file,Buffer.from("changed"));
  const damaged=await read(),item=object(damaged,articlePath);assert.equal(item.source.pdfOrigin.state,"unresolved");assert.equal(item.paperId,undefined);assert.deepEqual(item.identifiers,{});
  st.files.set(file,bytes);put(st,articlePath,article+"edited");const changed=await read();assert.equal(object(changed,articlePath).source.verification.state,"invalid");assert.equal(object(changed,articlePath).paperId,undefined);put(st,articlePath,article);
 });
 await check("missing/legacy receipts, unmatched sizes, conflicting attached-PDF receipts and duplicate output entries never imply identity",async()=>{
  assert.equal(match({version:1}),undefined);assert.equal(match({...manifest,source:{path:"input.pdf",size:123}}),undefined);
  assert.equal(match({...manifest,source:{...manifest.source,size:manifest.source.size+1}}).origin.state,"unresolved");
  assert.throws(()=>match({...manifest,source:{...manifest.source,sha256:"bad"}}),/凭据/);
  assert.throws(()=>match({...manifest,outputs:[...manifest.outputs,...manifest.outputs]}),/正文/);
  assert.throws(()=>match({...manifest,options:{include_source_pdf:true}}),/附带 PDF/);
  assert.throws(()=>match({...manifest,outputs:[...manifest.outputs,{path:"_extraction/source.pdf",size:manifest.source.size,sha256:"0".repeat(64)}]}),/附带 PDF/);
  put(st,manifestPath,{schema_version:1,extractor:"mineru-open-api",source:{path:"input.pdf"}});assert.equal(object(await read(),articlePath).paperId,undefined);put(st,manifestPath,manifest);
 });
 await check("ambiguous owners or metadata conflicts do not choose one PDF, and all matching copies are retained without borrowing a version",async()=>{
  const entries=structuredClone(index.get(pdfOriginKey(manifest.source.sha256,manifest.source.size)));
  entries[1].manifest.paperId="p-"+randomUUID();const ix=new Map([[pdfOriginKey(manifest.source.sha256,manifest.source.size),entries]]);
  assert.equal(match(manifest,article,ix).origin.state,"unresolved");
  entries[1].manifest.paperId=entries[0].manifest.paperId;entries[1].manifest.identity.identifiers.doi="10.9999/conflict";assert.equal(match(manifest,article,ix).origin.state,"unresolved");
  assert.equal(match(manifest,article,index,{identifiers:{doi:"10.9999/conflict"}}).origin.state,"unresolved");
  assert.equal(match(manifest,article,index,{identifiers:{},citekey:"wrong"}).origin.state,"unresolved");
  const result=match();assert.equal(result.origin.sourceIds.length,2);assert.equal(result.identity.paperId,pdfs[0].paperId);assert.equal(result.identity.sourceVersionId,undefined);
 });
 await check("fresh navigation rejects an old association after its source changes even if converted bytes are unchanged",async()=>{
  const old=object(verified,articlePath),fresh=structuredClone(verified),changed=object(fresh,articlePath);
  changed.source.pdfOrigin.sourceIds.pop();assert.throws(()=>libraryNavigation(old,fresh),/来源关联已变化/);
  changed.source.pdfOrigin=structuredClone(old.source.pdfOrigin);changed.paperId="p-"+randomUUID();assert.throws(()=>libraryNavigation(old,fresh),/来源关联已变化/);
  const controller=new AbortController();controller.abort();await assert.rejects(read({signal:controller.signal}),/abort/i);await assert.rejects(read({maxBytes:1}),/预算/);
 });
 console.log(`LIBRARY_MINERU_ORIGIN_OK (${count} groups; memory packages, simulated full-conversion verifier, no external calls/writes during scans)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
