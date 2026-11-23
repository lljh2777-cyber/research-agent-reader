"use strict";
// Memory-only DOM ranges and Vault; real capture/service/receipts. No models or filesystem cleanup.
const assert = require("node:assert/strict"), path = require("node:path"), { loadReading } = require("./reading-test-helpers");
class TFile { constructor(p) { this.path = p; this.extension = "md"; this.basename = path.posix.basename(p, ".md"); } }
const mocks = { obsidian: { TFile, MarkdownView: class {}, Notice: class {}, normalizePath: p => p } };
const { AnnotationService, readAnnotationRecords } = loadReading("annotations/annotation-service.ts", mocks);
const { captureMarkdownRange, revealMarkdownRange, annotationDisplayText, annotationEvidenceText } = loadReading("annotations/markdown-selection.ts");
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
async function archiveFixture() {
 const selectedText = "A passage", sourcePath = "Clippings/archive.md", f = memory(selectedText, sourcePath);
 const selection = { sourcePath, selectedText, sourceStart: 0, sourceEnd: selectedText.length, prefix: "", suffix: "", context: selectedText, section: "", anchorRect: {} };
 const record = await f.service.createAnnotation(selection, { manualText: "Original memo", aiText: "Original explanation" });
 return { ...f, record, note: f.files.get(record.annotationPath) };
}
let count = 0; const check = async (name, fn) => { await fn(); count++; console.log("OK linked annotations: " + name); };
(async () => {
 await check("archiving keeps the manual edit made while the write was waiting", async () => {
  const { service, record, note, app } = await archiveFixture();
  const process = app.vault.process;
  app.vault.process = (file, transform) => {
   note.text = note.text.replace("Original memo", "Edited while waiting");
   return process(file, transform);
  };
  const updated = await service.updateArchiveState(record, { archiveStatus: "pending" });
  assert.equal((await service.loadAnnotation(record.annotationPath, record.id)).manualText, "Edited while waiting");
  assert.equal(updated.manualText, "Edited while waiting");
 });
 await check("archiving changes only the requested fields and their display lines", async () => {
  const { service, record, note } = await archiveFixture();
  const extraMeta = String.raw` "extension" : { "archiveStatus":"nested", "values":[1.00, "\u0041", "}"] }, `;
  const before = note.text
   .replace('{"id":', () => "{" + extraMeta + '"id":')
   .replace(/^(<!-- agent-dashboard:annotation-meta .* -->)$/m, line => "  " + line + "  ")
   .replace("Original memo", () => "Original memo $& $1 $$\n### 归档\n- 状态：个人记录")
   .replace("- 状态：未归档", "- 状态：我的阅读进度\n- 状态：未归档")
   .replace("- 知识节点：无", () => "我的补充段落  \n\n- 知识节点：无")
   .replaceAll("\n", "\r\n") + "块外备注\r\n";
  note.text = before;
  const updated = await service.updateArchiveState(record, { archiveStatus: "completed", archiveTargets: ["[[wiki/methods/test]]"] });
  const expected = before.replace('"archiveStatus":"none"', '"archiveStatus":"completed"')
   .replace('"archiveTargets":[]', '"archiveTargets":["wiki/methods/test"]')
   .replace("- 状态：未归档", "- 状态：已归档").replace("- 知识节点：无", "- 知识节点：[[wiki/methods/test]]");
  assert.equal(note.text, expected);
  assert.equal(updated.updatedAt, record.updatedAt);
  assert.deepEqual(updated.archiveTargets, ["wiki/methods/test"]);
  const message = "运行失败 $& $1\n### 详细日志\n第二行";
  await service.updateArchiveState(record, { archiveStatus: "failed", archiveError: message, archiveRunId: "run-1" });
  assert.ok(note.text.includes("- 说明：" + message.replaceAll("\n", "\r\n") + "\r\n"));
  const retry = await service.updateArchiveState(record, { archiveStatus: "pending", archiveError: "" });
  assert.equal(retry.archiveRunId, "run-1");
  assert.equal(note.text, expected.replace('"archiveStatus":"completed"', '"archiveStatus":"pending"')
   .replace('"archiveRunId":""', '"archiveRunId":"run-1"').replace("- 状态：已归档", "- 状态：归档中"));
 });
 await check("removing a queued record or its file reports a conflict without recreating it", async () => {
  const { service, record, note, app, files } = await archiveFixture();
  const process = app.vault.process;
  app.vault.process = (file, transform) => {
   note.text = "仅保留用户段落\r\n";
   return process(file, transform);
  };
  const archive = () => service.updateArchiveState(record, { archiveStatus: "completed" });
  await assert.rejects(archive, /归档冲突/);
  assert.equal(note.text, "仅保留用户段落\r\n");
  files.delete(record.annotationPath);
  await assert.rejects(archive, /归档冲突/);
  assert.equal(files.has(record.annotationPath), false);
 });
 await check("archive entry shows the deletion conflict during busy, pending, completed and failed writes", async () => {
  const notices = [];
  class Base {}
  const obsidian = { ...mocks.obsidian, Plugin: Base, PluginSettingTab: Base, Component: Base, ItemView: Base, Modal: Base, FileSystemAdapter: Base, Notice: class { constructor(message) { notices.push(message); } } };
  const Plugin = loadReading("plugin.ts", { obsidian, electron: {} }).default;
  for (const stage of ["busy", "pending", "completed", "failed"]) {
   const { service, record, note } = await archiveFixture();
   const plugin = new Plugin(), run = { id: "run", status: "running" };
   notices.length = 0;
   plugin.annotationService = service;
   plugin.isActionRunning = () => stage === "busy";
   plugin.resolveActionExecutionConfig = () => ({});
   plugin.startTaskRun = async () => run;
   plugin.getTaskRun = () => run;
   plugin.finishTaskRun = async (_id, result) => Object.assign(run, result);
   plugin.runVaultAction = async () => {
    assert.ok(stage === "completed" || stage === "failed");
    note.text = "用户已移除批注\n";
    return { stdout: 'ANNOTATION_ARCHIVE_TARGETS: ["wiki/methods/test"]', stderr: "", exitCode: stage === "completed" ? 0 : 1 };
   };
   if (stage === "busy" || stage === "pending") note.text = "用户已移除批注\n";
   await plugin.archiveAnnotation(record);
   assert.match(notices.at(-1), /归档冲突/);
   assert.equal(note.text, "用户已移除批注\n");
   if (stage !== "busy") assert.equal(run.status, "failed");
  }
 });
 await check("color-only records round-trip, update without losing text or receipts, and leave ordinary sources unchanged", async () => {
  const content = "# Notes\n\nRepeated words and a [linked label](https://example.invalid) with X<sup>2</sup>.", sourcePath = "notes/ordinary.md";
  const f = memory(content, sourcePath), selectedText = "Repeated words", start = content.indexOf(selectedText);
  const selection = { sourcePath, selectedText, sourceStart: start, sourceEnd: start + selectedText.length, prefix: content.slice(0,start), suffix: content.slice(start+selectedText.length,start+selectedText.length+80), section: "Notes", context: content, anchorRect: {} };
  const r = await f.service.createAnnotation(selection, { color: "yellow" });
  assert.equal(f.files.get(sourcePath).text, content); assert.equal(r.manualText, ""); assert.ok(r.sourceAnchor);
  assert.equal((await new AnnotationService(f.app, {}).findAnnotationForSelection(selection)).color, "yellow");
  const receipt = { requestedModel: "test/model", usage: { input_tokens: 12 } };
  let noted = await f.service.updateAnnotation(r, { manualText: "Personal", aiText: "Saved explanation", aiProvider: "test", aiModel: "test/model", aiCli: receipt });
  for (const color of ["green", "blue", "purple", "red"]) {
   const changed = noted = await f.service.updateAnnotation(noted, { color });
   const read = readAnnotationRecords(f.files.get(r.annotationPath).text, r.annotationPath).records[0];
   assert.equal(read.color, color); assert.equal(read.manualText, "Personal"); assert.equal(read.aiText, "Saved explanation"); assert.deepEqual(read.aiCli, receipt); assert.deepEqual(read.sourceAnchor, r.sourceAnchor);
  }
  const cleared = await f.service.updateAnnotation(noted, { color: "none" });
  assert.equal(cleared.color, undefined); assert.equal((await f.service.loadAnnotation(r.annotationPath,r.id)).color,undefined);
  assert.equal(f.files.get(sourcePath).text, content);
  const before = f.writes.length;
  await assert.rejects(f.service.updateAnnotation(cleared, { color: "url(evil)" }), /颜色/);
  await assert.rejects(f.service.createAnnotation(selection, { color: "constructor" }), /颜色/);
  assert.equal(f.writes.length, before);
  const malformed = f.files.get(r.annotationPath).text.replace('"id":', '"color":"url(evil)","id":');
  assert.equal(readAnnotationRecords(malformed,r.annotationPath).records.length,0);
 });
 await check("colored rendered ranges retain links and superscripts and reject changed or ambiguous anchors", async () => {
  const { annotationHighlightRanges } = loadReading("annotations/annotation-highlights.ts", { obsidian: { ...mocks.obsidian, Component: class {} } });
  const raw = "Read [the paper](https://example.invalid) and X<sup>2</sup>.", d = dom(["Read ", "the paper", " and X2."]);
  d.block.matches = () => true; d.block.querySelector = () => null; d.block.querySelectorAll = () => []; d.block.parentElement = null;
  const r = { color: "green", sourcePath: "Clippings/linked.md", selectedText: raw, sourceAnchor: { start: 0, end: raw.length, prefix: "", suffix: "" } };
  const ranges = annotationHighlightRanges([d.block],raw,r);
  assert.equal(ranges.length,1); assert.equal(ranges[0].toString(),"Read the paper and X2.");
  assert.equal(annotationHighlightRanges([d.block],raw.replace("paper", "other"),r).length,0);
  assert.equal(annotationHighlightRanges([d.block], "prefix " + raw + "\n" + raw,r).length,0);
  assert.equal(annotationHighlightRanges([d.block],raw,{...r, sourcePath:"x", color: undefined}).length,0);
 });
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
 const {renderCliGroundedExplanation} = loadReading("annotations/cli-grounded-explanation.ts");
 const reviewQuote = (quote,evidence) => renderCliGroundedExplanation(JSON.stringify({claims:[{quote,meaning:"作者报告了这项结果。"}]}),evidence);
 await check("historical verified quotes exclude hidden URLs and altered claims", async () => {
  const raw = "The classifier performed only marginally better than random guessing (Fig. [1a](https://example.invalid/hidden-strong-association)).";
  const visible = "The classifier performed only marginally better than random guessing (Fig. 1a).";
  const evidence = annotationEvidenceText(raw);
  assert.equal(evidence,visible);
  assert.ok(reviewQuote(visible,evidence).includes(visible));
  for(const forged of ["hidden-strong-association",visible.replace("marginally better","much better")]) assert.throws(()=>reviewQuote(forged,evidence),/引句不在/);
  assert.equal(annotationEvidenceText("Read [the paper][ref].","[ref]: https://example.invalid/hidden"),"Read the paper.");
 });
 await check("superscripts and subscripts survive CLI evidence without changing DOM anchors or old receipts", async () => {
  const raw = "Xenium<sup>5</sup>, inference<sup>17</sup>, 10<sup>2</sup> and H<sub>2</sub>O.", visible = "Xenium5, inference17, 102 and H2O.", d = dom([visible]), f = memory(raw);
  assert.equal(annotationDisplayText(raw), visible); assert.equal(annotationEvidenceText(raw), raw);
  assert.equal(annotationEvidenceText('[X<sup class="ref">5</sup>](https://example.invalid)'), 'X<sup>5</sup>');
  assert.equal(annotationEvidenceText('A<SUP title="note">1,2</SUP> B<sub>i</sub>'), 'A<sup>1,2</sup> B<sub>i</sub>');
  const captured = captureMarkdownRange(d.block, d.range(), raw, 0, raw.length);
  assert.equal(raw.slice(captured.start, captured.end), raw);
  assert.equal(revealMarkdownRange(d.block, raw, 0, raw.length, captured.start, captured.end).toString(), visible);
  live(d.range()); const selection = await f.service.captureSelection();
  const record = await f.service.createAnnotation(selection, { aiText: 'Historical Xenium5 quote.', aiProvider: 'original' });
  assert.ok(reviewQuote(raw,annotationEvidenceText(raw)).includes(raw));
  assert.throws(()=>reviewQuote(visible,annotationEvidenceText(raw)),/引句不在/);
  assert.deepEqual(await f.service.loadAnnotation(record.annotationPath,record.id),JSON.parse(JSON.stringify(record)));
  assert.equal(f.files.get(selection.sourcePath).text, raw);
 });
 console.log(`LINKED_ANNOTATIONS_OK (${count} groups; memory DOM/Vault only)`);
})().catch(e => { console.error(e); process.exitCode = 1; });
