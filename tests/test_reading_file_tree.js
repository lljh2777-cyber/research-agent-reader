"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { readingFileTree, readingFolderAncestors, readingLanguageHint, bilingualFileOrder } = loadReading("reader/reading-file-tree.ts");
const files = ["Study/source.md", "Study/paper.zh-CN.md", "Study/_work/chunks/10.md", "Study/_work/chunks/2.md", "Other/source.md", "root.md", "Study/source.md", "Assets/source.PDF", "Study/images/figure.png", "../outside.md"];
const flatten = nodes => nodes.flatMap(node => node.kind === "folder" ? [node, ...flatten(node.children)] : [node]);

const tree = readingFileTree(files, "md", "Study/paper.zh-CN.md");
assert.deepEqual(tree.map(node => [node.kind, node.name]), [["folder", "Other"], ["folder", "Study"], ["file", "root.md"]]);
assert.deepEqual(flatten(tree).filter(node => node.kind === "file").map(node => node.path), ["Other/source.md", "Study/_work/chunks/2.md", "Study/_work/chunks/10.md", "Study/source.md", "root.md"]);
assert.deepEqual(tree[1].children.map(node => node.name), ["_work", "source.md"]);
console.log("OK directory hierarchy, duplicate names, numeric order, exclusion and type filtering");

const search = readingFileTree(files, "md", "Study/paper.zh-CN.md", "STUDY chunks 10");
assert.deepEqual(flatten(search).map(node => node.path), ["Study", "Study/_work", "Study/_work/chunks", "Study/_work/chunks/10.md"]);
assert.deepEqual(readingFileTree(files, "md", "Study/source.md", "not-present"), []);
assert.deepEqual(readingFileTree(files, "pdf", "root.md")[0].children.map(node => node.path), ["Assets/source.PDF"]);
console.log("OK search preserves ancestors, handles tokens and empty results; PDF selection is case insensitive");

assert.deepEqual(readingFolderAncestors("Study/_work/chunks/10.md"), ["Study", "Study/_work", "Study/_work/chunks"]);
assert.deepEqual(readingFolderAncestors("root.md"), []);
for (const path of ["Study/paper.zh-CN.md", "中文译文.md", "paper.zh-Hans.MD"]) assert.equal(readingLanguageHint(path), "zh-CN");
for (const path of ["Study/paper.en.md", "English original.md", "英文原文.md"]) assert.equal(readingLanguageHint(path), "en");
for (const path of ["中文目录/article.md", "english folder/paper.md", "English 中文.md", "study.md"]) assert.equal(readingLanguageHint(path), undefined);
console.log("OK language hints use filenames only; ambiguous names require explicit confirmation");

assert.deepEqual(bilingualFileOrder("中文.md", "English.md", "zh-CN"), { left: "English.md", right: "中文.md" });
assert.deepEqual(bilingualFileOrder("English.md", "中文.md", "en"), { left: "English.md", right: "中文.md" });
// A user correction overrides a misleading filename hint.
assert.deepEqual(bilingualFileOrder("paper.zh-CN.md", "other.md", "en"), { left: "paper.zh-CN.md", right: "other.md" });
for (const args of [["a.md", "a.md", "en"], ["a.md", "b.pdf", "en"], ["a.md", "b.md", undefined], ["../a.md", "b.md", "en"]]) assert.throws(() => bilingualFileOrder(...args), /请确认/);
console.log("READING_FILE_TREE_OK (4 groups; memory only, no cleanup or model calls)");
