"use strict";
// Small DOM adapter exercises async control boundaries; actual rendering is checked in Obsidian.
const assert = require("node:assert/strict"), path = require("node:path"), { loadReading } = require("./reading-test-helpers");
const base = require("./fulltext-pmc-fixtures.cjs"), f = require("./source-intake-fixtures.cjs");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Element {
	constructor(tag = "div", options = {}) { this.tag = tag; this.children = []; this.dataset = {}; this.value = options.value || ""; this.disabled = false; this.textContent = options.text || ""; this.attrs = options.attr || {}; }
	createEl(tag, options = {}) { const el = new Element(tag, options); this.children.push(el); return el; }
	createDiv(options) { return this.createEl("div", typeof options === "string" ? {} : options); }
	empty() { this.children = []; } addClass() {} setText(text) { this.textContent = text; } setAttribute(k, v) { this.attrs[k] = v; }
	querySelectorAll(selector) { const tags = selector.split(",").map(x => x.trim()); return this.children.flatMap(c => [...(tags.includes(c.tag) ? [c] : []), ...c.querySelectorAll(selector)]); }
	async decode() { await decodeGate?.promise; }
}
let decodeGate;
const { LocalPdfIntakeModal } = loadReading("views/local-pdf-intake.ts", { obsidian: { Modal: class { constructor() { this.contentEl = new Element(); } close() { this.onClose(); } } } });
const plan = () => ({ ...f.source(), requestId: "r-test", jobId: "s-test", snapshot: f.source().snapshot, existing: false, recovering: false, warnings: [] });
const tick = () => new Promise(r => setImmediate(r));
const button = (view, text) => view.contentEl.querySelectorAll("button").find(b => b.textContent === text);
function setup(overrides = {}) {
	const calls = [], service = { history: async () => [], cancel: id => calls.push(["cancel", id]), prepare: async () => plan(), present: async () => ({ dataUrl: f.raster().rasterDataUrl, digest: "shown-digest" }), save: async () => ({ phase: "saved", paperId: "p-saved" }), ...overrides };
	const view = new LocalPdfIntakeModal({}, service, path.resolve("vault"), async id => calls.push(["open", id]), async () => path.resolve("paper.pdf")); view.onOpen();
	view.file.value = path.resolve("paper.pdf"); view.identifier.value = base.ids.doi; view.identifier.oninput(); return { view, service, calls };
}
(async () => {
	// Stale resolver replies after cancel, editing or close cannot render or expose a Save action.
	for (const mode of ["cancel", "edit", "close"]) {
		const gate = deferred(), x = setup({ prepare: () => gate.promise }); const pending = x.view.run(async signal => x.view.preview(await x.service.prepare(), signal), "loading");
		if (mode === "close") x.view.close(); else if (mode === "edit") x.view.identifier.oninput(); else x.view.cancel.onclick();
		gate.resolve(plan()); await pending; assert.equal(x.view.plan, undefined); assert.equal(button(x.view, "身份一致，保存 PDF 原文"), undefined); assert.equal(x.calls[0][0], "cancel");
	}
	// PDF rendering alone never enables Save: successful browser image decoding is required.
	{
		decodeGate = deferred(); const x = setup(), pending = x.view.run(signal => x.view.preview(plan(), signal), "loading"); await tick();
		const save = button(x.view, "身份一致，保存 PDF 原文"); assert.equal(save.disabled, true); assert.equal(x.view.digest, "");
		decodeGate.resolve(); await pending; decodeGate = undefined; assert.equal(save.disabled, false); assert.equal(x.view.digest, "shown-digest");
		const page = x.view.result.querySelectorAll("input")[0]; page.value = "2"; page.oninput(); assert.equal(save.disabled, true); assert.equal(x.view.digest, ""); x.view.close();
	}
	{
		decodeGate = deferred(); const x = setup(), pending = x.view.run(signal => x.view.preview(plan(), signal), "loading"); await tick();
		decodeGate.reject(new Error("invalid raster")); await pending; decodeGate = undefined;
		assert.equal(button(x.view, "身份一致，保存 PDF 原文").disabled, true); assert.match(x.view.status.textContent, /显示失败/); x.view.close();
	}
	// Separate saved-package registration failure from publication failure, and keep retry available.
	{
		const x = setup({ save: async () => ({ phase: "registration_pending", error: "index changed" }) });
		await x.view.run(signal => x.view.preview(plan(), signal), "loading"); const save = button(x.view, "身份一致，保存 PDF 原文"); await x.view.commit(x.view.plan, save);
		assert.match(x.view.status.textContent, /原文已保存，登记未完成/); assert.equal(save.disabled, false); assert.equal(x.view.saving, false); x.view.close();
	}
	// Late successful saves never recreate closed UI or navigate without a separate explicit click.
	{
		const gate = deferred(), x = setup({ save: () => gate.promise }); await x.view.run(signal => x.view.preview(plan(), signal), "loading");
		const pending = x.view.commit(x.view.plan, button(x.view, "身份一致，保存 PDF 原文")); x.view.close(); gate.resolve({ phase: "saved", paperId: "p" }); await pending;
		assert.equal(x.view.contentEl.children.length, 0); assert.ok(!x.calls.some(c => c[0] === "open"));
	}
	console.log("LOCAL_PDF_INTAKE_VIEW_OK: stale callbacks, cancel/close, decoded-image gate, page edits, image failure, registration status and late save");
})().catch(error => { console.error(error); process.exitCode = 1; });
