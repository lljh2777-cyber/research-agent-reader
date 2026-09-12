"use strict";
// Actual excerpt services, memory-only files, no deletion/network/model calls.
const assert=require("node:assert/strict"), path=require("node:path"), {loadReading}=require("./reading-test-helpers");
class TFile {constructor(p){this.path=p;this.basename=path.posix.basename(p,".md");this.extension="md";this.stat={size:0};}}
class MarkdownView {}
const mocks={obsidian:{TFile,MarkdownView,Notice:class{},normalizePath:p=>p}};
const {AnnotationService}=loadReading("annotations/annotation-service.ts",mocks);
const {ExcerptLibraryService,readExcerptSnapshot,patchExcerptNote,patchExcerptOrganization}=loadReading("annotations/excerpt-library.ts",mocks);
const {excerptRevision}=loadReading("annotations/excerpt.ts");
async function fixture(eol="\n",source="Clippings/repeated.md"){
 const body=["# Study","","😀 第一处 repeated sentence.","","第二处 repeated sentence.",""].join(eol),start=body.lastIndexOf("repeated sentence"),quote="repeated sentence";
 const files=new Map([[source,{file:new TFile(source),text:body}]]), writes=[],opened=[],selections=[];
 const app={vault:{getAbstractFileByPath:p=>files.get(p)?.file||null,getMarkdownFiles:()=>[...files.values()].map(x=>x.file).filter(x=>x instanceof TFile),
 read:async f=>{if(!files.has(f.path))throw Error("missing");return files.get(f.path).text;},
 createFolder:async p=>files.set(p,{file:{path:p}}),create:async(p,text)=>{assert.ok(!files.has(p));const file=new TFile(p);files.set(p,{file,text});writes.push(p);return file;},
 process:async(f,fn)=>{const current=files.get(f.path);if(!current)throw Error("missing");current.text=fn(current.text);writes.push(f.path);}},workspace:{getLeaf:()=>({view:null,async openFile(file){opened.push(file.path);const view=this.view=new MarkdownView();view.file=file;view.editor={getValue:()=>files.get(file.path).text,offsetToPos:i=>({line:body.slice(0,i).split("\n").length-1,ch:i-(body.lastIndexOf("\n",i-1)+1)}),setSelection:(a,b)=>selections.push({a,b}),scrollIntoView:()=>{},focus:()=>{}};}})}};
 const creator=new AnnotationService(app,{}),service=new ExcerptLibraryService(app);
 const record=await creator.createExcerpt({sourcePath:source,selectedText:quote,sourceStart:start,sourceEnd:start+quote.length,prefix:body.slice(Math.max(0,start-80),start),suffix:body.slice(start+quote.length,start+quote.length+80),sourceRevision:excerptRevision(body),section:"",context:"",isTableCell:false,anchorRect:{}},"initial memo");
 if(eol==="\r\n")files.get(record.annotationPath).text=files.get(record.annotationPath).text.replace(/\r?\n/g,"\r\n");
 return {files,app,record,service,writes,body,source,start,opened,selections};
}
let count=0;const test=async(name,run)=>{await run();count++;console.log("PASS excerpt library: "+name);};
(async()=>{
 await test("read-only listing, source freshness and reload from a new service",async()=>{
  const f=await fixture(),before=[...f.files].map(([k,v])=>[k,v.text]);
  const result=await f.service.list();assert.equal(result.entries.length,1);assert.deepEqual(result.issues,[]);assert.match(await f.service.status(result.entries[0]),/文本与保存时一致/);
  assert.deepEqual([...f.files].map(([k,v])=>[k,v.text]),before);assert.equal((await new ExcerptLibraryService(f.app).load(f.record)).record.manualText,"initial memo");
  f.files.get(f.source).text+=" changed";assert.match(await f.service.status(result.entries[0]),/版本已变化/);f.files.delete(f.source);assert.match(await f.service.status(result.entries[0]),/已缺失/);
 });
 await test("LF/CRLF edits preserve source receipts, extra prose, AI and unknown metadata",async()=>{
  for(const eol of ["\n","\r\n"]){const f=await fixture(eol),entry=f.files.get(f.record.annotationPath);
   entry.text=entry.text.replace('"createdAt":','"unknownFutureField":{"keep":true},"createdAt":').replace("<!-- agent-dashboard:ai-start -->"+eol,"<!-- agent-dashboard:ai-start -->"+eol+"independent AI text"+eol)+eol+"User appendix remains byte exact";
   const snapshot=await f.service.load(f.record),saved=await f.service.saveNote(snapshot,"  新的个人笔记 😀\n第二行  ");
   assert.equal(saved.record.manualText,"新的个人笔记 😀\n第二行");assert.deepEqual(saved.record.excerpt,snapshot.record.excerpt);assert.deepEqual(saved.record.sourceAnchor,snapshot.record.sourceAnchor);assert.equal(saved.record.aiText,"independent AI text");
   assert.ok(entry.text.includes('"unknownFutureField":{"keep":true}'));assert.ok(entry.text.endsWith(eol+"User appendix remains byte exact"));assert.equal(f.files.get(f.source).text,f.body);
   const unchanged=entry.text;await f.service.saveNote(saved,saved.record.manualText);assert.equal(entry.text,unchanged);
  }
 });
 await test("whole-file concurrent edit conflicts, explicit refresh and exact retry",async()=>{
  const f=await fixture(),snap=await f.service.load(f.record),entry=f.files.get(f.record.annotationPath);
  entry.text+="\nExternal appendix";const before=entry.text;await assert.rejects(f.service.saveNote(snap,"draft preserved"),/其他窗口/);assert.equal(entry.text,before);
  const latest=await f.service.load(f.record);const results=await Promise.allSettled([f.service.saveNote(latest,"first"),f.service.saveNote(latest,"second")]);assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(results.filter(x=>x.status==="rejected").length,1);
  assert.ok(entry.text.endsWith("External appendix"));
 });
 await test("write failure before commit and response loss after commit are distinguished",async()=>{
  const f=await fixture(),snap=await f.service.load(f.record),process=f.app.vault.process,before=f.files.get(f.record.annotationPath).text;
  f.app.vault.process=async()=>{throw Error("disk unavailable");};await assert.rejects(f.service.saveNote(snap,"new"),/disk unavailable/);assert.equal(f.files.get(f.record.annotationPath).text,before);
  f.app.vault.process=async(...args)=>{await process(...args);throw Error("response lost");};assert.equal((await f.service.saveNote(snap,"new")).record.manualText,"new");
 });
 await test("cancel at process boundary never writes; invalid notes and ambiguous partitions rejected",async()=>{
  const f=await fixture(),snap=await f.service.load(f.record),entry=f.files.get(f.record.annotationPath),before=entry.text,process=f.app.vault.process,c=new AbortController();
  f.app.vault.process=async(...args)=>{c.abort();return process(...args);};await assert.rejects(f.service.saveNote(snap,"new",c.signal),/abort/i);assert.equal(entry.text,before);
  assert.throws(()=>patchExcerptNote(before,snap,"<!-- agent-dashboard:manual-end -->","now"),/控制标记/);assert.throws(()=>patchExcerptNote(before,snap,"x".repeat(10001),"now"),/过长/);
  for(const bad of [before+"\n<!-- agent-dashboard:manual-end -->",before.replace('"version":1','"version":99'),before+before]) assert.throws(()=>readExcerptSnapshot(bad,f.record),/损坏|重复/);
  assert.throws(()=>readExcerptSnapshot(before,{...f.record,annotationPath:"wiki/annotations/../outside.md"}),/路径/);
  f.app.vault.process=async(file,fn)=>{file.path="wiki/annotations/moved.md";entry.text=fn(entry.text);};
  await assert.rejects(f.service.saveNote(snap,"new"),/已移动或替换/);assert.equal(entry.text,before);
 });
 await test("corrupt and oversized excerpt files remain visible as read issues, legacy notes excluded",async()=>{
  const f=await fixture(),bad="wiki/annotations/ann-excerpt-"+"f".repeat(48)+".md";
  f.files.set(bad,{file:new TFile(bad),text:"damaged"});f.files.set("wiki/annotations/legacy.md",{file:new TFile("wiki/annotations/legacy.md"),text:"legacy"});
  const result=await f.service.list();assert.equal(result.entries.length,1);assert.equal(result.issues.length,1);assert.ok(result.issues[0].includes(bad));
  f.files.get(f.record.annotationPath).file.stat.size=130*1024;assert.equal((await f.service.list()).issues.length,2);
  const c=new AbortController();c.abort();await assert.rejects(f.service.list(c.signal),/abort/i);
 });
 await test("exact second occurrence opens in Markdown and selects Unicode-aware raw offsets for each source root",async()=>{
  for(const source of ["Clippings/repeated.md","papers/mineru/article.md","papers/jats/article.md"]){const f=await fixture("\r\n",source);await f.service.openSource(f.record);assert.deepEqual(f.opened,[source]);assert.equal(f.selections.length,1);assert.equal(f.selections[0].a.line,4);assert.equal(f.selections[0].a.ch,4);assert.equal(f.selections[0].b.ch,21);assert.equal(f.writes.length,1);}
 });
 await test("stale/missing sources, changed editor content and cancellation never select another paragraph",async()=>{
  const f=await fixture();f.files.get(f.source).text+=" change";await assert.rejects(f.service.openSource(f.record),/版本已变化/);assert.equal(f.opened.length,0);
  f.files.get(f.source).text=f.body;const get=f.app.workspace.getLeaf;f.app.workspace.getLeaf=()=>{const leaf=get();const open=leaf.openFile;leaf.openFile=async function(file){await open.call(leaf,file);leaf.view.editor.getValue=()=>"unsaved edits";};return leaf;};
  await assert.rejects(f.service.openSource(f.record),/编辑器文本不一致/);assert.equal(f.selections.length,0);
  f.files.delete(f.source);await assert.rejects(f.service.openSource(f.record),/已缺失/);
  const g=await fixture(),c=new AbortController();c.abort();await assert.rejects(g.service.openSource(g.record,c.signal),/abort/i);assert.equal(g.opened.length,0);
 });
 await test("host Markdown opener preserves the exact leaf and prevents automatic reader replacement",async()=>{
  const f=await fixture(),leaf=f.app.workspace.getLeaf();let called=0;
  const service=new ExcerptLibraryService(f.app,async file=>{called++;await leaf.openFile(file);return leaf;});
  f.app.workspace.getLeaf=()=>{throw Error("Must use host-controlled Markdown bypass");};await service.openSource(f.record);assert.equal(called,1);assert.equal(f.selections.length,1);
 });
 await test("note or source changing during open prevents selection; editing a historical note remains valid",async()=>{
  const f=await fixture(),get=f.app.workspace.getLeaf;
  f.app.workspace.getLeaf=()=>{const leaf=get(),open=leaf.openFile;leaf.openFile=async file=>{await open.call(leaf,file);f.files.get(f.record.annotationPath).text+="\nConcurrent edit";};return leaf;};
  await assert.rejects(f.service.openSource(f.record),/打开期间/);assert.equal(f.selections.length,0);
  f.files.get(f.source).text+="changed";const before=f.files.get(f.source).text;const saved=await f.service.saveNote(await f.service.load(f.record),"historical note edit");assert.equal(saved.record.manualText,"historical note edit");assert.equal(f.files.get(f.source).text,before);
 });
 await test("manual completion and reopen preserve source, note, AI, unknown metadata and LF/CRLF",async()=>{
  for(const eol of ["\n","\r\n"]){const f=await fixture(eol),entry=f.files.get(f.record.annotationPath);entry.text=entry.text.replace('"archiveStatus":','"extra":{"preserve":true},"archiveStatus":')+eol+"Keep this appendix";
   const before=await f.service.load(f.record),complete=await f.service.setCompleted(before,true);assert.equal(complete.record.archiveStatus,"completed");assert.ok(entry.text.includes("- 状态：整理完成"));assert.ok(entry.text.includes('"extra":{"preserve":true}'));assert.ok(entry.text.endsWith("Keep this appendix"));
   const strip=r=>{const copy=structuredClone(r);delete copy.updatedAt;delete copy.archiveStatus;return copy;};assert.deepEqual(strip(complete.record),strip(before.record));
   const unchanged=entry.text;assert.equal(patchExcerptOrganization(unchanged,complete,true,"ignored"),unchanged);const reopened=await new ExcerptLibraryService(f.app).setCompleted(complete,false);assert.equal(reopened.record.archiveStatus,"none");assert.ok(entry.text.includes("- 状态：待整理"));assert.equal(f.files.get(f.source).text,f.body);if(eol==="\r\n")assert.ok(!/(?<!\r)\n/.test(entry.text));
  }
 });
 await test("completion conflicts, cancellation, response loss and existing archive jobs",async()=>{
  const f=await fixture(),old=await f.service.load(f.record),entry=f.files.get(f.record.annotationPath);entry.text+="\nExternal edit";const before=entry.text;await assert.rejects(f.service.setCompleted(old,true),/其他窗口/);assert.equal(entry.text,before);
  const fresh=await f.service.load(f.record),c=new AbortController(),process=f.app.vault.process;f.app.vault.process=async(...args)=>{c.abort();return process(...args);};await assert.rejects(f.service.setCompleted(fresh,true,c.signal),/abort/i);assert.equal(entry.text,before);
  f.app.vault.process=async(...args)=>{await process(...args);throw Error("response lost");};assert.equal((await f.service.setCompleted(fresh,true)).record.archiveStatus,"completed");
  entry.text=entry.text.replace('"archiveRunId":""','"archiveRunId":"legacy-run"');const archive=entry.text;await assert.rejects(f.service.setCompleted(await f.service.load(f.record),false),/归档任务/);assert.equal(entry.text,archive);
 });
 console.log(`EXCERPT_LIBRARY_OK (${count} groups; memory-only services)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
