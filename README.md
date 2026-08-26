# Research Agent Reader

Research Agent Reader is a desktop-only Obsidian plugin for reading research Markdown,
reviewing validated MinerU document packages, annotating selected text, and
connecting optional local AI-agent workflows.

> Public release status: `0.29.0` beta preparation. The plugin is not yet listed
> in the Obsidian Community directory.

## Features

- Opens Markdown files from configurable folders in a two-pane research reader.
- Keeps article text in the left pane and moves figures with captions to the right pane.
- Reads validated MinerU packages with continuous PDF pages, synchronized text,
  figure navigation, reconstructed visuals, and caption recovery safeguards.
- Creates local Markdown annotations from selected reading text.
- Provides a vault dashboard, query view, and optional Direct API connections.
- Detects optional Codex CLI, Claude Code, OpenCode, MinerU, Python, R, and
  Obsidian CLI installations without installing or updating them.
- Supports optional Research Vault Toolkit workflows for paper intake, deep
  reading, code analysis, vault linting, and OKF export.

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

After the first GitHub release is published, beta users will be able to install
the repository through BRAT. Release tags must exactly match the version in
`manifest.json`, without a `v` prefix.

## Reader setup

The default reader folders are `papers` and `Clippings`. Change them under
**Settings → Research Agent Reader → 文献阅读器**. Markdown source files are never
rewritten merely to support the two-pane reader; inferred figure labels exist
only in the reading view.

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
   └─ validation.json
```

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
- send selected prompts, retrieved note excerpts, and explicitly attached images
  to a configured model provider;
- upload a selected document to the configured MinerU service after confirmation;
- save bounded task and query history in the plugin's local `data.json` file.

Direct API credentials are referenced through Obsidian SecretStorage. The plugin
stores the secret name, not the secret value, in `data.json`. CLI credentials
remain under the control of the corresponding CLI. Users are responsible for
reviewing the terms and privacy policy of every configured external service.

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

## License

MIT. See [LICENSE](LICENSE).

---

## 简体中文说明

Research Agent Reader 是桌面版 Obsidian 科研阅读与本地智能体工作流插件。核心阅读器
可直接阅读普通 Markdown、Obsidian Web Clipper 文档和经过验证的 MinerU 文献包；
高级文献入库、全文深读、代码分析、知识库体检及 OKF 导出需要另行配置 Research
Vault Toolkit。插件不会自行安装外部程序，也不会包含客户端遥测。
