"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { ReadingWorkspaceService } = loadReading("reading/workspace.ts");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
const Base = class {};
const Plugin = loadReading("plugin.ts", { electron: {}, obsidian: {
	Plugin: Base, PluginSettingTab: Base, Component: Base, ItemView: Base, Modal: Base,
} }).default;

function gate() {
	let release;
	const promise = new Promise(resolve => { release = resolve; });
	return { promise, release };
}

async function fixture(secondRelease) {
	const workspace = new ReadingWorkspaceService({}, ".", ".");
	workspace.repository = new ReadingRepository(memoryStorage());
	const sessions = ["a.pdf", "b.pdf"].map(path => createReadingSession({
		kind: "pdf", path, title: path, fingerprint: "a".repeat(64),
	}));
	for (const s of sessions) await workspace.repository.add(s);
	const count = { opens: 0, created: 0, destroyed: 0 };
	const release = gate(), started = gate();
	workspace.loader.open = async (kind, path) => {
		count.opens++;
		started.release();
		if (path === "a.pdf") await release.promise;
		if (path === "b.pdf" && secondRelease) await secondRelease.promise;
		count.created++;
		return { source: sessions.find(s => s.source.path === path).source, verify: async () => {},
			destroy: async () => { count.destroyed++; } };
	};
	return { workspace, sessions, count, release, started };
}

test("concurrent cold loads and a later cache hit have one PDF owner", async () => {
	const { workspace, sessions: [s], release, count } = await fixture();
	const first = workspace.document(s.id), second = workspace.document(s.id);
	release.release();
	const [a, b] = await Promise.all([first, second]);
	const cached = await workspace.document(s.id);
	await workspace.dispose();
	assert.equal(count.created, 1);
	assert.equal(first, second);
	assert.equal(a, b);
	assert.equal(cached, a);
	assert.equal(count.destroyed, 1);
});

test("a failed load can be retried", async t => {
	const { workspace, sessions: [s], release, count } = await fixture();
	const open = t.mock.method(workspace.loader, "open");
	open.mock.mockImplementationOnce(async () => { throw new Error("PDF read failed"); });
	await assert.rejects(workspace.document(s.id), /PDF read failed/);
	release.release();
	const loaded = await workspace.document(s.id);
	await workspace.dispose();
	assert.equal(loaded.source, s.source);
	assert.equal(open.mock.callCount(), 2);
	assert.equal(count.destroyed, 1);
});

test("different session IDs load independently", async () => {
	const { workspace, sessions: [a, b], release, count } = await fixture();
	const first = workspace.document(a.id);
	const other = await workspace.document(b.id);
	assert.equal(other.source.path, "b.pdf");
	assert.equal(count.created, 1);
	release.release();
	assert.notEqual(await first, other);
	await workspace.dispose();
	assert.equal(count.destroyed, 2);
});

for (const operation of ["document", "create", "open", "relocate"]) {
	test("unload waits for " + operation + " and destroys its late PDF", async () => {
		const { workspace, sessions: [s], release, started, count } = await fixture();
		const loading = operation === "document" ? workspace.document(s.id)
			: operation === "relocate" ? workspace.relocate(s.id, "a.pdf")
			: workspace[operation]("pdf", "a.pdf", "", "");
		const settled = Promise.allSettled([loading]);
		await started.promise;
		let disposed = false;
		const disposal = workspace.dispose().then(() => { disposed = true; });
		await new Promise(resolve => setImmediate(resolve));
		const returnedEarly = disposed;
		release.release();
		const [outcome] = await settled;
		await disposal;
		assert.equal(returnedEarly, false, "unload returned before the PDF opened");
		assert.equal(outcome.status, "rejected");
		assert.match(outcome.reason.message, /已关闭/);
		assert.equal(count.created, 1);
		assert.equal(count.destroyed, 1);
	});
}

test("a closed workspace rejects loading without opening a PDF", async () => {
	const { workspace, sessions: [s], release, count } = await fixture();
	await workspace.dispose();
	release.release();
	await assert.rejects(workspace.document(s.id), /已关闭/);
	assert.equal(count.opens, 0);
});

