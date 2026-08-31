"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const projectRoot = path.resolve(__dirname, "..");

class ObsidianBase {}
class ObsidianTFile extends ObsidianBase {}
class ObsidianFileSystemAdapter extends ObsidianBase {}

const obsidianStub = {
	Component: ObsidianBase,
	FileSystemAdapter: ObsidianFileSystemAdapter,
	ItemView: ObsidianBase,
	MarkdownRenderer: { render: async () => {} },
	Modal: ObsidianBase,
	Notice: class {},
	Plugin: ObsidianBase,
	PluginSettingTab: ObsidianBase,
	Setting: class {},
	TFile: ObsidianTFile,
	normalizePath: (value) => String(value).replace(/([^:])\\+/g, "$1/").replace(/\/+/g, "/"),
	setIcon: () => {},
};

const buildResult = esbuild.buildSync({
	entryPoints: [path.join(projectRoot, "src", "main.ts")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	external: ["obsidian", "electron"],
	logLevel: "silent",
});
const pluginStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-plugin-storage-"));

function loadPluginAt(storageRoot) {
	const builtFile = path.join(storageRoot, "main.cjs");
	const originalLoad = Module._load;
	Module._load = function loadWithRuntimeStubs(request, parent, isMain) {
		if (request === "obsidian") return obsidianStub;
		if (request === "electron") return { shell: { openPath: async () => "" } };
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		const builtModule = new Module(builtFile, module);
		builtModule.filename = builtFile;
		builtModule.paths = Module._nodeModulePaths(projectRoot);
		builtModule._compile(buildResult.outputFiles[0].text, builtFile);
		return builtModule.exports.default || builtModule.exports;
	} finally {
		Module._load = originalLoad;
	}
}

const AgentDashboardPlugin = loadPluginAt(pluginStorageRoot);
const pluginOutputPath = (runId) => path.join(
	pluginStorageRoot,
	"task-output",
	"dashboard-runs",
	`${runId}.json`,
);
const outputPathAt = (storageRoot, runId) => path.join(
	storageRoot,
	"task-output",
	"dashboard-runs",
	`${runId}.json`,
);

function makeRun(id) {
	return {
		id,
		actionId: "paper-ingest",
		label: "文献入库",
		agent: "paper-ingest",
		summary: "测试任务",
		executionConfig: null,
		status: "running",
		startedAt: "2026-08-31T00:00:00.000Z",
		finishedAt: "",
		exitCode: null,
		output: "",
		error: "",
	};
}

function makeTerminalRun(id, output = "completed output") {
	return {
		...makeRun(id),
		status: "done",
		finishedAt: "2026-08-31T00:01:00.000Z",
		exitCode: 0,
		output,
	};
}

function makeStoredState(toolkitRoot, taskRuns, settings = {}) {
	return {
		settings: {
			toolkitRoot,
			taskHistoryLimit: 30,
			querySessionLimit: 8,
			queryMessageLimit: 30,
			providerProfiles: [],
			activeProviderId: "",
			...settings,
		},
		taskRuns,
		querySessions: [],
		activeQuerySessionId: "",
		latestLintReport: null,
	};
}

function makePlugin(toolkitRoot, run, PluginClass = AgentDashboardPlugin) {
	const plugin = new PluginClass();
	const snapshots = [];
	plugin.settings = {
		toolkitRoot,
		taskHistoryLimit: 30,
		querySessionLimit: 8,
		queryMessageLimit: 30,
		providerProfiles: [],
		activeProviderId: "",
	};
	plugin.taskRuns = [run];
	plugin.querySessions = [];
	plugin.activeQuerySessionId = "";
	plugin.latestLintReport = null;
	plugin.saveData = async (snapshot) => {
		snapshots.push(snapshot);
	};
	return { plugin, snapshots };
}

async function finishSuccessfully(plugin, run, output) {
	return plugin.finishTaskRun(run.id, {
		status: "done",
		exitCode: 0,
		output,
		artifacts: {
			articlePath: "papers/example/article.md",
			wikiPath: "wiki/sources/example.md",
			filesWritten: ["papers/example/article.md", "wiki/sources/example.md"],
		},
	});
}

async function persistTerminalRuns(plugin, runs) {
	for (const run of runs) {
		run.outputPath = await plugin.persistTaskRunOutput(run);
	}
}

async function testNoToolkitDoesNotWriteToCwd() {
	const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "reader-no-toolkit-"));
	const previousCwd = process.cwd();
	process.chdir(isolatedCwd);
	try {
		const longOutput = "A".repeat(24000);
		const run = makeRun("run-no-toolkit");
		const { plugin, snapshots } = makePlugin("", run);
		const completed = await finishSuccessfully(plugin, run, longOutput);
		assert.equal(completed.status, "done");
		assert.equal(completed.exitCode, 0);
		assert.equal(
			completed.outputPath,
			"task-output/dashboard-runs/run-no-toolkit.json",
		);
		assert.equal(completed.output, longOutput);
		assert.equal(fs.existsSync(path.join(isolatedCwd, "tool-library")), false);
		assert.equal(fs.existsSync(path.join(isolatedCwd, "task-output")), false);
		assert.equal(JSON.parse(fs.readFileSync(pluginOutputPath(run.id), "utf8")).output, longOutput);
		assert.equal(plugin.getTaskRunOutput(completed), longOutput);
		assert.equal(snapshots.length, 1);
		assert.equal(snapshots[0].taskRuns[0].status, "done");
		assert.equal(snapshots[0].taskRuns[0].output.length, 12000);
		assert.deepEqual(snapshots[0].taskRuns[0].artifacts, completed.artifacts);
	} finally {
		process.chdir(previousCwd);
	}
}

