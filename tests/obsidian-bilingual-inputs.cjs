/* Native input/layout checks against the installed plugin. Restores reader state. */
module.exports=async function bilingualInputs(app,out){
 const assert=require("node:assert/strict"),fs=require("node:fs"),p=app.plugins.plugins["research-agent-reader"],view=app.workspace.getLeavesOfType("agent-dashboard-mineru-reader")[0].view,state=structuredClone(view.getState()),checks=[];
 const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);},pause=()=>new Promise(r=>require("node:timers").setTimeout(r,200)),frames=async()=>{for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));};
 const win=require("electron").remote.getCurrentWindow();win.show();win.focus();const content=win.webContents,reader=view.bilingualReader,linked=view.contentEl.querySelector('[aria-label="双栏联动"]'),shell=view.contentEl.querySelector(".agent-bilingual-shell"),oldWidth=shell.style.width;
 const aligned=()=>{const s=reader.snapshot();return s.positions.en.blockId===s.positions["zh-CN"].blockId&&Math.abs(s.positions.en.progress-s.positions["zh-CN"].progress)<0.06;};
 try{
  linked.checked=true;linked.dispatchEvent(new Event("change"));await frames();window.getSelection().removeAllRanges();
  const en=reader.panes.get("en"),zh=reader.panes.get("zh-CN"),rect=en.scroller.getBoundingClientRect(),before=en.scroller.scrollTop;
  content.sendInputEvent({type:"mouseWheel",x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+80),deltaY:-150,deltaX:0});await pause();await frames();check(en.scroller.scrollTop>before&&reader.state.active==="en"&&aligned(),"native wheel scroll makes English lead and aligns Chinese");
  const beforeZh=zh.scroller.scrollTop;zh.scroller.focus();for(let i=0;i<3;i++){content.sendInputEvent({type:"keyDown",keyCode:"Down"});content.sendInputEvent({type:"keyUp",keyCode:"Down"});}await pause();await frames();check(zh.scroller.scrollTop>beforeZh&&reader.state.active==="zh-CN"&&aligned(),"native keyboard scroll makes Chinese lead and aligns English");
  shell.style.width="440px";await pause();await frames();for(const pane of reader.panes.values()){const section=pane.scroller.parentElement,bounds=section.getBoundingClientRect();check([...section.querySelectorAll(".agent-bilingual-pane-heading button")].every(b=>b.getBoundingClientRect().right<=bounds.right+1&&b.getBoundingClientRect().left>=bounds.left),pane.language+" buttons stay reachable at 440px reader width");}
  const beforeResize=reader.snapshot();shell.style.width=oldWidth;await pause();await frames();const afterResize=reader.snapshot();check(["en","zh-CN"].every(l=>afterResize.positions[l].blockId===beforeResize.positions[l].blockId),"width restoration preserves reading blocks");
  const result={ok:true,checks,realModelCalls:0};fs.writeFileSync(out,JSON.stringify(result,null,2));return result;
 }finally{shell.style.width=oldWidth;await view.setState(state,{});await frames();app.workspace.requestSaveLayout();}
};
