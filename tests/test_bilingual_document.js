"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { loadReading } = require("./reading-test-helpers");
const { createBilingualDocument, parseBilingualMarkdown, bilingualPaths, loadBilingualDocument } = loadReading("reader/bilingual-document.ts");
const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = value => Buffer.from(value, "utf8");
const entry = "Clippings/example/paper.md";
const en = '\uFEFF---\r\ntitle: "Example"\r\n---\r\n## Main\r\n\r\nText with [^1].\r\n\r\n![Fig. 1](<images/figure.webp>)\r\n\r\nCaption.\r\n\r\n[^1]: Reference unchanged.\r\n';
const zh = '---\ntitle: "Example"\ntitleZh: "示例"\n---\n## 正文\n\n带有脚注的文字 [^1]。\n\n![图 1](<images/figure.webp>)\n\n图注。\n\n[^1]: Reference unchanged.\n';
const metadata = (source = en, extra = {}) => JSON.stringify({ schemaVersion: 1, sourceFile: "paper.md", translationFile: "paper.zh-CN.md", status: "needs-review", humanReview: "not-reviewed", sourceVersion: { algorithm: "sha256", value: hash(source) }, ...extra });
const make = (source = en, translation = zh, extra = {}) => createBilingualDocument(entry, bytes(source), bytes(translation), bytes(metadata(source, extra)));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("OK " + name); }
(async () => {
 await check("full source ranges preserve BOM, CRLF and unequal frontmatter", () => {
  const doc = make(); assert.equal(doc.syncAvailable, true); assert.equal(doc.pairs.length, 5);
  assert.equal(doc.files.en.digest, hash(en)); assert.equal(doc.files.en.revision.length, en.length);
  assert.equal(en.slice(doc.pairs[1].en.start, doc.pairs[1].en.end).trim(), "Text with [^1].");
  assert.equal(doc.files["zh-CN"].text.slice(doc.pairs[1]["zh-CN"].start, doc.pairs[1]["zh-CN"].end).trim(), "带有脚注的文字 [^1]。");
  assert.equal(doc.status, "needs-review"); assert.equal(doc.humanReview, "not-reviewed");
 });
 await check("fixed same-directory entries reject outside roots and traversal", () => {
  for (const path of ["papers/example/paper.md", "Clippings/paper.md", "Clippings/example/../paper.md", "Clippings/example/paper.en.md", "Clippings\\example\\paper.md", "Clippings/example:/paper.md"]) assert.throws(() => bilingualPaths(path));
  assert.deepEqual(bilingualPaths("Clippings/example/paper.zh-CN.md"), bilingualPaths(entry));
  assert.throws(() => make(en, zh, { sourceFile: "../../secret" })); assert.throws(() => make(en, zh, { schemaVersion: 2 }));
 });
 await check("stale and unknown provenance do not enable synchronization", () => {
  const stale = createBilingualDocument(entry, bytes(en + "\n"), bytes(zh), bytes(metadata(en, { stale: false })));
  assert.equal(stale.stale, true); assert.equal(stale.syncAvailable, false);
  assert.equal(make(en, zh, { stale: true }).syncAvailable, false);
  assert.equal(make(en, zh, { sourceVersion: undefined }).syncAvailable, false);
  assert.equal(make(en, zh, { status: "passed-ai", humanReview: "passed-ai" }).humanReview, "unknown");
 });
 await check("missing, reordered image, heading and citation structures stop mapping", () => {
  for (const changed of [zh.replace("## 正文", "### 正文"), zh.replace("图注。", "图注。\n\n多出的段落。"), zh.replace("figure.webp", "different.webp"), zh.replace("文字 [^1]", "文字 [^2]")]) assert.equal(make(en, changed).syncAvailable, false);
  assert.equal(make(en, "").syncAvailable, false);
 });
 await check("paragraph identity is occurrence-based and makes no semantic claim", () => {
  const source = "## A\n\nRepeat.\n\nRepeat.\n", translation = "## 甲\n\n重复。\n\n重复。\n", doc = make(source, translation);
  assert.equal(doc.syncAvailable, true); assert.notEqual(doc.pairs[1].en.start, doc.pairs[2].en.start);
  assert.notEqual(doc.pairs[1].id, doc.pairs[2].id);
 });
 await check("formula, table, code and list ranges remain complete", () => {
  const text = "## A\n\n| Name | Value |\n| --- | --- |\n| X | 2 |\n\n$$\nx=2\n\ny=3\n$$\n\n```js\nconst a=1;\n\nconst b=2;\n```\n\n- first\n- second\n\n> quote\n> continued\n";
  const parsed = parseBilingualMarkdown(text); assert.deepEqual(parsed.blocks.map(b => b.kind), ["heading", "table", "math", "code", "list", "quote"]);
  assert.match(text.slice(parsed.blocks[2].start, parsed.blocks[2].end), /y=3/);
  assert.throws(() => parseBilingualMarkdown("```js\nunfinished")); assert.throws(() => parseBilingualMarkdown("---\ntitle: unfinished"));
 });
 const memory = () => { const files = new Map([[entry, bytes(en)], ["Clippings/example/paper.zh-CN.md", bytes(zh)], ["Clippings/example/translation.json", bytes(metadata())], ["Clippings/example/images/figure.webp", bytes("image")]]); const reads = []; return { files, reads, async read(path, limit) { reads.push({path, limit}); const value = files.get(path); if (value && value.length > limit) throw new Error("limit"); return value || null; } }; };
 await check("loader is read-only and bounds exactly named inputs and shared image", async () => {
  const io = memory(), before = [...io.files].map(([p, v]) => [p, Buffer.from(v)]), doc = await loadBilingualDocument(io, entry);
  assert.equal(doc.syncAvailable, true); assert.equal(io.reads.length, 7); assert.deepEqual([...io.files], before);
 });
 await check("missing files and missing image are visible without invented pairs", async () => {
  const io = memory(); io.files.set("Clippings/example/images/figure.webp", null); const doc = await loadBilingualDocument(io, entry);
  assert.equal(doc.syncAvailable, false); assert.match(doc.issues.join(" "), /图片缺失/);
  io.files.set("Clippings/example/paper.zh-CN.md", null); await assert.rejects(loadBilingualDocument(io, entry), /配对文件缺失/);
 });
 await check("external and encoded traversal image targets never reach IO", async () => {
  for (const asset of ["https://example.test/figure.webp", "images/%2e%2e/secret.webp", "images/%2fsecret.webp"]) {
   const io = memory(), source = en.replace("images/figure.webp", asset), translation = zh.replace("images/figure.webp", asset);
   io.files.set(entry, bytes(source)); io.files.set("Clippings/example/paper.zh-CN.md", bytes(translation)); io.files.set("Clippings/example/translation.json", bytes(metadata(source)));
   await assert.rejects(loadBilingualDocument(io, entry), /图片/); assert.equal(io.reads.length, 3);
  }
 });
 await check("edit during loading and cancellation do not return a mixed snapshot", async () => {
  const io = memory(), read = io.read.bind(io); let calls = 0;
  io.read = async (p, limit) => { calls++; if (calls === 5) io.files.set(entry, bytes(en + "changed")); return read(p, limit); };
  await assert.rejects(loadBilingualDocument(io, entry), /加载期间变化/);
  const c = new AbortController(); c.abort(); const other = memory(); await assert.rejects(loadBilingualDocument(other, entry, c.signal)); assert.equal(other.reads.length, 0);
 });
 console.log(`Bilingual document: ${passed} groups passed; memory IO, no deletion or model requests.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
