"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
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
		timeoutMs: 5_000,
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
	}), /ENOENT|spawn/);
}

async function testAbortWaitsForProcessTree() {
	const controller = new AbortController();
	const script = [
		"const {spawn}=require('node:child_process');",
		"const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
		"console.log(JSON.stringify({parent:process.pid,child:child.pid}));",
		"setInterval(()=>{},1000);",
	].join("");
	const running = runMineruProcessCommand({
		command: process.execPath,
		baseArgs: [],
		cliArgs: ["-e", script],
		cwd: os.tmpdir(),
		timeoutMs: 30_000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 400);
	const result = await running;
	assert.equal(result.exitCode, 130);
	assert.match(result.stderr, /已确认 MinerU 进程树退出/);
	const pids = JSON.parse(result.stdout.trim().split(/\r?\n/)[0]);
	assert.equal(pidAlive(pids.parent), false, "parent PID must be gone before stop resolves");
	assert.equal(pidAlive(pids.child), false, "descendant PID must be gone before stop resolves");
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

(async () => {
	await testNormalExit();
	await testSpawnFailureRejectsWithoutClaimingStop();
	await testAbortWaitsForProcessTree();
	await testTimeoutWaitsForExit();
	console.log("MINERU_PROCESS_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