async function testInvalidToolkitDoesNotCreateConfiguredPath() {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reader-invalid-toolkit-"));
	const missingRoot = path.join(sandbox, "missing-toolkit");
	const output = "B".repeat(16000);
	const run = makeRun("run-invalid-toolkit");
	const { plugin, snapshots } = makePlugin(missingRoot, run);
	const completed = await finishSuccessfully(plugin, run, output);
	assert.equal(completed.status, "done");
	assert.equal(
		completed.outputPath,
		"task-output/dashboard-runs/run-invalid-toolkit.json",
	);
	assert.equal(fs.existsSync(missingRoot), false);
	assert.equal(JSON.parse(fs.readFileSync(pluginOutputPath(run.id), "utf8")).output, output);
	assert.equal(snapshots[0].taskRuns[0].output.length, 12000);
	assert.ok(snapshots[0].taskRuns[0].artifacts);
}

async function testNoToolkitReloadRestoresFullOutput() {
	const longOutput = "重启后仍需保留的完整输出".repeat(1800);
	const run = makeRun("run-no-toolkit-reload");
	const { plugin, snapshots } = makePlugin("", run);
	const completed = await finishSuccessfully(plugin, run, longOutput);
	assert.equal(completed.outputPath, "task-output/dashboard-runs/run-no-toolkit-reload.json");
	assert.equal(snapshots.length, 1);

	const reloaded = new AgentDashboardPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => snapshots[0];
	reloaded.saveData = async () => {};
	await reloaded.loadSettings();
	assert.equal(reloaded.taskRuns.length, 1);
	assert.equal(reloaded.taskRuns[0].output.length, 12000);
	assert.equal(reloaded.taskRuns[0].outputPath, completed.outputPath);
	assert.equal(reloaded.getTaskRunOutput(reloaded.taskRuns[0]), longOutput);
}

async function testConfiguredToolkitStillUsesPluginStorage() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-valid-toolkit-"));
	const longOutput = "完整输出".repeat(7000);
	const run = makeRun("run-valid-toolkit");
	const { plugin, snapshots } = makePlugin(toolkitRoot, run);
	const completed = await finishSuccessfully(plugin, run, longOutput);
	assert.equal(completed.status, "done");
	assert.equal(
		completed.outputPath,
		"task-output/dashboard-runs/run-valid-toolkit.json",
	);
	const absoluteOutputPath = pluginOutputPath(run.id);
	const persisted = JSON.parse(fs.readFileSync(absoluteOutputPath, "utf8"));
	assert.equal(persisted.output, longOutput);
	assert.equal(fs.existsSync(path.join(toolkitRoot, "tool-library")), false);
	assert.equal(plugin.getTaskRunOutput(completed), longOutput);
	assert.equal(snapshots[0].taskRuns[0].output.length, 12000);
	assert.deepEqual(snapshots[0].taskRuns[0].artifacts, completed.artifacts);
}

async function testSameRunAtomicallyReplacesExternalOutput() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-replace-output-"));
	const run = makeRun("run-replace-output");
	const { plugin } = makePlugin(toolkitRoot, run);
	const first = await finishSuccessfully(plugin, run, "first output");
	const repeated = await finishSuccessfully(plugin, run, "second output");
	assert.equal(repeated.output, "first output", "a terminal TaskRun must be idempotent");
	const completed = {
		...first,
		finishedAt: "2026-08-31T00:02:00.000Z",
		output: "second output",
	};
	completed.outputPath = await plugin.persistTaskRunOutput(completed);
	assert.equal(
		completed.outputPath,
		"task-output/dashboard-runs/run-replace-output.json",
	);
	assert.equal(plugin.getTaskRunOutput(completed), "second output");
	const outputDirectory = path.dirname(pluginOutputPath(run.id));
	assert.deepEqual(
		fs.readdirSync(outputDirectory).filter((name) => name.includes("run-replace-output")),
		["run-replace-output.json"],
	);
}

async function testExternalWriteFailureKeepsTrueOutcome() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-failed-output-"));
	const output = "C".repeat(18000);
	const run = makeRun("run-write-failure");
	run.outputPath = "tool-library/output/dashboard-runs/run-write-failure.json";
	const { plugin, snapshots } = makePlugin(toolkitRoot, run);
	plugin.persistTaskRunOutput = async () => {
		throw new Error("simulated side-write failure");
	};
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args);
	try {
		const completed = await finishSuccessfully(plugin, run, output);
		assert.equal(completed.status, "done");
		assert.equal(completed.exitCode, 0);
		assert.equal(completed.outputPath, undefined);
		assert.equal(plugin.getTaskRunOutput(completed), output);
		assert.equal(snapshots[0].taskRuns[0].status, "done");
		assert.equal(snapshots[0].taskRuns[0].output.length, 12000);
		assert.ok(snapshots[0].taskRuns[0].artifacts);
		assert.equal(warnings.length, 1);
	} finally {
		console.warn = originalWarn;
	}
}

async function testSettingsSaveFailureKeepsTrueOutcome() {
	const run = makeRun("run-save-failure");
	const { plugin, snapshots } = makePlugin("", run);
	await plugin.saveSettings();
	const runningSnapshot = snapshots[0];
	plugin.saveData = async () => {
		throw new Error("simulated data.json failure");
	};
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args);
	try {
		const completed = await finishSuccessfully(plugin, run, "completed despite history failure");
		assert.equal(completed.status, "done");
		assert.equal(completed.exitCode, 0);
		assert.match(completed.output, /completed despite history failure/);
		assert.ok(completed.artifacts);
		assert.equal(warnings.length, 1);
		assert.match(String(warnings[0][0]), /task history/);

		const reloaded = new AgentDashboardPlugin();
		reloaded.app = { vault: { adapter: {} } };
		reloaded.loadData = async () => runningSnapshot;
		reloaded.saveData = async () => {};
		await reloaded.loadSettings();
		const recovered = reloaded.taskRuns[0];
		assert.equal(recovered.status, "done", "terminal sidecar must win over stale running data.json");
		assert.equal(recovered.exitCode, 0);
		assert.equal(recovered.outputPath, "task-output/dashboard-runs/run-save-failure.json");
		assert.match(reloaded.getTaskRunOutput(recovered), /completed despite history failure/);
		assert.deepEqual(recovered.artifacts, completed.artifacts);
	} finally {
		console.warn = originalWarn;
	}
}

