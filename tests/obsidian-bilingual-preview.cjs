/* Native component QA through Obsidian's own plugin loader. No model calls, source
 * edits, plugin deployment or file deletion. Bundle under Node, not Electron. */
module.exports = async function bilingualPreview(app, { apiPath, sourcePath, cssPath, keepOpen = false }) {
 const assert = require("node:assert/strict"), fs = require("node:fs");
 const plugin = app.plugins.plugins["research-agent-reader"];
 assert.equal(app.vault.getName(), "paper-test"); assert.ok(plugin);
 assert.ok(!plugin.getTaskRuns().some(r => r.status === "running"));
 assert.ok(!document.querySelector(".agent-annotation-popover, textarea[data-dirty='true']"));
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
  const footnote=host.querySelector('.agent-bilingual-pane[data-bilingual-language="zh-CN"] a[href^="#bilingual-zh-CN-"]');
  const beforeEn=renderer.panes.get("en").scroller.scrollTop;
  check(!!footnote,"Chinese footnote has a pane-scoped target"); footnote.click(); check(renderer.panes.get("zh-CN").scroller.scrollTop>0 && renderer.panes.get("en").scroller.scrollTop===beforeEn,"Chinese footnote navigation changes only its own scroller");
  const split=host.querySelector('[role="separator"]'); split.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true})); check(ratio===0.48,"keyboard splitter updates ratio");
  const image=renderer.panes.get("en").article.querySelector("img"); image.click(); check(!!document.querySelector(".modal-container .modal img"),"inline image opens native enlargement"); controller.abort();
  host.querySelector(".agent-bilingual-toolbar button").click(); // aborted listener must not invoke the callback
  check(!ordinary,"aborted view has no late event callback");
  const result={ok:true,checks,version:plugin.manifest.version,panes:[...renderer.panes].map(([language,p])=>({language,anchors:p.anchors.size,images:p.article.querySelectorAll("img").length})),modelCalls:0,sourceWrites:0};
  if(keepOpen)globalThis.__bilingualNativePreview={cleanup,leaf,renderer,result};
  return result;
 } finally { if(!keepOpen || !globalThis.__bilingualNativePreview)await cleanup(); }
};
