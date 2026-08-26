import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const projectRoot = pluginRoot;
const vaultName = String(process.env.OBSIDIAN_VAULT_NAME || "").trim();
const pluginId = "research-agent-reader";
const action = process.argv[2] || "check";

function isFile(candidate) {
	try {
		return Boolean(candidate) && fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function findOnPath(command) {
	const locator = process.platform === "win32" ? "where.exe" : "which";
	const result = spawnSync(locator, [command], {
		encoding: "utf8",
		windowsHide: true,
		shell: false,
	});
	if (result.status !== 0) return "";
	return String(result.stdout || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(isFile) || "";
}

function findRunningObsidianCli() {
	if (process.platform !== "win32") return "";
	const powershell = path.join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const result = spawnSync(
		powershell,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$p = Get-Process -Name Obsidian -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Path }",
		],
		{ encoding: "utf8", windowsHide: true, shell: false },
	);
	const executable = String(result.stdout || "").trim().split(/\r?\n/)[0] || "";
	return executable ? path.join(path.dirname(executable), "Obsidian.com") : "";
}

function detectCli() {
	const candidates = process.platform === "win32"
		? [
			process.env.OBSIDIAN_CLI_PATH,
			findRunningObsidianCli(),
			path.join(process.env.LOCALAPPDATA || "", "Programs", "Obsidian", "Obsidian.com"),
			path.join(process.env.ProgramFiles || "", "Obsidian", "Obsidian.com"),
			findOnPath("obsidian"),
		]
		: [
			process.env.OBSIDIAN_CLI_PATH,
			findOnPath("obsidian"),
			path.join(process.env.HOME || "", ".local", "bin", "obsidian"),
			"/usr/local/bin/obsidian",
		];
	return candidates.find(isFile) || "";
}

const cli = detectCli();

function run(args, { allowFailure = false, capture = false } = {}) {
	if (!cli) {
		throw new Error("未检测到 Obsidian CLI。请在 Obsidian 设置 → 常规中启用命令行接口，或设置 OBSIDIAN_CLI_PATH。");
	}
	const result = spawnSync(cli, args, {
		cwd: projectRoot,
		encoding: "utf8",
		windowsHide: true,
		shell: false,
		timeout: 15_000,
	});
	if (result.error) throw result.error;
	const stdout = String(result.stdout || "").trim();
	const stderr = String(result.stderr || "").trim();
	if (!capture) {
		if (stdout) process.stdout.write(`${stdout}\n`);
		if (stderr) process.stderr.write(`${stderr}\n`);
	}
	if (!allowFailure && result.status !== 0) {
		throw new Error(`Obsidian CLI 命令失败（${result.status}）：${args.join(" ")}\n${stderr || stdout}`);
	}
	return { status: result.status, stdout, stderr };
}

function checkConnection() {
	if (!vaultName) {
		throw new Error("请先设置 OBSIDIAN_VAULT_NAME，再运行 Obsidian CLI 检查。");
	}
	run(["version"]);
	run(["vaults", "verbose"]);
	run([`vault=${vaultName}`, "plugin", `id=${pluginId}`]);
}

function outputHasDiagnostics(output) {
	const text = output.trim();
	if (!text) return false;
	return !/^no\s+.*(?:captured|found)\.?$/i.test(text)
		&& !/^0\s+(?:errors?|messages?)\.?$/i.test(text)
		&& !/^\[\]$/i.test(text);
}

async function reloadAndInspect({ screenshot = false } = {}) {
	if (!vaultName) {
		throw new Error("请先设置 OBSIDIAN_VAULT_NAME，再运行 Obsidian CLI QA。");
	}
	run([`vault=${vaultName}`, "dev:errors", "clear"]);
	let debuggerAttached = false;
	try {
		const debuggerResult = run([`vault=${vaultName}`, "dev:debug", "on"], {
			capture: true,
			allowFailure: true,
		});
		debuggerAttached = debuggerResult.status === 0;
		if (debuggerAttached) run([`vault=${vaultName}`, "dev:console", "clear"]);
		run([`vault=${vaultName}`, "plugin:reload", `id=${pluginId}`]);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const errors = run([`vault=${vaultName}`, "dev:errors"], { capture: true, allowFailure: true });
		const consoleErrors = debuggerAttached
			? run(
				[`vault=${vaultName}`, "dev:console", "level=error", "limit=100"],
				{ capture: true, allowFailure: true },
			)
			: { status: 0, stdout: "", stderr: "" };
		if (errors.stdout) process.stdout.write(`${errors.stdout}\n`);
		if (consoleErrors.stdout) process.stdout.write(`${consoleErrors.stdout}\n`);
		if (!debuggerAttached) process.stdout.write("Console capture unavailable: debugger could not be attached.\n");
		const dashboardDom = run(
			[`vault=${vaultName}`, "dev:dom", "selector=.agent-dashboard-view", "total"],
			{ capture: true, allowFailure: true },
		);
		if (dashboardDom.stdout) process.stdout.write(`Dashboard DOM: ${dashboardDom.stdout}\n`);
		if (dashboardDom.status !== 0 || !/\b[1-9]\d*\b/.test(dashboardDom.stdout)) {
			throw new Error("插件重载后未检测到 Research Agent Reader 视图 DOM。");
		}
		if (screenshot) {
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const screenshotPath = path.join(os.tmpdir(), `research-agent-reader-${stamp}.png`);
			run([`vault=${vaultName}`, "dev:screenshot", `path=${screenshotPath}`]);
			process.stdout.write(`Screenshot: ${screenshotPath}\n`);
		}
		if (outputHasDiagnostics(errors.stdout) || outputHasDiagnostics(consoleErrors.stdout)) {
			throw new Error("插件重载后检测到 JavaScript 或控制台错误。");
		}
	} finally {
		if (debuggerAttached) {
			run([`vault=${vaultName}`, "dev:debug", "off"], { allowFailure: true });
		}
	}
}

try {
	if (action === "check") {
		checkConnection();
	} else if (action === "reload") {
		await reloadAndInspect();
	} else if (action === "qa") {
		checkConnection();
		await reloadAndInspect({ screenshot: true });
	} else {
		throw new Error("仅支持 check、reload、qa；该 wrapper 不接受 eval 或任意 CLI 命令。");
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
