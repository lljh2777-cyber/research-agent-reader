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

async function fixture() {
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
