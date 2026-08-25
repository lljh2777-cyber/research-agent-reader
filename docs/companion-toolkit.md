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

This is an integration contract, not an installation instruction. The public
toolkit repository, version compatibility policy, installer, and upgrade path
will be defined separately before advanced workflows are advertised as stable.

When the project root or a required executable is missing, the plugin should
show a diagnostic result and leave standalone reading features available.
