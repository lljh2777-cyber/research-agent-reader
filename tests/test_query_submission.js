"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { loadReading } = require("./reading-test-helpers");

const notices = [];
const mocks = { electron: {}, obsidian: {
	FileSystemAdapter: class {},
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
		saveFullAnswer: async () => {},
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
	const buttons = new Map();
	class Element {
		constructor(messageId) { this.messageId = messageId; }
		createEl(tag, options = {}) {
			ops.push(tag);
			if (options.text) labels.push(options.text);
			const child = new Element(options.attr?.["data-message-id"] ?? this.messageId);
			if (tag === "button") buttons.set(child.messageId + "/" + options.attr?.["aria-label"], child);
			return child;
		}
		createDiv(options) { return this.createEl("div", options); }
		createSpan(options) { return this.createEl("span", options); }
		setText(value) { labels.push(value); ops.push("setText"); }
		addClass() {}
		addEventListener(type, fn) { if (type === "click") this.click = fn; }
		empty() { ops.push("empty"); labels.length = 0; }
		querySelector() { ops.push("querySelector"); return null; }
		set scrollTop(value) { ops.push("scroll"); }
		get isConnected() { return true; }
	}
	view.contentEl = new Element();
	view.render = QueryWikiView.prototype.render;
	view.renderHeader = view.renderComposer = view.renderEmptyState = () => {};
	return { view, ops, labels, buttons, renders: () => ops.filter(op => op === "empty").length };
}

async function reloadHistory(snapshot) {
	const host = new Plugin();
	host.app = { vault: { adapter: {} } };
	const bytes = JSON.stringify(snapshot);
	host.loadData = async () => JSON.parse(bytes);
	let saved;
	host.saveData = async next => { saved = next; };
	await host.loadSettings();
	await host.saveSettings();
	return { host, messages: host.getActiveQuerySession().messages, saved: saved.querySessions[0].messages };
}

const fsPromises = require("node:fs/promises");
const actionQuestion = { id: "message-first", role: "user", status: "done", content: "原问题" };
const actionReply = { id: "message-reply", role: "assistant", status: "done", content: "原会话回答", createdAt: "2026-01-02T03:04:00.000Z" };

async function answerButtons(t, reply = {}, fileText) {
	const path = require("node:path");
	const root = await fsPromises.mkdtemp(path.join(require("node:os").tmpdir(), "reader-answer-buttons-"));
	const original = { id: "query-first", title: "原会话", messages: [actionQuestion, { ...actionReply, ...reply }] };
	const other = { id: "query-second", title: "第二会话", messages: [actionQuestion, { ...actionReply, content: "其他会话回答" }] };
	const { host } = await reloadHistory({ settings: {}, querySessions: [original, other], activeQuerySessionId: original.id });
	const session = host.getActiveQuerySession();
	const rootAccess = t.mock.method(host, "readingPluginDirectory", () => root);
	if (fileText !== undefined) {
		const dir = path.join(root, "task-output", "query-answers", original.id);
		await fsPromises.mkdir(dir, { recursive: true });
		await fsPromises.writeFile(path.join(dir, actionReply.id + ".md"), fileText);
	}
	const notes = new Map();
	Object.assign(host.app.vault, {
		getAbstractFileByPath: file => notes.has(file) ? { path: file } : null,
		createFolder: async () => {},
		create: async (file, content) => notes.set(file, content),
	});
	const clipboard = [];
	const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
		clipboard: { writeText: async text => { clipboard.push(text); } },
	} });
	const oldWindow = globalThis.window;
	globalThis.window = { requestAnimationFrame() {}, setTimeout() {} };
	t.after(() => {
		if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
		else Reflect.deleteProperty(globalThis, "navigator");
		globalThis.window = oldWindow;
	});
	const ui = screen({ makeView: () => new QueryWikiView({}, host) });
	await ui.view.onOpen();
	const start = notices.length;
	return {
		host, session, rootAccess, notes, clipboard, notices: () => notices.slice(start),
		copy: (id = actionReply.id) => ui.buttons.get(id + "/复制本条内容").click(),
		note: () => ui.buttons.get(actionReply.id + "/将本回答保存为笔记").click(),
	};
}

