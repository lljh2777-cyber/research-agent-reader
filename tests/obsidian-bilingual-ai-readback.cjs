/* Reads the four saved real-model QA records after plugin reload; no model calls,
 * source edits, index writes or deletion. Output is a new, explicitly named file. */
module.exports=async function bilingualAIReadback(app,directory){
 const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),timers=require("node:timers"),p=app.plugins.plugins["research-agent-reader"];
 assert.equal(app.vault.getName(),"paper-test");assert.equal(p.manifest.version,"0.84.1");assert.equal(app.workspace.activeLeaf.view.getViewType(),"empty");assert.ok(!p.annotationPopover&&!p.getTaskRuns().some(r=>r.status==="running"));
 const plan=JSON.parse(fs.readFileSync(path.join(directory,"plan.json"),"utf8")),checks=[],original=p.createLLMProvider;let modelCalls=0;
 p.createLLMProvider=()=>{modelCalls++;throw Error("readback must not call a model");};
 const until=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await new Promise(r=>timers.setTimeout(r,25));}throw Error("readback UI timeout");};
 try{
  for(const test of plan.cases){
   const result=JSON.parse(fs.readFileSync(path.join(directory,"closeout",test.id+".result.json"),"utf8"));assert.equal(result.ok,true);
   const record=await p.annotationService.loadAnnotation(result.annotation.annotationPath,result.annotation.id);assert.ok(record);assert.equal(record.aiText,result.explanation.text);assert.equal(record.aiModel,plan.model);assert.equal(record.selectedText,test.selectedText);assert.equal(record.bilingual.language,test.language);assert.equal(record.bilingual.english.text,test.english);assert.equal(record.bilingual.status,"needs-review");assert.equal(record.bilingual.humanReview,"not-reviewed");
   const context=await p.annotationService.getRecordExplanationContext(record);assert.deepEqual(context.bilingual,record.bilingual);assert.equal(context.selectedText,test.selectedText);
   p.openAnnotationPopover({record,anchorRect:new DOMRect(30,30,20,20)});await until(()=>[...document.querySelectorAll(".agent-annotation-section-content")].some(el=>el.textContent.includes("英文依据：")));
   const popup=document.querySelector(".agent-annotation-popover");assert.ok(popup.querySelector(".agent-annotation-source-role").textContent.includes(test.language==="en"?"英文来源摘录":"中文译文摘录"));assert.equal(popup.querySelector("details pre").textContent,test.english);assert.ok(popup.textContent.includes("AI 解释")&&popup.textContent.includes("一般知识／解释性推断："));assert.ok(![...popup.querySelectorAll("button")].some(b=>["归档","重新归档"].includes(b.textContent)));p.annotationPopover.close();checks.push(test.id+": exact saved AI answer, language, English receipt and review state retained after reload; automatic archive absent");
  }
  for(const [name,digest] of Object.entries(plan.digests))assert.equal(crypto.createHash("sha256").update(Buffer.from(await app.vault.adapter.readBinary(plan.root+"/"+name))).digest("hex"),digest);
  assert.equal(p.settings.annotationBackendId,"codex-cli");assert.equal(p.settings.annotationWebSearchEnabled,true);assert.equal(p.settings.annotationMaxTokens,1500);assert.equal(p.settings.activeProviderId,"provider-1789025256657-i5009a");checks.push("paired source bytes and metadata unchanged; original settings restored");
  assert.equal(modelCalls,0);const result={ok:true,version:p.manifest.version,checks,realModelCalls:modelCalls,active:app.workspace.activeLeaf.view.getViewType()};fs.writeFileSync(path.join(directory,"readback.json"),JSON.stringify(result,null,2),{encoding:"utf8",flag:"wx"});return result;
 }finally{p.annotationPopover?.close();p.createLLMProvider=original;}
};
