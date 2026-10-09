"use strict";
// Actual services and adapters, memory-only files. No model/network or filesystem cleanup.
const assert=require('node:assert/strict'),{loadReading}=require('./reading-test-helpers'),{readingFixture,topicFixture,mocks}=require('./answer-excerpt-fixtures.cjs');
const {prepareAnswerExcerpt,renderAnswerExcerpt,readAnswerExcerpt,answerExcerptCompleted,AnswerExcerptService,MAX_ANSWER_HUMAN_HISTORY}=loadReading('learning/answer-excerpts.ts',mocks);
const {readAnswerSnapshot,topicAnswerSnapshot}=loadReading('learning/answer-snapshot.ts',mocks),{readAnswerExcerptPending}=loadReading('learning/answer-excerpt-pending.ts',mocks);
const {readDraftMaterial,draftMaterialText,draftMaterialStatus,newKnowledgeDraft}=loadReading('curation/draft.ts',mocks),{KnowledgeDraftStore}=loadReading('curation/draft-store.ts',mocks),{storage}=require('./source-intake-fixtures.cjs');
async function fixture(){const f=readingFixture(),record=prepareAnswerExcerpt(f.answer(),0,5,'Memo','2026-09-12T00:00:00.000Z'),file=(await f.service.save(record)).file;return{...f,file};}
const reload=f=>new AnswerExcerptService(f.app,(ref,s)=>readAnswerSnapshot(f.storage,ref,s));
let count=0;async function test(name,run){await run();count++;console.log('PASS answer history: '+name);}
(async()=>{
 await test('legacy v1/v2 reads and no-ops never migrate; first edit captures only available baseline',async()=>{
  for(const legacy of [1,2]){const f=await fixture();let file=f.file;
   if(legacy===2){const r={...file.record,version:2,humanRevision:{text:'Legacy current',updated:file.record.updated},organization:{state:'completed',updated:file.record.updated}};f.put(file.path,renderAnswerExcerpt(r));file=await f.service.load(file.path);}
   const before=f.files.get(file.path).text,writes=f.writes.length;await f.service.list();await readAnswerExcerptPending(f.service,new AbortController().signal);assert.equal(f.writes.length,writes);
   assert.equal((await f.service.saveHumanRevision(file,file.record.humanRevision?.text||'')).digest,file.digest);assert.equal(f.files.get(file.path).text,before);
   const next=await f.service.saveHumanRevision(file,'New revision');assert.equal(next.record.version,3);assert.deepEqual(next.record.humanHistory.map(x=>[x.kind,x.text]),[['baseline',legacy===1?'':'Legacy current'],['edit','New revision']]);
   assert.equal(next.record.humanHistory[0].updated,file.record.updated);assert.deepEqual(next.record.answer,file.record.answer);assert.equal(next.record.note,'Memo');
  }
 });
 await test('append, clear, reload and restore preserve the whole sequence and separate roles',async()=>{
  const f=await fixture();let file=await f.service.saveHumanRevision(f.file,'Version A\r\n```\n<script>literal</script>');const first=structuredClone(file.record.humanHistory);
  file=await f.service.saveHumanRevision(file,'Version B');file=await f.service.saveHumanRevision(file,' \n ');assert.equal(file.record.humanRevision,null);assert.equal(file.record.humanHistory.length,4);
  const service=reload(f);file=await service.load(file.path);file=await service.saveNote(file,'Latest memo');const history=structuredClone(file.record.humanHistory);file=await service.setCompleted(file,true);assert.equal(file.record.version,3);assert.ok(answerExcerptCompleted(file.record));assert.deepEqual(file.record.humanHistory,history);
  const restored=await service.restoreHumanRevision(file,1);assert.deepEqual(restored.record.humanHistory.slice(0,2),first);assert.deepEqual(restored.record.humanHistory.slice(0,4),history);assert.equal(restored.record.humanHistory[4].kind,'restore');assert.equal(restored.record.humanHistory[4].restoredFrom,1);assert.equal(restored.record.humanRevision.text,first[1].text);assert.equal(restored.record.note,'Latest memo');assert.deepEqual(restored.record.answer,f.file.record.answer);assert.equal(answerExcerptCompleted(restored.record),false);
  assert.equal((await service.restoreHumanRevision(restored,1)).digest,restored.digest);file=await service.restoreHumanRevision(restored,0);assert.equal(file.record.humanRevision,null);assert.equal(file.record.humanHistory.length,6);
 });
 await test('restore rejects stale editors, invalid indices, cancellation and failed disk writes',async()=>{
  const f=await fixture(),a=await f.service.saveHumanRevision(f.file,'A'),b=await f.service.saveHumanRevision(a,'B'),raw=f.files.get(b.path).text,process=f.app.vault.process;
  await assert.rejects(f.service.restoreHumanRevision(a,0),/修改/);for(const index of [-1,3,0.5,NaN,'1'])await assert.rejects(f.service.restoreHumanRevision(b,index),/请选择/);
  const abort=new AbortController();abort.abort();await assert.rejects(f.service.restoreHumanRevision(b,1,abort.signal),/abort/i);
  f.app.vault.process=async()=>{throw Error('disk failure');};await assert.rejects(f.service.restoreHumanRevision(b,1),/disk failure/);assert.equal(f.files.get(b.path).text,raw);
  f.app.vault.process=async(...args)=>{await process(...args);throw Error('response lost');};const restored=await f.service.restoreHumanRevision(b,1);assert.equal(restored.record.humanHistory.length,4);assert.equal(restored.record.humanRevision.text,'A');
 });
 await test('concurrent restore and edit commit exactly one sequence without erasing history',async()=>{
  const f=await fixture(),a=await f.service.saveHumanRevision(f.file,'A'),b=await f.service.saveHumanRevision(a,'B'),other=reload(f);
  const results=await Promise.allSettled([f.service.restoreHumanRevision(b,1),other.saveHumanRevision(b,'C')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const current=await f.service.load(b.path);assert.deepEqual(current.record.humanHistory.slice(0,3),b.record.humanHistory);assert.equal(current.record.humanHistory.length,4);
 });
 await test('history count limit preserves everything while notes, completion and no-op saves remain usable',async()=>{
  const f=await fixture();let file=f.file;for(let i=1;i<MAX_ANSWER_HUMAN_HISTORY;i++)file=await f.service.saveHumanRevision(file,'Revision '+i);
  const raw=f.files.get(file.path).text,history=structuredClone(file.record.humanHistory);await assert.rejects(f.service.saveHumanRevision(file,'Over limit'),/上限/);await assert.rejects(f.service.restoreHumanRevision(file,0),/上限/);assert.equal(f.files.get(file.path).text,raw);
  file=await f.service.setCompleted(file,true);assert.equal((await f.service.restoreHumanRevision(file,63)).digest,file.digest);file=await f.service.saveNote(file,'Useful note');assert.deepEqual(file.record.humanHistory,history);assert.equal(answerExcerptCompleted(file.record),false);
 });
 await test('history validation rejects corrupt chains, timestamps, references and legacy masquerades',async()=>{
  const f=await fixture(),a=await f.service.saveHumanRevision(f.file,'A'),b=await f.service.saveHumanRevision(a,'B'),r=await f.service.restoreHumanRevision(b,1);
  const bad=[x=>x.humanHistory=undefined,x=>x.humanHistory=[],x=>x.humanHistory[0].kind='edit',x=>x.humanHistory[1].kind='baseline',x=>x.humanHistory[1].text=' ',x=>x.humanHistory[1].updated='bad',x=>x.humanHistory[1].updated='2020-01-01T00:00:00.000Z',x=>x.humanHistory[1].updated='2099-01-01T00:00:00.000Z',x=>x.humanHistory[2].text='A',x=>x.humanHistory[3].restoredFrom=3,x=>x.humanHistory[3].restoredFrom=2,x=>x.humanHistory[1].restoredFrom=0,x=>x.humanRevision.text='Other',x=>x.humanRevision.updated=x.created,x=>x.version=2,x=>x.humanHistory[0].text='x'.repeat(20001)];
  for(const mutate of bad){const copy=structuredClone(r.record);mutate(copy);assert.throws(()=>readAnswerExcerpt(renderAnswerExcerpt(copy),r.path));}
  assert.throws(()=>readAnswerExcerpt(f.files.get(r.path).text.replace('## 人工修订历史','## Forged history'),r.path));
 });
 await test('two MiB file bound rejects oversized accumulated history without partial writes',async()=>{
  const f=await fixture();let file=f.file,blocked=false;for(let i=0;i<63;i++){const raw=f.files.get(file.path).text;try{file=await f.service.saveHumanRevision(file,'<'.repeat(19990)+i);}catch(e){assert.match(String(e),/读取上限/);assert.equal(f.files.get(file.path).text,raw);blocked=true;break;}}assert.ok(blocked);assert.ok((await f.service.load(file.path)).record.humanHistory.length<64);
 });
 await test('restoring reopens pending work and unchanged restore retains manual completion',async()=>{
  const f=await fixture();let file=await f.service.saveHumanRevision(f.file,'A');file=await f.service.saveHumanRevision(file,'B');file=await f.service.setCompleted(file,true);assert.equal((await readAnswerExcerptPending(f.service,new AbortController().signal)).entries.length,0);
  file=await f.service.restoreHumanRevision(file,2);assert.equal((await readAnswerExcerptPending(f.service,new AbortController().signal)).entries.length,0);file=await f.service.restoreHumanRevision(file,1);assert.equal((await readAnswerExcerptPending(f.service,new AbortController().signal)).entries[0].file.digest,file.digest);
 });
 await test('knowledge draft snapshots stay fixed; new material uses current revision, never history prose',async()=>{
  const f=await fixture();let file=await f.service.saveHumanRevision(f.file,'SENTINELA');f.files.get(file.path).file.extension='md';const material=await readDraftMaterial(f.app,{kind:'answer',path:file.path,roles:['human','note']}),s=new KnowledgeDraftStore(storage()),d={...newKnowledgeDraft(),title:'History test',body:'Manual summary',material},saved=await s.save(d,null);
  file=await f.service.saveHumanRevision(file,'SENTINELB');const next=await readDraftMaterial(f.app,{kind:'answer',path:file.path,roles:['human']});assert.match(draftMaterialText(next),/SENTINELB/);assert.doesNotMatch(draftMaterialText(next),/SENTINELA/);assert.match(await draftMaterialStatus(f.app,f.service,material),/变化/);
  file=await f.service.restoreHumanRevision(file,1);assert.equal((await s.read(d.id)).current.digest,saved.digest);assert.equal((await s.read(d.id)).current.draft.material.raw,material.raw);assert.match(await draftMaterialStatus(f.app,f.service,material),/变化/);
 });
 await test('topic histories retain saved request and route without additional teaching calls',async()=>{
  const t=await topicFixture(),study=await t.study(),a=topicAnswerSnapshot(study,study.nodes[0].id),f=readingFixture(),service=new AnswerExcerptService(f.app,(ref,s)=>readAnswerSnapshot(t.storage,ref,s)),writes=t.storage.writes.length;
  let file=(await service.save(prepareAnswerExcerpt(a))).file;file=await service.saveHumanRevision(file,'A');file=await service.saveHumanRevision(file,'B');file=await service.restoreHumanRevision(file,1);assert.deepEqual(file.record.answer,a);assert.equal(t.calls(),1);assert.equal(t.storage.writes.length,writes);
 });
 console.log(`ANSWER_HISTORY_OK (${count} groups; memory-only)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
