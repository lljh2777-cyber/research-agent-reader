"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");
const hookEntry = path.join(pluginRoot, "tests", "mineru-process-hooks.ts");
const hookBuild = esbuild.buildSync({
	entryPoints: [path.join(pluginRoot, "src", "runtime", "mineru-process.ts")],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	logLevel: "silent",
});
const hookModule = new Module(hookEntry, module);
hookModule.filename = hookEntry;
hookModule.paths = Module._nodeModulePaths(pluginRoot);
hookModule._compile(hookBuild.outputFiles[0].text, hookEntry);
const { runMineruProcessCommand } = hookModule.exports;

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function testNormalExit() {
	const result = await runMineruProcessCommand({
		command: process.execPath,
		baseArgs: [],
		cliArgs: ["-e", "process.stdout.write('ok')"],
		cwd: os.tmpdir(),
		// On a cold Windows runner the Job Object wrapper must compile its small
		// C# helper before it can launch the command.
		timeoutMs: process.platform === "win32" ? 30_000 : 5_000,
		signal: new AbortController().signal,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout, "ok");
}

async function testSpawnFailureRejectsWithoutClaimingStop() {
	await assert.rejects(runMineruProcessCommand({
		command: path.join(os.tmpdir(), "missing-mineru-executable-for-test"),
		baseArgs: [],
		cliArgs: [],
		cwd: os.tmpdir(),
		timeoutMs: 5_000,
		signal: new AbortController().signal,
	}, "", { platform: "linux" }), /ENOENT|spawn/);
}

async function testPreAbortedNeverSpawns() {
	const controller = new AbortController();
	controller.abort();
	let spawnCount = 0;
	const result = await runMineruProcessCommand({
		command: process.execPath,
		baseArgs: [],
		cliArgs: ["-e", "process.exit(0)"],
		cwd: os.tmpdir(),
		timeoutMs: 5_000,
		signal: controller.signal,
	}, "", {
		spawnProcess() {
			spawnCount += 1;
			throw new Error("pre-aborted run must not spawn");
		},
	});
	assert.equal(spawnCount, 0);
	assert.equal(result.exitCode, 130);
	assert.match(result.stderr, /未创建 MinerU 进程/);
}

function fakeChild(pid, onKill = () => {}) {
	const child = new EventEmitter();
	child.pid = pid;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = onKill;
	return child;
}

async function testWindowsHelperFailureNeverClaimsTreeExit() {
	const controller = new AbortController();
	let calls = 0;
	const helperCommands = [];
	const main = fakeChild(4242, () => {
		queueMicrotask(() => main.emit("close", 0));
		return true;
	});
	const spawnProcess = (command) => {
		calls += 1;
		if (calls === 1) {
			queueMicrotask(() => main.emit("spawn"));
			return main;
		}
		helperCommands.push(command);
		const helper = fakeChild(4343);
		queueMicrotask(() => helper.emit("close", 1));
		return helper;
	};
	const running = runMineruProcessCommand({
		command: "mineru-open-api",
		baseArgs: [], cliArgs: ["extract"], cwd: os.tmpdir(), timeoutMs: 30_000,
		signal: controller.signal,
	}, "", { spawnProcess, platform: "win32", windowsRoot: "C:\\Windows", finalCloseTimeoutMs: 100 });
	setImmediate(() => controller.abort());
	await assert.rejects(running, /进程树终止未确认|完整进程树/);
	assert.equal(helperCommands.some((command) => (
		path.win32.normalize(command) === path.win32.normalize("C:\\Windows\\System32\\taskkill.exe")
	)), true);
}

async function testWindowsHelperTimeoutNeverClaimsTreeExit() {
	const controller = new AbortController();
	let calls = 0;
	const main = fakeChild(5252, () => {
		queueMicrotask(() => main.emit("close", 0));
		return true;
	});
	const spawnProcess = () => {
		calls += 1;
		if (calls === 1) {
			queueMicrotask(() => main.emit("spawn"));
			return main;
		}
		return fakeChild(5353, () => true);
	};
	const running = runMineruProcessCommand({
		command: "mineru-open-api", baseArgs: [], cliArgs: ["extract"], cwd: os.tmpdir(), timeoutMs: 30_000,
		signal: controller.signal,
	}, "", {
		spawnProcess, platform: "win32", windowsRoot: "C:\\Windows",
		helperTimeoutMs: 100, finalCloseTimeoutMs: 100,
	});
	setImmediate(() => controller.abort());
	await assert.rejects(running, /进程树终止未确认|完整进程树/);
}

async function testAbortWaitsForProcessTree() {
	const controller = new AbortController();
	const pidFile = path.join(os.tmpdir(), `mineru-abort-tree-${process.pid}-${Date.now()}.json`);
	const script = [
		"const fs=require('node:fs');const {spawn}=require('node:child_process');",
		"const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();",
		`fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));`,
		"setInterval(()=>{},1000);",
	].join("");
	try {
		const running = runMineruProcessCommand({
			command: process.execPath,
			baseArgs: [],
			cliArgs: ["-e", script],
			cwd: os.tmpdir(),
			timeoutMs: 30_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 800);
		const result = await running;
		assert.equal(result.exitCode, 130);
		assert.match(result.stderr, /已确认 MinerU 进程树退出/);
		const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
		assert.equal(pidAlive(pids.parent), false, "parent PID must be gone before stop resolves");
		assert.equal(pidAlive(pids.child), false, "descendant PID must be gone before stop resolves");
	} finally {
		try { fs.unlinkSync(pidFile); } catch { /* Fixture may not have started. */ }
	}
}

async function testTimeoutWaitsForExit() {
	const result = await runMineruProcessCommand({
		command: process.execPath,
		baseArgs: [],
		cliArgs: ["-e", "setInterval(()=>{},1000)"],
		cwd: os.tmpdir(),
		timeoutMs: 200,
		signal: new AbortController().signal,
	});
	assert.equal(result.exitCode, 124);
	assert.match(result.stderr, /提取超时；已确认 MinerU 进程树退出/);
}

async function testNaturalParentExitDoesNotApproveLiveDescendant() {
	const pidFile = path.join(os.tmpdir(), `mineru-descendant-${process.pid}-${Date.now()}.txt`);
	const script = [
		"const fs=require('node:fs');const {spawn}=require('node:child_process');",
		"const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
		`fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
	].join("");
	let descendantPid = 0;
	try {
		const request = {
			command: process.execPath,
			baseArgs: [],
			cliArgs: ["-e", script],
			cwd: os.tmpdir(),
			timeoutMs: process.platform === "win32" ? 2_500 : 5_000,
			signal: new AbortController().signal,
		};
		if (process.platform === "win32") {
			const result = await runMineruProcessCommand(request, "", {
				helperTimeoutMs: 2_000, finalCloseTimeoutMs: 300,
			});
			assert.equal(result.exitCode, 124, "Windows Job must keep the wrapper alive until the descendant is killed on timeout");
		} else {
			await assert.rejects(runMineruProcessCommand(request, "", {
				helperTimeoutMs: 2_000, finalCloseTimeoutMs: 300,
			}), /完整进程树退出/);
		}
		descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
		assert.equal(pidAlive(descendantPid), process.platform !== "win32",
			"Windows Job must kill the descendant; POSIX rejection leaves cleanup to this fixture");
	} finally {
		if (!descendantPid && fs.existsSync(pidFile)) descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
		if (descendantPid) {
			try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already gone. */ }
		}
		try { fs.unlinkSync(pidFile); } catch { /* Fixture may not have reached the write. */ }
	}
}

(async () => {
	await testNormalExit();
	await testSpawnFailureRejectsWithoutClaimingStop();
	await testPreAbortedNeverSpawns();
	await testWindowsHelperFailureNeverClaimsTreeExit();
	await testWindowsHelperTimeoutNeverClaimsTreeExit();
	await testAbortWaitsForProcessTree();
	await testTimeoutWaitsForExit();
	await testNaturalParentExitDoesNotApproveLiveDescendant();
	console.log("MINERU_PROCESS_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
