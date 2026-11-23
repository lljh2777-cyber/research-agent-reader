"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadReading } = require("./reading-test-helpers");

const notices = [];
const { QueryWikiView } = loadReading("views/query-wiki.ts", { obsidian: {
	ItemView: class {}, Modal: class {}, setIcon() {},
	Notice: class { constructor(message) { notices.push(message); } },
} });

const noImages = { attachments: [], notePaths: [], discoveredCount: 0, totalBytes: 0 };
const result = { exitCode: 0, stdout: "answer", stderr: "", events: [] };

function fixture() {
	const profile = { id: "vision", type: "openai-compatible", name: "Vision", model: "test", capabilities: { vision: true } };
	const session = { id: "session", queryBackendId: profile.id, retrievalMode: "vault", messages: [] };
	const runs = [];
	let messageId = 0;
	const host = {
		querySubmissionActive: false,
		getActiveQuerySession: () => session,
		resolveQueryBackendId: id => id,
		getProviderProfile: () => profile,
		isActionRunning: () => false,
		resolveQuestionImageAttachments: async () => noImages,
		resolveDirectQueryExecutionConfig: () => ({ model: profile.model }),
		buildQueryActionInput: question => question,
		createQueryMessageId: () => String(++messageId),
		appendQueryMessages: async (_id, messages) => { session.messages.push(...messages); },
		updateQueryMessage: async (_id, id, update) => Object.assign(session.messages.find(m => m.id === id), update),
		startTaskRun: async () => {
			const run = { id: String(runs.length + 1) };
			runs.push(run);
			return run;
		},
		runDirectVaultQuery: async () => result,
		finishTaskRun: async (id, outcome) => Object.assign(runs.find(run => run.id === id), outcome),
	};
	const makeView = () => {
		const view = new QueryWikiView({}, host);
		view.render = async () => {};
		return view;
	};
	return { host, session, runs, view: makeView(), makeView };
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

test("clicking Send while attachment resolution is pending starts one task", async t => {
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
	send.dispatchEvent(new Event("click"));
	await Promise.resolve();
	send.dispatchEvent(new Event("click"));
	release();
	await Promise.all(submit.mock.calls.map(call => call.result));
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