test("answer buttons: the old note button saves the rendered session after switching sessions", async t => {
	const f = await answerButtons(t);
	f.host.activeQuerySessionId = "query-second";
	await f.note();
	const [note] = f.notes.values();
	assert.equal(note.split("\n\n")[1], "原会话回答");
	await f.copy();
	assert.deepEqual(f.clipboard, ["原会话回答"]);
});

test("answer buttons: copy the full 25000 units after restart without a Notice", async t => {
	const answer = "📖".repeat(12500);
	const f = await answerButtons(t, { content: answer.slice(0, 8000), contentLength: answer.length }, answer);
	await f.copy();
	assert.equal(f.clipboard.length, 1);
	assert.equal(f.clipboard[0].length, 25000);
	assert.equal(f.clipboard[0], answer);
	assert.deepEqual(f.notices(), []);
});

test("answer buttons: a missing file copies only the preview and explains it once", async t => {
	const preview = "答".repeat(8000);
	const f = await answerButtons(t, { content: preview, contentLength: 25000 });
	await f.copy();
	assert.deepEqual(f.clipboard, [preview]);
	assert.equal(f.notices().length, 1);
	assert.match(f.notices()[0], /截短/);
	assert.match(f.notices()[0], /回答文件不存在/);
});

test("answer buttons: a complete file produces exactly the original note format", async t => {
	const f = await answerButtons(t, { content: "前缀", contentLength: 6 }, "前缀完整正文");
	await f.note();
	const [note] = f.notes.values();
	const expected = [
		"---", 'title: "原问题"', "created: 2026-01-02T03:04:00.000Z", "type: qa", "tags:", "  - qa",
		'source: "原会话"', "---", "# 原问题", "", "前缀完整正文", "", "## 来源", "- 无", "",
	].join("\n");
	assert.deepEqual(Buffer.from(note), Buffer.from(expected));
	assert.deepEqual(f.notices(), ["已保存笔记：" + [...f.notes.keys()][0]]);
});

test("answer buttons: longer partial file supplies note text and exact UTF-16 counts", async t => {
	const part = "📖".repeat(59999) + "  ";
	const f = await answerButtons(t, { content: part.slice(0, 8000), contentLength: 130000 }, part);
	await f.note();
	const [note] = f.notes.values();
	const block = "> 注意：聊天记录中的回答已被截短（原文 130000 字符，本笔记保留 120000 字符）";
	assert.ok(note.includes("\n\n" + part + "\n\n" + block + "\n\n## 来源"));
	assert.equal(f.notices().length, 1);
	assert.match(f.notices()[0], /部分原文/);
});

test("answer buttons: direct note callers still get a path and the first message cannot be saved", async t => {
	const f = await answerButtons(t);
	const saved = await f.host.saveQueryAnswerNote(f.session.id, actionReply.id);
	assert.ok(f.notes.has(saved));
	assert.deepEqual(f.notices(), []);
	f.session.messages.shift();
	await f.note();
	assert.equal(f.notes.size, 1);
	assert.deepEqual(f.notices(), ["落笔记失败：找不到要落笔记的回答"]);
});

test("answer buttons: clipboard error shows a Chinese reason without stack frames", async t => {
	const f = await answerButtons(t);
	t.mock.method(globalThis.navigator.clipboard, "writeText", async () => { throw new Error("EIO\n    at writeText (clipboard.js:1:2)"); });
	await f.copy();
	assert.deepEqual(f.notices(), ["复制失败：系统错误（EIO）"]);
});

