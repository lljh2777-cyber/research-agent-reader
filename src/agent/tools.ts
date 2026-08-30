import { normalizePath, TFile } from "obsidian";

import { searchTavily, type WebSearchHttpDeps } from "../services/web-search";
import type { AgentTool } from "./types";

/** Max characters of one vault file handed to the model per read. */
const VAULT_READ_CHAR_LIMIT = 16000;
const VAULT_LIST_LIMIT = 200;
const HTTP_JSON_CHAR_LIMIT = 12000;

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
			};
		};
	};
}

export interface HttpToolDeps {
	httpGetJson(url: string, timeoutMs: number): Promise<{ status: number; json: unknown; text: string }>;
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
	}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface WriteScopeRule {
	/** Vault-relative prefixes the flow may create or update. */
	allowedPrefixes: readonly string[];
	/** Optional vault subfolder that remaps plain prefixes (e.g. knowledge-base). */
	writeRootPrefix?: string;
}

const MAX_TRACKED_WRITES = 200;

/**
 * Paths written through writeNote during one run, kept for the caller to
 * report (and for future rollback) — the loop itself never deletes files.
 */
export class VaultWriteJournal {
	private readonly entries: string[] = [];

	record(path: string): void {
		if (this.entries.length >= MAX_TRACKED_WRITES) return;
		if (!this.entries.includes(path)) this.entries.push(path);
	}

	paths(): readonly string[] {
		return [...this.entries];
	}
}

function normalizeVaultRelative(raw: string): string {
	return normalizePath(String(raw || "").trim()).replace(/^\/+/, "");
}

function pathEscapesScope(path: string): boolean {
	return path.split("/").some((segment) => segment === ".." || segment === "");
}

function resolveScopedPath(path: string, scope: WriteScopeRule): string {
	const normalized = normalizeVaultRelative(path);
	const allowed = scope.allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
	if (!allowed) return "";
	const root = scope.writeRootPrefix
		? `${scope.writeRootPrefix}/${normalized}`
		: normalized;
	return pathEscapesScope(root) ? "" : normalizePath(root);
}

export function createVaultSearchTool(retriever: {
	retrieve(question: string, expandedTerms?: string[]): Promise<Record<string, unknown>>;
}): AgentTool {
	return {
		name: "vault_search",
		description: "在当前知识库中按关键词做词法检索，返回最相关的笔记路径与标题。用于查重（找已有 sources 笔记）和收集相关上下文。",
		parameters: {
			question: "检索问题或关键词，例如论文标题、方法名、DOI",
			limit: "可选，返回条数上限，默认 8，最大 20",
		},
		required: ["question"],
		async execute(args) {
			const question = String(args.question || "").trim();
			if (!question) throw new Error("vault_search 需要 question 参数");
			const limit = Math.max(1, Math.min(20, Math.round(Number(args.limit)) || 8));
			const result = await retriever.retrieve(question);
			const seeds = Array.isArray(result.lexical_seeds) ? result.lexical_seeds : [];
			const lines = seeds
				.slice(0, limit)
				.map((seed, index) => {
					const record = seed as { path?: string; title?: string; score?: number };
					return `${index + 1}. ${String(record.path || "")} — ${String(record.title || "").slice(0, 120)}（score ${Number(record.score || 0).toFixed(2)}）`;
				});
			return {
				output: lines.length
					? `共 ${seeds.length} 个候选，前 ${lines.length}：\n${lines.join("\n")}`
					: "没有找到相关笔记。",
				summary: `${seeds.length} 个候选`,
			};
		},
	};
}

