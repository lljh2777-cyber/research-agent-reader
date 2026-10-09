"use strict";
// Real create-only writer in a retained isolated directory; no network or fixture cleanup.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers");
const { resolveNodeExecutable } = loadReading("runtime/node-executable.ts");
const { createTrustedVaultTextFile } = loadReading("runtime/trusted-vault-fs.ts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rar-note-create-"));
const adapter = { getBasePath: () => root };
(async () => {
 const desktop = path.join(root, "Obsidian.exe");
 assert.equal(resolveNodeExecutable({ execPath: desktop, electron: true, searchPath: path.dirname(process.execPath) }), fs.realpathSync(process.execPath));
 assert.equal(resolveNodeExecutable({ execPath: process.execPath, electron: false, searchPath: "" }), fs.realpathSync(process.execPath));
 assert.throws(() => resolveNodeExecutable({ execPath: desktop, electron: true, searchPath: ["", ".", "relative-node"].join(path.delimiter) }), /Node.js/);
 // Even an Electron executable named node must not be used as the standalone runtime.
 assert.throws(() => resolveNodeExecutable({ execPath: process.execPath, electron: true, searchPath: "" }), /Node.js/);
 const name = "wiki/sources/new-note.md", content = "# 初始笔记\n\n原文依据保持不变。\n";
 await createTrustedVaultTextFile(adapter, name, content);
 assert.equal(fs.readFileSync(path.join(root, name), "utf8"), content);
 await assert.rejects(createTrustedVaultTextFile(adapter, name, "replacement"), /EEXIST/);
 assert.equal(fs.readFileSync(path.join(root, name), "utf8"), content);
 const race = await Promise.allSettled(["one", "two"].map(text => createTrustedVaultTextFile(adapter, "wiki/sources/race.md", text)));
 assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
 assert.ok(["one", "two"].includes(fs.readFileSync(path.join(root, "wiki/sources/race.md"), "utf8")));
 await assert.rejects(createTrustedVaultTextFile(adapter, "../outside.md", "outside"), /相对路径/);
 assert.deepEqual(fs.readdirSync(path.join(root, "wiki/sources")).sort(), ["new-note.md", "race.md"]);
 const fields = {title:"Paper",title_zh:"论文",authors:"Author",year:"2026",doi:"",researchQuestion:"问题",conclusion:"结论",motivation:"动机"};
 const {prepareSourceNote}=loadReading("agent/tools.ts",{obsidian:{normalizePath:p=>p}});
 assert.match(prepareSourceNote("test",fields).content,/## 证据缺口\n.*尚未逐图核验/);
 const withGaps=prepareSourceNote("test",{...fields,evidenceGaps:"样本量仍需核对"}).content;
 assert.match(withGaps,/尚未逐图核验/);assert.match(withGaps,/样本量仍需核对/);
 for (const [code, expected] of [["ENOSPC", /创建笔记失败/], ["EEXIST", /已存在同名文件/]]) {
  const {commitSourceNote} = loadReading("agent/tools.ts", {obsidian:{normalizePath:p=>p}, "../runtime/trusted-vault-fs":{
   createTrustedVaultTextFile:async()=>{throw Object.assign(new Error(code),{code});},
  }});
  await assert.rejects(commitSourceNote({app:{vault:{adapter:{}}}},"error",fields), error=>expected.test(error.message) && (code!=="ENOSPC" || !error.message.includes("已存在同名文件")));
 }
 console.log("TRUSTED_NOTE_CREATE_OK: standalone Node, missing-runtime error, real UTF-8 create, no overwrite, concurrent creator and path scope; retained fixture: " + root);
})().catch(error => { console.error(error); process.exitCode = 1; });