test("answer buttons: failed read saves a marked note and gives one readable Notice", async t => {
	const f = await answerButtons(t, { content: "预览", contentLength: 9000 }, "更长正文");
	t.mock.method(fsPromises, "open", async () => { throw new Error("EACCES\n    at open (reader.js:1:2)"); });
	await f.note();
	const [note] = f.notes.values();
	assert.match(note, /\n\n预览\n\n> 注意：聊天记录中的回答已被截短（原文 9000 字符，本笔记保留 2 字符）\n\n## 来源/);
	assert.equal(f.notices().length, 1);
	assert.match(f.notices()[0], /已保存笔记/);
	assert.match(f.notices()[0], /权限/);
	assert.doesNotMatch(f.notices()[0], /at open|reader\.js/);
});

test("answer buttons: both actions use the updated message at click time", async t => {
	const f = await answerButtons(t);
	f.session.messages[1] = { ...f.session.messages[1], content: "更新后的回答" };
	await f.copy();
	await f.note();
	assert.deepEqual(f.clipboard, ["更新后的回答"]);
	assert.ok([...f.notes.values()][0].includes("\n\n更新后的回答\n\n"));
	assert.equal(f.rootAccess.mock.callCount(), 0);
});

for (const removed of ["message", "session"]) {
	test("answer buttons: deleted " + removed + " preserves clipboard and does not create a note", async t => {
		const f = await answerButtons(t);
		f.clipboard.push("原剪贴板");
		if (removed === "session") f.host.querySessions = [];
		else f.session.messages.pop();
		await f.copy();
		await f.note();
		assert.deepEqual(f.clipboard, ["原剪贴板"]);
		assert.equal(f.notes.size, 0);
		assert.deepEqual(f.notices(), ["复制失败：找不到要复制的消息", "落笔记失败：找不到要落笔记的回答"]);
	});
}

test("answer buttons: first user message and unfinished answers copy from memory", async t => {
	const f = await answerButtons(t);
	await f.copy(actionQuestion.id);
	for (const status of ["pending", "stopping", "failed", "interrupted"]) {
		f.session.messages[1] = { ...f.session.messages[1], status, content: status, contentLength: 9000 };
		await f.copy();
	}
	assert.deepEqual(f.clipboard, ["原问题", "pending", "stopping", "failed", "interrupted"]);
	assert.equal(f.rootAccess.mock.callCount(), 0);
	assert.deepEqual(f.notices(), []);
});

test("answer buttons: a pending file read keeps the content and length from the click", async t => {
	const f = await answerButtons(t, { content: "原", contentLength: 9 }, "原文的片段");
	const opened = deferred(), release = deferred();
	const actualOpen = fsPromises.open;
	t.mock.method(fsPromises, "open", async (...args) => {
		opened.resolve();
		await release.promise;
		return actualOpen(...args);
	});
	const click = f.note();
	await Promise.race([opened.promise, click]);
	f.session.messages[1].content = "之后的内容";
	f.session.messages[1].contentLength = 10000;
	release.resolve();
	await click;
	assert.ok([...f.notes.values()][0].includes("原文的片段\n\n> 注意：聊天记录中的回答已被截短（原文 9 字符，本笔记保留 5 字符）"));
});

async function truncationHints(host, message) {
	const ui = screen({ makeView: () => new QueryWikiView({}, host) });
	await ui.view.renderMessage(ui.view.contentEl, message, host.getActiveQuerySession().id);
	return ui.labels.filter(label => label.startsWith("内容已截短"));
}

test("contentLength counts the trimmed final answer once and survives a history round trip", async t => {
	const f = lifecycleFixture(t);
	const answer = "📖".repeat(12500);
	const task = f.view.submitQuestion("inspect");
	const hooks = await f.started;
	hooks.onEvent({ type: "assistant-delta", delta: answer + "discarded partial" });
	const partial = f.session.messages[1];
	assert.equal(partial.content.length, 20000);
	assert.equal(partial.contentLength, undefined);
	const event = { type: "retrieval-result", payload: { answer_markdown: "  " + answer + "\n" } };
	hooks.onEvent(event);
	f.answer.resolve({ ...result, events: [event] });
	await task;

	const live = f.session.messages[1];
	assert.equal(live.content, answer.slice(0, 20000));
	assert.equal(live.contentLength, 25000);
	assert.deepEqual(await truncationHints(f.host, live), ["内容已截短（原文 25000 字符，当前保留 20000 字符）"]);
	const snapshot = f.snapshots.at(-1);
	const stored = snapshot.querySessions[0].messages[1];
	assert.equal(stored.content, answer.slice(0, 8000));
	assert.equal(stored.contentLength, 25000);
	const reload = await reloadHistory(snapshot);
	assert.deepEqual(await truncationHints(reload.host, reload.messages[1]), ["内容已截短（原文 25000 字符，当前保留 8000 字符）"]);
	assert.equal(reload.saved[1].content, stored.content);
	assert.equal(reload.saved[1].contentLength, 25000);
});

test("contentLength uses the pre-snapshot assistant length and omits it for users", async () => {
	const f = fixture();
	const content = "a".repeat(9000);
	f.session.messages.push(
		{ role: "user", content, contentLength: 12000, status: "done" },
		{ role: "assistant", content, status: "done" },
	);
	await f.host.saveSettings();
	const snapshot = f.snapshots.at(-1);
	const [user, answer] = snapshot.querySessions[0].messages;
	assert.equal(answer.content.length, 8000);
	assert.equal(answer.contentLength, 9000);
	assert.equal(user.content.length, 8000);
	assert.equal(Object.hasOwn(user, "contentLength"), false);
	const reload = await reloadHistory(snapshot);
	assert.deepEqual(await truncationHints(reload.host, reload.messages[1]), ["内容已截短（原文 9000 字符，当前保留 8000 字符）"]);
});

test("contentLength is optional for old and short answers and ignores invalid lengths on load", async () => {
	const messages = [undefined, -1, "9000", NaN, 9999.5, 2, 5].map(contentLength =>
		({ role: "assistant", status: "done", content: "short", contentLength }));
	const reload = await reloadHistory({ settings: {}, querySessions: [{ id: "short", messages }] });
	for (const [index, message] of reload.messages.entries()) {
		assert.equal(message.contentLength ?? message.content.length, 5);
		assert.deepEqual(await truncationHints(reload.host, message), []);
		assert.equal(Object.hasOwn(reload.saved[index], "contentLength"), false);
	}
});

test("contentLength only shows a hint for a completed assistant answer", async () => {
	const f = fixture();
	await f.view.submitQuestion("short reply");
	assert.deepEqual(await truncationHints(f.host, f.session.messages[1]), []);
	assert.equal(Object.hasOwn(f.snapshots.at(-1).querySessions[0].messages[1], "contentLength"), false);
	for (const status of ["pending", "stopping", "failed", "interrupted", "done"]) {
		const role = status === "done" ? "user" : "assistant";
		assert.deepEqual(await truncationHints(f.host, { role, status, content: "part", contentLength: 9000 }), []);
	}
});

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

test("full answer writes the complete trimmed 25000-unit result before the done update", async t => {
	const f = lifecycleFixture(t, true);
	const answer = "📖".repeat(12500);
	const order = [];
	const save = t.mock.method(f.host, "saveFullAnswer", async () => {
		order.push("write");
		await tick();
		order.push("written");
	});
	const update = f.host.updateQueryMessage.bind(f.host);
	f.host.updateQueryMessage = (sessionId, messageId, patch, mode) => {
		if (patch.status === "done") order.push("done");
		return update(sessionId, messageId, patch, mode);
	};
	const task = f.view.submitQuestion("inspect");
	const hooks = await f.started;
	hooks.onEvent({ type: "assistant-delta", delta: answer });
	assert.equal(f.session.messages[1].content.length, 20000);
	const event = { type: "retrieval-result", payload: { answer_markdown: " \n" + answer + "\n" } };
	hooks.onEvent(event);
	f.answer.resolve({ ...result, stdout: "unused stdout", events: [event] });
	await task;
	assert.equal(save.mock.callCount(), 1);
	assert.deepEqual(save.mock.calls[0].arguments, [f.session.id, f.session.messages[1].id, answer]);
	assert.deepEqual(order, ["write", "written", "done"]);
});

for (const [length, writes] of [[0, 0], [8000, 0], [8001, 1]]) {
	test("full answer write threshold at " + length + " UTF-16 units", async t => {
		const f = fixture();
		const save = t.mock.method(f.host, "saveFullAnswer");
		f.host.runDirectVaultQuery = async () => ({ ...result, stdout: "x".repeat(length) });
		await f.view.submitQuestion("inspect");
		assert.equal(f.session.messages[1].status, "done");
		assert.equal(save.mock.callCount(), writes);
	});
}

for (const failHistory of [false, true]) {
	test("full answer write failure preserves completion with " + (failHistory ? "failed" : "successful") + " history save", async t => {
		const f = lifecycleFixture(t);
		const answer = "x".repeat(9000);
		const task = f.view.submitQuestion("inspect");
		await f.started;
		const before = notices.length;
		const expected = ["完整回答未能保存，重启后复制和落笔记只能得到截短版本：answer file read-only"];
		f.host.saveFullAnswer = async () => { throw new Error("answer file read-only"); };
		if (failHistory) {
			f.host.saveData = async () => { throw new Error("history read-only"); };
			expected.push("查询记录保存失败：history read-only");
		}
		f.answer.resolve({ ...result, stdout: answer });
		await assert.doesNotReject(task);
		assert.equal(f.runs[0].status, "done");
		assert.equal(f.session.messages[1].status, "done");
		assert.equal(f.session.messages[1].content, answer);
		assert.equal(f.session.messages[1].contentLength, answer.length);
		assert.deepEqual(notices.slice(before), expected);
	});
}

for (const [label, exitCode, events, status] of [
	["backend failure", 1, [], "failed"],
	["interrupted exit", 130, [], "interrupted"],
	["stop event despite a zero exit", 0, [{ type: "status", stage: "stopped" }], "done"],
]) {
	test("full answer skips " + label + " even with long stdout", async t => {
		const f = fixture();
		const save = t.mock.method(f.host, "saveFullAnswer");
		f.host.runDirectVaultQuery = async () => ({ ...result, exitCode, events, stdout: "x".repeat(9000) });
		await f.view.submitQuestion("inspect");
		assert.equal(f.session.messages[1].status, status);
		assert.equal(save.mock.callCount(), 0);
	});
}

for (const unloading of [false, true]) {
	test("full answer skips a successful late reply after " + (unloading ? "unload" : "user cancellation"), async t => {
		const f = lifecycleFixture(t);
		const save = t.mock.method(f.host, "saveFullAnswer");
		f.host.stopDirectVaultQuery = () => true;
		const task = f.view.submitQuestion("inspect");
		await f.started;
		const shutdown = unloading ? f.host.queryTasks.shutdown() : null;
		if (!unloading) {
			await f.host.queryTasks.stop(f.session.id);
			assert.equal(f.session.messages[1].status, "stopping");
		}
		f.answer.resolve({ ...result, stdout: "x".repeat(9000) });
		await Promise.all([task, shutdown]);
		assert.equal(f.session.messages[1].status, unloading ? "interrupted" : "done");
		assert.equal(save.mock.callCount(), 0);
	});
}

test("full answer Direct API streaming fallback saves only the final non-streaming reply", async t => {
	const f = lifecycleFixture(t);
	const profile = { ...f.host.getProviderProfile(), capabilities: { streaming: true }, lastTest: { ok: true, streamingVerified: true } };
	f.host.getProviderProfile = () => profile;
	f.host.runDirectVaultQuery = Plugin.prototype.runDirectVaultQuery;
	f.host.runVaultRetrievalPreflight = async () => ({ candidate_paths: ["paper.md"] });
	f.host.readVaultEvidencePacket = async () => [];
	const answer = "最终回答".repeat(2300);
	const calls = [];
	f.host.createLLMProvider = () => ({
		async stream(_request, onDelta) {
			calls.push("stream");
			onDelta("discarded partial".repeat(800));
			throw new Error("stream disconnected");
		},
		async complete() {
			calls.push("complete");
			return { text: answer };
		},
	});
	const save = t.mock.method(f.host, "saveFullAnswer");
	await f.view.submitQuestion("inspect");
	assert.deepEqual(calls, ["stream", "complete"]);
	assert.equal(f.session.messages[1].content, answer);
	assert.equal(save.mock.callCount(), 1);
	assert.deepEqual(save.mock.calls[0].arguments, [f.session.id, f.session.messages[1].id, answer]);
});

test("full answer done update overwrites an existing longer contentLength", async t => {
	const f = lifecycleFixture(t);
	const task = f.view.submitQuestion("inspect");
	await f.started;
	const messageId = f.session.messages[1].id;
	await f.host.updateQueryMessage(f.session.id, messageId, { contentLength: 40000 });
	const answer = "x".repeat(9000);
	f.answer.resolve({ ...result, stdout: answer });
	await task;
	assert.equal(f.session.messages[1].id, messageId);
	assert.equal(f.session.messages[1].contentLength, answer.length);
	assert.equal(f.snapshots.at(-1).querySessions[0].messages[1].contentLength, answer.length);
});

test("full answer plugin host writes under its installation root and rejects a missing root", async () => {
	const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
	function installedPlugin(directory) {
		return Object.assign(new Plugin(), { readingPluginDirectory: () => directory });
	}
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "reader-full-answer-host-"));
	const args = ["query-session", "message-reply", "正文\n"];
	await installedPlugin(root).saveFullAnswer(...args);
	const file = path.join(root, "task-output", "query-answers", "query-session", "message-reply.md");
	assert.equal(await fs.readFile(file, "utf8"), args[2]);
	const missing = path.join(root, "missing");
	await assert.rejects(() => installedPlugin(missing).saveFullAnswer(...args), /插件.*目录/);
	await assert.rejects(() => fs.stat(missing), { code: "ENOENT" });
});

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

