"use strict";
// Pure memory, no filesystem or provider calls, no cleanup.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { LibraryBrowserController, filterLibrary, libraryNavigation, paperStateLabel } = loadReading("library/browser.ts");
const { projectLibrary } = loadReading("library/projection.ts");
const { documentLearningEntry } = loadReading("learning/entry.ts");
const hash = "a".repeat(64);
const source = { kind: "source", id: "papers/a/original.pdf", title: "Paper A", identifiers: { doi: "10.1234/a" }, source: { format: "pdf", path: "papers/a/original.pdf", sourceVersionId: "publisher-1", saved: true, verification: { state: "verified", fingerprint: hash } } };
const note = { kind: "note", id: "wiki/sources/a.md", title: "Paper A", identifiers: { doi: "10.1234/a" }, contentHash: hash };
const empty = () => ({ papers: [], diagnostics: [], excluded: [], readIssues: [], recordStates: [], complete: true, stats: { filesRead: 0, bytesRead: 0, directoriesRead: 0, objects: 0, elapsedMs: 0 } });
const project = items => ({ ...empty(), ...projectLibrary(items) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
(async () => {
	const data = project([source, note]), item = data.papers[0].objects.find(o => o.kind === "source");
	assert.equal(filterLibrary(data.papers, "10.1234/a", "all").length, 1);
	assert.equal(filterLibrary(data.papers, "PAPER a", "sources").length, 1);
	assert.equal(filterLibrary(data.papers, "", "sessions").length, 0);
	assert.equal(filterLibrary(data.papers, "missing", "all").length, 0);
	assert.equal(filterLibrary(project([{ ...note, identifiers: {} }]).papers, "", "issues").length, 1);
	assert.match(paperStateLabel("completed"), /用户标记/);
	assert.deepEqual(libraryNavigation(item, data), { kind: "source", path: source.id, format: "pdf", read: false });
	assert.equal(libraryNavigation(item, data, true).read, true);
	for (const changed of [
		{ ...source.source, verification: { state: "verified", fingerprint: "b".repeat(64) } },
		{ ...source.source, sourceVersionId: "accepted-1" },
		{ ...source.source, verification: { state: "invalid", reason: "changed" } },
	]) assert.throws(() => libraryNavigation(item, project([{ ...source, source: changed }])), /变化|核验/);
	assert.throws(() => libraryNavigation(item, empty()), /变化/);
	const jats = { ...source, source: { ...source.source, format: "jats", projectionId: "jats-v3-a" } }, jatsData = project([jats]);
	assert.equal(libraryNavigation(jatsData.papers[0].objects[0], jatsData, true).format, "jats");
	assert.throws(() => libraryNavigation(jatsData.papers[0].objects[0], project([{ ...jats, source: { ...jats.source, projectionId: "jats-v3-b" } }])), /版本已变化/);
	const markdown = { ...source, source: { ...source.source, format: "markdown" } }, mdData = project([markdown]);
	assert.throws(() => libraryNavigation(mdData.papers[0].objects[0], mdData, true), /Markdown/);
	const noteData = project([note]); assert.deepEqual(libraryNavigation(noteData.papers[0].objects[0], noteData), { kind: "note", path: note.id });
	const annotation = { kind: "annotation", id: "wiki/annotations/a#file.md#opaque#id", annotationPath: "wiki/annotations/a#file.md", title: "A", identifiers: {} };
	const annotationData = project([annotation]); assert.deepEqual(libraryNavigation(annotationData.papers[0].objects[0], annotationData), { kind: "note", path: annotation.annotationPath });
	const sessionItem = { kind: "session", id: "r-00000001-0000-0000-0000-000000000000", title: "History", identifiers: {}, reading: { sessionId: "r-00000001-0000-0000-0000-000000000000", source: { kind: "pdf", path: "missing.pdf", fingerprint: hash } }, binding: { state: "unresolved", reason: "missing" } };
	const history = { ...empty(), papers: [{ objects: [sessionItem] }] };
	assert.equal(libraryNavigation(sessionItem, history, true).sessionId, sessionItem.id, "missing source can still open exact history");
	assert.throws(() => libraryNavigation({ ...sessionItem, reading: { ...sessionItem.reading, source: { ...sessionItem.reading.source, fingerprint: "b".repeat(64) } } }, history), /变化/);
	assert.deepEqual(documentLearningEntry({ kind: "document", reading: { sessionId: "exact" } }), { sessionId: "exact" });
	assert.throws(() => documentLearningEntry({ kind: "topic", sessionId: "t-new" }), /尚未开放/);
	// Duplicate clicks coalesce; opening/filtering/details are consumers, never separate scans.
	{
		const gate = deferred(); let calls = 0, changes = 0;
		const controller = new LibraryBrowserController(async () => { calls++; return gate.promise; }, () => { changes++; });
		const first = controller.refresh(); assert.equal(controller.busy, true); assert.equal(controller.refresh(), first);
		await Promise.resolve(); assert.equal(calls, 1); gate.resolve(data); await first;
		assert.equal(controller.state.phase, "ready"); assert.equal(controller.state.result, data); assert.equal(controller.busy, false); assert.equal(changes, 2);
	}
	// Cancel immediately and during IO; late results never replace the previous view.
	for (const early of [true, false]) {
		const gate = deferred(); let calls = 0;
		const controller = new LibraryBrowserController(async () => { calls++; return gate.promise; }, () => {});
		controller.state.result = data; const run = controller.refresh(); if (!early) await Promise.resolve(); controller.cancel();
		assert.equal(controller.state.phase, "cancelled"); assert.equal(controller.refresh(), run, "no overlapping scan while cancelled IO winds down");
		gate.resolve(empty()); await run; assert.equal(controller.state.result, data); assert.equal(controller.state.phase, "cancelled"); assert.equal(calls, early ? 0 : 1);
	}
	{
		let mode = "fail", received;
		const controller = new LibraryBrowserController(async (_, verify) => { received = verify; if (mode === "fail") throw new Error("scan failed"); return data; }, () => {});
		await controller.refresh(); assert.equal(controller.state.phase, "failed"); assert.match(controller.state.error, /scan failed/);
		mode = "ready"; await controller.refresh("papers/a/article.md"); assert.equal(received, "papers/a/article.md"); assert.equal(controller.state.phase, "ready");
		mode = "fail"; await controller.refresh(); assert.equal(controller.state.result, data, "last good result survives failed refresh");
	}
	{
		const gate = deferred(); let changes = 0;
		const controller = new LibraryBrowserController(() => gate.promise, () => changes++);
		const run = controller.refresh(); await Promise.resolve(); controller.dispose(); gate.resolve(data); await run;
		assert.equal(changes, 1); assert.equal(controller.state.result, undefined); await controller.refresh(); assert.equal(changes, 1);
	}
	console.log("LIBRARY_BROWSER_OK: filters, capabilities, exact-version navigation, source-free routing isolation, single scans, cancellation, stale results, failures and close");
})().catch(error => { console.error(error); process.exitCode = 1; });
