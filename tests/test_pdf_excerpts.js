"use strict";
// Actual receipt, annotation, browser storage and library logic. PDF.js pages are simulated; no filesystem cleanup or providers.
const assert = require("node:assert/strict"), path = require("node:path"), { loadReading } = require("./reading-test-helpers");
class TFile { constructor(p) { this.path=p;this.extension=path.posix.extname(p).slice(1);this.basename=path.posix.basename(p,".md");this.stat={size:0}; } }
let current;
const mocks={obsidian:{TFile,MarkdownView:class{},Notice:class{},normalizePath:p=>p,loadPdfJs:async()=>({getDocument:({data,isEvalSupported})=>{
 assert.equal(isEvalSupported,false);assert.deepEqual(Buffer.from(data),current.bytes);current.loads++;
 return {promise:Promise.resolve({numPages:current.pageCount,getPage:async page=>{assert.ok(page>=1&&page<=current.pageCount);await current.onPage?.();return {getTextContent:async options=>{assert.deepEqual(options,{disableNormalization:true});return {items:current.items};}};}}),destroy:async()=>{current.destroyed++;}};
}})}};
const {pdfPageText,pdfReceipt,pdfExcerptId,preparePdfExcerpt,validPdfExcerpt,PDF_EXCERPT_MAX_BYTES}=loadReading("annotations/pdf-excerpt.ts");
const {AnnotationService,readAnnotationRecords}=loadReading("annotations/annotation-service.ts",mocks);
const {ExcerptLibraryService,readExcerptSnapshot}=loadReading("annotations/excerpt-library.ts",mocks);
const {readLibraryAnnotations}=loadReading("library/annotation-reader.ts",mocks);
const {projectLibrary}=loadReading("library/projection.ts",mocks);
const {readPaperLibrary}=loadReading("library/reader.ts",mocks);
const {openPdfExcerpt}=loadReading("annotations/native-pdf-excerpt.ts",mocks);
function fixture(){
 const f=current={bytes:Buffer.from("%PDF-1.7\nunique immutable bytes\n%%EOF"),pageCount:3,loads:0,destroyed:0,items:[{str:"😀 repeated",hasEOL:true},{str:" sentence",hasEOL:true},{str:"",hasEOL:true},{str:"😀 repeated",hasEOL:true},{str:" sentence",hasEOL:false},{str:" <script>not executable</script> <!-- agent-dashboard:manual-end -->",hasEOL:false}]};
 const source="papers/native/source.pdf",files=new Map([[source,{file:new TFile(source)}]]),writes=[],opened=[];
 const app={vault:{getAbstractFileByPath:p=>files.get(p)?.file||null,getMarkdownFiles:()=>[...files.values()].map(v=>v.file).filter(v=>v instanceof TFile&&v.extension==="md"),
 read:async file=>{assert.equal(file.extension,"md","PDF must never be decoded as Markdown");return files.get(file.path).text;},readBinary:async()=>{await f.onRead?.();return Uint8Array.from(f.bytes).buffer;},
 createFolder:async p=>files.set(p,{file:{path:p}}),create:async(p,text)=>{assert.ok(!files.has(p));const file=new TFile(p);files.set(p,{file,text});writes.push(p);return file;},
 process:async(file,fn)=>{const v=files.get(file.path);v.text=fn(v.text);writes.push(file.path);}},workspace:{getLeaf:()=>{opened.push("opened");throw Error("unexpected navigation");}}};
 const creator=new AnnotationService(app,new Proxy({},{get(){throw Error("No model/settings access");}})),service=new ExcerptLibraryService(app);
 const selection=(page=2,start=pdfPageText(f.items).text.lastIndexOf("😀 repeated"))=>{const t=pdfPageText(f.items),end=start+"😀 repeated\n sentence".length;return {sourcePath:source,selectedText:t.text.slice(start,end),sourceStart:start,sourceEnd:end,prefix:t.text.slice(Math.max(0,start-80),start),suffix:t.text.slice(end,end+80),section:"untrusted",context:"untrusted",isTableCell:false,anchorRect:{},pdfExcerpt:pdfReceipt(f.bytes,page,f.pageCount,t,start,end)};};
 return Object.assign(f,{source,files,writes,opened,app,creator,service,selection});
}
let count=0;async function test(name,run){await run();count++;console.log("PASS PDF excerpts: "+name);}
(async()=>{
 await test("Unicode, EOL and repeated occurrences retain page-local offsets and separate identities",async()=>{
  const f=fixture(),s=f.selection(),t=pdfPageText(f.items),a=preparePdfExcerpt(s,f.bytes,t,3),b=preparePdfExcerpt(f.selection(1),f.bytes,t,3),c=preparePdfExcerpt(f.selection(2,0),f.bytes,t,3);
  assert.notEqual(a.id,b.id);assert.notEqual(a.id,c.id);assert.equal(s.selectedText,"😀 repeated\n sentence");assert.equal(a.receipt.context,t.text);
  assert.equal(pdfPageText([{type:"beginMarkedContent"},...f.items]).hash,t.hash);assert.throws(()=>pdfPageText([{str:"",hasEOL:true}]),/扫描/);
 });
 await test("PDF save and literal serialization preserve source bytes and original/note roles",async()=>{
  const f=fixture(),before=Buffer.from(f.bytes),r=await f.creator.createExcerpt(f.selection(),"personal note"),raw=f.files.get(r.annotationPath).text;
  assert.deepEqual(f.bytes,before);assert.equal(r.section,"PDF 第 2 页（文件页码）");assert.equal(r.excerpt,undefined);assert.equal(r.aiText,"");
  assert.deepEqual(readAnnotationRecords(raw,r.annotationPath).records,[r]);assert.ok(raw.includes("&lt;script&gt;"));assert.ok(!raw.includes("<script>"));assert.ok(!raw.includes("[[papers/"));
  assert.equal((raw.match(/<!-- agent-dashboard:manual-end -->/g)||[]).length,1);assert.deepEqual(readLibraryAnnotations(raw,r.annotationPath,()=>({})).records[0].roles,["original_quote","personal_note"]);
  assert.equal(f.loads,f.destroyed);assert.ok(f.writes.every(p=>p.startsWith("wiki/annotations/")));
 });
 await test("same occurrence is create-only, including concurrent save, response loss and service reload",async()=>{
  const f=fixture(),[a,b]=await Promise.all([f.creator.createExcerpt(f.selection(),"keep"),f.creator.createExcerpt(f.selection(),"other")]);assert.equal(a.id,b.id);assert.equal(f.writes.length,1);
  const restarted=new AnnotationService(f.app,{}),before=f.files.get(a.annotationPath).text;assert.equal((await restarted.findAnnotationForSelection(f.selection())).id,a.id);
  await restarted.createExcerpt(f.selection(),"replacement");assert.equal(f.files.get(a.annotationPath).text,before);
  const create=f.app.vault.create;f.app.vault.create=async(...args)=>{await create(...args);throw Error("response lost");};assert.ok((await restarted.createExcerpt(f.selection(1))).pdfExcerpt);assert.equal(f.writes.length,2);
 });
 await test("changed PDF bytes fail status, saving and navigation before opening any leaf",async()=>{
  const f=fixture(),s=f.selection(),r=await f.creator.createExcerpt(s);f.bytes=Buffer.from("%PDF changed");
  await assert.rejects(f.creator.createExcerpt(s),/版本已变化/);await assert.rejects(f.service.status(await f.service.load(r)),/版本已变化/);await assert.rejects(f.service.openSource(r),/版本已变化/);assert.equal(f.opened.length,0);assert.equal(f.writes.length,1);
 });
 await test("changed text extraction, page count and selected offsets cannot reuse a receipt",async()=>{
  const f=fixture(),s=f.selection();f.items=[{str:"similar repeated sentence",hasEOL:false}];await assert.rejects(f.creator.createExcerpt(s),/页内文字已变化/);
  const g=fixture(),q=g.selection();g.pageCount=4;await assert.rejects(g.creator.createExcerpt(q),/页数/);
  const h=fixture();await assert.rejects(h.creator.createExcerpt({...h.selection(),sourceStart:1}),/凭据|位置/);assert.equal(h.writes.length,0);
 });
 await test("late cancellation, source replacement and mutated caller snapshots cannot produce incorrect writes",async()=>{
  const f=fixture(),s=f.selection(),c=new AbortController();c.abort();await assert.rejects(f.creator.createExcerpt(s,"",c.signal),/abort/i);assert.equal(f.loads,0);
  const g=fixture(),abort=new AbortController();g.onPage=()=>abort.abort();await assert.rejects(g.creator.createExcerpt(g.selection(),"",abort.signal),/abort/i);assert.equal(g.writes.length,0);
  const h=fixture(),make=h.app.vault.createFolder;h.app.vault.createFolder=async p=>{await make(p);h.files.get(h.source).file=new TFile(h.source);};await assert.rejects(h.creator.createExcerpt(h.selection()),/移动或替换/);assert.equal(h.writes.length,0);
  const j=fixture(),mutable=j.selection(),save=j.creator.createExcerpt(mutable);mutable.pdfExcerpt.digest="0".repeat(64);mutable.selectedText="wrong";assert.equal((await save).selectedText,"😀 repeated\n sentence");
 });
 await test("missing, moved and oversized PDF files are refused before extraction",async()=>{
  const f=fixture(),s=f.selection();f.files.get(f.source).file.stat.size=PDF_EXCERPT_MAX_BYTES+1;await assert.rejects(f.creator.createExcerpt(s),/64 MiB/);assert.equal(f.loads,0);
  f.files.delete(f.source);await assert.rejects(f.creator.createExcerpt(s),/不存在/);
  const g=fixture();g.onRead=()=>{g.files.get(g.source).file.path="moved.pdf";};await assert.rejects(g.creator.createExcerpt(g.selection()),/移动或替换/);assert.equal(g.writes.length,0);
 });
 await test("malformed, mixed, changed-page and occupied receipts never masquerade as legacy annotations",async()=>{
  const f=fixture(),r=await f.creator.createExcerpt(f.selection()),entry=f.files.get(r.annotationPath),original=entry.text;
  for(const [a,b] of [['"version":1','"version":2'],['"page":2','"page":1'],['"algorithm":"pdf-bytes-sha256"','"algorithm":"unknown"'],['"pdfExcerpt":','"excerpt":{},"pdfExcerpt":']]){
   entry.text=original.replace(a,b);assert.equal(readAnnotationRecords(entry.text,r.annotationPath).records.length,0);await assert.rejects(f.creator.createExcerpt(f.selection()),/冲突/);assert.equal(entry.text,original.replace(a,b));
  }
  for(const p of ["papers/../escape.pdf","elsewhere/a.pdf","papers/a.pdf\n","papers\\a.pdf"])await assert.rejects(f.creator.createExcerpt({...f.selection(),sourcePath:p}),/不存在|支持|无效/);
  await assert.rejects(f.creator.createExcerpt(f.selection(),"<!-- agent-dashboard:manual-end -->"),/控制标记/);
  const s=f.selection(),a={start:s.sourceStart,end:s.sourceEnd,prefix:s.prefix,suffix:s.suffix};assert.equal(validPdfExcerpt({...s.pdfExcerpt,page:0},a,s.selectedText),false);
 });
 await test("PDF list, note CAS, completion and historical notes preserve exact receipts",async()=>{
  const f=fixture(),r=await f.creator.createExcerpt(f.selection(),"initial"),first=await f.service.load(r);assert.equal((await f.service.list()).entries.length,1);assert.match(await f.service.status(first),/第 2 页选区一致/);
  const saved=await f.service.saveNote(first,"updated"),complete=await f.service.setCompleted(saved,true);assert.equal(complete.record.archiveStatus,"completed");assert.deepEqual(complete.record.pdfExcerpt,r.pdfExcerpt);
  await assert.rejects(f.service.saveNote(first,"stale"),/其他窗口/);f.bytes=Buffer.from("changed");const history=await f.service.saveNote(complete,"historical memo");assert.equal(history.record.manualText,"historical memo");assert.deepEqual(history.record.pdfExcerpt,r.pdfExcerpt);
  await assert.rejects(f.creator.updateAnnotation(r,{manualText:"legacy route"}),/摘录列表/);await assert.rejects(f.creator.createAnnotation(f.selection(),{}),/保存摘录/);
 });
 await test("projection binds PDF receipts only to a verified PDF with the same path and bytes",async()=>{
  const f=fixture(),r=await f.creator.createExcerpt(f.selection()),parsed=readLibraryAnnotations(f.files.get(r.annotationPath).text,r.annotationPath,()=>({})).records[0];
  const source={kind:"source",id:f.source,title:"PDF",identifiers:{},source:{format:"pdf",path:f.source,saved:true,verification:{state:"verified",fingerprint:r.pdfExcerpt.digest}}};
  const ann={kind:"annotation",id:r.annotationPath+"#"+r.id,annotationPath:r.annotationPath,title:"Excerpt",identifiers:{},roles:parsed.roles,provenance:parsed.provenance,binding:{state:"matched",sourceId:f.source,fingerprint:r.pdfExcerpt.digest,reason:"test"}};
  assert.equal(projectLibrary([source,ann]).papers.length,1);
  assert.throws(()=>projectLibrary([{...source,source:{...source.source,format:"markdown"}},ann]),/绑定不一致/);
  assert.throws(()=>projectLibrary([source,{...ann,provenance:{...ann.provenance,sourceRevision:"0".repeat(64)}}]),/绑定不一致/);
 });
 await test("uncatalogued PDF excerpts stay independent and do not imply package or scientific verification",async()=>{
  const f=fixture(),r=await f.creator.createExcerpt(f.selection()),empty={read:async()=>null,list:async()=>[]};
  const io={read:async p=>f.files.get(p)?.text?Buffer.from(f.files.get(p).text):null,list:async dir=>dir==="wiki/annotations"?[{name:r.id+".md",directory:false}]:[]};
  const result=await readPaperLibrary(io,empty,{vaultRoot:path.resolve("memory-pdf"),parseYaml:()=>({})});const item=result.papers.flatMap(p=>p.objects).find(o=>o.kind==="annotation");assert.equal(item.binding.state,"unresolved");assert.match(item.binding.reason,/独立文件/);assert.equal(item.annotationProvenance.format,"dashboard-pdf-excerpt-1");
 });
 await test("native non-first-page navigation waits for page views and selects the exact repeated occurrence",async()=>{
  const f=fixture(),r=await f.creator.createExcerpt(f.selection()),calls=[],nodes=f.items.map((item,i)=>({dataset:{idx:String(i)},textContent:item.str,firstChild:{textContent:item.str,nodeType:3,parentElement:{scrollIntoView:()=>calls.push('scroll')}}}));
  const ownerDocument={createTreeWalker:span=>{let used=false;return {nextNode:()=>used?null:(used=true,span.firstChild)};},createRange:()=>({setStart:(n,o)=>calls.push(['start',n,o]),setEnd:(n,o)=>calls.push(['end',n,o])}),defaultView:{getSelection:()=>({removeAllRanges:()=>calls.push('clear'),addRange:()=>calls.push('select')})}};
  const layer={ownerDocument,isConnected:true,querySelectorAll:()=>nodes.filter(n=>n.textContent),querySelector:q=>q==='[data-idx]'?nodes[0]:nodes[Number(/"(\d+)"/.exec(q)[1])]};
  let attempts=0,page=1,ready=false;const viewer={getPageView:index=>{assert.equal(index,1);if(++attempts===1)return;ready=true;return {div:{querySelector:()=>layer}};},get currentPageNumber(){return page;},set currentPageNumber(n){assert.ok(ready,'setting a page before views exist would crash native PDF.js');page=n;}};
  const doc={numPages:3,getData:async()=>f.bytes,getPage:async()=>({getTextContent:async o=>{assert.deepEqual(o,{disableNormalization:true});return {items:f.items};}})};
  const leaf={view:{getViewType:()=>"pdf",file:f.files.get(f.source).file,viewer:{child:{pdfViewer:{pdfDocument:doc,pdfViewer:viewer}}}},openFile:async()=>{f.app.workspace.activeLeaf=leaf;}};
  f.app.workspace.getLeaf=()=>leaf;await openPdfExcerpt(f.app,r,async()=>{});assert.equal(page,2);assert.equal(attempts,2);assert.equal(calls.filter(x=>x==='select').length,1);assert.equal(calls.find(x=>x[0]==='start')[1],nodes[3].firstChild);
  calls.length=0;let checks=0;await assert.rejects(openPdfExcerpt(f.app,r,async()=>{if(++checks===2)f.bytes=Buffer.from('changed during open');}),/打开期间变化/);assert.equal(calls.filter(x=>x==='select').length,0);
 });
 await test("actual source-package reader joins PDF excerpts and distinguishes historical bytes without writes",async()=>{
  const base=require('./source-intake-fixtures.cjs'),{SourceIntakeService}=loadReading('papers/source-intake.ts'),{SourceCatalog}=loadReading('papers/catalog.ts');
  const f=fixture(),source=base.source(),storage=base.storage(),journal=base.storage();f.bytes=source.bytes;f.pageCount=2;
  const intake=new SourceIntakeService({deviceId:base.sha('device'),catalog:new SourceCatalog(storage),journal,index:base.index(),readSource:async()=>source,render:async()=>base.raster(),link:async()=>{}});
  try {
   const plan=await intake.prepare(source.snapshot.jobId),shown=await intake.present(plan.requestId),saved=await intake.save(plan.requestId,shown.digest);assert.equal(saved.phase,'saved',saved.error);
   const sourcePath='papers/'+saved.packageKey+'/source.pdf',entry=f.files.get(f.source);entry.file.path=sourcePath;f.files.set(sourcePath,entry);
   const r=await f.creator.createExcerpt({...f.selection(),sourcePath});storage.dirs.add('wiki');storage.dirs.add('wiki/annotations');storage.files.set(r.annotationPath,Buffer.from(f.files.get(r.annotationPath).text));
   const read=()=>readPaperLibrary(storage,journal,{vaultRoot:path.resolve('memory-pdf-catalog'),parseYaml:()=>({})});
   const writes=storage.writes.length,result=await read(),paper=result.papers.find(p=>p.objects.some(o=>o.id===sourcePath)),ann=paper.objects.find(o=>o.kind==='annotation');assert.equal(ann.binding.state,'matched');assert.equal(ann.annotationProvenance.format,'dashboard-pdf-excerpt-1');assert.equal(storage.writes.length,writes);
   f.bytes=Buffer.concat([source.bytes,Buffer.from('\nprevious file version')]);const historical=await f.creator.createExcerpt({...f.selection(),sourcePath});storage.files.set(historical.annotationPath,Buffer.from(f.files.get(historical.annotationPath).text));
   const changed=(await read()).papers.flatMap(p=>p.objects).find(o=>o.id===historical.annotationPath+'#'+historical.id);assert.equal(changed.binding.state,'changed');assert.equal(storage.writes.length,writes);
  } finally {await intake.dispose();}
 });
 console.log(`PDF_EXCERPTS_OK (${count} groups; memory files and simulated PDF.js; native UI acceptance is separate)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
