/* Native component QA through Obsidian's own plugin loader. No model calls, source
 * edits, plugin deployment or file deletion. Bundle under Node, not Electron. */
module.exports = async function bilingualPreview(app, { apiPath, sourcePath, cssPath, keepOpen = false, exerciseSync = false, exerciseAnnotations = false }) {
 const assert = require("node:assert/strict"), fs = require("node:fs");
 const plugin = app.plugins.plugins["research-agent-reader"];
 assert.equal(app.vault.getName(), "paper-test"); assert.ok(plugin);
 assert.ok(!plugin.getTaskRuns().some(r => r.status === "running"));
 assert.ok(!document.querySelector(".agent-annotation-popover, textarea[data-dirty='true']"));
  const nativeWindow=require("electron").remote.getCurrentWindow(); if(nativeWindow.isMinimized())nativeWindow.restore();nativeWindow.show();nativeWindow.focus();
 const id = "research-bilingual-native-preview", virtual = ".obsidian/plugins/" + id;
 assert.ok(!app.plugins.manifests[id] && !app.plugins.plugins[id]);
 const read = app.vault.adapter.read, active = app.workspace.activeLeaf, globalApi = globalThis.__bilingualNativeApi;
 let leaf, renderer, style, popover, stage="load", controller = new AbortController(); const originalService=plugin.annotationService;
 const cleanup = async () => { popover?.close(); plugin.annotationService=originalService; controller.abort(); renderer?.unload(); leaf?.detach(); style?.remove(); await app.plugins.unloadPlugin(id); delete app.plugins.manifests[id]; app.vault.adapter.read = read; globalThis.__bilingualNativeApi = globalApi; if (active) await app.workspace.revealLeaf(active); };
 try {
  const bundle = fs.readFileSync(apiPath, "utf8");
  app.plugins.manifests[id] = { id, name: "Bilingual native preview QA", version: "0.0.0", minAppVersion: "1.11.4", author: "QA", description: "Ephemeral native component QA", dir: virtual, isDesktopOnly: true };
  app.vault.adapter.read = function(path) { if (path === virtual + "/main.js") return Promise.resolve(bundle + '\nconst qaApi=module.exports; module.exports=class extends require("obsidian").Plugin { onload(){globalThis.__bilingualNativeApi=qaApi;} };'); if (path === virtual + "/styles.css") return Promise.resolve(""); return read.apply(this, arguments); };
  await app.plugins.loadPlugin(id); app.vault.adapter.read = read;
  const api = globalThis.__bilingualNativeApi; assert.ok(api?.BilingualReader);
  const doc = await api.loadBilingualDocument(new api.FileSourceStorage(app.vault.adapter.getBasePath()), sourcePath); assert.ok(doc.syncAvailable);
  leaf = app.workspace.getLeaf("tab"); await leaf.setViewState({type:"agent-dashboard-mineru-reader",active:true,state:{}}); await app.workspace.revealLeaf(leaf);
  leaf.view.contentEl.empty(); const host = leaf.view.contentEl.createDiv({cls:"agent-dashboard-mineru-reader-shell"});
  style = document.head.createEl("style"); style.textContent = fs.readFileSync(cssPath, "utf8");
  let ordinary = false, ratio;
  const service=new api.AnnotationService(app,plugin);plugin.annotationService=service;
  const annotate=async()=>{const selection=await service.captureSelection();popover?.close();popover=new api.AnnotationPopover({app,service,selection,anchorRect:selection.anchorRect,onArchive:async()=>{throw Error("QA must not archive");}});popover.open();};
  renderer = new api.BilingualReader({app,host,document:doc,signal:controller.signal,annotate,ordinary:()=>{ordinary=true;},onRatio:value=>{ratio=value;}}); renderer.load(); await renderer.render();
  const checks = [], check = (ok,label)=>{assert.ok(ok,label);checks.push(label);};
  check(renderer.panes.size === 2,"two native Markdown panes rendered");
  for (const language of ["en","zh-CN"]) {
   const pane=renderer.panes.get(language); check(pane.article.textContent.length>10000,language+" complete nonblank body");
   const images=[...pane.article.querySelectorAll("img")]; for(let i=0;i<100 && images.some(img=>!img.complete);i++) await new Promise(r=>setTimeout(r,50));
   check(images.length===5 && images.every(img=>img.naturalWidth>0),language+" five local images rendered inline");
   check(pane.scroller.clientHeight>100 && pane.scroller.scrollHeight>pane.scroller.clientHeight,language+" independent scroller has usable height");
   check(pane.anchors.size===doc.files[language].blocks.length,language+" every sample block including footnotes has an anchor");
   check(pane.article.dataset.agentAnnotationSource===doc.files[language].path && !pane.article.querySelector("[data-agent-annotation-source]"),language+" annotations bind raw source rather than transformed renderer offsets");
  }
  const ids=[...host.querySelectorAll("[id]")].map(e=>e.id); check(new Set(ids).size===ids.length,"cross-language DOM identifiers unique");
  const linked=host.querySelector('[aria-label="双栏联动"]'); if(linked){linked.checked=false;linked.dispatchEvent(new Event("change"));}
  const footnote=host.querySelector('.agent-bilingual-pane[data-bilingual-language="zh-CN"] a[href^="#bilingual-zh-CN-"]');
  const beforeEn=renderer.panes.get("en").scroller.scrollTop;
  check(!!footnote,"Chinese footnote has a pane-scoped target"); footnote.click(); check(renderer.panes.get("zh-CN").scroller.scrollTop>0 && renderer.panes.get("en").scroller.scrollTop===beforeEn,"Chinese footnote navigation changes only its own scroller");
  const split=host.querySelector('[role="separator"]'); split.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true})); check(ratio===0.48,"keyboard splitter updates ratio");
  const saved=[];
  if(exerciseAnnotations){
   const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,40));}throw Error("Native annotation action timed out");};
   for(const language of ["en","zh-CN"]){
    stage=language+" selection";
    const pane=renderer.panes.get(language),paragraph=[...pane.article.querySelectorAll("p")].find(p=>renderer.blockForElement(language,p)?.kind==="paragraph" && p.textContent.length>70);
    assert.ok(paragraph);const walker=document.createTreeWalker(paragraph,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode()))if(!node.parentElement.closest("a,code") && node.textContent.trim().length>30 && !/[\r\n|\[\]]/.test(node.textContent.trim().slice(0,24)))break;
    assert.ok(node);const start=node.textContent.length-node.textContent.trimStart().length,range=document.createRange();range.setStart(node,start);range.setEnd(node,start+(language==="en"?24:16));window.getSelection().removeAllRanges();window.getSelection().addRange(range);
    assert.ok(window.getSelection().toString().trim(),JSON.stringify({range:range.toString(),connected:node.isConnected,count:window.getSelection().rangeCount,styles:[paragraph,pane.article,pane.scroller,host].map(e=>({cls:e.className,select:getComputedStyle(e).userSelect,display:getComputedStyle(e).display})),active:document.activeElement?.outerHTML?.slice(0,80)}));
    const selection=await service.captureSelection();check(selection.sourcePath===doc.files[language].path && doc.files[language].text.slice(selection.sourceStart,selection.sourceEnd)===range.toString() && selection.bilingual.language===language,language+" rendered selection binds exact raw offsets and language");stage=language+" popup";
    host.querySelector('[data-bilingual-annotate="'+language+'"]').click();await wait(()=>document.querySelector(".agent-annotation-popover"));
    const popup=document.querySelector(".agent-annotation-popover");check(popup.textContent.includes(language==="en"?"英文来源摘录":"中文译文摘录"),language+" pane button opens role-aware annotation popup");
    [...popup.querySelectorAll("button")].find(b=>b.textContent.includes("保存摘录")).click();popup.querySelector("textarea").value="Native bilingual QA: "+language;popup.querySelector("textarea").dispatchEvent(new Event("input"));
    const confirm=[...popup.querySelectorAll("button")].find(b=>b.textContent==="确认保存摘录");await confirm.onclick();check(popup.textContent.includes("已保存") || popup.textContent.includes("个人备注"),language+" popup saves detached excerpt");
    const record=await service.createExcerpt(selection,"must preserve native note");check(record.manualText==="Native bilingual QA: "+language && !!record.bilingual.english,language+" repeat save preserves note and actual English paragraph");saved.push(record);popover.close();popover=undefined;
    const library=new api.ExcerptLibraryService(app,undefined,async record=>renderer.reveal(record));await library.openSource(record);check(window.getSelection().toString()===record.selectedText && renderer.state.active===language,language+" excerpt return selects exact text in saved language");
   }
   check(saved[0].id!==saved[1].id,"English and Chinese excerpts remain separate records");
  }
  if(exerciseSync){
   const frames=async()=>{for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));};
   await frames();
   const scroll=(language,id)=>{const p=renderer.panes.get(language);p.scroller.dispatchEvent(new WheelEvent("wheel",{bubbles:true}));p.scroller.scrollTop+=p.anchors.get(id).getBoundingClientRect().top-p.scroller.getBoundingClientRect().top+25;};
   const aligned=()=>{const s=renderer.snapshot();return s.positions.en.blockId===s.positions["zh-CN"].blockId && Math.abs(s.positions.en.progress-s.positions["zh-CN"].progress)<0.04;};
   check(linked && !linked.checked,"link switch can be disabled");
   const oldZh=renderer.panes.get("zh-CN").scroller.scrollTop;scroll("en","b-10");await frames();check(renderer.panes.get("zh-CN").scroller.scrollTop===oldZh,"unlinked scrolling leaves other pane alone");
   const before=renderer.panes.get("en").scroller.scrollTop;host.querySelector('[data-bilingual-sync="en"]').click();await frames();
   check(aligned() && renderer.panes.get("en").scroller.scrollTop===before && !linked.checked,"English single sync only moves Chinese and leaves switch off");
   scroll("zh-CN","b-18");await frames();const beforeZh=renderer.panes.get("zh-CN").scroller.scrollTop;host.querySelector('[data-bilingual-sync="zh-CN"]').click();await frames();
   check(aligned() && renderer.panes.get("zh-CN").scroller.scrollTop===beforeZh && !linked.checked,"Chinese single sync only moves English and leaves switch off");
   linked.checked=true;linked.dispatchEvent(new Event("change"));scroll("en","b-30");await frames();check(aligned(),"linked English user scroll drives Chinese");
   scroll("zh-CN","b-26");await frames();check(aligned(),"linked Chinese user scroll drives English");
   const stable=[...renderer.panes].map(([,p])=>p.scroller.scrollTop);await frames();check(JSON.stringify(stable)===JSON.stringify([...renderer.panes].map(([,p])=>p.scroller.scrollTop)),"programmatic scrolling has no feedback loop");
   const state=renderer.snapshot();controller.abort();renderer.unload();host.empty();controller=new AbortController();
   renderer=new api.BilingualReader({app,host,document:doc,signal:controller.signal,state,ratio:0.48,ordinary:()=>{ordinary=true;}});renderer.load();await renderer.render();await frames();
   const restored=renderer.snapshot();check(restored.linked===state.linked && restored.active===state.active && ["en","zh-CN"].every(l=>restored.positions[l].blockId===state.positions[l].blockId && Math.abs(restored.positions[l].progress-state.positions[l].progress)<0.04),"fresh native component restores both block positions and link state");
   const metadata=app.vault.getFileByPath(doc.metadataPath), originalMetadata=await app.vault.read(metadata), altered=originalMetadata+"\n";
   try{await app.vault.modify(metadata,altered);check(host.querySelector('[aria-label="双栏联动"]').disabled && [...host.querySelectorAll('[data-bilingual-sync]')].every(b=>b.disabled),"actual fixture metadata change suspends both sync controls");}
   finally{if(await app.vault.read(metadata)!==altered)throw Error("Fixture metadata changed independently; preserved for review");await app.vault.modify(metadata,originalMetadata);}
   check(await app.vault.read(metadata)===originalMetadata,"fixture metadata restored exactly after external-change simulation");
  }
  const image=renderer.panes.get("en").article.querySelector("img"); image.click(); check(!!document.querySelector(".modal-container .modal img"),"inline image opens native enlargement"); controller.abort();
  host.querySelector(".agent-bilingual-toolbar button").click(); // aborted listener must not invoke the callback
  check(!ordinary,"aborted view has no late event callback");
  const result={ok:true,checks,version:plugin.manifest.version,panes:[...renderer.panes].map(([language,p])=>({language,anchors:p.anchors.size,images:p.article.querySelectorAll("img").length})),excerpts:saved.map(r=>({id:r.id,path:r.annotationPath,language:r.bilingual.language})),modelCalls:0,originalSourceWrites:0,fixtureMetadataWrites:exerciseSync?2:0};
  if(keepOpen)globalThis.__bilingualNativePreview={cleanup,leaf,renderer,result};
  return result;
 } catch(error) { throw new Error(stage+": "+error.message); } finally { if(!keepOpen || !globalThis.__bilingualNativePreview)await cleanup(); }
};
