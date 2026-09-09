"use strict";

// In-memory persistence only: no model calls, files, retention cleanup or deletion.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
class Base {}
const obsidian = { Plugin: Base, PluginSettingTab: Base, Component: Base, ItemView: Base, Modal: Base, TFile: Base, FileSystemAdapter: Base, Notice: Base, normalizePath: p => p.replace(/\\/g, "/") };
const Plugin = loadReading("plugin.ts", { obsidian, electron: {} }).default;
const { DashboardView } = loadReading("views/dashboard.ts", { obsidian });
const { ingestTaskResult } = loadReading("agent/ingest-task-result.ts");
const action = { id: "paper-ingest", label: "文献入库", agent: "paper-intake-pipeline" };
const outcome = overrides => ({ exitCode: 1, stdout: "structured output", stderr: "", loopStatus: "failed", artifacts: { articlePath: "", wikiPath: "", filesWritten: [] }, result: { status: "failed", errors: ["identity receipt conflict"], conflicts: [] }, ...overrides });
const makePlugin = () => {
	const plugin = new Plugin();
	plugin.settings = { taskHistoryLimit: 100 };
	plugin.saveSettings = async () => {};
	plugin.persistTaskRunOutput = async () => "";
	plugin.deleteTaskRunOutput = async () => { throw new Error("Test must not reclaim any files"); };
	return plugin;
};

(async () => {
	assert.equal(ingestTaskResult(outcome()).error, "identity receipt conflict");
	assert.equal(ingestTaskResult(outcome({ result: { errors: [], conflicts: ["duplicate conflict"] } })).error, "duplicate conflict");
	assert.equal(ingestTaskResult(outcome({ result: null, stderr: "network error" })).error, "network error");
	assert.match(ingestTaskResult(outcome({ result: null })).error, /未返回结构化/);
	assert.equal(ingestTaskResult(outcome({ exitCode: 130, loopStatus: "cancelled" })).status, "interrupted");
	assert.equal(ingestTaskResult(outcome({ exitCode: 0 })).error, "");

	const plugin = makePlugin(), states = [];
	const dispose = plugin.subscribeTaskRuns(() => states.push(plugin.getTaskRuns().map(r => r.status)));
	const starts = await Promise.allSettled([plugin.startTaskRun(action, "first"), plugin.startTaskRun(action, "second")]);
	assert.equal(starts[0].status, "fulfilled"); assert.equal(starts[1].status, "rejected");
	assert.match(starts[1].reason.message, /正在运行/); assert.equal(plugin.taskRuns.length, 1);
	assert.deepEqual(states, [["running"]]);
	const run = starts[0].value;
	await plugin.finishTaskRun(run.id, ingestTaskResult(outcome()));
	assert.equal(plugin.isActionRunning(action.id), false); assert.equal(plugin.getRunningTaskRun(action.id), null);
	assert.deepEqual(states.at(-1), ["failed"]);
	const retry = await plugin.startTaskRun(action, "retry");
	await plugin.finishTaskRun(retry.id, ingestTaskResult(outcome({ exitCode: 130, loopStatus: "cancelled" })));
	assert.equal(plugin.getTaskRun(retry.id).status, "interrupted"); assert.equal(plugin.isActionRunning(action.id), false);
	const latest = await plugin.startTaskRun(action, "another retry");
	await plugin.finishTaskRun(run.id, { status: "done" });
	assert.equal(plugin.getRunningTaskRun(action.id).id, latest.id, "old completion cannot unlock new task");
	await plugin.finishTaskRun(latest.id, ingestTaskResult(outcome({ exitCode: 0 })));
	const notifications = states.length; dispose();
	await plugin.startTaskRun(action, "unsubscribed"); assert.equal(states.length, notifications);

	const failing = makePlugin(); let called = 0;
	failing.subscribeTaskRuns(() => called++);
	failing.saveSettings = async () => { throw new Error("disk full"); };
	await assert.rejects(failing.startTaskRun(action, "cannot save"), /disk full/);
	assert.equal(failing.isActionRunning(action.id), false); assert.equal(called, 0);
	failing.saveSettings = async () => {};
	const finishing = await failing.startTaskRun(action, "finish despite disk error");
	failing.saveSettings = async () => { throw new Error("disk full"); };
	failing.persistTaskRunOutput = async () => { throw new Error("journal full"); };
	const warnings = [], warn = console.warn; console.warn = (...args) => warnings.push(args);
	try { await failing.finishTaskRun(finishing.id, ingestTaskResult(outcome())); } finally { console.warn = warn; }
	assert.equal(warnings.length, 2); assert.equal(failing.isActionRunning(action.id), false); assert.equal(called, 2);
	assert.equal(failing.getTaskRun(finishing.id).error, "identity receipt conflict");

	// The real view subscribes before initial load and unsubscribes on close.
	const view = new DashboardView({}, plugin); let renders = 0;
	view.renderLoading = () => {}; view.registerVaultRefreshEvents = () => {}; view.loadAndRender = async () => { renders++; };
	view.contentEl = { empty() {} }; plugin.getReadingWorkspace = undefined;
	await view.onOpen(); assert.equal(renders, 1);
	const active = plugin.getRunningTaskRun(action.id);
	await plugin.finishTaskRun(active.id, ingestTaskResult(outcome())); assert.equal(renders, 2);
	await view.onClose(); await plugin.startTaskRun(action, "closed view"); assert.equal(renders, 2);
	await view.onOpen(); assert.equal(renders, 3);
	await plugin.finishTaskRun(plugin.getRunningTaskRun(action.id).id, ingestTaskResult(outcome())); assert.equal(renders, 4);
	await view.onClose();
	console.log("INGEST_TASK_LIFECYCLE_OK: status notifications, concurrent start, retry, cancellation, persistence failure, subscription cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
