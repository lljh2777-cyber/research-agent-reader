// Explicit isolated filesystem fixtures are retained. No cleanup or deletion calls.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{loadReading}=require("./reading-test-helpers");
const {FileSourceStorage}=loadReading("sources/storage.ts");
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"rar-source-storage-")),io=new FileSourceStorage(root);
 assert.deepEqual(await io.list("papers"),[]);assert.equal(await io.read("papers/missing.pdf"),null);assert.deepEqual(await fs.readdir(root),[],"read-only operations do not create directories");
 for(const p of ["../outside","/outside","papers/../outside","papers/file:stream","papers\\file","papers/a.","papers/a "])await assert.rejects(io.read(p),/路径/);
 await io.mkdir("papers");await io.mkdir("papers/fixture",true);await assert.rejects(io.mkdir("papers/fixture",true));
 const value=Buffer.from("bounded original bytes");await io.create("papers/fixture/source.pdf",value);assert.deepEqual(Buffer.from(await io.read("papers/fixture/source.pdf")),value);
 await assert.rejects(io.create("papers/fixture/source.pdf",Buffer.from("replacement")));assert.deepEqual(Buffer.from(await io.read("papers/fixture/source.pdf")),value);await assert.rejects(io.read("papers/fixture/source.pdf",4),/大小/);
 const f=require("./source-intake-fixtures.cjs"),{SourceIntakeService}=loadReading("papers/source-intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts"),{validateSourcePackageFile}=loadReading("sources/reading-guard.ts");
 await io.mkdir("private");const fixture=f.source(),service=new SourceIntakeService({deviceId:f.sha("device"),catalog:new SourceCatalog(io),journal:new FileSourceStorage(path.join(root,"private")),index:f.index(),readSource:async()=>fixture,render:async()=>f.raster(),link:async()=>{}});
 try{const plan=await service.prepare(fixture.snapshot.jobId),display=await service.present(plan.requestId),saved=await service.save(plan.requestId,display.digest);assert.equal(saved.phase,"saved",saved.error);
  const sourcePath=path.join(root,"papers",plan.packageKey,"source.pdf");assert.equal((await validateSourcePackageFile(root,sourcePath)).citekey,plan.citekey);
  await io.create("papers/"+plan.packageKey+"/article.md",Buffer.from("user-added unregistered body"));await assert.rejects(validateSourcePackageFile(root,sourcePath),/未登记/);
  if(process.platform==="win32")await assert.rejects(validateSourcePackageFile(root,sourcePath.replace("papers","PAPERS")),/未登记|路径解析变化/);
  await assert.rejects(validateSourcePackageFile(root,path.join(root,"papers",plan.packageKey,"article.md")),/没有可用/);
 }finally{await service.dispose();}
 const {ReaderDocumentLoader}=loadReading("reader/document-loader.ts",{obsidian:{normalizePath:p=>p}});
 await assert.rejects(new ReaderDocumentLoader({vault:{adapter:{exists:async p=>p.endsWith("/_source")}}}).load("Papers/incomplete/body.md"),/尚无 Markdown/);
 const outside=await fs.mkdtemp(path.join(os.tmpdir(),"rar-source-link-target-"));let linkChecked=false;
 try{await fs.symlink(outside,path.join(root,"papers","linked"),process.platform==="win32"?"junction":"dir");linkChecked=true;}catch(e){if(!["EPERM","EACCES"].includes(e.code))throw e;}
 if(linkChecked){await assert.rejects(io.list("papers"),/链接/);await assert.rejects(io.read("papers/linked/secret"),/链接/);await assert.rejects(io.mkdir("papers/linked/nested"),/链接/);}
 console.log("SOURCE_STORAGE_OK: exclusive files/directories, bounded reads, path rejection, read-only discovery; link checks="+linkChecked+"; isolated fixtures retained");
})().catch(e=>{console.error(e.message);process.exitCode=1;});
