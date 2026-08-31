import { normalizePath, TFile } from "obsidian";

import { searchTavily, type WebSearchHttpDeps } from "../services/web-search";
import {
	publishMineruPackage,
	type MineruCommandRequest,
	type MineruPublishArgs,
	type MineruPublishContext,
} from "./mineru-publish";
import type { AgentTool, AgentToolContext } from "./types";

/** Max characters of one vault file handed to the model per read. */
const VAULT_READ_CHAR_LIMIT = 16000;
const VAULT_LIST_LIMIT = 200;
const VAULT_DOI_SCAN_FILE_LIMIT = 5000;

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

/**
 * Native MinerU bridge for the light agent: only the CLI executable is
 * required (npm mineru-open-api); no toolkit project and no Python. The
 * heavy lifting lives in mineru-publish.ts.
 */
export interface MineruToolDeps {
	mineruExecutable: string;
	/** Absolute path of the active vault. */
	vaultRoot: string;
	/** Stage parent directory override (tests). */
	stageRoot?: string;
	runCommand(request: MineruCommandRequest): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}>;
}

/** Extract arguments accepted by the native publish pipeline. */
export type MineruExtractArgs = MineruPublishArgs;

function normalizeVaultRelative(raw: string): string {
	return normalizePath(String(raw || "").trim()).replace(/^\/+/, "");
}

function pathEscapesScope(path: string): boolean {
	return path.split("/").some((segment) => segment === ".." || segment === "");
}

function withinPrefixes(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function decodeFrontmatterScalar(raw: string): string {
	const value = raw.trim();
	if (!value) return "";
	if (value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value) as unknown;
			return typeof parsed === "string" ? parsed.trim() : "";
		} catch {
			return value.slice(1, value.endsWith('"') ? -1 : undefined).trim();
		}
	}
	if (value.startsWith("'")) {
		const inner = value.slice(1, value.endsWith("'") ? -1 : undefined);
		return inner.replace(/''/g, "'").trim();
	}
	return value.replace(/\s+#.*$/, "").trim();
}

function normalizeObservedDoi(raw: string): string {
	return String(raw || "")
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
}

function extractVaultIdentity(content: string): { title: string; doi: string } {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] || "";
	const titleLine = /^title:[ \t]*(.+)$/mi.exec(frontmatter)?.[1] || "";
	const doiLine = /^doi:[ \t]*(.+)$/mi.exec(frontmatter)?.[1] || "";
	const h1 = /^#[ \t]+(.+?)\s*$/m.exec(content)?.[1] || "";
	return {
		title: decodeFrontmatterScalar(titleLine) || h1.trim(),
		doi: normalizeObservedDoi(decodeFrontmatterScalar(doiLine)),
	};
}

function extractObservedDois(texts: readonly string[]): string[] {
	const dois: string[] = [];
	const seen = new Set<string>();
	for (const text of texts) {
		for (const match of String(text || "").matchAll(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi)) {
			const doi = normalizeObservedDoi(match[0]);
			const key = doi.toLowerCase();
			if (!doi || seen.has(key)) continue;
			seen.add(key);
			dois.push(doi);
			if (dois.length >= 50) return dois;
		}
	}
	return dois;
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
			const identity = extractVaultIdentity(content);
			return {
				output: `${header}\n\n${slice}${offset + slice.length < content.length ? "\n…[未完，用 offset 继续读]" : ""}`,
				summary: header,
				receiptData: {
					query: path,
					paths: [path],
					...(identity.title ? { titles: [identity.title], candidates: [{ path, title: identity.title }] } : {}),
					...(identity.doi ? { dois: [identity.doi] } : {}),
				},
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
				receiptData: {
					...(folder ? { query: folder } : {}),
					paths,
				},
			};
		},
	};
}

/**
 * Exact DOI lookup over authoritative source-note frontmatter. A DOI must not
 * use the generic lexical tokenizer: shared registrar prefixes otherwise
 * create unrelated candidates that cannot be safely cleared.
 */
