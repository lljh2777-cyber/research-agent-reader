"use strict";
// Isolated real files are retained, including partial writes. No deletion or live models.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {loadReading}=require('./reading-test-helpers');
const {FileSourceStorage}=loadReading('sources/storage.ts');
const {TopicSessionStore}=loadReading('topic-learning/store.ts');
const {TopicLearningService}=loadReading('topic-learning/service.ts');
const {TopicStudyStore,TOPIC_STUDY_DIRECTORY}=loadReading('topic-learning/study-store.ts');
const {TopicStudyService}=loadReading('topic-learning/study-service.ts');
const open=root=>{const io=new FileSourceStorage(root),topics=new TopicLearningService(new TopicSessionStore(io)),store=new TopicStudyStore(io);return{io,topics,store,service:new TopicStudyService(store,topics)}};
(async()=>{
 if(process.argv[2]==='probe'){
  const f=open(process.argv[3]),expected=JSON.parse(await fs.readFile(path.join(process.argv[3],'expected.json'),'utf8'));
  const h=await f.store.read(expected.session.id,expected.routeDigest);assert.deepEqual(h.study,expected);assert.equal(h.pending.length,1);assert.deepEqual(h.errors,[]);
  console.log('STUDY_RESTART_OK');return;
 }
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rar-topic-study-')),f=open(root);
 assert.deepEqual(await fs.readdir(root),[]);
 const initial=await f.topics.create({topic:'机器学习',goal:'理解训练与评估',background:'零基础'}),id=initial.session.id;
 const edited=await f.topics.editPlan(id,initial.digest,{version:1,modules:[{id:'unit-a',title:'数据',question:'输入是什么？',objective:'辨认输入',prerequisites:[]},{id:'unit-b',title:'评估',question:'为什么评估？',objective:'解释测试数据',prerequisites:['unit-a']}]});
 const confirmed=await f.topics.confirmPlan(id,edited.digest),route=await f.service.start(id,confirmed.digest);
 const folder=path.join(root,TOPIC_STUDY_DIRECTORY,id,route),original=await fs.readdir(folder),bytes=await Promise.all(original.map(name=>fs.readFile(path.join(folder,name))));
 const backend=()=>({name:'Mock',model:'file-test',images:false,complete:async r=>{r.onUsage({input:13,output:7});return JSON.stringify({title:'模拟回答',content:'仅用于真实文件恢复验证。'})}});
 let s=await f.service.get(id,route);await f.service.generate(id,route,s.head,{kind:'next'},backend);s=await f.service.get(id,route);
 await f.service.generate(id,route,s.head,{kind:'ask',parentId:s.nodes[0].id,question:'举一个例子？',newBranch:false},backend);s=await f.service.get(id,route);
 const pending='e-'+require('node:crypto').randomUUID();await f.io.create(`${TOPIC_STUDY_DIRECTORY}/${id}/${route}/${pending}.json`,Buffer.from('{partial'));
 await fs.writeFile(path.join(root,'expected.json'),JSON.stringify(s),{flag:'wx'});
 const names=await fs.readdir(folder),snapshot=await Promise.all(names.map(n=>fs.readFile(path.join(folder,n))));
 const result=execFileSync(process.execPath,[__filename,'probe',root],{encoding:'utf8',windowsHide:true});assert(result.includes('STUDY_RESTART_OK'));
 for(let i=0;i<names.length;i++)assert.deepEqual(await fs.readFile(path.join(folder,names[i])),snapshot[i]);
 for(let i=0;i<original.length;i++)assert.deepEqual(await fs.readFile(path.join(folder,original[i])),bytes[i]);
 await assert.rejects(f.io.create(`${TOPIC_STUDY_DIRECTORY}/${id}/${route}/${original[0]}`,Buffer.from('replacement')),/EEXIST/);
 await assert.rejects(f.store.read('../escape',route),/标识/);
 assert.equal(s.nodes.length,2);assert.equal(s.nodes[1].attempts[0].result.usage.output,7);
 console.log('TOPIC_STUDY_STORAGE_OK: separate-process main/branch/usage recovery, exclusive writes and retained partial bytes; fixture '+root);
})().catch(e=>{console.error(e);process.exitCode=1});