async function testEmptyOutputFailureRecoversAfterSettingsSaveFailure() {
	const run = makeRun("run-empty-output-failure");
	const { plugin, snapshots } = makePlugin("", run);
	await plugin.saveSettings();
	const runningSnapshot = snapshots[0];
	plugin.saveData = async () => {
		throw new Error("simulated data.json failure");
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		const completed = await plugin.finishTaskRun(run.id, {
			status: "failed",
			exitCode: 1,
			output: "",
			error: "provider failed before producing output",
		});
		assert.equal(completed.outputPath, "task-output/dashboard-runs/run-empty-output-failure.json");

		const reloaded = new AgentDashboardPlugin();
		reloaded.app = { vault: { adapter: {} } };
		reloaded.loadData = async () => runningSnapshot;
		reloaded.saveData = async () => {};
		await reloaded.loadSettings();
		const recovered = reloaded.taskRuns[0];
		assert.equal(recovered.status, "failed");
		assert.equal(recovered.exitCode, 1);
		assert.equal(recovered.output, "");
		assert.match(recovered.error, /provider failed/);
		assert.equal(recovered.outputPath, completed.outputPath);
	} finally {
		console.warn = originalWarn;
	}
}

async function testVaultLintCompletionAlsoRecovers() {
	const run = { ...makeRun("run-vault-lint-recovery"), actionId: "vault-lint" };
	const { plugin, snapshots } = makePlugin("", run);
	await plugin.saveSettings();
	const runningSnapshot = snapshots[0];
	plugin.saveData = async () => {
		throw new Error("simulated data.json failure");
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		const completed = await plugin.finishTaskRun(run.id, {
			status: "done",
			exitCode: 0,
			output: "Vault lint: score 100",
			error: "",
		});
		assert.equal(completed.outputPath, "task-output/dashboard-runs/run-vault-lint-recovery.json");

		const reloaded = new AgentDashboardPlugin();
		reloaded.app = { vault: { adapter: {} } };
		reloaded.loadData = async () => runningSnapshot;
		reloaded.saveData = async () => {};
		await reloaded.loadSettings();
		const recovered = reloaded.taskRuns[0];
		assert.equal(recovered.status, "done");
		assert.equal(reloaded.getTaskRunOutput(recovered), "Vault lint: score 100");
	} finally {
		console.warn = originalWarn;
	}
}

async function testTerminalDataOutcomeCannotBeReversedByStaleSidecar() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-terminal-authority-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const committed = {
		...makeTerminalRun("run-terminal-authority", "committed inline output"),
		artifacts: { articlePath: "papers/committed/article.md", filesWritten: [] },
		outputPath: "task-output/dashboard-runs/run-terminal-authority.json",
	};
	const stale = {
		...committed,
		status: "failed",
		exitCode: 1,
		output: "stale sidecar output",
		error: "stale failure",
		artifacts: { articlePath: "papers/stale/article.md", filesWritten: [] },
	};
	const writer = makePlugin("", stale, IsolatedPlugin).plugin;
	await writer.persistTaskRunOutput(stale);

	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => makeStoredState("", [committed]);
	reloaded.saveData = async () => {};
	await reloaded.loadSettings();
	const recovered = reloaded.taskRuns[0];
	assert.equal(recovered.status, "done");
	assert.equal(recovered.exitCode, 0);
	assert.equal(recovered.output, "committed inline output");
	assert.equal(recovered.error, "");
	assert.equal(recovered.artifacts.articlePath, "papers/committed/article.md");
	assert.equal(reloaded.getTaskRunOutput(recovered), "committed inline output");
}

async function testJunctionOutputDirectoryIsRejected() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-junction-plugin-"));
	const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-junction-outside-"));
	fs.symlinkSync(
		outsideRoot,
		path.join(isolatedPluginRoot, "task-output"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const run = makeRun("run-junction");
	const { plugin } = makePlugin("", run, IsolatedPlugin);
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args);
	try {
		const completed = await finishSuccessfully(plugin, run, "must stay inline");
		assert.equal(completed.status, "done");
		assert.equal(completed.outputPath, undefined);
		assert.equal(fs.existsSync(path.join(outsideRoot, "dashboard-runs")), false);
		assert.equal(warnings.length, 1);
	} finally {
		console.warn = originalWarn;
	}
}

async function testSymlinkOutputFileIsRejected() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-symlink-plugin-"));
	const outputDirectory = path.join(isolatedPluginRoot, "task-output", "dashboard-runs");
	fs.mkdirSync(outputDirectory, { recursive: true });
	const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-symlink-outside-"));
	const outsideFile = path.join(outsideRoot, "outside.json");
	fs.writeFileSync(outsideFile, "outside remains unchanged", "utf8");
	try {
		fs.symlinkSync(outsideFile, path.join(outputDirectory, "run-symlink.json"), "file");
	} catch (error) {
		// Windows without Developer Mode commonly permits junctions but not file
		// symlinks. The junction case above still exercises the Windows boundary;
		// Unix and enabled Windows hosts exercise this target-file check.
		if (error?.code === "EPERM") return;
		throw error;
	}
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const run = makeRun("run-symlink");
	const { plugin } = makePlugin("", run, IsolatedPlugin);
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args);
	try {
		const completed = await finishSuccessfully(plugin, run, "must not follow link");
		assert.equal(completed.status, "done");
		assert.equal(completed.outputPath, undefined);
		assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside remains unchanged");
		assert.equal(warnings.length, 1);
	} finally {
		console.warn = originalWarn;
	}
}

