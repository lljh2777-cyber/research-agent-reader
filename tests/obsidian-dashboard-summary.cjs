const assert = require('node:assert/strict');
const fs = require('node:fs');
module.exports = async (app, root) => {
 const p = app.plugins.plugins['research-agent-reader'];
 const pause = () => new Promise(r => setTimeout(r, 80));
 const wait = async (test, label) => { for(let i=0;i<100;i++){if(test())return;await pause();}throw Error(label); };
 const saved = {read:p.readDashboardCuration, service:p.getCurationService, backend:p.createReadingBackend, http:p.providerHttpRequest};
 let calls=0, v;
 const close = () => { for (const m of [...p.curationModals]) m.close(); };
 globalThis.__summaryCleanup = async () => { close(); p.readDashboardCuration=saved.read;p.getCurationService=saved.service;p.createReadingBackend=saved.backend;p.providerHttpRequest=saved.http; if(v)await v.loadAndRender(); };
 try {
  p.createReadingBackend=p.providerHttpRequest=()=>{calls++;throw Error('unexpected model call');};
  const real = await p.readDashboardCuration();
  await p.activateDashboardView(); app.workspace.iterateAllLeaves(l=>{if(typeof l.view.renderFollowup==='function')v=l.view;});
  await wait(()=>v?.contentEl.querySelector('.agent-dashboard-followup'),'summary');
  assert.equal(v.contentEl.querySelector('.agent-dashboard-followup h2').textContent,'待处理与最近整理');
  const revisions = new Map(['one','two'].map((id,i)=>[id,{id,state:'applied',created:'2026-09-11T00:00:00Z',writes:[{role:'target',path:`wiki/concepts/${id}.md`,before:'old',after:'new'}]}]));
  const reviews = new Map([['interrupted',{state:'interrupted',updated:'2026-09-11',context:{title:'恢复后的生成记录',target:{path:'wiki/concepts/sample.md'},nodeIds:['n']},suggestions:[]}]]);
  p.getCurationService=()=>({reviews,revisions,errors:[],activeCount:0,changesPending:false,subscribe:()=>()=>{},ready:async()=>{}});
  p.readDashboardCuration=async()=>({pending:1,revisit:1,generating:1,unfinished:0,issues:['隔离测试：一条记录无法读取'],recent:[{id:'one',path:'wiki/concepts/one.md',updated:'2026-09-11T00:00:00Z',label:'记录标记已应用'}]});
  await v.loadAndRender();
  assert.match(v.contentEl.querySelector('.agent-dashboard-followup').textContent,/统计不完整/);
  v.contentEl.querySelector('[data-revision-id="one"]').click();
  await wait(()=>document.querySelector('.curation-record'),'exact revision');
  assert.equal(document.querySelectorAll('.curation-record').length,1);
  assert.match(document.querySelector('.curation-record').textContent,/one.md/);
  [...document.querySelectorAll('.curation-tabs button')].find(b=>b.textContent==='修订记录').click();
  await wait(()=>document.querySelectorAll('.curation-record').length===2,'all history');close();
  revisions.delete('one');v.contentEl.querySelector('[data-revision-id="one"]').click();
  await wait(()=>document.querySelector('.curation-maintenance-body')?.textContent.includes('未跳到其他记录'),'missing revision');
  assert.equal(document.querySelectorAll('.curation-record').length,0);close();
  v.contentEl.querySelector('[data-summary-action="generating"]').click();
  await wait(()=>document.querySelector('.curation-record')?.textContent.includes('恢复后的生成记录'),'interrupted generation remains reachable');close();
  for(const [id,tab] of [['pending','待审阅'],['stale','需复查'],['history','修订记录']]){
   v.contentEl.querySelector(`[data-summary-action="${id}"]`).click();
   await wait(()=>document.querySelector('.curation-tabs [aria-pressed="true"]')?.textContent===tab,id);close();
  }
  v.contentEl.querySelector('[data-summary-action="tasks"]').click();assert.equal(v.runsFilter,'open');assert.equal(v.runsExpanded,true);
  v.contentEl.querySelector('.agent-dashboard-followup').scrollIntoView({block:'center'});
  assert.equal(calls,0);
  const result={version:p.manifest.version,realSavedSummary:real,exactRevision:true,missingRevision:true,allHistory:true,interruptedGeneration:true,taskFilter:true,modelCalls:calls};
  fs.writeFileSync(root+'/observations.json',JSON.stringify(result,null,2));return result;
 } catch(e) {await globalThis.__summaryCleanup();throw e;}
};
