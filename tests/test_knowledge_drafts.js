"use strict";
// Actual draft contracts, append store, pending projection and existing excerpt readers. Memory files; no cleanup/model/network.
const assert=require('node:assert/strict'),{loadReading}=require('./reading-test-helpers'),{storage}=require('./source-intake-fixtures.cjs'),{fixture,mocks}=require('./excerpt-fixtures.cjs');
const {KnowledgeDraftStore,draftRevision,KNOWLEDGE_DRAFT_ROOT}=loadReading('curation/draft-store.ts',mocks);
const {newKnowledgeDraft,validateKnowledgeDraft,readDraftMaterial,renderKnowledgeDraft,draftMaterialText,draftMaterialStatus}=loadReading('curation/draft.ts',mocks);
const {objectDigest}=loadReading('papers/identity.ts'),{readPendingCenter,pendingDestination}=loadReading('services/pending-center.ts',mocks);
const draft=()=>({...newKnowledgeDraft(),title:'神经网络与证据',body:'用户草稿：需要区分推测与论文结论。'}),changed=d=>({...d,body:d.body+'\n第二版',updated:new Date(Date.parse(d.updated)+1).toISOString()});
const file=(d,r,extension='json')=>`${KNOWLEDGE_DRAFT_ROOT}/${d.id}/${r.digest}.${extension}`;
let count=0;async function test(name,run){await run();count++;console.log('PASS knowledge drafts: '+name);}
(async()=>{
 await test('browse missing history is read-only; create, reload and append preserve earlier snapshots',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft();assert.deepEqual(await s.list(),{ids:[],issues:[]});assert.deepEqual((await s.read(d.id)).revisions,[]);assert.equal(io.writes.length,0);assert.deepEqual([...io.dirs],['']);
  const first=await s.save(d,null),before=Buffer.from(io.files.get(file(d,first))),second=await new KnowledgeDraftStore(io).save(changed(d),first.digest),h=await s.read(d.id);
  assert.deepEqual(h.issues,[]);assert.equal(h.current.digest,second.digest);assert.equal(h.revisions.length,2);assert.deepEqual(io.files.get(file(d,first)),before);assert.ok(io.writes.every(p=>p.startsWith('knowledge-drafts/')));assert.equal((await s.summaries()).entries[0].title,d.title);
 });
 await test('identical retry and lost body/marker responses reuse one immutable revision',async()=>{
  for(const ext of ['json','ready']){const io=storage(),s=new KnowledgeDraftStore(io),d=draft();let lost=false;io.after=async p=>{if(!lost&&p.endsWith('.'+ext)){lost=true;throw Error('response lost');}};
   const first=await s.save(d,null);assert.equal((await s.save(d,null)).digest,first.digest);assert.equal((await s.read(d.id)).revisions.length,1);assert.equal(io.writes.length,2);}
 });
 await test('late cancellation leaves a visible pending body and restart can resume exact save',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft(),c=new AbortController();io.after=async p=>{if(p.endsWith('.json'))c.abort();};await assert.rejects(s.save(d,null,c.signal),/abort/i);
  const h=await s.read(d.id);assert.equal(h.current,undefined);assert.equal(h.pending.length,1);assert.deepEqual(h.issues,[]);assert.equal((await s.summaries()).entries[0].pending,1);io.after=undefined;
  const r=await new KnowledgeDraftStore(io).resume(h.pending[0]);assert.equal((await s.read(d.id)).current.digest,r.digest);assert.equal(io.writes.length,2);
 });
 await test('failure before commit retains old head, blocks fresh saves and permits explicit recovery',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft(),a=await s.save(d,null);io.before=async p=>{if(p.endsWith('.ready'))throw Error('disk failure');};await assert.rejects(s.save(changed(d),a.digest),/disk failure/);
  const h=await s.read(d.id);assert.equal(h.current.digest,a.digest);assert.equal(h.pending.length,1);await assert.rejects(s.save({...changed(d),body:'different retry'},a.digest),/未完成保存/);io.before=undefined;
  assert.equal((await s.resume(h.pending[0])).draft.body,changed(d).body);assert.equal((await s.read(d.id)).revisions.length,2);
 });
 await test('old editor cannot overwrite a newer head; caller mutation does not affect in-flight save',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft(),a=await s.save(d,null);await s.save(changed(d),a.digest);await assert.rejects(new KnowledgeDraftStore(io).save({...d,body:'stale'},a.digest),/其他窗口/);
  const mutable=draft(),save=s.save(mutable,null);mutable.title='changed caller';mutable.body='wrong';const r=await save;assert.equal(r.draft.title,'神经网络与证据');assert.notEqual(r.draft.body,'wrong');
 });
 await test('concurrent stores retain competing bodies and never silently choose a winner',async()=>{
  const io=storage(),d=draft();let seen=0,release;const gate=new Promise(resolve=>release=resolve);io.after=async p=>{if(p.endsWith('.json')){if(++seen===2)release();await gate;}};
  const values=await Promise.allSettled([new KnowledgeDraftStore(io).save(d,null),new KnowledgeDraftStore(io).save({...d,body:'other window'},null)]);assert.ok(values.every(v=>v.status==='rejected'));const s=new KnowledgeDraftStore(io),h=await s.read(d.id);assert.equal(h.pending.length,2);assert.equal(h.current,undefined);
  io.after=undefined;const list=io.list;io.list=async p=>(await list.call(io,p)).reverse();assert.equal(objectDigest(await s.read(d.id)),objectDigest(h));await assert.rejects(s.resume(h.pending[0]),/未完成保存/);const copy={...h.pending[0].draft,id:draft().id};assert.ok(await s.save(copy,null));assert.equal((await s.read(d.id)).pending.length,2);
 });
 await test('bad JSON, corrupt ready markers, path escapes, unknown fields and oversized bodies fail closed',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft(),r=await s.save(d,null);io.files.set(file(d,r,'ready'),Buffer.from('0'.repeat(64)));assert.ok((await s.read(d.id)).issues.length);await assert.rejects(s.save(changed(d),r.digest),/历史需要核对/);
  io.files.set(file(d,r),Buffer.from('{'));assert.ok((await s.read(d.id)).issues.length);await assert.rejects(s.read('../escape'),/标识/);
  for(const bad of [{...d,title:''},{...d,title:'x\ny'},{...d,body:'x'.repeat(40001)},{...d,kind:'sources'},{...d,path:'wiki/sources/a.md'},{...d,created:'yesterday'},{...d,version:2}])assert.throws(()=>validateKnowledgeDraft(bad));
  assert.throws(()=>draftRevision(d,'wrong'));assert.equal((await s.summaries()).entries[0].issues.length>0,true);
 });
 await test('forged parent chains, materials and multiple committed heads cannot be edited',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft(),r=await s.save(d,null),other=draftRevision({...d,body:'parallel root'},null);io.files.set(file(d,other),Buffer.from(JSON.stringify(other)));io.files.set(file(d,other,'ready'),Buffer.from(other.digest));let h=await s.read(d.id);assert.equal(h.current,undefined);assert.ok(h.issues.some(x=>x.includes('并发')));
  const x=storage(),store=new KnowledgeDraftStore(x),a=await store.save(d,null),orphan=draftRevision(changed(d),'a'.repeat(64));x.files.set(file(d,orphan),Buffer.from(JSON.stringify(orphan)));x.files.set(file(d,orphan,'ready'),Buffer.from(orphan.digest));h=await store.read(d.id);assert.ok(h.issues.some(x=>x.includes('前置')));assert.equal(h.current,undefined);
 });
 await test('Markdown snapshots retain literal quotes and opt-in notes; source loss does not erase draft',async()=>{
  const f=await fixture(),material=await readDraftMaterial(f.app,{kind:'excerpt',ref:f.record,includeNote:false}),d={...draft(),material},io=storage(),s=new KnowledgeDraftStore(io),r=await s.save(d,null),out=renderKnowledgeDraft(d);
  assert.ok(out.includes('原文摘录'));assert.ok(!out.includes('My inference'));assert.ok(!out.includes('<script>'));assert.ok(out.includes('\\[\\[link\\]\\]'));const withNote={...material,includeNote:true};assert.match(draftMaterialText(withNote),/个人备注（未核验）/);
  f.files.clear();assert.match(await draftMaterialStatus(f.app,{},material),/无法核对/);assert.ok(await s.save(changed(d),r.digest));assert.equal((await s.read(d.id)).current.draft.material.raw,material.raw);await assert.rejects(s.save({...changed(d),material:null},(await s.read(d.id)).current.digest),/材料变化/);
 });
 await test('PDF receipt pages survive material snapshot validation and cannot masquerade as AI',async()=>{
  const f=await fixture(),{pdfReceipt,pdfPageText,pdfExcerptId}=loadReading('annotations/pdf-excerpt.ts'),{AnnotationService}=loadReading('annotations/annotation-service.ts',mocks);
  // Use canonical existing annotation serialization with a prepared PDF receipt; source bytes remain memory-only.
  const bytes=Buffer.from('%PDF-1.7\nexample'),items=pdfPageText([{str:'PDF sentence',hasEOL:false}]),receipt=pdfReceipt(bytes,2,3,items,0,12),r={...f.record,sourcePath:'papers/a.pdf',selectedText:'PDF sentence',sourceAnchor:{start:0,end:12,prefix:'',suffix:''},excerpt:undefined,pdfExcerpt:receipt};r.id=pdfExcerptId(r.sourcePath,receipt,0,12);r.annotationPath=`wiki/annotations/${r.id}.md`;
  // Existing serializer is a private method at runtime; it writes nothing.
  const service=new AnnotationService(f.app,{});
  const raw=service.renderNewDocument(r),material={kind:'excerpt',path:r.annotationPath,raw,digest:loadReading('retrieval/chunks.ts').contentHash(raw),excerptId:r.id,includeNote:false};
  assert.match(draftMaterialText(material),/PDF 第 2 \/ 3 页/);assert.throws(()=>draftMaterialText({...material,kind:'answer'}));
 });
 await test('learning materials preserve selected AI/human/note roles and reject forged visible text',async()=>{
  const a=require('./answer-excerpt-fixtures.cjs'),f=a.readingFixture(),api=loadReading('curation/draft.ts',a.mocks),answers=loadReading('learning/answer-excerpts.ts',a.mocks),saved=await f.service.save(answers.prepareAnswerExcerpt(f.answer(),undefined,undefined,'my note'));f.files.get(saved.file.path).file.extension='md';
  const m=await api.readDraftMaterial(f.app,{kind:'answer',path:saved.file.path,roles:['ai','note']}),text=api.draftMaterialText(m);assert.match(text,/不是论文证据/);assert.match(text,/个人备注/);assert.match(text,/回答版本/);assert.throws(()=>api.draftMaterialText({...m,roles:['note','ai']}));assert.throws(()=>api.draftMaterialText({...m,roles:['toString']}));assert.throws(()=>api.draftMaterialText({...m,raw:m.raw+'appendix'}));
  const d={...draft(),material:m};assert.match(api.renderKnowledgeDraft(d),/AI 回答/);f.storage.files.clear();assert.match(await api.draftMaterialStatus(f.app,f.service,m),/无法核对/);
 });
 await test('pending center routes exact draft versions read-only, including recovery and failures',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),d=draft(),r=await s.save(d,null),empty={entries:[],issues:[]};
  const inputs={library:async()=>({papers:[],readIssues:[],complete:true}),acquisitions:{listJobs:async()=>[],readJob:async()=>null},local:async()=>[],excerpts:async()=>empty,curation:async()=>empty,tasks:()=>[],drafts:signal=>s.summaries(signal)};
  const scan=()=>readPendingCenter(inputs,new AbortController().signal),before=io.writes.length,result=await scan(),entry=result.items.find(x=>x.target.kind==='draft');assert.ok(entry);assert.equal(entry.category,'draft');assert.equal(pendingDestination(entry,result).id,d.id);assert.equal(io.writes.length,before);
  await s.save(changed(d),r.digest);const fresh=await scan();assert.throws(()=>pendingDestination(entry,fresh),/变化/);
  inputs.drafts=async()=>{throw Error('disk offline');};assert.ok((await scan()).issues.some(x=>x.includes('草稿读取失败')));
 });
 await test('cancellation and listing limits are explicit; draft JSON is outside knowledge/curation scopes',async()=>{
  const io=storage(),s=new KnowledgeDraftStore(io),c=new AbortController();c.abort();await assert.rejects(s.list(c.signal),/abort/i);await assert.rejects(s.save(draft(),null,c.signal),/abort/i);assert.equal(io.writes.length,0);
  io.dirs.add(KNOWLEDGE_DRAFT_ROOT);for(let i=0;i<101;i++)io.dirs.add(KNOWLEDGE_DRAFT_ROOT+'/d-'+String(i).padStart(8,'0')+'-0000-0000-0000-000000000000');const list=await s.list();assert.equal(list.ids.length,100);assert.ok(list.issues.length);
  const p='.obsidian/plugins/research-agent-reader/knowledge-drafts/'+draft().id+'/a.json';assert.equal(loadReading('retrieval/chunks.ts').inKnowledgeScope(p),false);assert.equal(loadReading('curation/policy.ts').curationTarget(p),false);
 });
 console.log(`KNOWLEDGE_DRAFTS_OK (${count} groups; memory-only)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
