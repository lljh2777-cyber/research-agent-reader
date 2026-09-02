import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildRuntimeViewerIndex, MINERU_VIEWER_LIMITS } from "../mineru/normalization";
import { buildVisualCandidates, validateVisualCandidates } from "../mineru/visual-candidates";
import { buildRuntimeVisualRepair, validateVisualContracts } from "../mineru/visual-repair";

/**
 * Native (Python/toolkit-free) MinerU publish pipeline for the light agent.
 * It spawns the mineru-open-api CLI directly, validates the extraction with
 * the same gates as the toolkit helper, and publishes a reader-compatible
 * immutable package under <vaultRoot>/papers/<citekey>/ — create-only.
 */

export interface MineruCommandRequest {
	command: string;
	baseArgs: string[];
	cliArgs: string[];
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
}

export interface MineruCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface MineruPublishDeps {
	runCommand(request: MineruCommandRequest): Promise<MineruCommandResult>;
	/** Absolute path of the active vault; packages publish under papers/. */
	vaultRoot: string;
	mineruExecutable: string;
	/** Stage parent directory; defaults to os.tmpdir(). */
	stageRoot?: string;
	now?: () => Date;
	/** Injectable filesystem boundary for atomic-publish failure tests. */
	publishOps?: Partial<MineruPublishOps>;
}

export interface MineruPublishOps {
	copyPackage(source: string, destination: string): void;
	renamePackage(source: string, destination: string): void;
}

export interface MineruPublishArgs {
	source: string;
	/** User-visible original basename; the CLI reads the authorized snapshot. */
	sourceName?: string;
	/** Hash computed while creating the authorized snapshot. */
	expectedSourceSha256?: string;
	citekey: string;
	model: string;
	language: string;
	ocr: boolean;
	formula: boolean;
	table: boolean;
	pages: string;
	timeoutSeconds: number;
	includeSourcePdf: boolean;
	baseUrl?: string;
}

export interface MineruPackageReceipt {
	/** Absolute path of the published package inside the vault. */
	packagePath: string;
	validation: Record<string, unknown>;
}

export interface MineruPublishContext {
	signal: AbortSignal;
	timeoutMs: number;
	/** Synchronous, read-only gate over the exact same-volume copy to commit. */
	validateBeforeCommit?(articleMarkdown: string): void;
}

/** Identity/evidence conflicts are distinct from CLI and filesystem failures. */
export class MineruPreCommitValidationError extends Error {
	readonly cleanupFailed: boolean;
	readonly stagingBasename: string;

	constructor(
		message: string,
		options: { cleanupFailed?: boolean; stagingBasename?: string } = {},
	) {
		super(message);
		this.name = "MineruPreCommitValidationError";
		this.cleanupFailed = options.cleanupFailed === true;
		this.stagingBasename = String(options.stagingBasename || "");
	}
}

const CITEKEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_PUBLISH_ASSET_BYTES = 256 * 1024 * 1024;
const PACKAGE_INVENTORY_LIMITS = {
	maxDepth: 16,
	maxEntries: 10_000,
	maxFiles: 8_192,
	maxTotalBytes: 512 * 1024 * 1024,
	maxFileBytes: MAX_PUBLISH_ASSET_BYTES,
} as const;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

export interface ResolvedMineruCommand {
	command: string;
	baseArgs: string[];
}

function packagedMineruPlatformName(): string {
	if (!["darwin", "linux", "win32"].includes(process.platform)) return "";
	if (!["arm64", "x64"].includes(process.arch)) return "";
	return `mineru-open-api-${process.platform}-${process.arch}`;
}

/**
 * npm 0.5.x ships a tiny Node launcher whose only job is to find and execute
 * an optional platform package. Resolve that native binary ourselves so the
 * desktop plugin never tries to use Obsidian/Electron as a Node runtime.
 */
function resolvePackagedMineruBinary(packageRoot: string): string {
	const platformPackage = packagedMineruPlatformName();
	if (!platformPackage) return "";
	const binaryName = process.platform === "win32" ? "mineru-open-api.exe" : "mineru-open-api";
	const packageCandidates = [
		path.join(packageRoot, "node_modules", platformPackage),
		path.join(path.dirname(packageRoot), platformPackage),
	];
	for (const platformRoot of packageCandidates) {
		try {
			const platformRootStats = fs.lstatSync(platformRoot);
			const platformPackageJson = path.join(platformRoot, "package.json");
			const platformPackageJsonStats = fs.lstatSync(platformPackageJson);
			if (platformRootStats.isSymbolicLink() || !platformRootStats.isDirectory()
				|| platformPackageJsonStats.isSymbolicLink() || !platformPackageJsonStats.isFile()) continue;
			const platformRecord = JSON.parse(
				fs.readFileSync(platformPackageJson, "utf8"),
			) as { name?: string };
			if (platformRecord.name !== platformPackage) continue;
			const platformBinRoot = path.join(platformRoot, "bin");
			const platformBinStats = fs.lstatSync(platformBinRoot);
			if (platformBinStats.isSymbolicLink() || !platformBinStats.isDirectory()) continue;
			const stats = fs.lstatSync(path.join(platformBinRoot, binaryName));
			if (stats.isSymbolicLink() || !stats.isFile()) continue;
			const realPlatformRoot = realPathSync(platformRoot);
			const realBinary = realPathSync(path.join(platformRoot, "bin", binaryName));
			if (!isPathInside(realPlatformRoot, realBinary)) continue;
			return realBinary;
		} catch {
			continue;
		}
	}
	return "";
}

interface ValidatedMineruNodeEntry {
	entry: string;
	packageRoot: string;
}

