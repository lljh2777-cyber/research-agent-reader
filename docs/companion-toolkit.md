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
search, and capped reads restricted to `wiki/sources` and `papers`.

The model never writes files and never chooses extraction paths:

- When the selected output includes original Markdown and the toolkit is
  configured (Python + MinerU CLI, with the active vault corresponding to the
  toolkit root or its `knowledge-base` subfolder), the plugin itself spawns
  `tool-library/scripts/run_mineru_extract.py` for the exact PDF the user
  authorized. The receipt is then derived from where the helper ACTUALLY
  published (`packagePath`) and only counts when the article sits inside the
  active vault — stale same-citekey packages are never claimed, and the run
  fails honestly when the toolkit publishes elsewhere. The plugin also
  verifies the article opening against the verified title.
- The wiki note is written by the plugin from model-supplied *fields* into
  `wiki/sources/<citekey>.md` via the vault's atomic create (never
  overwriting), with safe single-line YAML scalars, bibliographic metadata
  (authors/year/doi), `ingest_mode: lightweight`, and
  `registry_status: pending` frontmatter.
- "Verified" identity results are additionally gated on plugin-observed tool
  receipts (at least one metadata lookup, one dedup lookup, and exact DOI
  verification whenever a DOI is claimed).

The light runner never updates `papers.csv`, `references.bib`, or index/log
pages — those registry files remain the Codex CLI pipeline's job, which can
later upgrade a lightweight product to a fully registered entry.

This is an integration contract, not an installation instruction. The public
toolkit repository, version compatibility policy, installer, and upgrade path
will be defined separately before advanced workflows are advertised as stable.

When the project root or a required executable is missing, the plugin should
show a diagnostic result and leave standalone reading features available.
