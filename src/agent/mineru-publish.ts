import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

export interface ResolvedMineruCommand {
	command: string;
	baseArgs: string[];
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
			if (segments[0]?.toLowerCase() !== "node_modules" || segments.includes("..")) continue;
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
		return { command: process.execPath, baseArgs: [resolved] };
	}
	if (ext !== ".cmd" && ext !== ".bat") {
		return { command: resolved, baseArgs: [] };
	}
	const shimStats = fs.lstatSync(resolved);
	if (shimStats.isSymbolicLink() || !shimStats.isFile()) {
		throw new Error(`MinerU npm shim 必须是普通文件：${resolved}`);
	}
	const shim = fs.readFileSync(resolved, "utf8");
	const entry = resolveNpmShimEntry(resolved, shim);
	if (entry) return { command: process.execPath, baseArgs: [entry] };
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
	return sha256Bytes(fs.readFileSync(file));
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

function listFilesRecursive(root: string): string[] {
	const results: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const child = path.join(current, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) results.push(child);
		}
	};
	walk(root);
	return results;
}

/** Mirrors the toolkit helper: exactly one .md, one unambiguous MinerU JSON. */
function locateMineruOutputs(extractDir: string): { markdown: string; json: string } {
	const files = listFilesRecursive(extractDir);
	const markdownFiles = files.filter((file) => file.toLowerCase().endsWith(".md"));
	if (markdownFiles.length !== 1) {
		throw new Error(`MinerU 输出应只有一个 .md，实际 ${markdownFiles.length} 个`);
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
		throw new Error(`MinerU 输出应有唯一无歧义的 JSON，实际 ${jsonFiles.length} 个`);
	}
	return { markdown: markdownFiles[0], json: jsonFile };
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
	const flattened: MineruElement[] = [];
	const push = (item: unknown, pageIdx: number): void => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("mineru-result.json 含非对象元素");
		}
		const record = item as Record<string, unknown>;
		const page = pageIdx >= 0 ? pageIdx : record.page_idx;
		if (typeof page !== "number" || !Number.isInteger(page) || page < 0) {
			throw new Error("mineru-result.json 元素缺少有效 page_idx");
		}
		const asset = collectAssetFromItem(record);
		flattened.push({ pageIdx: page, assetPaths: asset ? [asset] : [] });
	};
	if (payload.every((page) => Array.isArray(page))) {
		for (let pageIndex = 0; pageIndex < (payload as unknown[][]).length; pageIndex += 1) {
			const page = (payload as unknown[][])[pageIndex];
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
	const register = (absolutePath: string): void => {
		const relative = path.relative(inputs.packageRoot, absolutePath).split(path.sep).join("/");
		const size = fs.statSync(absolutePath).size;
		if (size > MAX_PUBLISH_ASSET_BYTES) {
			throw new Error(`包内文件超过发布上限（256MiB）：${relative}`);
		}
		outputs.push({ path: relative, size, sha256: sha256File(absolutePath) });
	};
	register(path.join(inputs.packageRoot, "article.md"));
	register(path.join(inputs.packageRoot, "mineru-result.json"));
	const imagesDir = path.join(inputs.packageRoot, "images");
	if (fs.existsSync(imagesDir)) {
		for (const file of listFilesRecursive(imagesDir)) register(file);
	}
	if (inputs.includeSourcePdf) {
		register(path.join(inputs.packageRoot, "_extraction", "source.pdf"));
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
			path: portableBasename(inputs.sourcePdf),
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
		derived_contracts: [],
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

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		if (fs.existsSync(stagingContainer) && fs.lstatSync(stagingContainer).isSymbolicLink()) {
			console.warn("Refused to recursively clean a symlinked MinerU staging directory", stagingContainer);
			return false;
		}
		fs.rmSync(stagingContainer, { recursive: true, force: true });
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
			fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
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
	const pages = normalizePagesValue(args.pages);
	const initialPapersRoot = ensureTrustedPapersRoot(deps.vaultRoot);
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
		const imagesSource = path.join(path.dirname(outputs.markdown), "images");
		if (fs.existsSync(imagesSource)) {
			fs.cpSync(imagesSource, path.join(packageRoot, "images"), { recursive: true });
		}
		const extractionDir = path.join(packageRoot, "_extraction");
		if (args.includeSourcePdf) {
			fs.mkdirSync(extractionDir, { recursive: true });
			fs.copyFileSync(source, path.join(extractionDir, "source.pdf"));
		}

		const validation = validateStagedPackage(packageRoot);
		fs.mkdirSync(extractionDir, { recursive: true });
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
			fs.rmSync(stage, { recursive: true, force: true });
		} catch (cleanupError) {
			console.warn("Could not clean MinerU staging directory", cleanupError);
		}
	}
}