function validateMineruNodeEntry(rawEntry: string): ValidatedMineruNodeEntry {
	const entry = path.resolve(rawEntry);
	const entryStats = fs.lstatSync(entry);
	if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
		throw new Error("MinerU Node 入口必须是普通文件，不能是符号链接或 junction");
	}
	const realEntry = realPathSync(entry);
	let current = path.dirname(entry);
	for (let depth = 0; depth < 8; depth += 1) {
		const packageJson = path.join(current, "package.json");
		if (fs.existsSync(packageJson)) {
			const packageStats = fs.lstatSync(current);
			const packageJsonStats = fs.lstatSync(packageJson);
			if (packageStats.isSymbolicLink() || !packageStats.isDirectory()
				|| packageJsonStats.isSymbolicLink() || !packageJsonStats.isFile()) {
				throw new Error("MinerU npm 包根和 package.json 必须是普通目录与文件");
			}
			const record = JSON.parse(fs.readFileSync(packageJson, "utf8")) as {
				name?: string;
				bin?: string | Record<string, string>;
			};
			if (record.name !== "mineru-open-api") {
				throw new Error(`npm shim 指向的包不是 mineru-open-api：${String(record.name || "未知包")}`);
			}
			const binValue = typeof record.bin === "string"
				? record.bin
				: record.bin?.["mineru-open-api"];
			if (!binValue || path.isAbsolute(binValue)) {
				throw new Error("mineru-open-api package.json 缺少可信的 bin 映射");
			}
			const binSegments = String(binValue).replace(/\\/g, "/").split("/");
			if (binSegments.some((segment) => !segment || segment === "." || segment === "..")) {
				throw new Error("mineru-open-api bin 映射包含不安全路径");
			}
			const declaredEntry = path.resolve(current, ...binSegments);
			let inspectedParent = path.dirname(declaredEntry);
			while (inspectedParent !== current) {
				const parentStats = fs.lstatSync(inspectedParent);
				if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
					throw new Error("mineru-open-api bin 路径包含符号链接或非普通目录");
				}
				const next = path.dirname(inspectedParent);
				if (next === inspectedParent || !isPathInside(current, inspectedParent)) {
					throw new Error("mineru-open-api bin 入口越出包目录");
				}
				inspectedParent = next;
			}
			const declaredStats = fs.lstatSync(declaredEntry);
			if (declaredStats.isSymbolicLink() || !declaredStats.isFile()) {
				throw new Error("mineru-open-api bin 入口不是普通文件");
			}
			const realPackageRoot = realPathSync(current);
			const realDeclaredEntry = realPathSync(declaredEntry);
			if (!isPathInside(realPackageRoot, realDeclaredEntry) || realDeclaredEntry !== realEntry) {
				throw new Error("npm shim 入口与 mineru-open-api package.json bin 映射不一致");
			}
			return { entry: realEntry, packageRoot: realPackageRoot };
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error("无法找到 mineru-open-api 的 package.json，拒绝 Node launcher");
}

function resolveNodeRuntime(shimRoot: string): string {
	const executableName = process.platform === "win32" ? "node.exe" : "node";
	const candidates = [
		path.join(shimRoot, executableName),
	];
	if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) candidates.unshift(process.execPath);
	for (const candidate of candidates) {
		try {
			const stats = fs.lstatSync(candidate);
			if (stats.isFile()) return realPathSync(candidate);
		} catch {
			continue;
		}
	}
	return "";
}

function resolveNodeLauncher(entry: string, shimRoot: string): ResolvedMineruCommand {
	const validated = validateMineruNodeEntry(entry);
	const nativeBinary = resolvePackagedMineruBinary(validated.packageRoot);
	if (nativeBinary) return { command: nativeBinary, baseArgs: [] };
	const nodeRuntime = resolveNodeRuntime(shimRoot);
	if (nodeRuntime) return { command: nodeRuntime, baseArgs: [validated.entry] };
	throw new Error("MinerU npm 包未提供可验证的平台二进制，且配置目录旁没有可信 Node.js；请重新安装 mineru-open-api");
}

function resolveNpmShimEntry(shimPath: string, shim: string): string {
	const shimRoot = path.dirname(shimPath);
	const realShimRoot = realPathSync(shimRoot);
	for (const line of String(shim || "").split(/\r?\n/)) {
		for (const match of line.matchAll(/"([^"\r\n]+)"/g)) {
			const token = match[1].trim();
			if (!/^%(?:~dp0|dp0%)[\\/]+/i.test(token)) continue;
			const relative = token
				.replace(/^%(?:~dp0|dp0%)[\\/]+/i, "")
				.replace(/\\/g, "/");
			const segments = relative.split("/").filter(Boolean);
			if (segments[0]?.toLowerCase() !== "node_modules"
				|| segments[1]?.toLowerCase() !== "mineru-open-api"
				|| segments.includes("..")) continue;
			// A normal npm cmd shim passes only `%*` after the quoted entry. Never
			// reinterpret shell operators or an appended command tail.
			const tail = line.slice((match.index || 0) + match[0].length).trim();
			if (tail && tail !== "%*") continue;
			const candidate = path.resolve(shimRoot, ...segments);
			if (!isPathInside(shimRoot, candidate)) continue;
			const extension = path.extname(candidate).toLowerCase();
			if (extension && ![".js", ".mjs", ".cjs"].includes(extension)) continue;
			try {
				const directStats = fs.lstatSync(candidate);
				if (directStats.isSymbolicLink() || !directStats.isFile()) continue;
				const realCandidate = realPathSync(candidate);
				if (!isPathInside(realShimRoot, realCandidate)) continue;
				return realCandidate;
			} catch {
				continue;
			}
		}
	}
	return "";
}

/**
 * Resolves how to launch the configured MinerU CLI without a shell (shell
 * mode is banned in this plugin). npm installs CLIs as .cmd shims that
 * spawn() refuses on Windows; instead of shelling out, we read the shim and
 * launch its node entry script directly.
 */
