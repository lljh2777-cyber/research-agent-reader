export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ArticleWikiSource = "auto" | "pdf" | "article";
export type PdfXraySource = "pdf" | "article";
export type MineruModel = "vlm" | "pipeline" | "auto" | "html";

export interface DashboardActionOptions {
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

export const ACTIONS: readonly DashboardAction[] = [
	{
		id: "paper-ingest",
		label: "文献入库",
		agent: "paper-intake-pipeline",
		description: "输入本地 PDF，并选择生成可追溯的原文 Markdown、创建初步文章 Wiki，或同时执行。身份核验、去重和元数据准备始终先执行。",
		placeholder: "例如：D:\\Downloads\\paper.pdf\n可补充 citekey、DOI、Zotero key 或处理要求",
		requiresInput: true,
		writes: true,
		enabled: true,
		ai: true,
		reasoningEffort: "high",
	},
	{
		id: "pdf-xray",
		label: "PDF 深读",
		agent: "paper_xray",
		description: "选择从原始 PDF 或已有 MinerU article.md 深读，再输入来源路径和核验目标。只有完整检查全文证据后才允许升级为 x-ray。",
		placeholder: "例如：D:\\Papers\\example.pdf\n或 knowledge-base/papers/example/article.md\n重点核验方法、图 2、数据来源与局限性",
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
		description: "输入 R/Python 项目根目录和关注重点。该操作会调用 code_reader 子智能体，只做静态阅读并更新代码说明页。",
		placeholder: "例如：D:\\Desktop\\Code_down\n分析入口、脚本关系、数据流，并按关键代码 + 解释输出",
		requiresInput: true,
		writes: true,
		enabled: true,
		ai: true,
		model: "gpt-5.6-sol",
		reasoningEffort: "medium",
	},
	{
		id: "code-practice",
		label: "代码练习",
		agent: "local-runtime",
		description: "在独立视图中使用 Python/R 单元格。运行至当前单元格时会在新进程中累计重放前置代码，可逐格查看输出、停止任务并显式保存练习笔记。",
		placeholder: "",
		requiresInput: false,
		writes: true,
		enabled: true,
		localView: true,
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
		id: "synthesis",
		label: "综合分析",
		agent: "research-vault-synthesis",
		description: "输入跨文献主题、比较问题或目标页面。该操作可更新 synthesis、MOC、concept、method、dataset 或 project 页面及其索引。",
		placeholder: "例如：综合已有单细胞文献与代码笔记，更新 Single-cell RNA-seq 方法页并列出证据缺口",
		requiresInput: true,
		writes: true,
		enabled: true,
		ai: true,
		model: "gpt-5.6-sol",
		reasoningEffort: "high",
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
		label: "知识库体检",
		agent: "research-vault-lint",
		description: "体检 wiki 与顶层知识索引：检查结构、属性、链接、孤立页、证据深度、source note 正文、代码关系、索引和 OKF 状态；排除 papers 原文包。完成后可在结果弹窗中选择由 AI 提出方案并修复。",
		placeholder: "",
		requiresInput: false,
		writes: false,
		enabled: true,
	},
	{
		id: "vault-lint-fix",
		label: "体检修复",
		agent: "research-vault-lint",
		description: "读取最新体检报告，由 AI 提出修复方案并执行低风险修复，随后重新体检。高影响项目只报告，不自动处理。",
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
