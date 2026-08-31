# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- 文献入库的任务默认策略现在可选择自动、轻量 Agent 或 Codex CLI 运行方式；各任务的模型覆盖改为由内置模型目录、CLI 探测结果和已配置自定义模型共同生成的下拉列表，未知的历史配置值仍会作为自定义项保留。
- 轻量文献入库的「生成原文 Markdown」不再依赖工具包目录和 Python：插件直接调用 mineru-open-api CLI（npm），在插件内完成暂存、校验（单一 md/json、标题完整性、引用资产存在性与路径逃逸防护）与原子发布（create-only，写入阅读器兼容的 `_extraction/manifest.json` + `validation.json`）。设置 → 工具链与运行环境新增「组件就绪状态」清单（MinerU CLI / 工具包目录 / Python / Codex CLI 各自解锁什么、是否就绪）。

### Fixed

- 轻量入库的身份核验和去重现在只接受工具生成的有界结构化回执：声明标题必须命中元数据候选，DOI 与标题必须来自同一精确 Crossref 回执，`none` 查重必须绑定完整标题或 DOI，`exact` 还必须由同一路径下的标题或 DOI 一致证据支持。
- MinerU 包先在 Vault 同卷唯一 staging 中完整复制，再以单次目录 rename 暴露；复制、提交或并发失败会精确清理 staging（清理本身失败时报告唯一残留），不会暴露半包或覆盖既有包。manifest 不再记录宿主机绝对 PDF/CLI 路径，CLI 版本输出也只保留可识别的 SemVer。
- 任务完整输出改为原子写入插件本地 `task-output/dashboard-runs/` 侧车，不再依赖 Toolkit 或回落到进程工作目录；侧车与 `data.json` 通过完成日志及两阶段清理标记对账，写入或最终保存失败不会把真实任务结果改判为失败。旧版内联长输出会在任务状态归一化后迁移到同一插件本地目录，再在 `data.json` 中保留有界快照。

## [0.30.0] - 2026-08-30

### Added

- In-plugin bounded light agent for paper intake (文献入库 · 轻量 Agent): runs on any tested Direct API profile without Codex CLI. The workflow is a plugin-driven state machine — phase 1 (identity + dedup) is a read-only tool loop over Crossref metadata lookups and vault lexical search; phase 2 runs the toolkit MinerU helper deterministically on exactly the user-authorized PDF (the model never chooses the path, and the upload confirmation still applies); phase 3 collects note *fields* from the model and the plugin builds and writes the wiki note itself (create-only, `wiki/sources/<citekey>.md`, with `ingest_mode: lightweight` + `registry_status: pending` frontmatter). Results are validated against plugin-observed receipts, not model claims.
- Paper-ingest modal gains a 运行方式 choice: 轻量 Agent · Direct API (default when a tested profile exists) or Codex CLI · 完整入库 (unchanged full registry pipeline). The result modal reads the structured article/wiki paths and adds a 打开文章 Wiki button; the historical regex fallback remains for old runs.
- Settings → Direct API: 轻量 Agent controls for the per-phase tool-loop step cap (3–20) and the per-turn output token cap (512–8192, default 4096 — prevents protocol JSON truncation at provider 256-token defaults).

### Changed

- Task stopping is now resolved by a unified `stopTaskRun` (light-agent loop → direct query → process) instead of inferring the executor from `executionConfig.backend`, so the dashboard stop button reliably stops light-agent runs.
- Loop hardening: cancellation and the wall-clock deadline share one abort signal handed to tools (the MinerU subprocess is killed promptly on abort, with capped output capture); consecutive (not lifetime) protocol-failure repair; tool-output budget is a hard cap without the 200-char floor; the JSON extractor skips invalid leading objects; read tools are restricted to `wiki/sources` + `papers`; generic URL fetches were replaced by `crossref_search` / `crossref_doi` domain tools that own the URL.
- Receipt binding: the MinerU receipt is derived from where the helper actually published and only counts when the article lies inside the active vault (stale same-citekey packages are never claimed); cancelling a run aborts in-flight HTTP via registerCancel, terminates the helper's process tree (taskkill /T on Windows, process group on POSIX), shuts down on plugin unload, and caps the MinerU timeout at the run's remaining budget.
- Search scoping: `vault_search` runs (and ranks) only inside `wiki/sources` + `papers`, so out-of-scope paths and titles never reach the model.
- Safe note serialization: frontmatter values are single-line quoted scalars (injection-proof), note commits use the vault's atomic create with read-back verification, cross-root links are rejected, and bibliographic metadata (authors/year/doi) is stored alongside `ingest_mode`/`registry_status`.
- Identity gating: "verified" is accepted only with plugin-observed tool receipts (metadata lookup + dedup lookup + exact DOI verification when a DOI is claimed), a structured `duplicateStatus` (exact → skip as no-op, possible → human confirmation), and deterministic citekey suffixing on collisions; technical errors are reported as failures, distinct from evidence conflicts.

## [0.29.0] - 2026-08-30

### Added

