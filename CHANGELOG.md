# Changelog

All notable changes to this project will be documented in this file.

## [0.29.0] - Unreleased

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
