"use strict";
// Real services/writer with memory-only vault and journal. No filesystem cleanup or model/network calls.
const assert=require("node:assert/strict"),path=require("node:path"),{loadReading}=require("./reading-test-helpers");
class TFile{constructor(p){this.path=p;this.basename=path.posix.basename(p,".md");this.extension="md";this.stat={size:0};}}
const obsidian={TFile,MarkdownView:class{},Notice:class{},normalizePath:p=>p,parseYaml:text=>Object.fromEntries(text.split(/\r?\n/).filter(l=>l.includes(":")).map(l=>{const i=l.indexOf(":");return[l.slice(0,i),l.slice(i+1).trim().replace(/^"|"$/g,"")];}))},mocks={obsidian};
const {AnnotationService}=loadReading("annotations/annotation-service.ts",mocks),{excerptRevision}=loadReading("annotations/excerpt.ts"),{ExcerptLibraryService}=loadReading("annotations/excerpt-library.ts",mocks);
const {prepareExcerptCuration,excerptAddition}=loadReading("curation/excerpt.ts",mocks),{CurationService,validatedReview}=loadReading("curation/service.ts",mocks),{CurationWriter}=loadReading("curation/writer.ts",mocks),{curationParagraphs}=loadReading("curation/policy.ts",mocks);
async function fixture({eol="\n",source="Clippings/excerpt.md",target="wiki/concepts/example.md",metadata="title: Example",sourceMetadata="",quote="Repeated **sentence** with 2 mg and [[link]]."}={}){
 const body=[...(sourceMetadata?["---",sourceMetadata,"---"]:[]),"# Article","",quote,"","😀 Second: "+quote,""].join(eol),start=body.lastIndexOf(quote),original=["---",metadata,"---","# Example","","## Scope","Keep existing context.","","## Links","[[wiki/methods/existing]]",""].join(eol);
 const files=new Map(),writes=[],records=new Map();const put=(p,text)=>files.set(p,{file:new TFile(p),text});put(source,body);put(target,original);put("研究主题索引.md","# Index\n");put("文献索引.md","# Papers\n");put("wiki/log.md","# Log\n");
 const app={vault:{getFileByPath:p=>files.get(p)?.file||null,getAbstractFileByPath:p=>files.get(p)?.file||null,getMarkdownFiles:()=>[...files.values()].map(v=>v.file).filter(v=>v instanceof TFile),read:async f=>files.get(f.path).text,cachedRead:async f=>files.get(f.path).text,
 createFolder:async p=>files.set(p,{file:{path:p}}),create:async(p,text)=>{assert.ok(!files.has(p));put(p,text);writes.push(p);return files.get(p).file;},process:async(f,fn)=>{const v=files.get(f.path);v.text=fn(v.text);writes.push(f.path);}},metadataCache:{getFileCache:()=>({frontmatter:{}})}};
 const record=await new AnnotationService(app,{}).createExcerpt({sourcePath:source,selectedText:quote,sourceStart:start,sourceEnd:start+quote.length,prefix:body.slice(Math.max(0,start-80),start),suffix:body.slice(start+quote.length,start+quote.length+80),sourceRevision:excerptRevision(body),section:"",context:"",isTableCell:false,anchorRect:{}},"My inference: 999 mg.\n[click](https://example.invalid) <script>code</script>");writes.length=0;
 const workspace={ready:async()=>{},repository:{get:()=>{throw Error("fictitious reading session");}},document:()=>{throw Error("fictitious reading document");}},store={list:async kind=>[...records.keys()].filter(k=>k.startsWith(kind+":" )).map(k=>k.split(":")[1]),read:async(kind,id)=>structuredClone(records.get(kind+":"+id)),write:async(kind,value)=>records.set(kind+":"+value.id,structuredClone(value))};
 const service=new CurationService(app,workspace,store,()=>{throw Error("model must not run");}),writer=new CurationWriter(service),paragraph=curationParagraphs(original)[0];
 const prepare=async(include=false)=>prepareExcerptCuration(app,record,target,paragraph.id,include),preview=async(include=false)=>{const review=await service.saveExcerpt(await prepare(include));return{review,plan:await writer.preview(review.id,["s-0"])};};
 return{files,app,writes,records,record,source,target,original,body,service,writer,workspace,store,paragraph,prepare,preview,put};
}

module.exports={fixture,mocks,TFile};
