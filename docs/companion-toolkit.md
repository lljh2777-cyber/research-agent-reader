# Optional Research Vault Toolkit

The Obsidian community release contains only the plugin bundle. It does not ship
or install Python scripts, Codex skills, agent definitions, R, MinerU, or other
executables.

Advanced actions currently recognize a configured project root with this contract:

```text
<project-root>/
├─ AGENTS.md
├─ tool-library/
│  ├─ scripts/
│  │  ├─ run_vault_action.py
│  │  ├─ run_code_practice.py
│  │  ├─ lint_vault.py
│  │  ├─ export_okf.py
│  │  └─ run_mineru_extract.py
│  └─ output/
└─ knowledge-base/
```

The read-only **知识库体检** action is built into the plugin and does not require
this toolkit. Its ordinary audit scope is `wiki/` plus top-level Vault Markdown.
`papers/` and `Clippings/` are excluded except for the hard boundary rule that
forbids links among `papers/`, `wiki/`, and `Clippings/`. The companion toolkit
is still required for AI-assisted lint repair and other advanced write actions.

## Light Agent (Direct API) paper ingest

文献入库 offers an in-plugin "轻量 Agent" runner that does **not** need Codex
CLI (or any coding agent). The model behind a user's Direct API profile drives
a bounded, phase-gated tool loop inside the plugin: identity verification via
`crossref_search` / `crossref_doi` (plugin-constructed URLs), vault lexical
search, and capped identity reads restricted to `wiki/sources`, `papers`, and
`Clippings`.

The model never writes files and never chooses extraction paths:

- When the selected output includes original Markdown, the plugin runs the
  conversion itself: it spawns the user-configured `mineru-open-api` CLI
  directly (npm; no Python and no toolkit required). Automatic and saved CLI
  paths must resolve to a package whose `package.json` name and declared bin
  entry are both `mineru-open-api`; arbitrary native executables are rejected.
  The plugin validates the
  extraction with the same gates as the toolkit helper (single md/json,
  non-empty article with a title heading, every referenced asset present
  inside the package), and publishes create-only into the active vault at
  `papers/<citekey>/` with a reader-compatible `_extraction/manifest.json`
  and `validation.json`. Before any remote extraction, the plugin copies the
  selected ordinary PDF into a private, bounded, SHA-256-addressed snapshot;
  both local identity evidence and MinerU consume that same immutable byte
  sequence. A same-citekey package is never overwritten or claimed.
- The wiki note is written by the plugin from model-supplied *fields* into
  `wiki/sources/<citekey>.md` via the vault's atomic create (never
  overwriting), with safe single-line YAML scalars, bibliographic metadata
  (authors/year/doi), `ingest_mode: lightweight`, and
  `registry_status: pending` frontmatter.
- "Verified" identity results are additionally gated on plugin-observed tool
  receipts (at least one metadata lookup, one dedup lookup, and exact DOI
  verification whenever a DOI is claimed) plus an explicit human visual
  confirmation. The user compares a final PDF.js raster from the authorized
  snapshot with the plugin-bound Crossref record; filenames, metadata, and
  PDF text-layer candidates remain discovery hints only.

The light runner never updates `papers.csv`, `references.bib`, or index/log
pages — those registry files remain the Codex CLI pipeline's job, which can
later upgrade a lightweight product to a fully registered entry.

创建文章 Wiki 前必须读取本篇原文。复用 `papers/` 中的既有包时，插件会重新执行
阅读器的完整包校验；`Clippings/` 仍可作为普通 Markdown 原文使用。没有可用原文、
没有成功的原文读取回执，或模型明确报告证据不足时，不创建摘要级 Wiki。
仅选择 Wiki 且没有既有原文时，应先生成原文，或改用能够读取 PDF 正文的工作流。

This is an integration contract, not an installation instruction. The public
toolkit repository, version compatibility policy, installer, and upgrade path
will be defined separately before advanced workflows are advertised as stable.

When the project root or a required executable is missing, the plugin should
show a diagnostic result and leave standalone reading features available.
