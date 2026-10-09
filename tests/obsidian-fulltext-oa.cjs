"use strict";
// Explicit live-source QA. Email comes only from user-configured plugin settings.
module.exports=async function(app,mode="discover",doi="10.21105/joss.01143"){
	const assert=require("node:assert/strict"),{setTimeout}=require("node:timers");
	const plugin=app.plugins.plugins["research-agent-reader"],service=plugin.getAcquisitionService(),transport=service.backend.transport;
	const originalMetadata=transport.metadata,originalDownload=transport.download;let metadataCalls=0,pdfTransfers=0;
	transport.metadata=function(...args){metadataCalls++;return originalMetadata.apply(this,args);};transport.download=function(...args){pdfTransfers++;return originalDownload.apply(this,args);};
	const wait=async predicate=>{const deadline=Date.now()+310000;while(!predicate()){if(Date.now()>deadline)throw new Error("Live OA QA timed out");await new Promise(r=>setTimeout(r,50));}};
	try{
		assert.ok(plugin.settings.fulltextUnpaywallEnabled&&plugin.settings.fulltextUnpaywallEmail,"user must configure Unpaywall");await service.ready();
		if(mode==="resume")assert.ok(service.list().some(j=>j.phase==="acquired"&&j.identity?.identifiers.doi===doi),"resume needs a completed snapshot");
		const job=await service.start({input:{kind:"doi",value:doi},goal:"pdf",versionPolicy:"record_only",useUnpaywall:true});
		await wait(()=>["awaiting_selection","acquired","failed","no_match","needs_configuration","conflict"].includes(service.get(job.id).phase));
		let current=service.get(job.id);if(!["awaiting_selection","acquired"].includes(current.phase))throw new Error(JSON.stringify({phase:current.phase,error:current.error,code:current.errorCode}));
		if(mode==="discover")return{mode,jobId:job.id,phase:current.phase,title:current.identity.title,authors:current.identity.authors.length,candidates:current.candidates.map(c=>({id:c.id,provider:c.providerId,origin:c.oa?.origin,version:c.version,license:c.oa?.license})),metadataCalls,pdfTransfers};
		if(current.phase==="awaiting_selection"){assert.ok(current.candidates[0].oa,"live test should exercise OA fallback");await service.choose(job.id,current.candidates[0].id);await wait(()=>["acquired","failed","no_match","needs_configuration","conflict"].includes(service.get(job.id).phase));}
		current=service.get(job.id);assert.equal(current.phase,"acquired",JSON.stringify({error:current.error,code:current.errorCode}));
		const {snapshot,bytes}=await service.preview(job.id);assert.equal(snapshot.candidate.providerId,"unpaywall");
		const beforeCalls=metadataCalls,beforeTransfers=pdfTransfers;assert.equal((await service.start({input:{kind:"doi",value:doi},goal:"pdf",versionPolicy:"record_only",useUnpaywall:true})).id,job.id);assert.equal(metadataCalls,beforeCalls);assert.equal(pdfTransfers,beforeTransfers);
		const beforePreviews=new Set(plugin.fulltextPreviews);await plugin.openAcquiredPdf(job.id);const preview=[...plugin.fulltextPreviews].find(p=>!beforePreviews.has(p));
		try{await wait(()=>preview.contentEl.querySelector(".rar-fulltext-pager span")?.textContent===`第 1 / ${snapshot.validation.pageCount} 页`);assert.ok(preview.contentEl.querySelector("canvas").width>100);}finally{preview.close();}
		if(mode==="resume"){assert.equal(metadataCalls,0);assert.equal(pdfTransfers,0);}
		return{ok:true,mode,jobId:job.id,snapshotId:snapshot.id,title:snapshot.identity.title,origin:snapshot.candidate.oa.origin,license:snapshot.candidate.oa.license,bytes:bytes.length,pages:snapshot.validation.pageCount,identityCheck:snapshot.validation.identityCheck,sha256:snapshot.artifact.sha256,metadataCalls,pdfTransfers};
	}finally{transport.metadata=originalMetadata;transport.download=originalDownload;}
};
