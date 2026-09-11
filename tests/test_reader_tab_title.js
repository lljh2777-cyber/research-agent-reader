const assert=require('node:assert/strict'),{loadReading}=require('./reading-test-helpers');
const api=loadReading('views/mineru-reader.ts',{obsidian:{ItemView:class{},Component:class{},TFile:class{}}});
const View=Object.values(api).find(v=>typeof v==='function'&&v.prototype?.getDisplayText);
assert.ok(View);
const make=()=>{const v=Object.create(View.prototype),titles=[];Object.assign(v,{opened:true,loadGeneration:0,readerState:{articlePath:'new.md',pdfPage:1,markdownPage:1},readerPackage:{title:'Old title'},leaf:{updateHeader:()=>titles.push(v.getDisplayText())},pdfRenderer:{destroy:async()=>{},numPages:0},revokeVerifiedResourceUrls:()=>{},renderLoading:()=>{},renderWorkspace:async()=>{},renderError:()=>{},syncStateForMode:()=>{},requestStateSave:()=>{}});return {v,titles};};
(async()=>{
 const {v,titles}=make();v.loader={load:async()=>({title:'New title',sourceKind:'markdown',visuals:[]})};await v.loadAndRender();assert.deepEqual(titles,['文献阅读器','New title']);
 for(const late of ['stale','closed']){const {v,titles}=make();let release;v.loader={load:()=>new Promise(r=>release=r)};const pending=v.loadAndRender();await Promise.resolve();if(late==='stale')v.loadGeneration++;else v.opened=false;release({title:'Late title'});await pending;assert.deepEqual(titles,['文献阅读器']);}
 const failed=make();failed.v.loader={load:async()=>{throw Error('missing');}};await failed.v.loadAndRender();assert.ok(failed.titles.every(t=>t==='文献阅读器'));
 const renderFailed=make();renderFailed.v.loader={load:async()=>({title:'Loaded',sourceKind:'markdown',visuals:[]})};renderFailed.v.renderWorkspace=async()=>{throw Error('render');};await renderFailed.v.loadAndRender();assert.equal(renderFailed.titles.at(-1),'文献阅读器');
 console.log('READER_TAB_TITLE_OK: switch, loading, failed render, stale and closed responses');
})().catch(e=>{console.error(e);process.exitCode=1;});
