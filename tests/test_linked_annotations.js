"use strict";
// Memory-only DOM ranges and Vault; real capture/service/receipts. No models or filesystem cleanup.
const assert = require("node:assert/strict"), path = require("node:path"), { loadReading } = require("./reading-test-helpers");
class TFile { constructor(p) { this.path = p; this.extension = "md"; this.basename = path.posix.basename(p, ".md"); } }
const mocks = { obsidian: { TFile, MarkdownView: class {}, Notice: class {}, normalizePath: p => p } };
const { AnnotationService, readAnnotationRecords } = loadReading("annotations/annotation-service.ts", mocks);
const { captureMarkdownRange, revealMarkdownRange, annotationDisplayText } = loadReading("annotations/markdown-selection.ts");
const { excerptRevision, prepareExcerpt, validExcerpt } = loadReading("annotations/excerpt.ts");
globalThis.Node = { ELEMENT_NODE: 1 }; globalThis.NodeFilter = { SHOW_TEXT: 4 }; globalThis.DOMRect = class {};
function dom(parts, sourcePath = "Clippings/linked.md") {
 const block = { nodeType: 1, dataset: { agentAnnotationSource: sourcePath, agentAnnotationLineStart: "0" }, children: [], matches: () => false, contains: n => n === block || nodes.includes(n),
  closest: s => /input|textarea|button|pre, code/.test(s) ? null : block };
 const nodes = parts.map(part => { const foot = typeof part !== "string", el = foot ? {} : block;
  return { data: foot ? part.foot : part, parentElement: { closest: s => s === ".footnote-backref" ? (part.back ? el : null) : s.includes("footnote") ? (foot ? el : null) : block }, foot, el }; });
 block.contains = n => n === block || nodes.includes(n) || nodes.some(t => t.el === n);
 const all = () => nodes.map(n => n.data).join("");
 const offset = (node, n) => node === block ? (n ? all().length : 0) : nodes.slice(0, nodes.indexOf(node)).reduce((sum, v) => sum + v.data.length, n);
 const doc = { createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] || null }; }, createRange: () => ({
  commonAncestorContainer: block, startContainer: block, startOffset: 0, endContainer: block, endOffset: 1,
  selectNodeContents() { this.setStart(block, 0); this.setEnd(block, 1); },
  setStart(n, o) { this.startContainer = n; this.startOffset = o; }, setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
  toString() { return all().slice(offset(this.startContainer, this.startOffset), offset(this.endContainer, this.endOffset)); }, getBoundingClientRect: () => ({})
 }) };
 block.ownerDocument = doc; block.textContent = all();
 const range = (first = 0, from = 0, last = nodes.length - 1, to = nodes[last].data.length) => { const r = doc.createRange(); r.setStart(nodes[first], from); r.setEnd(nodes[last], to); return r; };
 return { block, range, nodes };
}
function memory(content, sourcePath = "Clippings/linked.md") {
 const files = new Map([[sourcePath, { file: new TFile(sourcePath), text: content }]]), writes = [];
 const app = { workspace: {}, vault: { getAbstractFileByPath: p => files.get(p)?.file, read: async f => files.get(f.path).text,
  createFolder: async p => files.set(p, { file: { path: p } }), create: async (p, text) => { assert.ok(!files.has(p)); const file = new TFile(p); files.set(p, { file, text }); writes.push(p); return file; },
  process: async (f, fn) => { files.get(f.path).text = fn(files.get(f.path).text); writes.push(f.path); } } };
 return { files, writes, app, service: new AnnotationService(app, {}) };
}
function live(range) { globalThis.window = { getSelection: () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => range.toString() }) }; }
let count = 0; const check = async (name, fn) => { await fn(); count++; console.log("OK linked annotations: " + name); };
(async () => {
 await check("paragraph across links, footnotes, Unicode and soft line breaks keeps exact source and round trips", async () => {
  const raw = "😀 Before [linked **words**](https://example.invalid/a_(b)) and [[wiki/methods/item|方法]]\nwith evidence[^author-key].";
  const content = "# Article\n\n" + raw + "\n\n[^author-key]: Reference\n", d = dom(["😀 Before ", "linked ", "words", " and ", "方法", "\nwith evidence", { foot: "[7]" }, "."]), f = memory(content);
  live(d.range()); const s = await f.service.captureSelection();
  assert.equal(s.selectedText, raw); assert.equal(content.slice(s.sourceStart, s.sourceEnd), raw); assert.ok(s.detached);
  const r = await f.service.createAnnotation(s, { manualText: "manual", aiText: "mock explanation", aiProvider: "mock" });
  assert.equal(f.files.get(s.sourcePath).text, content); assert.ok(f.writes.every(p => p.startsWith("wiki/annotations/")));
  assert.deepEqual(readAnnotationRecords(f.files.get(r.annotationPath).text, r.annotationPath).records[0], JSON.parse(JSON.stringify(r)));
  assert.doesNotMatch(f.files.get(r.annotationPath).text, /<pre>[^<]*\[\[wiki\/methods/);
  assert.equal((await new AnnotationService(f.app, {}).findAnnotationForSelection(s)).id, r.id);
  const excerpt = await f.service.createExcerpt(s), back = revealMarkdownRange(d.block, content, 0, content.length, excerpt.sourceAnchor.start, excerpt.sourceAnchor.end);
  assert.equal(back.toString(), d.range().toString()); assert.equal(excerpt.selectedText, raw);
  f.files.get(s.sourcePath).text += "Changed"; const before = f.writes.length;
  await assert.rejects(f.service.createExcerpt(s), /版本/); assert.equal(f.writes.length, before);
 });
 await check("partial labels expand to complete links; repeated words retain the selected occurrence", async () => {
  const raw = "repeat [repeat](https://example.invalid) repeat.", d = dom(["repeat ", "repeat", " repeat."]);
  const s = captureMarkdownRange(d.block, d.range(1, 1, 1, 4), raw, 0, raw.length);
  assert.equal(raw.slice(s.start, s.end), "[repeat](https://example.invalid)"); assert.ok(s.expanded);
  const last = captureMarkdownRange(d.block, d.range(2, 1, 2, 7), raw, 0, raw.length); assert.equal(last.start, raw.lastIndexOf("repeat"));
  assert.equal(revealMarkdownRange(d.block, raw, 0, raw.length, last.start, last.end).toString(), "repeat");
  assert.throws(() => captureMarkdownRange(d.block, d.range(), raw + "\n\n" + raw, 0, raw.length * 2 + 2), /重复/);
  assert.throws(() => captureMarkdownRange(d.block, d.range(), "unrelated", 0, 9), /准确对应/);
 });
 await check("reference links, escaped labels, entities, autolinks and arbitrary footnote labels", async () => {
  for (const [raw, parts, definition] of [
   ["Read [the paper][ref].", ["Read the paper."], "\n\n[ref]: https://example.invalid"],
   ["Read [ref][].", ["Read ref."], "\n\n[ref]: https://example.invalid"],
   ["Read [ref].", ["Read ref."], "\n\n[ref]: https://example.invalid"],
   ["Read [a \\[b\\]](https://example.invalid/a_(b)) &amp; more.", ["Read a [b] & more."], ""],
   ["See <https://example.invalid>[^non-numeric].", ["See https://example.invalid", { foot: "12" }, "."], ""],
   ["Read <a href=\"https://example.invalid\">paper</a>.", ["Read paper."], ""]
  ]) { const d = dom(parts), content = raw + definition, s = captureMarkdownRange(d.block, d.range(), content, 0, raw.length); assert.equal(content.slice(s.start, s.end), raw); assert.equal(revealMarkdownRange(d.block, content, 0, raw.length, s.start, s.end).toString(), d.range().toString()); }
  assert.equal(annotationDisplayText("[paper](https://example.invalid) [[target|alias]] [^key]"), "paper alias [key]");
  const body = "[^named-ref]: Reference [paper](https://example.invalid).", d = dom(["Reference paper.", { foot: "↩︎", back: true }]), s = captureMarkdownRange(d.block, d.range(), body, 0, body.length);
  assert.equal(body.slice(s.start, s.end), "Reference [paper](https://example.invalid).");
  assert.throws(() => captureMarkdownRange(d.block, d.range(1, 0, 1, 1), body, 0, body.length), /没有可批注/);
 });
 await check("editor source selections keep whole links and authored Wiki remains unchanged", async () => {
  const raw = "A [linked words](https://example.invalid) result.", source = "wiki/concepts/linked.md", f = memory(raw, source), start = raw.indexOf("linked"), end = start + 6;
  globalThis.window = { getSelection: () => null };
  f.app.workspace = { getActiveViewOfType: () => ({ file: f.files.get(source).file, editor: { getSelection: () => raw.slice(start, end), listSelections: () => [{ anchor: { ch: start }, head: { ch: end } }], posToOffset: p => p.ch } }) };
  const s = await f.service.captureSelection(); assert.equal(s.selectedText, "[linked words](https://example.invalid)"); assert.ok(s.linkSelectionExpanded && s.detached);
  const r = await f.service.createAnnotation(s, { manualText: "memo" }); assert.equal(f.files.get(source).text, raw); assert.equal(r.sourceAnchor.start, raw.indexOf("["));
  assert.equal((await new AnnotationService(f.app, {}).findAnnotationForSelection(s)).id, r.id);
 });
 await check("visible and raw budgets preserve valid bounded excerpt receipts", async () => {
  const raw = "[short](https://example.invalid/" + "x".repeat(1800) + ")", content = "p".repeat(2000) + "\n\n" + raw + "\n\n" + "s".repeat(2000), start = content.indexOf(raw), end = start + raw.length;
  const s = { sourcePath: "Clippings/long.md", selectedText: raw, sourceStart: start, sourceEnd: end, prefix: content.slice(start - 80, start), suffix: content.slice(end, end + 80), sourceRevision: excerptRevision(content) };
  const { receipt } = prepareExcerpt(s, content); assert.ok(receipt.context.length <= 3200); assert.ok(validExcerpt(receipt, { start, end }, raw));
  assert.throws(() => prepareExcerpt({ ...s, selectedText: "x".repeat(601) }, content), /位置/);
  const huge = "[short](https://example.invalid/" + "x".repeat(2500) + ")"; assert.throws(() => prepareExcerpt({ ...s, selectedText: huge }, content), /位置/);
 });
 await check("native CLI sees and verifies identical visible prose; hidden URLs and altered claims cannot become evidence", async () => {
  const raw = "The classifier performed only marginally better than random guessing (Fig. [1a](https://example.invalid/hidden-strong-association)).", visible = "The classifier performed only marginally better than random guessing (Fig. 1a).", f = memory(raw);
  const settings = { annotationBackendId: "qoderclicn", annotationQoderModel: "Qwen3.8-Flash", annotationCliTimeoutSeconds: 120 }, requests = [];
  let quote = visible; const cli = { generate: async request => { requests.push(request); return { text: JSON.stringify({ claims: [{ quote, meaning: "作者报告该分类器的表现仅略优于随机猜测。" }] }), requestedModel: settings.annotationQoderModel }; } };
  const service = new AnnotationService(f.app, { settings }, cli), selection = { sourcePath: "Clippings/linked.md", selectedText: raw, context: raw, section: "" };
  const answer = await service.generateExplanation(selection, () => {}); assert.ok(answer.text.includes(visible)); assert.ok(requests[0].user.includes(visible)); assert.ok(!requests[0].user.includes("https://")); assert.equal(selection.selectedText, raw);
  quote = visible.replace("marginally better", "much better"); await assert.rejects(service.generateExplanation(selection, () => {}), /引句不在/);
  quote = "hidden-strong-association"; await assert.rejects(service.generateExplanation(selection, () => {}), /引句不在/);
  const referenced = "Read [the paper][ref].", content = referenced + "\n\n[ref]: https://example.invalid/hidden\n"; f.files.get(selection.sourcePath).text = content; quote = "Read the paper.";
  await service.generateExplanation({ ...selection, selectedText: referenced, context: referenced }, () => {}); assert.ok(requests.at(-1).user.includes(quote)); assert.ok(!requests.at(-1).user.includes("[ref]"));
  assert.equal(requests.length, 4, "each accepted or rejected result consumes exactly one mock call");
 });
 console.log(`LINKED_ANNOTATIONS_OK (${count} groups; memory DOM/Vault only)`);
})().catch(e => { console.error(e); process.exitCode = 1; });