- Direct API 联网搜索: the query view's 联网搜索 mode now works with Direct API profiles through a bounded in-plugin loop. Provider-native server search is used first (OpenRouter, Qwen/DashScope, Zhipu GLM, and DeepSeek's Responses API `web_search` tool — auto-detected from the endpoint), with Tavily as the universal fallback (API key kept in Obsidian SecretStorage). Search queries are LLM-expanded and capped at 3; results are deduplicated, truncated, and the answer must cite [n] sources, which flow into the existing web-source panels and citation validation. Each profile's 联网方式（自动/仅原生/仅 Tavily/关闭）lives in the Direct API settings.
- Query answers can be saved as Markdown notes in one click (落为笔记): each completed answer gains a note button that writes the question, answer, and deduplicated source wikilinks into a configurable folder (default `wiki/qa`) with `type: qa` frontmatter and a session backlink.

### Changed

- Regrouped the settings home page into 阅读 · 开箱即用 / AI 助手 / 可选扩展 · 高级 sections with unified per-module state badges, renamed the 运行环境 module to 工具链与运行环境, and clarified in the header that core reading works without any configuration.
- Extracted the plugin into a standalone repository layout.
- Raised the minimum Obsidian version to 1.11.4 for SecretStorage compatibility.
- Removed the default annotation hotkey so users can choose their own shortcut.
- Removed user-specific Python and R executable defaults.
- Made the regression suite runnable from the plugin repository.
- Added community-release documentation, privacy disclosures, CI, and release automation.
- Made optional toolkit discovery require real toolkit markers instead of assuming every Vault is a project workspace.
- Added cross-platform CLI candidate discovery and platform-neutral public UI examples.
- Added a public-release audit and disposable clean-Vault smoke-test fixture.
- Clarified in settings and runtime errors that the reader, annotations, and built-in health check do not need external tools.
- Added a strict release guard for the already-occupied provisional plugin ID and display name.
- Renamed the public plugin identity to `Research Agent Reader` with ID `research-agent-reader` before publication.

### Fixed

- The Tavily settings section is now rendered before the profile editor, so the global API key stays visible even when no Direct API profile is selected; its description no longer lists DeepSeek as Tavily-only (DeepSeek web search runs natively through its Responses API).
- Internals: the Direct API vault and web flows share one completion helper (streaming, fallback, cancellation) and profile loading instead of duplicated blocks.
- Direct API 的能力边界不再固定显示「不联网」：连接测试结果按 profile 的联网方式显示真实边界（原生联网 / Tavily / 未配置兜底），问答视图的后端说明按知识库/联网模式区分。
- 批注的浅层联网解释在供应商支持原生联网（OpenRouter / 千问 / 智谱 / DeepSeek）时保留 Direct API 后端并携带服务端联网参数，只有不支持原生联网时才回退 Codex CLI。
- 设置页不再在控件触发重渲染时跳回顶部：同页重渲染保持滚动位置，切换模块时回到顶部。
- Annotations are now reachable from the reader itself: the reading pane header has a 批注 button, and selecting body text shows a floating 批注 chip next to the selection. Previously the only entry was a command palette command, so the feature looked unusable inside the reader. Wiki notes support the same flow in Live Preview/source mode (selections are captured through the editor API) and in reading mode. The 批注 AI settings page documents both entries and links to Obsidian's hotkey settings so users can bind a custom shortcut (e.g. Shift+S) to the 批注所选文字 command.
- Direct API image attachments and vault evidence packets now read through the active Obsidian Vault API instead of deriving a `knowledge-base` folder from the toolkit root, so they work in any Vault layout. Evidence paths resolve as-is first; the legacy `knowledge-base/` prefix strip only applies when the exact path does not exist.
- Vault sources shown in the query view and persisted in query sessions resolve through the same exact-path-first rule, so a real top-level `knowledge-base/` folder is no longer rewritten and distinct sources can no longer collide into one during dedupe.
- Added an in-plugin lexical retrieval fallback so Direct API vault queries work without the optional toolkit; toolkit retrieval stays primary when configured, and failures fall back transparently with a trace reason shown in the query view.
- Renamed the persisted `projectRoot` setting to `toolkitRoot` with automatic migration of existing `data.json` values.
- The in-plugin retriever now follows the toolkit trace contract: `lexical_seeds` carries matched page objects, `lexical_terms` carries query tokens, and LLM keyword expansion triggers whenever no candidate page was found (even if the query tokenized successfully). Expansion terms keep a reserved token quota.
- Indexed note bodies with a per-field token budget instead of a shared 48-token cap, so target terms deep inside a long note stay reachable.
- Notes whose body indexing was interrupted by the time budget are completed on a later query instead of being skipped forever, and transient read failures no longer mark a body as indexed.
- Image attachments enforce the size limit against the bytes actually read (not the possibly stale `stat.size`) and report the actual size to the provider.
- LLM keyword expansions are now recorded in the retrieval trace (`used` plus the generated `terms`) so Direct API answers stay auditable.
- Independent CLI processes (model discovery, version probes, connection tests) no longer spawn inside the optional toolkit directory; without a configured toolkit they fall back to a safe working directory instead of failing. Toolkit-requiring runners now reject execution up front with an actionable error instead of creating stray stop-file directories.

### Notes

- Advanced Research Vault workflows still require a separately installed toolkit.