export function createVaultDoiSearchTool(
	deps: VaultToolDeps,
	allowedPrefixes: readonly string[],
): AgentTool {
	return {
		name: "vault_doi_search",
		description: "在 wiki/sources 笔记的 frontmatter 中按完整 DOI 精确查重；只比较权威 doi 字段，不扫描正文引用。",
		parameters: { doi: "已由 Crossref 核验的完整 DOI，例如 10.1000/example" },
		required: ["doi"],
		async execute(args, context) {
			const doi = normalizeObservedDoi(String(args.doi || ""));
			if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error(`DOI 格式不合法：${doi}`);
			const sourceNotes = deps.app.vault.getMarkdownFiles()
				.filter((file) => {
					const filePath = String(file.path || "").replace(/\\/g, "/");
					return withinPrefixes(filePath, allowedPrefixes)
						&& filePath.startsWith("wiki/sources/");
				})
				.sort((a, b) => String(a.path).localeCompare(String(b.path)));
			if (sourceNotes.length > VAULT_DOI_SCAN_FILE_LIMIT) {
				throw new Error(`source note 数量超过 DOI 精确查重上限 ${VAULT_DOI_SCAN_FILE_LIMIT}，不能安全判定 none`);
			}
			const candidates: Array<{ path: string; title: string }> = [];
			for (const file of sourceNotes) {
				if (context.signal.aborted || context.remainingMs() <= 0) throw new Error("DOI 精确查重已取消或超时");
				const content = await deps.app.vault.read(file as TFile);
				const observed = extractVaultIdentity(content);
				if (normalizeObservedDoi(observed.doi).toLowerCase() !== doi.toLowerCase()) continue;
				candidates.push({ path: String(file.path), title: observed.title });
			}
			const lines = candidates.map((candidate, index) => (
				`${index + 1}. ${candidate.path} — ${candidate.title || "（无标题）"}`
			));
			return {
				output: lines.length ? `找到 ${lines.length} 个同 DOI source note：\n${lines.join("\n")}` : "没有找到同 DOI source note。",
				summary: `${candidates.length} 个同 DOI source note`,
				receiptData: {
					query: doi,
					...(candidates.length ? { dois: [doi] } : {}),
					paths: candidates.map((candidate) => candidate.path),
					titles: candidates.map((candidate) => candidate.title).filter(Boolean),
					candidates,
				},
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
			const records = extractCrossrefRecords(response.json);
			const items = records.map((record, index) => formatCrossrefRecord(record, index));
			if (!items.length) {
				return {
					output: "Crossref 没有返回候选。",
					summary: "0 条候选",
					receiptData: { query },
				};
			}
			return {
				output: items.join("\n\n"),
				summary: `${items.length} 条候选`,
				receiptData: {
					query,
					titles: records.map((record) => record.title).filter(Boolean),
					dois: records.map((record) => record.doi).filter(Boolean),
					bibliographicRecords: records.map(toReceiptBibliographicRecord),
				},
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
			const doi = String(args.doi || "").trim().replace(/^https?:\/\/doi\.org\//i, "").slice(0, 300);
			if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error(`DOI 格式不合法：${doi}`);
			const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
			const response = await deps.httpGetJson(url, 20_000, { signal: context.signal });
			if (response.status === 404) throw new Error(`Crossref 没有这个 DOI：${doi}`);
			if (response.status !== 200) throw new Error(`Crossref HTTP ${response.status}`);
			const records = extractCrossrefRecords(response.json);
			if (!records.length) throw new Error("Crossref 返回无法解析");
			return {
				output: records.map((record, index) => formatCrossrefRecord(record, index)).join("\n\n"),
				summary: `DOI ${doi} 已核验`,
				receiptData: {
					query: doi,
					titles: records.map((record) => record.title).filter(Boolean),
					dois: records.map((record) => record.doi).filter(Boolean),
					bibliographicRecords: records.map(toReceiptBibliographicRecord),
				},
			};
		},
	};
}

interface CrossrefRecord {
	doi: string;
	title: string;
	authors: string;
	year: string;
	container: string;
}

function toReceiptBibliographicRecord(record: CrossrefRecord): {
	title: string;
	doi: string;
	authors: string;
	year: string;
} {
	return {
		title: record.title,
		doi: record.doi,
		authors: record.authors,
		year: record.year,
	};
}

function extractCrossrefRecords(json: unknown): CrossrefRecord[] {
	const message = (json as { message?: { items?: unknown } } | null)?.message;
	const rawItems = Array.isArray(message?.items) ? message.items : [message];
	return rawItems.filter(Boolean).slice(0, 5).map((item) => {
		const record = item as {
			DOI?: string;
			title?: string[];
			author?: Array<{ given?: string; family?: string }>;
			issued?: { "date-parts"?: number[][] };
			"container-title"?: string[];
			type?: string;
		};
		const title = String(record.title?.[0] || "").trim();
		const authors = (record.author || []).slice(0, 4)
			.map((author) => [author.family, author.given].filter(Boolean).join(" "))
			.filter(Boolean)
			.join("; ");
		const year = String(record.issued?.["date-parts"]?.[0]?.[0] || "");
		const container = String(record["container-title"]?.[0] || "");
		return {
			doi: normalizeObservedDoi(String(record.DOI || "")),
			title,
			authors,
			year,
			container,
		};
	});
}

function formatCrossrefRecord(record: CrossrefRecord, index: number): string {
	return [
		`[${index + 1}] DOI: ${record.doi || "（无）"}`,
		`标题: ${record.title || "（无标题）"}`,
		record.authors ? `作者: ${record.authors}` : "",
		record.year ? `年份: ${record.year}` : "",
		record.container ? `期刊: ${record.container}` : "",
	].filter(Boolean).join("\n");
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
			if (result.scope_complete === false) {
				const total = Number(result.scope_total_files || 0);
				throw new Error(
					`Vault 去重检索范围不完整（范围内 ${total || "超过 5000"} 个 Markdown）；无法安全确认没有重复，已停止入库`,
				);
			}
			const seeds = Array.isArray(result.lexical_seeds) ? result.lexical_seeds : [];
			const queryTerms = Array.isArray(result.lexical_terms)
				? result.lexical_terms
					.filter((term): term is string => typeof term === "string")
					.map((term) => term.trim())
					.filter(Boolean)
				: [];
			const inScope = seeds.filter((seed) => {
				const path = String((seed as { path?: string }).path || "").replace(/\\/g, "/");
				return allowedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
			});
			const selected = inScope.slice(0, limit);
			const lines = selected
				.map((seed, index) => {
					const record = seed as { path?: string; title?: string; score?: number };
					return `${index + 1}. ${String(record.path || "")} — ${String(record.title || "").slice(0, 120)}（score ${Number(record.score || 0).toFixed(2)}）`;
				});
			return {
				output: lines.length
					? `共 ${inScope.length} 个候选，前 ${lines.length}：\n${lines.join("\n")}`
					: "没有找到相关笔记。",
				summary: `${inScope.length} 个候选`,
					receiptData: {
						query: question,
						queryTerms,
						// The model-visible output may honor a smaller display limit, but the
						// security receipt must retain every already-bounded retriever hit so
						// a model cannot hide a later duplicate with limit=1.
						paths: inScope.map((seed) => String((seed as { path?: string }).path || "")),
						titles: inScope.map((seed) => String((seed as { title?: string }).title || "")).filter(Boolean),
						candidates: inScope.map((seed) => {
						const record = seed as { path?: string; title?: string };
						return { path: String(record.path || ""), title: String(record.title || "") };
					}),
				},
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
			if (!results.length) {
				return {
					output: "没有搜索到结果。",
					summary: "0 条结果",
					receiptData: { query: queries.join(" | ") },
				};
			}
			const blocks = results.map((result, index) => {
				return `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.content.slice(0, 800)}`;
			});
			return {
				output: blocks.join("\n\n"),
				summary: `${results.length} 条结果`,
				receiptData: {
					query: queries.join(" | "),
					titles: results.map((result) => result.title).filter(Boolean),
					// Tavily snippets are prose, not authoritative structured metadata;
					// only DOI-shaped result URLs are promoted into receipt facts.
					dois: extractObservedDois(results.map((result) => result.url)),
					bibliographicRecords: results.map((result) => ({
						title: result.title,
						doi: extractObservedDois([result.url])[0] || "",
						authors: "",
						year: "",
					})),
				},
			};
		},
	};
}

/** Probes whether the native MinerU publish pipeline can run right now. */
export function mineruReadiness(deps: MineruToolDeps): { ready: boolean; reason: string } {
	if (!deps.mineruExecutable.trim()) {
		return { ready: false, reason: "未配置 MinerU CLI（npm 全局安装 mineru-open-api 后在设置中配置）" };
	}
	return { ready: true, reason: "" };
}

export interface MineruPackageReceipt {
	/** Absolute filesystem path of the published package inside the vault. */
	packagePath: string;
	validation: Record<string, unknown>;
}

/**
 * Runs the native publish pipeline for exactly the user-authorized PDF.
 * The model has no say over the source path — it is bound by the caller —
 * and the MinerU subprocess is killed promptly when the abort signal fires.
 */
export async function runAuthorizedMineruExtract(
	deps: MineruToolDeps,
	args: MineruExtractArgs,
	context: MineruPublishContext & { validateBeforeCommit(articleMarkdown: string): void },
): Promise<MineruPackageReceipt> {
	return publishMineruPackage(
		{
			runCommand: deps.runCommand,
			vaultRoot: deps.vaultRoot,
			mineruExecutable: deps.mineruExecutable,
			stageRoot: deps.stageRoot,
		},
		args,
		context,
	);
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
 * wikilinks, Markdown links/images (including reference definitions with
 * optional titles and angle-wrapped targets). Only external web schemes and
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
	// Reference definitions: target, optional <angle> target, and optional
	// "double"/'single'/(paren) title after it.
	for (const match of body.matchAll(/^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?[ \t]*$/gm)) {
		targets.push(match[1] || match[2] || "");
	}
	return targets.filter((target) => !/^(https?:\/\/|mailto:|#)/i.test(target));
}

/**
 * Raw HTML is banned outright in model-generated fields (these are
 * abstract-level summaries; external links must use Markdown). Tag-shaped
 * constructs require a letter tag name followed by whitespace, an
 * attribute-free close, or a self-close — so math prose like "E<mc²" or
 * "<p、q> 记号" does not trip it, while ANY HTML tag (including quoted ">"
 * inside attributes, xlink:href, srcset, SVG tricks) is rejected wholesale
 * instead of being parsed.
 */
const RAW_HTML_TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/;

/**
 * Structural validation of the generated note: exactly one frontmatter
 * block with the required keys, no raw HTML, and no vault-internal links
 * in the body. Returns human-readable violations; empty means safe.
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
	const titleZhLine = /^title_zh:[ \t]*(.*)$/mi.exec(match[1])?.[1] || "";
	if (!decodeFrontmatterScalar(titleZhLine)) violations.push("frontmatter 的 title_zh 不能为空");
	const rawHtml = RAW_HTML_TAG_PATTERN.exec(rest);
	if (rawHtml) {
		violations.push(
			`正文包含原始 HTML（${rawHtml[0].slice(0, 60)}）；模型生成字段不允许 HTML，外部链接请使用 Markdown 格式`,
		);
		return violations;
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
	if (!fields.title_zh.trim()) throw new Error("笔记缺少审校后的简体中文标题 title_zh");
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
