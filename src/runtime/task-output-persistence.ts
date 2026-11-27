import * as fs from "node:fs";
import * as path from "node:path";

import type { TaskRun, TaskRunArtifacts } from "../types/contracts";
import { normalizeIngestProgress, type IngestProgress } from "../agent/ingest-progress";
import { isPathInside, writeContainedTextFile } from "./contained-text-file";
import { QUERY_OUTPUT_MAX_CHARS } from "./query-output-limit";
import { readTrustedVaultFile } from "./trusted-vault-fs";

const TASK_OUTPUT_DIRECTORY = "task-output";
const QUERY_ANSWERS_DIRECTORY = "query-answers";
const QUERY_SESSION_ID = /^query-[a-z0-9-]{1,64}$/;
const QUERY_MESSAGE_ID = /^message-[a-z0-9-]{1,64}$/;
const PLUGIN_OUTPUT_DIRECTORY_SEGMENTS = [TASK_OUTPUT_DIRECTORY, "dashboard-runs"];
const LEGACY_TOOLKIT_OUTPUT_DIRECTORY_SEGMENTS = ["tool-library", "output", "dashboard-runs"];
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 12 * 1024 * 1024;
const MAX_ERROR_CHARS = 128 * 1024;
const MAX_SUMMARY_CHARS = 64 * 1024;

export interface TaskRunOutputLocation {
	rootPath: string;
	relativePath: string;
	absolutePath: string;
	directoryPath: string;
}

export interface TaskRunCompletionRecord {
	relativePath: string;
	runId: string;
	actionId: string;
	status: "done" | "failed" | "interrupted";
	exitCode: number | null;
	startedAt: string;
	finishedAt: string;
	output: string;
	error: string;
	summary: string;
	artifacts?: TaskRunArtifacts;
	ingestProgress?: IngestProgress;
}

export interface TaskRunStorageCleanupResult {
	temporaryRemoved: number;
	failures: string[];
}

function realPathSync(targetPath: string): string {
	return fs.realpathSync.native
		? fs.realpathSync.native(targetPath)
		: fs.realpathSync(targetPath);
}

function resolveExistingDirectory(rawPath: string): string | null {
	const candidate = String(rawPath || "").trim();
	if (!candidate || !path.isAbsolute(candidate)) return null;
	try {
		const directStats = fs.lstatSync(candidate);
		if (!directStats.isDirectory() && !directStats.isSymbolicLink()) return null;
		const resolved = realPathSync(candidate);
		if (!fs.statSync(resolved).isDirectory()) return null;
		return resolved;
	} catch {
		return null;
	}
}

function normalizeRunId(runId: string): string | null {
	const rawRunId = String(runId || "");
	const normalizedRunId = rawRunId.trim();
	if (rawRunId !== normalizedRunId) return null;
	return SAFE_RUN_ID.test(normalizedRunId) ? normalizedRunId : null;
}

function buildLocation(
	rootPath: string,
	directorySegments: string[],
	runId: string,
): TaskRunOutputLocation | null {
	const normalizedRunId = normalizeRunId(runId);
	if (!normalizedRunId) return null;
	const filename = `${normalizedRunId}.json`;
	const relativePath = [...directorySegments, filename].join("/");
	const directoryPath = path.resolve(rootPath, ...directorySegments);
	const absolutePath = path.resolve(directoryPath, filename);
	if (!isPathInside(rootPath, directoryPath) || !isPathInside(rootPath, absolutePath)) return null;
	return { rootPath, relativePath, absolutePath, directoryPath };
}

function resolveTaskRunOutputLocation(
	pluginDirectory: string,
	runId: string,
): TaskRunOutputLocation | null {
	const rootPath = resolveExistingDirectory(pluginDirectory);
	return rootPath
		? buildLocation(rootPath, PLUGIN_OUTPUT_DIRECTORY_SEGMENTS, runId)
		: null;
}

