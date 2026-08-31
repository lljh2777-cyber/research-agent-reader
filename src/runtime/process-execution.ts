import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import type { DashboardAction } from "../actions";
import {
	getCliBackendLabel,
	MODEL_OPTIONS,
	OPENCODE_ZEN_FREE_MODELS,
	type CliBackendId,
} from "../config";
import { ProviderConnectionError } from "../providers/shared";
import type { DashboardSettings } from "./settings";
import type { DashboardLifecycleState } from "./lifecycle-state";
import type {
	CliDiscoveredModel,
	CliModelDiscoveryResult,
	CodePracticeRequest,
	CodePracticeResult,
	CodexExecutionConfig,
	DashboardProcessHooks,
	DashboardProcessResult,
	ProviderConnectionTestResult,
} from "../types/contracts";

interface VaultActionProcessOptions {
	runId: string;
	action: DashboardAction;
	input: string;
	executionConfig: CodexExecutionConfig;
	settings: DashboardSettings;
	hooks?: DashboardProcessHooks;
}

interface JsonProcessOptions {
	runId: string;
	executable: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	timeoutMessage: string;
}

interface JsonProcessResult {
	stdout: string;
	stderr: string;
}

function appendOutput(current: string, chunk: Buffer | string, limit: number): string {
	return `${current}${chunk.toString()}`.slice(-limit);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? value as Record<string, unknown>
		: {};
}

function prepareCliSpawn(
	executable: string,
	args: string[],
): { executable: string; args: string[] } {
	if (
		process.platform !== "win32"
		|| !/\.(?:cmd|bat)$/i.test(executable)
	) {
		return { executable, args };
	}
	const powershellShim = executable.replace(/\.(?:cmd|bat)$/i, ".ps1");
	if (!fs.existsSync(powershellShim)) {
		return { executable, args };
	}
	const powershellExecutable = path.join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	return {
		executable: powershellExecutable,
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			powershellShim,
			...args,
		],
	};
}

function createClaudeProcessEnv(settings: DashboardSettings): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PYTHONUTF8: "1",
		PYTHONIOENCODING: "utf-8",
	};
	if (settings.claudeConfigSource !== "official") return env;
	for (const key of [
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_MODEL",
		"ANTHROPIC_DEFAULT_FABLE_MODEL",
		"ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
		"ANTHROPIC_DEFAULT_OPUS_MODEL",
		"ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
		"ANTHROPIC_DEFAULT_SONNET_MODEL",
		"ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
	]) {
		delete env[key];
	}
	return env;
}

/**
 * Independent CLI processes (model discovery, version probes, connection
 * tests) must not depend on the optional toolkit directory: it is often
 * unconfigured, and spawning inside a missing cwd fails. Toolkit runners keep
 * requiring a valid toolkit root and are validated before spawning.
 */
export function resolveCliProcessCwd(toolkitRoot: string): string {
	const root = String(toolkitRoot || "").trim();
	return root && fs.existsSync(root) ? root : process.cwd();
}

export class ProcessExecutionService {
	constructor(private readonly state: DashboardLifecycleState) {}

	discoverCliModels(
		settings: DashboardSettings,
		backendId: CliBackendId,
	): Promise<CliModelDiscoveryResult> {
		if (backendId === "claude-code") {
			return Promise.resolve(this.discoverClaudeModels(settings));
		}
		if (backendId === "opencode") {
			return this.discoverOpenCodeModels(settings);
		}
		return this.discoverCodexModels(settings);
	}