const modelLimitHint = "模型输出达到上限，回答可能不完整";
const limitedNotice = "知识库回答已完成，但模型输出达到上限，回答可能不完整";
const replyText = "回答正文";

function directLimitFixture(t, type, streaming, events, body) {
	const f = lifecycleFixture(t);
	const profile = { ...f.host.getProviderProfile(), type, secretId: "fixture",
		capabilities: { streaming }, lastTest: { ok: true, streamingVerified: streaming } };
	f.host.getProviderProfile = () => profile;
	f.host.app = { secretStorage: { getSecret: () => "fixture" } };
	f.host.runDirectVaultQuery = Plugin.prototype.runDirectVaultQuery;
	f.host.runVaultRetrievalPreflight = async () => ({ candidate_paths: ["paper.md"] });
	f.host.readVaultEvidencePacket = async () => [];
	f.host.resolveWebSearchBackend = () => ({ kind: "native", protocol: "qwen" });
	const calls = [];
	f.host.providerHttpStream = async ({ onEvent }) => {
		calls.push("stream");
		for (const event of events) {
			if (event instanceof Error) throw event;
			onEvent(JSON.stringify(event));
		}
	};
	f.host.providerHttpRequest = async () => {
		calls.push("complete");
		return { status: 200, json: body };
	};
	return { ...f, calls };
}

