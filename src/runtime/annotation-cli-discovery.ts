import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTextCliCommand } from "./cli-text";
import { codeBuddyTextAdapter } from "./codebuddy-text";
import { qoderTextAdapter } from "./qoder-text";
import { openCodeTextAdapter, openCodeIsolatedEnvironment } from "./opencode-text";
import { runMineruProcessCommand, type MineruProcessRequest, type MineruProcessResult } from "./mineru-process";

export type AnnotationCliBackend = "codebuddy" | "qoderclicn" | "opencode";
export interface AnnotationCliModel { id: string; label: string }
export interface QuotaBucket { label: string; remaining: number; unit: string }
export interface AnnotationCliQuota { status: "known" | "unknown"; buckets: QuotaBucket[]; message: string }
export interface AnnotationCliDiscovery {
	status: "loading" | "ready" | "error";
	models: AnnotationCliModel[];
	source: string;
	checkedAt?: number;
	message: string;
	quota?: AnnotationCliQuota;
}

const adapters = { codebuddy: codeBuddyTextAdapter, qoderclicn: qoderTextAdapter, opencode: openCodeTextAdapter };
const sources = { codebuddy: "CodeBuddy 初始化接口", qoderclicn: "qoderclicn --list-models", opencode: "opencode models --refresh" };
const unknownQuota = (message: string): AnnotationCliQuota => ({ status: "unknown", buckets: [], message });
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(value);
const clean = (value: string): string => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function uniqueModels(models: AnnotationCliModel[]): AnnotationCliModel[] {
	const unique = new Map(models.filter(model => validId(model.id)).map(model => [model.id, model]));
	if (!unique.size || unique.size > 2000) throw new Error("模型列表为空或格式不受支持");
	return [...unique.values()];
}

