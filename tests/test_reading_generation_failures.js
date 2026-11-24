"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { ReadingWorkspaceService } = loadReading("reading/workspace.ts");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
const { openCodeProject } = loadReading("code-reading/source.ts");
class Base {}
const obsidian = {
	ItemView: Base, Component: class { load() {} unload() {} }, Modal: Base, SuggestModal: Base, FuzzySuggestModal: Base,
	Notice: Base, setIcon() {}, MarkdownRenderer: { render: async (_app, text, el) => { el.textContent = text; } },
};
const { ReadingWorkspaceView } = loadReading("views/reading-workspace.ts", { electron: {}, obsidian });
const { InlinePaperReading } = loadReading("views/inline-paper-reading.ts", {
	obsidian, "./reading-citations": { renderReadingCitations() {} },
});
const paper = { kind: "article", title: "Paper", path: "paper.md", fingerprint: "a".repeat(64) };
const evidence = { id: "text-1-0", kind: "paper", path: paper.path, label: "Intro", text: "Evidence" };
const paperDoc = { source: paper, evidence: [evidence], catalog: "text-1-0 Intro", verify: async () => {} };
const answer = JSON.stringify({ title: "Intro", content: "Answer [text-1-0]", evidenceIds: ["text-1-0"],
	outline: ["Intro"], mainSummary: "Answer", completed: false });
const modelError = new Error("provider response truncated");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(doc = paperDoc, completed = false) {
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const service = new ReadingWorkspaceService({}, ".", ".");
	service.repository = repo;
	service.document = async () => doc;
	const session = createReadingSession(doc.source);
	session.outline = ["Intro"];
	const node = addReadingNode(session, null);
	if (completed) { node.status = "done"; node.content = "Background"; }
	await repo.add(session);
	const backend = { name: "test", model: "mock", images: false, async complete(req) {
		if (!JSON.parse(req.prompt).output) return JSON.stringify({ action: "ready" });
		throw modelError;
	} };
	const engine = new ReadingEngine(service, () => backend);
	return { service, repo, storage, session, id: node.id, engine, backend, current: () => repo.get(session.id).nodes[0] };
}

function viewFor(f) {
	return Object.assign(Object.create(ReadingWorkspaceView.prototype), {
		service: f.service, sessionId: f.session.id, plugin: { getReadingEngine: () => f.engine },
		app: { workspace: { getLeavesOfType: () => [] } }, renderer: { unload() {} }, modeMotion: { stop() {} },
		outcomeEvents: [], modals: [], draftTimers: [], scrollTimers: [], scrollEdits: [], localDrafts: [], renderCitations() {},
	});
}

function render(f, view = viewFor(f)) {
	const elements = [];
	const previous = global.document;
	global.document = { createElement(tag) {
		const el = { tag, dataset: {}, appendChild() {}, setAttribute() {} };
		elements.push(el); return el;
	} };
	try { view.renderAnswer({ appendChild() {} }, view.session.nodes.find(node => node.id === f.id)); }
	finally { global.document = previous; }
	return { text: elements.map(e => e.textContent).join(" "), retry: elements.find(e => e.title === "重试") };
}

async function foregroundView(storage, session, lifecycleTest) {
	const service = new ReadingWorkspaceService({}, ".", ".");
	service.repository = new ReadingRepository(storage);
	await service.ready();
	const view = viewFor({ service, session });
	view.service = undefined;
	view.plugin.getReadingWorkspace = () => service;
	const buttons = [];
	function element(tag) {
		const el = Object.assign(new EventTarget(), { dataset: {}, style: { setProperty() {} }, classList: { add() {}, toggle() {} },
			setAttribute() {}, appendChild() {}, replaceChildren() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [] });
		if (tag === "button") buttons.push(el);
		return el;
	}
	Object.assign(view, { leaf: {}, domain: "paper", contentEl: element("div"),
		renderHeader() {}, renderAnswer() {}, renderMode() {}, renderOutcomes() {}, drag() {} });
	const previous = global.document;
	global.document = Object.assign(new EventTarget(), { createElement: element, createElementNS: (_ns, tag) => element(tag) });
	if (lifecycleTest) {
		const engine = new ReadingEngine(service, () => ({}));
		view.plugin.getReadingEngine = () => engine;
		view.plugin.getCurationService = () => ({ subscribe: () => () => {} });
		view.app.vault = { on() {}, offref() {} };
		view.renderer.load = () => {};
		view.scheduleOutcomes = () => {};
		const state = lifecycleTest.mock.method(view, "render");
		const stream = lifecycleTest.mock.method(view.contentEl, "querySelectorAll");
		await view.onOpen();
		return { service, engine, view, buttons, stateCalls: () => state.mock.callCount(),
			streamCalls: () => stream.mock.calls.filter(call => call.arguments[0] === "[data-answer-id]").length };
	}
	try { await view.setState({ sessionId: session.id, domain: "paper" }); }
	finally { global.document = previous; }
	return { service, buttons };
}