export function createVaultReadTool(deps: VaultToolDeps): AgentTool {
	return {
		name: "vault_read",
		description: "读取知识库中的一个文本文件（Markdown/JSON/CSV/BibTeX）。长文件分页返回，可用 offset 继续读。",
		parameters: {
			path: "vault 内相对路径，例如 papers/example_2026/article.md",
			offset: "可选，从第几个字符开始读，默认 0",
		},
		required: ["path"],
		async execute(args) {
			const raw = String(args.path || "").trim();
			const path = normalizeVaultRelative(raw);
			if (!path || pathEscapesScope(path)) throw new Error(`非法路径：${raw}`);
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

export function createVaultListTool(deps: VaultToolDeps): AgentTool {
	return {
		name: "vault_list",
		description: "列出知识库中某个目录下的文件路径（含子目录）。用于发现已有 papers 包和 sources 笔记。",
		parameters: {
			folder: "可选，目录前缀，例如 papers 或 wiki/sources；留空列出全部 Markdown",
			extension: "可选，按扩展名过滤，例如 pdf；默认 md",
		},
		required: [],
		async execute(args) {
			const folder = normalizeVaultRelative(String(args.folder || ""));
			const extension = String(args.extension || "md").replace(/^\./, "").toLowerCase();
			const source = extension === "md"
				? deps.app.vault.getMarkdownFiles()
				: deps.app.vault.getFiles();
			const paths = source
				.map((file) => String(file.path || ""))
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
 * Allowlisted HTTP JSON fetch. Only https, only hosts on the flow's list —
 * the model cannot point it anywhere else.
 */
export function createHttpJsonTool(deps: HttpToolDeps, allowedHosts: readonly string[]): AgentTool {
	return {
		name: "http_get_json",
		description: `请求一个白名单域名的 HTTPS JSON 接口。当前白名单：${allowedHosts.join(", ")}。用于 Crossref/arXiv 元数据核验。`,
		parameters: {
			url: "完整 https:// URL，域名必须在白名单内",
		},
		required: ["url"],
		async execute(args) {
			const raw = String(args.url || "").trim();
			let parsed: URL;
			try {
				parsed = new URL(raw);
			} catch {
				throw new Error(`URL 无法解析：${raw}`);
			}
			if (parsed.protocol !== "https:") throw new Error("只允许 https:// 请求");
			const host = parsed.hostname.toLowerCase();
			if (!allowedHosts.includes(host)) {
				throw new Error(`域名 ${host} 不在白名单内：${allowedHosts.join(", ")}`);
			}
			const response = await deps.httpGetJson(parsed.toString(), 20_000);
			if (response.status !== 200) {
				throw new Error(`HTTP ${response.status}：${parsed.host}${parsed.pathname}`);
			}
			const text = response.json !== null
				? JSON.stringify(response.json, null, 1)
				: response.text;
			return {
				output: text.slice(0, HTTP_JSON_CHAR_LIMIT) || "(空响应)",
				summary: `${parsed.host}${parsed.pathname} → HTTP ${response.status}`,
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

export function createMineruExtractTool(deps: MineruToolDeps): AgentTool {
	return {
		name: "mineru_extract",
		description: "调用 MinerU 服务把一个 PDF 转成经过校验的原文包（article.md + JSON + 图片），发布到 papers/<citekey>/。成功后返回包路径。文档内容会上传到 MinerU 服务端。",
		parameters: {
			source: "本地 PDF 的绝对路径",
			citekey: "本篇文献的 citekey（阶段 1 已确定）",
			model: "可选：vlm（默认）/ pipeline / auto",
			language: "可选，文档语言代码，默认 en",
			ocr: "可选，扫描件 true",
			pages: "可选，页码范围如 1-10,15",
			timeoutSeconds: "可选，60–1800，默认 600",
			includeSourcePdf: "可选，true 时在包里附带原 PDF",
		},
		required: ["source", "citekey"],
		async execute(args) {
			const built = buildMineruHelperArgs(deps, {
				source: String(args.source || ""),
				citekey: String(args.citekey || ""),
				model: args.model === undefined ? undefined : String(args.model),
				language: args.language === undefined ? undefined : String(args.language),
				ocr: args.ocr === true,
				formula: args.formula !== false,
				table: args.table !== false,
				pages: args.pages === undefined ? "" : String(args.pages),
				timeoutSeconds: args.timeoutSeconds === undefined ? undefined : Number(args.timeoutSeconds),
				includeSourcePdf: args.includeSourcePdf === true,
			});
			if ("error" in built) throw new Error(built.error);
			const timeoutMs = 1800_000;
			const result = await deps.runHelper({
				pythonExecutable: deps.pythonExecutable,
				helperPath: built.helperPath,
				cliArgs: built.cliArgs,
				cwd: built.cwd,
				timeoutMs,
			});
			if (result.exitCode !== 0) {
				const detail = (result.stderr || result.stdout || "").trim().split("\n").pop() || "";
				throw new Error(`MinerU 提取失败（exit ${result.exitCode}）：${detail.slice(0, 300)}`);
			}
			const line = result.stdout.trim().split("\n").filter(Boolean).pop() || "";
			let payload: { status?: string; package?: string; validation?: Record<string, unknown> } = {};
			try {
				payload = JSON.parse(line) as { status?: string; package?: string };
			} catch {
				throw new Error("MinerU helper 输出无法解析为 JSON");
			}
			if (payload.status !== "published" || !payload.package) {
				throw new Error(`MinerU helper 未发布成功：${line.slice(0, 200)}`);
			}
			return {
				output: `MinerU 包已发布：${payload.package}\nvalidation：${JSON.stringify(payload.validation ?? {}).slice(0, 500)}`,
				summary: `已发布 ${payload.package}`,
			};
		},
	};
}

export function createWriteNoteTool(
	deps: VaultToolDeps,
	scope: WriteScopeRule,
	journal: VaultWriteJournal,
): AgentTool {
	return {
		name: "write_note",
		description: `在知识库中创建或覆盖一个文本文件。只允许写入这些前缀：${scope.allowedPrefixes.join("、")}。路径中的 .. 和越界都会被拒绝。`,
		parameters: {
			path: "vault 内相对路径，例如 wiki/sources/example_2026.md",
			content: "完整文件内容（Markdown）",
		},
		required: ["path", "content"],
		async execute(args) {
			const raw = String(args.path || "").trim();
			const content = String(args.content ?? "");
			const resolved = resolveScopedPath(raw, scope);
			if (!resolved) {
				throw new Error(`路径越界或不合法：${raw}（只允许 ${scope.allowedPrefixes.join("、")} 前缀）`);
			}
			if (!content.trim()) throw new Error("write_note 的 content 不能为空");
			const adapter = deps.app.vault.adapter;
			const segments = resolved.split("/");
			for (let index = 1; index < segments.length; index += 1) {
				const folder = segments.slice(0, index).join("/");
				if (folder && !(await adapter.exists(folder, true))) {
					await adapter.mkdir(folder);
				}
			}
			await adapter.write(resolved, content);
			journal.record(resolved);
			return {
				output: `已写入：${resolved}（${content.length} 字符）`,
				summary: `已写入 ${resolved}`,
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
		async execute(args) {
			if (!deps.apiKey) throw new Error("未配置 Tavily API Key");
			const rawQueries = Array.isArray(args.queries) ? args.queries : [];
			const queries = rawQueries
				.map((query) => String(query || "").trim())
				.filter(Boolean)
				.slice(0, 3);
			if (!queries.length) throw new Error("web_search 需要至少一个检索词");
			const results = await searchTavily(deps.http, deps.apiKey, queries, {
				maxResults: deps.maxResults,
				timeoutMs: deps.timeoutMs,
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
