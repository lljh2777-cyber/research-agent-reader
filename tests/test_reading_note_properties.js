"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { readNoteProperties, notePropertyUrl } = loadReading("reader/note-properties.ts");
const { normalizeBilingualState } = loadReading("reader/bilingual-position.ts");
const { normalizeManualSplit } = loadReading("reader/manual-split.ts");

const yaml = 'title: "Original title"\r\ntitleZh: "译文标题"\r\ndescription: |\r\n  First line\r\n  Second line\r\n';
const text = "\uFEFF---\r\n" + yaml + "---\r\n\r\n# First heading\r\n正文。";
const parse = header => {
	assert.equal(header, yaml, "pass only the original header to Obsidian's YAML parser");
	return { title: "Original title", titleZh: "译文标题", description: "First line\nSecond line",
		author: ["[[First Author]]", "Second Author"], tags: ["clippings"],
		published: new Date("2023-05-31T00:00:00Z"), verified: false, count: 0, empty: null };
};
const en = readNoteProperties("papers/paper.md", text, parse, "en");
const zh = readNoteProperties("papers/paper.zh-CN.md", text, parse, "zh-CN");
assert.equal(en.title, "Original title");
assert.equal(zh.title, "译文标题");
assert.equal(en.fields.find(field => field.key === "description").values[0], "First line\nSecond line");
assert.deepEqual(en.fields.find(field => field.key === "author"), { key: "author", values: ["[[First Author]]", "Second Author"], list: true });
assert.deepEqual(en.fields.slice(-4).map(field => field.values), [["2023-05-31"], ["false"], ["0"], []]);
assert.equal(readNoteProperties("paper.md", "---\nnot: [closed\n...\n\n# **Visible** title\n", () => { throw Error("bad yaml"); }).title, "Visible title");
assert.equal(readNoteProperties("folder/notes.md", "Body\n---\ntitle: Ignore\n---", () => assert.fail("do not parse a fence in the body")).title, "notes");
assert.equal(readNoteProperties("paper.md", "    # Indented code", () => assert.fail("no header")).title, "paper");
assert.deepEqual(readNoteProperties("paper.md", "---\n" + "a".repeat(128 * 1024) + "\n---\n", () => assert.fail("do not parse an oversized header")).fields, []);
assert.equal(notePropertyUrl("https://www.nature.com/articles/abc"), "https://www.nature.com/articles/abc");
for (const unsafe of ["javascript:alert(1)", "file:///C:/x", "obsidian://open", "https://user:password@example.test/", "https://example.test/ has spaces"])
	assert.equal(notePropertyUrl(unsafe), undefined);

const doc = { syncAvailable: false, selectedFiles: {}, files: { en: { digest: "en", blocks: [] }, "zh-CN": { digest: "zh", blocks: [] } } };
const preferences = { language: "zh-CN", expanded: true };
assert.deepEqual(normalizeBilingualState({ noteProperties: preferences }, doc).noteProperties, preferences, "note properties remain available in a progress-only pair");
assert.equal(normalizeBilingualState({ noteProperties: { language: "pdf", expanded: "yes" } }, doc).noteProperties, undefined);
assert.equal(normalizeBilingualState({}, doc).noteProperties, undefined, "old layouts default to collapsed properties");
assert.deepEqual(normalizeManualSplit({ left: "paper.md", right: "paper.pdf", noteProperties: preferences }).noteProperties, { expanded: true });
console.log("READING_NOTE_PROPERTIES_OK: bounded frontmatter, exact source language, fallbacks, safe links and restored controls");
