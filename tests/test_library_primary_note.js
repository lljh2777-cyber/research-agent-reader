"use strict";
// All mutations below are isolated in memory; no user-file cleanup or model requests.
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers"), f = require("./jats-fixtures.cjs");
const { PrimaryNoteEditor, savedPrimaryNote, primaryNoteCandidates } = loadReading("library/primary-note-editor.ts");
const { PaperRecordService } = loadReading("library/record-service.ts");
const { JournalPaperRecordStore } = loadReading("library/record-store.ts");
const { readPaperLibrary } = loadReading("library/reader.ts");
const { PaperLibraryView } = loadReading("views/paper-library.ts", { obsidian: { ItemView: class {} } });
const pid = "p-00000001-0000-0000-0000-000000000000", a = "wiki/sources/a.md", b = "wiki/sources/b.md", other = "wiki/sources/other.md";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const note = (doi = "10.1234/example", body = "Original text") => `---\n${JSON.stringify({ title: "Same title", doi })}\n---\n${body}`;
async function setup(primaryNoteId) {
	const vault = f.storage(), plugin = f.storage(), store = new JournalPaperRecordStore(plugin);
	vault.dirs.add("wiki"); vault.dirs.add("wiki/sources");
	for (const [id, doi] of [[a, "10.1234/example"], [b, "10.1234/example"], [other, "10.1234/other"]]) vault.files.set(id, Buffer.from(note(doi)));
	await store.append({ kind: "record", id: pid, paperId: pid, title: "Example", identifiers: { doi: "10.1234/example" }, readingState: "revisit", ...(primaryNoteId ? { primaryNoteId } : {}) }, []);
	const scan = () => readPaperLibrary(vault, plugin, { vaultRoot: path.resolve("memory-primary-note"), parseYaml: JSON.parse });
	const service = new PaperRecordService(store, scan), commands = [];
	const host = { preparePaperRecord: id => service.prepare(id), savePaperRecord: command => { commands.push(command); return service.save(command); } };
	return { vault, plugin, store, service, scan, commands, host, editor: new PrimaryNoteEditor(host, () => {}) };
}
let checks = 0; const check = async (label, work) => { await work(); checks++; console.log("PASS primary note: " + label); };
(async () => {
	await check("same-title candidates use exact paths; viewing and cancelling never choose a default", async () => {
		const x = await setup(), before = x.plugin.writes.length;
		await x.editor.begin(pid); assert.deepEqual(primaryNoteCandidates(x.editor.state.context).map(item => item.id), [a, b]);
		assert.equal(x.editor.state.value, null); assert.equal(x.editor.canSave, false); await x.editor.save();
		for (const id of [other, "Same title", "../outside.md", ""]) { x.editor.setValue(id); assert.equal(x.editor.state.value, null); }
		x.editor.setValue(b); x.editor.cancel(); assert.equal(x.plugin.writes.length, before); assert.equal(x.commands.length, 0);
	});
	await check("select, replace and clear preserve reading state, note bytes and old revisions", async () => {
		const x = await setup(), originals = new Map(x.vault.files), old = new Map(x.plugin.files);
		for (const value of [a, b, null]) {
			await x.editor.begin(pid); x.editor.setValue(value); assert.deepEqual(await x.editor.save(), { paperId: pid, value });
			const record = (await x.store.read(pid)).current.record, paper = (await x.scan()).papers.find(p => p.paperId === pid);
			assert.equal(record.primaryNoteId ?? null, value); assert.equal(paper.primaryNoteId ?? null, value); assert.equal(record.readingState, "revisit");
			assert.ok(paper.objects.filter(o => o.kind === "note").every(o => o.noteReview.state === "unreviewed"));
		}
		assert.ok(x.commands.every(c => Object.keys(c).sort().join(",") === "contextHash,paperId,primaryNoteId"));
		for (const [id, bytes] of originals) assert.deepEqual(x.vault.files.get(id), bytes);
		for (const [id, bytes] of old) assert.deepEqual(x.plugin.files.get(id), bytes);
		assert.equal(x.vault.writes.length, 0);
	});
	await check("missing saved choice stays explicit and can be cleared with no candidates", async () => {
		const x = await setup("wiki/sources/missing.md");
		// Simulate a read-only snapshot with both notes now belonging to another paper; no file deletion.
		x.vault.files.set(a, Buffer.from(note("10.1234/elsewhere"))); x.vault.files.set(b, Buffer.from(note("10.1234/elsewhere")));
		await x.editor.begin(pid); assert.equal(x.editor.state.context.paper.primaryNoteId, undefined);
		assert.equal(savedPrimaryNote(x.editor.state.context), "wiki/sources/missing.md"); assert.equal(primaryNoteCandidates(x.editor.state.context).length, 0);
		assert.equal(x.editor.canSave, false); x.editor.setValue(null); assert.equal(x.editor.canSave, true); await x.editor.save();
		assert.equal((await x.store.read(pid)).current.record.primaryNoteId, undefined);
		assert.equal((await x.scan()).diagnostics.some(d => d.code === "primary_note_missing"), false);
	});
	await check("changed text, reassociation and external human state reject stale choices without automatic retries", async () => {
		for (const mode of ["text", "identity", "decision"]) {
			const x = await setup(a); await x.editor.begin(pid); x.editor.setValue(b);
			if (mode === "text") x.vault.files.set(b, Buffer.from(note(undefined, "User changed body")));
			if (mode === "identity") x.vault.files.set(b, Buffer.from(note("10.1234/other")));
			if (mode === "decision") { const c = await x.service.prepare(pid); await x.service.save({ paperId: pid, contextHash: c.contextHash, readingState: "completed" }); }
			const before = x.plugin.writes.length; await x.editor.save(); assert.equal(x.plugin.writes.length, before);
			assert.equal(x.commands.length, 1); assert.equal(x.editor.state.value, b); assert.match(x.editor.state.error, /变化/);
			assert.equal((await x.store.read(pid)).current.record.primaryNoteId, a);
			x.editor.cancel(); await x.editor.begin(pid); assert.equal(x.editor.state.value, a);
			if (mode === "identity") assert.ok(!primaryNoteCandidates(x.editor.state.context).some(item => item.id === b));
		}
	});
	await check("single pending save pins the chosen path, preserves failed drafts, and drops closed callbacks", async () => {
		const x = await setup(), gate = deferred(); let calls = 0;
		x.host.savePaperRecord = async command => { calls++; await gate.promise; return x.service.save(command); };
		await x.editor.begin(pid); x.editor.setValue(b); const first = x.editor.save(); await x.editor.save(); x.editor.setValue(a); x.editor.cancel();
		assert.equal(x.editor.state.phase, "saving"); gate.resolve(); assert.deepEqual(await first, { paperId: pid, value: b }); assert.equal(calls, 1);
		await x.editor.begin(pid); x.editor.setValue(null); x.host.savePaperRecord = async () => { throw new Error("disk full"); };
		await x.editor.save(); assert.equal(x.editor.state.value, null); assert.match(x.editor.state.error, /disk full/);
		const late = deferred(); x.host.savePaperRecord = () => late.promise; const run = x.editor.save(); x.editor.dispose(); late.resolve(); assert.equal(await run, undefined);
	});
	await check("prepare cancellation and newly discovered concurrent heads cannot publish editable candidates", async () => {
		const x = await setup(), gate = deferred(); x.host.preparePaperRecord = () => gate.promise;
		const run = x.editor.begin(pid); x.editor.cancel(); gate.resolve(await x.service.prepare(pid)); await run; assert.equal(x.editor.state.phase, "idle");
		x.host.preparePaperRecord = async () => ({ ...await x.service.prepare(pid), heads: ["a", "b"] });
		await x.editor.begin(pid); assert.equal(x.editor.state.phase, "blocked"); await x.editor.save(); assert.equal(x.commands.length, 0);
	});
	await check("refresh never steals a newer selection or reports a committed clear as failed", async () => {
		for (const mode of ["same", "other", "failed", "closed"]) {
			const view = Object.create(PaperLibraryView.prototype), gate = deferred(), started = deferred(); let renders = 0;
			view.closed = false; view.selectedKey = "old"; view.primaryEditor = { save: async () => ({ paperId: pid, value: null }) };
			view.browser = { state: {}, refresh: () => { started.resolve(); return gate.promise; } }; view.renderResults = () => renders++; view.saveView = () => {};
			const run = view.savePrimaryNote(); await started.promise;
			if (mode === "other") view.selectedKey = "another"; if (mode === "closed") view.closed = true;
			view.browser.state = { phase: mode === "failed" ? "failed" : "ready", result: { papers: [{ paperId: pid, key: "new", association: "identified", diagnosticIds: [] }], recordStates: [], diagnostics: [] } };
			gate.resolve(); await run;
			if (mode === "same") assert.equal(view.selectedKey, "new"); if (mode === "other") assert.equal(view.selectedKey, "another");
			if (mode === "failed") { assert.match(view.message, /已清除主要笔记选择/); assert.match(view.message, /列表尚未刷新成功/); }
			if (mode === "closed") assert.equal(renders, 0);
		}
	});
	console.log(`LIBRARY_PRIMARY_NOTE_OK: ${checks} scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
