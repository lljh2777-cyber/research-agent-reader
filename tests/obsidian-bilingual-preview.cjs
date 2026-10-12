/* Native component QA through Obsidian's own plugin loader. No model calls, source
 * edits, plugin deployment or file deletion. Bundle under Node, not Electron. */
module.exports = async function bilingualPreview(app, { apiPath, sourcePath, cssPath, keepOpen = false, exerciseSync = false }) {
 const assert = require("node:assert/strict"), fs = require("node:fs");
 const plugin = app.plugins.plugins["research-agent-reader"];
 assert.equal(app.vault.getName(), "paper-test"); assert.ok(plugin);
 assert.ok(!plugin.getTaskRuns().some(r => r.status === "running"));
 assert.ok(!document.querySelector(".agent-annotation-popover, textarea[data-dirty='true']"));
  const window=require("electron").remote.getCurrentWindow(); if(window.isMinimized())window.restore();window.show();window.focus();
 const id = "research-bilingual-native-preview", virtual = ".obsidian/plugins/" + id;
 assert.ok(!app.plugins.manifests[id] && !app.plugins.plugins[id]);
 const read = app.vault.adapter.read, active = app.workspace.activeLeaf, globalApi = globalThis.__bilingualNativeApi;
 let leaf, renderer, style, controller = new AbortController();
 const cleanup = async () => { controller.abort(); renderer?.unload(); leaf?.detach(); style?.remove(); await app.plugins.unloadPlugin(id); delete app.plugins.manifests[id]; app.vault.adapter.read = read; globalThis.__bilingualNativeApi = globalApi; if (active) await app.workspace.revealLeaf(active); };
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
  renderer = new api.BilingualReader({app,host,document:doc,signal:controller.signal,ordinary:()=>{ordinary=true;},onRatio:value=>{ratio=value;}}); renderer.load(); await renderer.render();
  const checks = [], check = (ok,label)=>{assert.ok(ok,label);checks.push(label);};
  check(renderer.panes.size === 2,"two native Markdown panes rendered");
  for (const language of ["en","zh-CN"]) {
   const pane=renderer.panes.get(language); check(pane.article.textContent.length>10000,language+" complete nonblank body");
   const images=[...pane.article.querySelectorAll("img")]; for(let i=0;i<100 && images.some(img=>!img.complete);i++) await new Promise(r=>setTimeout(r,50));
   check(images.length===5 && images.every(img=>img.naturalWidth>0),language+" five local images rendered inline");
   check(pane.scroller.clientHeight>100 && pane.scroller.scrollHeight>pane.scroller.clientHeight,language+" independent scroller has usable height");
   check(pane.anchors.size===doc.files[language].blocks.length,language+" every sample block including footnotes has an anchor");
   check(!pane.article.querySelector("[data-agent-annotation-source]"),language+" ordinary annotation outlet withheld until role adaptation");
  }
  const ids=[...host.querySelectorAll("[id]")].map(e=>e.id); check(new Set(ids).size===ids.length,"cross-language DOM identifiers unique");
  const linked=host.querySelector('[aria-label="双栏联动"]'); if(linked){linked.checked=false;linked.dispatchEvent(new Event("change"));}
  const footnote=host.querySelector('.agent-bilingual-pane[data-bilingual-language="zh-CN"] a[href^="#bilingual-zh-CN-"]');
  const beforeEn=renderer.panes.get("en").scroller.scrollTop;
  check(!!footnote,"Chinese footnote has a pane-scoped target"); footnote.click(); check(renderer.panes.get("zh-CN").scroller.scrollTop>0 && renderer.panes.get("en").scroller.scrollTop===beforeEn,"Chinese footnote navigation changes only its own scroller");
  const split=host.querySelector('[role="separator"]'); split.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true})); check(ratio===0.48,"keyboard splitter updates ratio");
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
  const result={ok:true,checks,version:plugin.manifest.version,panes:[...renderer.panes].map(([language,p])=>({language,anchors:p.anchors.size,images:p.article.querySelectorAll("img").length})),modelCalls:0,originalSourceWrites:0,fixtureMetadataWrites:exerciseSync?2:0};
  if(keepOpen)globalThis.__bilingualNativePreview={cleanup,leaf,renderer,result};
  return result;
 } finally { if(!keepOpen || !globalThis.__bilingualNativePreview)await cleanup(); }
};
