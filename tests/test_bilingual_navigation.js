"use strict";
const assert = require("node:assert/strict"), { loadReading } = require("./reading-test-helpers");
const { BilingualReader } = loadReading("views/bilingual-reader.ts", { obsidian: { Component: class {}, ItemView: class {} } });
const { splitOutlineHeadings } = loadReading("views/split-outline.ts", { obsidian: { ItemView: class {} } });
const doc = { syncAvailable: true, files: { en: { path: "paper.md", digest: "en", blocks: [{ id: "b-0" }] }, "zh-CN": { path: "paper.zh-CN.md", digest: "zh", blocks: [{ id: "b-0" }] } } };
const controller = new AbortController(), reader = new BilingualReader({ document: doc, signal: controller.signal, defaultLinked: false });
const captured = [], synchronized = []; let published = 0, notice;
reader.capture = language => captured.push(language); reader.synchronize = language => synchronized.push(language); reader.publish = () => published++;
reader.message = { setText: text => notice = text };
const outer = { scrollTop: 11, scrollLeft: 7 };
function fixture(language) {
	const scroller = { scrollTop: 60, scrollHeight: 1200, clientHeight: 200, clientTop: 2, getBoundingClientRect: () => ({ top: 100 }) };
	const target = { id: "ref: 1", top: 620, height: 40, getBoundingClientRect() { return { top: 102 + this.top - scroller.scrollTop, height: this.height }; }, scrollIntoView() { throw new Error("ancestor scrolling is forbidden"); } };
	const source = { ...target, id: "fnref-1", top: 20 };
	const anchor = href => ({ href, getAttribute(key) { return key === "href" ? this.href : null; }, setAttribute(key, value) { if (key === "href") this.href = value; }, closest() { return this; } });
	const link = anchor("#ref%3A%201"), back = anchor("#fnref-1"), missing = anchor("#missing"), external = anchor("https://example.test/#ref-1");
	const nodes = new Set([target, source, link, back, missing, external]); let handler, capture;
	const article = { contains: node => nodes.has(node), querySelectorAll: selector => selector === "[id]" ? [target, source] : [link, back, missing, external],
		addEventListener(type, fn, options) { assert.equal(type, "click"); handler = fn; capture = options.capture; assert.equal(options.signal, controller.signal); } };
	reader.panes.set(language, { article, scroller }); reader.scopeLinks(article, language);
	const click = (a, nested = false) => {
		const event = { target: nested ? { closest: () => a } : a, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
		assert.equal(capture, true, "reader handles clicks before native target and bubbling footnote handlers"); handler(event);
		if (a !== external && !event.stopped) outer.scrollTop = 999; // A native footnote handler must not get this event.
		return event;
	};
	return { scroller, target, source, link, back, missing, external, click };
}
const en = fixture("en"), zh = fixture("zh-CN");
assert.equal(en.link.href, "#bilingual-en-ref: 1"); assert.equal(zh.link.href, "#bilingual-zh-CN-ref: 1");
const event = zh.click(zh.link, true); assert.ok(event.prevented && event.stopped);
assert.equal(zh.scroller.scrollTop, 620); assert.equal(en.scroller.scrollTop, 60); assert.equal(reader.state.active, "zh-CN");
assert.deepEqual(outer, { scrollTop: 11, scrollLeft: 7 }); assert.deepEqual(captured, ["zh-CN"]); assert.equal(published, 1);
zh.click(zh.back); assert.equal(zh.scroller.scrollTop, 20); assert.equal(en.scroller.scrollTop, 60);
console.log("OK encoded citations, nested click targets and backlinks move only their own pane before native handlers");

reader.state.linked = true; en.click(en.link); assert.deepEqual(synchronized, ["en"]); assert.equal(reader.state.active, "en");
reader.scrollToElement("en", en.target, "center"); assert.equal(en.scroller.scrollTop, 540);
en.target.top = 5000; en.click(en.link); assert.equal(en.scroller.scrollTop, 1000);
en.target.top = -10; en.click(en.link); assert.equal(en.scroller.scrollTop, 0);
console.log("OK linked navigation preserves the clicked language; excerpt centering and edge targets stay within pane bounds");

const before = [zh.scroller.scrollTop, en.scroller.scrollTop, published, synchronized.length];
assert.ok(zh.click(zh.missing).prevented); assert.match(notice, /未找到/);
assert.equal(zh.click(zh.external).prevented, false);
reader.invalidated = true; assert.ok(zh.click(zh.link).prevented); reader.invalidated = false;
controller.abort(); assert.ok(en.click(en.link).prevented);
assert.deepEqual([zh.scroller.scrollTop, en.scroller.scrollTop, published, synchronized.length], before);
assert.deepEqual(reader.state.digests, { en: "en", "zh-CN": "zh" }); assert.deepEqual(outer, { scrollTop: 11, scrollLeft: 7 });

{
	const marker = () => ({ closest: () => null, hasAttribute: () => true });
	const heading = (tagName, top, title = "Repeated heading", embedded = false) => ({
		tagName, textContent: title, closest: () => embedded ? {} : null, hasAttribute: () => false, top,
	});
	const enFirst = heading("H2", 200), enSecond = heading("H3", 930);
	const zhFirst = heading("H2", 310), zhSecond = heading("H3", 780);
	function outline(first, second, firstId, secondId, language) {
		const firstMarker = marker(), secondMarker = marker();
		const elements = [firstMarker, first, secondMarker, heading("H2", 750, "Embedded heading", true), second];
		const article = { contains: el => elements.includes(el), querySelectorAll: () => elements };
		const scroller = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
		for (const node of [first, second]) node.getBoundingClientRect = () => ({ top: node.top - scroller.scrollTop, height: 24 });
		return { article, scroller, headings: splitOutlineHeadings(article, new Map([[firstMarker, firstId], [secondMarker, secondId]])), language };
	}
	const english = outline(enFirst, enSecond, "en-a", "en-b", "en");
	const chinese = outline(zhFirst, zhSecond, "zh-a", "zh-b", "zh-CN");
	assert.deepEqual(english.headings.map(h => [h.title, h.level, h.blockId]), [["Repeated heading", 2, "en-a"], ["Repeated heading", 3, "en-b"]]);
	const headings = { en: english.headings, "zh-CN": chinese.headings };
	const signal = new AbortController();
	const pairedDoc = {
		syncAvailable: true, selectedFiles: {}, files: doc.files,
		pairs: [{ en: { id: "en-a" }, "zh-CN": { id: "zh-a" } }, { en: { id: "en-b" }, "zh-CN": { id: "zh-b" } }],
	};
	const view = new BilingualReader({ document: pairedDoc, signal: signal.signal, defaultLinked: true });
	view.panes.set("en", english); view.panes.set("zh-CN", chinese); view.restoring = false;
	view.capture = lang => { view.state.positions[lang] = { blockId: lang + "-different", progress: 0 }; };
	global.cancelAnimationFrame = () => {};
	view.jumpToHeading("en", headings.en[1].id, headings);
	assert.equal(english.scroller.scrollTop, 800, "source scroll can be clamped at the end");
	assert.equal(chinese.scroller.scrollTop, 780, "exact paired heading is used even if captured source position differs");
	assert.ok(view.programmatic.has("en") && view.programmatic.has("zh-CN"));
	view.state.linked = false;
	view.jumpToHeading("zh-CN", headings["zh-CN"][0].id, headings);
	assert.equal(chinese.scroller.scrollTop, 310); assert.equal(english.scroller.scrollTop, 800);
	view.state.linked = true; pairedDoc.syncAvailable = false;
	view.jumpToHeading("en", headings.en[0].id, headings);
	assert.equal(english.scroller.scrollTop, 200); assert.equal(chinese.scroller.scrollTop, 310, "an unpaired outline jump never syncs by progress");
	signal.abort();
	view.jumpToHeading("en", headings.en[1].id, headings);
	assert.equal(english.scroller.scrollTop, 200);
	delete global.cancelAnimationFrame;
	console.log("OK distinct duplicate headings, exact paired navigation at scroll bounds, and local-only jumps with no valid pairing");
}
console.log("BILINGUAL_NAVIGATION_OK (4 groups; simulated DOM, memory only, no cleanup or model calls)");
