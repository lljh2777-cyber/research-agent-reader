"use strict";
// Actual services/serialization/projection in memory. No network, model calls or filesystem deletion.
const assert=require("node:assert/strict"),path=require("node:path"),{loadReading}=require("./reading-test-helpers");
class TFile{constructor(p){this.path=p;this.extension="md";this.basename=path.posix.basename(p,".md");}}
const mocks={obsidian:{TFile,MarkdownView:class{},Notice:class{},normalizePath:p=>p.replace(/\\/g,"/")}};
const {AnnotationService,readAnnotationRecords}=loadReading("annotations/annotation-service.ts",mocks);
const {excerptRevision,prepareExcerpt}=loadReading("annotations/excerpt.ts");
const {readPaperLibrary}=loadReading("library/reader.ts",mocks);
function fixture(){
 const source="Clippings/excerpt.md",body="# Results\n\nFirst repeated sentence.\n\nSecond repeated sentence.\n<!-- agent-dashboard:annotation-start quoted -->\n```sample```\n";
 const files=new Map([[source,{file:new TFile(source),text:body}]]),writes=[];
 const app={vault:{getAbstractFileByPath:p=>files.get(p)?.file||null,read:async f=>files.get(f.path).text,
  createFolder:async p=>{if(files.has(p))throw Error("exists");files.set(p,{file:{path:p}});},
  create:async(p,text)=>{if(files.has(p))throw Error("exists");const file=new TFile(p);files.set(p,{file,text});writes.push(p);return file;},
  process:async(f,fn)=>{files.get(f.path).text=fn(files.get(f.path).text);writes.push(f.path);}}};
 const service=new AnnotationService(app,new Proxy({},{get(){throw Error("Model configuration must not be accessed");}}));
 const selection=(text="repeated sentence",start=body.indexOf(text))=>({sourcePath:source,selectedText:text,section:"untrusted heading",context:"untrusted context",sourceStart:start,sourceEnd:start+text.length,prefix:body.slice(Math.max(0,start-80),start),suffix:body.slice(start+text.length,start+text.length+80),isTableCell:false,anchorRect:{},sourceRevision:excerptRevision(body)});
 const storage={read:async p=>{const text=files.get(p)?.text;return text===undefined?null:Buffer.from(text);},list:async p=>{
  const entries=new Map();for(const key of files.keys()){if(!key.startsWith(p+"/"))continue;const relative=key.slice(p.length+1),name=relative.split("/")[0];entries.set(name,{name,directory:relative.includes("/")||files.get(key).text===undefined});}return [...entries.values()];}};
 return {source,body,files,writes,app,service,selection,storage};
}
let n=0;const test=async(name,fn)=>{await fn();console.log("PASS excerpts: "+name);n++;};
(async()=>{
 await test("exact text, context, revision, roles and safe serialization without changing the source",async()=>{
  const f=fixture(),r=await f.service.createExcerpt(f.selection(),"personal memo"),raw=f.files.get(r.annotationPath).text;
  assert.equal(f.files.get(f.source).text,f.body);assert.equal(r.section,"Results");assert.equal(r.excerpt.context,f.body);assert.equal(r.aiText,"");
  const parsed=readAnnotationRecords(raw,r.annotationPath);assert.deepEqual(parsed.errors,[]);assert.deepEqual(parsed.records[0],r);
  assert.equal((raw.match(/<!-- agent-dashboard:annotation-start /g)||[]).length,1);assert.ok(!raw.includes("[[Clippings/"));assert.ok(f.writes.every(p=>p.startsWith("wiki/annotations/")));
 });
 await test("repeat/concurrent saves and fresh service recovery preserve the existing personal edit",async()=>{
  const f=fixture(),[a,b]=await Promise.all([f.service.createExcerpt(f.selection(),"first memo"),f.service.createExcerpt(f.selection(),"second memo")]);assert.equal(a.id,b.id);assert.equal(f.writes.length,1);
  f.files.get(a.annotationPath).text=f.files.get(a.annotationPath).text.replace(/first memo|second memo/g,"user edit");const saved=f.files.get(a.annotationPath).text;
  const reloaded=new AnnotationService(f.app,{}),found=await reloaded.findAnnotationForSelection(f.selection());assert.equal(found.id,a.id);assert.equal(found.manualText,"user edit");
  await reloaded.createExcerpt(f.selection(),"do not overwrite");assert.equal(f.files.get(a.annotationPath).text,saved);assert.equal(f.writes.length,1);
  const second=await reloaded.createExcerpt(f.selection("repeated sentence",f.body.lastIndexOf("repeated sentence")));assert.notEqual(second.id,a.id);
 });
 await test("changed text elsewhere, changed positions and missing originals cannot rebind a captured selection",async()=>{
  const f=fixture(),s=f.selection(),r=await f.service.createExcerpt(s);f.files.get(f.source).text=f.body+"changed";const writes=f.writes.length;
  await assert.rejects(f.service.createExcerpt(s),/版本已变化/);assert.match(await f.service.getExcerptStatus(r),/需复查/);assert.equal(f.writes.length,writes);
  f.files.get(f.source).text=f.body;assert.throws(()=>prepareExcerpt({...s,sourceStart:s.sourceStart+1},f.body),/位置/);
  f.files.delete(f.source);assert.match(await f.service.getExcerptStatus(r),/缺失/);await assert.rejects(f.service.createExcerpt(s),/不存在/);
 });
 await test("failure after committing a file and failure before writing both recover without duplicate files",async()=>{
  const f=fixture(),create=f.app.vault.create;let fail=true;
  f.app.vault.create=async(...args)=>{if(fail){fail=false;throw Error("disk full");}return create(...args);};
  await assert.rejects(f.service.createExcerpt(f.selection()),/disk full/);assert.equal(f.writes.length,0);
  f.app.vault.create=async(...args)=>{await create(...args);throw Error("response lost");};const saved=await f.service.createExcerpt(f.selection());assert.ok(saved.excerpt);assert.equal(f.writes.length,1);
 });
 await test("cancellation/late source changes stop before a note write; incoming mutable selections are copied",async()=>{
  const f=fixture(),s=f.selection(),c=new AbortController();c.abort();await assert.rejects(f.service.createExcerpt(s,"",c.signal),/abort/i);assert.equal(f.writes.length,0);
  const make=f.app.vault.createFolder;f.app.vault.createFolder=async p=>{await make(p);f.files.get(f.source).text=f.body+"late";};
  await assert.rejects(f.service.createExcerpt(s),/版本已变化/);assert.equal(f.writes.length,0);
  const g=fixture(),selection=g.selection(),p=g.service.createExcerpt(selection);selection.selectedText="mutated";selection.sourceRevision.digest="0".repeat(64);assert.equal((await p).selectedText,"repeated sentence");
 });
 await test("corrupt receipts, occupied paths and control markers never overwrite or masquerade as legacy notes",async()=>{
  const f=fixture(),r=await f.service.createExcerpt(f.selection());const entry=f.files.get(r.annotationPath);entry.text=entry.text.replace('"version":1','"version":99');const corrupt=entry.text;
  assert.equal(readAnnotationRecords(corrupt,r.annotationPath).records.length,0);await assert.rejects(f.service.createExcerpt(f.selection()),/冲突/);assert.equal(entry.text,corrupt);
  await assert.rejects(f.service.createExcerpt(f.selection(),"<!-- agent-dashboard:manual-end -->"),/控制标记/);
  assert.throws(()=>prepareExcerpt({...f.selection(),sourceRevision:undefined},f.body),/重新选择/);assert.throws(()=>prepareExcerpt({...f.selection(),sourcePath:"papers/../outside.md"},f.body),/重新选择/);
 });
 await test("editor selections trim whitespace while keeping exact raw-text offsets and a captured revision",async()=>{
  const f=fixture(),raw=" repeated sentence.",start=f.body.indexOf(raw),priorWindow=globalThis.window,priorRect=globalThis.DOMRect;
  globalThis.window={getSelection:()=>null};globalThis.DOMRect=class{};
  f.app.workspace={getActiveViewOfType:()=>({file:f.files.get(f.source).file,editor:{getSelection:()=>raw,listSelections:()=>[{anchor:{ch:start},head:{ch:start+raw.length}}],posToOffset:p=>p.ch}})};
  try{const selection=await f.service.captureSelection();assert.equal(selection.selectedText,raw.trim());assert.equal(selection.sourceStart,start+1);assert.equal(f.body.slice(selection.sourceStart,selection.sourceEnd),selection.selectedText);assert.ok((await f.service.createExcerpt(selection)).excerpt);}finally{globalThis.window=priorWindow;globalThis.DOMRect=priorRect;}
 });
 await test("library joins a verified text excerpt by its source and marks it changed without rewriting after edits",async()=>{
  const f=fixture(),r=await f.service.createExcerpt(f.selection(),"memo"),empty={read:async()=>null,list:async()=>[]};
  const read=()=>readPaperLibrary(f.storage,empty,{vaultRoot:path.resolve("memory-excerpt"),parseYaml:()=>({})});
  const result=await read(),paper=result.papers.find(p=>p.objects.some(o=>o.id===f.source)),item=paper.objects.find(o=>o.kind==="annotation");
  assert.ok(item);assert.equal(item.binding.state,"matched");assert.deepEqual(item.roles,["original_quote","personal_note"]);assert.equal(item.annotationProvenance.format,"dashboard-excerpt-1");
  const before=f.files.get(r.annotationPath).text;f.files.get(f.source).text=f.body+"new paragraph";const changed=(await read()).papers.flatMap(p=>p.objects).find(o=>o.kind==="annotation");assert.equal(changed.binding.state,"changed");assert.equal(f.files.get(r.annotationPath).text,before);
  f.files.delete(f.source);const missing=(await read()).papers.flatMap(p=>p.objects).find(o=>o.kind==="annotation");assert.equal(missing.binding.state,"unresolved");assert.match(missing.binding.reason,/保留历史摘录/);
 });
 console.log(`EXCERPTS_OK (${n} groups; memory files, real services, zero model/network calls)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
