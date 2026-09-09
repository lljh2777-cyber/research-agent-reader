/** Navigation metadata only: no credentials, model requests or settings writes. */
export type SettingsCategory = "reading" | "connections" | "knowledge" | "system";
export type SettingsFilter = SettingsCategory | "common" | "all";
export type SettingsPage = "home" | "reader" | "annotations" | "tasks" | "direct-api"
	| "codex" | "claude" | "opencode" | "retrieval" | "mineru" | "runtime" | "data" | "obsidian-cli" | "fulltext";

export interface SettingsEntry {
	page: Exclude<SettingsPage, "home">;
	category: SettingsCategory;
	title: string;
	description: string;
	icon: string;
	keywords: string;
	common?: boolean;
}

export const SETTINGS_CATEGORIES: Array<{ id: SettingsCategory; label: string }> = [
	{ id: "reading", label: "阅读与批注" },
	{ id: "connections", label: "模型与连接" },
	{ id: "knowledge", label: "文献与知识库" },
	{ id: "system", label: "系统与数据" },
];

export const SETTINGS_ENTRIES: SettingsEntry[] = [
	{ page:"fulltext",category:"knowledge",title:"全文来源",icon:"download",description:"PMC PDF、Unpaywall 开放来源回退与联系邮箱。",keywords:"DOI PMID PMCID PDF 全文 获取 下载 邮箱 email OA Unpaywall PMC" },
	{ page: "reader", category: "reading", title: "文献阅读器", icon: "book-open-text", common: true,
		description: "接管目录、图文双栏与阅读版式。", keywords: "PDF Markdown MinerU article.md 缩放 栏宽 跟随 版面框" },
	{ page: "direct-api", category: "connections", title: "Direct API", icon: "plug-zap", common: true,
		description: "为深读、问答和 Agent 配置模型服务。", keywords: "AI 助手 LLM Provider OpenAI OpenRouter API Key 密钥 凭据 SecretStorage endpoint 联网 Tavily 超时 文献入库" },
	{ page: "annotations", category: "reading", title: "批注 AI", icon: "message-square-text", common: true,
		description: "划选解释的模型、深度与回答长度。", keywords: "注释 后端 推理 速度 输出 token 联网" },
	{ page: "retrieval", category: "knowledge", title: "知识库检索", icon: "search", common: true,
		description: "检索方式、向量索引与结果预览。", keywords: "embedding rerank BGE bge-m3 bge-reranker-v2-m3 硅基流动 siliconflow 凭据 密钥 语义 混合 来源 维护 整理 修订" },
	{ page: "mineru", category: "knowledge", title: "文献解析", icon: "file-scan", common: true,
		description: "MinerU 服务与文献入库的解析参数。", keywords: "PDF OCR article.md Markdown 转换 MinerU token 认证 CLI 私有服务" },
	{ page: "data", category: "system", title: "数据与诊断", icon: "database-zap", common: true,
		description: "历史保留、笔记目录与诊断信息。", keywords: "导出 学习 会话 存储 保存 清理 重置 维护 日志" },
	{ page: "tasks", category: "reading", title: "任务默认策略", icon: "sliders-horizontal",
		description: "为各类任务选择默认后端与模型。", keywords: "PDF 深读 推理 速度 查询 策略 操作" },
	{ page: "codex", category: "connections", title: "Codex CLI", icon: "bot",
		description: "本地 Codex 的配置来源、模型与连接。", keywords: "OpenAI CC Switch CCSwitch 推理 速度 PDF 深读" },
	{ page: "claude", category: "connections", title: "Claude Code", icon: "sparkles",
		description: "本地 Claude 的配置来源、模型与连接。", keywords: "Anthropic CC Switch CCSwitch 推理" },
	{ page: "opencode", category: "connections", title: "OpenCode", icon: "braces",
		description: "本地 OpenCode 的配置来源与模型发现。", keywords: "Zen CC Switch CCSwitch 推理" },
	{ page: "runtime", category: "system", title: "工具链与运行环境", icon: "terminal",
		description: "本地可执行文件、工具包与任务超时。", keywords: "Codex Claude OpenCode CLI Python R 路径 目录 安装 Toolkit" },
	{ page: "obsidian-cli", category: "system", title: "Obsidian CLI", icon: "square-terminal",
		description: "外部自动化与开发调试的可选连接。", keywords: "命令行 可执行文件 诊断 回归" },
];

export function filterSettingsEntries(filter: SettingsFilter, query: string): SettingsEntry[] {
	const terms = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	return SETTINGS_ENTRIES.filter((entry) => {
		// Searching always covers every page, even when the common filter is selected.
		if (terms.length) {
			const text = `${entry.title} ${entry.description} ${entry.keywords}`.normalize("NFKC").toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		}
		return filter === "all" || (filter === "common" ? entry.common : entry.category === filter);
	});
}
