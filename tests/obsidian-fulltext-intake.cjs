"use strict";
// Native acquisition -> real plugin intake lifecycle -> deferred fake model backend.
// Reads one existing local PDF; all new jobs/links/history/requests stay in memory.
module.exports=async function(app){
	const assert=require("node:assert/strict"),{setTimeout}=require("node:timers"),{memory,waitFor}=require("./fulltext-fixtures.cjs");
	const plugin=app.plugins.plugins["research-agent-reader"],previous=plugin.getAcquisitionService();await previous.ready();
	if(plugin.isActionRunning("paper-ingest"))throw new Error("Wait for current intake before native QA");
	const job=previous.list().find(j=>j.phase==="acquired"&&j.request.goal==="pdf");if(!job)throw new Error("Native QA needs an acquired local PDF");
	const snapshot=await previous.repository.snapshot(job.snapshotId),storage=memory();storage.jobs.set(job.id,structuredClone(job));storage.snapshots.set(snapshot.id,structuredClone(snapshot));
	const service=new previous.constructor(new previous.repository.constructor(storage,"production"),previous.deviceId,previous.backend);
	const before={settings:JSON.stringify(plugin.settings),history:[...plugin.taskRuns],results:new Map(plugin.lightAgentResults),modals:new Set(document.querySelectorAll(".modal-container"))};
	const originals=new Map(),pending=new Map(),requests=new Map(),operations=[],checks=[];let calls=0;
	const profile={id:"fulltext-native-fixture",name:"本地验收模拟模型",model:"deterministic",lastTest:{ok:true}};
	const patch=(name,value)=>{originals.set(name,{own:Object.hasOwn(plugin,name),value:plugin[name]});plugin[name]=value;};
	const oldRun=plugin.agentLoopService.runPaperIngest;
	const transport=previous.backend.transport,oldMetadata=transport.metadata,oldDownload=transport.download;
	const outcome=status=>({exitCode:status==="done"?0:status==="interrupted"?130:1,stdout:"Native fulltext intake fixture",stderr:"",loopStatus:status==="interrupted"?"cancelled":"completed",filesWritten:[],artifacts:{articlePath:"",wikiPath:"",filesWritten:[]},result:{status:status==="done"?"completed":"failed",errors:status==="done"?[]:["simulated intake failure"],conflicts:[],duplicates:[],notes:[]}});
	const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
	const closeResults=()=>{for(const el of document.querySelectorAll(".modal-container"))if(!before.modals.has(el)&&!el.querySelector('[data-fulltext-action="intake"]')&&!el.querySelector('[data-fulltext-action="intake-start"]'))el.querySelector(".modal-close-button, .modal-header-button:has(.lucide-x)")?.click();};
	const intake=()=>[...plugin.acquisitionDialogs][0];
	let off;
	try{
		transport.metadata=transport.download=async()=>{throw new Error("Intake QA must not query/download sources");};
		plugin.acquisitionServices.set("production",service);off=service.subscribe(()=>plugin.notifyTaskRuns());await service.ready();
		patch("saveSettings",async()=>{});patch("persistTaskRunOutput",async()=>"");patch("deleteTaskRunOutput",async()=>{throw new Error("QA must not remove files");});
		patch("getIngestRecords",()=>({write:async(_kind,id,value)=>{requests.set(id,structuredClone(value));},read:async(_kind,id)=>requests.get(id)||null}));
		patch("getVerifiedProviderProfiles",()=>[]);patch("getProviderProfile",id=>id===profile.id?profile:originals.get("getProviderProfile").value.call(plugin,id));
		patch("stopTaskRun",id=>{if(pending.has(id)){pending.get(id).resolve(outcome("interrupted"));pending.delete(id);return true;}return originals.get("stopTaskRun").value.call(plugin,id);});
		plugin.agentLoopService.runPaperIngest=async(id,options,profileId,hooks)=>{calls++;assert.equal(options.acquisitionSource.snapshotId,snapshot.id);assert.equal(options.acquisitionSource.sha256,snapshot.artifact.sha256);hooks.onEvent({status:"waiting",payload:{ingestProgress:{steps:["prepare","identity","draft","save"],stage:"identity",detail:"模拟：等待标题页核对",waiting:true}}});return new Promise(resolve=>pending.set(id,{resolve,options,profileId}));};
		plugin.openFulltextAcquisition("production",job.id);const acquisition=[...plugin.acquisitionModals].find(m=>m.service===service);
		await waitFor(()=>acquisition.contentEl.querySelector('[data-fulltext-action="intake"]'));
		const open=async()=>{acquisition.contentEl.querySelector('[data-fulltext-action="intake"]').click();await waitFor(()=>intake());return intake().contentEl.querySelector('[data-fulltext-action="intake-start"]');};
		let start=await open();check(start.disabled,"intake needs a configured model while acquisition remains available");intake().close();
		plugin.getVerifiedProviderProfiles=()=>[profile];start=await open();
		check(intake().contentEl.textContent.includes(snapshot.identity.title),"intake is bound to the acquired paper");
		const boxes=[...intake().contentEl.querySelectorAll('input[type="checkbox"]')];check(getComputedStyle(boxes[2].parentElement).display==="none","upload consent is hidden when conversion is not selected");check(boxes[0].getBoundingClientRect().width<40,"output checkbox retains a compact hit target");
		for(const width of [360,680]){intake().modalEl.style.width=width+"px";await new Promise(r=>setTimeout(r,40));check(intake().contentEl.scrollWidth<=intake().contentEl.clientWidth+2,"intake choices fit width "+width);}
		boxes[0].checked=true;boxes[0].dispatchEvent(new Event("change"));check(getComputedStyle(boxes[2].parentElement).display!=="none","conversion selection reveals upload consent");await start.onclick();check(calls===0&&intake().contentEl.textContent.includes("请确认"),"remote conversion requires separate consent");boxes[0].checked=false;boxes[0].dispatchEvent(new Event("change"));
		const first=start.onclick();operations.push(first);await start.onclick();await waitFor(()=>pending.size===1);check(calls===1,"double click starts exactly one intake");
		const run=plugin.getRunningTaskRun("paper-ingest");check(run.acquisitionSource.snapshotId===snapshot.id,"TaskRun keeps the immutable source reference");check(service.get(job.id).phase==="acquired","running intake does not change acquisition completion");
		check(service.get(job.id).intakeRunIds.includes(run.id),"acquisition links its intake run");await waitFor(()=>acquisition.contentEl.textContent.includes("关联入库：进行中"));check(true,"linked intake status updates in the open acquisition panel");
		check(plugin.getTaskRuns().find(r=>r.id===run.id).ingestProgress?.waiting,"identity confirmation remains a distinct waiting phase");
		pending.get(run.id).resolve(outcome("failed"));pending.delete(run.id);await first;await waitFor(()=>acquisition.contentEl.textContent.includes("关联入库：未完成"));check(true,"failure status updates independently");closeResults();
		Object.assign(requests.get(run.id).options,{createArticleMarkdown:true,mineruModel:"pipeline",mineruLanguage:"en",mineruOcr:true,mineruPages:"1-3",remoteUploadConfirmed:true});
		const failed=plugin.getTaskRuns().find(r=>r.id===run.id);await plugin.continuePaperIngest(failed);await waitFor(()=>intake());start=intake().contentEl.querySelector('[data-fulltext-action="intake-start"]');
		const resumedBoxes=[...intake().contentEl.querySelectorAll('input[type="checkbox"]')];check(resumedBoxes[0].checked&&!resumedBoxes[2].checked,"continuation restores output choice but resets upload consent");check(intake().contentEl.textContent.includes("pipeline")&&intake().contentEl.textContent.includes("1-3"),"continuation displays its retained conversion parameters");
		await start.onclick();check(calls===1,"previous upload consent cannot authorize a new intake");resumedBoxes[2].checked=true;
		const second=start.onclick();operations.push(second);await waitFor(()=>pending.size===1);const resumed=plugin.getRunningTaskRun("paper-ingest");check(resumed.id!==run.id&&resumed.acquisitionSource.sha256===run.acquisitionSource.sha256,"retry creates a new intake for the same acquired PDF");
		check(pending.get(resumed.id).options.mineruPages==="1-3"&&pending.get(resumed.id).options.mineruModel==="pipeline"&&pending.get(resumed.id).options.mineruOcr,"same conversion parameters reach the deferred fake backend");
		pending.get(resumed.id).resolve(outcome("done"));pending.delete(resumed.id);await second;await waitFor(()=>acquisition.contentEl.textContent.includes("关联入库：已完成"));check(true,"completed intake synchronizes its result");closeResults();
		start=await open();const third=start.onclick();operations.push(third);await waitFor(()=>pending.size===1);const stopped=plugin.getRunningTaskRun("paper-ingest");plugin.stopTaskRun(stopped.id);await third;check(plugin.getTaskRuns().find(r=>r.id===stopped.id).status==="interrupted","stopping intake preserves the acquisition snapshot");closeResults();
		check(service.get(job.id).snapshotId===snapshot.id&&service.get(job.id).phase==="acquired","all three intakes reuse one completed acquisition");
		for(const width of [360,680]){acquisition.modalEl.style.width=width+"px";await new Promise(r=>setTimeout(r,40));check(acquisition.contentEl.scrollWidth<=acquisition.contentEl.clientWidth+2,"linked task panel fits width "+width);}
		check(JSON.stringify(plugin.settings)===before.settings,"native QA leaves settings unchanged");
		check(JSON.stringify(plugin.taskRuns.filter(r=>!r.acquisitionSource || r.acquisitionSource.jobId!==job.id))===JSON.stringify(before.history.filter(r=>!r.acquisitionSource || r.acquisitionSource.jobId!==job.id)),"legacy user history is unchanged");
		return{ok:true,checks,calls,realModelCalls:0,realMineruCalls:0};
	}finally{
		for(const p of pending.values())p.resolve(outcome("interrupted"));await Promise.allSettled(operations);off?.();
		for(const modal of [...plugin.acquisitionDialogs])modal.close();for(const modal of [...plugin.acquisitionModals])if(modal.service===service)modal.close();closeResults();
		transport.metadata=oldMetadata;transport.download=oldDownload;plugin.agentLoopService.runPaperIngest=oldRun;for(const[name,value]of originals){if(value.own)plugin[name]=value.value;else delete plugin[name];}
		plugin.taskRuns=before.history;plugin.lightAgentResults=before.results;plugin.acquisitionServices.set("production",previous);await service.dispose();plugin.notifyTaskRuns();
	}
};