export function resolveMineruCommand(executable: string): ResolvedMineruCommand {
	const configured = String(executable || "").trim();
	if (!configured) throw new Error("未配置 MinerU CLI");
	const resolved = path.resolve(configured);
	if (!fs.existsSync(resolved)) {
		throw new Error(`MinerU CLI 不存在：${resolved}（npm 全局安装 mineru-open-api 后在设置中配置）`);
	}
	const ext = path.extname(resolved).toLowerCase();
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
		return resolveNodeLauncher(realPathSync(resolved), path.dirname(resolved));
	}
	if (!ext) {
		const stats = fs.lstatSync(resolved);
		if (stats.isFile()) {
			const head = fs.readFileSync(resolved, "utf8").slice(0, 200);
			if (/^#!.*\bnode\b/i.test(head)) {
				return resolveNodeLauncher(realPathSync(resolved), path.dirname(resolved));
			}
		}
	}
	if (ext !== ".cmd" && ext !== ".bat") {
		throw new Error(
			"MinerU CLI 必须是可验证的 mineru-open-api npm shim 或该包声明的 Node 入口；不直接执行任意原生文件",
		);
	}
	const shimStats = fs.lstatSync(resolved);
	if (shimStats.isSymbolicLink() || !shimStats.isFile()) {
		throw new Error(`MinerU npm shim 必须是普通文件：${resolved}`);
	}
	const shim = fs.readFileSync(resolved, "utf8");
	const entry = resolveNpmShimEntry(resolved, shim);
	if (entry) return resolveNodeLauncher(entry, path.dirname(resolved));
	throw new Error(
		`无法从 npm shim 解析 MinerU 入口脚本：${resolved}。请在设置中直接配置其 node_modules 下的 .js 入口文件`,
	);
}

export function mineruCliArgs(args: MineruPublishArgs, extractDir: string): string[] {
	const cliArgs: string[] = [];
	if (args.baseUrl?.trim()) cliArgs.push("--base-url", args.baseUrl.trim());
	cliArgs.push("extract", args.source);
	if (args.model && args.model !== "auto") cliArgs.push("--model", args.model);
	cliArgs.push(
		"--language", args.language || "en",
		"--format", "md,json",
		"--timeout", String(Math.max(60, Math.min(1800, Math.round(args.timeoutSeconds) || 600))),
		"--output", extractDir,
		"--formula" + (args.formula ? "" : "=false"),
		"--table" + (args.table ? "" : "=false"),
	);
	if (args.ocr) cliArgs.push("--ocr");
	if (args.pages) cliArgs.push("--pages", args.pages);
	return cliArgs;
}

export function normalizePagesValue(value: string): string {
	const raw = String(value || "").trim().replace(/，/g, ",");
	if (!raw) return "";
	const tokens = raw.split(/[,\s]+/).filter(Boolean);
	for (const token of tokens) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(token);
		if (!match) throw new Error(`MinerU 页码范围不合法（应如 1-10,15）：${token}`);
		const start = Number(match[1]);
		const end = Number(match[2] || match[1]);
		if (start < 1 || end < start) throw new Error("MinerU 页码从 1 开始且不能倒序");
	}
	return tokens.join(",");
}

function sha256File(file: string): string {
	const hash = createHash("sha256");
	const descriptor = fs.openSync(file, "r");
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		while (true) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		return hash.digest("hex");
	} finally {
		fs.closeSync(descriptor);
	}
}

function sha256Bytes(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function portableBasename(value: string): string {
	const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function normalizeExtractorVersion(value: string): string {
	const bounded = String(value || "").slice(0, 1000);
	const candidate = /(?:^|[^0-9A-Za-z.+-])v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.+-])/i.exec(bounded)?.[1] || "";
	const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
	const strictSemver = new RegExp(
		`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)`
		+ `(?:-${identifier}(?:\\.${identifier})*)?`
		+ "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
	);
	return candidate && strictSemver.test(candidate) ? candidate : "unknown";
}

interface PackageInventory {
	files: string[];
	directories: string[];
	totalBytes: number;
}

/** Enumerate an untrusted tree without following filesystem indirections. */
function inventoryTree(root: string): PackageInventory {
	const rootPath = path.resolve(root);
	const rootStats = fs.lstatSync(rootPath);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw new Error(`MinerU 输出根必须是普通目录：${rootPath}`);
	}
	const realRoot = realPathSync(rootPath);
	const files: string[] = [];
	const directories: string[] = [];
	const stack: Array<{ directory: string; depth: number }> = [{ directory: rootPath, depth: 0 }];
	let entries = 0;
	let totalBytes = 0;
	while (stack.length) {
		const current = stack.pop() as { directory: string; depth: number };
		if (current.depth > PACKAGE_INVENTORY_LIMITS.maxDepth) {
			throw new Error(`MinerU 输出目录深度超过 ${PACKAGE_INVENTORY_LIMITS.maxDepth}`);
		}
		const handle = fs.opendirSync(current.directory);
		try {
			while (true) {
				const entry = handle.readSync();
				if (!entry) break;
				entries += 1;
				if (entries > PACKAGE_INVENTORY_LIMITS.maxEntries) {
					throw new Error(`MinerU 输出条目数超过 ${PACKAGE_INVENTORY_LIMITS.maxEntries}`);
				}
				const child = path.join(current.directory, entry.name);
				const stats = fs.lstatSync(child);
				if (stats.isSymbolicLink()) throw new Error(`MinerU 输出包含符号链接或 junction：${entry.name}`);
				const realChild = realPathSync(child);
				if (!isPathInside(realRoot, realChild)) throw new Error(`MinerU 输出解析到暂存目录之外：${entry.name}`);
				if (stats.isDirectory()) {
					directories.push(child);
					stack.push({ directory: child, depth: current.depth + 1 });
					continue;
				}
				if (!stats.isFile()) throw new Error(`MinerU 输出包含不支持的特殊文件：${entry.name}`);
				if (stats.size > PACKAGE_INVENTORY_LIMITS.maxFileBytes) {
					throw new Error(`MinerU 输出单文件超过 256 MiB：${entry.name}`);
				}
				files.push(child);
				totalBytes += stats.size;
				if (files.length > PACKAGE_INVENTORY_LIMITS.maxFiles) {
					throw new Error(`MinerU 输出文件数超过 ${PACKAGE_INVENTORY_LIMITS.maxFiles}`);
				}
				if (totalBytes > PACKAGE_INVENTORY_LIMITS.maxTotalBytes) {
					throw new Error("MinerU 输出累计大小超过 512 MiB");
				}
			}
		} finally {
			handle.closeSync();
		}
	}
	return { files, directories, totalBytes };
}

