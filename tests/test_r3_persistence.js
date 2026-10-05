"use strict";
// Five fresh Node processes, retained isolated disk files, zero network/model/deletion.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {loadReading}=require('./reading-test-helpers'),{environment,mocks}=require('./r3-persistence-fixture.cjs');
async function stage(name,root){
 const f=environment(root),statePath=path.join(root,'state.json'),state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{pids:[]};state.pids.push(process.pid);
 const {prepareAnswerExcerpt}=loadReading('learning/answer-excerpts.ts',mocks),{prepareAnswerExcerptCuration}=loadReading('curation/answer-excerpt.ts',mocks),{curationParagraphs}=loadReading('curation/policy.ts',mocks),{readDraftMaterial,newKnowledgeDraft}=loadReading('curation/draft.ts',mocks);
 if(name==='seed'){
  const sample=require('./answer-excerpt-fixtures.cjs').readingFixture();await f.io.mkdir('reading-sessions');await f.io.create('reading-sessions/'+sample.session.id+'.json',Buffer.from(JSON.stringify(sample.session)));
  let answer=(await f.answers.save(prepareAnswerExcerpt(sample.answer(),0,5,'Independent memo'))).file;answer=await f.answers.saveHumanRevision(answer,'Current human A');answer=await f.answers.saveHumanRevision(answer,'Historical human B');answer=await f.answers.restoreHumanRevision(answer,1);state.answer=answer;
  state.source='Clippings/r3.md';state.body='# Source\n\nRepeated source sentence.\n\nRepeated source sentence.\n';state.target='wiki/concepts/r3-existing.md';state.original='# Existing knowledge\n\nKeep existing prose.\n';f.put(state.source,state.body);f.put(state.target,state.original);f.put('研究主题索引.md','# Index\n');f.put('wiki/log.md','# Log\n');
  const text='Repeated source sentence.',start=state.body.lastIndexOf(text),{excerptRevision}=loadReading('annotations/excerpt.ts'),{AnnotationService}=loadReading('annotations/annotation-service.ts',mocks);
  state.selection={sourcePath:state.source,selectedText:text,sourceStart:start,sourceEnd:start+text.length,prefix:state.body.slice(Math.max(0,start-80),start),suffix:state.body.slice(start+text.length,start+text.length+80),sourceRevision:excerptRevision(state.body),section:'',context:'',isTableCell:false,anchorRect:{}};
  state.excerpt=await new AnnotationService(f.app,{}).createExcerpt(state.selection,'Original memo');await f.excerpts.setCompleted(await f.excerpts.load(state.excerpt),true);
 }else if(name==='curation-failure'){
  const old=await f.excerpts.load(state.excerpt);assert.equal(old.record.archiveStatus,'completed');const edited=await f.excerpts.saveNote(old,'New memo after completion');assert.equal(edited.record.archiveStatus,'none');assert.deepEqual(edited.record.sourceAnchor,old.record.sourceAnchor);
  const {AnnotationService}=loadReading('annotations/annotation-service.ts',mocks),duplicate=await new AnnotationService(f.app,{}).createExcerpt(state.selection,'must not overwrite');assert.equal(duplicate.id,state.excerpt.id);assert.equal((await f.excerpts.load(state.excerpt)).record.manualText,'New memo after completion');assert.equal(f.read(state.source),state.body);
  const answer=await f.answers.load(state.answer.path);assert.deepEqual(answer,state.answer);assert.equal(answer.record.humanHistory.length,4);
  const material=await readDraftMaterial(f.app,{kind:'answer',path:answer.path,roles:['human','note']}),d={...newKnowledgeDraft(material),title:'R3 persisted concept',body:'User interpretation awaiting review'};state.draft=await f.drafts.save(d,null);
  const review=await f.curation.saveAnswerExcerpt(await prepareAnswerExcerptCuration(f.app,f.answers,answer.path,state.target,curationParagraphs(state.original)[0].id,['human']));const plan=await f.writer.preview(review.id,['s-0']);state.revision=plan.id;
  const process=f.app.vault.process;f.app.vault.process=async(file,fn)=>{if(file.path==='研究主题索引.md')throw Error('injected index failure');return process(file,fn);};await assert.rejects(f.writer.apply(plan),/injected index failure/);assert.equal(f.curation.revisions.get(plan.id).state,'recovery');assert.match(f.read(state.target),/Current human A/);assert.equal(f.read('研究主题索引.md'),'# Index\n');
 }else if(name==='curation-recover-page-failure'){
  await f.curation.ready();assert.equal(f.curation.revisions.get(state.revision).state,'recovery');await f.writer.resume(state.revision);assert.equal(f.curation.revisions.get(state.revision).state,'applied');assert.equal(f.read(state.target).split('Current human A').length-1,1);
  await f.writer.applyUndo(await f.writer.previewUndo(state.revision));assert.equal(f.read(state.target),state.original);
  const oldDraft=await f.drafts.read(state.draft.draft.id);assert.equal(oldDraft.current.digest,state.draft.digest);await f.answers.saveHumanRevision(await f.answers.load(state.answer.path),'Later human C');
  const plan=await f.pages.preview(state.draft.draft.id,state.draft.digest,'r3-persisted-page');state.page=plan.path;state.pagePlan=plan;
  const write=f.pageFiles.write.bind(f.pageFiles);f.pageFiles.write=async(w,s)=>{if(w.role==='index')throw Error('injected page index failure');return write(w,s);};await assert.rejects(f.pages.apply(plan),/injected page index failure/);assert.equal((await f.pages.record(state.draft.draft.id)).complete,false);assert.equal(f.read(state.page),plan.writes[0].after);
 }else if(name==='page-recover'){
  const record=await f.pages.record(state.draft.draft.id);assert.equal(record.complete,false);await f.pages.apply(record.plan);assert.equal((await f.pages.record(state.draft.draft.id)).complete,true);for(const w of record.plan.writes)assert.equal(f.read(w.path),w.after);
  const {chunkDocument,contentHash}=loadReading('retrieval/chunks.ts'),text=f.read(state.page);assert.match(text,/Current human A/);assert.doesNotMatch(text,/Historical human B|Later human C/);const chunks=chunkDocument({path:state.page,title:'R3',text,hash:contentHash(text),origins:[]});assert.ok(chunks.every(c=>!c.text.includes('Current human A')&&!c.text.includes('Independent memo')));
 }else if(name==='verify'){
  assert.equal((await f.pages.record(state.draft.draft.id)).complete,true);assert.equal((await f.drafts.read(state.draft.draft.id)).current.digest,state.draft.digest);assert.equal((await f.answers.load(state.answer.path)).record.humanHistory.length,5);assert.equal((await f.excerpts.load(state.excerpt)).record.archiveStatus,'none');assert.equal(f.read(state.source),state.body);assert.equal(f.read(state.target),state.original);assert.equal(f.read(state.page),state.pagePlan.writes[0].after);
  await f.curation.ready();assert.ok([...f.curation.revisions.values()].some(r=>r.undoOf===state.revision&&r.state==='applied'));assert.equal(new Set(state.pids).size,5);
 }else assert.fail(name);
 fs.writeFileSync(statePath,JSON.stringify(state,null,2));console.log('PASS R3 fresh process: '+name+' (PID '+process.pid+')');
}
if(process.argv[2])stage(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});
else{const root=fs.mkdtempSync(path.join(os.tmpdir(),'rar-r3-persistence-'));for(const name of ['seed','curation-failure','curation-recover-page-failure','page-recover','verify'])execFileSync(process.execPath,[__filename,name,root],{stdio:'inherit',windowsHide:true});console.log('R3_PERSISTENCE_OK (5 fresh processes; retained fixture: '+root+')');}