function resolveLegacyToolkitLocation(
	toolkitRoot: string,
	runId: string,
): TaskRunOutputLocation | null {
	const rootPath = resolveExistingDirectory(toolkitRoot);
	return rootPath
		? buildLocation(rootPath, LEGACY_TOOLKIT_OUTPUT_DIRECTORY_SEGMENTS, runId)
		: null;
}

/** Writes the full task output into plugin-owned storage using an atomic rename. */
export async function writeTaskRunOutput(
	pluginDirectory: string,
	run: TaskRun,
): Promise<string> {
	const output = String(run?.output || "");
	const root = await resolvePluginDirectory(pluginDirectory);
	const location = buildLocation(root, PLUGIN_OUTPUT_DIRECTORY_SEGMENTS, run.id);
	if (!location) throw new Error("无效的任务输出 run ID");
	await writeContainedTextFile(location.rootPath, location.absolutePath, () => {
		const payload = JSON.stringify({
			schema_version: 2,
			run_id: run.id,
			action_id: run.actionId,
			status: run.status,
			exit_code: run.exitCode,
			started_at: run.startedAt,
			finished_at: run.finishedAt,
			output,
			error: run.error,
			summary: run.summary,
			artifacts: run.artifacts,
			ingestProgress: run.ingestProgress,
		}, null, 2);
		if (Buffer.byteLength(payload, "utf8") > MAX_SIDECAR_BYTES) {
			throw new Error("任务输出 sidecar 超过 16 MiB 安全上限");
		}
		return payload;
	});
	return location.relativePath;
}

