/* Full installed-plugin QA in paper-test. Retains explicitly named test notes,
 * excerpts and journals. Never generates translations, calls models or deletes files. */
module.exports = async function bilingualCloseout(app, outputDirectory) {
 const assert=require("node:assert/strict"),fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
 const p=app.plugins.plugins["research-agent-reader"],root="Clippings/bilingual-native-20261012",target="wiki/concepts/Bilingual-native-20261012.md";
 assert.equal(app.vault.getName(),"paper-test");assert.equal(p.manifest.version,"0.84.0");assert.ok(!p.getTaskRuns().some(r=>r.status==="running"));assert.ok(!document.querySelector("textarea[data-dirty=true],.agent-annotation-popover,.modal-container"));
 const checks=[],records=[],check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
 const until=async predicate=>{for(let i=0;i<160;i++){if(predicate())return;await new Promise(r=>require("node:timers").setTimeout(r,40));}throw Error("QA timeout");};
 const frames=async()=>{for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));};
 const click=(host,label)=>{const b=[...host.querySelectorAll("button")].find(b=>b.textContent.trim()===label);assert.ok(b&&!b.disabled,"enabled button: "+label);b.click();};
 const close=()=>{p.annotationPopover?.close();p.excerptBrowser?.close();for(const modal of [...p.curationModals])modal.close();};
 const baseline={};for(const name of ["paper.md","paper.zh-CN.md","translation.json","images/image-1.webp","images/image-2.webp","images/image-3.webp","images/image-4.webp","images/image-5.webp"])baseline[name]=crypto.createHash("sha256").update(Buffer.from(await app.vault.adapter.readBinary(root+"/"+name))).digest("hex");
 const active=app.workspace.activeLeaf,win=require("electron").remote.getCurrentWindow();win.show();win.focus();
 let view,stage="entry",draftId,revisionId;
 try {
  for(const name of ["paper.md","paper.zh-CN.md"]){
   await p.activateMineruReaderView(root+"/"+name);view=app.workspace.activeLeaf.view;
   if(view.bilingualReader)click(view.contentEl,"返回单语图文");
   await until(()=>view.contentEl.querySelector('[data-bilingual-action="open"]'));click(view.contentEl,"双语对照");await until(()=>view.bilingualReader?.panes.size===2);await frames();
   check(view.bilingualReader.panes.get("en").article.dataset.agentAnnotationSource===root+"/paper.md"&&view.bilingualReader.panes.get("zh-CN").article.dataset.agentAnnotationSource===root+"/paper.zh-CN.md","real "+name+" entry opens English left and Chinese right");
  }
  for(const language of ["en","zh-CN"]){
   const reader=view.bilingualReader,host=view.contentEl;
   stage=language+" excerpt";const pane=reader.panes.get(language),paragraph=[...pane.article.querySelectorAll("p")].find(el=>reader.blockForElement(language,el)?.kind==="paragraph"&&el.textContent.length>70),walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);let node;
   while((node=walker.nextNode()))if(!node.parentElement.closest("a,code")&&node.textContent.trim().length>40)break;assert.ok(node);
   const from=node.textContent.length-node.textContent.trimStart().length+5,range=document.createRange();range.setStart(node,from);range.setEnd(node,from+(language==="en"?22:12));window.getSelection().removeAllRanges();window.getSelection().addRange(range);
   const selection=await p.annotationService.captureSelection();check(selection.bilingual.language===language&&selection.selectedText===range.toString(),language+" selection uses deployed provenance service");
   host.querySelector('[data-bilingual-annotate="'+language+'"]').click();await until(()=>!!p.annotationPopover);
   let popup=document.querySelector(".agent-annotation-popover");if([...popup.querySelectorAll("button")].some(b=>b.textContent.includes("保存摘录"))){click(popup,[...popup.querySelectorAll("button")].find(b=>b.textContent.includes("保存摘录")).textContent.trim());const input=popup.querySelector("textarea");input.value="Native closeout "+language;input.dispatchEvent(new Event("input"));await [...popup.querySelectorAll("button")].find(b=>b.textContent==="确认保存摘录").onclick();}
   const record=await p.annotationService.createExcerpt(selection,"must preserve existing note");check(record.manualText==="Native closeout "+language,language+" popup saves and repeat save preserves note");records.push(record);p.annotationPopover.close();
   p.openExcerptBrowser(record);await until(()=>p.excerptBrowser?.selected?.record.id===record.id);const browser=p.excerptBrowser;
   check(browser.contentEl.textContent.includes(language==="en"?"英文来源摘录":"中文译文摘录"),language+" excerpt details retain language and English context");
   click(browser.contentEl,"回到原文");await until(()=>!p.excerptBrowser);check(window.getSelection().toString()===record.selectedText&&view.bilingualReader.state.active===language,language+" list return reopens exact language and text");
  }
  stage="pending";const pending=await p.inspectPendingCenter(new AbortController().signal),row=pending.items.find(item=>item.target.kind==="excerpt"&&item.target.ref.id===records[1].id);check(row?.title.includes("中文译文摘录"),"pending center retains translation role");await p.openPendingItem(row,new AbortController().signal);await until(()=>p.excerptBrowser?.selected?.record.id===records[1].id);p.excerptBrowser.close();
  stage="curation";let file=app.vault.getFileByPath(target);if(!file){file=await app.vault.create(target,'---\ntitle: "Bilingual native QA"\ntype: concept\nstatus: unreviewed\n---\n# Bilingual native QA\n\nThis is a software QA fixture; scientific content remains unreviewed.\n');}
  const before=await app.vault.read(file);
  if(!before.includes(records[1].annotationPath)){
   p.openExcerptBrowser(records[1]);await until(()=>p.excerptBrowser?.selected?.record.id===records[1].id);click(p.excerptBrowser.contentEl,"补充到已有笔记");await until(()=>document.querySelector('[aria-label="摘录目标笔记"]'));
   const modal=[...p.curationModals].find(m=>m.contentEl.querySelector('[aria-label="摘录目标笔记"]')),select=modal.contentEl.querySelector('[aria-label="摘录目标笔记"]');select.value=target;select.dispatchEvent(new Event("change"));await until(()=>modal.contentEl.querySelector('[aria-label="摘录插入位置"]')?.options.length>1&&!modal.action);
   const paragraph=modal.contentEl.querySelector('[aria-label="摘录插入位置"]');paragraph.value=paragraph.options[1].value;paragraph.dispatchEvent(new Event("change"));for(const name of ["选择这条摘录","同时补充个人备注"]){const input=modal.contentEl.querySelector('[aria-label="'+name+'"]');input.checked=true;input.dispatchEvent(new Event("change"));}
   click(modal.contentEl,"预览选中补充");await until(()=>!!modal.preview&&!modal.action);check(await app.vault.read(file)===before&&modal.contentEl.textContent.includes("中文译文摘录")&&modal.contentEl.textContent.includes("英文对应段落"),"curation preview shows roles before any target write");
   revisionId=modal.preview.id;click(modal.contentEl,"确认补充到笔记");await until(()=>modal.contentEl.textContent.includes("摘录已补充")&&!modal.action);modal.close();
  }
  const saved=await app.vault.read(file);check(saved.includes("rar-learning-note")&&saved.includes("中文译文摘录")&&saved.includes("英文对应段落")&&saved.includes("个人备注"),"guarded curation stores translated quote, English and personal note in learning block");
	const curation=p.getCurationService();await curation.ready();revisionId=revisionId||[...curation.revisions.values()].find(r=>r.state==="applied"&&r.writes.some(w=>w.path===target))?.id;check(!!revisionId,"applied revision retained for exact retry without duplicate note text");
  const filename=path.join(outputDirectory,"native-retrieval.cjs"),Module=require("node:module"),loaded=new Module(filename);loaded.filename=filename;loaded.require=name=>name==="obsidian"?{}:require(name);loaded._compile(fs.readFileSync(filename,"utf8"),filename);
  const chunks=loaded.exports.chunkDocument({path:target,title:"QA",text:saved,hash:"qa"});check(chunks.every(c=>!c.text.includes(records[1].selectedText)&&!c.text.includes(records[1].bilingual.english.text.trim())),"real retrieval chunker excludes saved bilingual material");
  stage="draft";const existingDraft=(await p.getKnowledgeDrafts().summaries()).entries.find(e=>e.title==="双语阅读原生验收 20261012");if(existingDraft)p.openKnowledgeDrafts(existingDraft.id);else await p.openDraftFromExcerpt({kind:"excerpt",ref:records[1],includeNote:true});await until(()=>document.querySelector('[aria-label="知识页草稿标题"]'));
  const draft=[...p.curationModals].find(m=>m.contentEl.querySelector('[aria-label="知识页草稿标题"]'));check(draft.contentEl.textContent.includes("中文译文摘录"),"draft material header retains translated role");
  for(const [label,value] of [["知识页草稿标题","双语阅读原生验收 20261012"],["知识页草稿正文","这是测试库中的个人理解记录，论文结论与翻译质量未审阅。"]]){const el=draft.contentEl.querySelector('[aria-label="'+label+'"]');el.value=value;el.dispatchEvent(new Event("input"));}
  click(draft.contentEl,"预览草稿");check(draft.contentEl.textContent.includes("英文对应段落")&&draft.contentEl.textContent.includes("中文译文摘录"),"draft preview preserves both source roles");click(draft.contentEl,"确认保存草稿");await until(()=>draft.history?.current&&!draft.action);draftId=draft.draft.id;draft.close();
  const history=await p.getKnowledgeDrafts().read(draftId);check(history.current.draft.material.raw.includes('"language":"zh-CN"'),"saved draft keeps exact translation receipt");
  stage="restore preparation";view=app.workspace.getLeavesOfType("agent-dashboard-mineru-reader")[0].view;await app.workspace.revealLeaf(view.leaf);
  const current=view.bilingualReader,linked=view.contentEl.querySelector('[aria-label="双栏联动"]');linked.checked=false;linked.dispatchEvent(new Event("change"));
  const splitter=view.contentEl.querySelector('[role="separator"]');for(let i=0;i<3;i++)splitter.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));await frames();
  for(const [language,id] of [["en","b-30"],["zh-CN","b-45"]]){const pane=current.panes.get(language);pane.scroller.dispatchEvent(new WheelEvent("wheel",{bubbles:true}));pane.scroller.scrollTop+=pane.anchors.get(id).getBoundingClientRect().top-pane.scroller.getBoundingClientRect().top+20;await frames();}
  const state=view.getState();app.workspace.requestSaveLayout();await until(()=>{const json=JSON.parse(fs.readFileSync(path.join(app.vault.adapter.getBasePath(),".obsidian/workspace.json"),"utf8"));return JSON.stringify(json).includes('"blockId":"b-45"');});
  const expected={version:p.manifest.version,state,excerpts:records.map(r=>({id:r.id,annotationPath:r.annotationPath,language:r.bilingual.language,selectedText:r.selectedText,manualText:r.manualText})),draftId,revisionId,target,baseline,originalActiveLeaf:active?.id};
  fs.writeFileSync(path.join(outputDirectory,"restart-expected.json"),JSON.stringify(expected,null,2));
  for(const [name,digest] of Object.entries(baseline))check(crypto.createHash("sha256").update(Buffer.from(await app.vault.adapter.readBinary(root+"/"+name))).digest("hex")===digest,"paired fixture unchanged: "+name);
  const result={ok:true,version:p.manifest.version,checks,expectedFile:path.join(outputDirectory,"restart-expected.json"),target,draftId,revisionId,realModelCalls:0};fs.writeFileSync(path.join(outputDirectory,"step5-before-restart.json"),JSON.stringify(result,null,2));return result;
 } catch(error){throw Error(stage+": "+error.message);}finally{close();}
};
