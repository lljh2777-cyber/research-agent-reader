import { normalizePath, TFile } from "obsidian";

import { searchTavily, type WebSearchHttpDeps } from "../services/web-search";
import type { AgentTool, AgentToolContext } from "./types";

/** Max characters of one vault file handed to the model per read. */
const VAULT_READ_CHAR_LIMIT = 16000;
const VAULT_LIST_LIMIT = 200;

export interface VaultToolDeps {
	app: {
		vault: {
			getAbstractFileByPath(path: string): unknown;
			getMarkdownFiles(): Array<{ path: string }>;
			getFiles(): Array<{ path: string; extension?: string }>;
			read(file: TFile): Promise<string>;
			adapter: {
				exists(path: string, sensitive?: boolean): Promise<boolean>;
				write(path: string, data: string): Promise<void>;
				mkdir(path: string): Promise<void>;
				read(path: string): Promise<string>;
			};
		};
	};
}

export interface HttpToolDeps {
	httpGetJson(
		url: string,
		timeoutMs: number,
		options?: { signal?: AbortSignal },
	): Promise<{ status: number; json: unknown; text: string }>;
}

export interface MineruToolDeps {
	/** Resolved toolkit project root, or empty when not configured. */
	toolkitRoot: string;
	mineruExecutable: string;
	mineruBaseUrl: string;
	pythonExecutable: string;
	/** Spawns the MinerU helper; injectable for tests. */
	runHelper(args: {
		pythonExecutable: string;
		helperPath: string;
		cliArgs: string[];
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
	}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function normalizeVaultRelative(raw: string): string {
	return normalizePath(String(raw || "").trim()).replace(/^\/+/, "");
}

function pathEscapesScope(path: string): boolean {
	return path.split("/").some((segment) => segment === ".." || segment === "");
}

function withinPrefixes(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Read-scoped vault read tool. The ingest flow only needs wiki/sources and
 * papers; broader vault content stays outside the model's reach so untrusted
 * tool output cannot steer it into unrelated files.
 */
export function createVaultReadTool(deps: VaultToolDeps, allowedPrefixes: readonly string[]): AgentTool {
	return {
		name: "vault_read",
		description: `读取知识库中的一个文本文件（Markdown/JSON/CSV/BibTeX），只允许这些前缀：${allowedPrefixes.join("、")}。长文件分页返回，可用 offset 继续读。`,
		parameters: {
			path: "vault 内相对路径，例如 papers/example_2026/article.md",
			offset: "可选，从第几个字符开始读，默认 0",
		},
		required: ["path"],
		async execute(args) {
			const raw = String(args.path || "").trim();
			const path = normalizeVaultRelative(raw);
			if (!path || pathEscapesScope(path)) throw new Error(`非法路径：${raw}`);
			if (!withinPrefixes(path, allowedPrefixes)) {
				throw new Error(`路径超出读取范围（只允许 ${allowedPrefixes.join("、")}）：${path}`);
			}
			const file = deps.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new Error(`文件不存在：${path}`);
			if (["png", "jpg", "jpeg", "webp", "gif", "pdf"].includes(file.extension.toLowerCase())) {
				throw new Error(`vault_read 只支持文本文件，收到 .${file.extension}`);
			}
			const content = await deps.app.vault.read(file);
			const offset = Math.max(0, Math.round(Number(args.offset)) || 0);
			const slice = content.slice(offset, offset + VAULT_READ_CHAR_LIMIT);
			const header = `path=${path} 共 ${content.length} 字符，本次返回 ${slice.length}（offset ${offset}）`;
			return {
				output: `${header}\n\n${slice}${offset + slice.length < content.length ? "\n…[未完，用 offset 继续读]" : ""}`,
				summary: header,
			};
		},
	};
}

export function createVaultListTool(deps: VaultToolDeps, allowedPrefixes: readonly string[]): AgentTool {
	return {
		name: "vault_list",
		description: `列出知识库中某个目录下的文件路径（含子目录），只允许这些前缀：${allowedPrefixes.join("、")}。用于发现已有 sources 笔记和 papers 包。`,
		parameters: {
			folder: "可选，目录前缀，例如 papers 或 wiki/sources；留空列出范围内全部 Markdown",
			extension: "可选，按扩展名过滤，例如 pdf；默认 md",
		},
		required: [],
		async execute(args) {
			const folder = normalizeVaultRelative(String(args.folder || ""));
			if (folder && !withinPrefixes(folder, allowedPrefixes) && !allowedPrefixes.some((prefix) => prefix.startsWith(folder))) {
				throw new Error(`目录超出读取范围（只允许 ${allowedPrefixes.join("、")}）：${folder}`);
			}
			const extension = String(args.extension || "md").replace(/^\./, "").toLowerCase();
			const source = extension === "md"
				? deps.app.vault.getMarkdownFiles()
				: deps.app.vault.getFiles();
			const paths = source
				.map((file) => String(file.path || ""))
				.filter((path) => withinPrefixes(path, allowedPrefixes))
				.filter((path) => (folder ? path === folder || path.startsWith(`${folder}/`) : true))
				.filter((path) => path.toLowerCase().endsWith(`.${extension}`))
				.sort()
				.slice(0, VAULT_LIST_LIMIT);
			return {
				output: paths.length ? paths.join("\n") : "该目录下没有匹配文件。",
				summary: `${paths.length} 个 .${extension} 文件`,
			};
		},
	};
}

/**
 * Crossref bibliographic search. The plugin owns the URL; the model only
 * supplies the query string, so untrusted content cannot point the request
 * at arbitrary paths or hosts.
 */
export function createCrossrefSearchTool(deps: HttpToolDeps): AgentTool {
	return {
		name: "crossref_search",
		description: "在 Crossref 中按标题/关键词检索文献元数据（DOI、作者、年份、期刊）。返回前 5 条候选。",
		parameters: {
			query: "标题或书目关键词，例如：Novae a graph-based foundation model",
		},
		required: ["query"],
		async execute(args, context) {
			const query = String(args.query || "").trim().slice(0, 300);
			if (!query) throw new Error("crossref_search 需要 query 参数");
			const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5`;
			const response = await deps.httpGetJson(url, 20_000, { signal: context.signal });
			if (response.status !== 200) throw new Error(`Crossref HTTP ${response.status}`);
			const items = extractCrossrefItems(response.json);
			if (!items.length) return { output: "Crossref 没有返回候选。", summary: "0 条候选" };
			return {
				output: items.join("\n\n"),
				summary: `${items.length} 条候选`,
			};
		},
	};
}

export function createCrossrefDoiTool(deps: HttpToolDeps): AgentTool {
	return {
		name: "crossref_doi",
		description: "按 DOI 精确查询 Crossref 元数据，用于核验候选 DOI 与标题是否一致。",
		parameters: {
			doi: "DOI，例如 10.1038/s41586-024-08153-9",
		},
		required: ["doi"],
		async execute(args, context) {
			const doi = String(args.doi || "").trim().replace(/^https?:\/\/doi\.org\//i, "");
			if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error(`DOI 格式不合法：${doi}`);
			const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
			const response = await deps.httpGetJson(url, 20_000, { signal: context.signal });
			if (response.status === 404) throw new Error(`Crossref 没有这个 DOI：${doi}`);
			if (response.status !== 200) throw new Error(`Crossref HTTP ${response.status}`);
			const items = extractCrossrefItems(response.json);
			if (!items.length) throw new Error("Crossref 返回无法解析");
			return { output: items.join("\n\n"), summary: `DOI ${doi} 已核验` };
		},
	};
}

function extractCrossrefItems(json: unknown): string[] {
	const message = (json as { message?: { items?: unknown } } | null)?.message;
	const rawItems = Array.isArray(message?.items) ? message.items : [message];
	return rawItems.filter(Boolean).slice(0, 5).map((item, index) => {
		const record = item as {
			DOI?: string;
			title?: string[];
			author?: Array<{ given?: string; family?: string }>;
			issued?: { "date-parts"?: number[][] };
			"container-title"?: string[];
			type?: string;
		};
		const title = String(record.title?.[0] || "（无标题）");
		const authors = (record.author || []).slice(0, 4)
			.map((author) => [author.family, author.given].filter(Boolean).join(" "))
			.filter(Boolean)
			.join("; ");
		const year = record.issued?.["date-parts"]?.[0]?.[0] || "";
		const container = String(record["container-title"]?.[0] || "");
		return [
			`[${index + 1}] DOI: ${record.DOI || "（无）"}`,
			`标题: ${title}`,
			authors ? `作者: ${authors}` : "",
			year ? `年份: ${year}` : "",
			container ? `期刊: ${container}` : "",
		].filter(Boolean).join("\n");
	});
}

export function createVaultSearchTool(retriever: {
	retrieve(
		question: string,
		expandedTerms?: string[],
		options?: { allowedPrefixes?: string[] },
	): Promise<Record<string, unknown>>;
}, allowedPrefixes: readonly string[]): AgentTool {
	return {
		name: "vault_search",
		description: `在知识库中按关键词做词法检索（范围限定：${allowedPrefixes.join("、")}），返回最相关的笔记路径与标题。用于查重（找已有 sources 笔记）。`,
		parameters: {
			question: "检索问题或关键词，例如论文标题、方法名、DOI",
			limit: "可选，返回条数上限，默认 8，最大 20",
		},
		required: ["question"],
		async execute(args) {
			const question = String(args.question || "").trim();
			if (!question) throw new Error("vault_search 需要 question 参数");
			const limit = Math.max(1, Math.min(20, Math.round(Number(args.limit)) || 8));
			// Scoping happens inside the retriever so ranking itself never
			// considers out-of-scope files; the belt-and-braces output filter
			// below guarantees no out-of-scope path can reach the model.
			const result = await retriever.retrieve(question, [], { allowedPrefixes: [...allowedPrefixes] });
			const seeds = Array.isArray(result.lexical_seeds) ? result.lexical_seeds : [];
			const inScope = seeds.filter((seed) => {
				const path = String((seed as { path?: string }).path || "").replace(/\\/g, "/");
				return allowedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
			});
			const lines = inScope
				.slice(0, limit)
				.map((seed, index) => {
					const record = seed as { path?: string; title?: string; score?: number };
					return `${index + 1}. ${String(record.path || "")} — ${String(record.title || "").slice(0, 120)}（score ${Number(record.score || 0).toFixed(2)}）`;
				});
			return {
				output: lines.length
					? `共 ${inScope.length} 个候选，前 ${lines.length}：\n${lines.join("\n")}`
					: "没有找到相关笔记。",
				summary: `${inScope.length} 个候选`,
			};
		},
	};
}

export interface TavilySearchDeps {
	http: WebSearchHttpDeps;
	apiKey: string;
	maxResults: number;
	timeoutMs: number;
}

export function createWebSearchTool(deps: TavilySearchDeps): AgentTool {
	return {
		name: "web_search",
		description: "用 Tavily 做联网搜索，返回带编号的网页摘要。用于元数据核验和浅层查证；每次最多 3 个查询词。",
		parameters: {
			queries: "JSON 数组，1–3 个检索词，例如 [\"DeepSeek-R1 Nature title\"]",
		},
		required: ["queries"],
		async execute(args, context) {
			if (context.signal.aborted) throw new Error("任务已取消");
			if (!deps.apiKey) throw new Error("未配置 Tavily API Key");
			const rawQueries = Array.isArray(args.queries) ? args.queries : [];
			const queries = rawQueries
				.map((query) => String(query || "").trim())
				.filter(Boolean)
				.slice(0, 3);
			if (!queries.length) throw new Error("web_search 需要至少一个检索词");
			const results = await searchTavily(deps.http, deps.apiKey, queries, {
				maxResults: deps.maxResults,
				timeoutMs: Math.min(deps.timeoutMs, Math.max(5_000, context.remainingMs())),
			});
			if (!results.length) return { output: "没有搜索到结果。", summary: "0 条结果" };
			const blocks = results.map((result, index) => {
				return `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content.slice(0, 800)}`;
			});
			return {
				output: blocks.join("\n\n"),
				summary: `${results.length} 条结果`,
			};
		},
	};
}

export interface MineruExtractArgs {
	source: string;
	citekey: string;
	model?: string;
	language?: string;
	ocr?: boolean;
	formula?: boolean;
	table?: boolean;
	pages?: string;
	timeoutSeconds?: number;
	includeSourcePdf?: boolean;
}

export function buildMineruHelperArgs(
	deps: MineruToolDeps,
	args: MineruExtractArgs,
): { cliArgs: string[]; helperPath: string; cwd: string } | { error: string } {
	if (!deps.toolkitRoot.trim()) return { error: "未配置工具包目录（设置 → 工具链与运行环境），无法运行 MinerU 提取" };
	if (!deps.pythonExecutable.trim()) return { error: "未配置 Python 可执行文件，无法运行 MinerU 提取" };
	if (!deps.mineruExecutable.trim()) return { error: "未配置 MinerU CLI，无法生成原文 Markdown" };
	const citekey = String(args.citekey || "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(citekey)) {
		return { error: `citekey 不合法（字母数字 ._ -，不以符号开头）：${citekey}` };
	}
	const source = String(args.source || "").trim();
	if (!source.toLowerCase().endsWith(".pdf")) return { error: "source 必须是一个 PDF 路径" };
	const helperPath = `${deps.toolkitRoot.replace(/[\\/]+$/, "")}/tool-library/scripts/run_mineru_extract.py`;
	const cliArgs = [
		helperPath,
		"--project-root", deps.toolkitRoot,
		"--source", source,
		"--citekey", citekey,
		"--mineru", deps.mineruExecutable,
		"--model", ["vlm", "pipeline", "auto", "html"].includes(String(args.model)) ? String(args.model) : "vlm",
		"--language", String(args.language || "en"),
		"--timeout", String(Math.max(60, Math.min(1800, Math.round(Number(args.timeoutSeconds)) || 600))),
	];
	if (args.pages) cliArgs.push("--pages", String(args.pages));
	if (args.ocr === true) cliArgs.push("--ocr");
	if (args.formula === false) cliArgs.push("--no-formula");
	if (args.table === false) cliArgs.push("--no-table");
	if (args.includeSourcePdf === true) cliArgs.push("--include-source-pdf");
	if (deps.mineruBaseUrl.trim()) cliArgs.push("--base-url", deps.mineruBaseUrl.trim());
	return { cliArgs, helperPath, cwd: deps.toolkitRoot };
}

/** Probes whether the light agent can run the MinerU helper right now. */
export function mineruReadiness(deps: MineruToolDeps): { ready: boolean; reason: string } {
	if (!deps.toolkitRoot.trim()) return { ready: false, reason: "未配置工具包目录（设置 → 工具链与运行环境）" };
	if (!deps.pythonExecutable.trim()) return { ready: false, reason: "未配置 Python 可执行文件" };
	if (!deps.mineruExecutable.trim()) return { ready: false, reason: "未配置 MinerU CLI" };
	return { ready: true, reason: "" };
}

export interface MineruPackageReceipt {
	/** Absolute filesystem path of the published package (helper output). */
	packagePath: string;
	validation: Record<string, unknown> | null;
}

/**
 * Runs the MinerU helper for exactly the user-authorized PDF. The model has
 * no say over the source path — it is bound by the caller — and the helper
 * subprocess is killed promptly when the abort signal fires.
 */
export async function runAuthorizedMineruExtract(
	deps: MineruToolDeps,
	args: MineruExtractArgs,
	context: { signal: AbortSignal; timeoutMs: number },
): Promise<MineruPackageReceipt> {
	if (context.signal.aborted) throw new Error("任务已取消");
	const readiness = mineruReadiness(deps);
	if (!readiness.ready) throw new Error(readiness.reason);
	const built = buildMineruHelperArgs(deps, args);
	if ("error" in built) throw new Error(built.error);
	const result = await deps.runHelper({
		pythonExecutable: deps.pythonExecutable,
		helperPath: built.helperPath,
		cliArgs: built.cliArgs,
		cwd: built.cwd,
		timeoutMs: context.timeoutMs,
		signal: context.signal,
	});
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout || "").trim().split("\n").pop() || "";
		throw new Error(`MinerU 提取失败（exit ${result.exitCode}）：${detail.slice(0, 300)}`);
	}
	const line = result.stdout.trim().split("\n").filter(Boolean).pop() || "";
	let payload: { status?: string; package?: string; validation?: Record<string, unknown> } = {};
	try {
		payload = JSON.parse(line) as { status?: string; package?: string; validation?: Record<string, unknown> };
	} catch {
		throw new Error("MinerU helper 输出无法解析为 JSON");
	}
	if (payload.status !== "published" || !payload.package) {
		throw new Error(`MinerU helper 未发布成功：${line.slice(0, 200)}`);
	}
	return { packagePath: payload.package.replace(/\\/g, "/"), validation: payload.validation ?? null };
}

export interface SourceNoteFields {
	title: string;
	title_zh: string;
	authors: string;
	year: string;
	doi: string;
	researchQuestion: string;
	conclusion: string;
	motivation: string;
	evidenceGaps: string;
	notes: string[];
}

export interface SourceNoteWriteReceipt {
	path: string;
	operation: "create";
	charCount: number;
}

/**
 * Single-line, control-char-free, double-quoted YAML scalar. Model-supplied
 * text can never break out of a frontmatter value or inject new keys.
 */
export function yamlSafeScalar(value: string): string {
	const collapsed = String(value || "")
		.replace(/[\r\n\t]+/g, " ")
		// Strip C0 control characters and DEL.
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();
	return JSON.stringify(collapsed).replace(/</g, "\\u003c");
}

/**
 * Model-generated body fields may not contain any vault-internal link:
 * wikilinks, Markdown links/images (including reference definitions and
 * relative escapes), or HTML href/src. Only external web schemes and
 * in-document anchors are allowed. Controlled cross-references will be
 * generated by the plugin itself in a later iteration.
 */
function findDisallowedLinkTargets(body: string): string[] {
	const targets: string[] = [];
	for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
		targets.push(`wikilink:${match[1]}`);
	}
	for (const match of body.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
		targets.push(match[1]);
	}
	for (const match of body.matchAll(/^[ \t]*\[[^\]]+\]:[ \t]*(\S+)[ \t]*$/gm)) {
		targets.push(match[1]);
	}
	for (const match of body.matchAll(/<\w+[^>]*\b(?:href|src)=["']([^"']+)["'][^>]*>/gi)) {
		targets.push(match[1]);
	}
	return targets.filter((target) => !/^(https?:\/\/|mailto:|#)/i.test(target));
}

/**
 * Structural validation of the generated note: exactly one frontmatter
 * block with the required keys, and no vault-internal links in the body.
 * Returns human-readable violations; an empty array means safe.
 */
export function validateSourceNoteContent(content: string): string[] {
	const violations: string[] = [];
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!match) {
		violations.push("frontmatter 缺失或格式不正确");
		return violations;
	}
	const rest = content.slice(match[0].length);
	if (/^---\s*$/m.test(rest)) {
		violations.push("正文包含多余的 frontmatter 边界");
	}
	for (const required of ["title:", "title_zh:", "type: \"source\"", "depth: \"abstract-level\"", "registry_status: \"pending\""]) {
		if (!match[1].includes(required)) violations.push(`frontmatter 缺少 ${required}`);
	}
	const disallowed = findDisallowedLinkTargets(rest);
	if (disallowed.length) {
		violations.push(
			`正文包含不允许的 Vault 内部链接（${disallowed.slice(0, 3).map((target) => target.slice(0, 60)).join("、")}）；主目录间禁止互链，模型生成的正文字段暂不包含任何内部链接`,
		);
	}
	return violations;
}

function buildSourceNoteMarkdown(
	citekey: string,
	fields: SourceNoteFields,
	depthNote: string,
): string {
	const created = new Date().toISOString().slice(0, 10);
	const frontmatter = [
		"---",
		`title: ${yamlSafeScalar(fields.title)}`,
		`title_zh: ${yamlSafeScalar(fields.title_zh)}`,
		`citekey: ${yamlSafeScalar(citekey)}`,
		`authors: ${yamlSafeScalar(fields.authors)}`,
		`year: ${yamlSafeScalar(fields.year)}`,
		`doi: ${yamlSafeScalar(fields.doi)}`,
		"type: \"source\"",
		"depth: \"abstract-level\"",
		"ingest_mode: \"lightweight\"",
		"registry_status: \"pending\"",
		`created: ${yamlSafeScalar(created)}`,
		...(depthNote ? [depthNote] : []),
		"---",
	].join("\n");
	const body = [
		"",
		"# " + fields.title,
		"",
		"## 研究问题",
		fields.researchQuestion || "Vault 中未找到足够依据",
		"",
		"## 结论",
		fields.conclusion || "Vault 中未找到足够依据",
		"",
		"## 问题与动机",
		fields.motivation || "Vault 中未找到足够依据",
		...(fields.evidenceGaps ? ["", "## 证据缺口", fields.evidenceGaps] : []),
	].join("\n");
	return `${frontmatter}${body}\n`;
}

export interface VaultCreateDeps extends VaultToolDeps {
	app: {
		vault: VaultToolDeps["app"]["vault"] & {
			create(path: string, data: string): Promise<unknown>;
		};
	};
}

/**
 * Commits one source note at the citekey-derived path. Create-only via the
 * vault's atomic create (an existing note is never overwritten — the Codex
 * CLI pipeline owns updates); the plugin builds the YAML and section
 * structure from validated model fields, then reads the file back to verify
 * what was actually written.
 */
export async function commitSourceNote(
	deps: VaultCreateDeps,
	citekey: string,
	fields: SourceNoteFields,
	depthNote = "",
	options: { signal?: AbortSignal } = {},
): Promise<SourceNoteWriteReceipt> {
	if (options.signal?.aborted) throw new Error("任务已取消，未写入文件");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(citekey)) {
		throw new Error(`citekey 不合法：${citekey}`);
	}
	if (!fields.title.trim()) throw new Error("笔记缺少核验后的原文标题");
	const path = normalizePath(`wiki/sources/${citekey}.md`);
	if (pathEscapesScope(path)) throw new Error(`派生路径不合法：wiki/sources/${citekey}.md`);
	const content = buildSourceNoteMarkdown(citekey, fields, depthNote);
	const violations = validateSourceNoteContent(content);
	if (violations.length) {
		throw new Error(`生成的笔记未通过结构校验：${violations.join("；")}`);
	}
	const segments = path.split("/");
	for (let index = 1; index < segments.length; index += 1) {
		const folder = segments.slice(0, index).join("/");
		if (folder && !(await deps.app.vault.adapter.exists(folder, true))) {
			await deps.app.vault.adapter.mkdir(folder);
		}
	}
	if (options.signal?.aborted) throw new Error("任务已取消，未写入文件");
	// Atomic create: fails when the file appeared between the earlier dedup
	// check and now (another task or sync service), instead of overwriting.
	try {
		await deps.app.vault.create(path, content);
	} catch (createError) {
		const message = createError instanceof Error ? createError.message : String(createError);
		throw new Error(`创建笔记失败（已存在同名文件时不会覆盖）：${message.slice(0, 200)}`);
	}
	const written = await deps.app.vault.adapter.read(path);
	if (written !== content) {
		throw new Error("写入后回读校验不一致，请人工检查该文件");
	}
	return { path, operation: "create", charCount: content.length };
}

/** Write journal kept by the plugin as the source of truth for results. */
export class VaultWriteJournal {
	private readonly entries: SourceNoteWriteReceipt[] = [];

	record(receipt: SourceNoteWriteReceipt): void {
		if (this.entries.length >= 200) return;
		this.entries.push(receipt);
	}

	paths(): readonly string[] {
		return this.entries.map((entry) => entry.path);
	}

	receipts(): readonly SourceNoteWriteReceipt[] {
		return [...this.entries];
	}
}