/** Mirrors the toolkit helper: exactly one .md, one unambiguous MinerU JSON. */
function locateMineruOutputs(extractDir: string): { markdown: string; json: string } {
	const files = inventoryTree(extractDir).files;
	const inventory = files.length
		? files.slice(0, 20).map((file) => path.relative(extractDir, file).replace(/\\/g, "/")).join("、")
		: "（空）";
	const markdownFiles = files.filter((file) => file.toLowerCase().endsWith(".md"));
	if (markdownFiles.length !== 1) {
		throw new Error(`MinerU 输出应只有一个 .md，实际 ${markdownFiles.length} 个；暂存文件：${inventory}`);
	}
	const jsonFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));
	let jsonFile = jsonFiles.length === 1 ? jsonFiles[0] : "";
	if (jsonFiles.length > 1) {
		const preferred = ["content_list_v2", "content_list"]
			.map((marker) => jsonFiles.filter((file) => file.toLowerCase().includes(marker)))
			.find((matches) => matches.length === 1);
		jsonFile = preferred?.[0] || "";
	}
	if (!jsonFile) {
		throw new Error(`MinerU 输出应有唯一无歧义的 JSON，实际 ${jsonFiles.length} 个；暂存文件：${inventory}`);
	}
	return { markdown: markdownFiles[0], json: jsonFile };
}

function normalizedReferencedAsset(rawPath: string): string {
	let normalized = String(rawPath || "").trim().replace(/^</, "").replace(/>$/, "");
	try { normalized = decodeURIComponent(normalized); } catch { /* Keep raw input. */ }
	normalized = normalized.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || /^[a-z]+:\/\//i.test(normalized) || path.posix.isAbsolute(normalized)) {
		throw new Error(`MinerU 资产引用了不支持的地址：${rawPath}`);
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`MinerU 资产引用越出包目录：${rawPath}`);
	}
	return segments.join("/");
}

function copyReferencedAssets(
	extractDir: string,
	outputRoot: string,
	packageRoot: string,
	markdown: string,
	payload: unknown,
): void {
	const refs = new Set(markdownAssetRefs(markdown).map(normalizedReferencedAsset));
	for (const element of flattenMineruElements(payload)) {
		for (const rawAsset of element.assetPaths) refs.add(normalizedReferencedAsset(rawAsset));
	}
	if (refs.size > MINERU_VIEWER_LIMITS.maxMarkdownImages * 2) {
		throw new Error("MinerU 引用资产数超过安全上限");
	}
	const realExtractRoot = realPathSync(extractDir);
	for (const relative of refs) {
		const source = path.resolve(outputRoot, ...relative.split("/"));
		if (!isPathInside(path.resolve(outputRoot), source)) throw new Error(`MinerU 资产引用越界：${relative}`);
		if (!fs.existsSync(source)) throw new Error(`MinerU 引用资产缺失或为空：${relative}`);
		const stats = fs.lstatSync(source);
		if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0) {
			throw new Error(`MinerU 引用资产不是非空普通文件：${relative}`);
		}
		const realSource = realPathSync(source);
		if (!isPathInside(realExtractRoot, realSource)) throw new Error(`MinerU 引用资产解析到暂存目录之外：${relative}`);
		const destination = path.join(packageRoot, ...relative.split("/"));
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
	}
}

function copyInventoriedTree(source: string, destination: string): void {
	const inventory = inventoryTree(source);
	fs.mkdirSync(destination);
	for (const directory of inventory.directories.sort((a, b) => a.length - b.length)) {
		const relative = path.relative(source, directory);
		fs.mkdirSync(path.join(destination, relative));
	}
	for (const file of inventory.files) {
		const relative = path.relative(source, file);
		fs.copyFileSync(file, path.join(destination, relative), fs.constants.COPYFILE_EXCL);
	}
}

interface MineruElement {
	pageIdx: number;
	assetPaths: string[];
}

function collectAssetFromItem(item: Record<string, unknown>): string | null {
	const content = item.content && typeof item.content === "object" && !Array.isArray(item.content)
		? item.content as Record<string, unknown>
		: {};
	const source = content.image_source && typeof content.image_source === "object"
		? content.image_source as Record<string, unknown>
		: content.table_source && typeof content.table_source === "object"
			? content.table_source as Record<string, unknown>
			: {};
	for (const value of [item.img_path, item.image_path, source.path, source.src, content.img_path]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function flattenMineruElements(payload: unknown): MineruElement[] {
	if (!Array.isArray(payload) || payload.length === 0) {
		throw new Error("mineru-result.json 必须是非空元素数组");
	}
	if (payload.length > MINERU_VIEWER_LIMITS.maxSourceElements) {
		throw new Error("mineru-result.json 元素或页数超过安全上限");
	}
	const flattened: MineruElement[] = [];
	const push = (item: unknown, pageIdx: number): void => {
		if (flattened.length >= MINERU_VIEWER_LIMITS.maxSourceElements) {
			throw new Error("mineru-result.json 元素数超过安全上限");
		}
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("mineru-result.json 含非对象元素");
		}
		const record = item as Record<string, unknown>;
		const page = pageIdx >= 0 ? pageIdx : record.page_idx;
		if (
			typeof page !== "number"
			|| !Number.isInteger(page)
			|| page < 0
			|| page >= MINERU_VIEWER_LIMITS.maxPages
		) {
			throw new Error("mineru-result.json 元素缺少有效 page_idx");
		}
		const asset = collectAssetFromItem(record);
		flattened.push({ pageIdx: page, assetPaths: asset ? [asset] : [] });
	};
	if (payload.every((page) => Array.isArray(page))) {
		if (payload.length > MINERU_VIEWER_LIMITS.maxPages) {
			throw new Error("mineru-result.json 页数超过安全上限");
		}
		for (let pageIndex = 0; pageIndex < (payload as unknown[][]).length; pageIndex += 1) {
			const page = (payload as unknown[][])[pageIndex];
			if (page.length > MINERU_VIEWER_LIMITS.maxBlocksPerPage) {
				throw new Error(`mineru-result.json 第 ${pageIndex + 1} 页元素数超过安全上限`);
			}
			if (!page.length) continue;
			for (const item of page) push(item, pageIndex);
		}
	} else {
		for (const item of payload) push(item, -1);
	}
	if (!flattened.length) throw new Error("mineru-result.json 页数组不含任何元素");
	return flattened;
}

function safePackageAssetPath(packageRoot: string, rawPath: string): string {
	let normalized = String(rawPath || "").trim().replace(/^</, "").replace(/>$/, "");
	try {
		normalized = decodeURIComponent(normalized);
	} catch {
		// Keep the raw value when it is not valid percent-encoding.
	}
	// Backslashes are path separators on Windows-hosted extractions; treat
	// them as such on every platform so `..\` traversal cannot masquerade
	// as an ordinary filename on POSIX.
	normalized = normalized.replace(/\\/g, "/");
	if (!normalized || /^[a-z]+:\/\//i.test(normalized)) {
		throw new Error(`mineru 资产引用了不支持的地址：${rawPath}`);
	}
	const candidate = path.resolve(packageRoot, normalized);
	const normalizedRoot = path.resolve(packageRoot);
	if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
		throw new Error(`mineru 资产引用越出包目录：${rawPath}`);
	}
	return candidate;
}

