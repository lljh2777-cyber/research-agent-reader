/* Explicit real-model QA entry point for the installed paper-test plugin.
 * Invoke one frozen case at a time from Obsidian CLI; no retries or deletion.
 * Records messages/text/usage only: never profiles, credentials or headers.
 * Baseline creates a QA annotation. Replay retains the first artifact and
 * updates only the QA record whose ID and first answer match that artifact. */
module.exports = async function bilingualAI(app, options) {
 const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),timers=require("node:timers");
 const write=(name,value)=>fs.writeFileSync(path.join(options.outputDirectory,name),JSON.stringify(value,null,2),{encoding:"utf8",flag:"wx"});
 const plan=JSON.parse(fs.readFileSync(options.planPath,"utf8")),test=plan.cases.find(c=>c.id===options.caseId),p=app.plugins.plugins["research-agent-reader"];
 assert.ok(test);assert.equal(app.vault.getName(),"paper-test");assert.equal(p.manifest.version,options.version);
 assert.equal(app.workspace.activeLeaf.view.getViewType(),"empty");assert.ok(!p.getTaskRuns().some(r=>r.status==="running"));assert.ok(!document.querySelector(".agent-annotation-popover,.modal-container,textarea[data-dirty=true]"));
 for(const [name,digest] of Object.entries(plan.digests))assert.equal(crypto.createHash("sha256").update(Buffer.from(await app.vault.adapter.readBinary(plan.root+"/"+name))).digest("hex"),digest);
 const profile=p.settings.providerProfiles.find(x=>x.model===plan.model);assert.ok(profile?.lastTest?.ok);
 const original={backend:p.settings.annotationBackendId,web:p.settings.annotationWebSearchEnabled,maxTokens:p.settings.annotationMaxTokens,getProfile:p.getProviderProfile,create:p.createLLMProvider};
 const baselineLeaf=app.workspace.activeLeaf;let view,transport,selection,record,stage="opening",timer;
 const until=async predicate=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>timers.setTimeout(r,40));}throw Error("QA UI timeout at "+stage);};
 const win=require("electron").remote.getCurrentWindow();if(win.isMinimized())win.restore();win.show();win.focus();
 p.settings.annotationBackendId=profile.id;p.settings.annotationWebSearchEnabled=false;
 if(options.maxTokens!==undefined){assert.ok(Number.isInteger(options.maxTokens)&&options.maxTokens>=128&&options.maxTokens<=4096);p.settings.annotationMaxTokens=options.maxTokens;}
 p.getProviderProfile=function(id){const value=original.getProfile.call(this,id);return id===profile.id?{...value,timeoutSeconds:90}:value;};
 p.createLLMProvider=function(value){const provider=original.create.call(this,value),complete=provider.complete;
  provider.complete=async function(request,execution){assert.equal(transport,undefined,"only one model call per case");transport={request:structuredClone(request),startedAt:new Date().toISOString()};write(test.id+".request.json",transport);
   try{const answer=await complete.call(this,request,execution);transport.finishedAt=new Date().toISOString();transport.response={text:answer.text,model:answer.raw?.model??null,usage:answer.raw?.usage??null,finishReasons:answer.raw?.choices?.map(c=>c.finish_reason)??null};write(test.id+".response.json",transport.response);return answer;}
   catch(error){transport.finishedAt=new Date().toISOString();transport.error={name:error.name,message:String(error.message).replace(/(?:sk-|Bearer\s+)\S+/gi,"[redacted]")};write(test.id+".failure.json",transport.error);throw error;}
  };return provider;
 };
 try {
  await p.activateMineruReaderView(plan.root+"/paper."+(test.language==="en"?"md":"zh-CN.md"));view=app.workspace.activeLeaf.view;
  await until(()=>view.contentEl.querySelector('[data-bilingual-action="open"]'));view.contentEl.querySelector('[data-bilingual-action="open"]').click();await until(()=>view.bilingualReader?.panes.size===2&&!view.bilingualReader.restoring);
  const reader=view.bilingualReader,pane=reader.panes.get(test.language),paragraph=[...pane.article.querySelectorAll("p")].find(el=>reader.blockForElement(test.language,el)?.id===test.blockId&&el.textContent.includes(test.selectedText));assert.ok(paragraph,"selected rendered paragraph");
  const nodes=[],walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);let node,text="";while((node=walker.nextNode())){nodes.push({node,start:text.length,end:text.length+node.textContent.length});text+=node.textContent;}
  const from=text.indexOf(test.selectedText),to=from+test.selectedText.length;assert.ok(from>=0&&text.indexOf(test.selectedText,from+1)<0,"unique selected text");
  const first=nodes.find(n=>n.start<=from&&n.end>from),last=nodes.find(n=>n.start<to&&n.end>=to),range=document.createRange();range.setStart(first.node,from-first.start);range.setEnd(last.node,to-last.start);window.getSelection().removeAllRanges();window.getSelection().addRange(range);
  selection=await p.annotationService.captureSelection();assert.equal(selection.selectedText,test.selectedText);assert.equal(selection.bilingual.block.id,test.blockId);assert.equal(selection.bilingual.english.text,test.english);
  const {anchorRect,...savedSelection}=selection;write(test.id+".input.json",{case:test,selection:savedSelection,version:p.manifest.version,configuredModel:profile.model,web:false,maxTokens:p.settings.annotationMaxTokens,timeoutSeconds:90,planDigest:crypto.createHash("sha256").update(fs.readFileSync(options.planPath)).digest("hex")});
  stage="generation";
  let baseline=options.baselineDirectory?JSON.parse(fs.readFileSync(path.join(options.baselineDirectory,test.id+".result.json"),"utf8")):null;
  // A failed generation leaves the previous saved QA record untouched.
  if(baseline&&!baseline.annotation&&options.fallbackBaselineDirectory)baseline=JSON.parse(fs.readFileSync(path.join(options.fallbackBaselineDirectory,test.id+".result.json"),"utf8"));
  if(baseline?.annotation){
   assert.equal(baseline.ok,true);
   record=await p.annotationService.loadAnnotation(baseline.annotation.annotationPath,baseline.annotation.id);assert.ok(record,"QA baseline record exists");assert.equal(record.aiText,baseline.explanation.text,"do not replace an externally edited QA answer");
   const context=await p.annotationService.getRecordExplanationContext(record);assert.equal(context.selectedText,selection.selectedText);assert.deepEqual(context.bilingual,selection.bilingual);
   let cancel;timer=timers.setTimeout(()=>cancel?.(),95000);const explanation=await p.annotationService.generateExplanation(context,c=>cancel=c);clearTimeout(timer);
   await p.annotationService.updateAnnotation(record,{manualText:record.manualText,aiText:explanation.text,aiProvider:explanation.provider,aiModel:explanation.model});
  }else{
   assert.equal(await p.annotationService.findAnnotationForSelection(selection),null,"baseline must use a fresh selection");
   view.contentEl.querySelector('[data-bilingual-annotate="'+test.language+'"]').click();await until(()=>p.annotationPopover?.selection);
   const pop=p.annotationPopover;timer=timers.setTimeout(()=>pop.cancelGeneration?.(),95000);await pop.renderExplanation();clearTimeout(timer);
   if(!document.querySelector(".agent-annotation-ai-result"))throw Error("real answer unavailable: "+document.querySelector(".agent-annotation-popover")?.textContent);
   const button=[...document.querySelectorAll(".agent-annotation-popover button")].find(b=>b.textContent==="保留");assert.ok(button&&!button.disabled);button.click();await until(()=>!p.annotationPopover);
   record=await p.annotationService.findAnnotationForSelection(selection);assert.ok(record,"saved real AI annotation");
  }
  record=await p.annotationService.loadAnnotation(record.annotationPath,record.id);assert.equal(record.aiText,transport.response.text.trim());assert.deepEqual(record.bilingual,selection.bilingual);
  stage="readback";p.openAnnotationPopover({record,anchorRect:selection.anchorRect});await until(()=>document.querySelector(".agent-annotation-popover"));const roles=document.querySelector(".agent-annotation-popover").textContent;assert.ok(roles.includes(test.language==="en"?"英文来源摘录":"中文译文摘录"));p.annotationPopover.close();
  const result={ok:true,caseId:test.id,version:p.manifest.version,configuredModel:profile.model,explanation:{text:record.aiText,provider:record.aiProvider,model:record.aiModel},annotation:{id:record.id,annotationPath:record.annotationPath},startedAt:transport.startedAt,finishedAt:transport.finishedAt,usage:transport.response.usage,returnedModel:transport.response.model,finishReasons:transport.response.finishReasons,realModelCalls:1};write(test.id+".result.json",result);return {ok:true,caseId:test.id,version:p.manifest.version,model:profile.model,annotation:result.annotation,usage:result.usage,finishReasons:result.finishReasons};
 }catch(error){write(test.id+".result.json",{ok:false,stage,error:String(error.message).replace(/(?:sk-|Bearer\s+)\S+/gi,"[redacted]"),realModelCalls:transport?1:0,...(record?{unchangedAnnotation:{id:record.id,annotationPath:record.annotationPath}}:{})});throw error;
 }finally{clearTimeout(timer);p.annotationPopover?.close();p.settings.annotationBackendId=original.backend;p.settings.annotationWebSearchEnabled=original.web;p.settings.annotationMaxTokens=original.maxTokens;p.getProviderProfile=original.getProfile;p.createLLMProvider=original.create;if(view?.leaf)view.leaf.detach();if(baselineLeaf&&app.workspace.getLeafById(baselineLeaf.id))await app.workspace.revealLeaf(baselineLeaf);window.getSelection()?.removeAllRanges();app.workspace.requestSaveLayout();}
};
