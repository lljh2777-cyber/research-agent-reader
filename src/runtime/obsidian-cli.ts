import * as fs from "node:fs";
import { spawn } from "node:child_process";

export interface ObsidianCliCommandResult {
	label: "version" | "vaults" | "plugin";
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface ObsidianCliConnectionResult {
	ok: boolean;
	executable: string;
	vaultName: string;
	vaultPath: string;
	vaultFound: boolean;
	appVersion: string;
	installerVersion: string;
	pluginId: string;
	pluginName: string;
	pluginVersion: string;
	pluginEnabled: boolean;
	message: string;
	testedAt: string;
	durationMs: number;
	commands: ObsidianCliCommandResult[];
}

export interface ObsidianCliProbeState {
	status: "idle" | "testing" | "done";
	result?: ObsidianCliConnectionResult;
}

interface ObsidianCliProbeOptions {
	executable: string;
	vaultName: string;
	pluginId: string;
	cwd: string;
}

interface VersionIdentity {
	appVersion: string;
	installerVersion: string;
}

const OUTPUT_LIMIT = 32_000;
const COMMAND_TIMEOUT_MS = 8_000;

function appendOutput(current: string, chunk: Buffer | string): string {
	return `${current}${chunk.toString()}`.slice(-OUTPUT_LIMIT);
}

export function parseObsidianVersionOutput(output: string): VersionIdentity {
	const firstLine = output.trim().split(/\r?\n/)[0] || "";
	const match = firstLine.match(/^(.+?)(?:\s+\(installer\s+(.+?)\))?$/i);
	return {
		appVersion: match?.[1]?.trim() || "",
		installerVersion: match?.[2]?.trim() || "",
	};
}

export function parseObsidianVaultsOutput(
	output: string,
	vaultName: string,
): { found: boolean; path: string } {
	const target = vaultName.trim().toLowerCase();
	for (const line of output.split(/\r?\n/)) {
		const [name, ...pathParts] = line.split("\t");
		if (name.trim().toLowerCase() !== target) continue;
		return { found: true, path: pathParts.join("\t").trim() };
	}
	return { found: false, path: "" };
}

export function parseObsidianPluginOutput(output: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const separator = line.indexOf("\t");
		if (separator <= 0) continue;
		fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
	}
	return fields;
}

function runObsidianCliCommand(
	executable: string,
	args: string[],
	cwd: string,
	label: ObsidianCliCommandResult["label"],
): Promise<ObsidianCliCommandResult> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ReturnType<typeof spawn> | null = null;
		const finish = (exitCode: number | null, errorMessage = ""): void => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			if (errorMessage) stderr = appendOutput(stderr, errorMessage);
			resolve({
				label,
				ok: exitCode === 0,
				exitCode,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				durationMs: Date.now() - startedAt,
			});
		};
		const timer = window.setTimeout(() => {
			child?.kill();
			finish(null, `Obsidian CLI ${label} 检查超过 ${COMMAND_TIMEOUT_MS / 1000} 秒`);
		}, COMMAND_TIMEOUT_MS);
		try {
			child = spawn(executable, args, {
				cwd,
				windowsHide: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.on("data", (chunk) => {
				stdout = appendOutput(stdout, chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr = appendOutput(stderr, chunk);
			});
			child.on("error", (error) => finish(null, error.message));
			child.on("close", (code) => finish(code));
		} catch (error) {
			finish(null, error instanceof Error ? error.message : String(error));
		}
	});
}

export class ObsidianCliService {
	async probe(options: ObsidianCliProbeOptions): Promise<ObsidianCliConnectionResult> {
		const startedAt = Date.now();
		const executable = String(options.executable || "").trim();
		const base = {
			executable,
			vaultName: options.vaultName,
			vaultPath: "",
			vaultFound: false,
			appVersion: "",
			installerVersion: "",
			pluginId: options.pluginId,
			pluginName: "",
			pluginVersion: "",
			pluginEnabled: false,
			testedAt: new Date().toISOString(),
		};
		if (!executable || !fs.existsSync(executable)) {
			return {
				...base,
				ok: false,
				message: `Obsidian CLI 可执行文件不存在：${executable || "未配置"}`,
				durationMs: Date.now() - startedAt,
				commands: [],
			};
		}

		const commands: ObsidianCliCommandResult[] = [];
		const version = await runObsidianCliCommand(executable, ["version"], options.cwd, "version");
		commands.push(version);
		const versionIdentity = parseObsidianVersionOutput(version.stdout);
		if (!version.ok) {
			return {
				...base,
				...versionIdentity,
				ok: false,
				message: version.stderr || version.stdout || "无法连接运行中的 Obsidian。",
				durationMs: Date.now() - startedAt,
				commands,
			};
		}

		const vaults = await runObsidianCliCommand(executable, ["vaults", "verbose"], options.cwd, "vaults");
		commands.push(vaults);
		const vaultIdentity = parseObsidianVaultsOutput(vaults.stdout, options.vaultName);
		const plugin = await runObsidianCliCommand(
			executable,
			[`vault=${options.vaultName}`, "plugin", `id=${options.pluginId}`],
			options.cwd,
			"plugin",
		);
		commands.push(plugin);
		const pluginIdentity = parseObsidianPluginOutput(plugin.stdout);
		const pluginEnabled = pluginIdentity.enabled?.toLowerCase() === "true";
		const ok = vaults.ok && vaultIdentity.found && plugin.ok && pluginEnabled;
		const failedCommand = commands.find((command) => !command.ok);
		const message = ok
			? "Obsidian CLI 已连接，当前 Vault 与 Agent Dashboard 插件状态正常。"
			: failedCommand?.stderr
				|| failedCommand?.stdout
				|| (!vaultIdentity.found
					? `CLI 未返回当前 Vault：${options.vaultName}`
					: !pluginEnabled
						? "Agent Dashboard 插件未启用或状态无法确认。"
						: "Obsidian CLI 连接测试未完全通过。");
		return {
			...base,
			...versionIdentity,
			ok,
			vaultPath: vaultIdentity.path,
			vaultFound: vaultIdentity.found,
			pluginName: pluginIdentity.name || "",
			pluginVersion: pluginIdentity.version || "",
			pluginEnabled,
			message,
			durationMs: Date.now() - startedAt,
			commands,
		};
	}
}
