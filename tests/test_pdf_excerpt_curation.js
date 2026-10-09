"use strict";
// Real annotation, package, curation, writer and history services; memory vault and simulated PDF.js. No cleanup or model calls.
const assert=require("node:assert/strict"),path=require("node:path"),{loadReading}=require("./reading-test-helpers"),base=require("./source-intake-fixtures.cjs");
class TFile{constructor(p){this.path=p;this.extension=path.posix.extname(p).slice(1);this.basename=path.posix.basename(p,".md");this.stat={size:0};}}
let active;
const mocks={obsidian:{TFile,MarkdownView:class{},Notice:class{},normalizePath:p=>p,
 parseYaml:text=>Object.fromEntries(text.split(/\r?\n/).filter(l=>l.includes(":")).map(l=>{const i=l.indexOf(":");return[l.slice(0,i),l.slice(i+1).trim().replace(/^"|"$/g,"")];})),
 loadPdfJs:async()=>({getDocument:({data,isEvalSupported})=>{assert.equal(isEvalSupported,false);assert.deepEqual(Buffer.from(data),active.bytes);return{promise:Promise.resolve({numPages:active.pageCount,getPage:async()=>{await active.onPage?.();return{getTextContent:async options=>{assert.deepEqual(options,{disableNormalization:true});return{items:active.items};}};}}),destroy:async()=>{}};}})},
 "../sources/storage":{FileSourceStorage:class{async read(...args){return active.io.read(...args);}async list(...args){return active.io.list(...args);}}}};