/** Only matching, successful control replies count; user/assistant/result events never do. */
export function controlResponse(stdout: string, requestId: string): Record<string, unknown> {
	const matches: Record<string, unknown>[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		try {
			const event = record(JSON.parse(line));
			const response = record(event?.response);
			if (event?.type === "control_response" && response?.request_id === requestId) {
				if (response.subtype !== "success") throw new Error("CLI 不支持该查询接口");
				const data = record(response.response);
				if (!data) throw new Error("CLI 查询接口未返回有效数据");
				matches.push(data);
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
	}
	if (matches.length !== 1) throw new Error("CLI 未返回唯一查询结果");
	return matches[0];
}

export function parseAnnotationCliModels(backend: AnnotationCliBackend, stdout: string): AnnotationCliModel[] {
	if (stdout.length > 2_000_000) throw new Error("模型列表超过读取上限");
	if (backend === "codebuddy") {
		const models = controlResponse(stdout, "catalog-init").models;
		if (!Array.isArray(models)) throw new Error("CLI 未返回模型列表");
		return uniqueModels(models.flatMap(value => {
			const model = record(value);
			return model && validId(model.id) ? [{ id: model.id, label: typeof model.name === "string" ? clean(model.name).slice(0, 200) : model.id }] : [];
		}));
	}
	const models: AnnotationCliModel[] = [];
	let modelHeader = false;
	for (const raw of clean(stdout).split(/\r?\n/)) {
		const line = raw.trim();
		if (backend === "opencode") {
			if (/^[^/\s]+\/[^/\s]+$/.test(line)) models.push({ id: line, label: line });
		} else {
			if (line === "MODEL") { modelHeader = true; continue; }
			if (!modelHeader || !line || /^Auto$/i.test(line)) continue;
			// Qoder's custom/BYOK entries must use the modelID, never their display name.
			const custom = /^(.+?)\s+\(([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\)$/i.exec(line);
			if (custom) models.push({ id: custom[2], label: `${custom[1]} · 自定义（${custom[2]}）` });
			else if (validId(line) && /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(line)) models.push({ id: line, label: line });
			else throw new Error("模型列表格式不受支持");
		}
	}
	return uniqueModels(models);
}

export function parseQoderQuota(stdout: string): AnnotationCliQuota {
	const data = controlResponse(stdout, "catalog-quota"), usage = record(data.usage);
	if (!usage) return unknownQuota("CLI 未返回账号额度");
	const buckets: QuotaBucket[] = [];
	for (const [key, label] of [["userQuota", "套餐"], ["addOnQuota", "附加额度"], ["orgResourcePackage", "组织共享额度"]]) {
		const bucket = record(usage[key]);
		if (key === "orgResourcePackage" && bucket?.available !== true) continue;
		if (typeof bucket?.remaining === "number" && Number.isFinite(bucket.remaining) && bucket.remaining >= 0 && typeof bucket.unit === "string" && /^[a-zA-Z]{1,24}$/.test(bucket.unit)) {
			buckets.push({ label, remaining: bucket.remaining, unit: bucket.unit.toLowerCase() === "credits" ? "Credits" : bucket.unit });
		}
	}
	return buckets.length ? { status: "known", buckets, message: "账号额度快照；各项分别显示，不推算免费模型调用次数。" } : unknownQuota("CLI 未返回有效的账号剩余额度");
}

export function annotationCliControlInput(quota = false): string {
	return [
		{ type: "control_request", request_id: "catalog-init", request: { subtype: "initialize", hasPrompt: false } },
		...(quota ? [{ type: "control_request", request_id: "catalog-quota", request: { subtype: "get_usage_info" } }] : []),
	].map(value => JSON.stringify(value)).join("\n") + "\n";
}

/** Manual, memory-only queries. No model prompt, Vault cwd, credential reads or SDK install. */
export class AnnotationCliDiscoveryService {
	private readonly entries = new Map<string, AnnotationCliDiscovery>();
	private readonly pending = new Map<string, Promise<AnnotationCliDiscovery>>();
	private readonly active = new Set<AbortController>();
	private closing = false;
	constructor(private readonly runProcess: (request: MineruProcessRequest) => Promise<MineruProcessResult> = runMineruProcessCommand) {}
	get(backend: AnnotationCliBackend, executable: string): AnnotationCliDiscovery | null { return this.entries.get(`${backend}\0${executable}`) || null; }

	refresh(backend: AnnotationCliBackend, executable: string): Promise<AnnotationCliDiscovery> {
		const key = `${backend}\0${executable}`;
		const existing = this.pending.get(key);
		if (existing) return existing;
		if (this.closing) return Promise.reject(new Error("CLI 查询已停止"));
		const state: AnnotationCliDiscovery = { status: "loading", models: [], source: sources[backend], message: "查询中…", ...(backend === "qoderclicn" ? { quota: unknownQuota("查询中…") } : {}) };
		this.entries.set(key, state);
		const controller = new AbortController(); this.active.add(controller);
		const query = async (args: string[], input: string | null, env?: NodeJS.ProcessEnv | ((cwd: string) => NodeJS.ProcessEnv)): Promise<string> => {
			const command = resolveTextCliCommand(executable, adapters[backend]);
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "research-reader-cli-catalog-"));
			const result = await this.runProcess({ command: command.command, baseArgs: command.baseArgs, cliArgs: args, cwd, input, signal: controller.signal, timeoutMs: 45000, env: typeof env === "function" ? env(cwd) : env });
			if (controller.signal.aborted) throw new Error("CLI 查询已停止");
			if (result.exitCode === 124) throw new Error("CLI 查询超时；请稍后手动刷新");
			if (result.exitCode !== 0) throw new Error(`CLI 查询失败（退出码 ${result.exitCode}），请检查程序路径与登录状态`);
			return result.stdout;
		};
		const controlArgs = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--tools", "", "--permission-mode", backend === "codebuddy" ? "dontAsk" : "dont_ask", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--setting-sources", "user", "--settings", '{"disableAllHooks":true,"autoUpdates":false,"permissions":{"deny":["*"]}}'];
		if (backend === "codebuddy") controlArgs.push("--verbose");
		let modelStatus: "ready" | "error" = "error";
		const modelQuery = (async () => {
			try {
				const stdout = backend === "codebuddy"
					? await query(controlArgs, annotationCliControlInput(), { DISABLE_AUTOUPDATER: "1", CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1" })
					: backend === "qoderclicn" ? await query(["--list-models"], null)
						: await query(["models", "--pure", "--refresh"], null, () => openCodeIsolatedEnvironment());
				state.models = parseAnnotationCliModels(backend, stdout); modelStatus = "ready"; state.message = `已获取 ${state.models.length} 个固定模型候选`;
			} catch (error) { state.models = []; modelStatus = "error"; state.message = this.queryError(error); }
		})();
		const quotaQuery = backend === "qoderclicn" ? (async () => {
			try { state.quota = parseQoderQuota(await query(controlArgs, annotationCliControlInput(true))); }
			catch (error) { state.quota = unknownQuota(this.queryError(error)); }
		})() : Promise.resolve();
		const pending = Promise.all([modelQuery, quotaQuery]).then(() => { state.status = modelStatus; state.checkedAt = Date.now(); return state; }).finally(() => { this.active.delete(controller); this.pending.delete(key); });
		this.pending.set(key, pending);
		return pending;
	}
	private queryError(error: unknown): string {
		// Never display raw CLI output, account identities or credential errors.
		const message = error instanceof Error ? error.message : "";
		return /^(CLI (?:查询|未返回|不支持)|模型列表)/.test(message) ? message : "CLI 查询不可用，请检查程序路径与登录状态";
	}
	async dispose(): Promise<void> {
		this.closing = true; for (const controller of this.active) controller.abort();
		await Promise.allSettled([...this.pending.values()]); this.entries.clear();
	}
}
