export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ArticleWikiSource = "auto" | "pdf" | "article";
export type PdfXraySource = "pdf" | "article";
export type MineruModel = "vlm" | "pipeline" | "auto" | "html";

export interface DashboardActionOptions {
	identityCandidateTitle?: string;
	identityCandidateDoi?: string;
	createArticleMarkdown?: boolean;
	createArticleWiki?: boolean;
	articleWikiSource?: ArticleWikiSource;
	mineruModel?: MineruModel;
	mineruLanguage?: string;
	mineruOcr?: boolean;
	mineruFormula?: boolean;
	mineruTable?: boolean;
	mineruPages?: string;
	mineruTimeoutSeconds?: number;
	mineruIncludeSourcePdf?: boolean;
	/** Light-agent runs require the explicit remote-upload confirmation. */
	mineruRemoteConfirmed?: boolean;
	pdfXraySource?: PdfXraySource;
}

export interface DashboardAction {
	id: string;
	label: string;
	agent: string;
	description: string;
	placeholder: string;
	requiresInput: boolean;
	writes: boolean;
	enabled: boolean;
	ai?: boolean;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	localView?: boolean;
	queryView?: boolean;
	showInRail?: boolean;
}

// This internal action accepts one saved annotation; it is not a dashboard writing tool.
export const ARCHIVE_ANNOTATION_ACTION: DashboardAction = {
	id: "synthesis",
	label: "归档本条批注",
	agent: "research-vault-synthesis",
	description: "依据这一条批注和原文归档知识点。",
	placeholder: "", requiresInput: true, writes: true, enabled: true, ai: true,
	reasoningEffort: "high",
};

export const ACTIONS: readonly DashboardAction[] = [
	{
		id: "fulltext-acquisition", label: "获取全文", agent: "fulltext-acquisition-service",
		description: "按 DOI、PMID 或 PMCID 查找 PMC 可用 PDF，核对版本后获取并在本地预览，无需模型配置。",
		placeholder: "", requiresInput: false, writes: false, enabled: true, ai: false, localView: true,
	},
	{
		id: "paper-ingest",
		label: "文献入库",
		agent: "paper-intake-pipeline",
		description: "输入本地 PDF，并选择生成可追溯的原文 Markdown、创建初步论文笔记，或同时执行。身份核验、去重和元数据准备始终先执行。",
		placeholder: "例如：<论文目录>/paper.pdf\n可补充 citekey、DOI、Zotero key 或处理要求",
		requiresInput: true,
		writes: true,
		enabled: true,
		ai: true,
		reasoningEffort: "high",
	},
	{
		id: "pdf-xray",
		label: "文献深读",
		agent: "paper_xray",
		description: "选择从原始 PDF 或已有 MinerU article.md 深读，再输入来源路径和核验目标。只有完整检查全文证据后才允许升级为 x-ray。",
		placeholder: "例如：<论文目录>/example.pdf\n或 papers/example/article.md\n重点核验方法、图 2、数据来源与局限性",
		requiresInput: true,
		writes: true,
		enabled: true,
		ai: true,
		model: "gpt-5.6-sol",
		reasoningEffort: "high",
	},
	{
		id: "code-analysis",
		label: "代码分析",
		agent: "code_reader",
		description: "选择 R/Python 文件或项目，沿主线逐步理解代码，通过支线追问并查看源码依据；一次性代码笔记保留在更多选项中。",
		placeholder: "例如：<代码项目目录>\n分析入口、脚本关系、数据流，并按关键代码 + 解释输出",
		requiresInput: true,
		writes: true,
		enabled: true,
		ai: true,
		model: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
	{
		id: "vault-retrieval",
		label: "知识库检索",
		agent: "research-vault-retrieval",
		description: "在独立侧边栏中连续查询当前 vault。每轮都会执行透明检索级联并使用只读沙箱，不写入知识库文件。",
		placeholder: "例如：当前知识库关于 scRNA-seq 质控阈值有哪些依据和分歧？",
		requiresInput: true,
		writes: false,
		enabled: true,
		ai: true,
		reasoningEffort: "medium",
		queryView: true,
	},
	{
		id: "annotation-explain",
		label: "AI 批注解释",
		agent: "annotation-assistant",
		description: "结合选中文字、当前段落和文章语境生成简短的初步解释；只读且不创建知识节点。",
		placeholder: "",
		requiresInput: true,
		writes: false,
		enabled: true,
		showInRail: false,
		ai: true,
		reasoningEffort: "medium",
	},
	{
		id: "vault-lint",
		showInRail: false,
		label: "知识库体检",
		agent: "Research Agent Reader 内置体检",
		description: "只读体检 wiki 与 Vault 顶层 Markdown：检查属性、断链、孤立页和三主目录链接边界。papers 与 Clippings 不参与常规体检，仅检查是否跨主目录链接；无需 Python 或外部工具链。完成后可选择由 AI 提出方案并修复。",
		placeholder: "",
		requiresInput: false,
		writes: false,
		enabled: true,
	},
	{
		id: "vault-lint-fix",
		label: "体检修复",
		agent: "research-vault-lint",
		description: "读取最新内置体检报告，由 AI 提出修复方案并执行低风险修复，随后重新体检。修复过程不得在 papers、wiki、Clippings 三个主目录之间创建链接；高影响项目只报告，不自动处理。",
		placeholder: "",
		requiresInput: false,
		writes: true,
		enabled: true,
		showInRail: false,
		ai: true,
		reasoningEffort: "high",
	},
	{
		id: "okf-export",
		label: "OKF 导出",
		agent: "okf-export",
		description: "预检 wiki 后生成 OKF v0.1 时间戳 bundle，转换 wikilink、补齐最低属性并保留旧导出。不会修改源笔记或复制附件。",
		placeholder: "",
		requiresInput: false,
		writes: true,
		enabled: true,
	},
];

export const ACTION_BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));
