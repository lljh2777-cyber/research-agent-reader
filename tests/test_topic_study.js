"use strict";
// Memory only: no live providers, filesystem writes, processes or deletion.
const assert = require('node:assert/strict');
const {loadReading} = require('./reading-test-helpers');
const {TopicSessionStore} = loadReading('topic-learning/store.ts');
const {TopicLearningService} = loadReading('topic-learning/service.ts');
const {TopicStudyStore} = loadReading('topic-learning/study-store.ts');
const {TopicStudyService} = loadReading('topic-learning/study-service.ts');
const {TopicStudyController} = loadReading('topic-learning/study-workspace.ts');
const {nextTopicNode,studyContext,STUDY_PROMPT_VERSION} = loadReading('topic-learning/study.ts');
const {layoutLearning} = loadReading('learning/graph.ts');
const {safeLearningMarkdown} = loadReading('learning/presentation.ts');
const {readPaperLibrary} = loadReading('library/reader.ts');
const plan={version:1,modules:[{id:'unit-a',title:'数据与目标',question:'预测什么？',objective:'区分输入和目标',prerequisites:[]},{id:'unit-b',title:'训练与评估',question:'为什么划分数据？',objective:'解释独立测试',prerequisites:['unit-a']}]};
const intent={topic:'机器学习',goal:'理解训练与评估',background:'零基础'};
const answer=JSON.stringify({title:'模拟讲解',content:'这是用于工程测试的模拟讲解，不是教学质量证据。'});
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
function io(){const files=new Map(),dirs=new Set(),writes=[];return{files,writes,async read(p){return files.get(p)||null},async mkdir(p){dirs.add(p)},async create(p,b){assert(!files.has(p));files.set(p,Buffer.from(b));writes.push(p)},async list(p){return [...dirs,...files.keys()].filter(k=>k.startsWith(p+'/')&&!k.slice(p.length+1).includes('/')).map(k=>({name:k.slice(p.length+1),directory:dirs.has(k)}))}}}
const backend=(complete=async()=>answer)=>({name:'Mock',model:'study-test',images:false,complete});
async function fixture(){const storage=io(),topics=new TopicLearningService(new TopicSessionStore(storage)),created=await topics.create(intent),edited=await topics.editPlan(created.session.id,created.digest,plan),confirmed=await topics.confirmPlan(created.session.id,edited.digest),store=new TopicStudyStore(storage),service=new TopicStudyService(store,topics),route=await service.start(created.session.id,confirmed.digest);return{storage,topics,store,service,route,id:created.session.id,confirmed,get(){return service.get(this.id,this.route)}}}
async function run(f,action,complete){const s=await f.get();await f.service.generate(f.id,f.route,s.head,action,()=>backend(complete));return f.get()}
(async()=>{
 // Read-only restore, source-free requests and sibling-free branch context.
 {
  const f=await fixture(),initial=await f.get(),writes=f.storage.writes.length;await f.store.list(f.id);await f.get();assert.equal(f.storage.writes.length,writes);assert.equal(initial.nodes.length,0);
  let calls=0;let s=await run(f,{kind:'next'},async r=>{calls++;assert.deepEqual(r.images,[]);assert(!r.webSearch);assert.match(r.system,/模型一般知识/);assert(!r.prompt.includes('source.path'));r.onUsage({input:31,output:12});return answer});
  const main=s.nodes[0].id;assert.equal(calls,1);assert.equal(s.nodes[0].attempts[0].result.usage.input,31);
  s=await run(f,{kind:'ask',parentId:main,question:'训练误差低就一定泛化好吗？',newBranch:false});const b1=s.nodes.at(-1);
  s=await run(f,{kind:'ask',parentId:b1.id,question:'请给一个反例',newBranch:false},async r=>{assert.deepEqual(JSON.parse(r.prompt).context.map(x=>x.id),[main,b1.id]);return answer});const b2=s.nodes.at(-1);assert.equal(b2.branchId,b1.branchId);
  s=await run(f,{kind:'ask',parentId:b1.id,question:'另开一个问题',newBranch:true});assert.notEqual(s.nodes.at(-1).branchId,b1.branchId);assert(!s.nodes.at(-1).attempts[0].contextIds.includes(b2.id));
  s=await run(f,{kind:'ask',parentId:main,question:'另一条平行支线',newBranch:false},async r=>{assert.deepEqual(JSON.parse(r.prompt).context.map(x=>x.id),[main]);return answer});
  s=await run(f,{kind:'next'},async r=>{assert.deepEqual(JSON.parse(r.prompt).context.map(x=>x.id),[main]);return answer});assert.equal(s.graph.mainIds.length,2);
  const layout=layoutLearning({...s.graph,collapsed:[]});assert.equal(layout.nodes.length,s.nodes.length);assert.equal(new Set(layout.nodes.map(n=>`${n.x}:${n.y}`)).size,s.nodes.length);
  const head=s.head;await assert.rejects(f.service.generate(f.id,f.route,head,{kind:'next'},()=>{throw new Error('factory must not run')}),/均已生成/);
  await assert.rejects(f.service.generate(f.id,f.route,head,{kind:'retry',nodeId:main},()=>{throw new Error('factory must not run')}),/没有可重试/);
  const snapshot=[...f.storage.files].map(([k,v])=>[k,v.toString()]);const edited=await f.topics.editIntent(f.id,f.confirmed.digest,{...intent,goal:'新的目标'});
  await assert.rejects(f.service.start(f.id,edited.digest),/确认/);const p=await f.topics.editPlan(f.id,edited.digest,plan),confirmed=await f.topics.confirmPlan(f.id,p.digest),newRoute=await f.service.start(f.id,confirmed.digest);
  assert.notEqual(newRoute,f.route);assert.equal((await f.service.get(f.id,newRoute)).nodes.length,0);assert.deepEqual((await f.get()).nodes,s.nodes);
  for(const[k,v]of snapshot)assert.equal(f.storage.files.get(k).toString(),v);
  const lib=await readPaperLibrary(io(),f.storage,{vaultRoot:require('node:path').resolve('memory-vault'),parseYaml:JSON.parse});assert.equal(lib.papers.length,0);
 }
 // Exact retry receipts, raw invalid output, restored usage and no automatic retry.
 {
  const f=await fixture();let calls=0;let s=await run(f,{kind:'next'},async()=>{calls++;return '{bad json'});const failed=s.nodes[0];assert.equal(failed.status,'failed');assert.equal(calls,1);assert.equal(failed.attempts[0].result.response,'{bad json');
  s=await run(f,{kind:'retry',nodeId:failed.id});assert.equal(s.nodes.length,1);assert.equal(s.nodes[0].attempts.length,2);assert.equal(s.nodes[0].status,'done');assert.equal(s.nodes[0].attempts[1].result.usage.input,undefined);
  const restored=new TopicStudyService(new TopicStudyStore(f.storage),f.topics);assert.deepEqual(await restored.get(f.id,f.route),s);
  await assert.rejects(f.service.generate(f.id,f.route,'a'.repeat(64),{kind:'next'},()=>{throw new Error('must not call')}),/已变化/);
 }
 // Cancel before request, during uncooperative model completion and before result publication.
 {
  const f=await fixture(),c=new AbortController();c.abort();let calls=0;
  await assert.rejects(f.service.generate(f.id,f.route,(await f.get()).head,{kind:'next'},()=>{calls++;return backend()},c.signal));assert.equal(calls,0);assert.equal((await f.get()).nodes.length,0);
 }
 for(const mode of ['cancel','dispose','timeout','publication']){
  const f=await fixture(),c=new AbortController(),entered=defer(),late=defer();let usage,timeout;
  const timer=global.setTimeout;if(mode==='timeout')global.setTimeout=(fn,ms,...args)=>ms===180000?(timeout=fn,0):timer(fn,ms,...args);
  if(mode==='publication'){const create=f.storage.create;f.storage.create=async(p,b)=>{await create(p,b);if(p.endsWith('.json')&&JSON.parse(b).event.type==='result'&&JSON.parse(b).event.status==='done')c.abort()};}
  try{
   const task=f.service.generate(f.id,f.route,(await f.get()).head,{kind:'next'},()=>backend(async r=>{usage=r.onUsage;entered.resolve();return mode==='publication'?answer:late.promise}),c.signal);
   await entered.promise;if(mode==='cancel')c.abort();if(mode==='dispose')await f.service.dispose();if(mode==='timeout')timeout();await task;
   usage({input:999});late.resolve(answer);await new Promise(r=>setImmediate(r));const s=await f.get();assert.equal(s.nodes[0].status,'cancelled');assert.equal(s.nodes[0].content,'');assert.notEqual(s.nodes[0].attempts[0].result.usage.input,999);
   if(mode==='publication')assert.equal((await f.store.read(f.id,f.route)).pending.length,1);
  }finally{global.setTimeout=timer;}
 }
 // Request persistence failure makes zero model calls; response save failure preserves the request.
 for(const stage of ['request','result']){
  const f=await fixture(),create=f.storage.create;let calls=0;
  f.storage.create=async(p,b)=>{if(p.endsWith('.json')&&JSON.parse(b).event.type===stage)throw new Error('disk full');await create(p,b)};
  await assert.rejects(f.service.generate(f.id,f.route,(await f.get()).head,{kind:'next'},()=>backend(async()=>{calls++;return answer})),/disk full/);
  const s=await f.get();assert.equal(calls,stage==='request'?0:1);assert.equal(s.nodes.length,stage==='request'?0:1);if(s.nodes.length)assert.equal(s.nodes[0].status,'interrupted');
 }
 // Simulated restart after the persisted request keeps it visible and never resumes the model.
 {
  const f=await fixture(),s=await f.get(),spec=nextTopicNode(s),context=studyContext(s,spec.parentId);
  await f.store.append(f.id,f.route,s.head,{type:'request',node:spec,provider:'Mock',model:'crashed',promptVersion:STUDY_PROMPT_VERSION,contextIds:context.ids,omitted:context.omitted});
  const writes=f.storage.writes.length,recovered=await f.get();assert.equal(recovered.nodes[0].status,'interrupted');assert.equal(f.storage.writes.length,writes);await run(f,{kind:'retry',nodeId:spec.id});assert.equal((await f.get()).nodes[0].status,'done');
 }
 // Tampered bytes and racing writers fail closed; old files are never replaced.
 {
  const f=await fixture(),file=[...f.storage.files.keys()].find(p=>p.includes('topic-learning-dialogues')&&p.endsWith('.json'));f.storage.files.set(file,Buffer.from('{bad'));
  assert((await f.store.read(f.id,f.route)).errors.length);await assert.rejects(f.get());
 }
 {
  const f=await fixture(),s=await f.get(),create=f.storage.create,barrier=defer();let count=0,calls=0;
  f.storage.create=async(p,b)=>{await create(p,b);if(p.endsWith('.json')){if(++count===2)barrier.resolve();await barrier.promise}};
  const other=new TopicStudyService(new TopicStudyStore(f.storage),f.topics);
  const result=await Promise.allSettled([f.service.generate(f.id,f.route,s.head,{kind:'next'},()=>backend(async()=>{calls++;return answer})),other.generate(f.id,f.route,s.head,{kind:'next'},()=>backend(async()=>{calls++;return answer}))]);
  assert(result.every(r=>r.status==='rejected'));assert.equal(calls,0);assert((await f.store.read(f.id,f.route)).errors.some(e=>e.includes('并发')));
 }
 // UI selection and draft recovery do not move mainline focus or trigger model calls.
 {
  const f=await fixture();await run(f,{kind:'next'});const c=new TopicStudyController(f.service,()=>{});await c.open(f.id,f.route);const main=c.ui.selectedId;c.ui.drafts[main]='追问草稿';
  await c.generate({kind:'ask',parentId:main,question:'为什么？',newBranch:false},()=>backend());const branch=c.ui.selectedId;assert.notEqual(branch,main);assert.equal(c.ui.mainFocusId,main);c.returnToMain();assert.equal(c.ui.selectedId,main);
  c.toggle(c.study.nodes.find(n=>n.id===branch).branchId);c.select(branch);assert.equal(c.ui.collapsed.length,0);c.ui.drafts[branch]='恢复的问题';const state=c.state(),fresh=new TopicStudyController(f.service,()=>{});fresh.restore(state);const writes=f.storage.writes.length;await fresh.refresh();assert.equal(fresh.ui.selectedId,branch);assert.equal(fresh.ui.drafts[branch],'恢复的问题');assert.equal(f.storage.writes.length,writes);
 }
 // A successful explicit retry clears the original question draft without creating a new node.
 {
  const f=await fixture();await run(f,{kind:'next'});const c=new TopicStudyController(f.service,()=>{});await c.open(f.id,f.route);const main=c.ui.selectedId;c.ui.drafts[main]=' 原始问题 ';
  await c.generate({kind:'ask',parentId:main,question:c.ui.drafts[main],newBranch:false},()=>backend(async()=>'{bad'));assert.equal(c.ui.drafts[main],' 原始问题 ');const id=c.ui.selectedId;
  await c.generate({kind:'retry',nodeId:id},()=>backend());assert.equal(c.ui.drafts[main],undefined);assert.equal(c.ui.selectedId,id);
 }
 // A long branch keeps the originating unit and recent ancestors; siblings stay excluded.
 {
  const f=await fixture();let s=await run(f,{kind:'next'}),main=s.nodes[0].id,parent=main;
  for(let i=0;i<11;i++){s=await run(f,{kind:'ask',parentId:parent,question:'追问 '+i,newBranch:false});parent=s.nodes.at(-1).id;}
  const context=studyContext(s,parent);assert.equal(context.ids.length,9);assert.equal(context.ids[0],main);assert.equal(context.ids.at(-1),parent);assert.equal(context.omitted,3);
 }
 // Reserve enough storage for the request and result before creating a backend.
 {
  const f=await fixture(),read=f.store.read.bind(f.store),head=(await f.get()).head;
  f.store.read=async(...args)=>{const h=await read(...args);return {...h,pending:Array(509).fill('pending')};};
  let calls=0;await assert.rejects(f.service.generate(f.id,f.route,head,{kind:'next'},()=>{calls++;return backend()}),/剩余空间/);assert.equal(calls,0);
 }
 const safe=safeLearningMarkdown('![remote](https://example.com/image.png)\n<script>alert(1)</script>\n```dataviewjs\napp.vault.delete(file)\n```');assert(!safe.includes('!['));assert(!safe.includes('<script>'));assert(!safe.includes('```'));
 console.log('TOPIC_STUDY_OK: immutable routes, source-free branch context, stable nodes, retries, cancellation, restart, usage, failed writes, conflicts and passive rendering');
})().catch(e=>{console.error(e);process.exitCode=1});
