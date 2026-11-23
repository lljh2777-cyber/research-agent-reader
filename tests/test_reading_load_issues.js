"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
const { FileReadingStorage, ReadingRepository } = loadReading("reading/store.ts");

function paper(title) {
	return createReadingSession({ kind: "pdf", path: title + ".pdf", title, fingerprint: "a".repeat(64) });
}

function element(tag) {
	return {
		tag, textContent: "", value: "", className: "", dataset: {}, children: [],
		classList: { add() {} }, setAttribute() {}, focus() {}, addEventListener() {},
		appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
	};
}
const descendants = el => [el, ...el.children.flatMap(descendants)];
const visibleText = el => descendants(el).map(item => item.textContent).join(" ");

async function openWorkspace(t, repo) {
	const notices = [], opened = [];
	class Base {}
	const obsidian = { ItemView: Base, Component: Base, Modal: Base, FuzzySuggestModal: Base, SuggestModal: Base,
		setIcon() {}, Notice: class { constructor(text) { notices.push(text); } } };
	const { ReadingWorkspaceView } = loadReading("views/reading-workspace.ts", { obsidian, electron: {} });
	const previousDocument = global.document;
	global.document = { createElement: element, addEventListener() {} };
	t.after(() => { global.document = previousDocument; });
	const service = { repository: repo, ready: async () => {} };
	const view = Object.assign(Object.create(ReadingWorkspaceView.prototype), {
		domain: "paper", sessionId: "", outcomeEvents: [], renderer: { load() {} }, contentEl: element("div"),
		app: { vault: { on() {} } }, plugin: { getReadingWorkspace: () => service,
			getReadingEngine: () => ({ subscribe() {} }), getCurationService: () => ({ subscribe() {} }) },
		render() {}, scheduleOutcomes() {}, selectSession(id) { opened.push(repo.get(id).id); },
	});
	await view.onOpen();
	function library() {
		const root = element("div");
		view.modal = () => ({ contentEl: root, modalEl: element("div"), open() {}, close() {}, onClose() {} });
		view.openSessionLibrary();
		return root;
	}
	return { notices, opened, library };
}

test("unsupported version is reported with its number and original file bytes are preserved", async t => {
	const root = path.join(__dirname, "fixtures", "reading-quarantine");
	const id = "r-00000000-0000-4000-8000-000000000002";
	const filename = path.join(root, "reading-sessions", id + ".json");
	const before = await fs.readFile(filename);
	const repo = new ReadingRepository(new FileReadingStorage(root));
	await repo.load();
	assert.equal(repo.sessions.has(id), false);
	const { library } = await openWorkspace(t, repo);
	const text = visibleText(library());
	assert.ok(text.includes(id + ".json"));
	assert.match(text, /版本[^\n]*2/);
	assert.doesNotMatch(text, /这里还没有会话/);
	assert.deepEqual(await fs.readFile(filename), before);
});

test("library keeps per-file reasons alongside all openable sessions in a mixed library", async t => {
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const first = paper("First"), broken = paper("Broken"), invalid = paper("Invalid"), second = paper("Second");
	invalid.mainIds.push("missing");
	for (const session of [first, broken, invalid, second]) {
		storage.files.set(session.id, session === broken ? "{bad JSON" : JSON.stringify(session));
	}
	const before = new Map(storage.files);
	await repo.load();
	assert.deepEqual(storage.files, before);
	const { library, opened, notices } = await openWorkspace(t, repo);
	assert.match(notices.join(" "), /无法加载/);
	const root = library();
	const rows = descendants(root).filter(el => el.className.split(" ").includes("reading-library-row"));
	for (const session of [first, second]) {
		const row = rows.find(el => el.dataset.sessionId === session.id);
		descendants(row).find(el => el.tag === "button" && el.title.includes("打开会话")).onclick();
	}
	assert.deepEqual(opened, [first.id, second.id]);
	for (const [session, reason] of [[broken, /JSON|Unexpected/i], [invalid, /断链或重复节点/]]) {
		const row = rows.find(el => visibleText(el).includes(session.id + ".json"));
		assert.ok(row, "isolated file is missing from the library");
		assert.match(visibleText(row), reason);
		assert.ok(!descendants(row).some(el => el.tag === "button"));
	}
	assert.match(visibleText(root), /无法加载/);
});

test("an interrupted session stays openable with a save warning until its next successful save", async t => {
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const session = paper("Interrupted");
	addReadingNode(session, null);
	const original = JSON.stringify(session);
	storage.files.set(session.id, original);
	storage.fail = true;
	await repo.load();
	assert.equal(repo.get(session.id).nodes[0].status, "interrupted");
	assert.equal(storage.files.get(session.id), original);
	const { library, opened, notices } = await openWorkspace(t, repo);
	assert.doesNotMatch(notices.join(" "), /无法加载/);
	assert.match(notices.join(" "), /中断状态未能保存/);
	const root = library();
	const row = descendants(root).find(el => el.dataset.sessionId === session.id);
	assert.match(visibleText(row), /中断状态未能保存/);
	assert.match(visibleText(row), /disk full/);
	descendants(row).find(el => el.tag === "button" && el.title.includes("打开会话")).onclick();
	assert.deepEqual(opened, [session.id]);
	await assert.rejects(repo.transact(session.id, () => {}), /disk full/);
	assert.match(visibleText(root), /disk full/);
	storage.fail = false;
	await repo.transact(session.id, draft => { draft.title = "Saved"; });
	assert.doesNotMatch(visibleText(root), /中断状态未能保存/);
	assert.equal(JSON.parse(storage.files.get(session.id)).nodes[0].status, "interrupted");
});
