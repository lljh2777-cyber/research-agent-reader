"use strict";
// Real validators with a memory-only vault and read-only journal adapter.
const assert=require("node:assert/strict"),{fixture,mocks}=require("./excerpt-fixtures.cjs"),{loadReading}=require("./reading-test-helpers");
const {readExcerptHistory,excerptHistoryDestination}=loadReading("annotations/excerpt-history.ts",mocks);
const {ExcerptLibraryService}=loadReading("annotations/excerpt-library.ts",mocks);
const {prepareExcerptCuration}=loadReading("curation/excerpt.ts",mocks),{curationParagraphs}=loadReading("curation/policy.ts",mocks);
const id=n=>"c-"+String(n).padStart(8,"0")+"-0000-0000-0000-000000000000";
function journal(f){return {
 list:async dir=>[...f.records.keys()].filter(k=>k.startsWith(dir.split("/")[1]+":")).map(k=>({name:k.split(":")[1]+".json",directory:false})),
 read:async(p,limit)=>{const parts=p.split("/"),v=f.records.get(parts[1]+":"+parts[2].slice(0,-5));if(!v)return null;const bytes=Buffer.from(JSON.stringify(v));if(bytes.length>limit)throw Error("size limit");return bytes;}
};}
let count=0;async function test(name,run){await run();count++;console.log("PASS excerpt history: "+name);}
(async()=>{
 await test("empty history is read-only and requires exact excerpt identity",async()=>{
  const f=await fixture(),before=JSON.stringify([...f.files]),data=await readExcerptHistory(journal(f),f.record);assert.deepEqual(data,{entries:[],issues:[]});assert.equal(JSON.stringify([...f.files]),before);assert.equal(f.records.size,0);
  await assert.rejects(readExcerptHistory(journal(f),{...f.record,annotationPath:"wiki/annotations/other.md"}),/标识/);
 });
 await test("multiple targets retain exact batch, apply, undo and before/after snapshots",async()=>{
  const f=await fixture(),{review,plan}=await f.preview();await f.writer.apply(plan);const undo=await f.writer.previewUndo(plan.id);await f.writer.applyUndo(undo);
  const other="wiki/methods/second.md";f.put(other,f.original);const context=await prepareExcerptCuration(f.app,f.record,other,curationParagraphs(f.original)[0].id,false);await f.service.saveExcerpt(context);
  const before=JSON.stringify([...f.records]),writes=f.writes.length,result=await readExcerptHistory(journal(f),f.record);assert.deepEqual(result.issues,[]);assert.equal(result.entries.length,4);
  const applied=result.entries.find(e=>e.id===plan.id),reverted=result.entries.find(e=>e.id===undo.id);assert.equal(applied.label,"补充已撤销");assert.equal(reverted.label,"已撤销补充");assert.equal(applied.before,f.original);assert.equal(reverted.after,f.original);assert.ok(reverted.detail.includes(plan.id));assert.ok(result.entries.some(e=>e.path===other));assert.ok(result.entries.some(e=>e.id===review.id));assert.equal(JSON.stringify([...f.records]),before);assert.equal(f.writes.length,writes);
  f.files.clear();assert.equal((await readExcerptHistory(journal(f),f.record)).entries.length,4); // historical snapshots survive missing current sources/targets
 });
 await test("pending, recovery and failed undo never claim success",async()=>{
  const f=await fixture(),{plan}=await f.preview();await f.service.saveRevision(plan);let r=await readExcerptHistory(journal(f),f.record);assert.match(r.entries.find(e=>e.id===plan.id).label,/未完成/);
  await f.writer.resume(plan.id);const undo=await f.writer.previewUndo(plan.id);undo.state="recovery";undo.error="disk unavailable";await f.service.saveRevision(undo);
  r=await readExcerptHistory(journal(f),f.record);assert.equal(r.entries.find(e=>e.id===plan.id).label,"已补充（历史记录）");assert.match(r.entries.find(e=>e.id===undo.id).label,/撤销未完成/);assert.match(r.entries.find(e=>e.id===undo.id).detail,/disk unavailable/);
 });
 await test("manual status changes preserve history but invalidate old write previews",async()=>{
  const f=await fixture(),{plan}=await f.preview(),library=new ExcerptLibraryService(f.app),old=await library.load(f.record);await library.setCompleted(old,true);
  const history=await readExcerptHistory(journal(f),f.record);assert.equal(history.entries[0].excerptDigest,old.digest);assert.notEqual(history.entries[0].excerptDigest,(await library.load(f.record)).digest);await assert.rejects(f.writer.apply(plan),/摘录.*变化/);assert.equal(f.files.get(f.target).text,f.original);
 });
 await test("history navigation compares latest raw records including newly applied undo",async()=>{
  const f=await fixture(),{plan}=await f.preview();await f.writer.apply(plan);const first=await readExcerptHistory(journal(f),f.record),entry=first.entries.find(e=>e.id===plan.id);assert.equal(excerptHistoryDestination(entry,first),f.target);
  const undo=await f.writer.previewUndo(plan.id);await f.writer.applyUndo(undo);const fresh=await readExcerptHistory(journal(f),f.record);assert.throws(()=>excerptHistoryDestination(entry,fresh),/历史已变化/);
  assert.throws(()=>excerptHistoryDestination({...fresh.entries[0],path:"wiki/concepts/same-title.md"},fresh),/历史已变化/);
 });
 await test("malformed original cannot authenticate undo and unrelated excerpts stay separate",async()=>{
  const f=await fixture(),{plan}=await f.preview();await f.writer.apply(plan);const undo=await f.writer.previewUndo(plan.id);await f.writer.applyUndo(undo);
  f.records.get("revisions:"+plan.id).writes[0].after+="forged";let r=await readExcerptHistory(journal(f),f.record);assert.equal(r.entries.filter(e=>e.kind==="revision").length,0);assert.equal(r.issues.length,2);
  const another=await fixture({source:"Clippings/other.md"}),{review}=await another.preview();f.records.set("reviews:"+review.id,review);r=await readExcerptHistory(journal(f),f.record);assert.ok(!r.entries.some(e=>e.id===review.id));
 });
 await test("partial errors, duplicate IDs, cancellation and read limits are explicit",async()=>{
  const f=await fixture(),{review}=await f.preview(),io=journal(f);let r=await readExcerptHistory({...io,list:async dir=>dir.endsWith("revisions")?Promise.reject(Error("disk failure")):io.list(dir)},f.record);assert.equal(r.entries.length,1);assert.equal(r.issues.length,1);
  r=await readExcerptHistory({...io,list:async dir=>{const rows=await io.list(dir);return [...rows,...rows];}},f.record);assert.equal(r.entries.length,0);assert.ok(r.issues.some(s=>s.includes("重复")));
  const c=new AbortController();await assert.rejects(readExcerptHistory({...io,read:async(...args)=>{c.abort();return io.read(...args);}},f.record,c.signal),/abort/i);
  r=await readExcerptHistory({...io,list:async dir=>dir.endsWith("reviews")?Array.from({length:257},(_,i)=>({name:id(i)+".json",directory:false})):[],read:async p=>Buffer.from(JSON.stringify({...review,id:p.split("/").pop().slice(0,-5)}))},f.record);assert.equal(r.entries.length,256);assert.ok(r.issues.some(s=>s.includes("上限")));
  r=await readExcerptHistory({...io,read:async()=>Buffer.from("{")},f.record);assert.equal(r.entries.length,0);assert.equal(r.issues.length,1);
 });
 console.log(`EXCERPT_HISTORY_OK (${count} groups; memory-only)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
