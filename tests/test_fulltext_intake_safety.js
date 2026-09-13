"use strict";
// Real copy/publish implementations, in-memory filesystem. Any deletion is an error.
const assert=require("node:assert/strict"),path=require("node:path"),{createHash,randomUUID}=require("node:crypto"),{loadReading}=require("./reading-test-helpers");
const files=new Map(),dirs=new Set();let count=0,opened=0,closed=0,deletions=0,failWrite=false;
const deny=()=>{deletions++;throw new Error("Deletion prohibited");};
const stat=name=>({dev:1n,ino:1n,size:BigInt(files.get(name)?.length||0),mtimeNs:1n,ctimeNs:1n,isFile:()=>files.has(name),isDirectory:()=>dirs.has(name),isSymbolicLink:()=>false});
const root=path.resolve("intake-safety-memory"),source=path.join(root,"source.pdf"),bytes=Buffer.from("%PDF-1.7\nsource snapshot bytes\n%%EOF\n");dirs.add(root);files.set(source,bytes);
const promises={lstat:async name=>stat(name),stat:async name=>stat(name),realpath:async name=>name,mkdtemp:async prefix=>{const value=prefix+(++count);dirs.add(value);return value;},unlink:deny,rmdir:deny,open:async(name,flags)=>{opened++;if(flags==="wx"){assert.ok(!files.has(name));files.set(name,Buffer.alloc(0));}return{stat:async()=>stat(name),read:async(buffer,offset,length,position)=>({bytesRead:files.get(name).copy(buffer,offset,position,position+length)}),write:async chunk=>{if(failWrite)throw new Error("disk full");const part=Buffer.from(chunk.subarray(0,5));files.set(name,Buffer.concat([files.get(name),part]));return{bytesWritten:part.length};},sync:async()=>{},close:async()=>{closed++;}};}};
const fs={promises,existsSync:name=>dirs.has(name)||files.has(name),lstatSync:name=>{const value=stat(name);return{...value,size:Number(value.size)};},realpathSync:name=>name,mkdtempSync:prefix=>{const value=prefix+(++count);dirs.add(value);return value;},opendirSync:name=>{const entries=[...files.keys()].filter(f=>path.dirname(f)===name).map(f=>({name:path.basename(f)}));return{readSync:()=>entries.shift()||null,closeSync(){}};},readFileSync:(name,encoding)=>encoding?files.get(name).toString(encoding):files.get(name),unlinkSync:deny,rmdirSync:deny};
const {createAuthorizedPdfSnapshot,disposeAuthorizedPdfSnapshot}=loadReading("agent/pdf-identity.ts",{"node:fs":fs});
const {publishValidatedPackageAtomically,MineruPreCommitValidationError}=loadReading("agent/mineru-publish.ts",{"node:fs":fs});
(async()=>{
	const expected={sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length};
	const snapshot=await createAuthorizedPdfSnapshot(source,{stageRoot:root,retainFiles:true,expected});assert.deepEqual(files.get(snapshot.path),bytes,"short filesystem writes complete the full authorized copy");await disposeAuthorizedPdfSnapshot(snapshot);assert.ok(files.has(snapshot.path));
	await assert.rejects(createAuthorizedPdfSnapshot(source,{stageRoot:root,retainFiles:true,expected:{...expected,sha256:"0".repeat(64)}}),/不一致/);
	await assert.rejects(createAuthorizedPdfSnapshot(source,{stageRoot:root,retainFiles:true,expected:{...expected,byteLength:bytes.length+1}}),/大小/);
	failWrite=true;await assert.rejects(createAuthorizedPdfSnapshot(source,{stageRoot:root,retainFiles:true,expected}),/disk full/);failWrite=false;
	assert.equal(opened,closed);assert.equal(files.get(source),bytes);
	const papers=path.join(root,"papers");dirs.add(papers);
	for(const scenario of ["copy","validation","cancel","occupied","rename","success"]){
		const citekey="case_"+scenario,target=path.join(papers,citekey);let stage;
		const controller=new AbortController(),context={signal:controller.signal,timeoutMs:1000,retainStaging:true,validateBeforeCommit:()=>{if(scenario==="validation")throw new MineruPreCommitValidationError("wrong article");}};
		const ops={copyPackage(_source,to){stage=path.dirname(to);dirs.add(to);files.set(path.join(to,"article.md"),Buffer.from("# Existing verified article"));if(scenario==="copy")throw new Error("copy failed");if(scenario==="cancel")controller.abort();if(scenario==="occupied")dirs.add(target);},renamePackage(from,to){if(scenario==="rename")throw new Error("rename failed");dirs.add(to);files.set(path.join(to,"article.md"),files.get(path.join(from,"article.md")));files.delete(path.join(from,"article.md"));dirs.delete(from);}};
		if(scenario==="success")assert.equal(publishValidatedPackageAtomically("package",papers,citekey,context,ops),target);
		else assert.throws(()=>publishValidatedPackageAtomically("package",papers,citekey,context,ops));
		assert.ok(dirs.has(stage),scenario+" retains staging");if(scenario!=="success")assert.ok(files.has(path.join(stage,"package","article.md")));
	}
	assert.equal(deletions,0,"copy/publish/abort/failure/success retention performs no deletion");
	const Base=class{},obsidian={Plugin:Base,PluginSettingTab:Base,Component:Base,ItemView:Base,Modal:Base,TFile:Base,FileSystemAdapter:Base,Notice:Base,normalizePath:p=>p};
	const Plugin=loadReading("plugin.ts",{obsidian,electron:{}}).default,plugin=new Plugin();plugin.settings={taskHistoryLimit:5};plugin.saveSettings=async()=>{};plugin.persistTaskRunOutput=async()=>"";plugin.deleteTaskRunOutput=deny;
	const ref={jobId:"a-"+randomUUID(),snapshotId:"s-"+randomUUID(),...expected};
	const action={id:"paper-ingest",label:"ingest",agent:"intake"};plugin.taskRuns=Array.from({length:8},(_,i)=>({id:"old-"+i,actionId:"old",status:"done"}));
	await assert.rejects(plugin.startTaskRun({...action,id:"other"},"invalid binding",null,ref),/只能绑定/);
	const run=await plugin.startTaskRun(action,"bound intake",null,ref);await plugin.finishTaskRun(run.id,{status:"failed",error:"fixture failure"});assert.equal(deletions,0);assert.equal(plugin.taskRuns.length,9);
	const {normalizeStoredTaskRuns}=loadReading("runtime/persistence.ts");assert.equal(normalizeStoredTaskRuns([...plugin.taskRuns.slice(1),plugin.taskRuns[0]],5).find(r=>r.id===run.id).acquisitionSource.snapshotId,ref.snapshotId);
	let modelCalls=0,requestWrites=0;
	plugin.getAcquisitionService=()=>({intakeSource:async()=>({path:source,snapshot:{id:ref.snapshotId,artifact:{sha256:ref.sha256,byteLength:ref.byteLength}}})});
	plugin.getIngestRecords=()=>({write:async()=>{requestWrites++;}});plugin.agentLoopService={runPaperIngest:async()=>{modelCalls++;return{exitCode:1,artifacts:{}};}};
	const options={sourcePdfPath:source,acquisitionSource:{...ref,sha256:"0".repeat(64)},createArticleMarkdown:false,createArticleWiki:true};
	await assert.rejects(plugin.runLightPaperIngest(run.id,options,"fixture"),/不一致/);assert.equal(modelCalls,0);assert.equal(requestWrites,0);
	await assert.rejects(plugin.runLightPaperIngest(run.id,{...options,acquisitionSource:undefined},"fixture"),/不一致/);
	await assert.rejects(plugin.runLightPaperIngest(run.id,{...options,acquisitionSource:{...ref,jobId:"a-"+randomUUID()}},"fixture"),/不一致/);
	assert.equal(modelCalls,0);assert.equal(requestWrites,0);
	await plugin.runLightPaperIngest(run.id,{...options,acquisitionSource:ref},"fixture");assert.equal(modelCalls,1);assert.equal(requestWrites,1);
	console.log("PASS acquisition intake safety: expected PDF hash, short writes, retained authorization/staging, no output eviction, persisted task binding and validation before model work");
})().catch(e=>{console.error(e);process.exitCode=1;});
