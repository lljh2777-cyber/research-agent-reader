"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { readingSentences, matchReadingSentences, readSentenceAlignment } = loadReading("reader/bilingual-sentences.ts");

const text = "  Fig. 2 shows 3.5 mg.\nThe result persisted.  ";
const sentences = readingSentences(text);
assert.deepEqual(sentences.map(s => text.slice(s.start, s.end)), ["Fig. 2 shows 3.5 mg.", "The result persisted."]);
const zh = readingSentences("图2显示用量为3.5毫克。结果持续存在。");
assert.equal(zh.length, 2);
assert.deepEqual(matchReadingSentences(sentences, zh), [], "equal counts do not imply corresponding sentences");
assert.deepEqual(matchReadingSentences(sentences, readingSentences("图2显示用量为3.5毫克，结果持续存在。")), [], "a merged translation is not a one-to-one pair");
assert.equal(matchReadingSentences([sentences[0]], [zh[0]]).length, 1);
assert.deepEqual(matchReadingSentences(readingSentences("Caption fragment"), [zh[0]]), []);

const first = { blockId: "p-4", en: sentences[0].text, "zh-CN": zh[0].text };
const second = { blockId: "p-4", en: sentences[1].text, "zh-CN": zh[1].text };
const digestEn = "e".repeat(64), digestZh = "b".repeat(64);
const metadata = { schemaVersion: 1, digests: { en: digestEn, "zh-CN": digestZh }, pairs: [first, second] };
assert.deepEqual(readSentenceAlignment(metadata, digestEn, "c".repeat(64)), [], "a translation edit invalidates stored sentence matches");
assert.deepEqual(readSentenceAlignment(metadata, "c".repeat(64), digestZh), [], "an original edit also invalidates stored matches");
assert.deepEqual(matchReadingSentences(sentences, zh, readSentenceAlignment(metadata, digestEn, digestZh)), [[sentences[0], zh[0]], [sentences[1], zh[1]]]);
assert.deepEqual(matchReadingSentences(sentences, zh, [first, { ...second, en: first.en }]), [], "one English sentence cannot point to two translations");
assert.deepEqual(matchReadingSentences(sentences, zh, [first, { ...second, "zh-CN": first["zh-CN"] }]), [], "one translation cannot point to two English sentences");
assert.deepEqual(matchReadingSentences(readingSentences(first.en + " " + first.en), zh, [first]), [], "duplicate wording cannot supply a unique range");
assert.deepEqual(matchReadingSentences(sentences, zh, [{ ...first, en: "Unverified sentence." }]), []);

const align = (a, b) => matchReadingSentences(readingSentences(a), readingSentences(b)).map(pair => pair.map(s => s.text));
const lead = "We compared the Xenium and MERSCOPE arrays.", leadZh = "我们比较了 Xenium 和 MERSCOPE 阵列。";
const middle = "It remained robust.", middleZh = "它依然稳定可靠。";
const tail = "We measured 78 and 18 values with CosMX.", tailZh = "我们用 CosMX 测得 78 和 18 两个数值。";
assert.deepEqual(align([lead, middle, tail].join(" "), leadZh + middleZh + tailZh), [[lead, leadZh], [middle, middleZh], [tail, tailZh]]);
assert.deepEqual(align([lead, middle, tail].join(" "), leadZh + middleZh + tailZh.replace("18", "19")), [[lead, leadZh]], "number conflict blocks the anchor and its would-be gap");
assert.deepEqual(align([lead, tail].join(" "), tailZh + leadZh), [], "crossing anchors do not license sentence matches");
assert.deepEqual(align([lead, tail, "Other results followed."].join(" "), leadZh.slice(0, -1) + "，" + tailZh + "接着还有其他结果。"), [], "merged candidates with conflicting anchors remain dark");
assert.deepEqual(align(lead + " " + tail, leadZh + "这句话翻译时被拆开了。" + tailZh), [], "an isolated anchor can point to only half of a split translation");
const suffix = "Orbitrap and Agilent verified the signal.", suffixZh = "使用 Orbitrap 和 Agilent 验证了信号。";
assert.deepEqual(align([lead, middle, tail, suffix].join(" "), leadZh + "这一点没有改变。结果依然稳定。" + tailZh + suffixZh),
	[[tail, tailZh], [suffix, suffixZh]], "a split does not shift the next run of neighboring anchors");
assert.deepEqual(align(lead + " " + lead, leadZh + leadZh), [], "repeated anchors cannot select either occurrence");
assert.equal(readingSentences("We used MS/MS. Another experiment followed.")[0].complete, false, "a possible two-sentence span is not highlighted as one");
const scaled = "Novae analyzed 30 million cells across 18 tissues. Another test followed.";
const scaledZh = "Novae 分析了 18 种组织中的 3000 万个细胞。随后进行了另一项测试。";
assert.equal(align(scaled, scaledZh).length, 1, "decimal-scale words compare as the same quantity");
const referenceHints = (text, refs) => readingSentences(text, refs.map(id => {
	const start = text.indexOf("[" + id + "]");
	return { start, end: start + id.length + 2, key: "ref:" + id };
}));
const citedEn = referenceHints("A measurement [71] [83] agreed. Another result followed.", ["71", "83"]);
const citedZh = referenceHints("一项测量 [71] [83] 得到一致结果。随后有另一项结果。", ["71", "83"]);
assert.equal(matchReadingSentences(citedEn, citedZh).length, 1);
assert.equal(matchReadingSentences(citedEn, referenceHints("一项测量 [71] [82] 得到一致结果。随后有另一项结果。", ["71", "82"])).length, 0);

console.log("BILINGUAL_SENTENCES_OK: scientific punctuation, explicit records, local anchors, conflicts and gaps");
