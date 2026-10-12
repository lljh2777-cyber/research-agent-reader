"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { DEFAULT_SETTINGS, normalizeReaderModeSettings } = loadReading("runtime/settings.ts");
const { MineruReaderView } = loadReading("views/mineru-reader.ts", {
	obsidian: { ItemView: class { constructor(leaf) { this.leaf = leaf; } }, Component: class {}, TFile: class {} },
});

const entry = "Clippings/sample/paper.md";
const defaults = normalizeReaderModeSettings({});
assert.equal(defaults.mineruReaderDefaultMode, "pdf", "existing installations keep their ordinary default");
assert.equal(defaults.mineruReaderBilingualLinked, true);
assert.equal(defaults.mineruReaderBilingualSplitRatio, 0.5);
assert.equal(normalizeReaderModeSettings({ mineruReaderDefaultMode: "visuals" }).mineruReaderDefaultMode, "visuals");
assert.equal(normalizeReaderModeSettings({ mineruReaderDefaultMode: "invalid" }).mineruReaderDefaultMode, "pdf");
for (const value of [null, "0.6", NaN, Infinity]) {
	assert.equal(normalizeReaderModeSettings({ mineruReaderBilingualSplitRatio: value }).mineruReaderBilingualSplitRatio, 0.5);
}
assert.equal(normalizeReaderModeSettings({ mineruReaderBilingualSplitRatio: 0.1 }).mineruReaderBilingualSplitRatio, 0.3);
assert.equal(normalizeReaderModeSettings({ mineruReaderBilingualSplitRatio: 0.9 }).mineruReaderBilingualSplitRatio, 0.7);

const make = (stored) => {
	const settings = { ...DEFAULT_SETTINGS, ...normalizeReaderModeSettings(stored) };
	const view = new MineruReaderView({}, { app: {}, settings });
	view.requestStateSave = () => {};
	return { view, settings };
};

(async () => {
	const { view, settings } = make({ mineruReaderDefaultMode: "bilingual", mineruReaderBilingualLinked: false, mineruReaderBilingualSplitRatio: 0.6 });
	await view.setState({ articlePath: entry }, {});
	assert.equal(view.getState().bilingual, true, "fresh English entry uses the bilingual default");
	assert.equal(view.getState().bilingualRatio, 0.6);
	await view.setState({ articlePath: entry, mode: "visuals" }, {});
	assert.equal(view.getState().bilingual, false, "legacy saved reference mode without a bilingual flag also wins over new defaults");
	assert.equal(view.getState().mode, "visuals");
	await view.setArticlePath("Clippings/another/paper.zh-CN.md");
	assert.equal(view.getState().bilingual, true, "reused reader also applies the default to a new Chinese entry");
	await view.setArticlePath("Clippings/ordinary.md");
	assert.equal(view.getState().bilingual, false, "ordinary files are never forced into bilingual reading");

	const saved = { linked: true, active: "zh-CN", positions: { en: { blockId: "b-2", progress: 0.4 } } };
	await view.setState({ articlePath: entry, bilingual: false, bilingualRatio: 0.42, bilingualState: saved }, {});
	assert.equal(view.getState().bilingual, false, "saved manual ordinary mode wins over new defaults");
	assert.equal(view.getState().bilingualRatio, 0.42);
	assert.deepEqual(view.getState().bilingualState, saved);
	settings.mineruReaderDefaultMode = "pdf";
	await view.setState({ articlePath: entry, bilingual: true, bilingualRatio: 0.58, bilingualState: saved }, {});
	assert.equal(view.getState().bilingual, true, "saved bilingual mode survives a different global default");
	assert.equal(view.getState().bilingualRatio, 0.58);
	view.readerPackage = {};
	await view.setArticlePath(entry);
	assert.equal(view.getState().bilingualRatio, 0.58, "reopening the same document keeps the current layout");

	let renders = 0;
	view.renderWorkspace = async () => { renders++; };
	view.bilingualReader = { snapshot: () => saved };
	view.switchReaderLayout(false);
	assert.equal(view.getState().bilingual, false);
	assert.deepEqual(view.getState().bilingualState, saved, "switching layout retains source-bound positions");
	view.switchReaderLayout(true);
	assert.equal(view.getState().bilingual, true);
	assert.equal(renders, 2);
	view.bilingualReader = null;
	await view.setArticlePath("papers/sample/article.md");
	view.switchReaderLayout(true);
	assert.equal(view.getState().bilingual, false, "unsupported sources reject a programmatic bilingual choice");

	console.log("READER_PREFERENCES_OK: legacy defaults, validation, new-document routing, saved overrides and mode switching");
})().catch(error => { console.error(error); process.exitCode = 1; });