async function outputLimitHints(host, message) {
	const ui = screen({ makeView: () => new QueryWikiView({}, host) });
	await ui.view.renderMessage(ui.view.contentEl, message, host.getActiveQuerySession().id);
	return ui.labels.filter(label => label === modelLimitHint);
}

const chatLimit = { choices: [{ delta: {}, finish_reason: "length" }] };
const responseLimit = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: replyText };
const anthropicLimit = { content: [{ type: "text", text: replyText }], stop_reason: "max_tokens" };
const chatReply = finish_reason => ({ choices: [{ message: { content: replyText }, finish_reason }] });
const streamError = { type: "error", error: { message: "connection lost" } };
for (const [name, type, events, body, expectedCalls, limited] of [
	["Chat stream length", "openai-compatible", [{ choices: [{ delta: { content: replyText } }] }, chatLimit], null, ["stream"], true],
	["Chat ordinary length", "openai-compatible", null, chatReply("length"), ["complete"], true],
	["Responses stream limit", "openai", [{ type: "response.output_text.delta", delta: replyText },
		{ type: "response.incomplete", response: responseLimit }], null, ["stream"], true],
	["Responses ordinary limit", "openai", null, responseLimit, ["complete"], true],
	["Anthropic ordinary max_tokens", "anthropic", null, anthropicLimit, ["complete"], true],
	["Anthropic fallback max_tokens", "anthropic", [new Error("stream disconnected")], anthropicLimit, ["stream", "complete"], true],
	["normal completion", "openai-compatible", null, chatReply("stop"), ["complete"], false],
	["Responses incomplete content filter", "openai", null, { ...responseLimit, incomplete_details: { reason: "content_filter" } }, ["complete"], false],
	["failed stream then ordinary length", "openai-compatible", [streamError], chatReply("length"), ["stream", "complete"], true],
	["length in abandoned stream then ordinary stop", "openai-compatible", [{ choices: [{ delta: { content: "discarded" } }] },
		chatLimit, streamError], chatReply("stop"), ["stream", "complete"], false],
]) test("model output limit: " + name, async t => {
	const f = directLimitFixture(t, type, events !== null, events, body);
	const start = notices.length;
	await f.view.submitQuestion("inspect");
	const message = f.session.messages[1];
	assert.deepEqual(f.calls, expectedCalls);
	assert.equal(message.status, "done");
	assert.equal(message.content, replyText);
	assert.equal(message.contentLength, replyText.length);
	assert.equal(f.runs[0].exitCode, 0);
	assert.equal(message.outputLimitReached, limited ? true : undefined);
	assert.equal(Object.hasOwn(message, "outputLimitReached"), limited);
	assert.deepEqual(notices.slice(start), [limited ? limitedNotice : "知识库回答已完成"]);
	assert.deepEqual(await outputLimitHints(f.host, message), limited ? [modelLimitHint] : []);
	assert.equal(Object.hasOwn(f.snapshots.at(-1).querySessions[0].messages[1], "outputLimitReached"), limited);
});

