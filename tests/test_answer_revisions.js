"use strict";
// Memory-only services, actual parsers and projections; no providers or file cleanup.
const assert=require('node:assert/strict'),{loadReading}=require('./reading-test-helpers'),{mocks,readingFixture,topicFixture}=require('./answer-excerpt-fixtures.cjs');
const {prepareAnswerExcerpt,renderAnswerExcerpt,readAnswerExcerpt,answerExcerptCompleted,AnswerExcerptService}=loadReading('learning/answer-excerpts.ts',mocks);
const {readAnswerSnapshot,topicAnswerSnapshot}=loadReading('learning/answer-snapshot.ts',mocks);
const {readAnswerExcerptPending}=loadReading('learning/answer-excerpt-pending.ts',mocks);
const {readPendingCenter,pendingDestination,filterPending}=loadReading('services/pending-center.ts');
const {AnswerExcerptBrowser}=loadReading('views/answer-excerpt-browser.ts',{obsidian:{...mocks.obsidian,Modal:class{}}});
const signal=()=>new AbortController().signal;
const inputs=service=>({library:async()=>({papers:[],readIssues:[],complete:true}),acquisitions:{listJobs:async()=>[],readJob:async()=>null},local:async()=>[],excerpts:async()=>({entries:[],issues:[]}),curation:async()=>({entries:[],issues:[]}),tasks:()=>[],answerExcerpts:s=>readAnswerExcerptPending(service,s)});
async function fixture(){const f=readingFixture(),record=prepareAnswerExcerpt(f.answer(),0,5,'Personal memo','2026-09-12T00:00:00.000Z'),saved=await f.service.save(record);return{...f,file:saved.file,record};}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS answer revisions: '+name);}
(async()=>{
 await test('v1 viewing and no-op edits are byte-stable; v2 upgrade preserves the original and memo',async()=>{
  const f=await fixture(),raw=f.files.get(f.file.path).text,writes=f.writes.length;
  assert.equal((await f.service.list()).entries[0].record.version,1);await readAnswerExcerptPending(f.service,signal());assert.equal(f.writes.length,writes);
  assert.equal((await f.service.saveHumanRevision(f.file,'')).digest,f.file.digest);assert.equal((await f.service.setCompleted(f.file,false)).digest,f.file.digest);assert.equal(f.files.get(f.file.path).text,raw);
  const saved=await f.service.saveHumanRevision(f.file,'My revision\r\n```dataviewjs\napp.test()\n```\n[[not-evidence]]');
  assert.equal(saved.record.version,2);assert.deepEqual(saved.record.answer,f.record.answer);assert.equal(saved.record.note,'Personal memo');assert.equal(saved.path,f.file.path);
  assert.ok(f.files.get(saved.path).text.includes('````text\n'+saved.record.humanRevision.text+'\n````'));assert.equal(readAnswerExcerpt(f.files.get(saved.path).text,saved.path).digest,saved.digest);
  const reloaded=new AnswerExcerptService(f.app,(ref,s)=>readAnswerSnapshot(f.storage,ref,s));assert.deepEqual((await reloaded.load(saved.path)).record,saved.record);
  assert.equal((await reloaded.save(f.record)).file.record.humanRevision.text,saved.record.humanRevision.text);
 });
 await test('completion is manual and content changes reopen work; no-op edits preserve completion',async()=>{
  const f=await fixture();let file=await f.service.setCompleted(f.file,true);assert.ok(answerExcerptCompleted(file.record));
  assert.equal((await f.service.setCompleted(file,true)).digest,file.digest);assert.equal((await f.service.saveNote(file,file.record.note)).digest,file.digest);
  file=await f.service.saveHumanRevision(file,'Revision');assert.equal(answerExcerptCompleted(file.record),false);
  file=await f.service.setCompleted(file,true);assert.equal((await f.service.saveHumanRevision(file,'Revision')).digest,file.digest);
  file=await f.service.saveNote(file,'Changed memo');assert.equal(answerExcerptCompleted(file.record),false);assert.equal(file.record.humanRevision.text,'Revision');
  file=await f.service.saveHumanRevision(file,'  ');assert.equal(file.record.humanRevision,null);assert.deepEqual(file.record.answer,f.record.answer);
 });
 await test('whole-file conflicts and concurrent writers preserve all independent content roles',async()=>{
  const f=await fixture(),first=await f.service.saveHumanRevision(f.file,'First revision');
  await assert.rejects(f.service.saveNote(f.file,'Stale memo'),/修改/);await assert.rejects(f.service.setCompleted(f.file,true),/修改/);
  const other=new AnswerExcerptService(f.app,(ref,s)=>readAnswerSnapshot(f.storage,ref,s));
  const result=await Promise.allSettled([f.service.saveHumanRevision(first,'Second revision'),other.saveNote(first,'Concurrent memo')]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);const current=await f.service.load(first.path);assert.deepEqual(current.record.answer,f.record.answer);
  const raw=f.files.get(first.path).text;f.files.get(first.path).text+='External prose';await assert.rejects(f.service.saveHumanRevision(current,'Must not write'),/修改/);assert.equal(f.files.get(first.path).text,raw+'External prose');
 });
 await test('cancel, process failures and lost responses do not manufacture a successful revision',async()=>{
  const f=await fixture(),c=new AbortController(),process=f.app.vault.process,raw=f.files.get(f.file.path).text;c.abort();
  await assert.rejects(f.service.saveHumanRevision(f.file,'cancel',c.signal),/abort/i);assert.equal(f.files.get(f.file.path).text,raw);
  f.app.vault.process=async()=>{throw Error('disk failure');};await assert.rejects(f.service.saveHumanRevision(f.file,'failure'),/disk failure/);assert.equal(f.files.get(f.file.path).text,raw);
  f.app.vault.process=async(...args)=>{await process(...args);throw Error('response lost');};const saved=await f.service.saveHumanRevision(f.file,'Committed revision');assert.equal(saved.record.humanRevision.text,'Committed revision');
  const cancel=new AbortController();f.app.vault.process=async(file,fn)=>{cancel.abort();return process(file,fn);};await assert.rejects(f.service.setCompleted(saved,true,cancel.signal),/abort/i);assert.equal(answerExcerptCompleted((await f.service.load(saved.path)).record),false);
 });
 await test('v2 validation rejects forged roles, dates, oversized drafts and mismatched visible content',async()=>{
  const f=await fixture(),saved=await f.service.saveHumanRevision(f.file,'Human');
  for(const change of [r=>r.humanRevision.text='',r=>r.humanRevision.updated='bad',r=>r.organization.state='scientifically-verified',r=>r.version=1,r=>r.humanRevision=undefined]){const r=structuredClone(saved.record);change(r);assert.throws(()=>readAnswerExcerpt(renderAnswerExcerpt(r),saved.path));}
  const raw=f.files.get(saved.path).text;assert.throws(()=>readAnswerExcerpt(raw.replace('## 人工修订稿','## Verified paper'),saved.path));
  await assert.rejects(f.service.saveHumanRevision(saved,'x'.repeat(20001)),/两万/);assert.equal(f.files.get(saved.path).text,raw);
 });
 await test('pending center routes exact AI excerpts, hides completed matching work and rejects stale destinations',async()=>{
  const f=await fixture(),deps=inputs(f.service);const before=await readPendingCenter(deps,signal()),row=before.items[0];assert.equal(row.category,'learning');assert.equal(row.target.path,f.file.path);
  assert.equal(filterPending(before.items,'saved answer','learning').length,1);assert.equal(pendingDestination(row,await readPendingCenter(deps,signal())).kind,'answer-excerpt');
  let file=await f.service.setCompleted(f.file,true);const complete=await readPendingCenter(deps,signal());assert.equal(complete.items.length,0);assert.throws(()=>pendingDestination(row,complete),/变化/);
  file=await f.service.saveNote(file,'Changed');const reopened=await readPendingCenter(deps,signal());assert.equal(reopened.items[0].category,'learning');assert.throws(()=>pendingDestination(row,reopened),/变化/);
  const digest=file.record.answer.digest;await f.service.setCompleted(file,true);f.node.content+=' changed';f.persist();const changed=await readPendingCenter(deps,signal());assert.equal(changed.items[0].category,'review');assert.match(changed.items[0].detail,/变化/);
  assert.equal((await f.service.load(file.path)).record.answer.digest,digest);f.storage.files.clear();const missing=await readPendingCenter(deps,signal());assert.equal(missing.items[0].category,'review');assert.match(missing.items[0].detail,/无法核对/);
  assert.throws(()=>pendingDestination(changed.items[0],missing),/变化/);assert.equal(f.storage.writes.length,0);
 });
 await test('topic human revisions retain fixed request history and never make additional teaching calls',async()=>{
  const t=await topicFixture(),study=await t.study(),a=topicAnswerSnapshot(study,study.nodes[0].id),f=readingFixture(),service=new AnswerExcerptService(f.app,(ref,s)=>readAnswerSnapshot(t.storage,ref,s)),writes=t.storage.writes.length;
  const file=(await service.save(prepareAnswerExcerpt(a))).file,revision=await service.saveHumanRevision(file,'My learning revision');
  assert.deepEqual(revision.record.answer,a);const r=await readPendingCenter(inputs(service),signal());assert.match(r.items[0].detail,/主题学习.*人工修订稿/);assert.equal(t.calls(),1);assert.equal(t.storage.writes.length,writes);
 });
 await test('partial read failures and changed answers cannot be presented as a complete empty center',async()=>{
  const f=await fixture(),deps=inputs(f.service);deps.answerExcerpts=()=>{throw Error('unreadable');};let r=await readPendingCenter(deps,signal());assert.match(r.issues[0],/学习摘录读取失败/);
  f.files.get(f.file.path).text='Damaged';r=await readPendingCenter(inputs(f.service),signal());assert.equal(r.items.length,0);assert.equal(r.issues.length,1);
  const c=new AbortController();c.abort();await assert.rejects(readAnswerExcerptPending(f.service,c.signal),/abort/i);
 });
 await test('source checks are reused by answer version and excess versions stay explicitly unresolved',async()=>{
  const f=await fixture(),entries=Array.from({length:102},(_,i)=>({...f.file,path:'file-'+i,record:{...f.file.record,version:2,organization:{state:'completed'},answer:{...f.file.record.answer,digest:String(i).padStart(64,'0')}}}));entries.push(entries[0]);let calls=0;
  const result=await readAnswerExcerptPending({list:async()=>({entries,issues:[]}),sourceStatus:async()=>{calls++;return{state:'matched',message:'same'};}},signal());assert.equal(calls,100);assert.equal(result.entries.length,2);assert.equal(result.issues.length,1);assert.equal(result.entries[0].source.state,'unavailable');
 });
 await test('saving one editor preserves the other draft and invalidates its old preview',async()=>{
  const f=await fixture(),view=Object.create(AnswerExcerptBrowser.prototype);Object.assign(view,{selected:f.file,data:{entries:[f.file],issues:[]},draft:'Unsent memo',humanDraft:'Unsent human',humanPreview:{digest:f.file.digest,text:'Unsent human'},renderList:()=>{},renderDetail:()=>{}});
  assert.ok(view.dirty);const revised=await f.service.saveHumanRevision(f.file,'Saved human');view.accept(revised,'human');assert.equal(view.draft,'Unsent memo');assert.equal(view.humanDraft,'Saved human');assert.equal(view.humanPreview,undefined);assert.ok(view.dirty);
  view.humanDraft='New unsent human';const memo=await f.service.saveNote(revised,'Saved memo');view.accept(memo,'note');assert.equal(view.humanDraft,'New unsent human');assert.equal(view.draft,'Saved memo');view.accept(memo,'all');assert.equal(view.dirty,false);
 });
 console.log(`ANSWER_REVISIONS_OK (${count} groups; memory-only)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