function markdownAssetRefs(markdown: string): string[] {
	const refs = new Set<string>();
	for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
		refs.add(match[1]);
	}
	for (const match of markdown.matchAll(HTML_IMAGE_RE)) {
		refs.add(match[1]);
	}
	return [...refs];
}

/**
 * Same gates as the toolkit helper: non-empty markdown with a title
 * heading, a valid MinerU element array, and every referenced asset
 * present and non-empty inside the package.
 */
export function validateStagedPackage(packageRoot: string): Record<string, unknown> {
	const markdown = fs.readFileSync(path.join(packageRoot, "article.md"), "utf8");
	if (markdown.trim().length < 100) {
		throw new Error("MinerU article.md 为空或过短（<100 字符）");
	}
	if (!/^#\s+\S/m.test(markdown)) {
		throw new Error("Mineru article.md 缺少文档标题（# 标题）");
	}
	const payload = JSON.parse(fs.readFileSync(path.join(packageRoot, "mineru-result.json"), "utf8")) as unknown;
	const elements = flattenMineruElements(payload);

	let pageMax = 0;
	const jsonAssets = new Set<string>();
	for (const element of elements) {
		pageMax = Math.max(pageMax, element.pageIdx);
		for (const rawAsset of element.assetPaths) {
			const assetPath = safePackageAssetPath(packageRoot, rawAsset);
			if (!fs.existsSync(assetPath) || fs.statSync(assetPath).size === 0) {
				throw new Error(`mineru-result.json 引用的资产缺失或为空：${rawAsset}`);
			}
			jsonAssets.add(path.relative(packageRoot, assetPath).split(path.sep).join("/"));
		}
	}

	const markdownAssets = markdownAssetRefs(markdown);
	if (markdownAssets.length > MINERU_VIEWER_LIMITS.maxMarkdownImages) {
		throw new Error("article.md 图片引用数超过安全上限");
	}
	for (const rawAsset of markdownAssets) {
		const assetPath = safePackageAssetPath(packageRoot, rawAsset);
		if (!fs.existsSync(assetPath) || fs.statSync(assetPath).size === 0) {
			throw new Error(`article.md 引用的图片缺失或为空：${rawAsset}`);
		}
	}

	const unreferenced = [...jsonAssets].filter((asset) => !markdownAssets.includes(asset));
	return {
		status: "passed",
		checks: {
			markdown_nonempty: true,
			title_heading_present: true,
			json_array_valid: true,
			json_assets_exist: true,
			markdown_assets_exist: true,
		},
		page_count: elements.length ? pageMax + 1 : 0,
		json_element_count: elements.length,
		json_asset_count: jsonAssets.size,
		markdown_asset_count: markdownAssets.length,
		unreferenced_json_assets: unreferenced.sort(),
	};
}

function buildManifest(inputs: {
	sourcePdf: string;
	options: MineruPublishArgs;
	extractorVersion: string;
	extractorExecutable: string;
	packageRoot: string;
	includeSourcePdf: boolean;
	createdIso: string;
}): Record<string, unknown> {
	const outputs: Array<Record<string, unknown>> = [];
	const derivedContracts: Array<Record<string, unknown>> = [];
	const fileRecord = (absolutePath: string): Record<string, unknown> => {
		const relative = path.relative(inputs.packageRoot, absolutePath).split(path.sep).join("/");
		const size = fs.statSync(absolutePath).size;
		if (size > MAX_PUBLISH_ASSET_BYTES) {
			throw new Error(`包内文件超过发布上限（256MiB）：${relative}`);
		}
		return { path: relative, size, sha256: sha256File(absolutePath) };
	};
	const register = (absolutePath: string): void => { outputs.push(fileRecord(absolutePath)); };
	register(path.join(inputs.packageRoot, "article.md"));
	register(path.join(inputs.packageRoot, "mineru-result.json"));
	const imagesDir = path.join(inputs.packageRoot, "images");
	if (fs.existsSync(imagesDir)) {
		for (const file of inventoryTree(imagesDir).files) register(file);
	}
	if (inputs.includeSourcePdf) {
		register(path.join(inputs.packageRoot, "_extraction", "source.pdf"));
	}
	for (const relativePath of [
		"_extraction/viewer-index.json",
		"_extraction/visual-repair.json",
		"_extraction/visual-candidates.json",
	]) {
		const absolutePath = path.join(inputs.packageRoot, ...relativePath.split("/"));
		if (fs.existsSync(absolutePath)) derivedContracts.push(fileRecord(absolutePath));
	}
	const sourceStat = fs.statSync(inputs.sourcePdf);
	return {
		schema_version: 1,
		extractor: "mineru-open-api",
		extractor_version: inputs.extractorVersion,
		// Keep the manifest portable and avoid persisting host-specific paths.
		extractor_executable: portableBasename(inputs.extractorExecutable),
		created_at: inputs.createdIso,
		processing_depth: "conversion-only",
		source: {
			path: portableBasename(inputs.options.sourceName || inputs.sourcePdf),
			size: sourceStat.size,
			sha256: sha256File(inputs.sourcePdf),
		},
		privacy: {
			remote_processing: true,
			notice: "文档内容已发送至配置的 MinerU 服务处理。",
		},
		options: {
			mode: "precision-extract",
			formats: ["md", "json"],
			model: inputs.options.model,
			language: inputs.options.language,
			ocr: inputs.options.ocr,
			formula: inputs.options.formula,
			table: inputs.options.table,
			pages: normalizePagesValue(inputs.options.pages) || null,
			include_source_pdf: inputs.includeSourcePdf,
		},
		outputs,
		derived_contracts: derivedContracts,
	};
}