for (const mode of ["vault", "web"]) {
	for (const reason of ["length", "stop"]) test("model output limit: " + mode + " event " + reason, async t => {
		const f = directLimitFixture(t, "openai-compatible", false, null, chatReply(reason));
		const events = [];
		const result = await f.host.runDirectVaultQuery("run", "vision", "inspect", [], mode, { onEvent: event => events.push(event) });
		for (const source of [events, result.events]) {
			const { payload } = source.find(event => event.type === "retrieval-result");
			assert.equal(payload.answer_markdown, replyText);
			assert.equal(Object.hasOwn(payload, "output_limit_reached"), reason === "length");
			if (reason === "length") assert.equal(payload.output_limit_reached, true);
		}
	});
}

test("model output limit: flag survives save, restart and save", async t => {
	const f = directLimitFixture(t, "openai", false, null, responseLimit);
	await f.view.submitQuestion("inspect");
	const reload = await reloadHistory(f.snapshots.at(-1));
	assert.equal(reload.messages[1].outputLimitReached, true);
	assert.deepEqual(await outputLimitHints(reload.host, reload.messages[1]), [modelLimitHint]);
	assert.equal(reload.saved[1].outputLimitReached, true);
});

test("model output limit: invalid stored flags disappear on load and save", async () => {
	const messages = [false, "true", 1].map(outputLimitReached => ({ ...actionReply, outputLimitReached }));
	const reload = await reloadHistory({ settings: {}, querySessions: [{ id: "session", messages }] });
	for (const [index, message] of reload.messages.entries()) {
		assert.equal(Object.hasOwn(message, "outputLimitReached"), false);
		assert.deepEqual(await outputLimitHints(reload.host, message), []);
		assert.equal(Object.hasOwn(reload.saved[index], "outputLimitReached"), false);
	}
});

