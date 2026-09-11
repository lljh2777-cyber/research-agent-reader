# Research Agent Reader

Research Agent Reader 是一个桌面端 Obsidian 插件，面向以原文证据为基础的科研文献阅读与知识沉淀：保存可靠来源、逐步理解论文、核对依据，并将有价值的阅读内容整理为可复用笔记。

未来开发以[开发路线：科研阅读、主题学习与知识沉淀](docs/development-roadmap.md)为准：接通文献详情、统一添加、摘录和知识整理，再独立推进存储迁移、翻译与专题对照。新增主题学习扩展，允许从主题、目标与基础开始，使用对话和思维导图学习一般知识；资料阅读继续保持原文证据规则。

[主题路线 T1.1](docs/topic-planning-t11.md)已在 `0.54.0` 接入原生界面：从工作台的「主题路线（预览）」创建目标、手动编排或显式调用模型生成路线，保存和确认，并查看历史版本。无需资料即可使用；讲解、对话、导图和导出尚未开放。实现复用 [T0 服务](docs/topic-learning-development.md)，新增 `pnpm test:topic-workspace` 定向检查。

[R1 首批导航](docs/library-navigation-r1.md)已在 `0.53.0` 交付：从工作台的「文献库」搜索和筛选记录，打开详情、指定原文、阅读会话与笔记；旧 MinerU 可按需核验单个包。保留待关联和来源缺口，页面浏览不调用模型。下一步开展 T1.2 主题讲解与导图，R1 人工状态编辑随后继续。

[R0 工程开发已收尾](docs/r0-closeout.md)：文献聚合、人工决定存储与旧资料兼容成为本次导航基础；3 篇论文、18 题的固定样本和首次回答仍保留。独立人工科学审阅尚未完成，工程检查不代表模型回答质量通过。`pnpm test:r0` 可运行专用回归。

