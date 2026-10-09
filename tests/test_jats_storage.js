"use strict";
// Isolated filesystem fixtures are retained; no cleanup or deletion.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{loadReading}=require("./reading-test-helpers"),f=require("./jats-fixtures.cjs");
const {FileSourceStorage}=loadReading("sources/storage.ts"),{JatsIntakeService}=loadReading("jats/intake.ts"),{SourceCatalog}=loadReading("papers/catalog.ts"),{loadJatsSource}=loadReading("sources/jats-package.ts");
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"rar-jats-storage-")),storage=new FileSourceStorage(root),catalog=new SourceCatalog(storage),source=f.fixture(),acquired=await source.acquire();await storage.mkdir("private");
 const deps={deviceId:f.sha("device"),catalog,journal:new FileSourceStorage(path.join(root,"private")),index:f.index(),read:async()=>acquired,link:async()=>{}},service=new JatsIntakeService(deps);
 try{const plan=await service.prepare(acquired.snapshot.jobId);assert.equal((await service.save(plan.requestId,plan.evidenceDigest,false)).phase,"saved");
  const pkg=await loadJatsSource(storage,plan.packageKey);assert.equal(pkg.manifest.files.length,9);
  const {ReaderDocumentLoader}=loadReading("reader/document-loader.ts",{obsidian:{normalizePath:p=>p,TFile:class{}}});
  const app={vault:{adapter:{getBasePath:()=>root,exists:async p=>{try{await fs.lstat(path.join(root,p));return true;}catch(e){if(e.code==="ENOENT")return false;throw e;}}}}},loader=new ReaderDocumentLoader(app);
  assert.equal((await loader.load(`papers/${plan.packageKey}/article.md`)).sourceKind,"jats");
  await assert.rejects(loader.load(`papers/${plan.packageKey}/_source/article.xml`),/入口无效/);
  const incomplete="papers/incomplete--jats--abc";await storage.mkdir(incomplete);await storage.mkdir(incomplete+"/_source");await storage.create(incomplete+"/article.md",Buffer.from("Looks complete but has no manifest"));await assert.rejects(loader.load(incomplete+"/article.md"),/尚未提交/);
  source.metadata.license_code="CC BY-SA";const changed=await source.acquire(),other=new JatsIntakeService({...deps,read:async()=>changed});try{const next=await other.prepare(changed.snapshot.jobId);assert.equal(next.citekey,plan.citekey);assert.ok(!next.existing,"same source version with a changed manifest must not reuse old provenance");assert.equal((await other.save(next.requestId,next.evidenceDigest,false)).phase,"saved");assert.notEqual(next.packageKey,plan.packageKey);}finally{await other.dispose();}
  await storage.create(`papers/${plan.packageKey}/unexpected.txt`,Buffer.from("unregistered"));await assert.rejects(loader.load(`papers/${plan.packageKey}/article.md`),/未登记/);
 }finally{await service.dispose();}
 console.log("JATS_STORAGE_OK: real create-only publication, strict reader dispatch, incomplete/extra-resource refusal, source-manifest changes retained separately; fixtures retained");
})().catch(e=>{console.error(e);process.exitCode=1;});
