"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadReading } = require("./reading-test-helpers");

class Component {
	register(cleanup) { this.cleanup = cleanup; }
	unload() { this.cleanup(); }
}
class TFile { path = "paper.pdf"; }
const { SplitPdfPane } = loadReading("views/split-pdf-pane.ts", { obsidian: {
	Component, TFile,
	loadPdfJs: async () => ({
		getDocument: () => ({ promise: Promise.resolve({ numPages: 1 }), destroy: async () => {} }),
	}),
} });

function fixture(t) {
	const previousWindow = globalThis.window;
	const previousObserver = globalThis.ResizeObserver;
	const counts = { created: 0, observed: 0, disconnected: 0 };
	const scroller = {};
	globalThis.window = { clearTimeout };
	globalThis.ResizeObserver = class {
		constructor() { counts.created++; }
		observe(target) { assert.equal(target, scroller); counts.observed++; }
		disconnect() { counts.disconnected++; }
	};
	t.after(() => {
		globalThis.window = previousWindow;
		globalThis.ResizeObserver = previousObserver;
	});
	const file = new TFile();
	const app = { vault: { getAbstractFileByPath: () => file, readBinary: async () => Uint8Array.of(1) } };
	const heading = { createEl: () => new EventTarget(), createSpan: () => ({}) };
	const controller = new AbortController();
	const pane = new SplitPdfPane(app, file, heading, scroller, controller.signal, () => {});
	pane.showPage = async () => {};
	return { pane, controller, counts };
}

test("unloading during the first page draw leaves no resize observer", async t => {
	const { pane, counts } = fixture(t);
	let enterDraw, finishDraw;
	const entered = new Promise(resolve => { enterDraw = resolve; });
	const drawing = new Promise(resolve => { finishDraw = resolve; });
	pane.showPage = () => { enterDraw(); return drawing; };
	const rendering = pane.render(1, 0);
	await entered;
	pane.unload();
	finishDraw();
	await rendering;
	assert.equal(counts.created, counts.disconnected);
	assert.equal(counts.created, 0);
});

test("closing after the first draw disconnects the observed scroller once", async t => {
	const { pane, controller, counts } = fixture(t);
	await pane.render(1, 0);
	assert.deepEqual(counts, { created: 1, observed: 1, disconnected: 0 });
	controller.abort();
	assert.equal(counts.disconnected, 1);
});

test("component cleanup after abort does not disconnect twice", async t => {
	const { pane, controller, counts } = fixture(t);
	await pane.render(1, 0);
	controller.abort();
	assert.doesNotThrow(() => pane.unload());
	assert.deepEqual(counts, { created: 1, observed: 1, disconnected: 1 });
});
