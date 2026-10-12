"use strict";
const assert = require("node:assert/strict");
const {loadReading} = require("./reading-test-helpers");
const {parseBilingualMarkdown} = loadReading("reader/bilingual-document.ts");
const {bilingualRenderMarkdown, BilingualReader} = loadReading("views/bilingual-reader.ts", {obsidian: {Component: class {}}});
const text = '---\ntitle: "Title"\n---\n## Main\n\nText [^1].\n\n![Fig. 1](<images/one.webp>)\n\nCaption.\n\n$$\nx=2\n$$\n\n```js\nconst x=2;\n```\n\n[^1]: Reference.\n\n[reference]: https://example.test\n';
const file = {text, ...parseBilingualMarkdown(text)};
const rendered = bilingualRenderMarkdown(file);
assert.ok(!rendered.includes('title: "Title"'));
assert.ok(rendered.includes('![Fig. 1](<images/one.webp>)\n\n'));
assert.ok(rendered.includes('Caption.'));
assert.ok(rendered.includes('$$\nx=2\n$$'));
assert.ok(rendered.includes('```js\nconst x=2;\n```'));
assert.ok(rendered.includes('[^1]: Reference.'));
assert.ok(rendered.includes('[reference]: https://example.test'));
assert.equal((rendered.match(/data-bilingual-anchor=/g)||[]).length, 6);
for (const b of file.blocks.filter(b=>b.kind==="footnote"||b.kind==="reference")) assert.ok(!rendered.includes('data-bilingual-anchor="'+b.id+'"'));
assert.equal(file.text, text);
// During plugin reload Obsidian removes CSS before asking for the old view state.
// The old scroller then expands to its full article height and reports scrollTop=0.
const doc={syncAvailable:true,files:{en:{...file,digest:"a".repeat(64)},"zh-CN":{...file,digest:"b".repeat(64)}}};
const state={linked:false,active:"zh-CN",digests:{en:doc.files.en.digest,"zh-CN":doc.files["zh-CN"].digest},positions:{en:{blockId:"b-2",progress:0.3},"zh-CN":{blockId:"b-3",progress:0.4}}};
const controller=new AbortController(),reader=new BilingualReader({document:doc,state,signal:controller.signal});
assert.deepEqual(reader.snapshot(),state,"unpainted view keeps saved anchors");reader.restoring=false;
for(const language of ["en","zh-CN"])reader.panes.set(language,{scroller:{scrollTop:0,clientHeight:10000,scrollHeight:10000},article:{isConnected:true,getBoundingClientRect:()=>({height:10000})},anchors:new Map()});
assert.deepEqual(reader.snapshot(),state,"CSS teardown cannot overwrite long-document positions with top");
controller.abort();assert.deepEqual(reader.snapshot(),state,"aborted view keeps its last source-bound positions");
console.log("BILINGUAL_RENDERING_OK: inline assets, whole formulas/code and document-wide references preserved; source unchanged");
