"use strict";
// In-memory actual projections, read decoders and controllers. No providers or file cleanup.
const assert=require('node:assert/strict'),{loadReading}=require('./reading-test-helpers');
const {readPendingCenter,readPendingAcquisitions,pendingDestination,filterPending}=loadReading('services/pending-center.ts');
const {PendingController}=loadReading('services/pending-controller.ts');
const {readDashboardCuration}=loadReading('services/dashboard-curation.ts');
const {readLocalPdfHistory}=loadReading('papers/local-pdf-intake.ts');
const {PaperLibraryView}=loadReading('views/paper-library.ts',{obsidian:{ItemView:class{},Modal:class{}}});
const signal=()=>new AbortController().signal,id=(prefix,n)=>prefix+'-'+String(n).padStart(8,'0')+'-0000-0000-0000-000000000000';
const empty=()=>({papers:[],diagnostics:[],readIssues:[],complete:true,recordStates:[],excluded:[],stats:{}});
const paper=(objects,key='p1')=>({key,paperId:key,title:'Same title',identifiers:{doi:'10.1234/'+key},association:'identified',objects,readingState:'unmarked',diagnosticIds:[]});
const source=(key,format='pdf')=>({kind:'source',id:'papers/'+key+'/source.pdf',title:'Same title',identifiers:{},source:{path:'papers/'+key+'/source.pdf',packageKey:key,format,saved:true,verification:{state:'verified',fingerprint:'a'.repeat(64)}}});
const record=(key)=>({kind:'record',id:key,title:'Same title',identifiers:{},bibliography:{title:'Same title'}});
const job=(n,phase='failed')=>({schemaVersion:1,id:id('a',n),revision:1,attemptId:id('a',99),mode:'production',deviceId:'this-device',request:{input:{kind:'doi',value:'10.1234/test'},goal:'pdf',versionPolicy:'record_only'},phase,createdAt:'2026-09-12T00:00:00Z',updatedAt:'2026-09-12T00:00:00Z',detail:'',error:'',candidates:[],...(phase==='acquired'?{snapshotId:id('s',n)}:{})});
function inputs(){return {library:async()=>empty(),acquisitions:{listJobs:async()=>[],readJob:async()=>assert.fail('no jobs')},local:async()=>[],excerpts:async()=>({entries:[],issues:[]}),curation:async()=>({entries:[],issues:[]}),tasks:()=>[]};}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
let n=0;const test=async(name,run)=>{await run();n++;console.log('PASS pending center: '+name);};
(async()=>{
 await test('empty read has no writes, recovery or implicit completion claim',async()=>{const result=await readPendingCenter(inputs(),signal());assert.deepEqual(result.items,[]);assert.deepEqual(result.issues,[]);assert.ok(result.scannedAt);});
 await test('metadata and conversion gaps preserve source versions and same-title identities',async()=>{
  const deps=inputs(),a=source('a'),b=source('b'),converted={...source('converted','mineru'),source:{...source('converted','mineru').source,pdfOrigin:{state:'matched',sourceIds:[a.id]}}};
  const data={...empty(),papers:[paper([record('record-1')],'one'),paper([record('record-2')],'two'),paper([a,b,converted],'versions')]};deps.library=async()=>data;const before=JSON.stringify(data),r=await readPendingCenter(deps,signal());
  assert.equal(r.items.filter(i=>i.category==='metadata').length,2);assert.ok(!r.items.some(i=>i.key==='library:source:'+a.id));assert.ok(r.items.some(i=>i.key==='library:source:'+b.id));assert.equal(JSON.stringify(data),before);
  data.complete=false;data.readIssues=[{area:'sources',path:'papers/b',message:'unreadable'}];const partial=await readPendingCenter(deps,signal());assert.equal(partial.items.length,0);assert.match(partial.issues.join(' '),/不完整/);
 });
 await test('production acquisition journal validates modes and does not equate a download with a saved source',async()=>{
  const deps=inputs(),key='paper--pdf--'+'a'.repeat(24),jobs=[job(1,'acquired'),{...job(2,'acquired'),sourcePackages:[key]},job(3),{...job(4),mode:'demo'}];deps.acquisitions={listJobs:async()=>jobs.map(j=>j.id),readJob:async i=>jobs.find(j=>j.id===i)};
  deps.library=async()=>({...empty(),papers:[paper([{...source(key),identifiers:{doi:'10.1234/test'}}])]});let r=await readPendingCenter(deps,signal());assert.ok(r.items.some(i=>i.key==='acquisition:'+jobs[0].id));assert.match(r.items.find(i=>i.key==='acquisition:'+jobs[0].id).detail,/保存或登记/);assert.ok(!r.items.some(i=>i.key==='acquisition:'+jobs[1].id));assert.ok(r.issues.some(s=>s.includes(jobs[3].id)));
  deps.library=async()=>({...empty(),papers:[paper([{...source(key),identifiers:{doi:'10.1234/different'}}])]});assert.ok((await readPendingCenter(deps,signal())).items.some(i=>i.key==='acquisition:'+jobs[1].id));
  deps.library=async()=>empty();r=await readPendingCenter(deps,signal());assert.ok(r.items.some(i=>i.key==='acquisition:'+jobs[1].id));
  const many={listJobs:async()=>Array.from({length:257},(_,i)=>id('a',i+1)),readJob:async i=>({...job(1),id:i})};const limited=await readPendingAcquisitions(many,signal());assert.equal(limited.jobs.length,256);assert.match(limited.issues[0],/256/);
 });
 await test('local history is independently readable and corrupt or foreign operations are never adopted',async()=>{
  const io={list:async()=>[{name:id('s',1)+'.json',directory:false}],read:async()=>Buffer.from(JSON.stringify({schemaVersion:1,deviceId:'foreign',path:'X:/unknown.pdf',snapshot:{}}))};
  const result=await readLocalPdfHistory(io,'this-device',undefined,signal());assert.equal(result[0].state,'unavailable');assert.match(result[0].error,/另一设备/);
  const deps=inputs();deps.local=async()=>[...result,{id:id('s',2),title:'Local file',state:'pending',fileName:'paper.pdf',createdAt:'',error:''},{id:id('s',3),title:'Saved',state:'saved'}];const r=await readPendingCenter(deps,signal());assert.equal(r.items.length,1);assert.equal(r.items[0].target.id,id('s',2));assert.equal(r.issues.length,1);
 });
 await test('saved curation callbacks share existing validators without initialization or writes',async()=>{
  const review={version:1,id:id('c',1),updated:'2026-09-12T00:00:00Z',state:'ready',context:{target:{path:'wiki/sources/a.md'}},suggestions:[{decision:'pending'}]};
  const files=new Map([['knowledge-reviews/reviews/'+review.id+'.json',Buffer.from(JSON.stringify(review))]]),before=Buffer.from(files.values().next().value),entries=[];
  const io={list:async dir=>[...files.keys()].filter(p=>p.startsWith(dir+'/')).map(p=>({name:p.split('/').pop(),directory:false})),read:async p=>files.get(p)||null};
  const summary=await readDashboardCuration(io,row=>entries.push(row),signal());assert.equal(summary.pending,1);assert.equal(entries[0].id,review.id);assert.match(entries[0].digest,/^[a-f0-9]{64}$/);assert.deepEqual(files.values().next().value,before);
  const deps=inputs();deps.curation=async()=>({entries,issues:[]});assert.equal((await readPendingCenter(deps,signal())).items[0].target.kind,'review');
  const revision={version:1,id:id('c',2),updated:review.updated,state:'recovery',writes:[{role:'target',path:'wiki/concepts/a.md'}]};files.set('knowledge-reviews/revisions/'+revision.id+'.json',Buffer.from(JSON.stringify(revision)));entries.length=0;await readDashboardCuration(io,row=>entries.push(row),signal());assert.equal(entries.length,2);assert.ok((await readPendingCenter(deps,signal())).items.some(row=>row.target.kind==='revision'));
 });
 await test('excerpt source changes use composite library identities and completed excerpts disappear only when unchanged',async()=>{
  const deps=inputs(),r={id:'ann-excerpt-'+'a'.repeat(48),annotationPath:'wiki/annotations/ann-excerpt-'+'a'.repeat(48)+'.md',sourcePath:'Clippings/test.md',selectedText:'Exact quote',archiveStatus:'completed'};
  deps.excerpts=async()=>({entries:[{record:r,digest:'a'.repeat(64)}],issues:[]});assert.equal((await readPendingCenter(deps,signal())).items[0].category,'review');
  deps.library=async()=>({...empty(),papers:[paper([{kind:'annotation',id:r.annotationPath+'#'+r.id,binding:{state:'matched',reason:'same bytes'}}])]});
  assert.equal((await readPendingCenter(deps,signal())).items.length,0);
  r.archiveStatus='none';const reopened=(await readPendingCenter(deps,signal())).items[0];assert.equal(reopened.category,'excerpt');r.archiveStatus='completed';assert.throws(()=>pendingDestination(reopened,{items:[]}),/变化|完成/);
  deps.library=async()=>({...empty(),papers:[paper([{kind:'annotation',id:r.annotationPath+'#'+r.id,binding:{state:'unresolved',reason:'missing'}}])]});assert.equal((await readPendingCenter(deps,signal())).items[0].category,'review');
  deps.library=async()=>({...empty(),papers:[paper([{kind:'annotation',id:r.annotationPath+'#'+r.id,binding:{state:'changed',reason:'changed'}}])]});
  const out=await readPendingCenter(deps,signal());assert.equal(out.items.length,1);assert.equal(out.items[0].category,'review');assert.equal(out.items[0].target.ref.id,r.id);
  deps.curation=async()=>({entries:[{kind:'revisions',id:'c-recovery',path:'wiki/concepts/a.md',state:'recovery',digest:'x'}],issues:[]});assert.equal((await readPendingCenter(deps,signal())).items.length,2);
 });
 await test('partial failures retain independent rows; synchronous adapter failures and cancelled reads are explicit',async()=>{
  const deps=inputs();deps.library=()=>{throw Error('broken library');};deps.excerpts=async()=>{throw Error('broken excerpts');};deps.tasks=()=>[{id:'run-1',actionId:'paper-ingest',status:'failed',label:'Intake',summary:'paper.pdf',startedAt:'',finishedAt:''},{id:'done',actionId:'paper-ingest',status:'done'},{id:'code',actionId:'code-reading',status:'failed'}];
  const r=await readPendingCenter(deps,signal());assert.equal(r.items.length,1);assert.equal(r.issues.length,2);
  const c=new AbortController();c.abort();await assert.rejects(readPendingCenter(deps,c.signal),/abort/i);
  const pause=deferred(),d=new AbortController();deps.local=()=>pause.promise;const reading=readPendingCenter(deps,d.signal);d.abort();pause.resolve([]);await assert.rejects(reading,/abort/i);
 });
 await test('navigation rechecks stable identity and current state, not a title or a stale destination',async()=>{
  const deps=inputs();deps.library=async()=>({...empty(),papers:[paper([record('one')])]});const first=await readPendingCenter(deps,signal()),row=first.items[0];assert.equal(pendingDestination(row,await readPendingCenter(deps,signal())).object.id,'one');
  assert.throws(()=>pendingDestination(row,{...first,items:[]}),/变化/);assert.throws(()=>pendingDestination({...row,target:{kind:'task',id:'wrong'}},first),/变化/);
  deps.library=async()=>({...empty(),papers:[paper([{...record('one'),bibliography:{title:'changed'}}])]});const changed=await readPendingCenter(deps,signal());assert.throws(()=>pendingDestination(row,changed),/变化/);
 });
 await test('filters search paths and categories; duplicate keys do not choose a winner',async()=>{
  const deps=inputs();deps.local=async()=>[{id:'s-one',title:'A',state:'pending',fileName:'hello.pdf'},{id:'s-two',title:'B',state:'pending',fileName:'world.pdf'}];let r=await readPendingCenter(deps,signal());assert.equal(filterPending(r.items,'HELLO','intake').length,1);assert.equal(filterPending(r.items,'HELLO','review').length,0);
  deps.local=async()=>[{id:'s-one',title:'A',state:'pending'},{id:'s-one',title:'B',state:'pending'}];r=await readPendingCenter(deps,signal());assert.equal(r.items.length,0);assert.match(r.issues[0],/重复/);
 });
 await test('controller coalesces scans and discards late callbacks after cancellation or close',async()=>{
  for(const mode of ['cancel','close']){const pause=deferred();let reads=0,changes=0;const c=new PendingController(async()=>{reads++;return pause.promise;},()=>changes++),a=c.refresh(),b=c.refresh();assert.equal(a,b);await Promise.resolve();assert.equal(reads,1);if(mode==='cancel')c.cancel();else c.dispose();const previous=changes;pause.resolve({items:[],issues:[],scannedAt:''});await a;assert.notEqual(c.state.phase,'ready');if(mode==='close')assert.equal(changes,previous);}
 });
 await test('library return locates exactly one object and does not fallback when it vanished',async()=>{
  const view=Object.create(PaperLibraryView.prototype);view.closed=false;view.readingEditor={active:false};view.primaryEditor={active:false};view.renderShell=()=>{};view.saveView=()=>{};
  view.browser={refresh:async()=>{},state:{phase:'ready',result:{papers:[paper([record('one')],'first'),paper([record('two')],'second')]}}};
  await view.revealObject({kind:'record',id:'two'},signal());assert.equal(view.selectedKey,'second');await assert.rejects(view.revealObject({kind:'record',id:'missing'},signal()),/唯一定位/);assert.equal(view.selectedKey,'second');
 });
 console.log(`PENDING_CENTER_OK (${n} groups; no model/network/filesystem writes)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
