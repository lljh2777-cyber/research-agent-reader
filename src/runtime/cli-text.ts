import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveNodeExecutable } from "./node-executable";
import { runMineruProcessCommand, type MineruProcessRequest, type MineruProcessResult } from "./mineru-process";

export interface CliTextResult {
	text: string;
	requestedModel: string;
	reportedModel?: string;
	usage?: Record<string, unknown>;
	costUsd?: number;
}

export interface CliTextAdapter {
	label: string;
	npmPackage?: string;
	binName?: string;
	invocation(model: string, system: string): { args: string[]; env?: NodeJS.ProcessEnv };
	parse(stdout: string, requestedModel: string): CliTextResult;
}

export interface CliTextRequest {
	executable: string;
	model: string;
	system: string;
	user: string;
	timeoutMs: number;
}

/** Resolve known npm shims to their declared Node entry without invoking a shell. */
export function resolveTextCliCommand(executable: string, adapter: CliTextAdapter): { command: string; baseArgs: string[] } {
	if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) throw new Error(`${adapter.label} 路径必须是存在的绝对文件路径`);
	if (!/\.(cmd|bat|ps1)$/i.test(executable)) return { command: executable, baseArgs: [] };
	if (!adapter.npmPackage || !adapter.binName) throw new Error(`${adapter.label} 启动器不受支持，请指定原生程序`);
	const shim = fs.readFileSync(executable, "utf8").replace(/\\/g, "/");
	if (!shim.includes(`node_modules/${adapter.npmPackage}/`)) throw new Error(`${adapter.label} 启动器与 npm 包不匹配`);
	const root = fs.realpathSync(path.join(path.dirname(executable), "node_modules", adapter.npmPackage));
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string; bin?: Record<string, string> | string };
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[adapter.binName];
	if (pkg.name !== adapter.npmPackage || typeof bin !== "string") throw new Error(`${adapter.label} npm 入口未确认`);
	const entry = fs.realpathSync(path.resolve(root, bin));
	const relative = path.relative(root, entry);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) throw new Error(`${adapter.label} npm 入口超出包目录`);
	return { command: resolveNodeExecutable(), baseArgs: [entry] };
}

/** Each request owns a fresh conversation; disposal waits for process-tree closure. */
export class CliTextService {
	private readonly active = new Map<AbortController, Promise<unknown>>();
	private closing = false;
	private cwd = "";
	constructor(private readonly runProcess: (request: MineruProcessRequest) => Promise<MineruProcessResult> = runMineruProcessCommand) {}

	generate(request: CliTextRequest, adapter: CliTextAdapter, registerCancel: (cancel: () => void) => void): Promise<CliTextResult> {
		const controller = new AbortController();
		registerCancel(() => controller.abort());
		const pending = (async () => {
			if (this.closing || controller.signal.aborted) throw new Error("批注解释已取消");
			const model = request.model.trim();
			if (!model || model.length > 200 || /[\r\n\0]/.test(model)) throw new Error("请选择准确的 CLI 模型 ID");
			if (!request.user.trim() || request.user.length > 100000 || request.system.length > 20000) throw new Error("批注输入为空或超过上限");
			const command = resolveTextCliCommand(request.executable, adapter);
			const invocation = adapter.invocation(model, request.system);
			// A unique empty directory prevents loading Vault/project instructions.
			this.cwd ||= fs.mkdtempSync(path.join(os.tmpdir(), "research-reader-cli-"));
			const result = await this.runProcess({
				command: command.command, baseArgs: command.baseArgs, cliArgs: invocation.args,
				cwd: this.cwd, signal: controller.signal,
				input: request.user, env: invocation.env,
				timeoutMs: Math.max(1000, Math.min(300000, request.timeoutMs || 120000)),
			});
			if (controller.signal.aborted || this.closing || result.exitCode === 130) throw new Error("批注解释已取消");
			if (result.exitCode === 124) throw new Error("CLI 批注解释超时；已停止进程");
			if (result.exitCode !== 0) throw new Error(`${adapter.label} 调用失败：${(result.stderr || result.stdout).trim().slice(0, 1000) || `退出码 ${result.exitCode}`}`);
			const parsed = adapter.parse(result.stdout, model);
			if (!parsed.text.trim()) throw new Error("模型返回了空解释");
			return parsed;
		})();
		this.active.set(controller, pending);
		void pending.finally(() => this.active.delete(controller)).catch(() => {});
		return pending;
	}

	async dispose(): Promise<void> {
		this.closing = true;
		for (const controller of this.active.keys()) controller.abort();
		await Promise.allSettled([...this.active.values()]);
	}
}
