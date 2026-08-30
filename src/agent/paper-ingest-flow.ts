import type { AgentTool } from "./types";
import {
	createHttpJsonTool,
	createMineruExtractTool,
	createVaultListTool,
	createVaultReadTool,
	createVaultSearchTool,
	createWebSearchTool,
	createWriteNoteTool,
	VaultWriteJournal,
	type HttpToolDeps,
	type MineruToolDeps,
	type TavilySearchDeps,
	type VaultToolDeps,
	type WriteScopeRule,
} from "./tools";

/** Structured result the ingest flow must produce via {"action":"final"}. */
export interface PaperIngestFinalResult {
	status: "completed" | "conflict" | "failed";
	citekey: string;
	title: string;
	title_zh: string;
	articlePath: string;
	wikiPath: string;
	filesWritten: string[];
	duplicates: string[];
	conflicts: string[];
	notes: string[];
}

export const PAPER_INGEST_RESULT_SCHEMA = `{
  "status": "completed | conflict | failed",
  "citekey": "本篇 citekey",
  "title": "核验后的原文标题",
  "title_zh": "审校后的简体中文标题（无法确定时留空）",
  "articlePath": "已发布的 article.md 的 vault 相对路径，未生成则留空",
  "wikiPath": "已写入的 wiki 笔记路径，未创建则留空",
  "filesWritten": ["本次写入的全部文件路径"],
  "duplicates": ["发现的重复项及判断依据"],
  "conflicts": ["证据冲突；status=conflict 时必填"],
  "notes": ["复用、跳过、回退、元数据缺口等需要用户知道的事项"]
}`;

export interface PaperIngestFlowOptions {
	sourcePdfPath: string;
	requestNotes: string;
	createArticleMarkdown: boolean;
	createArticleWiki: boolean;
	articleWikiSource: "auto" | "pdf" | "article";
	mineruModel: string;
	mineruLanguage: string;
	mineruOcr: boolean;
	mineruFormula: boolean;
	mineruTable: boolean;
	mineruPages: string;
	mineruTimeoutSeconds: number;
	mineruIncludeSourcePdf: boolean;
	remoteUploadConfirmed: boolean;
}

export const PAPER_INGEST_ALLOWED_HOSTS = [
	"api.crossref.org",
	"export.arxiv.org",
	"arxiv.org",
	"doi.org",
] as const;

/** Wiki note + paper package are the only surfaces the light agent may write. */
export const PAPER_INGEST_WRITE_SCOPE: WriteScopeRule = {
	allowedPrefixes: ["papers", "wiki/sources"],
};

export function buildPaperIngestSystemPrompt(options: PaperIngestFlowOptions): string {
	const outputs: string[] = [];
	if (options.createArticleMarkdown) outputs.push("1) 生成原文 Markdown（MinerU）");
	if (options.createArticleWiki) outputs.push("2) 创建初步文章 Wiki（abstract-level）");
	return [
		"你是研究知识库的文献入库轻量 Agent，在 Obsidian 插件内运行，只能通过工具访问知识库和外部服务。",
		`本次任务选择的输出：${outputs.join("；")}。身份核验、去重、citekey 选定始终先执行。`,
		"",
		"## 执行顺序（严格遵守）",
		"1. 身份核验：根据用户提供的 PDF 路径/文件名和任务说明，用 http_get_json 查询 Crossref（https://api.crossref.org/works?query.bibliographic=<标题>）或 arXiv（https://export.arxiv.org/api/query?search_query=…）核对标题、作者、年份、DOI。",
		"2. 去重：用 vault_search 和 vault_list 检查 wiki/sources/ 与 papers/ 下是否已有同 DOI、同 arXiv、同规范化标题或同 citekey 的记录。",
		"3. 证据冲突（来源元数据互相矛盾、无法确定唯一身份）时：不再继续生成任何输出，直接 final，status=conflict 并写明冲突。",
		"4. 确定 citekey：格式为 <第一作者姓氏小写>_<关键词>_<年份>，只用字母数字._-，与现有文件不冲突。",
		options.createArticleMarkdown
			? `5. 用 mineru_extract 生成原文包：source 用用户提供的 PDF 绝对路径，citekey 用第 4 步结果，model=${options.mineruModel}，language=${options.mineruLanguage}${options.mineruOcr ? "，ocr=true" : ""}${options.mineruPages ? `，pages=${options.mineruPages}` : ""}。成功后用 vault_read 读取新包 article.md 的开头，核对标题与第 1 步身份一致；不一致按冲突处理并如实报告（包已生成要说明）。`
			: "",
		options.createArticleWiki
			? [
				`6. 创建 wiki/sources/<citekey>.md，内容来源模式=${options.articleWikiSource}（auto=优先用已验证 article.md，否则回退 PDF 信息并说明；pdf=仅用用户提供的信息；article=必须有已验证 article 包）。`,
				"   笔记要求：YAML frontmatter 含 title、title_zh、type: source、depth: abstract-level、created；title 保留原文，title_zh 为审校后的简体中文译名（保留专有名词，不确定就留空并在 notes 说明）；正文用简体中文写，小节：## 研究问题、## 结论、## 问题与动机；证据不足的地方写「Vault 中未找到足够依据」，不要编造；abstract-level 封顶，不得写成深度解读。",
			].join("\n")
			: "",
		"7. 全部完成后 final，result 按下面的 JSON 结构给出。",
		"",
		"## 红线",
		"- 只能写入允许前缀内的文件；papers、wiki、Clippings 三个主目录之间不得创建链接。",
		"- 不编造 DOI、作者、年份；查不到就留空并在 notes 说明。",
		"- 不修改 papers.csv、references.bib、文献索引（轻量入库不登记这些文件，如实告知用户）。",
		"- 重复入库：已有完全相同文献时跳过生成，final.status 用 completed 并在 duplicates 说明已有路径。",
		options.createArticleMarkdown && !options.remoteUploadConfirmed
			? "- 用户未确认远程上传：不得调用 mineru_extract，按冲突处理并在 notes 说明需勾选「确认远程处理」。"
			: "",
		"",
		`## final.result JSON 结构\n${PAPER_INGEST_RESULT_SCHEMA}`,
	].filter(Boolean).join("\n");
}

