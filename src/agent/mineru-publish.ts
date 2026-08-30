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

const CITEKEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_PUBLISH_ASSET_BYTES = 256 * 1024 * 1024;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

export interface ResolvedMineruCommand {
	command: string;
	baseArgs: string[];
}

/**
 * Resolves how to launch the configured MinerU CLI without a shell (shell
 * mode is banned in this plugin). npm installs CLIs as .cmd shims that
 * spawn() refuses on Windows; instead of shelling out, we read the shim and
 * launch its node entry script directly.
 */
export function resolveMineruCommand(executable: string): ResolvedMineruCommand {
	const resolved = path.resolve(String(executable || "").trim());
	if (!resolved) throw new Error("未配置 MinerU CLI");
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
	const shim = fs.readFileSync(resolved, "utf8");
	const quoted = /"%~dp0\\?([^"\r\n]+?\.(?:js|mjs|cjs))"/i.exec(shim);
	const bare = /node_modules[\\/][^"\r\n]*?\.(?:js|mjs|cjs)/i.exec(shim);
	const relative = quoted?.[1] || bare?.[0] || "";
	if (relative) {
		const entry = path.resolve(
			path.dirname(resolved),
			relative.replace(/^%~dp0[\\/]?/, "").replace(/\\/g, "/"),
		);
		if (fs.existsSync(entry)) {
			return { command: process.execPath, baseArgs: [entry] };
		}
	}
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
		extractor_executable: inputs.extractorExecutable,
		created_at: inputs.createdIso,
		processing_depth: "conversion-only",
		source: {
			path: inputs.sourcePdf,
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

/**
 * Runs MinerU on the user-authorized PDF and publishes a reader-compatible
 * package into the active vault — create-only, abortable, no Python and no
 * toolkit required.
 */
export async function publishMineruPackage(
	deps: MineruPublishDeps,
	args: MineruPublishArgs,
	context: { signal: AbortSignal; timeoutMs: number },
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
	const packageTarget = path.join(deps.vaultRoot, "papers", args.citekey);
	if (fs.existsSync(packageTarget)) {
		throw new Error(`papers/${args.citekey} 已存在，轻量入库不会覆盖（请更换 citekey 或使用完整入库）`);
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
		const extractorVersion = versionResult.stdout.trim().split(/\r?\n/)
			.find((line) => line.trim()) || "unknown";

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

		fs.cpSync(packageRoot, packageTarget, { recursive: true, force: false, errorOnExist: true });
		return { packagePath: packageTarget, validation };
	} finally {
		try {
			fs.rmSync(stage, { recursive: true, force: true });
		} catch (cleanupError) {
			console.warn("Could not clean MinerU staging directory", cleanupError);
		}
	}
}
