"use strict";
// Opt-in native integration against the public PMC README sample. Not part of npm tests.
// Keeps downloaded files and records; no model calls, Wiki writes or deletion.
module.exports = async function(app, mode = "acquire") {
	const assert = require("node:assert/strict"), { setTimeout } = require("node:timers");
	const plugin = app.plugins.plugins["research-agent-reader"], service = plugin.getAcquisitionService();
	const before = {settings: JSON.stringify(plugin.settings), history: JSON.stringify(plugin.taskRuns)};
	const transport = service.backend.transport, originalMetadata = transport.metadata, originalDownload = transport.download;
	let metadataCalls = 0, pdfTransfers = 0; const checks = [];
	transport.metadata = function(...args) { metadataCalls++; return originalMetadata.apply(this,args); };
	transport.download = function(...args) { pdfTransfers++; return originalDownload.apply(this,args); };
	const wait = async (predicate, timeout = 30000) => { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error("Native PMC check timed out: "+JSON.stringify({completed:checks,preview:[...plugin.fulltextPreviews].map(p=>p.contentEl.querySelector('.rar-fulltext-pager span')?.textContent)})); await new Promise(resolve => setTimeout(resolve,40)); } };
	const check = (condition,label) => { assert.ok(condition,label); checks.push(label); };
	const initialPreviews = new Set(plugin.fulltextPreviews), initialModals = new Set(plugin.acquisitionModals);
	try {
		await service.ready();
		const request = {input:{kind:"pmcid",value:"PMC10009416"},goal:"pdf",versionPolicy:"record_only"};
		if (mode === "resume") check(service.list().some(j=>j.phase==="acquired" && j.identity?.identifiers.pmcid===request.input.value),"reload recovered a verified local snapshot");
		const job = await service.start(request);
		await wait(()=>["awaiting_selection","acquired","failed","no_match","conflict"].includes(service.get(job.id).phase));
		let current = service.get(job.id);
		if (current.phase === "awaiting_selection") {
			check(current.identity.identifiers.doi === "10.1002/npr2.12307" && current.identity.identifiers.pmid === "36537061","public identifiers resolve consistently");
			check(current.candidates.length > 0 && current.candidates.every(c=>c.pmc && c.version==="version_of_record"),"real version manifests produce publication PDF candidates");
			await service.choose(job.id,current.candidates[0].id);
			await wait(()=>["acquired","failed","conflict"].includes(service.get(job.id).phase),180000);
		}
		current = service.get(job.id); assert.equal(current.phase,"acquired",JSON.stringify({phase:current.phase,error:current.error,errorCode:current.errorCode}));
		const {snapshot,bytes} = await service.preview(job.id);
		check(snapshot.artifact.byteLength === bytes.length && bytes.length > 1000,"real PDF is bounded, hashed and readable from disk");
		check(snapshot.validation.pageCount > 1 && snapshot.validation.bodyCheck === "not_checked","native PDF.js parses pages without claiming a deep reading");
		const callsBefore = metadataCalls, transfersBefore = pdfTransfers;
		for (const kind of ["doi","pmid","pmcid"]) {
			const reused = await service.start({...request,input:{kind,value:snapshot.identity.identifiers[kind]}});
			assert.equal(reused.id,job.id);
		}
		check(metadataCalls === callsBefore && pdfTransfers === transfersBefore,"three identifier aliases reuse the same file with zero network requests");
		if(mode === "resume") check(metadataCalls === 0 && pdfTransfers === 0,"reload and preview require no provider calls");
		plugin.openFulltextAcquisition("production",job.id);
		const modal = [...plugin.acquisitionModals].find(m=>!initialModals.has(m));
		const card=()=>modal.contentEl.querySelector(`[data-job-id="${job.id}"]`);
		await wait(()=>card()?.querySelector('[data-fulltext-action="preview"]'));
		check(modal.contentEl.textContent.includes(snapshot.identity.title),"production panel shows resolved identity");
		for(const width of [360,680]) { modal.modalEl.style.width=width+"px"; await new Promise(r=>setTimeout(r,50)); check(modal.contentEl.scrollWidth <= modal.contentEl.clientWidth+2,"production panel fits width "+width); }
		card().querySelector('[data-fulltext-action="preview"]').click();
		await wait(()=>[...plugin.fulltextPreviews].some(p=>!initialPreviews.has(p)));
		const preview=[...plugin.fulltextPreviews].find(p=>!initialPreviews.has(p));
		await wait(()=>preview.contentEl.querySelector('.rar-fulltext-pager span')?.textContent===`第 1 / ${snapshot.validation.pageCount} 页`);
		const canvas=preview.contentEl.querySelector("canvas");
		check(canvas.width>100 && canvas.height>100 && Math.max(canvas.width,canvas.height)<=1601,"passive preview renders a bounded page canvas");
		const pixels=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;
		let ink=0; for(let i=0;i<pixels.length;i+=4) if(pixels[i]<180 && pixels[i+1]<180 && pixels[i+2]<180) ink++;
		check(ink>100,"first page canvas contains visible document text");
		preview.contentEl.querySelector('[aria-label="PDF 下一页"]').click();
		await wait(()=>preview.contentEl.querySelector('.rar-fulltext-pager span')?.textContent===`第 2 / ${snapshot.validation.pageCount} 页`);
		check(true,"next page renders in the native preview");
		check(plugin.getTaskRuns().some(r=>r.id===job.id),"acquisition is projected into Dashboard history");
		check(JSON.stringify(plugin.settings)===before.settings && JSON.stringify(plugin.taskRuns)===before.history,"settings and legacy stored history are unchanged");
		return {ok:true,mode,checks,jobId:job.id,snapshotId:snapshot.id,sourceVersion:snapshot.candidate.pmc.sourceVersionId,license:snapshot.candidate.pmc.license,bytes:bytes.length,sha256:snapshot.artifact.sha256,pages:snapshot.validation.pageCount,identityCheck:snapshot.validation.identityCheck,metadataCalls,pdfTransfers};
	} finally {
		for(const preview of [...plugin.fulltextPreviews]) if(!initialPreviews.has(preview)) preview.close();
		for(const modal of [...plugin.acquisitionModals]) if(!initialModals.has(modal)) modal.close();
		transport.metadata=originalMetadata; transport.download=originalDownload;
	}
};