function writeDerivedViewerContracts(
	packageRoot: string,
	includeSourcePdf: boolean,
): {
	viewerStatus: string;
	repairStatus: string;
	candidateStatus: string;
	groupCount: number;
	autoGroupCount: number;
	candidateCount: number;
} {
	const articlePath = path.join(packageRoot, "article.md");
	const mineruPath = path.join(packageRoot, "mineru-result.json");
	const articleBytes = fs.readFileSync(articlePath);
	const mineruBytes = fs.readFileSync(mineruPath);
	const articleMarkdown = articleBytes.toString("utf8");
	const mineruPayload = JSON.parse(mineruBytes.toString("utf8")) as unknown;
	const articleHash = sha256Bytes(articleBytes);
	const mineruHash = sha256Bytes(mineruBytes);
	const viewerIndex = buildRuntimeViewerIndex(mineruPayload, articleMarkdown, {
		articleSha256: articleHash,
		mineruResultSha256: mineruHash,
		packagedSourcePdf: includeSourcePdf,
	});
	const visualRepair = buildRuntimeVisualRepair(viewerIndex);
	const contractErrors = validateVisualContracts({
		viewerIndex,
		visualRepair,
		sourceIndex: viewerIndex,
		articleHash,
		mineruHash,
	});
	if (contractErrors.length) {
		throw new Error(`生成的 MinerU 视觉派生契约未通过来源绑定：${contractErrors.slice(0, 5).join("；")}`);
	}
	const visualCandidates = buildVisualCandidates(viewerIndex, visualRepair);
	const candidateErrors = validateVisualCandidates(visualCandidates, viewerIndex, visualRepair);
	if (candidateErrors.length) {
		throw new Error(`生成的 MinerU 视觉候选契约未通过来源绑定：${candidateErrors.slice(0, 5).join("；")}`);
	}
	const extractionDir = path.join(packageRoot, "_extraction");
	fs.mkdirSync(extractionDir, { recursive: true });
	fs.writeFileSync(
		path.join(extractionDir, "viewer-index.json"),
		JSON.stringify(viewerIndex, null, 2) + "\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(extractionDir, "visual-repair.json"),
		JSON.stringify(visualRepair, null, 2) + "\n",
		"utf8",
	);
	fs.writeFileSync(
		path.join(extractionDir, "visual-candidates.json"),
		JSON.stringify(visualCandidates, null, 2) + "\n",
		"utf8",
	);
	return {
		viewerStatus: viewerIndex.status,
		repairStatus: visualRepair.status,
		candidateStatus: visualCandidates.status,
		groupCount: visualRepair.groups.length,
		autoGroupCount: visualRepair.groups.filter((group) => group.decision === "auto").length,
		candidateCount: visualCandidates.candidates.length,
	};
}

function createOnlyError(citekey: string, concurrent = false, stagingDetail = ""): Error {
	const detail = concurrent ? "（发布期间出现并发目标）" : "";
	return new Error(`papers/${citekey} 已存在${detail}${stagingDetail}，轻量入库不会覆盖（请更换 citekey 或使用完整入库）`);
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

/**
 * Resolve papers/ only after proving that the direct Vault child is a normal
 * directory whose real path remains inside the real Vault root. In particular,
 * a pre-existing Windows junction must never redirect staging/source.pdf to a
 * location outside the active Vault.
 */
function ensureTrustedPapersRoot(vaultRoot: string): string {
	const configuredVaultRoot = path.resolve(vaultRoot);
	let vaultStats: fs.Stats;
	try {
		vaultStats = fs.lstatSync(configuredVaultRoot);
	} catch {
		throw new Error("当前 Vault 根目录不存在或不可访问");
	}
	if (!vaultStats.isDirectory() && !vaultStats.isSymbolicLink()) {
		throw new Error("当前 Vault 根路径不是目录");
	}
	const realVaultRoot = realPathSync(configuredVaultRoot);
	const papersRoot = path.join(configuredVaultRoot, "papers");
	try {
		fs.mkdirSync(papersRoot);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
		if (code !== "EEXIST") throw error;
	}
	const directStats = fs.lstatSync(papersRoot);
	if (directStats.isSymbolicLink()) {
		throw new Error("Vault 的 papers 目录不能是符号链接或 junction");
	}
	if (!directStats.isDirectory()) throw new Error("Vault 的 papers 路径不是目录");
	const realPapersRoot = realPathSync(papersRoot);
	if (!isPathInside(realVaultRoot, realPapersRoot)) {
		throw new Error("Vault 的 papers 目录解析到当前 Vault 之外");
	}
	return papersRoot;
}

function acquirePublishLock(papersRoot: string, citekey: string): () => void {
	const locksRoot = path.join(papersRoot, ".locks");
	try { fs.mkdirSync(locksRoot); } catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		if (code !== "EEXIST") throw error;
	}
	const lockRootStats = fs.lstatSync(locksRoot);
	if (lockRootStats.isSymbolicLink() || !lockRootStats.isDirectory()) {
		throw new Error("papers/.locks 必须是普通目录");
	}
	if (!isPathInside(realPathSync(papersRoot), realPathSync(locksRoot))) {
		throw new Error("papers/.locks 解析到 papers 之外");
	}
	const lockPath = path.join(locksRoot, `${citekey}.lock`);
	let descriptor: number;
	try {
		descriptor = fs.openSync(lockPath, "wx", 0o600);
		fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		if (code === "EEXIST") throw new Error(`papers/${citekey} 正在由另一个入库任务发布`);
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
		try {
			const stats = fs.lstatSync(lockPath);
			if (!stats.isSymbolicLink() && stats.isFile()) fs.unlinkSync(lockPath);
		} catch { /* Best effort; stale lock remains visible and fails closed. */ }
	};
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Remove one private staging tree without ever following symbolic links or
 * Windows junctions. Every directory is removed only after its direct
 * children; reparse-point entries are unlinked as entries, not traversed.
 */
function removeTreeNoFollow(root: string): void {
	if (!fs.existsSync(root)) return;
	const rootStats = fs.lstatSync(root);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		fs.unlinkSync(root);
		return;
	}
	const stack: Array<{ directory: string; visited: boolean }> = [
		{ directory: root, visited: false },
	];
	while (stack.length) {
		const current = stack.pop();
		if (!current) continue;
		if (current.visited) {
			fs.rmdirSync(current.directory);
			continue;
		}
		stack.push({ directory: current.directory, visited: true });
		const handle = fs.opendirSync(current.directory);
		try {
			for (;;) {
				const entry = handle.readSync();
				if (!entry) break;
				const child = path.join(current.directory, entry.name);
				const stats = fs.lstatSync(child);
				if (stats.isDirectory() && !stats.isSymbolicLink()) {
					stack.push({ directory: child, visited: false });
				} else {
					fs.unlinkSync(child);
				}
			}
		} finally {
			handle.closeSync();
		}
	}
}