	private discoverCodexModels(settings: DashboardSettings): Promise<CliModelDiscoveryResult> {
		const executable = String(settings.codexExecutable || "");
		const useOfficialConfig = settings.codexConfigSource === "official";
		let switchedModel = "";
		let switchedProvider = "";
		if (!useOfficialConfig) {
			const codexHome = String(process.env.CODEX_HOME || "").trim()
				|| path.join(process.env.USERPROFILE || "", ".codex");
			try {
				const lines = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")
					.split(/\r?\n/);
				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (line.startsWith("[")) break;
					const match = line.match(/^(model|model_provider)\s*=\s*["']([^"']+)["']/);
					if (match?.[1] === "model") switchedModel = match[2].trim();
					if (match?.[1] === "model_provider") switchedProvider = match[2].trim();
				}
			} catch {
				// The app-server may still expose the active CC Switch model.
			}
		}
		const fallback = (message = ""): CliModelDiscoveryResult => ({
			backendId: "codex-cli",
			models: useOfficialConfig
				? MODEL_OPTIONS.map((model) => ({
					id: model.id,
					label: model.label,
					description: model.description,
					supportsFast: model.supportsFast,
				}))
				: switchedModel
					? [{
						id: switchedModel,
						label: `当前模型 · ${switchedModel}`,
						description: switchedProvider ? `provider: ${switchedProvider}` : undefined,
						supportsFast: false,
					}]
					: [],
			effectiveModel: useOfficialConfig ? settings.codexModel : switchedModel,
			source: useOfficialConfig ? "Codex 官方静态回退" : "CC Switch 当前配置",
			complete: false,
			message,
			discoveredAt: new Date().toISOString(),
		});
		if (!executable || !fs.existsSync(executable)) {
			return Promise.resolve(fallback(`Codex 可执行文件不存在：${executable || "未配置"}`));
		}
		return new Promise((resolve) => {
			let settled = false;
			let stdoutBuffer = "";
			let stderr = "";
			let timer = 0;
			const appServerArgs = [
				...(useOfficialConfig
					? ["--config", 'model_provider="openai"']
					: []),
				"app-server",
				"--stdio",
			];
			const invocation = prepareCliSpawn(executable, appServerArgs);
			const child = spawn(invocation.executable, invocation.args, {
				cwd: resolveCliProcessCwd(settings.toolkitRoot),
				shell: false,
				windowsHide: true,
			});
			const finish = (result: CliModelDiscoveryResult): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				if (!child.killed) child.kill();
				resolve(result);
			};
			const send = (payload: Record<string, unknown>): void => {
				if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(payload)}\n`);
			};
			const inspectLine = (line: string): void => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = asRecord(JSON.parse(line));
				} catch {
					return;
				}
				if (event.id === 1 && event.result) {
					send({
						method: "model/list",
						id: 2,
						params: { limit: 100, includeHidden: false },
					});
					return;
				}
				if (event.id !== 2) return;
				const result = asRecord(event.result);
				const data = Array.isArray(result.data) ? result.data : [];
				const models = data
					.map((value): CliDiscoveredModel | null => {
						const model = asRecord(value);
						const id = String(model.id || model.model || "").trim();
						if (!id) return null;
						const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
						const legacyTiers = Array.isArray(model.additionalSpeedTiers)
							? model.additionalSpeedTiers
							: [];
						const reasoning = Array.isArray(model.supportedReasoningEfforts)
							? model.supportedReasoningEfforts
								.map((option) => String(asRecord(option).reasoningEffort || "").trim())
								.filter(Boolean)
							: [];
						return {
							id,
							label: String(model.displayName || id),
							description: String(model.description || ""),
							isDefault: model.isDefault === true,
							supportedReasoningEfforts: reasoning,
							supportsFast: tiers.length > 0 || legacyTiers.includes("fast"),
						};
					})
					.filter((model): model is CliDiscoveredModel => model !== null);
				if (!models.length) {
					finish(fallback("Codex app-server 返回了空模型目录"));
					return;
				}
				const catalogDefault = models.find((model) => model.isDefault)?.id || "";
				finish({
					backendId: "codex-cli",
					models,
					effectiveModel: useOfficialConfig
						? settings.codexModel || catalogDefault
						: switchedModel || catalogDefault,
					source: useOfficialConfig
						? "Codex app-server · 官方 OpenAI"
						: "Codex app-server · CC Switch",
					complete: true,
					discoveredAt: new Date().toISOString(),
				});
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split(/\r?\n/);
				stdoutBuffer = lines.pop() || "";
				lines.forEach(inspectLine);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 4000);
			});
			child.once("error", (error: Error) => finish(fallback(error.message)));
			child.once("close", () => {
				if (stdoutBuffer) inspectLine(stdoutBuffer);
				if (!settled) finish(fallback(stderr.trim() || "Codex app-server 提前退出"));
			});
			send({
				method: "initialize",
				id: 1,
				params: {
					clientInfo: {
						name: "research-agent-reader",
						title: "Research Agent Reader",
						version: "0.29.0",
					},
					capabilities: {
						experimentalApi: false,
						requestAttestation: false,
					},
				},
			});
			timer = window.setTimeout(() => {
				finish(fallback("Codex 模型目录检测超过 15 秒"));
			}, 15000);
		});
	}

	private discoverClaudeModels(settings: DashboardSettings): CliModelDiscoveryResult {
		const candidates = new Map<string, CliDiscoveredModel>();
		const addModel = (id: unknown, label: string): void => {
			const normalized = String(id || "").trim();
			if (!normalized || candidates.has(normalized)) return;
			candidates.set(normalized, {
				id: normalized,
				label,
				supportsFast: false,
				supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
			});
		};
		let configuredModel = "";
		let settingsFound = false;
		if (settings.claudeConfigSource === "cc-switch") {
			const settingsPath = path.join(
				process.env.USERPROFILE || "",
				".claude",
				"settings.json",
			);
			try {
				const source = asRecord(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
				const env = asRecord(source.env);
				settingsFound = true;
				configuredModel = String(env.ANTHROPIC_MODEL || "").trim();
				addModel(configuredModel, configuredModel ? `当前模型 · ${configuredModel}` : "");
				for (const [key, label] of [
					["ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable"],
					["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"],
					["ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"],
					["ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"],
				] as const) {
					const model = String(env[key] || "").trim();
					addModel(model, model ? `${label} · ${model}` : "");
				}
			} catch {
				// An explicit model can still be used when CC Switch settings are unavailable.
			}
		} else {
			for (const [id, label] of [
				["sonnet", "Sonnet · 官方 CLI 别名"],
				["opus", "Opus · 官方 CLI 别名"],
				["haiku", "Haiku · 官方 CLI 别名"],
				["fable", "Fable · 官方 CLI 别名"],
			] as const) {
				addModel(id, label);
			}
		}
		const testedResult = this.state.providerRuntimeState.get("claude-code")?.result;
		const testedModel = testedResult?.ok
			? String(testedResult.model || "").trim()
			: "";
		addModel(settings.claudeModel, `插件设置 · ${settings.claudeModel}`);
		addModel(testedModel, `初始化事件 · ${testedModel}`);
		const effectiveModel = settings.claudeModel.trim()
			|| testedModel
			|| configuredModel;
		return {
			backendId: "claude-code",
			models: [...candidates.values()],
			effectiveModel,
			source: settings.claudeModel.trim()
				? "插件设置覆盖"
				: testedModel
					? "Claude 初始化事件"
					: settings.claudeConfigSource === "cc-switch"
						? settingsFound
							? "CC Switch 用户设置"
							: "CC Switch 配置"
						: "官方 Claude Code",
			complete: false,
			message: settings.claudeConfigSource === "cc-switch"
				? settingsFound
					? "Claude Code 不提供完整模型目录；此处列出 CC Switch 用户设置中可识别的模型。"
					: "未找到可读取的 CC Switch 用户设置；可检查配置来源或手动填写模型。"
				: "Claude Code 不提供完整模型目录；此处列出官方 CLI 别名和初始化事件中确认的模型。",
			discoveredAt: new Date().toISOString(),
		};
	}

	private discoverOpenCodeModels(settings: DashboardSettings): Promise<CliModelDiscoveryResult> {
		const executable = String(settings.openCodeExecutable || "");
		const useOfficialConfig = settings.openCodeConfigSource === "official";
		let configuredModel = useOfficialConfig ? settings.openCodeModel.trim() : "";
		if (!useOfficialConfig) {
			for (const configPath of [
				path.join(process.env.USERPROFILE || "", ".config", "opencode", "opencode.json"),
				path.join(process.env.USERPROFILE || "", ".opencode", "config.json"),
			]) {
				try {
					const content = fs.readFileSync(configPath, "utf8");
					const source = asRecord(JSON.parse(content));
					configuredModel = String(source.model || "").trim();
					if (configuredModel) break;
				} catch {
					// The CLI model list remains authoritative when JSONC or a custom path is used.
				}
			}
		}
		const fallback = (message = ""): CliModelDiscoveryResult => ({
			backendId: "opencode",
			models: useOfficialConfig
				? OPENCODE_ZEN_FREE_MODELS.map((model) => ({
					...model,
					supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
				}))
				: configuredModel
					? [{
						id: configuredModel,
						label: `当前模型 · ${configuredModel}`,
						supportsFast: false,
						supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
					}]
					: [],
			effectiveModel: configuredModel,
			source: useOfficialConfig ? "OpenCode Zen 静态回退" : "CC Switch 当前配置",
			complete: false,
			message,
			discoveredAt: new Date().toISOString(),
		});
		if (!executable || !fs.existsSync(executable)) {
			return Promise.resolve(fallback(`OpenCode 可执行文件不存在：${executable || "未配置"}`));
		}
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer = 0;
			const args = useOfficialConfig ? ["models", "opencode"] : ["models"];
			const invocation = prepareCliSpawn(executable, args);
			const child = spawn(invocation.executable, invocation.args, {
				cwd: resolveCliProcessCwd(settings.toolkitRoot),
				shell: false,
				windowsHide: true,
			});
			const finish = (result: CliModelDiscoveryResult): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve(result);
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 200000);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 8000);
			});
			child.once("error", (error: Error) => finish(fallback(error.message)));
			child.once("close", (code) => {
				if (code !== 0) {
					finish(fallback(stderr.trim() || stdout.trim() || `OpenCode 退出码 ${code}`));
					return;
				}
				const seen = new Set<string>();
				const models = stdout
					.split(/\r?\n/)
					.map((line) => line.trim().split(/\s+/)[0] || "")
					.filter((id) => {
						if (!id.includes("/") || seen.has(id)) return false;
						seen.add(id);
						return true;
					})
					.map((id): CliDiscoveredModel => ({
						id,
						label: id.split("/").slice(1).join("/") || id,
						description: id.endsWith("-free") ? "免费模型" : undefined,
						isDefault: id === configuredModel,
						supportsFast: false,
						supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
					}));
				if (!models.length) {
					finish(fallback("OpenCode 返回了空模型目录"));
					return;
				}
				if (!configuredModel) {
					configuredModel = useOfficialConfig
						? settings.openCodeModel.trim() || models[0].id
						: models.find((model) => model.isDefault)?.id || "";
				}
				finish({
					backendId: "opencode",
					models,
					effectiveModel: configuredModel,
					source: useOfficialConfig
						? "OpenCode models · 官方 Zen"
						: "OpenCode models · CC Switch",
					complete: true,
					discoveredAt: new Date().toISOString(),
				});
			});
			timer = window.setTimeout(() => {
				if (!child.killed) child.kill();
				finish(fallback("OpenCode 模型目录检测超过 20 秒"));
			}, 20000);
		});
	}

	recoverInterruptedPracticeRuns(settings: DashboardSettings): void {
		const runsDirectory = path.join(
			settings.toolkitRoot,
			"tool-library",
			"output",
			"code-practice",
			"runs",
		);
		if (!fs.existsSync(runsDirectory)) return;
		for (const name of fs.readdirSync(runsDirectory)) {
			if (!name.endsWith(".json")) continue;
			const recordPath = path.join(runsDirectory, name);
			try {
				const record = JSON.parse(
					fs.readFileSync(recordPath, "utf8"),
				) as Record<string, unknown>;
				if (record.status !== "queued" && record.status !== "running") continue;
				record.status = "stopped";
				record.finished_at = new Date().toISOString();
				record.stderr = `${String(record.stderr || "")}\nExecution interrupted before the plugin restarted.`.trim();
				fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");
			} catch (error) {
				console.warn(`Could not recover code-practice record: ${recordPath}`, error);
			}
		}
	}

	runCodePractice(
		settings: DashboardSettings,
		request: CodePracticeRequest,
	): Promise<CodePracticeResult> {
		const projectRoot = settings.toolkitRoot;
		const runner = path.join(projectRoot, "tool-library", "scripts", "run_code_practice.py");
		if (!fs.existsSync(runner)) {
			return Promise.reject(new Error(`代码练习 runner 不存在：${runner}`));
		}
		const interpreter = request.language === "python"
			? settings.pythonExecutable
			: settings.rscriptExecutable;
		if (!interpreter || !fs.existsSync(interpreter)) {
			return Promise.reject(new Error(
				`${request.language === "python" ? "Python" : "Rscript"} 解释器不可用：${interpreter || "未配置"}`,
			));
		}
		const stopPath = path.join(
			projectRoot,
			"tool-library",
			"output",
			"code-practice",
			"stop",
			`${request.run_id}.stop`,
		);
		const args = [
			runner,
			"--project-root",
			projectRoot,
			"--python",
			settings.pythonExecutable,
			"--rscript",
			settings.rscriptExecutable,
		];

		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const child = spawn(settings.pythonExecutable, args, {
				cwd: projectRoot,
				shell: false,
				windowsHide: true,
				env: {
					...process.env,
					PYTHONUTF8: "1",
					PYTHONIOENCODING: "utf-8",
				},
			});
			this.state.activePracticeRuns.set(request.run_id, { child, stopPath });
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 400000);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 400000);
			});
			child.once("error", (error: Error) => {
				if (settled) return;
				settled = true;
				this.state.activePracticeRuns.delete(request.run_id);
				reject(error);
			});
			child.once("close", () => {
				if (settled) return;
				settled = true;
				this.state.activePracticeRuns.delete(request.run_id);
				try {
					const result = JSON.parse(stdout.trim()) as CodePracticeResult;
					if (stderr.trim()) result.runner_stderr = stderr.trim();
					resolve(result);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					reject(new Error(
						`无法读取代码练习结果：${stderr.trim() || stdout.trim() || message}`,
					));
				}
			});
			child.stdin.end(JSON.stringify(request), "utf8");
		});
	}

	stopCodePractice(runId: string): boolean {
		const active = this.state.activePracticeRuns.get(runId);
		if (!active) return false;
		try {
			fs.mkdirSync(path.dirname(active.stopPath), { recursive: true });
			fs.writeFileSync(active.stopPath, "stop\n", "utf8");
			return true;
		} catch (error) {
			console.error("Could not request code-practice stop", error);
			return false;
		}
	}

	runVaultAction(options: VaultActionProcessOptions): Promise<DashboardProcessResult> {
		const { runId, action, input, executionConfig, settings, hooks = {} } = options;
		const projectRoot = settings.toolkitRoot;
		const runner = path.join(projectRoot, "tool-library", "scripts", "run_vault_action.py");
		if (!String(projectRoot || "").trim()) {
			return Promise.reject(new Error("未配置工具包目录，无法执行需要 Research Vault Toolkit 的操作"));
		}
		if (!fs.existsSync(runner)) {
			return Promise.reject(new Error(`统一 runner 不存在：${runner}`));
		}
		const timeoutSeconds = Math.max(
			10,
			Math.min(
				14400,
				Number(executionConfig.timeoutSeconds)
					|| Number(settings.taskTimeoutMinutes) * 60
					|| 3600,
			),
		);
		const stopPath = path.join(
			projectRoot,
			"tool-library",
			"output",
			"dashboard-runs",
			"stop",
			`${runId}.stop`,
		);
		fs.mkdirSync(path.dirname(stopPath), { recursive: true });
		if (fs.existsSync(stopPath)) fs.unlinkSync(stopPath);
		const backendId: CliBackendId = executionConfig.backend === "claude-code"
			? "claude-code"
			: executionConfig.backend === "opencode"
				? "opencode"
				: "codex-cli";
		const backendExecutable = backendId === "claude-code"
			? settings.claudeExecutable
			: backendId === "opencode"
				? settings.openCodeExecutable
				: settings.codexExecutable;
		const backendConfigSource = backendId === "claude-code"
			? settings.claudeConfigSource
			: backendId === "opencode"
				? settings.openCodeConfigSource
				: settings.codexConfigSource;
		const args = [
			runner,
			"--action",
			action.id,
			"--project-root",
			projectRoot,
			"--backend",
			backendId,
			"--backend-executable",
			backendExecutable,
			"--reasoning-effort",
			executionConfig.reasoningEffort || "default",
			"--service-tier",
			executionConfig.serviceTier,
			"--python",
			settings.pythonExecutable,
			"--timeout-seconds",
			String(timeoutSeconds),
			"--retrieval-mode",
			executionConfig.retrievalMode === "web" ? "web" : "vault",
			"--stop-file",
			stopPath,
			"--run-id",
			runId,
		];
		args.push(
			"--backend-config-source",
			backendConfigSource,
		);
		if (backendId !== "codex-cli") {
			if (executionConfig.model) {
				args.push("--backend-model", executionConfig.model);
			}
		} else {
			args.push("--model", executionConfig.model);
		}

		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let stderrBuffer = "";
			const events: DashboardProcessResult["events"] = [];
			let settled = false;
			let timedOut = false;
			let timer = 0;
			const child = spawn(settings.pythonExecutable, args, {
				cwd: projectRoot,
				shell: false,
				windowsHide: true,
				env: {
					...process.env,
					PYTHONUTF8: "1",
					PYTHONIOENCODING: "utf-8",
				},
			});
			this.state.activeProcesses.set(runId, child);
			this.state.activeProcessStops.set(runId, stopPath);
			const clearRunState = (): void => {
				this.state.activeProcesses.delete(runId);
				this.state.activeProcessStops.delete(runId);
				try {
					if (fs.existsSync(stopPath)) fs.unlinkSync(stopPath);
				} catch (error) {
					console.warn("Could not remove Dashboard stop signal", error);
				}
			};
			const consumeStderrLine = (line: string, keepNewline = true): void => {
				const normalized = line.replace(/\r$/, "");
				if (normalized.startsWith("DASHBOARD_EVENT ")) {
					try {
						const event = JSON.parse(
							normalized.slice("DASHBOARD_EVENT ".length),
						) as DashboardProcessResult["events"][number];
						events.push(event);
						hooks.onEvent?.(event);
					} catch (error) {
						console.warn("Could not parse Dashboard runner event", error);
					}
					return;
				}
				stderr = appendOutput(stderr, `${line}${keepNewline ? "\n" : ""}`, 160000);
				hooks.onStderr?.(line);
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 160000);
				hooks.onStdout?.(chunk.toString("utf8"));
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderrBuffer += chunk.toString("utf8");
				const lines = stderrBuffer.split("\n");
				stderrBuffer = lines.pop() || "";
				lines.forEach((line) => consumeStderrLine(line));
			});
			child.once("error", (error: Error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				clearRunState();
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				clearRunState();
				if (stderrBuffer) consumeStderrLine(stderrBuffer, false);
				resolve({
					exitCode: timedOut ? 124 : typeof code === "number" ? code : 1,
					signal: signal || "",
					stdout,
					stderr: timedOut
						? `${stderr}\n任务超过 ${timeoutSeconds} 秒，已请求终止。`
						: stderr,
					events,
				});
			});
			timer = window.setTimeout(() => {
				timedOut = true;
				this.requestVaultActionStop(runId);
				const cleanupGraceMs = action.writes ? 60000 : 10000;
				window.setTimeout(() => {
					if (this.state.activeProcesses.get(runId) === child && !child.killed) child.kill();
				}, cleanupGraceMs);
			}, (timeoutSeconds + 15) * 1000);
			child.stdin.end(input, "utf8");
		});
	}

	runJsonProcess(options: JsonProcessOptions): Promise<JsonProcessResult> {
		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer = 0;
			const child = spawn(options.executable, options.args, {
				cwd: options.cwd,
				shell: false,
				windowsHide: true,
				env: {
					...process.env,
					PYTHONUTF8: "1",
					PYTHONIOENCODING: "utf-8",
				},
			});
			this.state.activeProcesses.set(options.runId, child);
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				if (this.state.activeProcesses.get(options.runId) === child) {
					this.state.activeProcesses.delete(options.runId);
				}
				callback();
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 200000);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 40000);
			});
			child.once("error", (error: Error) => finish(() => reject(error)));
			child.once("close", (code) => {
				finish(() => {
					if (code !== 0) {
						reject(new Error(stderr.trim() || `进程退出码：${code}`));
						return;
					}
					resolve({ stdout, stderr });
				});
			});
			timer = window.setTimeout(() => {
				if (!child.killed) child.kill();
				finish(() => reject(new ProviderConnectionError("timeout", options.timeoutMessage)));
			}, options.timeoutMs);
			child.stdin.end();
		});
	}

	probeCodexCli(settings: DashboardSettings): Promise<ProviderConnectionTestResult> {
		const startedAt = Date.now();
		const executable = String(settings.codexExecutable || "");
		const displayModel = settings.codexConfigSource === "cc-switch"
			? "CC Switch 当前模型"
			: settings.codexModel || "Codex 官方默认模型";
		if (!executable || !fs.existsSync(executable)) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				model: displayModel,
				message: `Codex 可执行文件不存在：${executable || "未配置"}`,
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer = 0;
			const invocation = prepareCliSpawn(executable, ["--version"]);
			const child = spawn(invocation.executable, invocation.args, {
				cwd: resolveCliProcessCwd(settings.toolkitRoot),
				shell: false,
				windowsHide: true,
			});
			const finish = (
				result: Omit<ProviderConnectionTestResult, "model" | "responseTimeMs" | "testedAt">,
			): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve({
					model: displayModel,
					responseTimeMs: Date.now() - startedAt,
					testedAt: new Date().toISOString(),
					...result,
				});
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 4000);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 4000);
			});
			child.once("error", (error: Error) => {
				finish({ ok: false, type: "local-service-offline", message: error.message });
			});
			child.once("close", (code) => {
				if (code === 0) {
					finish({
						ok: true,
						type: "success",
						endpoint: settings.codexConfigSource === "cc-switch"
							? "Codex CLI · CC Switch"
							: "Codex CLI · 官方 OpenAI",
						modelExists: null,
						modelCount: MODEL_OPTIONS.length,
						streaming: { supported: false, verified: false },
						pdf: { supported: true, verified: false },
						vision: { supported: true, verified: false },
						responsePreview: stdout.trim() || "Codex CLI 可用",
					});
					return;
				}
				finish({
					ok: false,
					type: "local-service-offline",
					message: stderr.trim() || stdout.trim() || `Codex CLI 退出码 ${code}`,
				});
			});
			timer = window.setTimeout(() => {
				if (!child.killed) child.kill();
				finish({ ok: false, type: "timeout", message: "Codex CLI 版本检查超过 10 秒" });
			}, 10000);
		});
	}

	probeMineruCli(settings: DashboardSettings): Promise<ProviderConnectionTestResult> {
		const startedAt = Date.now();
		const executable = String(settings.mineruExecutable || "");
		const endpoint = settings.mineruServiceMode === "private"
			? settings.mineruBaseUrl || "私有服务地址未配置"
			: "MinerU 官方服务";
		if (settings.mineruServiceMode === "private" && !settings.mineruBaseUrl) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				endpoint,
				model: settings.mineruDefaultModel,
				message: "已选择私有部署，但尚未填写 MinerU 私有服务地址。",
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		if (!executable || !fs.existsSync(executable)) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				endpoint,
				model: settings.mineruDefaultModel,
				message: `MinerU 可执行文件不存在：${executable || "未配置"}`,
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer = 0;
			const invocation = prepareCliSpawn(executable, ["version"]);
			const child = spawn(invocation.executable, invocation.args, {
				cwd: resolveCliProcessCwd(settings.toolkitRoot),
				shell: false,
				windowsHide: true,
			});
			const finish = (ok: boolean, type: string, message: string): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve({
					ok,
					type,
					endpoint,
					model: settings.mineruDefaultModel,
					message,
					responsePreview: ok ? stdout.trim().split(/\r?\n/)[0] || "MinerU CLI 可用" : "",
					responseTimeMs: Date.now() - startedAt,
					testedAt: new Date().toISOString(),
				});
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 4000);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 4000);
			});
			child.once("error", (error: Error) => finish(false, "local-service-offline", error.message));
			child.once("close", (code) => {
				if (code === 0) {
					finish(true, "success", "MinerU CLI 可用；远程认证将在实际提取时验证。");
					return;
				}
				finish(false, "local-service-offline", stderr.trim() || stdout.trim() || `MinerU CLI 退出码 ${code}`);
			});
			// npm's PowerShell shim pipes stdin to its Node child and will wait
			// forever unless the parent closes the pipe. The probe has no input.
			child.stdin.end();
			timer = window.setTimeout(() => {
				if (!child.killed) child.kill();
				finish(false, "timeout", "MinerU CLI 版本检查超过 10 秒");
			}, 10000);
		});
	}

	probeClaudeCode(settings: DashboardSettings): Promise<ProviderConnectionTestResult> {
		const startedAt = Date.now();
		const executable = String(settings.claudeExecutable || "");
		if (!executable || !fs.existsSync(executable)) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				provider: "claude-code",
				model: settings.claudeModel || (
					settings.claudeConfigSource === "cc-switch"
						? "CC Switch 当前模型"
						: "Claude CLI 默认模型"
				),
				message: `Claude Code 可执行文件不存在：${executable || "未配置"}`,
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer = 0;
			let detectedModel = "";
			let responsePreview = "";
			const args = [
				"-p",
				"--safe-mode",
				"--permission-mode",
				"dontAsk",
				"--tools=",
				"--output-format",
				"stream-json",
				"--verbose",
				"--no-session-persistence",
				"--setting-sources",
				settings.claudeConfigSource === "cc-switch"
					? "user,project,local"
					: "project,local",
			];
			if (settings.claudeModel.trim()) {
				args.push("--model", settings.claudeModel.trim());
			}
			args.push("仅回复：CLAUDE_BACKEND_OK");
			const invocation = prepareCliSpawn(executable, args);
			const child = spawn(invocation.executable, invocation.args, {
				cwd: resolveCliProcessCwd(settings.toolkitRoot),
				shell: false,
				windowsHide: true,
				env: createClaudeProcessEnv(settings),
			});
			const finish = (
				result: Omit<ProviderConnectionTestResult, "model" | "responseTimeMs" | "testedAt">,
			): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve({
					model: detectedModel || settings.claudeModel || (
						settings.claudeConfigSource === "cc-switch"
							? "CC Switch 当前模型"
							: "Claude CLI 默认模型"
					),
					responseTimeMs: Date.now() - startedAt,
					testedAt: new Date().toISOString(),
					...result,
				});
			};
			const inspectLine = (line: string): void => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					if (event.type === "system" && event.subtype === "init") {
						detectedModel = String(event.model || "");
					}
					if (event.type === "result") {
						responsePreview = String(event.result || "").trim().slice(0, 160);
					}
				} catch {
					// Preserve non-JSON diagnostics for the final error.
				}
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 20000);
				String(chunk).split(/\r?\n/).forEach(inspectLine);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 8000);
			});
			child.once("error", (error: Error) => {
				finish({
					ok: false,
					type: "local-service-offline",
					provider: "claude-code",
					message: error.message,
				});
			});
			child.once("close", (code) => {
				stdout.split(/\r?\n/).forEach(inspectLine);
				if (code === 0 && detectedModel) {
					finish({
						ok: true,
						type: "success",
						provider: "claude-code",
						endpoint: settings.claudeConfigSource === "cc-switch"
							? "Claude Code · CC Switch"
							: "Claude Code · 官方配置",
						modelExists: null,
						streaming: { supported: true, verified: true },
						pdf: { supported: false, verified: false },
						vision: {
							supported: true,
							verified: false,
							note: "Claude Code Read 工具支持图片；当前模型的视觉兼容性将在首次图片查询时验证",
						},
						webSearch: {
							supported: true,
							verified: false,
							note: "仅在查询侧边栏的“联网搜索”模式开放 WebSearch/WebFetch；实际可用性取决于当前模型与账号",
						},
						responsePreview: responsePreview || "Claude Code 可用",
					});
					return;
				}
				finish({
					ok: false,
					type: "local-service-offline",
					provider: "claude-code",
					message: stderr.trim() || stdout.trim() || `Claude Code 退出码 ${code}`,
				});
			});
			timer = window.setTimeout(() => {
				if (!child.killed) child.kill();
				finish({
					ok: false,
					type: "timeout",
					provider: "claude-code",
					message: `${getCliBackendLabel("claude-code")} 连接测试超过 45 秒`,
				});
			}, 45000);
		});
	}

	probeOpenCode(settings: DashboardSettings): Promise<ProviderConnectionTestResult> {
		const startedAt = Date.now();
		const executable = String(settings.openCodeExecutable || "");
		const pythonExecutable = String(settings.pythonExecutable || "").trim();
		const runner = path.join(
			settings.toolkitRoot,
			"tool-library",
			"scripts",
			"run_vault_action.py",
		);
		const configuredModel = settings.openCodeModel.trim();
		const displayModel = configuredModel || (
			settings.openCodeConfigSource === "cc-switch"
				? "CC Switch 当前模型"
				: "OpenCode Zen 默认模型"
		);
		if (!pythonExecutable) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				provider: "opencode",
				model: displayModel,
				message: "未配置 Python 可执行文件",
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		if (!fs.existsSync(pythonExecutable)) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				provider: "opencode",
				model: displayModel,
				message: `Python 可执行文件不存在：${pythonExecutable}`,
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		if (!fs.existsSync(runner)) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				provider: "opencode",
				model: displayModel,
				message: `统一 runner 不存在：${runner}`,
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		if (!executable || !fs.existsSync(executable)) {
			return Promise.resolve({
				ok: false,
				type: "configuration",
				provider: "opencode",
				model: displayModel,
				message: `OpenCode 可执行文件不存在：${executable || "未配置"}`,
				responseTimeMs: Date.now() - startedAt,
				testedAt: new Date().toISOString(),
			});
		}
		const runnerTimeoutSeconds = Math.max(
			60,
			Math.min(180, Number(settings.providerTimeoutSeconds || 20) * 3),
		);
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timer = 0;
			const args = [
				runner,
				"--probe-backend",
				"opencode",
				"--project-root",
				settings.toolkitRoot,
				"--backend-executable",
				executable,
				"--backend-config-source",
				settings.openCodeConfigSource,
				"--reasoning-effort",
				settings.openCodeReasoningEffort,
				"--service-tier",
				"default",
				"--timeout-seconds",
				String(runnerTimeoutSeconds),
			];
			if (configuredModel) args.push("--backend-model", configuredModel);
			const child = spawn(pythonExecutable, args, {
				cwd: settings.toolkitRoot,
				shell: false,
				windowsHide: true,
				env: {
					...process.env,
					PYTHONUTF8: "1",
					PYTHONIOENCODING: "utf-8",
				},
			});
			const finish = (
				result: Omit<ProviderConnectionTestResult, "model" | "responseTimeMs" | "testedAt">,
				model = displayModel,
				responseTimeMs = Date.now() - startedAt,
			): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				resolve({
					model,
					responseTimeMs,
					testedAt: new Date().toISOString(),
					...result,
				});
			};
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendOutput(stdout, chunk, 30000);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendOutput(stderr, chunk, 10000);
			});
			child.once("error", (error: Error) => {
				finish({
					ok: false,
					type: "local-service-offline",
					provider: "opencode",
					message: error.message,
				});
			});
			child.once("close", (code) => {
				let payload: Record<string, unknown> = {};
				try {
					payload = asRecord(JSON.parse(stdout.trim()));
				} catch {
					// A non-JSON runner response is classified below.
				}
				const payloadModel = String(payload.model || "").trim() || displayModel;
				const payloadResponseTime = Number(payload.response_time_ms);
				const responseTimeMs = Number.isFinite(payloadResponseTime)
					? payloadResponseTime
					: Date.now() - startedAt;
				if (code === 0 && payload.ok === true) {
					finish({
						ok: true,
						type: "success",
						provider: "opencode",
						endpoint: settings.openCodeConfigSource === "cc-switch"
							? "OpenCode · CC Switch"
							: "OpenCode · 官方 Zen",
						modelExists: null,
						streaming: { supported: true, verified: true },
						pdf: { supported: false, verified: false },
						vision: {
							supported: false,
							verified: false,
							note: "首版未向 OpenCode runner 开放 Vault 图片附件",
						},
						webSearch: {
							supported: true,
							verified: false,
							note: "仅在查询侧边栏的“联网搜索”模式开放 websearch/webfetch",
						},
						responsePreview: String(payload.response_preview || "").trim(),
					}, payloadModel, responseTimeMs);
					return;
				}
				finish({
					ok: false,
					type: String(payload.type || (code === 0 ? "protocol" : "runner-failure")),
					provider: "opencode",
					message: String(
						payload.message
						|| stderr.trim()
						|| stdout.trim()
						|| `统一 runner 退出码 ${code}`,
					),
				}, payloadModel, responseTimeMs);
			});
			timer = window.setTimeout(() => {
				if (!child.killed) child.kill();
				finish({
					ok: false,
					type: "runner-failure",
					provider: "opencode",
					message: `统一 runner 未在 ${runnerTimeoutSeconds + 15} 秒内退出`,
				});
			}, (runnerTimeoutSeconds + 15) * 1000);
		});
	}

	stopVaultAction(runId: string): boolean {
		const child = this.state.activeProcesses.get(runId);
		if (!child || child.killed) return false;
		return this.requestVaultActionStop(runId);
	}

	requestVaultActionStop(runId: string): boolean {
		const child = this.state.activeProcesses.get(runId);
		const stopPath = this.state.activeProcessStops.get(runId);
		if (!child || child.killed || !stopPath) return false;
		try {
			fs.mkdirSync(path.dirname(stopPath), { recursive: true });
			fs.writeFileSync(stopPath, "stop\n", "utf8");
			return true;
		} catch (error) {
			console.error("Could not request Dashboard action stop", error);
			return false;
		}
	}

	isVaultActionProcessActive(runId: string): boolean {
		const child = this.state.activeProcesses.get(runId);
		return Boolean(child && !child.killed);
	}

	shutdown(): void {
		for (const runId of this.state.activePracticeRuns.keys()) {
			this.stopCodePractice(runId);
		}
		for (const [runId, child] of this.state.activeProcesses) {
			const stopRequested = this.requestVaultActionStop(runId);
			if (!stopRequested && !child.killed) child.kill();
		}
		for (const token of this.state.directQueryRuns.values()) {
			token.cancelled = true;
			token.abort?.();
		}
		this.state.clearTransientState();
	}
}
