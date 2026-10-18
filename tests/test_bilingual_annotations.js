"use strict";
// Real services and provenance in memory; no source writes, network or deletion.
const assert = require("node:assert/strict"), path = require("node:path"), { createHash } = require("node:crypto"), { loadReading } = require("./reading-test-helpers");
const hash = text => createHash("sha256").update(text).digest("hex");
class TFile { constructor(p) { this.path=p; this.extension=path.posix.extname(p).slice(1); this.basename=path.posix.basename(p,".md"); this.stat={size:0}; } }
let fixture;
class FileSourceStorage { async read(p) { return fixture.files.has(p) ? Buffer.from(fixture.files.get(p).text) : null; } }
const api = loadReading("../tests/bilingual-annotation-api.ts", { obsidian: { TFile, MarkdownView: class {}, Notice: class {}, normalizePath:p=>p, parseYaml:()=>({}) }, "../sources/storage":{FileSourceStorage} });
function make() {
 const root="Clippings/pair", en="\uFEFF---\ntitle: Example\n---\n## Main\n\nRepeated selected words.\n\nRepeated selected words.\n", zh="---\ntitle: 中文标题较长\n---\n## 正文\n\n重复的所选文字。\n\n重复的所选文字。\n";
 const metadata=JSON.stringify({schemaVersion:1,sourceFile:"paper.md",translationFile:"paper.zh-CN.md",sourceVersion:{algorithm:"sha256",value:hash(en)},status:"needs-review",humanReview:"not-reviewed"});
 const files=new Map(),writes=[]; for(const [p,text] of [[root+"/paper.md",en],[root+"/paper.zh-CN.md",zh],[root+"/translation.json",metadata],["wiki/concepts/target.md","# Target\n\nExisting claim.\n"]]) files.set(p,{file:new TFile(p),text});
 const app={vault:{adapter:{getBasePath:()=>"/memory"},getAbstractFileByPath:p=>files.get(p)?.file||null,getFileByPath:p=>files.get(p)?.file||null,getMarkdownFiles:()=>[...files.values()].map(v=>v.file).filter(f=>f.extension==="md"),read:async f=>files.get(f.path).text,
  createFolder:async p=>files.set(p,{file:{path:p}}),create:async(p,text)=>{assert.equal(files.has(p),false);const file=new TFile(p);files.set(p,{file,text});writes.push(p);return file;},process:async(f,fn)=>{files.get(f.path).text=fn(files.get(f.path).text);writes.push(f.path);}}};
 const doc=api.createBilingualDocument(root+"/paper.md",Buffer.from(en),Buffer.from(zh),Buffer.from(metadata));
 return {root,en,zh,metadata,files,writes,app,doc,service:new api.AnnotationService(app,{settings:{}})};
}
function selection(f,language="zh-CN",index=2) { const file=f.doc.files[language],block=file.blocks[index],selectedText=language==="en"?"selected words":"所选文字",start=file.text.indexOf(selectedText,block.start),end=start+selectedText.length;
 return {sourcePath:file.path,selectedText,sourceStart:start,sourceEnd:end,prefix:file.text.slice(Math.max(0,start-80),start),suffix:file.text.slice(end,end+80),sourceRevision:api.excerptRevision(file.text),section:block.chapter,context:file.text.slice(block.start,block.end),isTableCell:false,anchorRect:{},bilingual:api.bilingualReceipt(f.doc,language,block,start,end)}; }