function unloadClock(t) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const warning = t.mock.method(console, "warn", () => {});
	let returned = false;
	return {
		dispose: workspace => workspace.dispose().then(() => { returned = true; }),
		returned: () => returned,
		warnings: () => warning.mock.calls.map(call => call.arguments.join(" ")),
		async tick(ms) {
			t.mock.timers.tick(ms);
			await new Promise(resolve => setImmediate(resolve));
		},
	};
}

test("unload returns at five seconds even if the PDF never opens", async t => {
	const { workspace, sessions: [s], started, count } = await fixture();
	void workspace.document(s.id);
	await started.promise;
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(4999);
	assert.equal(clock.returned(), false);
	assert.deepEqual(clock.warnings(), []);
	await clock.tick(1);
	assert.equal(clock.returned(), true, "dispose still pending at 5000 ms");
	await disposal;
	assert.equal(count.created, 0);
	assert.equal(clock.warnings().length, 1);
	assert.ok(clock.warnings()[0].includes(s.id));
});

test("a PDF opening after unload returns is destroyed exactly once", async t => {
	const { workspace, sessions: [s], release, count } = await fixture();
	const loading = assert.rejects(workspace.document(s.id), /已关闭/);
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(5000);
	const returnedBeforeOpen = clock.returned();
	assert.equal(count.created, 0);
	release.release();
	await Promise.all([loading, disposal]);
	assert.deepEqual(count, { opens: 1, created: 1, destroyed: 1 });
	assert.equal(returnedBeforeOpen, true, "dispose waited for the late PDF");
});

test("a PDF settling within the deadline completes cleanup without a warning", async t => {
	const { workspace, sessions: [s], release, count } = await fixture();
	const loading = assert.rejects(workspace.document(s.id), /已关闭/);
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(4999);
	assert.equal(clock.returned(), false);
	release.release();
	await Promise.all([loading, disposal]);
	assert.equal(count.destroyed, 1);
	await clock.tick(1);
	assert.deepEqual(clock.warnings(), []);
});

test("only the still-opening session is reported and the other PDF is cleaned up", async t => {
	const finishFast = gate();
	const { workspace, sessions: [slow, fast], release, count } = await fixture(finishFast);
	const loading = assert.rejects(workspace.document(slow.id), /已关闭/);
	const fastLoad = assert.rejects(workspace.document(fast.id), /已关闭/);
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(4000);
	finishFast.release();
	await fastLoad;
	assert.equal(count.destroyed, 1);
	assert.deepEqual(clock.warnings(), []);
	await clock.tick(1000);
	const returned = clock.returned(), destroyed = count.destroyed;
	release.release();
	await Promise.all([loading, disposal]);
	assert.equal(returned, true, "the slow session blocked cleanup of the other PDF");
	assert.equal(destroyed, 1);
	assert.equal(count.created, 2);
	assert.equal(count.destroyed, 2);
	assert.equal(clock.warnings().length, 1);
	assert.ok(clock.warnings()[0].includes(slow.id));
	assert.ok(!clock.warnings()[0].includes(fast.id));
});

test("one timeout warning identifies concurrent cold, relocate, create and queued opens", async t => {
	const { workspace, sessions: [a, b], release, count } = await fixture();
	const loads = [
		workspace.document(a.id), workspace.relocate(b.id, "a.pdf"),
		workspace.create("pdf", "a.pdf", "", ""), workspace.open("pdf", "a.pdf", "", ""),
	].map(task => assert.rejects(task, /已关闭/));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(count.opens, 4);
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(5000);
	const returned = clock.returned();
	release.release();
	await Promise.all([...loads, disposal]);
	assert.equal(returned, true);
	assert.equal(clock.warnings().length, 1);
	for (const source of [a.id, b.id, "a.pdf"]) assert.ok(clock.warnings()[0].includes(source));
	assert.deepEqual(count, { opens: 4, created: 4, destroyed: 4 });
});

test("a loader error after the unload deadline still reaches its caller", async t => {
	const { workspace, sessions: [s], release } = await fixture();
	const failure = new Error("late PDF read failed");
	workspace.loader.open = async () => { await release.promise; throw failure; };
	const loading = assert.rejects(workspace.document(s.id), error => error === failure);
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(5000);
	const returned = clock.returned();
	release.release();
	await Promise.all([loading, disposal]);
	assert.equal(returned, true, "dispose waited for the late read error");
});