for (const orderly of [true, false]) {
	test("real onOpen isolates repository and stream updates after " + (orderly ? "onClose" : "abnormal close"), async t => {
		const previousDocument = global.document;
		t.after(() => { global.document = previousDocument; });
		const notices = t.mock.method(obsidian, "Notice");
		const storage = memoryStorage(), session = createReadingSession(paper);
		const node = addReadingNode(session, null); node.status = "done";
		await new ReadingRepository(storage).add(session);
		const old = await foregroundView(storage, session, t);
		const publish = (mount, text) => {
			const repo = mount.service.repository;
			const update = structuredClone(repo.get(session.id));
			update.nodes[0].title = text;
			repo.sessions.set(session.id, update);
			repo.emit(session.id);
			mount.engine.emit(session.id, node.id, text);
		};
		const before = old.stateCalls();
		publish(old, "before unload");
		assert.equal(old.stateCalls(), before + 1);
		assert.equal(old.streamCalls(), 1);
		if (orderly) await old.view.onClose();
		await old.service.dispose();
		const fresh = await foregroundView(storage, session, t);
		const freshBefore = fresh.stateCalls();
		const writes = t.mock.method(storage, "write");
		publish(old, "late old update");
		assert.equal(fresh.stateCalls(), freshBefore);
		assert.equal(fresh.streamCalls(), 0);
		if (orderly) {
			assert.equal(old.stateCalls(), before + 1);
			assert.equal(old.streamCalls(), 1);
		}
		const oldState = old.stateCalls(), oldStream = old.streamCalls();
		publish(fresh, "new update");
		assert.equal(fresh.stateCalls(), freshBefore + 1);
		assert.equal(fresh.streamCalls(), 1);
		assert.equal(old.stateCalls(), oldState);
		assert.equal(old.streamCalls(), oldStream);
		await tick();
		assert.equal(writes.mock.callCount(), 0);
		assert.equal(notices.mock.callCount(), 0);
		await fresh.view.onClose();
		if (!orderly) await old.view.onClose();
		await fresh.service.dispose();
	});
}

test("foreground and background recognize the old storage rejection, including a terminal save error", async t => {
	const notices = t.mock.method(obsidian, "Notice");
	const f = await fixture(paperDoc, true);
	const { service, buttons } = await foregroundView(f.storage, f.session);
	const advance = buttons.find(button => button.title === "继续下一步主线");
	await service.dispose();
	const [closed] = await Promise.allSettled([service.repository.transact(f.session.id, () => {})]);
	assert.equal(closed.status, "rejected");
	assert.match(closed.reason.message, /存储已关闭/);
	const failures = [];
	service.repository.subscribe((_, failure) => { if (failure) failures.push(failure); });
	for (const error of [closed.reason, Object.assign(new Error("terminal save failed"), { saveError: closed.reason })]) {
		service.advance = async () => { throw error; };
		advance.onclick();
		await service.repository.reportGenerationError(f.session.id, f.id, error);
		await tick();
		assert.equal(notices.mock.callCount(), 0);
		assert.deepEqual(failures, []);
	}
	const diskError = Object.assign(new Error("terminal save failed: disk full"), { saveError: new Error(closed.reason.message) });
	service.advance = async () => { throw diskError; };
	advance.onclick();
	await tick();
	assert.deepEqual(notices.mock.calls.map(call => call.arguments), [[diskError.message]]);
});

