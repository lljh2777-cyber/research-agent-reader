"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { loadReading } = require("./reading-test-helpers");

const notices = [];
const mocks = { electron: {}, obsidian: {
	ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {}, Component: class {},
	setIcon() {}, MarkdownRenderer: { async render(_app, value, el) { el.setText(value); } },
	Notice: class { constructor(message) { notices.push(message); } },
} };
const { QueryWikiView } = loadReading("views/query-wiki.ts", mocks);
const Plugin = loadReading("plugin.ts", mocks).default;

const noImages = { attachments: [], notePaths: [], discoveredCount: 0, totalBytes: 0 };
const result = { exitCode: 0, stdout: "answer", stderr: "", events: [] };

function fixture() {
	const profile = { id: "vision", type: "openai-compatible", name: "Vision", model: "test", capabilities: { vision: true } };
	const session = { id: "session", queryBackendId: profile.id, retrievalMode: "vault", messages: [] };
	const runs = [];
	let messageId = 0;
	const snapshots = [];
	const host = Object.assign(new Plugin(), {
		querySessions: [session],
		saveData: async snapshot => { snapshots.push(snapshot); },
		getActiveQuerySession: () => session,
		resolveQueryBackendId: id => id,
		getProviderProfile: () => profile,
		isActionRunning: () => false,
		resolveQuestionImageAttachments: async () => noImages,
		resolveDirectQueryExecutionConfig: () => ({ model: profile.model }),
		buildQueryActionInput: question => question,
		createQueryMessageId: () => String(++messageId),
		startTaskRun: async () => {
			const run = { id: String(runs.length + 1) };
			runs.push(run);
			return run;
		},
		runDirectVaultQuery: async () => result,
		finishTaskRun: async (id, outcome) => Object.assign(runs.find(run => run.id === id), outcome),
	});
	const makeView = () => {
		const view = new QueryWikiView({}, host);
		view.render = async () => {};
		return view;
	};
	return { host, session, runs, snapshots, view: makeView(), makeView };
}

function pauseImageResolution(host) {
	let release;
	const pending = new Promise(resolve => { release = () => resolve(noImages); });
	host.resolveQuestionImageAttachments = () => pending;
	return release;
}

function counts({ session, runs }) {
	return {
		users: session.messages.filter(m => m.role === "user").length,
		replies: session.messages.filter(m => m.role === "assistant").length,
		tasks: runs.length,
	};
}

const oneTurn = { users: 1, replies: 1, tasks: 1 };
const noTurn = { users: 0, replies: 0, tasks: 0 };

for (const otherView of [false, true]) {
	test("same-tick submissions start one turn " + (otherView ? "across views" : "in one view"), async () => {
		const f = fixture();
		const secondView = otherView ? f.makeView() : f.view;
		const release = pauseImageResolution(f.host);
		const first = f.view.submitQuestion("first");
		const second = secondView.submitQuestion("second");
		release();
		await Promise.all([first, second]);
		assert.deepEqual(counts(f), oneTurn);
		assert.equal(f.session.messages[0].content, "first");
	});
}

test("attachment failure shows the cause, preserves the draft and attachments, and permits resubmission", async () => {
	const f = fixture();
	const question = "inspect this figure";
	const image = { path: "fig.png", name: "fig.png", size: 10, mimeType: "image/png", sourceNotePath: "" };
	f.view.setInitialQuestion(question);
	f.view.pendingImages = [image];
	f.host.resolveQuestionImageAttachments = async () => { throw new Error("figure read denied"); };
	const before = notices.length;
	await f.view.submitQuestion(question);
	assert.deepEqual(counts(f), noTurn);
	assert.ok(notices.slice(before).some(message => message.includes("figure read denied")));
	assert.equal(f.view.queryDrafts.get(f.session.id), question);
	assert.deepEqual(f.view.pendingImages, [image]);

	f.host.resolveQuestionImageAttachments = async () => noImages;
	await f.view.submitQuestion(question);
	assert.deepEqual(counts(f), oneTurn);
	assert.deepEqual(f.session.messages[0].attachments, [image]);
});