async function resolvePluginDirectory(pluginDirectory: string): Promise<string> {
	if (!path.isAbsolute(pluginDirectory)) throw new Error("插件目录必须是绝对路径");
	let directory: string;
	try {
		directory = await fs.promises.realpath(pluginDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("插件目录不存在或链接目标不存在");
		throw error;
	}
	if (!(await fs.promises.stat(directory)).isDirectory()) throw new Error("插件目录不是文件夹");
	return directory;
}

export async function writeQueryAnswerFile(pluginDirectory: string, sessionId: string, messageId: string, text: string): Promise<void> {
	if (!QUERY_SESSION_ID.test(sessionId)) throw new Error("无效的查询会话 ID");
	if (!QUERY_MESSAGE_ID.test(messageId)) throw new Error("无效的查询消息 ID");
	const root = await resolvePluginDirectory(pluginDirectory);
	const targetPath = path.join(root, TASK_OUTPUT_DIRECTORY, QUERY_ANSWERS_DIRECTORY, sessionId, `${messageId}.md`);
	await writeContainedTextFile(root, targetPath, () => text.slice(0, QUERY_OUTPUT_MAX_CHARS));
}

async function queryAnswerStat(file: string): Promise<fs.Stats | undefined> {
	try {
		return await fs.promises.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function queryAnswerDirectory(root: string, sessionId?: string): Promise<string | null> {
	const segments = [TASK_OUTPUT_DIRECTORY, QUERY_ANSWERS_DIRECTORY];
	if (sessionId !== undefined) {
		if (!QUERY_SESSION_ID.test(sessionId)) throw new Error("无效的查询会话 ID");
		segments.push(sessionId);
	}
	let directory = root;
	for (const segment of segments) {
		directory = path.join(directory, segment);
		if (!isPathInside(root, directory)) throw new Error("查询回答目录超出插件存储目录");
		const stats = await queryAnswerStat(directory);
		if (!stats) return null;
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			if (segment === sessionId) return null;
			throw new Error("查询回答目录不是可信普通目录");
		}
	}
	return directory;
}

export async function readQueryAnswerFile(pluginDirectory: string, sessionId: string, messageId: string): Promise<string | null> {
	if (!QUERY_SESSION_ID.test(sessionId)) throw new Error("无效的查询会话 ID");
	if (!QUERY_MESSAGE_ID.test(messageId)) throw new Error("无效的查询消息 ID");
	const root = await resolvePluginDirectory(pluginDirectory);
	const base = await queryAnswerDirectory(root);
	if (!base) return null;
	const relativePath = path.relative(root, path.join(base, sessionId, messageId + ".md"));
	try {
		const bytes = await readTrustedVaultFile({}, relativePath, QUERY_OUTPUT_MAX_CHARS * 4, root);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function listQueryAnswerFiles(
	pluginDirectory: string,
	selectedSessions?: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
	const root = await resolvePluginDirectory(pluginDirectory);
	const files = new Map<string, string[]>();
	const base = await queryAnswerDirectory(root);
	if (!base) return files;
	for (const sessionId of await fs.promises.readdir(base)) {
		if (!QUERY_SESSION_ID.test(sessionId) || (selectedSessions && !selectedSessions.has(sessionId))) continue;
		const directory = await queryAnswerDirectory(root, sessionId);
		if (!directory) continue;
		const ids: string[] = [];
		for (const name of await fs.promises.readdir(directory)) {
			if (!name.endsWith(".md")) continue;
			const id = name.slice(0, -3);
			if (!QUERY_MESSAGE_ID.test(id)) continue;
			const stats = await queryAnswerStat(path.join(directory, name));
			if (stats?.isFile()) ids.push(id);
		}
		files.set(sessionId, ids);
	}
	return files;
}

async function queryRemovalPath(root: string, candidate: string): Promise<string> {
	const resolved = await fs.promises.realpath(candidate);
	if (!isPathInside(root, resolved) || path.relative(candidate, resolved) !== "") {
		throw new Error("查询回答清理目标已不在原目录位置");
	}
	return resolved;
}

export async function deleteQueryAnswerFiles(
	pluginDirectory: string, sessionId: string, messageIds: readonly string[], removeEmptyDirectory: boolean,
): Promise<void> {
	const root = await resolvePluginDirectory(pluginDirectory);
	for (const id of messageIds) {
		if (!QUERY_MESSAGE_ID.test(id)) throw new Error("无效的查询消息 ID");
		// Recheck the directory chain after enumeration, immediately before each removal.
		const directory = await queryAnswerDirectory(root, sessionId);
		if (!directory) return;
		const file = path.join(directory, id + ".md");
		const stats = await queryAnswerStat(file);
		if (stats?.isFile()) await fs.promises.unlink(await queryRemovalPath(root, file));
	}
	if (!removeEmptyDirectory) return;
	const directory = await queryAnswerDirectory(root, sessionId);
	if (!directory || (await fs.promises.readdir(directory)).length) return;
	try {
		await fs.promises.rmdir(await queryRemovalPath(root, directory));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Unmanaged entries and files arriving after the listing keep the directory alive.
		if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
	}
}

function readPayload(
	location: TaskRunOutputLocation,
	runId: string,
): Record<string, unknown> | null {
	try {
		const directStats = fs.lstatSync(location.absolutePath);
		if (directStats.isSymbolicLink() || !directStats.isFile()) return null;
		if (directStats.size > MAX_SIDECAR_BYTES) return null;
		const resolvedFile = realPathSync(location.absolutePath);
		if (!isPathInside(location.rootPath, resolvedFile)) return null;
		const serialized = fs.readFileSync(resolvedFile, "utf8");
		if (Buffer.byteLength(serialized, "utf8") > MAX_SIDECAR_BYTES) return null;
		const payload = JSON.parse(serialized) as Record<string, unknown>;
		if (![1, 2].includes(Number(payload.schema_version)) || payload.run_id !== runId) return null;
		if (typeof payload.output === "string" && payload.output.length > MAX_OUTPUT_CHARS) return null;
		if (typeof payload.error === "string" && payload.error.length > MAX_ERROR_CHARS) return null;
		if (typeof payload.summary === "string" && payload.summary.length > MAX_SUMMARY_CHARS) return null;
		if (payload.artifacts !== undefined && !isSafeArtifacts(payload.artifacts)) return null;
		return payload;
	} catch {
		return null;
	}
}

function isSafeArtifacts(value: unknown): value is TaskRunArtifacts {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const allowed = new Set(["articlePath", "wikiPath", "filesWritten"]);
	if (Object.keys(record).some((key) => !allowed.has(key))) return false;
	for (const key of ["articlePath", "wikiPath"] as const) {
		if (record[key] !== undefined && (typeof record[key] !== "string" || record[key].length > 1_000)) return false;
	}
	if (record.filesWritten !== undefined) {
		if (!Array.isArray(record.filesWritten) || record.filesWritten.length > 1_000) return false;
		if (record.filesWritten.some((item) => typeof item !== "string" || item.length > 1_000)) return false;
	}
	return true;
}

function readOutputPayload(location: TaskRunOutputLocation, run: TaskRun): string | null {
	const payload = readPayload(location, run.id);
	if (payload && Number(payload.schema_version) === 2) {
		const payloadExitCode = typeof payload.exit_code === "number" ? payload.exit_code : null;
		if (
			payload.action_id !== run.actionId
			|| payload.started_at !== run.startedAt
			|| payload.finished_at !== run.finishedAt
			|| payload.status !== run.status
			|| payloadExitCode !== run.exitCode
		) return null;
	}
	return payload && typeof payload.output === "string" ? payload.output : null;
}

/**
 * Reads a terminal sidecar before startup recovery rewrites a stale
 * data.json `running` record as interrupted. Schema v2 carries the complete
 * task outcome, so a failed final settings save can be reconciled exactly.
 */
export function readTaskRunCompletion(
	pluginDirectory: string,
	runId: string,
): TaskRunCompletionRecord | null {
	const location = resolveTaskRunOutputLocation(pluginDirectory, runId);
	if (!location) return null;
	const payload = readPayload(location, runId);
	if (!payload || Number(payload.schema_version) !== 2) return null;
	const status = String(payload.status || "");
	if (status !== "done" && status !== "failed" && status !== "interrupted") return null;
	const actionId = String(payload.action_id || "");
	const startedAt = String(payload.started_at || "");
	const finishedAt = String(payload.finished_at || "");
	if (!actionId || !startedAt || !finishedAt) return null;
	return {
		relativePath: location.relativePath,
		runId,
		actionId,
		status,
		exitCode: typeof payload.exit_code === "number" ? payload.exit_code : null,
		startedAt,
		finishedAt,
		output: typeof payload.output === "string" ? payload.output : "",
		error: typeof payload.error === "string" ? payload.error : "",
		summary: typeof payload.summary === "string" ? payload.summary : "",
		artifacts: payload.artifacts && typeof payload.artifacts === "object"
			? payload.artifacts as TaskRunArtifacts
			: undefined,
		ingestProgress: normalizeIngestProgress(payload.ingestProgress),
	};
}

/**
 * Deletes exactly one canonical plugin-owned sidecar. Missing files count as
 * already clean; symlinks, junction escapes, directories, and invalid run IDs
 * fail closed so history cleanup never follows an attacker-controlled target.
 */
export async function deleteTaskRunOutput(
	pluginDirectory: string,
	toolkitRoot: string,
	runId: string,
	storedRelativePath = "",
): Promise<boolean> {
	const pluginLocation = resolveTaskRunOutputLocation(pluginDirectory, runId);
	const legacyLocation = resolveLegacyToolkitLocation(toolkitRoot, runId);
	const location = storedRelativePath
		? storedRelativePath === pluginLocation?.relativePath
			? pluginLocation
			: storedRelativePath === legacyLocation?.relativePath
				? legacyLocation
				: null
		: pluginLocation;
	if (!location) throw new Error("任务输出 run ID 或插件存储目录无效");
	let directStats: fs.Stats;
	try {
		directStats = await fs.promises.lstat(location.absolutePath);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
		if (code === "ENOENT") return false;
		throw error;
	}
	if (directStats.isSymbolicLink()) throw new Error("任务输出文件不能是符号链接");
	if (!directStats.isFile()) throw new Error("任务输出目标不是普通文件");
	const resolvedFile = await fs.promises.realpath(location.absolutePath);
	if (!isPathInside(location.rootPath, resolvedFile)) {
		throw new Error("任务输出文件超出插件存储目录");
	}
	if (!readPayload(location, runId)) {
		throw new Error("任务输出文件不是与该 run ID 匹配的受支持 sidecar");
	}
	await fs.promises.unlink(location.absolutePath);
	return true;
}

/**
 * Reclaims stale atomic-write temp files left by a hard process termination.
 * Canonical sidecars require an explicit persisted `cleanupPending` marker and
 * are handled one-by-one by the caller; an unreferenced sidecar may be the only
 * recovery copy when data.json is temporarily incomplete or restored.
 */
export async function cleanupTaskRunStorage(
	pluginDirectory: string,
	nowMs = Date.now(),
): Promise<TaskRunStorageCleanupResult> {
	const result: TaskRunStorageCleanupResult = {
		temporaryRemoved: 0,
		failures: [],
	};
	const rootPath = resolveExistingDirectory(pluginDirectory);
	if (!rootPath) return result;
	const directoryPath = path.resolve(rootPath, ...PLUGIN_OUTPUT_DIRECTORY_SEGMENTS);
	let directoryStats: fs.Stats;
	try {
		directoryStats = await fs.promises.lstat(directoryPath);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
		if (code === "ENOENT") return result;
		throw error;
	}
	if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
		throw new Error("任务输出目录不是可信普通目录");
	}
	const realDirectory = await fs.promises.realpath(directoryPath);
	if (!isPathInside(rootPath, realDirectory)) {
		throw new Error("任务输出目录超出插件存储目录");
	}

	for (const entry of await fs.promises.readdir(directoryPath, { withFileTypes: true })) {
		const candidate = path.join(directoryPath, entry.name);
		try {
			const canonicalMatch = /^([A-Za-z0-9][A-Za-z0-9._-]{0,199})\.json$/.exec(entry.name);
			const temporaryMatch = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,199})\.json\.\d+\.[a-f0-9]{24}\.tmp$/.exec(entry.name);
			const recognizedName = Boolean(canonicalMatch || temporaryMatch);
			const directStats = await fs.promises.lstat(candidate);
			if (directStats.isSymbolicLink() || !directStats.isFile()) {
				if (recognizedName) throw new Error("任务输出候选不是可信普通文件");
				continue;
			}
			const resolved = await fs.promises.realpath(candidate);
			if (!isPathInside(rootPath, resolved)) {
				if (recognizedName) throw new Error("任务输出候选超出插件存储目录");
				continue;
			}

			if (canonicalMatch) {
				// Never infer deletion intent from a missing data.json reference.
				continue;
			}

			if (
				temporaryMatch
				&& directStats.mtimeMs <= nowMs - STALE_TEMP_MAX_AGE_MS
			) {
				await fs.promises.unlink(candidate);
				result.temporaryRemoved += 1;
			}
		} catch (error) {
			result.failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

/**
 * Reads only a canonical plugin-owned output file. The former Toolkit-backed
 * path remains read-only so histories created by an earlier beta keep working.
 */
export function readTaskRunOutput(
	pluginDirectory: string,
	toolkitRoot: string,
	run: TaskRun,
	storedRelativePath: string,
): string | null {
	const pluginLocation = resolveTaskRunOutputLocation(pluginDirectory, run.id);
	if (pluginLocation && storedRelativePath === pluginLocation.relativePath) {
		return readOutputPayload(pluginLocation, run);
	}
	const legacyLocation = resolveLegacyToolkitLocation(toolkitRoot, run.id);
	if (legacyLocation && storedRelativePath === legacyLocation.relativePath) {
		return readOutputPayload(legacyLocation, run);
	}
	return null;
}