for (const delivery of ["foreground", "background"]) {
	test("a timed-out " + delivery + " generation stays silent even with the old view still subscribed", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		t.mock.method(console, "warn", () => {});
		const notices = t.mock.method(obsidian, "Notice");
		const previousDocument = global.document;
		t.after(() => { global.document = previousDocument; });
		const storage = memoryStorage(), session = createReadingSession({ ...paper, kind: "pdf", path: "paper.pdf" });
		await new ReadingRepository(storage).add(session);
		const { service, view, buttons } = await foregroundView(storage, session, t);
		let started, finish;
		const opening = new Promise(resolve => { started = resolve; });
		const pdf = new Promise(resolve => { finish = resolve; });
		service.loader.open = () => { started(); return pdf; };
		const failureEvents = [];
		service.repository.subscribe((_, failure) => { if (failure) failureEvents.push(failure); });
		let task;
		if (delivery === "foreground") {
			const advance = t.mock.method(service, "advance");
			buttons.find(button => button.title === "开始讲解 →").onclick();
			task = advance.mock.calls[0].result;
		} else {
			const id = await service.repository.transact(session.id, draft => addReadingNode(draft, null).id);
			task = service.generate(session.id, id, "background");
		}
		const outcome = Promise.allSettled([task]);
		await opening;
		const disposal = service.dispose();
		t.mock.timers.tick(5000);
		await disposal;
		const reopened = new ReadingRepository(storage);
		await reopened.load();
		const writes = t.mock.method(storage, "write");
		finish({ destroy: async () => {} });
		const [result] = await outcome;
		await tick();
		if (delivery === "foreground") {
			assert.equal(result.status, "rejected");
			assert.equal(result.reason.cause, service.closeReason);
			assert.match(result.reason.saveError.message, /存储已关闭/);
		} else assert.equal(result.status, "fulfilled");
		assert.equal(service.repository.get(session.id).nodes.at(-1).status, "interrupted");
		assert.equal(reopened.get(session.id).nodes.at(-1).status, "interrupted");
		assert.deepEqual(failureEvents, []);
		assert.equal(notices.mock.callCount(), 0);
		assert.equal(writes.mock.callCount(), 0);
		await view.onClose();
	});
}

for (const entry of ["chat start", "map start", "continue"]) {
	test(entry + " stores an interrupted node without a foreground close Notice", async t => {
		const notices = t.mock.method(obsidian, "Notice");
		const session = createReadingSession(paper);
		if (entry === "continue") addReadingNode(session, null).status = "done";
		const storage = memoryStorage();
		await new ReadingRepository(storage).add(session);
		const { service, buttons } = await foregroundView(storage, session);
		const advance = t.mock.method(service, "advance");
		const start = buttons.filter(button => button.title === "开始讲解 →");
		const button = entry === "continue" ? buttons.find(button => button.title === "继续下一步主线")
			: start[entry === "chat start" ? 0 : 1];
		button.onclick();
		const unloading = service.dispose();
		await assert.rejects(advance.mock.calls[0].result, error => error === service.closeReason);
		await unloading;
		assert.equal(JSON.parse(await storage.read(session.id)).nodes.at(-1).status, "interrupted");
		assert.equal(notices.mock.callCount(), 0);
	});
}

test("a distinct foreground error with the same text still produces one Notice", async t => {
	const notices = t.mock.method(obsidian, "Notice");
	const f = await fixture(paperDoc, true);
	const { service, buttons } = await foregroundView(f.storage, f.session);
	// The write can fail after shutdown has started, independently of the close rejection.
	const write = t.mock.method(f.storage, "write", async () => {
		service.close();
		throw new Error(service.closeReason.message);
	});
	buttons.find(button => button.title === "继续下一步主线").onclick();
	await tick();
	assert.equal(write.mock.callCount(), 1);
	assert.deepEqual(notices.mock.calls.map(call => call.arguments), [[service.closeReason.message]]);
});

test("a real terminal disk error still produces one foreground Notice during normal unload", async t => {
	const notices = t.mock.method(obsidian, "Notice");
	const f = await fixture(paperDoc, true);
	const { service, buttons } = await foregroundView(f.storage, f.session);
	const write = f.storage.write.bind(f.storage), diskError = new Error("interruption write denied");
	f.storage.write = (id, text) => {
		if (JSON.parse(text).nodes.at(-1).status === "interrupted") throw diskError;
		return write(id, text);
	};
	const advance = t.mock.method(service, "advance");
	buttons.find(button => button.title === "继续下一步主线").onclick();
	const disposal = service.dispose();
	await assert.rejects(advance.mock.calls[0].result, error => error.saveError === diskError);
	await disposal;
	await tick();
	assert.equal(notices.mock.callCount(), 1);
	assert.match(notices.mock.calls[0].arguments[0], /interruption write denied/);
});

