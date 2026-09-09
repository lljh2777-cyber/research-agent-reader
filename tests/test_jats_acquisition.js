"use strict";
const assert=require("node:assert/strict"),{loadReading}=require("./reading-test-helpers"),{memory,waitFor}=require("./fulltext-fixtures.cjs"),{fixture}=require("./jats-fixtures.cjs");
const {AcquisitionService}=loadReading("fulltext/service.ts"),{AcquisitionRepository}=loadReading("fulltext/repository.ts"),{decodeRequest,decodeSnapshot}=loadReading("fulltext/contracts.ts");
const services=[];
function make(f,storage=memory(),device="test-device") {
 const backend={mode:"production",unpaywallEnabled:true,resolve:async()=>f.identity,discover:async(r,s)=>f.provider.discover(r,f.identity,s),download:async()=>{throw new Error("Unexpected PDF download");},verify:async()=>{throw new Error("Unexpected PDF verifier");},downloadJats:(c,s,p,context)=>f.provider.download(c,context.request,context.identity,context.attemptId,s,p,context.budget),readJatsSnapshot:s=>f.provider.read(s)};
 const service=new AcquisitionService(new AcquisitionRepository(storage,"production"),device,backend);services.push(service);return {service,storage,backend};
}
async function complete(a,request){const job=await a.service.start(request);await waitFor(()=>a.service.get(job.id).phase==="awaiting_selection");await a.service.choose(job.id,a.service.get(job.id).candidates[0].id);await waitFor(()=>["failed","acquired"].includes(a.service.get(job.id).phase));assert.equal(a.service.get(job.id).phase,"acquired",a.service.get(job.id).error);return a.service.get(job.id);}
(async()=>{
 const f=fixture(),a=make(f),job=await complete(a,f.request),preview=await a.service.previewJats(job.id);
 assert.equal(preview.snapshot.schemaVersion,3);assert.equal(preview.snapshot.validation.requestSatisfaction,"satisfied");assert.equal(job.request.useUnpaywall,undefined);await assert.rejects(a.service.preview(job.id));
 const calls=f.calls.length;assert.equal((await a.service.start({...f.request,input:{kind:"doi",value:f.identity.identifiers.doi}})).id,job.id);assert.equal(f.calls.length,calls,"alias cache reuse is offline");
 const restart=make(f,a.storage);await restart.service.ready();assert.equal(restart.service.get(job.id).phase,"acquired");assert.equal(f.calls.length,calls);
 const other=make(f,a.storage,"other-device");await other.service.ready();await assert.rejects(other.service.previewJats(job.id));await assert.rejects(other.service.refreshJats(job.id));
 const text=await complete(a,{...f.request,includeFigures:false});assert.notEqual(text.id,job.id);const textSource=await a.service.previewJats(text.id);assert.equal(textSource.snapshot.validation.assetCheck,"not_requested");assert.equal(textSource.snapshot.validation.requestSatisfaction,"satisfied");assert.equal(textSource.snapshot.artifact.files.length,2);
 const fresh=await a.service.refreshJats(job.id);assert.notEqual(fresh.id,job.id);await waitFor(()=>a.service.get(fresh.id).phase==="awaiting_selection");assert.equal(a.service.get(job.id).snapshotId,job.snapshotId);a.service.stop(fresh.id);await a.service.settled();assert.equal(a.service.get(fresh.id).phase,"cancelled");
 const wrong=structuredClone(preview.snapshot);wrong.artifact.files[0].ref="../../secret";assert.throws(()=>decodeSnapshot(wrong,"production"));
 assert.throws(()=>decodeRequest({...f.request,useUnpaywall:true},"production"));assert.throws(()=>decodeRequest({...f.request,includeFigures:undefined},"production"));assert.throws(()=>decodeRequest(f.request,"demo"));
 const xml=preview.snapshot.artifact.files.find(f=>f.role==="xml");f.storage.files.set(xml.path,Buffer.from("changed"));await assert.rejects(a.service.previewJats(job.id),/校验失败/);assert.equal(a.service.get(job.id).phase,"interrupted");
 const partial=fixture();partial.transport.failImage=true;const p=make(partial),pj=await complete(p,partial.request);assert.equal((await p.service.previewJats(pj.id)).snapshot.validation.requestSatisfaction,"partial");
 const interrupted=fixture(),i=make(interrupted);let release;i.backend.downloadJats=async()=>new Promise(r=>{release=r;});const ij=await i.service.start(interrupted.request);await waitFor(()=>i.service.get(ij.id).phase==="awaiting_selection");await i.service.choose(ij.id,i.service.get(ij.id).candidates[0].id);await waitFor(()=>release);i.service.stop(ij.id);await i.service.settled();const result=await interrupted.acquire();release({artifact:result.snapshot.artifact,validation:result.snapshot.validation});await new Promise(r=>setTimeout(r,20));assert.equal(i.storage.snapshots.size,0,"late source results cannot commit after cancellation");
 console.log("JATS_ACQUISITION_OK: production lifecycle, isolated PDF/JATS requests, offline restart/cache, explicit refresh, ownership, corruption and cancellation");
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{for(const s of services)await s.dispose();});
