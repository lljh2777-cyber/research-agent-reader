import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { TaskRun, TaskRunArtifacts } from "../types/contracts";

// `__dirname` is the installed Obsidian plugin directory in the production
// bundle. Keep complete outputs beside data.json instead of coupling public
// Direct API users to an optional Toolkit checkout.
const PLUGIN_OUTPUT_DIRECTORY_SEGMENTS = ["task-output", "dashboard-runs"];
const LEGACY_TOOLKIT_OUTPUT_DIRECTORY_SEGMENTS = ["tool-library", "output", "dashboard-runs"];
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

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
}

export interface TaskRunStorageCleanupResult {
	temporaryRemoved: number;
	failures: string[];
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function resolvePluginStorageRoot(): string | null {
	return resolveExistingDirectory(__dirname);
}

function resolveConfiguredToolkitRoot(toolkitRoot: string): string | null {
	return resolveExistingDirectory(toolkitRoot);
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

/**
 * Resolves the canonical output location inside the installed plugin's own
 * data directory. `toolkitRoot` remains in the signature for source
 * compatibility with existing callers, but it is not a write destination.
 */
export function resolveTaskRunOutputLocation(
	_toolkitRoot: string,
	runId: string,
): TaskRunOutputLocation | null {
	const rootPath = resolvePluginStorageRoot();
	return rootPath
		? buildLocation(rootPath, PLUGIN_OUTPUT_DIRECTORY_SEGMENTS, runId)
		: null;
}

function resolveLegacyToolkitLocation(
	toolkitRoot: string,
	runId: string,
): TaskRunOutputLocation | null {
	const rootPath = resolveConfiguredToolkitRoot(toolkitRoot);
	return rootPath
		? buildLocation(rootPath, LEGACY_TOOLKIT_OUTPUT_DIRECTORY_SEGMENTS, runId)
		: null;
}

async function ensureContainedOutputDirectory(location: TaskRunOutputLocation): Promise<string> {
	const relativeDirectory = path.relative(location.rootPath, location.directoryPath);
	if (
		!relativeDirectory
		|| relativeDirectory.startsWith("..")
		|| path.isAbsolute(relativeDirectory)
	) {
		throw new Error("任务输出目录超出插件存储目录");
	}
	let currentPath = location.rootPath;
	for (const segment of relativeDirectory.split(path.sep)) {
		const nextPath = path.join(currentPath, segment);
		try {
			await fs.promises.mkdir(nextPath);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
			if (code !== "EEXIST") throw error;
		}
		const directStats = await fs.promises.lstat(nextPath);
		if (directStats.isSymbolicLink()) throw new Error("任务输出目录不能是符号链接或 junction");
		if (!directStats.isDirectory()) throw new Error("任务输出目录不是文件夹");
		const resolvedPath = await fs.promises.realpath(nextPath);
		if (!isPathInside(location.rootPath, resolvedPath)) {
			throw new Error("任务输出目录超出插件存储目录");
		}
		currentPath = resolvedPath;
	}
	return currentPath;
}

async function assertSafeExistingTarget(
	rootPath: string,
	absolutePath: string,
): Promise<void> {
	try {
		const existingStats = await fs.promises.lstat(absolutePath);
		if (existingStats.isSymbolicLink()) throw new Error("任务输出文件不能是符号链接");
		if (!existingStats.isFile()) throw new Error("任务输出目标不是普通文件");
		const resolvedFile = await fs.promises.realpath(absolutePath);
		if (!isPathInside(rootPath, resolvedFile)) {
			throw new Error("任务输出文件超出插件存储目录");
		}
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
		if (code !== "ENOENT") throw error;
	}
}

/** Writes the full task output into plugin-owned storage using an atomic rename. */
export async function writeTaskRunOutput(
	toolkitRoot: string,
	run: TaskRun,
): Promise<string> {
	const output = String(run?.output || "");
	const location = resolveTaskRunOutputLocation(toolkitRoot, run?.id);
	if (!location) return "";
	const directoryPath = await ensureContainedOutputDirectory(location);
	const absolutePath = path.join(directoryPath, path.basename(location.absolutePath));
	if (!isPathInside(location.rootPath, absolutePath)) {
		throw new Error("任务输出文件超出插件存储目录");
	}
	await assertSafeExistingTarget(location.rootPath, absolutePath);
	const temporaryPath = path.join(
		directoryPath,
		`.${path.basename(absolutePath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
	);
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
	}, null, 2);
	let temporaryFileCreated = false;
	try {
		await fs.promises.writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx" });
		temporaryFileCreated = true;
		const temporaryStats = await fs.promises.lstat(temporaryPath);
		const resolvedTemporary = await fs.promises.realpath(temporaryPath);
		if (
			temporaryStats.isSymbolicLink()
			|| !temporaryStats.isFile()
			|| !isPathInside(location.rootPath, resolvedTemporary)
		) {
			throw new Error("任务输出临时文件未落在可信目录内");
		}
		// Re-check the destination immediately before replacement. Rename keeps
		// readers on either the complete previous payload or the complete new one.
		await assertSafeExistingTarget(location.rootPath, absolutePath);
		await fs.promises.rename(temporaryPath, absolutePath);
		temporaryFileCreated = false;
	} finally {
		if (temporaryFileCreated) {
			await fs.promises.unlink(temporaryPath).catch(() => undefined);
		}
	}
	return location.relativePath;
}

function readPayload(
	location: TaskRunOutputLocation,
	runId: string,
): Record<string, unknown> | null {
	try {
		const directStats = fs.lstatSync(location.absolutePath);
		if (directStats.isSymbolicLink() || !directStats.isFile()) return null;
		const resolvedFile = realPathSync(location.absolutePath);
		if (!isPathInside(location.rootPath, resolvedFile)) return null;
		const payload = JSON.parse(fs.readFileSync(resolvedFile, "utf8")) as Record<string, unknown>;
		if (![1, 2].includes(Number(payload.schema_version)) || payload.run_id !== runId) return null;
		return payload;
	} catch {
		return null;
	}
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
	toolkitRoot: string,
	runId: string,
): TaskRunCompletionRecord | null {
	const location = resolveTaskRunOutputLocation(toolkitRoot, runId);
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
	};
}

/**
 * Deletes exactly one canonical plugin-owned sidecar. Missing files count as
 * already clean; symlinks, junction escapes, directories, and invalid run IDs
 * fail closed so history cleanup never follows an attacker-controlled target.
 */
export async function deleteTaskRunOutput(
	toolkitRoot: string,
	runId: string,
	storedRelativePath = "",
): Promise<boolean> {
	const pluginLocation = resolveTaskRunOutputLocation(toolkitRoot, runId);
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
	_toolkitRoot: string,
	_knownRunIds: ReadonlySet<string>,
	nowMs = Date.now(),
): Promise<TaskRunStorageCleanupResult> {
	const result: TaskRunStorageCleanupResult = {
		temporaryRemoved: 0,
		failures: [],
	};
	const rootPath = resolvePluginStorageRoot();
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
	toolkitRoot: string,
	run: TaskRun,
	storedRelativePath: string,
): string | null {
	const pluginLocation = resolveTaskRunOutputLocation(toolkitRoot, run.id);
	if (pluginLocation && storedRelativePath === pluginLocation.relativePath) {
		return readOutputPayload(pluginLocation, run);
	}
	const legacyLocation = resolveLegacyToolkitLocation(toolkitRoot, run.id);
	if (legacyLocation && storedRelativePath === legacyLocation.relativePath) {
		return readOutputPayload(legacyLocation, run);
	}
	return null;
}