test("a new view after re-enable can advance and reports its own foreground errors", async t => {
	const notices = t.mock.method(obsidian, "Notice");
	const f = await fixture(paperDoc, true);
	const old = await foregroundView(f.storage, f.session);
	const unloading = old.service.dispose();
	old.buttons.find(button => button.title === "继续下一步主线").onclick();
	await unloading;
	await tick();
	assert.equal(notices.mock.callCount(), 0);
	const reopened = await foregroundView(f.storage, f.session);
	const { service, buttons } = reopened;
	const advance = t.mock.method(service, "advance");
	service.generateHandler = (id, nodeId) => service.repository.transact(id, session => {
		const node = session.nodes.find(node => node.id === nodeId);
		node.status = "done"; node.content = "Answer after re-enable";
	});
	const next = buttons.find(button => button.title === "继续下一步主线");
	next.onclick();
	await advance.mock.calls[0].result;
	assert.equal(JSON.parse(await f.storage.read(f.session.id)).nodes.at(-1).content, "Answer after re-enable");
	assert.equal(notices.mock.callCount(), 0);
	service.generateHandler = async () => { throw modelError; };
	next.onclick();
	await assert.rejects(advance.mock.calls[1].result, error => error === modelError);
	assert.deepEqual(notices.mock.calls.map(call => call.arguments), [[modelError.message]]);
	await service.dispose();
});

test("inline continue suppresses only its own workspace close Notice", async t => {
	const notices = t.mock.method(obsidian, "Notice");
	const f = await fixture(paperDoc, true);
	const buttons = new Map();
	function element() {
		return { dataset: {}, createDiv: element, createEl(tag, options) {
			const child = element();
			if (tag === "button") buttons.set(options.text, child);
			return child;
		} };
	}
	const pane = Object.assign(Object.create(InlinePaperReading.prototype), {
		workspace: f.service, key: paper.path, profileSelect: { value: "" },
		reader: { options: { document: { files: { en: { revision: { digest: paper.fingerprint } } } } } },
		turns: new Map(), guideLinks: new Map([[f.id, []]]), answerLayouts: [],
	});
	pane.renderThread(element(), undefined, f.session, undefined, undefined, f.current());
	await Promise.all(pane.answerLayouts);
	f.service.open = async () => ({ id: f.session.id, created: false });
	const next = buttons.get("继续主线");
	next.onclick();
	await f.service.dispose();
	await tick();
	assert.equal(notices.mock.callCount(), 0);
	f.service.open = async () => { throw modelError; };
	next.onclick();
	await tick();
	assert.deepEqual(notices.mock.calls.map(call => call.arguments), [[String(modelError)]]);
});

test("a persisted generation failure exposes the model reason and retry", async () => {
	const f = await fixture();
	await assert.rejects(f.service.generate(f.session.id, f.id), e => e === modelError);
	assert.equal(f.current().status, "failed");
	assert.equal(JSON.parse(f.storage.files.get(f.session.id)).nodes[0].status, "failed");
	const ui = render(f);
	assert.match(ui.text, /provider response truncated/);
	assert.ok(ui.retry);
});

test("model, usage-write and terminal-write failures remain visible; the next save restores a failed node", async () => {
	const f = await fixture();
	const write = f.storage.write.bind(f.storage);
	const usageError = new Error("usage write denied"), terminalError = new Error("terminal write denied");
	f.storage.write = (id, text) => {
		const node = JSON.parse(text).nodes[0];
		if (node.status === "failed") throw terminalError;
		if (node.usage?.at(-1)?.state === "failed") throw usageError;
		return write(id, text);
	};
	await assert.rejects(f.service.generate(f.session.id, f.id), e => {
		assert.match(e.message, /provider response truncated/);
		assert.match(e.message, /usage write denied/);
		assert.match(e.message, /terminal write denied/);
		assert.equal(e.cause.cause, modelError);
		assert.equal(e.cause.saveError, usageError);
		assert.equal(e.saveError, terminalError);
		return true;
	});
	assert.equal(f.current().status, "failed");
	assert.equal(JSON.parse(f.storage.files.get(f.session.id)).nodes[0].status, "running");
	await viewFor(f).onClose();
	const ui = render(f);
	for (const reason of [/provider response truncated/, /usage write denied/, /terminal write denied/, /未保存|尚未.*保存/]) assert.match(ui.text, reason);
	assert.ok(ui.retry);
	f.storage.write = write;
	await f.repo.transact(f.session.id, s => { s.title = "Saved"; });
	const restored = new ReadingRepository(f.storage); await restored.load();
	const saved = restored.get(f.session.id).nodes[0];
	assert.equal(saved.status, "failed");
	assert.match(saved.error, /provider response truncated/);
	assert.doesNotMatch(render(f).text, /terminal write denied/);
});