test("model output limit: only literal true is serialized; normal done message bytes stay identical", async () => {
	const f = fixture();
	const base = { id: "a", role: "assistant", content: "ok", status: "done" };
	for (const flag of [undefined, false, "true", 1, true]) {
		f.session.messages = [{ ...base, ...(flag === undefined ? {} : { outputLimitReached: flag }) }];
		await f.host.saveSettings();
		const stored = f.snapshots.at(-1).querySessions[0].messages[0];
		if (flag === true) assert.equal(stored.outputLimitReached, true);
		else assert.equal(JSON.stringify(stored), '{"id":"a","role":"assistant","content":"ok","status":"done","error":""}');
	}
});

test("model output limit: only completed assistant messages show the hint", async () => {
	const f = fixture();
	for (const status of ["pending", "stopping", "failed", "interrupted", "done"]) {
		const role = status === "done" ? "user" : "assistant";
		assert.deepEqual(await outputLimitHints(f.host, { ...actionReply, role, status, outputLimitReached: true }), []);
	}
});

for (const flag of [undefined, "true", 1]) test("model output limit: CLI flag " + typeof flag + " is ignored", async t => {
	const f = lifecycleFixture(t, true);
	const task = f.view.submitQuestion("inspect");
	await f.started;
	const payload = { answer_markdown: replyText, ...(flag === undefined ? {} : { output_limit_reached: flag }) };
	f.answer.resolve({ ...result, events: [{ type: "retrieval-result", payload }] });
	await task;
	assert.equal(f.session.messages[1].status, "done");
	assert.equal(f.session.messages[1].outputLimitReached, undefined);
	assert.equal(Object.hasOwn(f.snapshots.at(-1).querySessions[0].messages[1], "outputLimitReached"), false);
});