function cleanPublishStaging(
	stagingContainer: string,
	papersRoot: string,
	citekey: string,
): boolean {
	const relative = path.relative(papersRoot, stagingContainer);
	if (
		!relative
		|| path.dirname(relative) !== "."
		|| !path.basename(relative).startsWith(`.${citekey}.staging-`)
	) {
		console.warn("Refused to clean an unexpected MinerU publish staging path", stagingContainer);
		return false;
	}
	try {
		removeTreeNoFollow(stagingContainer);
		return !fs.existsSync(stagingContainer);
	} catch (cleanupError) {
		console.warn("Could not clean failed MinerU vault staging directory", cleanupError);
		return false;
	}
}

function retainedStagingDetail(cleaned: boolean, stagingContainer: string): string {
	return cleaned ? "" : `；staging 清理失败并保留：${path.basename(stagingContainer)}`;
}

/**
 * Copies a fully validated package into a hidden staging directory on the
 * same filesystem as papers/, then exposes it with one directory rename.
 * Failed copies/renames are cleaned on a best-effort basis; if cleanup itself
 * fails, only the named hidden staging directory can remain. The final citekey
 * directory is never populated incrementally.
 */
function publishValidatedPackageAtomically(
	packageRoot: string,
	papersRoot: string,
	citekey: string,
	context: MineruPublishContext,
	customOps?: Partial<MineruPublishOps>,
): string {
	const packageTarget = path.join(papersRoot, citekey);
	if (fs.existsSync(packageTarget)) throw createOnlyError(citekey, true);

	const stagingContainer = fs.mkdtempSync(path.join(papersRoot, `.${citekey}.staging-`));
	const stagedPackage = path.join(stagingContainer, "package");
	const copyPackage = customOps?.copyPackage
		|| ((source: string, destination: string): void => {
			copyInventoriedTree(source, destination);
		});
	const renamePackage = customOps?.renamePackage
		|| ((source: string, destination: string): void => fs.renameSync(source, destination));

	try {
		copyPackage(packageRoot, stagedPackage);
	} catch (error) {
		const cleaned = cleanPublishStaging(stagingContainer, papersRoot, citekey);
		throw new Error(
			`MinerU 包复制到同卷 staging 失败；最终目录未创建${retainedStagingDetail(cleaned, stagingContainer)}；${errorDetail(error)}`,
		);
	}

	try {
		inventoryTree(stagedPackage);
		if (context.signal.aborted) throw new Error("任务已取消");
		if (context.validateBeforeCommit) {
			const articleMarkdown = fs.readFileSync(path.join(stagedPackage, "article.md"), "utf8");
			context.validateBeforeCommit(articleMarkdown);
		}
		if (context.signal.aborted) throw new Error("任务已取消");
	} catch (error) {
		const cleaned = cleanPublishStaging(stagingContainer, papersRoot, citekey);
		const detail = retainedStagingDetail(cleaned, stagingContainer);
		if (error instanceof MineruPreCommitValidationError) {
			throw new MineruPreCommitValidationError(error.message, {
				cleanupFailed: !cleaned,
				stagingBasename: cleaned ? "" : path.basename(stagingContainer),
			});
		}
		throw new Error(
			`MinerU 包发布前校验失败；最终目录未创建${detail}；${errorDetail(error)}`,
		);
	}

	// Re-check after the potentially long copy. Correct concurrent publishers
	// expose a complete, non-empty directory with rename, so a later rename
	// also fails without replacing their package on supported desktop hosts.
	if (fs.existsSync(packageTarget)) {
		const cleaned = cleanPublishStaging(stagingContainer, papersRoot, citekey);
		throw createOnlyError(citekey, true, retainedStagingDetail(cleaned, stagingContainer));
	}
	try {
		renamePackage(stagedPackage, packageTarget);
	} catch (error) {
		const targetExists = fs.existsSync(packageTarget);
		const cleaned = cleanPublishStaging(stagingContainer, papersRoot, citekey);
		if (targetExists) {
			throw createOnlyError(citekey, true, retainedStagingDetail(cleaned, stagingContainer));
		}
		throw new Error(
			`MinerU 包原子提交失败；最终目录未创建${retainedStagingDetail(cleaned, stagingContainer)}；${errorDetail(error)}`,
		);
	}

	// rename moved the only child away; removing an empty container is safe and
	// non-recursive. Failure here does not invalidate the committed package.
	try {
		fs.rmdirSync(stagingContainer);
	} catch (cleanupError) {
		console.warn("Could not clean empty MinerU vault staging directory", cleanupError);
	}
	return packageTarget;
}

/**
 * Runs MinerU on the user-authorized PDF and publishes a reader-compatible
 * package into the active vault — create-only, abortable, no Python and no
 * toolkit required.
 */
