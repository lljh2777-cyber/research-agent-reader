"use strict";
// In-memory controller + real record-service integration; no model calls or file cleanup.
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers"), f = require("./jats-fixtures.cjs");
const { ReadingStateEditor, readingStateBlockReason, PAPER_READING_STATES } = loadReading("library/reading-state-editor.ts");
const { PaperRecordService } = loadReading("library/record-service.ts");
const { JournalPaperRecordStore } = loadReading("library/record-store.ts");
const { readPaperLibrary } = loadReading("library/reader.ts");
const { PaperLibraryView } = loadReading("views/paper-library.ts", { obsidian: { ItemView: class {} } });
const pid = "p-00000001-0000-0000-0000-000000000000";
const paper = { key: "view-only", paperId: pid, association: "identified", title: "Example", identifiers: {}, objects: [], readingState: "unmarked", diagnosticIds: [] };
const context = () => ({ paper: structuredClone(paper), heads: [], decisions: [], contextHash: "a".repeat(64) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let checks = 0;
const check = async (label, work) => { await work(); checks++; console.log("PASS library state: " + label); };
(async () => {
	await check("opening, selecting and cancelling never save; unchanged/invalid values cannot save", async () => {
		let writes = 0; const editor = new ReadingStateEditor({ preparePaperRecord: async () => context(), savePaperRecord: async () => writes++ }, () => {});
		assert.equal(writes, 0); await editor.begin(pid); assert.equal(editor.canSave, false); await editor.save();
		editor.setValue("model_completed"); assert.equal(editor.state.value, "unmarked");
		for (const value of PAPER_READING_STATES) { editor.setValue(value); assert.equal(editor.state.value, value); }
		editor.cancel(); assert.equal(writes, 0); assert.equal(editor.active, false);
	});
	await check("double prepare/save, draft mutation and cancel while saving cannot change the one frozen command", async () => {
		const prepare = deferred(), save = deferred(); let reads = 0; const commands = [], original = context();
		const editor = new ReadingStateEditor({ preparePaperRecord: () => { reads++; return prepare.promise; }, savePaperRecord: command => { commands.push(command); return save.promise; } }, () => {});
		const first = editor.begin(pid); await editor.begin("other"); assert.equal(reads, 1); prepare.resolve(original); await first;
		original.contextHash = "b".repeat(64); original.paper.paperId = "other";
		editor.setValue("completed"); const run = editor.save(); await editor.save(); editor.setValue("revisit"); editor.cancel();
		assert.equal(editor.state.phase, "saving"); assert.deepEqual(commands, [{ paperId: pid, contextHash: "a".repeat(64), readingState: "completed" }]);
		save.resolve({}); assert.deepEqual(await run, { paperId: pid, value: "completed" }); assert.equal(editor.active, false);
	});
	await check("cancelled prepare and closed views discard late responses without cancelling committed writes", async () => {
		const first = deferred(), second = deferred(); let calls = 0, changes = 0;
		const editor = new ReadingStateEditor({ preparePaperRecord: () => ++calls === 1 ? first.promise : second.promise, savePaperRecord: async () => {} }, () => changes++);
		const old = editor.begin(pid); editor.cancel(); const current = editor.begin(pid);
		first.resolve({ ...context(), contextHash: "c".repeat(64) }); await old; assert.equal(editor.state.phase, "preparing");
		second.resolve(context()); await current; assert.equal(editor.state.context.contextHash, "a".repeat(64));
		const save = deferred(); editor.host.savePaperRecord = () => save.promise; editor.setValue("reading"); const saving = editor.save();
		editor.dispose(); const atClose = changes; save.resolve({}); assert.equal(await saving, undefined); assert.equal(changes, atClose);
		await editor.begin(pid); assert.equal(changes, atClose);
		const late = deferred(), closed = new ReadingStateEditor({ preparePaperRecord: () => late.promise }, () => changes++);
		const pending = closed.begin(pid); closed.dispose(); const last = changes; late.reject(new Error("late failure")); await pending; assert.equal(changes, last);
	});
	await check("identity, corrupt records and multiple heads are blocked without picking a winner", async () => {
		assert.match(readingStateBlockReason({ ...paper, paperId: undefined }, { recordStates: [] }), /身份/);
		assert.match(readingStateBlockReason({ ...paper, association: "conflict" }, { recordStates: [] }), /身份/);
		assert.match(readingStateBlockReason(paper, { recordStates: [{ paperId: pid, blocked: true }] }), /损坏/);
		assert.match(readingStateBlockReason(paper, { recordStates: [{ paperId: pid, heads: ["a", "b"] }] }), /并发/);
		assert.equal(readingStateBlockReason(paper, { recordStates: [] }), undefined);
		for (const prepared of [{ ...context(), heads: ["a", "b"] }, { ...context(), paper: { ...paper, paperId: "other" } }]) {
			const editor = new ReadingStateEditor({ preparePaperRecord: async () => prepared, savePaperRecord: () => assert.fail("must not write") }, () => {});
			await editor.begin(pid); assert.equal(editor.state.phase, "blocked"); await editor.save(); editor.cancel(); assert.equal(editor.active, false);
		}
	});
	await check("save failure preserves the exact draft and token; retry is explicit", async () => {
		let reads = 0, writes = 0; const commands = [];
		const editor = new ReadingStateEditor({ preparePaperRecord: async () => { reads++; return context(); }, savePaperRecord: async edit => { commands.push(edit); if (++writes === 1) throw new Error("disk full"); } }, () => {});
		await editor.begin(pid); editor.setValue("revisit"); await editor.save();
		assert.equal(editor.state.phase, "editing"); assert.equal(editor.state.value, "revisit"); assert.match(editor.state.error, /disk full/); assert.equal(writes, 1);
		await editor.save(); assert.equal(writes, 2); assert.equal(reads, 1); assert.deepEqual(commands[0], commands[1]);
	});
	await check("real service saves all states, preserves primary note and history, and rejects stale edits", async () => {
		const vault = f.storage(), plugin = f.storage(), store = new JournalPaperRecordStore(plugin);
		const noteId = "wiki/sources/example.md";
		vault.dirs.add("wiki"); vault.dirs.add("wiki/sources");
		vault.files.set(noteId, Buffer.from('---\n{"title":"Example","doi":"10.1234/example"}\n---\nUnreviewed source note.'));
		await store.append({ kind: "record", id: pid, paperId: pid, title: "Example", identifiers: { doi: "10.1234/example" }, readingState: "unmarked", primaryNoteId: noteId }, []);
		const scan = () => readPaperLibrary(vault, plugin, { vaultRoot: path.resolve("memory-library-state"), parseYaml: JSON.parse });
		const service = new PaperRecordService(store, scan);
		const host = { preparePaperRecord: id => service.prepare(id), savePaperRecord: edit => service.save(edit) };
		const editor = new ReadingStateEditor(host, () => {}), oldBytes = new Map(plugin.files);
		for (const value of ["not_started", "reading", "completed", "revisit", "unmarked"]) {
			await editor.begin(pid); assert.equal(editor.state.phase, "editing"); editor.setValue(value); assert.ok(await editor.save());
			const read = await scan(), saved = read.papers.find(p => p.paperId === pid);
			assert.equal(saved.readingState, value); assert.equal(saved.primaryNoteId, noteId); assert.equal(saved.objects.find(o => o.kind === "note").noteReview.state, "unreviewed");
		}
		await editor.begin(pid); editor.setValue("completed");
		const external = await service.prepare(pid); await service.save({ paperId: pid, contextHash: external.contextHash, readingState: "revisit" });
		const writes = plugin.writes.length; await editor.save(); assert.equal(plugin.writes.length, writes);
		assert.match(editor.state.error, /编辑后变化/); assert.equal(editor.state.value, "completed");
		assert.equal((await store.read(pid)).current.record.readingState, "revisit");
		editor.cancel(); await editor.begin(pid); assert.equal(editor.state.value, "revisit");
		for (const [name, bytes] of oldBytes) assert.deepEqual(plugin.files.get(name), bytes);
		assert.equal(vault.writes.length, 0); assert.ok(plugin.writes.every(name => name.startsWith("paper-records/")));
	});
	await check("post-save refresh preserves a newer selection and distinguishes committed saves from refresh failure", async () => {
		for (const mode of ["same", "selected-other", "refresh-failed", "closed"]) {
			const gate = deferred(), refreshing = deferred(), view = Object.create(PaperLibraryView.prototype); let renders = 0, layouts = 0;
			view.closed = false; view.selectedKey = "before-record";
			view.readingEditor = { save: async () => ({ paperId: pid, value: "completed" }) };
			view.renderResults = () => renders++; view.saveView = () => layouts++;
			view.browser = { state: { phase: "loading" }, refresh: () => { refreshing.resolve(); return gate.promise; } };
			const run = view.saveReadingState(); await refreshing.promise;
			if (mode === "selected-other") view.selectedKey = "user-selected-another-paper";
			if (mode === "closed") view.closed = true;
			view.browser.state = { phase: mode === "refresh-failed" ? "failed" : "ready", result: { papers: [{ ...paper, key: "after-record", readingState: "completed" }], recordStates: [] } };
			gate.resolve(); await run;
			if (mode === "same") { assert.equal(view.selectedKey, "after-record"); assert.equal(layouts, 1); }
			if (mode === "selected-other") { assert.equal(view.selectedKey, "user-selected-another-paper"); assert.equal(layouts, 0); }
			if (mode === "refresh-failed") { assert.match(view.message, /已保存：用户标记已读/); assert.match(view.message, /列表尚未刷新成功/); }
			if (mode === "closed") { assert.equal(renders, 0); assert.equal(layouts, 0); }
		}
	});
	console.log(`LIBRARY_READING_STATE_OK: ${checks} scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
