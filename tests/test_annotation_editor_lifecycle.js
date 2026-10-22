"use strict";
// Memory-only editor events against the production popover. No files, models or cleanup.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
class Element extends EventTarget {
	constructor(tag = "div") { super(); this.tag = tag; this.children = []; this.dataset = {}; this.value = ""; this.disabled = false; }
	createEl(tag, options = {}) { const child = new Element(tag); child.text = options.text || ""; child.parent = this; this.children.push(child); return child; }
	createDiv(options) { return this.createEl("div", options); }
	createSpan(options) { return this.createEl("span", options); }
	empty() { for (const child of this.children) child.parent = undefined; this.children = []; }
	focus() {}
	setText(text) { this.text = text; }
	all() { return this.children.flatMap(child => [child, ...child.all()]); }
	fire(type, properties = {}) { const event = new Event(type, { cancelable: true }); Object.assign(event, properties); let current = this; while (current) { current.dispatchEvent(event); current = current.parent; } }
}
const notices = [];
class Scope { register(modifiers, key, run) { this.save = run; } }
const { AnnotationPopover } = loadReading("annotations/annotation-popover.ts", { obsidian: { Component: class {}, Scope, Notice: class { constructor(text) { notices.push(text); } }, MarkdownRenderer: {}, setIcon() {} } });
globalThis.window = { setTimeout: fn => { fn(); return 0; }, confirm: () => true };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
	const calls = [], waiting = [];
	const service = { updateAnnotation: async (record, draft) => { calls.push(structuredClone(draft)); await new Promise(resolve => waiting.push(resolve)); return { ...record, ...draft }; } };
	const scopes = [], app = { keymap: { pushScope(scope) { scopes.push(scope); }, popScope(scope) { scopes.splice(scopes.indexOf(scope), 1); } } };
	const popover = new AnnotationPopover({ app, service, anchorRect: {}, record: { id: "ann-1", manualText: "saved", aiText: "existing AI", aiProvider: "provider", aiModel: "model", aiCli: { backend: "test" } }, onArchive: async () => {} });
	const element = popover.element = new Element(); popover.closed = false;
	popover.renderHeader = () => {}; popover.position = () => {};
	popover.renderFooter = parent => parent.createDiv();
	popover.renderExisting = () => popover.reset();
	const editor = () => { popover.renderEditor(); const controls = element.all(); return { manual: controls.filter(e => e.tag === "textarea")[0], ai: controls.filter(e => e.tag === "textarea")[1], save: controls.find(e => e.text === "保存"), cancel: controls.find(e => e.text === "取消") }; };
	const finish = async () => { waiting.splice(0).forEach(resolve => resolve()); await flush(); };
	return { popover, element, calls, waiting, editor, finish, scopes, service };
}
(async () => {
	const f = fixture();
	let controls = f.editor(); controls.manual.value = "discarded draft"; controls.cancel.fire("click");
	controls = f.editor(); controls.manual.value = "current draft"; controls.manual.fire("keydown", { key: "Enter", ctrlKey: true });
	assert.equal(f.calls.length, 1, "cancelled editors must not submit stale drafts on the next Ctrl+Enter");
	assert.equal(f.calls[0].manualText, "current draft");
	assert.equal(f.scopes.length, 1, "only the current editor owns a host keyboard scope");
	await f.finish();
	assert.equal(f.scopes.length, 0, "saved editor releases its host shortcuts");
	controls = f.editor(); controls.manual.value = "next saved draft"; controls.ai.fire("keydown", { key: "Enter", ctrlKey: true });
	assert.equal(f.calls.length, 2, "reopening an editor must not accumulate save listeners");
	assert.equal(f.calls[1].manualText, "next saved draft");
	assert.equal(f.calls[1].aiText, "existing AI");
	await f.finish();
	const busy = fixture(); controls = busy.editor(); controls.manual.value = "one write";
	controls.save.fire("click"); controls.manual.fire("keydown", { key: "Enter", ctrlKey: true }); controls.ai.fire("keydown", { key: "Enter", ctrlKey: true });
	assert.equal(busy.calls.length, 1, "keyboard repeats while saving must not start overlapping writes");
	await busy.finish();
	const scoped = fixture(); controls = scoped.editor(); controls.manual.value = "host shortcut draft";
	assert.equal(scoped.scopes[0].save(), false, "host shortcut is consumed before global bindings");
	assert.equal(scoped.calls.length, 1);
	assert.equal(scoped.calls[0].manualText, "host shortcut draft");
	await scoped.finish();
	controls = scoped.editor(); controls.cancel.fire("click");
	assert.equal(scoped.scopes.length, 0, "cancelled editor releases its host shortcuts");
	const failure = fixture(); failure.service.updateAnnotation = async () => { throw new Error("disk unavailable"); };
	controls = failure.editor(); controls.manual.value = "keep this draft"; controls.save.fire("click"); await flush();
	assert.equal(controls.manual.value, "keep this draft");
	assert.equal(controls.manual.disabled, false); assert.equal(controls.save.disabled, false); assert.equal(controls.cancel.disabled, false);
	assert.equal(failure.scopes.length, 1, "failed saves keep the current editor available");
	const late = fixture(); controls = late.editor(); controls.save.fire("click"); late.popover.closed = true; await late.finish();
	assert.equal(late.popover.record.manualText, "saved");
	assert.ok(late.element.all().includes(controls.manual), "late saves must not rebuild a closed popover");
	const fresh = fixture(); let creates = 0, release;
	fresh.popover.selection = { selectedText: "source" }; fresh.service.createAnnotation = async () => { creates++; await new Promise(resolve => { release = resolve; }); return { id: "new" }; };
	const save = new Element("button"), first = fresh.popover.saveNew({ manualText: "one note" }, save, false);
	assert.equal(await fresh.popover.saveNew({ manualText: "repeat" }, save, false), null);
	assert.equal(creates, 1); release(); await first;
	console.log("ANNOTATION_EDITOR_LIFECYCLE_TEST_OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