test("Send is disabled synchronously while resolving attachments and starts one task", async t => {
	const f = fixture();
	const release = pauseImageResolution(f.host);
	const fields = new Map();
	class Element extends EventTarget {
		createEl(tag, options) {
			const child = new Element();
			fields.set(options?.attr?.["aria-label"] || tag, child);
			return child;
		}
		createDiv(options) { return this.createEl("div", options); }
		createSpan(options) { return this.createEl("span", options); }
		removeAttribute() {}
		addClass() {}
	}
	t.mock.method(f.view, "renderExecutionSettings", () => {});
	t.mock.method(f.view, "renderRetrievalModeSwitch", () => {});
	const oldWindow = globalThis.window;
	globalThis.window = { requestAnimationFrame() {} };
	try {
		f.view.setInitialQuestion("question");
		f.view.renderComposer(new Element());
	} finally {
		globalThis.window = oldWindow;
	}
	const submit = t.mock.method(f.view, "submitQuestion");
	const send = fields.get("发送问题");
	assert.equal(send.disabled, false);
	send.dispatchEvent(new Event("click"));
	const disabledWhileResolving = send.disabled;
	await Promise.resolve();
	send.dispatchEvent(new Event("click"));
	release();
	await Promise.all(submit.mock.calls.map(call => call.result));
	assert.equal(disabledWhileResolving, true);
	assert.deepEqual(counts(f), oneTurn);
});

test("a synchronous preparation error releases the submission", async () => {
	const f = fixture();
	f.host.buildQueryActionInput = () => { throw new Error("input unavailable"); };
	await assert.rejects(f.view.submitQuestion("first"), /input unavailable/);
	assert.deepEqual(counts(f), noTurn);
	f.host.buildQueryActionInput = question => question;
	await f.view.submitQuestion("second");
	assert.deepEqual(counts(f), oneTurn);
});

test("a cancelled query releases the submission", async () => {
	const f = fixture();
	f.host.runDirectVaultQuery = async () => ({ ...result, exitCode: 130, stdout: "" });
	await f.view.submitQuestion("first");
	assert.equal(f.session.messages[1].status, "interrupted");
	f.host.runDirectVaultQuery = async () => result;
	await f.view.submitQuestion("next");
	assert.deepEqual(f.runs.map(run => run.status), ["interrupted", "done"]);
});

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function lifecycleFixture(t, cli = false) {
	const f = fixture();
	const started = deferred(), answer = deferred();
	let executions = 0, stops = 0;
	function run(hooks) {
		executions++;
		started.resolve(hooks);
		return answer.promise;
	}
	f.host.runDirectVaultQuery = (_run, _provider, _question, _prior, _mode, hooks) => run(hooks);
	f.host.runVaultAction = (_run, _action, _input, _config, hooks) => run(hooks);
	if (cli) f.session.queryBackendId = "codex-cli";
	f.host.isQueryExecutionActive = () => true;
	f.host[cli ? "stopVaultAction" : "stopDirectVaultQuery"] = () => {
		stops++;
		answer.resolve({ ...result, exitCode: 130, stdout: "" });
		return true;
	};
	const previousWindow = globalThis.window;
	const frames = new Map();
	let nextFrame = 0;
	globalThis.window = {
		requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
		cancelAnimationFrame(id) { frames.delete(id); },
		setTimeout, clearTimeout,
	};
	t.after(() => { globalThis.window = previousWindow; });
	return { ...f, started: started.promise, answer, executions: () => executions, stops: () => stops,
		flushFrames() { for (const [id, fn] of frames) { frames.delete(id); fn(); } } };
}