async function testPersistedPayloadMustMatchRunIdentity() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-payload-identity-"));
	const run = makeRun("run-payload-identity");
	const { plugin } = makePlugin(toolkitRoot, run);
	const completed = await finishSuccessfully(plugin, run, "trusted full output");
	const absoluteOutputPath = pluginOutputPath(run.id);
	const originalPayload = JSON.parse(fs.readFileSync(absoluteOutputPath, "utf8"));
	const tamperedFields = [
		["run_id", "another-run"],
		["action_id", "pdf-xray"],
		["started_at", "2026-08-31T00:00:01.000Z"],
		["finished_at", "2026-08-31T00:09:00.000Z"],
		["status", "failed"],
		["exit_code", 99],
		["schema_version", 99],
	];
	for (const [field, value] of tamperedFields) {
		fs.writeFileSync(
			absoluteOutputPath,
			JSON.stringify({ ...originalPayload, [field]: value }),
			"utf8",
		);
		assert.equal(
			plugin.getTaskRunOutput({ ...completed, output: "inline fallback" }),
			"inline fallback",
			`schema-v2 ${field} must remain bound to the persisted TaskRun`,
		);
	}
	fs.writeFileSync(absoluteOutputPath, JSON.stringify(originalPayload), "utf8");
}

async function testTamperedRunIdCannotEscapeRoot() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-contained-output-"));
	const run = makeRun("../../outside");
	const { plugin } = makePlugin(toolkitRoot, run);
	const completed = await finishSuccessfully(plugin, run, "unsafe");
	assert.equal(completed.status, "done");
	assert.equal(completed.outputPath, undefined);
	assert.equal(fs.existsSync(path.join(toolkitRoot, "tool-library")), false);
	assert.equal(plugin.getTaskRunOutput({
		...completed,
		output: "inline fallback",
		outputPath: "../../outside.json",
	}), "inline fallback");
	const whitespaceRun = makeRun(" run-with-whitespace ");
	const whitespacePlugin = makePlugin(toolkitRoot, whitespaceRun).plugin;
	const whitespaceCompleted = await finishSuccessfully(whitespacePlugin, whitespaceRun, "unsafe");
	assert.equal(whitespaceCompleted.outputPath, undefined);
}

async function testLegacyLongOutputMigratesAfterNormalization() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-legacy-output-"));
	const legacyOutput = "旧版完整输出".repeat(3000);
	const legacyRun = {
		...makeRun("run-legacy-output"),
		status: "done",
		finishedAt: "2026-08-31T00:01:00.000Z",
		exitCode: 0,
		output: legacyOutput,
	};
	const plugin = new AgentDashboardPlugin();
	const snapshots = [];
	plugin.loadData = async () => ({
		settings: {
			toolkitRoot,
			taskHistoryLimit: 30,
			querySessionLimit: 8,
			queryMessageLimit: 30,
			providerProfiles: [],
			activeProviderId: "",
		},
		taskRuns: [legacyRun],
		querySessions: [],
		activeQuerySessionId: "",
		latestLintReport: null,
	});
	plugin.saveData = async (snapshot) => snapshots.push(snapshot);
	await plugin.loadSettings();
	assert.equal(plugin.taskRuns.length, 1);
	assert.equal(plugin.taskRuns[0].output.length, 12000);
	assert.equal(
		plugin.taskRuns[0].outputPath,
		"task-output/dashboard-runs/run-legacy-output.json",
	);
	assert.equal(plugin.getTaskRunOutput(plugin.taskRuns[0]), legacyOutput);
	assert.equal(fs.existsSync(path.join(toolkitRoot, "tool-library")), false);
	assert.ok(snapshots.length >= 1);
}

async function testLegacyRunningLongOutputSurvivesInterruptedMigrationAndReload() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-legacy-running-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const legacyOutput = "旧版运行中完整输出".repeat(2400);
	const legacyRun = { ...makeRun("run-legacy-running"), output: legacyOutput };
	const snapshots = [];
	const plugin = new IsolatedPlugin();
	plugin.app = { vault: { adapter: {} } };
	plugin.loadData = async () => makeStoredState("", [legacyRun]);
	plugin.saveData = async (snapshot) => snapshots.push(JSON.parse(JSON.stringify(snapshot)));
	await plugin.loadSettings();
	assert.equal(plugin.taskRuns[0].status, "interrupted");
	assert.equal(
		plugin.taskRuns[0].outputPath,
		"task-output/dashboard-runs/run-legacy-running.json",
	);
	assert.equal(plugin.getTaskRunOutput(plugin.taskRuns[0]), legacyOutput);

	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => snapshots.at(-1);
	let reloadSaves = 0;
	reloaded.saveData = async () => { reloadSaves += 1; };
	await reloaded.loadSettings();
	assert.equal(reloaded.taskRuns[0].status, "interrupted");
	assert.equal(reloaded.getTaskRunOutput(reloaded.taskRuns[0]), legacyOutput);
	assert.equal(reloadSaves, 0, "a fully reconciled schema-v2 snapshot should load without rewriting data.json");
}

async function testLegacyVaultLintLongOutputMigratesAfterStatusNormalization() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-legacy-lint-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const legacyOutput = `Vault lint: score 91\n${"旧版体检完整输出".repeat(2400)}`;
	const legacyRun = {
		...makeTerminalRun("run-legacy-lint", legacyOutput),
		actionId: "vault-lint",
		status: "failed",
		exitCode: 1,
		error: "legacy exit code",
	};
	const snapshots = [];
	const plugin = new IsolatedPlugin();
	plugin.app = { vault: { adapter: {} } };
	plugin.loadData = async () => makeStoredState("", [legacyRun]);
	plugin.saveData = async (snapshot) => snapshots.push(JSON.parse(JSON.stringify(snapshot)));
	await plugin.loadSettings();
	assert.equal(plugin.taskRuns[0].status, "done");
	assert.equal(plugin.taskRuns[0].error, "");
	assert.equal(plugin.getTaskRunOutput(plugin.taskRuns[0]), legacyOutput);

	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => snapshots.at(-1);
	reloaded.saveData = async () => {};
	await reloaded.loadSettings();
	assert.equal(reloaded.taskRuns[0].status, "done");
	assert.equal(reloaded.getTaskRunOutput(reloaded.taskRuns[0]), legacyOutput);
}

