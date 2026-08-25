"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.resolve(
	__dirname,
	"../node_modules/esbuild",
));

const pluginRoot = path.resolve(__dirname, "..");

function read(relativePath) {
	return fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
}

function loadTsModule(relativePath) {
	const entry = path.join(pluginRoot, relativePath);
	const result = esbuild.buildSync({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		target: "node18",
		logLevel: "silent",
	});
	const output = result.outputFiles[0].text;
	const loaded = new Module(entry, module);
	loaded.filename = entry;
	loaded.paths = Module._nodeModulePaths(path.dirname(entry));
	loaded._compile(output, entry);
	return loaded.exports;
}

const clipping = loadTsModule("src/reader/clipping-markdown.ts");
const readerMarkdown = loadTsModule("src/mineru/reader-markdown.ts");
const runtimeSettings = loadTsModule("src/runtime/settings.ts");

assert.deepEqual(
	runtimeSettings.normalizeReaderMarkdownFolders("papers\nClippings\npapers\n../outside\nD:\\vault"),
	["papers", "Clippings"],
);

const source = `---
title: "Example clipping"
---
# Example clipping

Opening body remains visible.

![Fig. 1](https://cdn.example.test/paper_Fig1_HTML.jpg)

First figure caption with **formatted** evidence.

Body between figures remains visible.

![](https://cdn.example.test/paper_Fig4_HTML.jpg)

Fourth figure caption without a label.

![](https://cdn.example.test/asset-final.jpg)

Fallback figure caption.

![](https://cdn.example.test/no-caption.jpg)

## This heading is not a caption
`;

const figures = clipping.extractClippingFigures(source);
assert.equal(figures.length, 4);
assert.deepEqual(figures.map((figure) => figure.label), ["Fig. 1", "Fig. 4", "Fig. 3", "Fig. 5"]);
assert.equal(figures[0].caption, "First figure caption with formatted evidence.");
assert.equal(figures[1].caption, "Fourth figure caption without a label.");
assert.equal(figures[3].caption, "");

const readerPackage = clipping.buildMarkdownReaderPackage(source, "Clippings/Example clipping.md");
assert.equal(readerPackage.sourceKind, "markdown");
assert.equal(readerPackage.title, "Example clipping");
assert.equal(readerPackage.packagePath, "Clippings");
assert.equal(readerPackage.pdfPath, null);
assert.equal(readerPackage.visuals.length, 4);
assert.doesNotMatch(readerPackage.articleMarkdown, /title: "Example clipping"/);
assert.deepEqual(
	readerPackage.visuals.map((visual) => visual.memberMarkdownImageIds[0]),
	["md-img-0000", "md-img-0001", "md-img-0002", "md-img-0003"],
);

const prepared = readerMarkdown.prepareReaderMarkdown(
	source,
	readerPackage.visuals,
	readerPackage.viewerIndex,
);
assert.equal((prepared.match(/data-visual-id=/g) || []).length, 4);
assert.doesNotMatch(prepared, /cdn\.example\.test/);
assert.doesNotMatch(prepared, /First figure caption/);
assert.doesNotMatch(prepared, /Fourth figure caption/);
assert.match(prepared, /Opening body remains visible/);
assert.match(prepared, /Body between figures remains visible/);
assert.match(prepared, /This heading is not a caption/);

const plugin = read("src/plugin.ts");
const view = read("src/views/mineru-reader.ts");
const settings = read("src/runtime/settings.ts");
const settingsTab = read("src/settings/settings-tab.ts");
assert.match(plugin, /isConfiguredReaderMarkdownFile/);
assert.match(plugin, /getActiveViewOfType\(MarkdownView\)/);
assert.match(plugin, /readerAutoOpenBypass/);
assert.match(view, /sourceKind === "markdown"/);
assert.match(
	view,
	/sourceKind === "markdown" && !this\.readerState\.markdownAnchor\)[\s\S]{0,180}markdownScroller\?\.scrollTo\(\{ top: 0, behavior: "auto" \}\);[\s\S]{0,40}return;/,
);
assert.doesNotMatch(view, /article\.scrollIntoView\(\{ block: "start" \}\)/);
assert.match(view, /getFirstLinkpathDest/);
assert.match(settings, /readerMarkdownFolders: \["papers", "Clippings"\]/);
assert.match(settingsTab, /默认阅读目录/);

console.log("DASHBOARD_MARKDOWN_READER_TESTS_OK");
