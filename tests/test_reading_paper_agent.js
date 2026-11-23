"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const { createHash } = require("node:crypto");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { investigatePaper, resolvePaperProfileId } = loadReading("reading/paper-agent.ts");
const { createReadingSession, addReadingBranch, addReadingNode } = loadReading("reading/session.ts");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { DirectReadingBackend } = loadReading("reading/backend.ts");
const settings = {activeProviderId:"default", annotationBackendId:"annotation-api", sceneProfiles:{reading:"codex-cli"}};
const source = {path:"fixture/paper.md",kind:"article",title:"Paper",fingerprint:"a".repeat(64)};
const item = (id,text,start,asset) => ({id,kind:"paper",path:source.path,text,start,end:start+text.length,label:id,...(asset?{asset}:{})});
const design = item("b-1-0","A design paragraph (Fig. 1a).",0);
const caption = item("b-2-0","Panel a illustrates the design.",80);
const results = item("b-3-0","The authors report the held-out score. "+"x".repeat(5100),200);
const fig = item("figure-4","Figure 1",6000,"fig.png");
const document = {source,catalog:"locations",evidence:[design,caption,results,fig],verify:async()=>{},image:async e=>({evidenceId:e.id,dataUrl:"data:image/png;base64,AAAA"})};
const audit = {cliConstructions:0,spawn:0};
const originalSpawn=cp.spawn;
const fakeProvider = (respond) => ({capabilities:{vision:true},complete: async payload => {
 const parts=payload.messages[1].content;
 const text=typeof parts==="string"?parts:parts.find(p=>p.type==="text").text;
 return {text:JSON.stringify(await respond(JSON.parse(text),payload)),raw:{usage:{input_tokens:9,output_tokens:3}}};
}});
const api = (id,respond) => {
 if(id==="codex-cli"){audit.cliConstructions++;throw Error("CLI constructor invoked");}
 if(id==="missing")throw Error("请选择已通过连接测试的论文阅读 API");
 return new DirectReadingBackend(fakeProvider(respond),id,id+"-model",false,false,undefined,id);
};
async function productionEntries() {
 class FileSystemAdapter { getBasePath(){ return "/fixture"; } }
 const obsidian = new Proxy({FileSystemAdapter},{get:(obj,key)=>obj[key] || class {}});
 const Plugin=loadReading("plugin.ts",{obsidian,electron:{}}).default;
 const plugin=Object.create(Plugin.prototype);
 const profiles=["annotation-api","B"].map(id=>({id,name:id,model:id+"-model",type:"openai-compatible",capabilities:{vision:true},lastTest:{ok:true}}));
 Object.assign(plugin,{app:{vault:{adapter:new FileSystemAdapter()}},manifest:{},settings:{...settings,providerProfiles:profiles},
  openPaperBody:async()=>false,activateReadingWorkspace:async()=>{},createReadingBackend:()=>{audit.cliConstructions++;throw Error("unexpected CLI backend");}});
 const invoked=[];
 let timeout=false, planningResponses=0;
 plugin.createLLMProvider = profile=>fakeProvider(p=>{
  invoked.push({model:profile.model,stage:p.action || (p.materials?"read":"answer")});
  if(timeout)throw Error("API timeout");
  if(p.action==="规划全文路线")planningResponses++;
  if(p.action==="规划全文路线")return {modules:[{title:"Design",question:"Design?",evidenceIds:[design.id]},{title:"Results",question:"Results?",evidenceIds:[results.id]}]};
  if(p.materials)return {action:"ready"};
  const id=p.evidence[0].id;
  return {title:"Answer",content:"Observed ["+id+"]",evidenceIds:[id],mainSummary:"Study design"};
 });
 const createProvider=plugin.createLLMProvider;
 plugin.createLLMProvider=profile=>{
  const provider=createProvider(profile), complete=provider.complete;
  provider.complete=async payload=>{
   const response=await complete(payload);
   if(planningResponses===1 && JSON.parse(response.text).modules){
    response.text='{"modules":[';
    response.raw={status:"incomplete",incomplete_details:{reason:"max_output_tokens"}};
   }
   return response;
  };
  return provider;
 };
 const workspace=plugin.getReadingWorkspace();
 workspace.repository=new ReadingRepository(memoryStorage());
 workspace.loader.open=async()=>({...document,destroy:async()=>{}});
 await plugin.startClippedReading(source.path);
 const session=[...workspace.repository.sessions.values()][0];
 assert.equal(planningResponses,2);assert.equal(session.nodes.length,1);
 assert.equal(session.mainIds.length,1);assert.equal(session.nodes[0].status,"done");
 const anchor={id:"fixture-note",path:source.path,digest:source.fingerprint,at:0,chinese:false,selected:design.text,englishStart:0,englishDigest:source.fingerprint,question:"Design?",note:"",quotes:[]};
 const annotation=await workspace.attachAnnotation(source.path,anchor,new AbortController().signal,"B");await Promise.all(workspace.tasks.keys());
 assert.equal(workspace.repository.get(session.id).nodes.find(n=>n.id===annotation.nodeId).model,"B-model");
 await workspace.repository.transact(session.id,s=>{s.backend="codex-cli";});
 timeout=true;const child=await workspace.ask(session.id,annotation.nodeId,"Details?");await Promise.allSettled(workspace.tasks.keys());
 const count=workspace.repository.get(session.id).nodes.length;
 assert.equal(workspace.repository.get(session.id).nodes.at(-1).status,"failed");
 await workspace.repository.transact(session.id,s=>{s.backend="missing";});
 await assert.rejects(workspace.generate(session.id,child),/API/);
 await workspace.repository.transact(session.id,s=>{s.backend="B";});timeout=false;
 await workspace.generate(session.id,child);
 const done=workspace.repository.get(session.id);
 assert.equal(done.nodes.length,count);assert.equal(done.nodes.at(-1).parentId,annotation.nodeId);
 assert.equal(done.nodes.at(-1).model,"B-model");assert.equal(done.nodes[0].model,"annotation-api-model");
 assert.ok(invoked.some(c=>c.stage==="规划全文路线" && c.model==="annotation-api-model"));
 assert.ok(invoked.some(c=>c.stage==="read" && c.model==="B-model"));
}
async function run(){
 cp.spawn=()=>{audit.spawn++;throw Error("process invocation");};
 await productionEntries();
 for(const legacy of ["", "auto","codex-cli","opencode"])assert.equal(resolvePaperProfileId(settings,legacy),"annotation-api");
 assert.equal(resolvePaperProfileId({...settings,sceneProfiles:{reading:"custom"}}),"custom");
 assert.equal(resolvePaperProfileId(settings,"missing"),"missing");
 let stage=0;
 const backend=api("A", p=>{
  if(stage++===0){assert.deepEqual(p.materials.map(e=>e.id),[design.id]);assert.ok(!JSON.stringify(p).includes(results.text.slice(0,24)));return {action:"read",ids:[caption.id,results.id,fig.id]};}
  assert.equal(p.materials.find(e=>e.id===results.id).text.length,5000);assert.deepEqual(p.images,[fig.id]);return {action:"ready"};
 });
 const collect = (opts={})=>investigatePaper({document,question:"Where is accuracy measured?",initial:[design],backend,signal:new AbortController().signal,...opts});
 const {trace}=await collect();
 assert.equal(stage,2);assert.equal(trace.stop,"材料足够");assert.deepEqual(trace.candidates,document.evidence.map(e=>e.id));
 const sent=trace.steps[1].sent.find(s=>s.id===results.id);
 assert.equal(sent.start,200);assert.equal(sent.end,5200);assert.equal(sent.hash,createHash("sha256").update(results.text.slice(0,5000)).digest("hex"));
 assert.deepEqual(trace.steps[1].images,[fig.id]);
 const good=await collect({initial:[caption],backend:api("A",()=>({action:"ready"}))});assert.equal(good.trace.steps.length,1);
 const repeated=await collect({backend:api("A",()=>({action:"read",ids:[caption.id]}))});assert.equal(repeated.trace.stop,"没有新的本文证据");assert.ok(repeated.trace.steps.length<=4);
 const noHit=await collect({backend:api("A",()=>({action:"read",ids:["missing"]}))});assert.deepEqual(noHit.trace.citations,[]);
 const enough=await collect({backend:api("A",()=>({action:"insufficient"}))});assert.equal(enough.trace.stop,"本文证据不足");
 const quota=await collect({backend:api("A",p=>({action:"read",ids:[[caption.id,results.id,fig.id,"missing"][p.materials.length-1]]}))});
 assert.equal(quota.trace.steps.length,4);assert.equal(quota.trace.stop,"达到本文补读上限");
 assert.ok(quota.trace.steps.every(s=>s.delivery==="received"));
 const brief=await collect({brief:true,backend:api("A",()=>{throw Error("brief requested further material")})});assert.deepEqual(brief.trace.candidates,[]);assert.deepEqual(brief.evidence.map(e=>e.id),[design.id]);
 const store=memoryStorage(), repository=new ReadingRepository(store);
 const session=createReadingSession(source,"codex-cli","old");
 session.paperSpace=true;const main=addReadingNode(session,null);Object.assign(main,{status:"done",title:"First",content:"Old answer",provider:"Codex CLI",model:"Old model"});
 session.outline=["First","Second"];session.mainSummary="Old memory";
 const branch=addReadingBranch(session,main.id,{id:"note",path:"fixture/paper.md",digest:source.fingerprint,at:0,chinese:false,selected:design.text,englishStart:0,englishDigest:source.fingerprint,question:"Explain",note:"",quotes:[]});
 const old=addReadingNode(session,branch.id,"Old question");Object.assign(old,{status:"done",content:"Historical branch answer"});
 const child=addReadingBranch(session,old.id);const node=addReadingNode(session,child.id,"Where?");await repository.add(session);
 let fail=true;const choices=[];let vaultQueries=0;
 const engine=new ReadingEngine({repository,document:async()=>document},s=>{
   const id=resolvePaperProfileId(settings,s.backend);choices.push(id);return api(id,p=>{
     if(fail)throw Error("API timeout");
     if(p.materials)return {action:"ready"};
     return {title:"Answer",content:"Verified. [b-1-0]",evidenceIds:["b-1-0"]};
   });
 },async()=>{vaultQueries++;return [];});
 await assert.rejects(engine.generate(session.id,node.id),/timeout/);
 await repository.transact(session.id,s=>{s.backend="missing";});
 await assert.rejects(engine.generate(session.id,node.id),/API/);
 await repository.transact(session.id,s=>{s.backend="B";});fail=false;
 await engine.generate(session.id,node.id);const final=repository.get(session.id);
 assert.deepEqual(choices,["annotation-api","missing","B"]);assert.equal(vaultQueries,0);
 assert.equal(final.nodes.length,3);assert.equal(final.nodes.at(-1).provider,"B");assert.equal(final.nodes.at(-1).model,"B-model");
 assert.deepEqual(final.nodes.at(-1).paperTrace.citations,[design.id]);assert.equal(final.nodes.at(-1).parentId,old.id);assert.deepEqual(final.nodes[0],main);assert.equal(final.mainSummary,"Old memory");
 await repository.transact(session.id,s=>{s.ui.inlineBranchId=child.id;s.ui.inlineFocusId=node.id;});
 const recovered=new ReadingRepository(store);await recovered.load();assert.equal(recovered.get(session.id).ui.inlineFocusId,node.id);
 assert.deepEqual(audit,{cliConstructions:0,spawn:0});console.log("PAPER_AGENT_OK",JSON.stringify(audit));
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{cp.spawn=originalSpawn});