async function testLegacyLongOutputMigrationFailureNeverOverwritesRawData() {
	const legacyOutput = "迁移失败时必须保留的旧版完整输出".repeat(2200);
	const storedState = makeStoredState("", [{
		...makeRun("run-legacy-migration-failure"),
		output: legacyOutput,
	}]);
	const plugin = new AgentDashboardPlugin();
	plugin.app = { vault: { adapter: {} } };
	plugin.loadData = async () => storedState;
	plugin.persistTaskRunOutput = async () => {
		throw new Error("simulated protected sidecar write failure");
	};
	let saveCount = 0;
	plugin.saveData = async () => { saveCount += 1; };
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await assert.rejects(
			plugin.loadSettings(),
			/为避免截断原 data\.json，本次加载已停止/,
		);
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(saveCount, 0, "failed full-output migration must block every data.json rewrite");
	assert.equal(storedState.taskRuns[0].output, legacyOutput);
}

async function testLegacyToolkitOutputRemainsReadable() {
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-legacy-toolkit-read-"));
	const legacyDirectory = path.join(toolkitRoot, "tool-library", "output", "dashboard-runs");
	fs.mkdirSync(legacyDirectory, { recursive: true });
	const run = {
		...makeRun("run-legacy-toolkit-read"),
		status: "done",
		output: "inline fallback",
		outputPath: "tool-library/output/dashboard-runs/run-legacy-toolkit-read.json",
	};
	fs.writeFileSync(
		path.join(legacyDirectory, "run-legacy-toolkit-read.json"),
		JSON.stringify({
			schema_version: 1,
			run_id: run.id,
			output: "legacy complete output",
		}),
		"utf8",
	);
	const { plugin } = makePlugin(toolkitRoot, run);
	assert.equal(plugin.getTaskRunOutput(run), "legacy complete output");
}

async function testCleanupPendingReloadDeletesCanonicalSidecarAndRecord() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-resume-cleanup-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const run = makeTerminalRun("run-resume-cleanup", "sensitive output");
	const writer = makePlugin("", run, IsolatedPlugin).plugin;
	run.outputPath = await writer.persistTaskRunOutput(run);
	const absoluteOutputPath = outputPathAt(isolatedPluginRoot, run.id);
	assert.equal(fs.existsSync(absoluteOutputPath), true);

	const snapshots = [];
	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => makeStoredState("", [{ ...run, cleanupPending: true }]);
	reloaded.saveData = async (snapshot) => snapshots.push(JSON.parse(JSON.stringify(snapshot)));
	await reloaded.loadSettings();
	assert.equal(fs.existsSync(absoluteOutputPath), false);
	assert.deepEqual(reloaded.taskRuns, []);
	assert.deepEqual(snapshots.at(-1).taskRuns, []);
}

async function testCleanupPendingReloadRemovesRecordWhenSidecarAlreadyMissing() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-resume-missing-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const run = {
		...makeTerminalRun("run-resume-missing"),
		outputPath: "task-output/dashboard-runs/run-resume-missing.json",
		cleanupPending: true,
	};
	const snapshots = [];
	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => makeStoredState("", [run]);
	reloaded.saveData = async (snapshot) => snapshots.push(JSON.parse(JSON.stringify(snapshot)));
	await reloaded.loadSettings();
	assert.deepEqual(reloaded.taskRuns, []);
	assert.deepEqual(snapshots.at(-1).taskRuns, []);
}

async function testCleanupPendingReloadDeletesExactLegacyToolkitSidecar() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-resume-legacy-plugin-"));
	const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-resume-legacy-toolkit-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const run = {
		...makeTerminalRun("run-resume-legacy"),
		outputPath: "tool-library/output/dashboard-runs/run-resume-legacy.json",
		cleanupPending: true,
	};
	const legacyOutputPath = path.join(
		toolkitRoot,
		"tool-library",
		"output",
		"dashboard-runs",
		`${run.id}.json`,
	);
	fs.mkdirSync(path.dirname(legacyOutputPath), { recursive: true });
	fs.writeFileSync(legacyOutputPath, JSON.stringify({
		schema_version: 1,
		run_id: run.id,
		output: "legacy sensitive output",
	}), "utf8");

	const reloaded = new IsolatedPlugin();
	reloaded.loadData = async () => makeStoredState(toolkitRoot, [run]);
	reloaded.saveData = async () => {};
	await reloaded.loadSettings();
	assert.equal(fs.existsSync(legacyOutputPath), false);
	assert.deepEqual(reloaded.taskRuns, []);
}

