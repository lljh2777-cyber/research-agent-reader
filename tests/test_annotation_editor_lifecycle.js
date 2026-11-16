"use strict";
// Memory-only editor events against the production popover. No files, models or cleanup.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
class Element extends EventTarget {
	constructor(tag = "div") { super(); this.tag = tag; this.children = []; this.dataset = {}; this.value = ""; this.disabled = false; }
	createEl(tag, options = {}) { const child = new Element(tag); child.text = options.text || ""; child.attributes = options.attr || {}; child.cls = options.cls; child.parent = this; this.children.push(child); return child; }
	createDiv(options) { return this.createEl("div", options); }
	createSpan(options) { return this.createEl("span", options); }
	empty() { for (const child of this.children) child.parent = undefined; this.children = []; }
	contains(child) { return child === this || this.all().includes(child); }
	focus() {}
	matches(selector) { return selector === ":focus-visible"; }
	setAttribute(name, value) { (this.attributes ||= {})[name] = value; }
	setText(text) { this.text = text; }
	all() { return this.children.flatMap(child => [child, ...child.all()]); }
	fire(type, properties = {}) { const event = new Event(type, { cancelable: true }); Object.assign(event, properties); let current = this; while (current) { current.dispatchEvent(event); current = current.parent; } }
}
class Scope { register(modifiers, key, run) { this.save = run; } }
const { normalizeAnnotationColorMeanings } = loadReading("annotations/colors.ts");
const { AnnotationPopover } = loadReading("annotations/annotation-popover.ts", { obsidian: { Component: class {}, Scope, Notice: class {}, setIcon() {} } });
globalThis.window = { confirm: () => true };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(record = { id: "ann-1", annotationPath: "wiki/annotations/source.md", sourcePath: "source.md", selectedText: "Selected source", manualText: "saved", aiText: "existing AI", aiProvider: "provider", archiveTargets: [] }) {
	const calls = [], waiting = [];
	const save = async (base, draft) => {
		calls.push(structuredClone(draft)); await new Promise(resolve => waiting.push(resolve));
		return { id: "ann-1", sourcePath: "source.md", selectedText: "Selected source", archiveTargets: [], ...base, ...draft, color: draft.color === "none" ? undefined : draft.color };
	};
	const service = { updateAnnotation: save, saveSelectionAnnotation: (_selection, draft) => save(undefined,draft) };
	const scopes = [], app = { keymap: { pushScope(scope) { scopes.push(scope); }, popScope(scope) { scopes.splice(scopes.indexOf(scope), 1); } } };
	const popover = new AnnotationPopover({ app, service, anchorRect: {}, record, selection: { sourcePath: "source.md", selectedText: "Selected source", sourceRevision: {} }, colorMeanings: normalizeAnnotationColorMeanings({ blue: "  样本与模型  ", green: "", red: 9, unknown: "ignore" }), onArchive: async () => {} });
	const element = popover.element = new Element(); popover.closed = false;
	popover.position = () => {};
	const controls = () => {
		const found = element.all(), fields = found.filter(e => e.tag === "textarea");
		return { note: fields[0], ai: fields[1], save: found.find(e => e.text === "保存"), color: key => found.find(e => e.attributes?.["data-color"] === key), list: found.find(e => e.text === "收录摘录") };
	};
	const finish = async () => { waiting.splice(0).forEach(resolve => resolve()); await flush(); };
	popover.renderForm();
	return { popover, element, calls, controls, finish, scopes, service };
}
(async () => {
	const f = fixture(), first = f.controls();
	const tooltip = f.element.all().find(e => e.cls === "agent-annotation-color-tooltip");
	assert.equal(tooltip.hidden, true);
	first.color("blue").fire("mouseenter");
	assert.equal(tooltip.hidden, false);
	assert.equal(tooltip.text, "蓝色 · 样本与模型");
	assert.equal(first.color("blue").attributes["aria-label"], tooltip.text);
	first.color("blue").fire("mouseleave");
	assert.equal(tooltip.hidden, true);
	first.color("red").fire("focus");
	assert.equal(tooltip.hidden, false);
	assert.equal(tooltip.text, "红色 · 疑点与限制");
	first.color("red").fire("blur");
	assert.equal(tooltip.hidden, true);
	for (const [color, label] of Object.entries({ green: "绿色 · 数据与证据", yellow: "黄色 · 主要结论", purple: "紫色 · 概念与定义", none: "无颜色" })) {
		assert.equal(first.color(color).attributes["aria-label"], label);
	}
	assert.equal(first.color("blue").text, "", "the tooltip adds no persistent label");
	assert.deepEqual(Object.keys(normalizeAnnotationColorMeanings({ unknown: "ignore" })).sort(), ["blue", "green", "purple", "red", "yellow"]);
	first.note.value = "current draft"; first.note.fire("input"); first.color("blue").fire("click");
	assert.equal(f.scopes[0].save(), false, "host shortcut is consumed");
	first.save.fire("click");
	assert.equal(f.calls.length, 1, "save and shortcut cannot overlap");
	assert.deepEqual(f.calls[0], { manualText: "current draft", color: "blue" });
	await f.finish();
	assert.equal(f.scopes.length, 1, "the saved form owns exactly one shortcut");
	const reopened = f.controls();
	assert.equal(reopened.note.value, "current draft");
	assert.equal(reopened.color("blue").attributes["aria-pressed"], "true");
	reopened.color("none").fire("click");
	reopened.save.fire("click"); await f.finish();
	assert.equal(f.calls[1].color, "none");
	const fresh = fixture(null), initial = fresh.controls();
	initial.color("red").fire("click"); initial.list.fire("click"); initial.save.fire("click");
	assert.equal(fresh.calls[0].color, "red"); assert.equal(fresh.calls[0].excerptListed, true); await fresh.finish();
	const failure = fixture(); failure.service.updateAnnotation = async () => { throw new Error("disk unavailable"); };
	const failed = failure.controls();
	failed.note.value = "keep this draft"; failed.note.fire("input"); failed.save.fire("click"); await flush();
	assert.equal(failed.note.value, "keep this draft"); assert.equal(failed.save.disabled, false);
	assert.equal(failure.element.dataset.dirty, "true");
	const late = fixture(), old = late.controls();
	old.note.value = "written"; old.note.fire("input"); old.save.fire("click"); late.popover.closed = true;
	await late.finish(); assert.equal(late.popover.record.manualText, "saved");
	assert.ok(late.element.all().includes(old.note), "late saves cannot rebuild a closed form");
	console.log("ANNOTATION_EDITOR_LIFECYCLE_TEST_OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