> Public release status: `0.31.0` beta is published at
> [GitHub Releases](https://github.com/lljh2777-cyber/research-agent-reader/releases/latest).
> The plugin is not yet listed in the Obsidian Community directory.

The `codex/research-learning-map` development branch is at `0.54.0`; the beta
release link above remains the published release.

`0.52.2` 修复真实 JATS 中的公式文档壳和备用图片误计数：DESeq2 可继续转换，Sopa 的公式与备用资源缺口已消除。旧转换器与来源包保持可回放，未展开的补充材料仍显示缺口。范围与测试见 [R0 公式修复](docs/jats-formulas-r0.md)。

全文获取与多来源入库的后续设计见[架构与开发流程](docs/fulltext-acquisition-design.md)。
总体设计基于 `0.43.2`，各阶段按实现说明验收。
`0.51.2` 修复粘贴 Nature 文章链接后「查找全文」禁用的问题。支持 Nature `/articles/<文章标识>` 页面与 `.pdf` 链接，忽略查询参数和页内锚点，转换为 DOI 后沿用原有身份与全文查询。其他不支持的链接会提示改用 DOI、PMID 或 PMCID；识别链接不代表已找到可用全文。

`0.51.1` 完成全文入库与 JATS 功能检查：修复正文外主图漏读、公式重复、Wiki 标识冲突和长摘要工具预算，优化重复来源核验及保存状态反馈，保留旧转换器与历史来源。验收范围与限制见[完整检查记录](docs/fulltext-acquisition-review.md)。

`0.51.0` 完成 M6 的阅读助手与既有 Wiki 修订步骤：JATS 会话可核对文字依据、准备后续操作卡，并对已有正式笔记生成建议、预览差异、应用或撤销。引用保留固定版本、正文块、XML 与字符范围；来源变化和用户编辑会阻止不一致写入。助手仍只读取文字，整理流程按需读取同版本图像，不自动升级 X-Ray。详见 [M6 助手与修订实现](docs/fulltext-acquisition-m6-curation.md)。

`0.50.0` 已完成 M6 的初始文章 Wiki 步骤：在已保存的 JATS 图文阅读器点击「文章 Wiki」，或在交互阅读中点击「生成文章 Wiki」。模型读取固定原文生成摘要级草稿；核对完整内容与证据片段后保存，再预览入库登记。草稿可恢复，保存只创建新笔记，已有 Wiki 可直接打开或继续登记。详见 [M6 Wiki 实现](docs/fulltext-acquisition-m6-wiki.md)。

`0.49.0` 已完成 M6 的交互阅读步骤：在已保存的 JATS 图文阅读器点击「交互深读」，或在新建阅读中选择「已保存 JATS article.md」。支持主线、支线、图像证据、会话恢复和保留来源快照的学习记录导出。详见 [M6 交互阅读实现](docs/fulltext-acquisition-m6-reading.md)。

`0.48.0` 已完成 M5：在「获取全文 → 获取内容」选择 JATS XML，可获取 PMC 的正文与同版本图片。
核对主文章信息后可无模型、无 MinerU 保存图文原文，支持章节、图表与参考文献跳转。
缺图、公式降级或未展开内容会列出缺口；部分结果需明确接受后保存，也可重新查询。
原文包保留 XML、来源清单、原始媒体与确定性投影；JATS 使用正文块定位，不提供 PDF 页码同步。
使用流程与验收范围见[全文获取 M5](docs/fulltext-acquisition-m5.md)。
`0.47.0` 已完成 M4：已获取的 PDF 可通过「仅保存原文」在标题页确认后保存，无需配置模型或 MinerU。
正式原文包按论文、版本和文件内容区分，并独立登记 `papers/index.md`；保存 PDF 不代表已转换正文或生成 Wiki。
索引登记失败可单独补登记，中断恢复先核对已写文件，保留用户修改。
新获取入口的身份与去重由来源目录确定，模型负责后续正文生成；旧本地 PDF 入库仍保留原有确认流程。
使用流程与验收范围见[全文获取 M4](docs/fulltext-acquisition-m4.md)。
此前 M3 已实现：PMC 无可用 PDF 时可查询 Unpaywall，并按稿件策略尝试开放 PDF 候选。
在「设置 → 全文来源」中填写联系邮箱并启用回退；查询会将 DOI 和邮箱发送给 Unpaywall。
获取结果可无模型预览，也可通过「继续入库」选择模型和输出，复用已校验 PDF 完成身份核对、MinerU 和 Wiki 流程。
获取与入库分别保存状态，入库失败后可用同一 PDF 重新续办。
使用流程和验收范围见[全文获取 M3](docs/fulltext-acquisition-m3.md)；PMC 基础能力见 [M2](docs/fulltext-acquisition-m2.md)，开发演示见 [M1](docs/fulltext-acquisition-m1.md)。

## Features

- Opens Markdown files from configurable folders in a two-pane research reader.
- Keeps article text in the left pane and moves figures with captions to the right pane.
- Reads validated MinerU packages with continuous PDF pages, synchronized text,
  figure navigation, reconstructed visuals, and caption recovery safeguards.
- Creates local Markdown annotations from selected reading text.
- 划选批注支持 Direct API 原生联网或 Tavily 浅层检索，共用联网问答配置，
  保留来源链接并支持取消与总时间限制。
- Provides a vault dashboard, query view, and optional Direct API connections.
- 设置提供常用入口、功能分类与全局搜索；模型连接优先配置，高级参数按需展开。
  详见[设置使用说明](docs/settings.md)。
- Adds a persistent interactive PDF learning space with a main teaching path,
  question branches, a mind map, and optional conversation panes. It reads original
  PDFs or validated MinerU packages through Direct API or an independent Codex CLI
  adapter. See the [交互深读使用说明](docs/interactive-reading.md).
- 新会话先规划简短阅读路线，每个单元保留标题、中心问题和候选证据；
  主线采用精简导读规则，首次讲全文总览，之后按箭头逐步展开。
  已有会话沿用原路线。详见[主线导读质量](docs/guided-reading-quality.md)。
- Adds a bounded Direct API reading assistant for progress, verified text evidence,
  knowledge retrieval, and guided curation/export previews. Requests retain tool
  traces and token usage; optional schema probes enable native structured output.
  Action cards track linked reading nodes, curation reviews, and exported files,
  including failures, retries, revisions, and restoration after reload.
  See the [阅读助手说明](docs/reading-assistant.md).
- Offers optional BGE hybrid retrieval and reranking through SiliconFlow, with
  incremental local vector storage, evidence previews, and paper scope constraints.
  Learning-note exports support reviewed associations, duplicate reuse, and preserved
  revisions. See [知识库检索与索引](docs/semantic-retrieval.md).
- 新增学习内容整理工作台：独立检索相似学习记录，核对原文证据，小批量生成建议，
  预览选中段落的修改，并保留可恢复的修订记录。维护面板集中显示待审阅内容、
  需复查依据及两类索引。详见[学习内容整理与正式知识修订](docs/knowledge-curation.md)。
- Runs paper intake through an in-plugin bounded agent loop on a Direct API
  profile (phase-gated: local PDF metadata/first-page identity preflight,
  exact DOI verification before any fuzzy lookup, and independent dedup for the source
  layer (`papers/` + `Clippings/`) and analysis layer (`wiki/sources/`),
  plugin-driven MinerU conversion only when source Markdown is missing, and plugin-built
  create-only wiki notes) — no coding agent required; PDF conversion needs
  only the `mineru-open-api` CLI (npm), not Python or the toolkit. The
  optional Codex CLI toolkit pipeline remains available for full registry
  updates.
- Detects optional Codex CLI, Claude Code, OpenCode, MinerU, Python, R, and
  Obsidian CLI installations without installing or updating them.
- Supports optional Research Vault Toolkit workflows for deep reading, code
  analysis, vault linting, and OKF export.

The current user interface is primarily Simplified Chinese. English localization
is planned before the first stable community release.

## Requirements

- Obsidian `1.11.4` or later.
- Obsidian Desktop. Mobile is not supported because the plugin uses Node.js APIs
  and can launch explicitly configured local processes.

The document reader and local annotations do not require an AI account or the
Research Vault Toolkit. Every external backend is optional.

Core features use the active Vault through Obsidian APIs. On a clean install,
the plugin does not infer an arbitrary parent folder as a toolkit workspace.
Advanced actions remain unavailable until the user explicitly configures a
compatible toolkit project and executable paths.

## Installation

### Development install

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

Copy the generated `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/research-agent-reader/
```

Then enable **Research Agent Reader** under **Settings → Community plugins**.

### Beta install

Install the BRAT community plugin, add
`https://github.com/lljh2777-cyber/research-agent-reader`, and select the latest
release of Research Agent Reader. Release tags exactly match the version in
`manifest.json`, without a `v` prefix.

## Reader setup

The default reader folders are `papers` and `Clippings`. Change them under
**Settings → Research Agent Reader → 文献阅读器**. Markdown source files are never
rewritten merely to support the two-pane reader; inferred figure labels exist
only in the reading view.

`papers/` 与 `Clippings/` 的批注独立保存在 `wiki/annotations/`，不改写原文。
重新划选同一段文字并打开批注，可查看或编辑已保存的内容；批注文档中的来源以路径记录。
Wiki 笔记继续使用原有的行内批注链接。

`papers/`, `wiki/`, and `Clippings/` are isolated content roots. Do not create
Obsidian wikilinks or Markdown links from one of these roots into another. The
built-in vault health check audits `wiki/` plus top-level Markdown files;
`papers/` and `Clippings/` are excluded from ordinary broken-link, orphan,
frontmatter, and content findings and receive only a lightweight cross-root
link-boundary check.

A validated MinerU package uses this layout:

```text
papers/<citekey>/
├─ article.md
├─ mineru-result.json
├─ images/
└─ _extraction/
   ├─ manifest.json
   ├─ validation.json
   ├─ viewer-index.json
   ├─ visual-repair.json
   ├─ visual-candidates.json  # bounded review packet; never auto-applied
   └─ source.pdf            # optional; enables PDF crop reconstruction
```

Native MinerU intake generates the versioned viewer sidecars inside the
same atomic staging directory and binds them in `manifest.json` by size and
SHA-256. Older validated packages without sidecars are reconstructed in memory;
any stale or malformed relationship fails closed to the original assets. The
candidate packet contains only deterministic review IDs and structural evidence;
it is not consumed as an automatic repair decision. These hashes are package
integrity and consistency checks only; they are not signatures and do not
authenticate the extractor, publisher, or scientific source.

## Optional workflow toolkit

Advanced dashboard actions expect a separately installed project toolkit. The
community plugin does not download, install, or update Python scripts, agent
CLIs, models, or other dependencies. Missing tools are reported as unavailable
and do not prevent the reader from loading.

See [Optional Research Vault Toolkit](docs/companion-toolkit.md) for the current
filesystem contract and backend responsibilities.

The optional toolkit is discovered only when a candidate directory contains
both `AGENTS.md` and `tool-library/scripts/run_vault_action.py`, or when the user
selects a project directory in settings. Missing dependencies produce an
actionable availability message and never disable the reader, local annotations,
or the built-in read-only health check.

## Privacy and permissions

Research Agent Reader contains no client-side telemetry and does not load advertising.

Depending on features the user explicitly configures or starts, the plugin can:

- read and write files in the active Obsidian vault;
- read a configured project directory outside the vault;
- launch local Codex CLI, Claude Code, OpenCode, MinerU, Python, R, or Obsidian
  CLI processes;
- send selected prompts, retrieved note excerpts, explicitly attached images,
  and a bounded first-page text excerpt used by paper-intake identity checks to
  a configured model provider; PDF preflight parsing itself remains local and
  never sends the absolute source path;
- upload a selected document to the configured MinerU service after confirmation;
- query public Europe PMC/Crossref metadata by paper identifier and, after
  source selection, download a PMC or Unpaywall-discovered PDF into the plugin's
  `fulltext/production/` storage. Optional Unpaywall lookup sends the DOI and an
  explicitly configured contact email to its API; the email stays in local
  settings and is excluded from acquisition records. Acquisition uses direct
  HTTPS without model calls, cookies, API keys, or system/Obsidian proxy settings.
  Each PDF target and redirect must pass public-address checks. Cached PDFs,
  metadata and partial attempts are retained. Continuing into intake requires
  selecting a model and, for MinerU conversion, a new upload confirmation;
- save bounded task and query records in the plugin's local `data.json` file;
- save completed-task full output, including any model/tool trace or Vault
  excerpts present in that run, in plugin-local sidecars under
  `.obsidian/plugins/research-agent-reader/task-output/dashboard-runs/`.

The **Clear completed tasks** action removes completed history records and
their registered sidecars. Unreferenced compatibility outputs created by older
beta versions inside an optional Toolkit are not deleted automatically.

Direct API credentials and an optional MinerU API token are referenced through
Obsidian SecretStorage. The plugin stores the secret name, not the secret value,
in `data.json`; the selected MinerU token is passed only to the launched CLI as
`MINERU_TOKEN`. MinerU can instead continue using its own CLI authentication or
an existing process environment variable. Other CLI credentials remain under
the control of the corresponding CLI. Users are responsible for reviewing the
terms and privacy policy of every configured external service.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and additional
trust-boundary details.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm verify:public
```

`main.js` is generated and intentionally excluded from source control. GitHub
Releases contain `main.js`, `manifest.json`, and `styles.css` as individual assets.

Optional private MinerU regression packages can be enabled locally with:

```powershell
$env:AGENT_DASHBOARD_FIXTURE_WORKSPACE = "D:\path\to\research-workspace"
pnpm test
```

For Obsidian CLI QA, set `OBSIDIAN_VAULT_NAME` and optionally
`OBSIDIAN_CLI_PATH`, then run `pnpm obsidian:qa`. The wrapper exposes only a
fixed diagnostic command set and does not expose `eval`, restart, restore, or
delete operations.

To prepare a disposable clean Vault containing the built plugin and public test
fixtures, run `pnpm test-vault:prepare`. The command never launches or restarts
Obsidian; it prints the generated Vault path and a manual smoke-test checklist.
See [Public release checklist](docs/release-checklist.md) for the remaining
desktop QA and screenshot requirements.

For a private comparison of lexical, reranked, and hybrid retrieval, see
[Retrieval benchmark](docs/retrieval-benchmark.md). Its synthetic tests run with
`pnpm test:retrieval-benchmark`; real corpus snapshots and results stay outside
the repository and Vault.

## License

MIT. See [LICENSE](LICENSE). Third-party integrations and development tools are
documented in [Third-Party Notices](THIRD_PARTY_NOTICES.md).

---

## 简体中文说明

Research Agent Reader 是桌面版 Obsidian 科研阅读与本地智能体工作流插件。核心阅读器
可直接阅读普通 Markdown、Obsidian Web Clipper 文档和经过验证的 MinerU 文献包。
AI 能力分三层：只需一个 Direct API 配置即可使用知识库问答、联网搜索、问答落笔记
和轻量文献入库（身份核验 + 去重 + 初步文章 Wiki；配置 MinerU CLI 后可生成完整原文
Markdown 包，并由轻量 Agent 读取已验证的 `article.md` 生成摘要级 Wiki，无需 Python、
工具包目录或 Codex CLI）。身份核验会先在本机读取 PDF 元数据与第一页文本作为候选线索；
提取到 DOI 时先精确核验，只有本地线索不足时才使用 Crossref 模糊搜索。写入前，用户必须
对照同一授权 PDF 快照最终渲染的标题页明确确认 Crossref 记录。入库结果可预览并完成本地索引登记；
工具包绑定当前库时可同步 papers.csv、references.bib。PDF 交互深读支持独立 Direct API 与 Codex CLI；
代码分析现已支持 Python/R 文件与小型项目的交互阅读，提供主线、支线、源码行号与独立学习笔记，详见 [代码阅读](docs/code-reading.md)。一次性深读、一次性代码笔记和综合分析等高级工作流继续使用 Toolkit。知识库体检内置可用，OKF 导出仍是 Toolkit 脚本能力。插件不会自行
安装外部程序，也不会包含客户端遥测。