async function testStartupKeepsUnreferencedCanonicalRecoveryAndOnlyRemovesStaleTemps() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-storage-sweep-"));
	const outputDirectory = path.join(isolatedPluginRoot, "task-output", "dashboard-runs");
	fs.mkdirSync(outputDirectory, { recursive: true });
	const unknownCanonical = path.join(outputDirectory, "unknown-recovery.json");
	fs.writeFileSync(unknownCanonical, JSON.stringify({
		schema_version: 1,
		run_id: "unknown-recovery",
		output: "only recovery copy",
	}), "utf8");
	const staleTemp = path.join(outputDirectory, `.stale-run.json.123.${"a".repeat(24)}.tmp`);
	const recentTemp = path.join(outputDirectory, `.recent-run.json.456.${"b".repeat(24)}.tmp`);
	fs.writeFileSync(staleTemp, "partial", "utf8");
	fs.writeFileSync(recentTemp, "partial", "utf8");
	const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
	fs.utimesSync(staleTemp, staleTime, staleTime);

	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const plugin = new IsolatedPlugin();
	plugin.app = { vault: { adapter: {} } };
	plugin.loadData = async () => makeStoredState("", []);
	plugin.saveData = async () => {};
	await plugin.loadSettings();
	assert.equal(fs.existsSync(unknownCanonical), true, "missing metadata is not deletion authority");
	assert.equal(fs.existsSync(staleTemp), false, "strictly named stale atomic temp should be reclaimed");
	assert.equal(fs.existsSync(recentTemp), true, "recent atomic temp may still belong to an active write");
}

async function testClearHistoryDeletesCanonicalSidecar() {
	const run = makeRun("run-clear-history");
	const { plugin } = makePlugin("", run);
	await finishSuccessfully(plugin, run, "sensitive full output");
	const outputPath = pluginOutputPath(run.id);
	assert.equal(fs.existsSync(outputPath), true);
	assert.equal(await plugin.clearCompletedTaskHistory(), 1);
	assert.equal(fs.existsSync(outputPath), false, "clearing history must delete its discoverable full-output sidecar");
	assert.deepEqual(plugin.taskRuns, []);
}

async function testClearHistoryFailureKeepsRecordVisible() {
	const run = { ...makeRun("run-clear-failure"), status: "done" };
	const { plugin } = makePlugin("", run);
	plugin.deleteTaskRunOutput = async () => {
		throw new Error("simulated unlink failure");
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await plugin.clearCompletedTaskHistory().then(() => {
			assert.fail("cleanup failure must not be reported as full success");
		}, (error) => {
			assert.match(error.message, /删除失败/);
		});
		assert.deepEqual(plugin.taskRuns.map((item) => item.id), [run.id]);
	} finally {
		console.warn = originalWarn;
	}
}

async function testClearHistoryNeverFollowsSymlinkOutput() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-delete-symlink-plugin-"));
	const outputDirectory = path.join(isolatedPluginRoot, "task-output", "dashboard-runs");
	fs.mkdirSync(outputDirectory, { recursive: true });
	const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-delete-symlink-outside-"));
	const outsideFile = path.join(outsideRoot, "outside.json");
	fs.writeFileSync(outsideFile, "outside remains unchanged", "utf8");
	try {
		fs.symlinkSync(outsideFile, path.join(outputDirectory, "run-delete-symlink.json"), "file");
	} catch (error) {
		if (error?.code === "EPERM") return;
		throw error;
	}
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const run = { ...makeRun("run-delete-symlink"), status: "done" };
	const { plugin } = makePlugin("", run, IsolatedPlugin);
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await plugin.clearCompletedTaskHistory().then(() => {
			assert.fail("symlink sidecar cleanup must fail closed");
		}, (error) => {
			assert.match(error.message, /删除失败/);
		});
		assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside remains unchanged");
		assert.deepEqual(plugin.taskRuns.map((item) => item.id), [run.id]);
	} finally {
		console.warn = originalWarn;
	}
}

async function testHistoryLimitReclaimsTerminalSidecar() {
	const oldRun = makeRun("run-history-limit-old");
	const { plugin } = makePlugin("", oldRun);
	await finishSuccessfully(plugin, oldRun, "old full output");
	const oldOutputPath = pluginOutputPath(oldRun.id);
	assert.equal(fs.existsSync(oldOutputPath), true);
	plugin.settings.taskHistoryLimit = 1;
	const newRun = await plugin.startTaskRun(
		{ id: "paper-ingest", label: "文献入库", agent: "paper-ingest" },
		"new task",
		null,
	);
	assert.equal(fs.existsSync(oldOutputPath), false, "history-limit eviction must reclaim the old terminal sidecar");
	assert.deepEqual(plugin.taskRuns.map((item) => item.id), [newRun.id]);
}

async function testSettingHistoryLimitDeletesOverflowAndPersistsFiveRuns() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-limit-setting-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const runs = Array.from({ length: 6 }, (_, index) => (
		makeTerminalRun(`run-limit-setting-${index}`, `output ${index}`)
	));
	const { plugin, snapshots } = makePlugin("", runs[0], IsolatedPlugin);
	plugin.taskRuns = runs;
	plugin.settings.taskHistoryLimit = 6;
	await persistTerminalRuns(plugin, runs);
	const overflowPath = outputPathAt(isolatedPluginRoot, runs[5].id);
	assert.equal(fs.existsSync(overflowPath), true);

	await plugin.setTaskHistoryLimit(5);
	assert.equal(plugin.settings.taskHistoryLimit, 5);
	assert.deepEqual(plugin.taskRuns.map((run) => run.id), runs.slice(0, 5).map((run) => run.id));
	assert.equal(fs.existsSync(overflowPath), false);
	assert.deepEqual(snapshots.at(-1).taskRuns.map((run) => run.id), runs.slice(0, 5).map((run) => run.id));

	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => snapshots.at(-1);
	reloaded.saveData = async () => {};
	await reloaded.loadSettings();
	assert.deepEqual(reloaded.taskRuns.map((run) => run.id), runs.slice(0, 5).map((run) => run.id));
}