function screen(f) {
	const view = f.makeView(), ops = [], labels = [];
	class Element {
		createEl(tag, options = {}) {
			ops.push(tag);
			if (options.text) labels.push(options.text);
			return new Element();
		}
		createDiv(options) { return this.createEl("div", options); }
		createSpan(options) { return this.createEl("span", options); }
		setText(value) { labels.push(value); ops.push("setText"); }
		addClass() {}
		addEventListener() {}
		empty() { ops.push("empty"); labels.length = 0; }
		querySelector() { ops.push("querySelector"); return null; }
		set scrollTop(value) { ops.push("scroll"); }
		get isConnected() { return true; }
	}
	view.contentEl = new Element();
	view.render = QueryWikiView.prototype.render;
	view.renderHeader = view.renderComposer = view.renderEmptyState = () => {};
	return { view, ops, labels, renders: () => ops.filter(op => op === "empty").length };
}

for (const failed of [false, true]) {
	test("closed query saves " + (failed ? "server failure" : "answer") + " without touching the old DOM", async t => {
		const f = lifecycleFixture(t), old = screen(f);
		await old.view.onOpen();
		const task = old.view.submitQuestion("inspect");
		const hooks = await f.started;
		await old.view.onClose();
		const before = old.ops.length;
		hooks.onEvent({ type: "assistant-delta", delta: "partial" });
		hooks.onEvent({ type: "assistant-reset" });
		if (failed) f.answer.reject(new Error("server rejected query"));
		else f.answer.resolve(result);
		await task;
		f.flushFrames();
		const saved = f.snapshots.at(-1).querySessions[0].messages[1];
		assert.equal(saved.status, failed ? "failed" : "done");
		assert.equal(f.stops(), 0);
		const fresh = screen(f);
		await fresh.view.onOpen();
		assert.ok(fresh.labels.includes(failed ? "server rejected query" : result.stdout));
		assert.deepEqual(old.ops.slice(before), []);
	});
}

test("immediate reopen delivers one render per retrieval event only to the open view", async t => {
	const f = lifecycleFixture(t), old = screen(f), fresh = screen(f);
	const service = f.host.queryTasks;
	const subscribe = service.subscribe.bind(service);
	let subscriptions = 0;
	t.mock.method(service, "subscribe", listener => {
		const off = subscribe(listener);
		subscriptions++;
		return () => { off(); subscriptions--; };
	});
	await old.view.onOpen();
	const task = old.view.submitQuestion("inspect");
	const hooks = await f.started;
	const closing = old.view.onClose();
	assert.equal(subscriptions, 0);
	const closedRenders = old.renders();
	await Promise.all([closing, fresh.view.onOpen()]);
	assert.equal(subscriptions, 1);
	assert.ok(fresh.labels.includes("正在准备检索"));
	const openRenders = fresh.renders();
	hooks.onEvent({ type: "retrieval-result", payload: { answer_markdown: "live answer" } });
	await tick();
	assert.deepEqual([old.renders() - closedRenders, fresh.renders() - openRenders], [0, 1]);
	assert.ok(fresh.labels.includes("live answer"));
	f.answer.resolve(result);
	await task;
	await fresh.view.onClose();
	assert.equal(subscriptions, 0);
});

test("close, reopen, close during one CLI execution saves one assistant reply", async t => {
	const f = lifecycleFixture(t, true), first = screen(f), second = screen(f);
	await first.view.onOpen();
	const task = first.view.submitQuestion("inspect");
	const hooks = await f.started;
	await first.view.onClose();
	await second.view.onOpen();
	const refreshes = second.renders();
	hooks.onEvent({ type: "retrieval-result", payload: { answer_markdown: "still running" } });
	await tick();
	assert.equal(second.renders() - refreshes, 1);
	await second.view.onClose();
	const before = second.ops.length;
	f.answer.resolve(result);
	await task;
	f.flushFrames();
	assert.deepEqual(second.ops.slice(before), []);
	assert.equal(f.executions(), 1);
	assert.equal(f.stops(), 0);
	assert.deepEqual(counts(f), oneTurn);
	assert.deepEqual(f.snapshots.at(-1).querySessions[0].messages.map(m => m.role), ["user", "assistant"]);
});