export function buildPaperIngestUserMessage(
	options: PaperIngestFlowOptions,
): string {
	const lines = [
		"入库任务：",
		`- 来源 PDF：${options.sourcePdfPath || "（用户未提供路径，从任务说明中解析）"}`,
		`- 生成原文 Markdown：${options.createArticleMarkdown ? "是（MinerU precision extract）" : "否"}`,
		`- 创建初步文章 Wiki：${options.createArticleWiki ? "是" : "否"}`,
	];
	if (options.createArticleWiki) {
		lines.push(`- 文章 Wiki 内容来源：${options.articleWikiSource}`);
	}
	lines.push("", "任务说明（用户原文）：", options.requestNotes || "（无补充说明）");
	return lines.join("\n");
}

export interface PaperIngestToolDeps {
	vault: VaultToolDeps;
	http: HttpToolDeps;
	mineru: MineruToolDeps;
	tavily: TavilySearchDeps;
	lexicalRetriever: {
		retrieve(question: string, expandedTerms?: string[]): Promise<Record<string, unknown>>;
	};
}

export function buildPaperIngestTools(
	deps: PaperIngestToolDeps,
	options: PaperIngestFlowOptions,
): { tools: AgentTool[]; journal: VaultWriteJournal } {
	const journal = new VaultWriteJournal();
	const tools: AgentTool[] = [
		createVaultSearchTool(deps.lexicalRetriever),
		createVaultReadTool(deps.vault),
		createVaultListTool(deps.vault),
		createHttpJsonTool(deps.http, PAPER_INGEST_ALLOWED_HOSTS),
	];
	if (options.createArticleMarkdown && options.remoteUploadConfirmed) {
		tools.push(createMineruExtractTool(deps.mineru));
	}
	if (deps.tavily.apiKey) {
		tools.push(createWebSearchTool(deps.tavily));
	}
	if (options.createArticleWiki) {
		tools.push(createWriteNoteTool(deps.vault, PAPER_INGEST_WRITE_SCOPE, journal));
	}
	return { tools, journal };
}

/** Normalizes a model-reported vault path to forward slashes without "..". */
function normalizeReportedPath(value: string): string {
	const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || normalized.split("/").some((segment) => segment === "..")) return "";
	return normalized;
}

/** Parses and validates the model's final payload into a typed result. */
export function parsePaperIngestFinalResult(
	final: Record<string, unknown> | null,
): PaperIngestFinalResult | null {
	if (!final) return null;
	const status = String(final.status || "").toLowerCase();
	if (!["completed", "conflict", "failed"].includes(status)) return null;
	const asStringArray = (value: unknown): string[] => Array.isArray(value)
		? value.map((item) => normalizeReportedPath(String(item || ""))).filter(Boolean)
		: [];
	return {
		status: status as PaperIngestFinalResult["status"],
		citekey: String(final.citekey || "").trim(),
		title: String(final.title || "").trim(),
		title_zh: String(final.title_zh || "").trim(),
		articlePath: normalizeReportedPath(String(final.articlePath || final.article_path || "")),
		wikiPath: normalizeReportedPath(String(final.wikiPath || final.wiki_path || "")),
		filesWritten: asStringArray(final.filesWritten ?? final.files_written),
		duplicates: asStringArray(final.duplicates),
		conflicts: asStringArray(final.conflicts),
		notes: asStringArray(final.notes),
	};
}