const {pdfPageText,pdfReceipt}=loadReading("annotations/pdf-excerpt.ts"),{AnnotationService}=loadReading("annotations/annotation-service.ts",mocks),{ExcerptLibraryService}=loadReading("annotations/excerpt-library.ts",mocks);
const {prepareExcerptCuration,validateExcerptContext,excerptAddition}=loadReading("curation/excerpt.ts",mocks),{CurationService,validatedReview}=loadReading("curation/service.ts",mocks),{CurationWriter}=loadReading("curation/writer.ts",mocks),{curationParagraphs}=loadReading("curation/policy.ts",mocks),{readExcerptHistory}=loadReading("annotations/excerpt-history.ts",mocks);
const {SourceIntakeService}=loadReading("papers/source-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts");
async function fixture(managed=false){
 const f=active={io:base.storage(),bytes:Buffer.from("%PDF-1.7\nimmutable\n%%EOF"),pageCount:2,items:[{str:"Context",hasEOL:true},{str:"😀 ﬁnd **evidence** [[link]]",hasEOL:true},{str:"<script>literal</script>",hasEOL:false}]};
 f.source="papers/legacy/_extraction/source.pdf";
 if(managed){const source=base.source();f.bytes=source.bytes;const intake=new SourceIntakeService({deviceId:base.sha("device"),catalog:new SourceCatalog(f.io),journal:base.storage(),index:base.index(),readSource:async()=>source,render:async()=>base.raster(),link:async()=>{}});
  try{const plan=await intake.prepare(source.snapshot.jobId),shown=await intake.present(plan.requestId),saved=await intake.save(plan.requestId,shown.digest);assert.equal(saved.phase,"saved",saved.error);f.source=`papers/${saved.packageKey}/source.pdf`;f.identity=source.snapshot.identity;}finally{await intake.dispose();}
 }else{f.io.dirs.add("papers");f.io.dirs.add("papers/legacy");f.io.dirs.add("papers/legacy/_extraction");f.io.files.set(f.source,f.bytes);}
 f.files=new Map();f.writes=[];f.records=new Map();f.target="wiki/concepts/pdf-learning.md";
 f.put=(p,text)=>f.files.set(p,{file:new TFile(p),text});f.put(f.source);f.original="---\ntitle: Example\n---\n# Example\n\n## Scope\nKeep existing text.\n\n## Links\n[[wiki/methods/existing]]\n";
 f.put(f.target,f.original);f.put("研究主题索引.md","# Index\n");f.put("文献索引.md","# Papers\n");f.put("wiki/log.md","# Log\n");
 f.app={vault:{adapter:{getBasePath:()=>path.resolve("memory-pdf-curation")},getFileByPath:p=>f.files.get(p)?.file||null,getAbstractFileByPath:p=>f.files.get(p)?.file||null,cachedRead:async file=>f.files.get(file.path).text,getMarkdownFiles:()=>[...f.files.values()].map(v=>v.file).filter(v=>v instanceof TFile&&v.extension==="md"),
  read:async file=>{assert.equal(file.extension,"md");return f.files.get(file.path).text;},readBinary:async()=>Uint8Array.from(f.bytes).buffer,createFolder:async p=>f.files.set(p,{file:{path:p}}),
  create:async(p,text)=>{assert.ok(!f.files.has(p));f.put(p,text);f.writes.push(p);return f.files.get(p).file;},process:async(file,fn)=>{const entry=f.files.get(file.path),after=fn(entry.text);if(after!==entry.text)f.writes.push(file.path);entry.text=after;}},metadataCache:{getFileCache:()=>({frontmatter:{}})}};
 const t=pdfPageText(f.items),start=t.text.indexOf("😀"),end=t.text.length;
 f.record=await new AnnotationService(f.app,{}).createExcerpt({sourcePath:f.source,selectedText:t.text.slice(start,end),sourceStart:start,sourceEnd:end,prefix:t.text.slice(0,start),suffix:"",section:"",context:"",isTableCell:false,anchorRect:{},pdfExcerpt:pdfReceipt(f.bytes,2,f.pageCount,t,start,end)},"Personal inference, not checked.");f.writes.length=0;
 f.workspace={ready:async()=>{},repository:{get:()=>{throw Error("fake session");}},document:()=>{throw Error("fake document");}};
 f.store={list:async kind=>[...f.records.keys()].filter(k=>k.startsWith(kind+":")).map(k=>k.split(":")[1]),read:async(kind,id)=>structuredClone(f.records.get(kind+":"+id)),write:async(kind,value)=>f.records.set(kind+":"+value.id,structuredClone(value))};
 f.restart=()=>{f.service=new CurationService(f.app,f.workspace,f.store,()=>{throw Error("model must not run");});f.writer=new CurationWriter(f.service);};f.restart();
 f.prepare=(include=false,signal)=>prepareExcerptCuration(f.app,f.record,f.target,curationParagraphs(f.files.get(f.target).text)[0].id,include,signal);
 f.preview=async(include=false)=>{const review=await f.service.saveExcerpt(await f.prepare(include));return{review,plan:await f.writer.preview(review.id,["s-0"])};};
 f.paper=metadata=>{f.target="wiki/sources/pdf-paper.md";f.original=`---\n${metadata}\n---\n# Paper\n\n## Evidence\nKeep original conclusion.\n`;f.put(f.target,f.original);};
 f.journal={list:async dir=>[...f.records.keys()].filter(k=>k.startsWith(dir.split("/")[1]+":")).map(k=>({name:k.split(":")[1]+".json",directory:false})),read:async p=>{const parts=p.split("/"),v=f.records.get(parts[1]+":"+parts[2].slice(0,-5));return v?Buffer.from(JSON.stringify(v)):null;}};
 return f;
}
let count=0;async function test(name,run){await run();count++;console.log("PASS PDF excerpt curation: "+name);}
(async()=>{
 await test("standalone quotes keep file pages, ligatures and escaped literal text, without model/session",async()=>{
  const f=await fixture(),c=await f.prepare(true),text=excerptAddition(c);assert.equal(c.ruleVersion,"pdf-excerpt-curation-v1");assert.deepEqual(c.excerpt.pdfSource,{version:1,kind:"standalone"});assert.equal(c.source.kind,"pdf");assert.equal(c.evidence.length,0);assert.equal(c.sessionId,"");
  assert.match(text,/第 2 \/ 2 页（文件页码）/);assert.match(text,/😀 ﬁnd/);assert.ok(text.includes("\\[\\[link\\]\\]"));assert.ok(!text.includes("<script>"));assert.ok(!text.includes("[[papers/"));assert.match(text,/个人备注（用户记录/);assert.ok(!excerptAddition(await f.prepare()).includes("Personal inference"));
  const {review,plan}=await f.preview();assert.equal(review.usage.calls,0);assert.equal(review.usage.model,"");assert.deepEqual(plan.writes.map(w=>w.path),[f.target,"研究主题索引.md","wiki/log.md"]);assert.equal(f.writes.length,0);
 });
 await test("standalone PDF never supplies paper identity, even with matching path or metadata",async()=>{
  const f=await fixture();f.paper(`title: Same\nsource_path: ${f.source}`);await assert.rejects(f.prepare(),/尚未登记/);assert.equal(f.records.size,0);assert.equal(f.writes.length,0);
 });
 await test("actual managed package permits only explicit same-PDF paper bindings and preserves depth",async()=>{
  const f=await fixture(true),c=await f.prepare(),m=c.excerpt.pdfSource.manifest;assert.equal(c.excerpt.pdfSource.kind,"managed");f.paper(`title: ${m.identity.title}\ndoi: ${m.identity.identifiers.doi}\nsource_path: ${f.source}\nsource_version: ${m.sourceVersionId}\ndepth: abstract-level`);
  const {plan}=await f.preview();assert.match(plan.writes[0].after,/depth: abstract-level/);assert.match(plan.writes[0].after,/原文包：/);assert.deepEqual(plan.writes.map(w=>w.path),[f.target,"文献索引.md","wiki/log.md"]);assert.equal((await f.writer.apply(plan)).state,"applied");
 });
 await test("title/DOI alone, mixed paths, identifiers, package stamps and metadata-only fail closed",async()=>{
  const f=await fixture(true),m=(await f.prepare()).excerpt.pdfSource.manifest,good=`title: ${m.identity.title}\nsource_path: ${f.source}`;
  for(const bad of [`title: ${m.identity.title}\ndoi: ${m.identity.identifiers.doi}`,good+"\ndoi: 10.9999/other",good+"\nsource_pdf: papers/other.pdf",good+"\ncitekey: other",good+"\nsource_kind: structured",good+"\nsource_version: other",good+"\nsource_manifest_digest: wrong",good+"\nsource_identity_digest: wrong",good+"\nsource_xml_sha256: wrong",good+"\narticle_path: papers/other/article.md",good+"\ndepth: metadata-only"]){f.paper(bad);await assert.rejects(f.prepare(),/不一致|元数据/);}
  assert.equal(f.writes.length,0);
 });
 await test("managed package damage, disappearance and migration never fall back to independent PDF",async()=>{
  const f=await fixture(true),c=await f.prepare(),root=`papers/${c.excerpt.pdfSource.manifest.packageKey}`,manifest=root+"/_source/manifest.json",original=f.io.files.get(manifest);f.io.files.set(manifest,Buffer.from("{}"));await assert.rejects(f.prepare());f.io.files.set(manifest,original);
  const asset=root+"/_source/identity-page.png",bytes=f.io.files.get(asset);f.io.files.set(asset,Buffer.from("altered image"));await assert.rejects(f.prepare());f.io.files.set(asset,bytes);
  f.io.files.delete(manifest);f.io.dirs.delete(root+"/_source");await assert.rejects(f.prepare());assert.equal(f.writes.length,0);
  const g=await fixture(),{review}=await g.preview();g.io.dirs.add("papers/legacy/_source");await assert.rejects(g.writer.preview(review.id,["s-0"]),/受管理/);assert.equal(g.writes.length,0);
 });
 await test("PDF bytes, extracted page items, page count and late disk reads invalidate previews",async()=>{
  const f=await fixture(),{review}=await f.preview(),bytes=f.bytes;f.bytes=Buffer.from("changed PDF");await assert.rejects(f.writer.preview(review.id,["s-0"]),/版本已变化/);f.bytes=bytes;
  const items=f.items;f.items=[{str:"changed text"}];await assert.rejects(f.writer.preview(review.id,["s-0"]),/页内文字已变化/);f.items=items;f.pageCount=3;await assert.rejects(f.writer.preview(review.id,["s-0"]),/页数/);f.pageCount=2;
  f.io.files.set(f.source,Buffer.from("late replacement"));await assert.rejects(f.writer.preview(review.id,["s-0"]),/版本已变化/);assert.equal(f.writes.length,0);
 });
 await test("forged source modes, receipts, package proofs and editable suggestions are rejected",async()=>{
  const f=await fixture(),{review}=await f.preview();
  for(const mutate of [c=>c.excerpt.sourceMode="markdown",c=>c.excerpt.pdfSource={version:1,kind:"managed",manifest:{}},c=>c.excerpt.pdfSource.manifest={},c=>c.source.kind="code",c=>c.source.fingerprint="0".repeat(64),c=>c.excerpt.snapshot.record.pdfExcerpt.page=1]){const c=structuredClone(review.context);mutate(c);assert.throws(()=>validateExcerptContext(c));}
  const forged=structuredClone(review);forged.suggestions[0].text="invented scientific conclusion";assert.throws(()=>validatedReview(forged));await assert.rejects(f.service.decide(review.id,"s-0","accepted","edited"),/不能|不支持|摘录/);assert.equal(f.writes.length,0);
 });
 await test("snapshot changes, target edits and target CAS races preserve user data",async()=>{
  const f=await fixture(),{plan}=await f.preview(),library=new ExcerptLibraryService(f.app);await library.setCompleted(await library.load(f.record),true);f.writes.length=0;await assert.rejects(f.writer.apply(plan),/摘录.*变化/);assert.equal(f.files.get(f.target).text,f.original);
  const g=await fixture(),p=(await g.preview()).plan;g.files.get(g.target).text+="\nUser edit";await assert.rejects(g.writer.apply(p),/目标笔记已变化/);assert.equal(g.writes.length,0);
  const h=await fixture(),q=(await h.preview()).plan,process=h.app.vault.process;h.app.vault.process=async(file,fn)=>{if(file.path===h.target)h.files.get(h.target).text+="\nConcurrent edit";return process(file,fn);};await assert.rejects(h.writer.apply(q),/写入前文件已变化/);assert.equal(h.service.revisions.get(q.id).state,"recovery");assert.equal(h.files.get(h.target).text,h.original+"\nConcurrent edit");
 });
 await test("index/log changes and cancellation during PDF extraction cannot apply stale plans",async()=>{
  for(const p of ["研究主题索引.md","wiki/log.md"]){const f=await fixture(),{plan}=await f.preview();f.files.get(p).text+="user edit";await assert.rejects(f.writer.apply(plan),/变化/);assert.equal(f.writes.length,0);}
  const f=await fixture(),{review}=await f.preview(),abort=new AbortController();f.onPage=()=>abort.abort();await assert.rejects(f.writer.preview(review.id,["s-0"],undefined,undefined,abort.signal),/abort/i);assert.equal(f.writes.length,0);
 });
 await test("partial apply reloads and resumes once; historical undo works without current PDF",async()=>{
  const f=await fixture(),{plan}=await f.preview(true),before=f.files.get(f.record.annotationPath).text,process=f.app.vault.process;let failed=false;
  f.app.vault.process=async(file,fn)=>{if(!failed&&file.path==="研究主题索引.md"){failed=true;throw Error("simulated disk failure");}return process(file,fn);};await assert.rejects(f.writer.apply(plan),/simulated disk/);assert.equal(f.service.revisions.get(plan.id).state,"recovery");assert.equal(f.writes.filter(p=>p===f.target).length,1);f.restart();assert.equal((await f.writer.resume(plan.id)).state,"applied");assert.equal(f.writes.filter(p=>p===f.target).length,1);
  await assert.rejects(f.prepare(),/已有这条摘录/);assert.equal(f.files.get(f.record.annotationPath).text,before);assert.deepEqual(f.io.files.get(f.source),f.bytes);f.files.delete(f.source);f.io.files.delete(f.source);
  const undo=await f.writer.previewUndo(plan.id);assert.equal((await f.writer.applyUndo(undo)).state,"applied");assert.equal(f.files.get(f.target).text,f.original);const history=await readExcerptHistory(f.journal,f.record);assert.deepEqual(history.issues,[]);assert.equal(history.entries.length,3);assert.ok(history.entries.some(e=>e.label==="补充已撤销"));assert.ok(history.entries.some(e=>e.label==="已撤销补充"));
 });
 await test("source changes after the target write block remaining writes and recovery until reverified",async()=>{
  const f=await fixture(true),{plan}=await f.preview();
  const review=[...f.records.values()].find(r=>r.context),asset=`papers/${review.context.excerpt.pdfSource.manifest.packageKey}/_source/identity-page.png`,bytes=f.io.files.get(asset),process=f.app.vault.process;
  f.app.vault.process=async(file,fn)=>{await process(file,fn);if(file.path===f.target)f.io.files.set(asset,Buffer.from("changed"));};await assert.rejects(f.writer.apply(plan));assert.equal(f.service.revisions.get(plan.id).state,"recovery");assert.deepEqual(f.writes,[f.target]);await assert.rejects(f.writer.resume(plan.id));f.io.files.set(asset,bytes);f.app.vault.process=process;assert.equal((await f.writer.resume(plan.id)).state,"applied");assert.equal(f.writes.filter(p=>p===f.target).length,1);
 });
 await test("response loss never duplicates target, and undo refuses later manual edits",async()=>{
  const f=await fixture(),{plan}=await f.preview(),process=f.app.vault.process;let lost=false;f.app.vault.process=async(file,fn)=>{await process(file,fn);if(!lost&&file.path===f.target){lost=true;throw Error("response lost");}};
  await assert.rejects(f.writer.apply(plan),/response lost/);assert.equal((await f.writer.resume(plan.id)).state,"applied");assert.equal(f.writes.filter(p=>p===f.target).length,1);const undo=await f.writer.previewUndo(plan.id);f.files.get(f.target).text+="\nLater edit";await assert.rejects(f.writer.applyUndo(undo),/后续编辑/);assert.match(f.files.get(f.target).text,/Later edit/);
 });
 await test("managed source and package notifications require reinspection",async()=>{
  const f=await fixture(true),{review}=await f.preview(),asset=`papers/${review.context.excerpt.pdfSource.manifest.packageKey}/_source/identity-page.png`;await f.service.inspect();assert.equal(f.service.changesPending,false);f.service.noteChange(asset);assert.equal(f.service.changesPending,true);await f.service.inspect();f.service.noteChange(f.source);assert.equal(f.service.changesPending,true);
 });
 console.log(`PDF_EXCERPT_CURATION_OK (${count} groups; memory vault, actual package validation and simulated PDF.js)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