for (const cli of [false, true]) {
	test("plugin unload cancels a detached " + (cli ? "CLI" : "Direct API") + " task and persists interruption", async t => {
		const f = lifecycleFixture(t, cli), old = screen(f);
		await old.view.onOpen();
		const task = old.view.submitQuestion("inspect");
		await f.started;
		await old.view.onClose();
		const unloading = f.host.onunload();
		await tick();
		f.answer.resolve(result);
		await Promise.all([unloading, task]);
		assert.equal(f.stops(), 1);
		assert.equal(f.snapshots.at(-1).querySessions[0].messages[1].status, "interrupted");
	});
}

test("unload during image resolution prevents a later backend start", async t => {
	const f = lifecycleFixture(t);
	const release = pauseImageResolution(f.host);
	const task = f.view.submitQuestion("inspect");
	const unloading = f.host.onunload();
	release();
	f.answer.resolve(result);
	await Promise.all([unloading, task]);
	assert.deepEqual(counts(f), noTurn);
});

test("closing during asynchronous Markdown rendering invalidates the pending view update", async t => {
	const f = lifecycleFixture(t), old = screen(f), drawing = deferred(), resume = deferred();
	f.session.messages.push({ id: "previous", role: "assistant", status: "done", content: "answer",
		createdAt: new Date().toISOString(), retrievalTrace: { retrieval_label: "ready" } });
	t.mock.method(mocks.obsidian.MarkdownRenderer, "render", async () => { drawing.resolve(); await resume.promise; });
	const opening = old.view.onOpen();
	await drawing.promise;
	await old.view.onClose();
	const before = old.ops.length;
	resume.resolve();
	await opening;
	f.flushFrames();
	assert.deepEqual(old.ops.slice(before), []);
});

for (const phase of ["keywords", "evidence"]) {
	test("unload during Direct API " + phase + " cancels model work before the answer", async t => {
		const f = lifecycleFixture(t), paused = deferred(), resume = deferred();
		const profile = { ...f.host.getProviderProfile(), lastTest: { ok: true } };
		f.host.getProviderProfile = () => profile;
		f.host.runDirectVaultQuery = Plugin.prototype.runDirectVaultQuery;
		f.host.stopDirectVaultQuery = Plugin.prototype.stopDirectVaultQuery;
		f.host.runVaultRetrievalPreflight = async () => ({ candidate_paths: phase === "keywords" ? [] : ["paper.md"] });
		f.host.readVaultEvidencePacket = async () => {
			if (phase === "evidence") { paused.resolve(); await resume.promise; }
			return [];
		};
		let aborts = 0, answers = 0;
		f.host.createLLMProvider = () => ({ async complete(request, options) {
			if (request.maxTokens === 256) {
				options?.registerCancel?.(() => { aborts++; resume.reject(new Error("cancelled")); });
				paused.resolve();
				await resume.promise;
				return { text: '{"keywords":[]}' };
			}
			answers++;
			return { text: "unexpected answer" };
		} });
		const task = f.view.submitQuestion("inspect");
		await paused.promise;
		const unloading = f.host.onunload();
		await tick();
		resume.resolve();
		await Promise.all([task, unloading]);
		assert.deepEqual({ aborts, answers }, { aborts: phase === "keywords" ? 1 : 0, answers: 0 });
		assert.equal(f.snapshots.at(-1).querySessions[0].messages[1].status, "interrupted");
	});
}

function useTaskHistory(f) {
	f.host.startTaskRun = Plugin.prototype.startTaskRun;
	f.host.finishTaskRun = Plugin.prototype.finishTaskRun;
	f.host.persistTaskRunOutput = async () => "";
}

async function runningQueryWithSaveFailure(t) {
	const f = lifecycleFixture(t);
	useTaskHistory(f);
	const task = f.view.submitQuestion("inspect");
	const hooks = await f.started;
	const before = notices.length;
	const error = "test disk read-only";
	const disk = { writable: false, attempts: 0 };
	const save = f.host.saveData;
	f.host.saveData = async snapshot => {
		disk.attempts++;
		if (!disk.writable) throw new Error(error);
		await save(snapshot);
	};
	return {
		...f, task, hooks, disk,
		saveNotices: () => notices.slice(before).filter(message => message.includes(error)),
		async writeProgress(count = 1) {
			for (let i = 0; i < count; i++) hooks.onEvent({ type: "status", label: "retrieving " + i });
			await f.host.flushScheduledSettingsSave();
			await tick();
		},
	};
}