async function testHistoryLimitDeletionFailureRetainsDurableCleanupMarker() {
	const runs = Array.from({ length: 6 }, (_, index) => makeTerminalRun(`run-limit-failure-${index}`));
	const { plugin, snapshots } = makePlugin("", runs[0]);
	plugin.taskRuns = runs;
	plugin.settings.taskHistoryLimit = 6;
	plugin.deleteTaskRunOutput = async () => {
		throw new Error("simulated retention unlink failure");
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await plugin.setTaskHistoryLimit(5);
		assert.equal(plugin.taskRuns.length, 6);
		assert.equal(plugin.taskRuns[5].cleanupPending, true);
		assert.equal(snapshots.at(-1).taskRuns[5].cleanupPending, true);

		const reloaded = new AgentDashboardPlugin();
		reloaded.app = { vault: { adapter: {} } };
		reloaded.loadData = async () => snapshots.at(-1);
		reloaded.deleteTaskRunOutput = async () => {
			throw new Error("still locked");
		};
		reloaded.saveData = async () => {};
		await reloaded.loadSettings();
		assert.equal(reloaded.taskRuns.length, 6);
		assert.equal(reloaded.taskRuns[5].cleanupPending, true);
	} finally {
		console.warn = originalWarn;
	}
}

async function testStartSaveFailureNeverDeletesExistingHistoryOrSidecar() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-start-save-failure-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const runs = Array.from({ length: 5 }, (_, index) => makeTerminalRun(`run-start-save-${index}`));
	const { plugin } = makePlugin("", runs[0], IsolatedPlugin);
	plugin.taskRuns = runs;
	plugin.settings.taskHistoryLimit = 5;
	runs[4].outputPath = await plugin.persistTaskRunOutput(runs[4]);
	const oldOutputPath = outputPathAt(isolatedPluginRoot, runs[4].id);
	plugin.saveData = async () => {
		throw new Error("simulated phase-one save failure");
	};
	await assert.rejects(
		plugin.startTaskRun(
			{ id: "paper-ingest", label: "文献入库", agent: "paper-ingest" },
			"new task",
			null,
		),
		/simulated phase-one save failure/,
	);
	assert.deepEqual(plugin.taskRuns.map((run) => run.id), runs.map((run) => run.id));
	assert.equal(fs.existsSync(oldOutputPath), true);
}

async function testFinalRetentionSaveFailureConvergesFromMarkerOnReload() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-finalize-reload-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const runs = Array.from({ length: 6 }, (_, index) => makeTerminalRun(`run-finalize-${index}`));
	const { plugin } = makePlugin("", runs[0], IsolatedPlugin);
	plugin.taskRuns = runs;
	plugin.settings.taskHistoryLimit = 6;
	runs[5].outputPath = await plugin.persistTaskRunOutput(runs[5]);
	const overflowPath = outputPathAt(isolatedPluginRoot, runs[5].id);
	let saveCount = 0;
	let markerSnapshot = null;
	plugin.saveData = async (snapshot) => {
		saveCount += 1;
		if (saveCount === 1) {
			markerSnapshot = JSON.parse(JSON.stringify(snapshot));
			return;
		}
		throw new Error("simulated final save failure");
	};
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		await plugin.setTaskHistoryLimit(5);
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(fs.existsSync(overflowPath), false, "unlink completed before the failed final save");
	assert.equal(markerSnapshot.taskRuns[5].cleanupPending, true);

	const reloadSnapshots = [];
	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => markerSnapshot;
	reloaded.saveData = async (snapshot) => reloadSnapshots.push(JSON.parse(JSON.stringify(snapshot)));
	await reloaded.loadSettings();
	assert.deepEqual(reloaded.taskRuns.map((run) => run.id), runs.slice(0, 5).map((run) => run.id));
	assert.deepEqual(reloadSnapshots.at(-1).taskRuns.map((run) => run.id), runs.slice(0, 5).map((run) => run.id));
}

async function testActiveOverflowIsPersistedThenSafelyRetiredOnReload() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-active-overflow-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const kept = Array.from({ length: 5 }, (_, index) => makeTerminalRun(`run-active-kept-${index}`));
	const active = [makeRun("run-active-overflow-a"), makeRun("run-active-overflow-b")];
	const { plugin, snapshots } = makePlugin("", kept[0], IsolatedPlugin);
	plugin.taskRuns = [...kept, ...active];
	plugin.settings.taskHistoryLimit = 5;
	await plugin.saveSettings();
	assert.equal(snapshots.at(-1).taskRuns.length, 7, "active overflow must survive bounded persistence");

	const reloaded = new IsolatedPlugin();
	reloaded.app = { vault: { adapter: {} } };
	reloaded.loadData = async () => snapshots.at(-1);
	reloaded.saveData = async () => {};
	await reloaded.loadSettings();
	assert.deepEqual(reloaded.taskRuns.map((run) => run.id), kept.map((run) => run.id));
}

async function testCompletingActiveOverflowReclaimsItsNewSidecar() {
	const isolatedPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-complete-overflow-"));
	const IsolatedPlugin = loadPluginAt(isolatedPluginRoot);
	const kept = Array.from({ length: 5 }, (_, index) => makeTerminalRun(`run-complete-kept-${index}`));
	const active = makeRun("run-complete-overflow");
	const { plugin } = makePlugin("", kept[0], IsolatedPlugin);
	plugin.taskRuns = [...kept, active];
	plugin.settings.taskHistoryLimit = 5;
	const completed = await finishSuccessfully(plugin, active, "overflow completion output");
	assert.equal(completed.status, "done");
	assert.equal(plugin.getTaskRun(active.id), null);
	assert.equal(fs.existsSync(outputPathAt(isolatedPluginRoot, active.id)), false);
}