test("the PDF deadline still drains an unrelated generation before disposing its document", async t => {
	const { workspace, sessions: [a, b], release, count } = await fixture();
	await workspace.document(b.id);
	const finishGeneration = gate();
	workspace.generateHandler = () => finishGeneration.promise;
	const generation = workspace.generate(b.id, "node");
	const loading = assert.rejects(workspace.document(a.id), /已关闭/);
	const clock = unloadClock(t);
	const disposal = clock.dispose(workspace);
	await clock.tick(5000);
	assert.equal(clock.returned(), false);
	assert.equal(count.destroyed, 0);
	finishGeneration.release();
	await generation;
	await clock.tick(0);
	const returned = clock.returned();
	release.release();
	await Promise.all([loading, disposal]);
	assert.equal(returned, true, "unload kept waiting for the expired PDF open");
	assert.equal(count.destroyed, 2);
});

test("plugin unload seals reading before another service finishes", async () => {
	const { workspace, sessions: [s], count, release } = await fixture();
	const plugin = new Plugin(), blocker = gate();
	plugin.readingWorkspace = workspace;
	plugin.annotationCliDiscovery.dispose = () => blocker.promise;
	plugin.flushScheduledSettingsSave = async () => {};
	let requests = 0;
	workspace.generateHandler = async () => { requests++; };
	const unloading = plugin.onunload();
	try {
		release.release();
		await assert.rejects(workspace.generate(s.id, "node"), /已关闭/);
		await assert.rejects(workspace.advance(s.id), /已关闭/);
		await assert.rejects(workspace.document(s.id), /已关闭/);
		assert.equal(workspace.repository.get(s.id).nodes.length, 0);
		assert.equal(requests, 0);
		assert.equal(count.opens, 0);
	} finally {
		blocker.release();
		await unloading;
	}
});

test("an already accepted generation interrupted during its cold load keeps its terminal state", async () => {
	const { workspace, sessions: [s], started, release, count } = await fixture();
	const id = await workspace.repository.transact(s.id, draft => addReadingNode(draft, null).id);
	let requests = 0;
	new ReadingEngine(workspace, () => ({ complete: async () => { requests++; } }));
	const task = workspace.generate(s.id, id);
	await started.promise;
	workspace.close();
	release.release();
	await assert.rejects(task, /已关闭/);
	assert.equal(workspace.repository.get(s.id).nodes[0].status, "interrupted");
	await workspace.dispose();
	assert.equal(count.destroyed, 1);
	assert.equal(requests, 0);
});

test("a generation waiting for a late PDF settles as interrupted when its open finishes", async t => {
	const clock = unloadClock(t);
	const { workspace, sessions: [s], started, release, count } = await fixture();
	const id = await workspace.repository.transact(s.id, draft => addReadingNode(draft, null).id);
	const complete = t.mock.fn();
	new ReadingEngine(workspace, () => ({ complete }));
	const generation = assert.rejects(workspace.generate(s.id, id), /已关闭/);
	await started.promise;
	const disposal = clock.dispose(workspace);
	await clock.tick(5000);
	const returnedBeforeOpen = clock.returned();
	release.release();
	await Promise.all([generation, disposal]);
	assert.equal(returnedBeforeOpen, true);
	assert.equal(workspace.repository.get(s.id).nodes[0].status, "interrupted");
	assert.equal(complete.mock.callCount(), 0);
	assert.deepEqual(count, { opens: 1, created: 1, destroyed: 1 });
});

test("unload also seals a workspace that was never opened", async () => {
	const plugin = new Plugin(), blocker = gate();
	plugin.annotationCliDiscovery.dispose = () => blocker.promise;
	plugin.flushScheduledSettingsSave = async () => {};
	const unloading = plugin.onunload();
	try {
		assert.throws(() => plugin.getReadingWorkspace(), /已关闭/);
	} finally {
		blocker.release();
		await unloading;
	}
});