export async function publishMineruPackage(
	deps: MineruPublishDeps,
	args: MineruPublishArgs,
	context: MineruPublishContext,
): Promise<MineruPackageReceipt> {
	if (context.signal.aborted) throw new Error("任务已取消");
	if (!deps.mineruExecutable.trim()) throw new Error("未配置 MinerU CLI（npm 全局安装 mineru-open-api 后在设置中配置）");
	if (!CITEKEY_PATTERN.test(args.citekey)) {
		throw new Error(`citekey 不合法（字母数字 ._ -，不以符号开头）：${args.citekey}`);
	}
	if (!deps.vaultRoot) throw new Error("无法定位当前 Vault 的文件系统位置");
	const source = path.resolve(args.source);
	if (!source.toLowerCase().endsWith(".pdf") || !fs.existsSync(source)) {
		throw new Error(`来源 PDF 不存在：${source}`);
	}
	const sourceStats = fs.lstatSync(source);
	if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
		throw new Error("MinerU 输入必须是插件创建的普通 PDF 快照");
	}
	const expectedSourceHash = String(args.expectedSourceSha256 || "").toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(expectedSourceHash) || sha256File(source) !== expectedSourceHash) {
		throw new Error("PDF 授权快照与身份预检哈希不一致，未启动 MinerU");
	}
	const pages = normalizePagesValue(args.pages);
	const initialPapersRoot = ensureTrustedPapersRoot(deps.vaultRoot);
	const releasePublishLock = acquirePublishLock(initialPapersRoot, args.citekey);
	try {
		const packageTarget = path.join(initialPapersRoot, args.citekey);
		if (fs.existsSync(packageTarget)) {
			throw createOnlyError(args.citekey);
		}
		const resolved = resolveMineruCommand(deps.mineruExecutable);
		const stageRoot = deps.stageRoot || os.tmpdir();
		const stage = fs.mkdtempSync(path.join(stageRoot, "mineru-publish-"));
		try {
		if (context.signal.aborted) throw new Error("任务已取消");
		const extractDir = path.join(stage, "extract");
		fs.mkdirSync(extractDir, { recursive: true });
		const versionResult = await deps.runCommand({
			command: resolved.command,
			baseArgs: resolved.baseArgs,
			cliArgs: ["version"],
			cwd: stage,
			timeoutMs: 15_000,
			signal: context.signal,
		}).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
		const extractorVersion = normalizeExtractorVersion(versionResult.stdout);

		const publishTimeoutMs = Math.min(
			context.timeoutMs,
			Math.max(60, Math.min(1800, Math.round(args.timeoutSeconds) || 600)) * 1000 + 30_000,
		);
		const result = await deps.runCommand({
			command: resolved.command,
			baseArgs: resolved.baseArgs,
			cliArgs: mineruCliArgs({ ...args, pages }, extractDir),
			cwd: stage,
			timeoutMs: publishTimeoutMs,
			signal: context.signal,
		});
		if (context.signal.aborted) throw new Error("任务已取消，MinerU 子进程已终止");
		if (result.exitCode !== 0) {
			const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).pop() || "无错误详情";
			throw new Error(`MinerU 退出码 ${result.exitCode}：${detail.slice(0, 300)}`);
		}

		const outputs = locateMineruOutputs(extractDir);
		const packageRoot = path.join(stage, "package");
		fs.mkdirSync(packageRoot);
		fs.copyFileSync(outputs.markdown, path.join(packageRoot, "article.md"));
		fs.copyFileSync(outputs.json, path.join(packageRoot, "mineru-result.json"));
		const extractedMarkdown = fs.readFileSync(outputs.markdown, "utf8");
		const extractedPayload = JSON.parse(fs.readFileSync(outputs.json, "utf8")) as unknown;
		copyReferencedAssets(
			extractDir,
			path.dirname(outputs.markdown),
			packageRoot,
			extractedMarkdown,
			extractedPayload,
		);
		const extractionDir = path.join(packageRoot, "_extraction");
		if (args.includeSourcePdf) {
			fs.mkdirSync(extractionDir, { recursive: true });
			fs.copyFileSync(source, path.join(extractionDir, "source.pdf"));
		}

		fs.mkdirSync(extractionDir, { recursive: true });
		const baseValidation = validateStagedPackage(packageRoot);
		const contractSummary = writeDerivedViewerContracts(packageRoot, args.includeSourcePdf);
		const validation = {
			...baseValidation,
			checks: {
				...(baseValidation.checks as Record<string, unknown>),
				viewer_index_contract_valid: true,
				visual_repair_contract_valid: true,
				visual_candidates_contract_valid: true,
			},
			viewer_index_status: contractSummary.viewerStatus,
			visual_repair_status: contractSummary.repairStatus,
			visual_candidates_status: contractSummary.candidateStatus,
			visual_repair_group_count: contractSummary.groupCount,
			visual_repair_auto_group_count: contractSummary.autoGroupCount,
			visual_candidates_count: contractSummary.candidateCount,
		};
		fs.writeFileSync(
			path.join(extractionDir, "validation.json"),
			JSON.stringify(validation, null, 2) + "\n",
			"utf8",
		);
		const manifest = buildManifest({
			sourcePdf: source,
			options: args,
			extractorVersion,
			extractorExecutable: deps.mineruExecutable,
			packageRoot,
			includeSourcePdf: args.includeSourcePdf,
			createdIso: (deps.now || (() => new Date()))().toISOString(),
		});
		fs.writeFileSync(
			path.join(extractionDir, "manifest.json"),
			JSON.stringify(manifest, null, 2) + "\n",
			"utf8",
		);

		// Re-resolve immediately before creating same-volume staging: a papers/
		// junction introduced during the long remote extraction must fail closed.
		const commitPapersRoot = ensureTrustedPapersRoot(deps.vaultRoot);
		const committedPath = publishValidatedPackageAtomically(
			packageRoot,
			commitPapersRoot,
			args.citekey,
			context,
			deps.publishOps,
		);
		return { packagePath: committedPath, validation };
		} finally {
			try {
				removeTreeNoFollow(stage);
			} catch (cleanupError) {
				console.warn("Could not clean MinerU staging directory", cleanupError);
			}
		}
	} finally {
		releasePublishLock();
	}
}
