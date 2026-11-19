"use strict";
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {loadReading} = require("./reading-test-helpers");
const hash = value => createHash("sha256").update(value).digest("hex");
const original = '---\ntitle: Example\nsource: https://example.org/article/1\n---\n# Results\n\nSource paragraph.\n';
const files = new Map([["first/paper.md", Buffer.from(original)]]);
const folders = new Set(["first"]);
class ReadOnlyStorage {
	async read(name) { return files.get(name) || null; }
	async list(dir) { return [...files.keys()].filter(key=>key.startsWith(dir+"/")).map(key=>({name:key.slice(dir.length+1),directory:false})); }
}
const fs = {readdir: async()=>[...folders].map(name=>({name,isDirectory:()=>true}))};
const api = loadReading("library/clipper.ts",{"node:fs/promises":fs,"../sources/storage":{FileSourceStorage:ReadOnlyStorage}});
(async()=>{
	const catalog = new api.ClipperDirectory("/example");
	const [first] = (await catalog.scan()).papers;
	assert.equal(first.bilingual,false); assert.equal(first.englishDigest,hash(original));
	const source = api.clipSource(first).id;
	assert.equal(await catalog.text(source),original);
	files.set("first/translation.json",Buffer.from(JSON.stringify({doi:"10.1234/a"})));
	files.set("first/paper.zh-CN.md",Buffer.from("# 结果\n"));
	const [paired] = (await catalog.scan()).papers;
	assert.equal(paired.key,first.key); assert.equal(paired.bilingual,true);
	folders.clear();folders.add("renamed");
	for(const [path,bytes] of [...files]){files.delete(path);files.set(path.replace("first/","renamed/"),bytes);}
	assert.equal(await catalog.text(source),original);
	folders.add("copy");files.set("copy/paper.md",Buffer.from(original));
	const conflict = await catalog.scan();assert.equal(conflict.papers.length,0);assert.equal(conflict.issues.length,1);
	await assert.rejects(catalog.text(source));
	console.log("CLIPPER_DIRECTORY_OK: read-only discovery, translation, folder relocation, duplicate identity");
})().catch(error=>{console.error(error);process.exitCode=1;});