let count=0; async function check(name,fn){fixture=make();await fn(fixture);count++;console.log("OK "+name);}
(async()=>{
 await check("separate language/occurrence IDs, literal source offsets and create-only reuse",async f=>{
  const zh=await f.service.createExcerpt(selection(f),"Personal note"),en=await f.service.createExcerpt(selection(f,"en")),other=await f.service.createExcerpt(selection(f,"zh-CN",1));
  assert.equal(api.quoteLabel(zh),"中文译文摘录");assert.equal(api.quoteLabel(en),"英文来源摘录");assert.notEqual(zh.id,en.id);assert.notEqual(zh.id,other.id);assert.ok(zh.sourceAnchor.start>f.zh.indexOf("所选文字"));
  assert.equal((await f.service.createExcerpt(selection(f),"must not overwrite")).manualText,"Personal note");assert.ok(f.writes.every(p=>p.startsWith("wiki/annotations/")));
  const parsed=api.readAnnotationRecords(f.files.get(zh.annotationPath).text,zh.annotationPath);assert.deepEqual(parsed.errors,[]);assert.equal(parsed.records[0].bilingual.english.text,"Repeated selected words.\n");
 });
 await check("manual/AI records preserve provenance and library roles",async f=>{
  const r=await f.service.createAnnotation(selection(f),{manualText:"my observation",aiText:"model background",aiProvider:"mock",aiModel:"mock"});
  const text=f.files.get(r.annotationPath).text;assert.match(text,/中文译文摘录/);assert.match(text,/英文对应段落/);assert.match(text,/not-reviewed/);
  const parsed=api.readLibraryAnnotations(text,r.annotationPath,()=>({}));assert.deepEqual(parsed.records[0].roles,["translation_quote","personal_note","ai_explanation"]);assert.deepEqual(parsed.records[0].provenance.bilingual,r.bilingual);
  const reopened=await f.service.findAnnotationForSelection(selection(f));assert.equal(reopened.id,r.id);
 });
 await check("paired source changes stop save, AI context, return and curation; history editable",async f=>{
  const s=selection(f),r=await f.service.createExcerpt(s,"historical note"),library=new api.ExcerptLibraryService(f.app);
  f.files.get(f.root+"/paper.md").text+="\nchanged English";
  await assert.rejects(f.service.createExcerpt(s),/双语资料版本已变化/);await assert.rejects(f.service.createAnnotation(s,{}),/双语资料版本已变化/);await assert.rejects(f.service.getRecordExplanationContext(r),/双语资料版本已变化/);await assert.rejects(library.openSource(r),/双语资料版本已变化/);
  const snapshot=await library.load(r);assert.match(await library.status(snapshot),/变化/);const edited=await library.saveNote(snapshot,"edited historical note");assert.equal(edited.record.manualText,"edited historical note");assert.equal(edited.record.selectedText,r.selectedText);
 });
 await check("translation and metadata revisions independently invalidate old receipt",async f=>{
  const s=selection(f);f.files.get(f.root+"/paper.zh-CN.md").text+="\n";await assert.rejects(f.service.createExcerpt(s),/变化/);f.files.get(f.root+"/paper.zh-CN.md").text=f.zh;f.files.get(f.root+"/translation.json").text+="\n";await assert.rejects(f.service.createExcerpt(s),/变化/);
 });
 await check("library keeps BOM offsets, language role and paired change in pending binding",async f=>{
  const r=await f.service.createExcerpt(selection(f,"en"));
  const io={read:async p=>f.files.get(p)?.text===undefined?null:Buffer.from(f.files.get(p).text),list:async dir=>{const entries=new Map();for(const p of f.files.keys()){if(!p.startsWith(dir+"/"))continue;const rest=p.slice(dir.length+1),name=rest.split("/")[0];entries.set(name,{name,directory:rest.includes("/")});}return [...entries.values()];}};
  const scan=()=>api.readPaperLibrary(io,{read:async()=>null,list:async()=>[]},{vaultRoot:path.resolve("memory"),parseYaml:text=>text.includes("title: Example")?{title:"English example"}:{}});
  const before=await scan(),object=before.papers.flatMap(p=>p.objects).find(o=>o.kind==="annotation"&&o.annotationPath===r.annotationPath);assert.ok(object);assert.equal(object.binding.state,"matched");assert.equal(before.papers.flatMap(p=>p.objects).find(o=>o.kind==="source"&&o.source.path===f.root+"/paper.md").title,"English example");
  f.files.get(f.root+"/paper.zh-CN.md").text+="\n";const after=await scan(),changed=after.papers.flatMap(p=>p.objects).find(o=>o.kind==="annotation"&&o.annotationPath===r.annotationPath);assert.equal(changed.binding.state,"changed");
 });
 await check("forged language/ranges/snapshots fail; legacy translated record stays unconfirmed",async f=>{
  const s=selection(f);for(const modify of [r=>r.language="en",r=>r.selection.start++,r=>r.english.text="invented text",r=>r.root="Clippings/other"]){const bad=structuredClone(s);modify(bad.bilingual);await assert.rejects(f.service.createExcerpt(bad),/凭据|变化/);}
  const legacy={...s};delete legacy.bilingual;await assert.rejects(f.service.createExcerpt(legacy),/未确认/);assert.equal(api.quoteLabel(legacy),"译文摘录（配对未确认）");
 });
 await check("curation preview and draft preserve language; formal retrieval masks all mixed material",async f=>{
  const r=await f.service.createExcerpt(selection(f),"own note"),paragraph=api.curationParagraphs(f.files.get("wiki/concepts/target.md").text).at(-1);
  const context=await api.prepareExcerptCuration(f.app,r,"wiki/concepts/target.md",paragraph.id,true);const text=api.excerptAddition(context);assert.match(text,/中文译文摘录/);assert.match(text,/英文对应段落/);assert.match(text,/个人备注/);assert.ok(!api.maskLearningBlocks(text).includes(r.selectedText));assert.ok(!api.maskLearningBlocks(text).includes(r.bilingual.english.text.trim()));
  const raw=f.files.get(r.annotationPath).text,material={kind:"excerpt",path:r.annotationPath,raw,digest:api.contentHash(raw),excerptId:r.id,includeNote:true};assert.match(api.draftMaterialText(material),/中文译文摘录/);assert.match(api.draftMaterialText(material),/英文对应段落/);
  f.files.get(f.root+"/translation.json").text+="\n";await assert.rejects(api.verifyExcerptCuration(f.app,context,context.target.hash),/变化/);
 });
 await check("source mutation at final save preflight leaves no partial annotation",async f=>{
  f.app.vault.createFolder=async()=>{f.files.get(f.root+"/paper.zh-CN.md").text+="\n";};await assert.rejects(f.service.createExcerpt(selection(f)),/变化/);assert.equal(f.writes.length,0);
 });
 await check("AI request identifies translation, actual English and model knowledge; cancellation stops late output",async f=>{
  const calls=[],profile={id:"mock",name:"Mock",model:"mock",timeoutSeconds:1,lastTest:{ok:true}};
  const plugin={settings:{annotationBackendId:"mock",annotationWebSearchEnabled:false,annotationMaxTokens:600},getProviderProfile:()=>profile,createLLMProvider:()=>({complete:async request=>{calls.push(request);return {text:"Model background (test)."};}})};
  const service=new api.AnnotationService(f.app,plugin),s=selection(f);s.context="UNPAIRED_NEIGHBOR says 999 independently confirmed metabolites.";await service.generateExplanation(s,()=>{});
  assert.equal(calls.length,1);assert.match(calls[0].messages[0].content,/模型一般知识/);assert.match(calls[0].messages[0].content,/不可当作作者英文原句/);assert.match(calls[0].messages[1].content,/中文译文摘录/);assert.ok(calls[0].messages[1].content.includes(s.bilingual.english.text));assert.equal(f.writes.length,0);
  assert.ok(!calls[0].messages[1].content.includes("UNPAIRED_NEIGHBOR"),"unverified neighboring translation is not paper evidence");assert.ok(calls[0].messages[1].content.includes(f.zh.slice(s.bilingual.block.start,s.bilingual.block.end)),"current translation block comes from verified bytes");
  const r=await service.createAnnotation(s,{aiText:"baseline"}),reopened=await service.getRecordExplanationContext(r);await service.generateExplanation(reopened,()=>{});assert.deepEqual(calls[1],calls[0],"new and reopened records share the same bounded evidence");
  await service.generateExplanation(selection(f,"en"),()=>{});assert.match(calls[2].messages[1].content,/英文来源摘录/);assert.ok(!calls[2].messages[0].content.includes("首段以‘译文对照：’"),"English selection does not receive Chinese-quote instructions");assert.ok(!calls[2].messages[1].content.includes("当前块译文"));
  f.files.get(f.root+"/paper.md").text+="\n";await assert.rejects(service.generateExplanation(s,()=>{}),/变化/);assert.equal(calls.length,3);
  f.files.get(f.root+"/paper.md").text=f.en;plugin.createLLMProvider=()=>({complete:async()=>new Promise(()=>{})});let cancel;
  const pending=service.generateExplanation(s,c=>{cancel=c;});for(let i=0;i<20&&!cancel;i++)await new Promise(r=>setTimeout(r,1));assert.ok(cancel);cancel();await assert.rejects(pending,/已取消/);
 });
 await check("native linked bilingual prose uses verified English while retaining raw translation anchors",async f=>{
  const en="# Results\n\nWe introduce [DeepMet](https://example.invalid/model), a chemical language model (Fig. [1a](https://example.invalid/figure)).\n",zh="# 结果\n\n我们介绍[DeepMet](https://example.invalid/model)，一种化学语言模型（图 [1a](https://example.invalid/figure)）。\n";
  const metadata=JSON.stringify({schemaVersion:1,sourceFile:"paper.md",translationFile:"paper.zh-CN.md",sourceVersion:{algorithm:"sha256",value:hash(en)},status:"needs-review",humanReview:"not-reviewed"});
  f.files.get(f.root+"/paper.md").text=en;f.files.get(f.root+"/paper.zh-CN.md").text=zh;f.files.get(f.root+"/translation.json").text=metadata;f.doc=api.createBilingualDocument(f.root+"/paper.md",Buffer.from(en),Buffer.from(zh),Buffer.from(metadata));
  const block=f.doc.files["zh-CN"].blocks[1],raw=zh.slice(block.start,block.end).trimEnd(),start=block.start,end=start+raw.length;
  const s={sourcePath:f.root+"/paper.zh-CN.md",selectedText:raw,sourceStart:start,sourceEnd:end,prefix:zh.slice(Math.max(0,start-80),start),suffix:zh.slice(end,end+80),section:"结果",context:"UNVERIFIED NEIGHBOR",isTableCell:false,anchorRect:{},sourceRevision:api.excerptRevision(zh),bilingual:api.bilingualReceipt(f.doc,"zh-CN",block,start,end)};
  const quote="We introduce DeepMet, a chemical language model (Fig. 1a).",requests=[],cli={generate:async request=>{requests.push(request);return{text:JSON.stringify(JSON.parse(request.user).candidates?{sentenceIds:[0],translationStatus:"possible-match"}:{claims:[{quote,meaning:"作者介绍 DeepMet 是一种化学语言模型。"}]}),requestedModel:"Qwen3.8-Flash",usage:{input_tokens:10,output_tokens:5},costUsd:0};}};
  const service=new api.AnnotationService(f.app,{settings:{annotationBackendId:"qoderclicn",annotationQoderModel:"Qwen3.8-Flash",annotationCliTimeoutSeconds:120}},cli),answer=await service.generateExplanation(s,()=>{});
  assert.ok(requests[0].user.includes(quote));assert.ok(!requests[0].user.includes("https://")&&!requests[0].user.includes("UNVERIFIED NEIGHBOR"));assert.ok(answer.text.startsWith("译文对照："));
  assert.ok(!JSON.parse(requests[1].user).candidates);assert.equal(JSON.parse(requests[1].user).evidence,quote);assert.ok(answer.cli.evidenceSelection);
  const record=await service.createAnnotation(s,{aiText:answer.text,aiCli:answer.cli});assert.equal(record.selectedText,raw);assert.equal(zh.slice(record.sourceAnchor.start,record.sourceAnchor.end),raw);assert.deepEqual(record.bilingual,s.bilingual);assert.equal((await service.loadAnnotation(record.annotationPath,record.id)).aiText,answer.text);assert.deepEqual((await service.loadAnnotation(record.annotationPath,record.id)).aiCli,JSON.parse(JSON.stringify(answer.cli)));
  await service.generateExplanation(await service.getRecordExplanationContext(record),()=>{});const withoutTimeout=r=>{const{timeoutMs,...rest}=r;assert.ok(timeoutMs>0&&timeoutMs<=120000);return rest;};assert.deepEqual(requests.slice(2).map(withoutTimeout),requests.slice(0,2).map(withoutTimeout),"reopened raw receipts reconstruct identical two-step evidence");
  f.files.get(f.root+"/paper.md").text+="changed";await assert.rejects(service.generateExplanation(s,()=>{}),/变化/);assert.equal(requests.length,4);
 });
 await check("oversized translated current block stops before any model call",async f=>{
  const text=f.zh.replaceAll("重复的所选文字。","前".repeat(17000)+"重复的所选文字。");f.files.get(f.root+"/paper.zh-CN.md").text=text;f.doc=api.createBilingualDocument(f.root+"/paper.md",Buffer.from(f.en),Buffer.from(text),Buffer.from(f.metadata));
  let calls=0;const profile={id:"mock",name:"Mock",model:"mock",timeoutSeconds:1,lastTest:{ok:true}},plugin={settings:{annotationBackendId:"mock",annotationWebSearchEnabled:false,annotationMaxTokens:600},getProviderProfile:()=>profile,createLLMProvider:()=>({complete:async()=>{calls++;return {text:"must not run"};}})};
  await assert.rejects(new api.AnnotationService(f.app,plugin).generateExplanation(selection(f),()=>{}),/当前段落超过请求上限/);assert.equal(calls,0);assert.equal(f.writes.length,0);
 });
 await check("uncertain candidate, cancellation, expired budget and changed source stop before explanation",async f=>{
  const settings={annotationBackendId:"qoderclicn",annotationQoderModel:"Qwen3.8-Flash",annotationCliTimeoutSeconds:120};
  for(const mode of ["uncertain","cancel","timeout","source-change"]){
   let calls=0,cancel;const originalNow=Date.now,base=Date.now();let clock=base;
   const cli={generate:async(request,adapter,register)=>{calls++;register(()=>{});if(mode==="cancel")cancel();if(mode==="timeout")clock=base+120001;if(mode==="source-change")f.files.get(f.root+"/paper.md").text+="changed";return{text:JSON.stringify({sentenceIds:mode==="uncertain"?[]:[0],translationStatus:mode==="uncertain"?"uncertain":"possible-match"}),requestedModel:"Qwen3.8-Flash"};}};
   if(mode==="timeout")Date.now=()=>clock;
   try{await assert.rejects(new api.AnnotationService(f.app,{settings},cli).generateExplanation(selection(f),stop=>{cancel=stop;}),mode==="uncertain"?/依据不足/:mode==="cancel"?/取消/:mode==="timeout"?/超时/:/变化/);assert.equal(calls,1,"no second model call after "+mode);assert.equal(f.writes.length,0);}finally{Date.now=originalNow;f.files.get(f.root+"/paper.md").text=f.en;}
  }
 });
 console.log(`Bilingual annotations: ${count} groups passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
