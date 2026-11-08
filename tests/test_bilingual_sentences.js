"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { readingSentences, matchReadingSentences, readSentenceAlignment } = loadReading("reader/bilingual-sentences.ts");
const { normalizeBilingualState } = loadReading("reader/bilingual-position.ts");

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

const doc = { syncAvailable: true, files: { en: { digest: digestEn, blocks: [] }, "zh-CN": { digest: digestZh, blocks: [] } } };
assert.equal(normalizeBilingualState({}, doc).sentenceHover, undefined);
assert.equal(normalizeBilingualState({ sentenceHover: true, linked: false }, doc).sentenceHover, true);
assert.equal(normalizeBilingualState({ sentenceHover: true }, { ...doc, syncAvailable: false }).sentenceHover, undefined);
console.log("BILINGUAL_SENTENCES_OK: scientific punctuation, unique version-bound pairs, ambiguous cases and opt-in state");
