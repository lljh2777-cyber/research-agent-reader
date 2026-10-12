"use strict";
const assert = require("node:assert/strict"), { loadReading } = require("./reading-test-helpers");
const { applySplitLayout, sourceSplitRatio } = loadReading("views/split-layout.ts");
const { normalizeManualSplit } = loadReading("reader/manual-split.ts");
const { ManualSplitReaderView } = loadReading("views/manual-split-reader.ts", { obsidian: { Component: class {}, Modal: class {}, ItemView: class { constructor(leaf) { this.leaf = leaf; } }, TFile: class {} } });
const scrollers = [{ scrollTop: 420 }, { scrollTop: 780 }];
const pane = (side, i) => ({ dataset: { splitSide: side }, source: i === 0 ? "English.md" : "中文.md", getAttribute: () => null, querySelector: () => scrollers[i] });
const left = pane("left", 0), right = pane("right", 1), attrs = new Map(), splitter = { dataset: {}, getAttribute: key => key === "role" ? "separator" : attrs.get(key), setAttribute: (k, v) => attrs.set(k, v) };
const css = new Map(), workspace = { children: [left, splitter, right], style: { setProperty: (k, v) => { if (css.get(k) !== v) scrollers.forEach(s => s.scrollTop = 0); css.set(k, v); } }, moves: 0,
	append(...nodes) { this.children = nodes; this.moves++; scrollers.forEach(s => s.scrollTop = 0); } };
applySplitLayout(workspace, 0.6, true);
assert.deepEqual(workspace.children, [right, splitter, left]); assert.deepEqual(scrollers.map(s => s.scrollTop), [420, 780]);
assert.equal(css.get("--bilingual-left"), "0.4fr"); assert.equal(attrs.get("aria-valuenow"), "40");
assert.equal(left.source, "English.md"); assert.equal(right.source, "中文.md");
applySplitLayout(workspace, 0.6, true); assert.equal(workspace.moves, 1, "no move when already in the requested order");
assert.deepEqual(scrollers.map(s => s.scrollTop), [420, 780]);
applySplitLayout(workspace, 0.6, false); assert.deepEqual(workspace.children, [left, splitter, right]); assert.deepEqual(scrollers.map(s => s.scrollTop), [420, 780]);
assert.equal(sourceSplitRatio(0.4, true), 0.6); assert.equal(sourceSplitRatio(0.4, false), 0.4);
console.log("OK pane identity, scroll positions, document widths, separator accessibility and repeated swaps");

const original = normalizeManualSplit({ mode: "bilingual", left: "English.md", right: "中文.md", entry: "中文.md", ratio: 0.6, linked: false, bilingualState: { positions: { en: { blockId: "b-2", progress: 0.4 }, "zh-CN": { blockId: "b-3", progress: 0.7 } } } });
let saves = 0, displayed;
const view = new ManualSplitReaderView({ updateHeader() {} }, { app: {} });
view.state = structuredClone(original); view.controller = new AbortController(); view.contentEl = { querySelector: () => null }; view.save = () => saves++;
view.bilingual = { snapshot: () => structuredClone(original.bilingualState), setReversed: value => displayed = value };
view.swap(); assert.equal(displayed, true); assert.equal(view.state.reversed, true); assert.equal(view.getDisplayText(), "中文.md ⇄ English.md");
assert.deepEqual(normalizeManualSplit(JSON.parse(JSON.stringify(view.getState()))), { ...original, reversed: true });
view.swap(); assert.equal(displayed, false); assert.deepEqual(view.state, original); assert.equal(saves, 2);
view.controller.abort(); view.swap(); assert.equal(saves, 2);
assert.equal(normalizeManualSplit({ ...original, reversed: "true" }).reversed, false);
console.log("OK bilingual swap saves layout without reassigning evidence roles; old and malformed layouts default to original order");

view.controller = new AbortController(); view.bilingual = undefined; view.state = normalizeManualSplit({ mode: "md-pdf", left: "body.md", right: "paper.pdf", pdfPage: 8, pdfProgress: 0.2, markdownProgress: 0.4, pdfZoom: 1.5, linked: false, digests: { left: "a".repeat(64), right: "b".repeat(64) } });
const pdfState = structuredClone(view.state); view.applyPdfLayout = () => displayed = view.state.reversed;
view.swap(); assert.equal(displayed, true); assert.deepEqual(view.state, { ...pdfState, reversed: true }); assert.equal(view.getDisplayText(), "paper.pdf ⇄ body.md");
console.log("SPLIT_SWAP_OK (3 groups; memory only, no files, cleanup or model calls)");