async function testConcurrentTaskStartCannotStealCompletionPath() {
	const runA = makeRun("run-concurrent-a");
	const { plugin } = makePlugin("", runA);
	let releasePersistence;
	const persistenceStarted = new Promise((resolve) => {
		plugin.persistTaskRunOutput = async (run) => {
			assert.equal(run.id, runA.id);
			resolve();
			return new Promise((release) => { releasePersistence = release; });
		};
	});
	const finishingA = finishSuccessfully(plugin, runA, "A output");
	await persistenceStarted;
	const startingB = plugin.startTaskRun(
		{ id: "pdf-xray", label: "PDF 深读", agent: "paper-xray" },
		"B task",
		null,
	);
	releasePersistence("task-output/dashboard-runs/run-concurrent-a.json");
	const [completedA, runB] = await Promise.all([finishingA, startingB]);
	assert.equal(completedA.id, runA.id, "finish A must return A after B is prepended");
	assert.equal(completedA.outputPath, "task-output/dashboard-runs/run-concurrent-a.json");
	assert.equal(plugin.getTaskRun(runB.id).outputPath, undefined, "B must never inherit A's sidecar path");
	assert.equal(plugin.getTaskRun(runA.id).outputPath, completedA.outputPath);
}

async function testClearHistoryWaitsForInFlightCompletion() {
	const run = makeRun("run-clear-during-finish");
	const { plugin } = makePlugin("", run);
	let releasePersistence;
	const persistenceStarted = new Promise((resolve) => {
		plugin.persistTaskRunOutput = async () => {
			resolve();
			return new Promise((release) => { releasePersistence = release; });
		};
	});
	const finishing = finishSuccessfully(plugin, run, "pending output");
	await persistenceStarted;
	const clearing = plugin.clearCompletedTaskHistory();
	releasePersistence("task-output/dashboard-runs/run-clear-during-finish.json");
	const completed = await finishing;
	assert.equal(completed.id, run.id);
	assert.equal(await clearing, 1, "clear should run after the queued completion becomes durable");
	assert.equal(plugin.getTaskRun(run.id), null);
}

async function testStartDuringClearIsSerialized() {
	const oldRun = { ...makeRun("run-clear-then-start"), status: "done" };
	const { plugin } = makePlugin("", oldRun);
	let releaseDelete;
	const deleteStarted = new Promise((resolve) => {
		plugin.deleteTaskRunOutput = async () => {
			resolve();
			return new Promise((release) => { releaseDelete = release; });
		};
	});
	const clearing = plugin.clearCompletedTaskHistory();
	await deleteStarted;
	const starting = plugin.startTaskRun(
		{ id: "paper-ingest", label: "文献入库", agent: "paper-ingest" },
		"new task during clear",
		null,
	);
	releaseDelete(true);
	const [removed, newRun] = await Promise.all([clearing, starting]);
	assert.equal(removed, 1);
	assert.deepEqual(plugin.taskRuns.map((item) => item.id), [newRun.id]);
}

async function testConcurrentStartsAreSerialized() {
	const plugin = makePlugin("", makeRun("placeholder")).plugin;
	plugin.taskRuns = [];
	const [first, second] = await Promise.all([
		plugin.startTaskRun(
			{ id: "paper-ingest", label: "文献入库", agent: "paper-ingest" },
			"first concurrent start",
			null,
		),
		plugin.startTaskRun(
			{ id: "pdf-xray", label: "PDF 深读", agent: "paper-xray" },
			"second concurrent start",
			null,
		),
	]);
	assert.equal(plugin.taskRuns.length, 2);
	assert.ok(plugin.getTaskRun(first.id));
	assert.ok(plugin.getTaskRun(second.id));
}

async function main() {
	await testNoToolkitDoesNotWriteToCwd();
	await testInvalidToolkitDoesNotCreateConfiguredPath();
	await testNoToolkitReloadRestoresFullOutput();
	await testConfiguredToolkitStillUsesPluginStorage();
	await testSameRunAtomicallyReplacesExternalOutput();
	await testExternalWriteFailureKeepsTrueOutcome();
	await testSettingsSaveFailureKeepsTrueOutcome();
	await testEmptyOutputFailureRecoversAfterSettingsSaveFailure();
	await testVaultLintCompletionAlsoRecovers();
	await testTerminalDataOutcomeCannotBeReversedByStaleSidecar();
	await testJunctionOutputDirectoryIsRejected();
	await testSymlinkOutputFileIsRejected();
	await testPersistedPayloadMustMatchRunIdentity();
	await testTamperedRunIdCannotEscapeRoot();
	await testLegacyLongOutputMigratesAfterNormalization();
	await testLegacyRunningLongOutputSurvivesInterruptedMigrationAndReload();
	await testLegacyVaultLintLongOutputMigratesAfterStatusNormalization();
	await testLegacyLongOutputMigrationFailureNeverOverwritesRawData();
	await testLegacyToolkitOutputRemainsReadable();
	await testCleanupPendingReloadDeletesCanonicalSidecarAndRecord();
	await testCleanupPendingReloadRemovesRecordWhenSidecarAlreadyMissing();
	await testCleanupPendingReloadDeletesExactLegacyToolkitSidecar();
	await testStartupKeepsUnreferencedCanonicalRecoveryAndOnlyRemovesStaleTemps();
	await testClearHistoryDeletesCanonicalSidecar();
	await testClearHistoryFailureKeepsRecordVisible();
	await testClearHistoryNeverFollowsSymlinkOutput();
	await testHistoryLimitReclaimsTerminalSidecar();
	await testSettingHistoryLimitDeletesOverflowAndPersistsFiveRuns();
	await testHistoryLimitDeletionFailureRetainsDurableCleanupMarker();
	await testStartSaveFailureNeverDeletesExistingHistoryOrSidecar();
	await testFinalRetentionSaveFailureConvergesFromMarkerOnReload();
	await testActiveOverflowIsPersistedThenSafelyRetiredOnReload();
	await testCompletingActiveOverflowReclaimsItsNewSidecar();
	await testConcurrentTaskStartCannotStealCompletionPath();
	await testClearHistoryWaitsForInFlightCompletion();
	await testStartDuringClearIsSerialized();
	await testConcurrentStartsAreSerialized();
	console.log("TASK_OUTPUT_PERSISTENCE_TEST_OK");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