for (const offline of [false, true]) test("a rejected answer commit never publishes success; terminal write " + (offline ? "fails" : "succeeds"), async () => {
	const f = await fixture();
	const write = f.storage.write.bind(f.storage), published = [];
	f.repo.subscribe(() => published.push(f.current().status));
	f.backend.complete = async req => JSON.parse(req.prompt).output ? answer : '{"action":"ready"}';
	f.storage.write = async (id, text) => {
		if (JSON.parse(text).nodes[0].status === "done") throw new Error("answer write denied");
		if (offline && JSON.parse(text).nodes[0].status === "failed") throw new Error("terminal write denied");
		await write(id, text);
	};
	await assert.rejects(f.service.generate(f.session.id, f.id), /answer write denied/);
	assert.equal(f.current().status, "failed");
	assert.ok(!published.includes("done"));
	const ui = render(f);
	assert.match(ui.text, /生成结果保存失败/);
	assert.match(ui.text, /answer write denied/);
	if (offline) assert.match(ui.text, /terminal write denied/);
	assert.ok(ui.retry);
});

test("retry while offline re-enters generation and handles the rejected task", async () => {
	const f = await fixture();
	f.storage.fail = true;
	await assert.rejects(f.service.generate(f.session.id, f.id), /disk full/);
	const ui = render(f);
	assert.ok(ui.retry, "retry missing while disk is unwritable");
	let task;
	const generate = f.service.generate.bind(f.service);
	f.service.generate = (...args) => (task = generate(...args));
	ui.retry.onclick();
	assert.ok(task);
	await tick();
	await task;
	assert.equal(f.current().status, "failed");
	assert.match(render(f).text, /disk full/);
});

for (const entry of ["ask", "correct", "attachAnnotation", "askCode"]) {
	test(entry + " publishes its background rejection with session and node identity", async () => {
		const bytes = Buffer.from("print(3)\n");
		const doc = entry === "askCode" ? await openCodeProject(path.resolve("example.py"), {
			stat: async () => ({ file: true, size: bytes.length }), realpath: async p => p, read: async () => bytes,
		}) : paperDoc;
		const f = await fixture(doc, true), events = [];
		f.repo.subscribe((id, failure) => { if (failure) events.push({ id, ...failure }); });
		f.service.open = async () => ({ id: f.session.id, created: false });
		f.backend.complete = async () => { throw modelError; };
		let nodeId;
		if (entry === "askCode") nodeId = await f.service.askCode(f.session.id, f.id, doc.evidence[0].id, 0, 5, "Why?");
		else if (entry === "attachAnnotation") ({ nodeId } = await f.service.attachAnnotation(paper.path,
			{ id: "ann", path: "paper.md", chinese: false, at: 0, englishStart: 0, digest: paper.fingerprint,
				englishDigest: paper.fingerprint, selected: "text", question: "Why?", note: "", quotes: [] }, new AbortController().signal));
		else nodeId = await f.service[entry](f.session.id, f.id, "Why?");
		await tick(); await f.repo.flush();
		assert.equal(events.length, 1, "background failure was not published exactly once");
		assert.equal(events[0].id, f.session.id);
		assert.equal(events[0].nodeId, nodeId);
		assert.equal(events[0].error, modelError);
		assert.equal(f.repo.get(f.session.id).nodes.at(-1).status, "failed");
	});
}

