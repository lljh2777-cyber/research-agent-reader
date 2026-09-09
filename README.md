# Research Agent Reader

Research Agent Reader is a desktop-only Obsidian plugin for reading research Markdown,
reviewing validated MinerU document packages, annotating selected text, and
connecting optional local AI-agent workflows.

> Public release status: `0.31.0` beta is published at
> [GitHub Releases](https://github.com/lljh2777-cyber/research-agent-reader/releases/latest).
> The plugin is not yet listed in the Obsidian Community directory.

The `codex/research-learning-map` development branch is at `0.43.2`; the beta
release link above remains the published release.

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
