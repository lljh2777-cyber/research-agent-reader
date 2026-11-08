"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { indexBilingualParagraphHover } = loadReading("views/bilingual-paragraph-hover.ts");
const { normalizeBilingualState } = loadReading("reader/bilingual-position.ts");

function fixture(digest, offset, rows) {
	const anchors = new Map(), elements = [], blocks = [], targets = [];
	let text = "";
	for (const [i, [kind, raw, rendered]] of rows.entries()) {
		const id = "b-" + (i + offset), start = text.length;
		text += raw + "\n\n";
		const block = { id, kind, start, end: text.length };
		blocks.push(block);
		const marker = { dataset: { bilingualAnchor: id }, tagName: "SPAN" };
		anchors.set(id, marker); elements.push(marker);
		const paragraphs = rendered.map(textContent => ({ textContent, dataset: {}, tagName: "P", closest: () => null }));
		elements.push(...paragraphs); targets.push(paragraphs);
	}
	return { file: { text, digest, blocks }, pane: { article: { querySelectorAll: () => elements }, anchors }, targets };
}
const en = fixture("en", 0, [
	["paragraph", "First sentence. Another sentence.", ["First sentence. Another sentence."]],
	["paragraph", "A raw block that renders twice.", ["One rendered paragraph.", "Another rendered paragraph."]],
	["paragraph", "**a**, Panel description.", ["a, Panel description."]],
	["heading", "## Extended data figures and tables", []],
	["paragraph", "An unlabelled figure caption.", ["An unlabelled figure caption."]],
	["heading", "## Discussion", []],
	["paragraph", "A later paragraph.", ["A later paragraph."]],
	["paragraph", "Supplementary Table 1. Catalog of entries.", ["Supplementary Table 1. Catalog of entries."]],
]);
const zh = fixture("zh", 10, [
	["paragraph", "第一句和另一句。", ["第一句和另一句。"]],
	["paragraph", "此处只渲染一段。", ["此处只渲染一段。"]],
	["paragraph", "**a**，子图说明。", ["a，子图说明。"]],
	["heading", "## 扩展数据图和表", []],
	["paragraph", "没有标号的图注。", ["没有标号的图注。"]],
	["heading", "## 讨论", []],
	["paragraph", "稍后的段落。", ["稍后的段落。"]],
	["paragraph", "补充表 1. 条目清单。", ["补充表 1. 条目清单。"]],
]);
const doc = { syncAvailable: true, stale: false, files: { en: en.file, "zh-CN": zh.file },
	pairs: en.file.blocks.map((block, i) => ({ en: block, "zh-CN": zh.file.blocks[i] })) };
const index = indexBilingualParagraphHover(doc, en.pane, zh.pane);
assert.deepEqual(index.counts, { en: 3, "zh-CN": 3 });
assert.equal(index.eligiblePairs, 3, "missing or ambiguous rendering does not reduce the structural denominator");
assert.deepEqual(index.pairs, [
	{ en: en.targets[0][0], "zh-CN": zh.targets[0][0] },
	{ en: en.targets[6][0], "zh-CN": zh.targets[6][0] },
]);
assert.equal(index.owners.get(en.targets[0][0]), index.owners.get(zh.targets[0][0]), "one paragraph pair is addressable from either language despite different sentence counts");
assert.equal(index.owners.has(zh.targets[1][0]), false, "ambiguous rendering in either pane suppresses both sides");
assert.equal(indexBilingualParagraphHover({ ...doc, syncAvailable: false, selectedFiles: {} }, en.pane, zh.pane).pairs.length, 0);
assert.equal(indexBilingualParagraphHover({ ...doc, stale: true }, en.pane, zh.pane).pairs.length, 0);

assert.equal(normalizeBilingualState({}, doc).paragraphHover, undefined);
const migrated = normalizeBilingualState({ sentenceHover: true, linked: false }, doc);
assert.equal(migrated.paragraphHover, true);
assert.equal(migrated.sentenceHover, undefined);
assert.equal(migrated.linked, false);
assert.equal(normalizeBilingualState({ paragraphHover: false, sentenceHover: true }, doc).paragraphHover, undefined);
assert.equal(normalizeBilingualState({ paragraphHover: true }, { ...doc, syncAvailable: false }).paragraphHover, undefined);
console.log("BILINGUAL_PARAGRAPH_HOVER_OK: structural identity, caption exclusion, ambiguity, stale/progress-only pairing and opt-in migration");