test("a background handler that rejects before marking running leaves a retryable terminal node", async () => {
	const f = await fixture(paperDoc, true), events = [];
	f.service.generateHandler = async () => { throw modelError; };
	f.repo.subscribe((_, failure) => { if (failure) events.push(failure); });
	const nodeId = await f.service.ask(f.session.id, f.id, "Why?");
	await tick(); await f.repo.flush();
	const node = f.repo.get(f.session.id).nodes.find(node => node.id === nodeId);
	assert.equal(node.status, "failed");
	assert.equal(node.error, modelError.message);
	assert.deepEqual(events, [{ nodeId, error: modelError }]);
});

function holdAnswer(f) {
	let enter, release;
	const started = new Promise(resolve => { enter = resolve; });
	const gate = new Promise(resolve => { release = resolve; });
	const calls = { selection: 0, answer: 0 };
	f.backend.complete = async request => {
		if (!JSON.parse(request.prompt).output) { calls.selection++; return '{"action":"ready"}'; }
		calls.answer++; enter(request.signal);
		await gate;
		request.signal.throwIfAborted();
		return answer;
	};
	return { started, release, calls };
}

test("closing the last view lets the answer finish on disk and reopen without regeneration", async () => {
	const f = await fixture(), pending = holdAnswer(f);
	const task = f.service.generate(f.session.id, f.id, "background");
	const signal = await pending.started;
	try {
		await viewFor(f).onClose();
		assert.equal(signal.aborted, false, "closing the last view aborted the answer");
	} finally { pending.release(); await task; }
	const restored = new ReadingRepository(f.storage);
	await restored.load();
	assert.equal(restored.get(f.session.id).nodes[0].status, "done");
	f.service.repository = restored;
	assert.match(render(f).text, /Answer \[text-1-0\]/);
	assert.deepEqual(pending.calls, { selection: 1, answer: 1 });
});

test("two retry clicks on the same failed node run one generation", async () => {
	const f = await fixture();
	await assert.rejects(f.service.generate(f.session.id, f.id), e => e === modelError);
	const { retry } = render(f), pending = holdAnswer(f), tasks = [];
	const generate = f.service.generate.bind(f.service);
	f.service.generate = (...args) => { const task = generate(...args); tasks.push(task); return task; };
	retry.onclick(); retry.onclick();
	await pending.started;
	pending.release(); await Promise.all(tasks);
	assert.equal(tasks.length, 2);
	assert.deepEqual(pending.calls, { selection: 1, answer: 1 });
	assert.equal(f.current().status, "done");
});

test("a reloaded or quarantined session discards warnings from its previous in-memory snapshot", async () => {
	const f = await fixture();
	for (const quarantine of [false, true]) {
		f.storage.fail = true;
		await assert.rejects(f.service.generate(f.session.id, f.id), /disk full/);
		assert.match(render(f).text, /终态尚未保存/);
		f.storage.fail = false;
		const original = f.storage.files.get(f.session.id);
		if (quarantine) f.storage.files.set(f.session.id, "{broken");
		await f.repo.load();
		if (quarantine) {
			assert.equal(f.repo.sessions.has(f.session.id), false);
			assert.equal(f.storage.files.get(f.session.id), "{broken");
			f.storage.files.set(f.session.id, original);
			await f.repo.load();
		}
		assert.doesNotMatch(render(f).text, /终态尚未保存/);
	}
});

for (const action of ["stop", "unload workspace"]) {
	test(action + " interrupts the node without a failure event", async () => {
		const f = await fixture(), events = [];
		let begin, signal;
		const started = new Promise(resolve => { begin = resolve; });
		f.backend.complete = req => new Promise((_, reject) => {
			signal = req.signal; begin();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		f.repo.subscribe((id, failure) => { if (failure) events.push(failure); });
		const task = f.service.generate(f.session.id, f.id, "background");
		await started;
		try {
			if (action === "stop") f.service.stop(f.session.id, f.id);
			else await f.service.dispose();
			assert.ok(signal.aborted);
		} finally { if (!signal.aborted) f.service.stop(f.session.id, f.id); await task; }
		assert.equal(f.current().status, "interrupted");
		const saved = JSON.parse(await f.storage.read(f.session.id)).nodes[0];
		assert.equal(saved.status, "interrupted");
		assert.equal(saved.usage.at(-1).state, "interrupted");
		assert.deepEqual(events, []);
	});
}