test("one failed write for three progress events shows one Notice", async t => {
	const f = await runningQueryWithSaveFailure(t);
	for (let i = 0; i < 12; i++) f.hooks.onEvent({ type: "assistant-delta", delta: "x" });
	assert.equal(f.disk.attempts, 0);
	assert.equal(f.saveNotices().length, 0);
	await f.writeProgress(3);
	assert.equal(f.disk.attempts, 1);
	const noticeCount = f.saveNotices().length;
	f.disk.writable = true;
	await f.writeProgress();
	f.answer.resolve(result);
	await f.task;
	assert.equal(noticeCount, 1);
});

test("only a successful write resets the save failure Notice", async t => {
	const f = await runningQueryWithSaveFailure(t);
	const counts = [];
	for (const writable of [false, false, true, false]) {
		f.disk.writable = writable;
		await f.writeProgress();
		counts.push(f.saveNotices().length);
	}
	assert.equal(f.disk.attempts, 4);
	f.disk.writable = true;
	await f.writeProgress();
	f.answer.resolve(result);
	await f.task;
	assert.deepEqual(counts, [1, 1, 1, 2]);
});

test("persistent write failures preserve a completed answer and release the task", async t => {
	const f = await runningQueryWithSaveFailure(t);
	await f.writeProgress();
	f.answer.resolve(result);
	await assert.doesNotReject(f.task);
	assert.equal(f.session.messages[1].content, result.stdout);
	assert.equal(f.session.messages[1].status, "done");
	assert.equal(f.host.taskRuns[0].status, "done");
	assert.equal(f.host.queryTasks.forSession(f.session.id), null);
	assert.equal(f.saveNotices().length, 1);
	assert.equal(f.snapshots.at(-1).querySessions[0].messages[1].status, "pending");
});

// Exact desktop data.json bytes from the same running queries on commit 2a70baa.
for (const [backend, expectedHash] of [
	["vision", "6df0257c390080636f8f1114cbeb5326b827cbd94eb2cd9d6fb2ebdfa5eebe30"],
	["codex-cli", "5d09a7aa93d6ce2ac5c3bbaf45c8daf7a5b7948257aa23fbe662fb2cf41cc09d"],
]) test("running history bytes remain compatible for " + backend, async t => {
	t.mock.timers.enable({ apis: ["Date"], now: 1760000000000 });
	t.mock.method(Math, "random", () => 0.4123456);
	const f = lifecycleFixture(t, backend === "codex-cli");
	// Keep machine-specific plugin settings out of the byte baseline.
	f.host.settings = { providerProfiles: [], activeProviderId: "" };
	f.host.activeQuerySessionId = f.session.id;
	f.host.resolveActionExecutionConfig = () => ({ model: "test" });
	useTaskHistory(f);
	let bytes;
	const { desktopSettingsFile } = loadReading("runtime/persistence.ts", { "node:fs/promises": {
		readFile: async () => "{}",
		open: async () => ({
			writeFile: async (text, encoding) => { bytes = Buffer.from(text, encoding); },
			sync: async () => {}, close: async () => {},
		}),
		rename: async () => {},
	} });
	const file = desktopSettingsFile("memory");
	await file.load();
	f.host.saveData = file.save;
	const task = f.view.submitQuestion("inspect");
	const hooks = await f.started;
	try {
		hooks.onEvent({ type: "assistant-delta", delta: "partial text" });
		hooks.onEvent({ type: "status", label: "retrieving" });
		await f.host.flushScheduledSettingsSave();
		const saved = JSON.parse(bytes);
		const reply = saved.querySessions[0].messages[1];
		assert.equal(saved.taskRuns[0].status, "running");
		assert.equal(reply.status, "pending");
		assert.equal(reply.runId, saved.taskRuns[0].id);
		assert.equal(reply.content, "partial text");
		assert.equal(reply.progress, "retrieving");
		assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
	} finally {
		f.answer.resolve(result);
		await task;
	}
});
