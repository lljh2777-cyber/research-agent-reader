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
a bounded tool loop inside the plugin: identity verification via allowlisted
HTTPS metadata hosts (Crossref/arXiv/DOI), vault lexical search, capped file
reads, and writes restricted to `papers/<citekey>/` and `wiki/sources/`. It
never updates `papers.csv`, `references.bib`, or index/log pages — those
registry files remain the Codex CLI pipeline's job.

When the selected output includes original Markdown, the loop still spawns
`tool-library/scripts/run_mineru_extract.py` from this toolkit (Python +
MinerU CLI stay required for PDF conversion). Without the toolkit, only the
wiki-note output is available.

This is an integration contract, not an installation instruction. The public
toolkit repository, version compatibility policy, installer, and upgrade path
will be defined separately before advanced workflows are advertised as stable.

When the project root or a required executable is missing, the plugin should
show a diagnostic result and leave standalone reading features available.