test("model output limit: a stopped request ignores a late limit event", async t => {
	const f = lifecycleFixture(t);
	f.host.stopDirectVaultQuery = () => true;
	const task = f.view.submitQuestion("inspect");
	await f.started;
	await f.host.queryTasks.stop(f.session.id);
	f.answer.resolve({ ...result, exitCode: 130, events: [{ type: "retrieval-result", payload: { output_limit_reached: true } }] });
	await task;
	assert.equal(f.session.messages[1].status, "interrupted");
	assert.equal(f.session.messages[1].outputLimitReached, undefined);
	assert.deepEqual(await outputLimitHints(f.host, f.session.messages[1]), []);
});

test("model output limit: next done result clears the old flag and replaces contentLength", async t => {
	const f = lifecycleFixture(t);
	const task = f.view.submitQuestion("inspect");
	await f.started;
	const message = f.session.messages[1];
	await f.host.updateQueryMessage(f.session.id, message.id, { contentLength: 40000, outputLimitReached: true });
	f.answer.resolve(result);
	await task;
	const latest = f.session.messages[1];
	assert.equal(latest.id, message.id);
	assert.equal(latest.contentLength, result.stdout.length);
	assert.equal(latest.outputLimitReached, undefined);
	assert.equal(Object.hasOwn(latest, "outputLimitReached"), false);
	assert.equal(Object.hasOwn(f.snapshots.at(-1).querySessions[0].messages[1], "outputLimitReached"), false);
});
