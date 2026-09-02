# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- 轻量文献入库在访问 Crossref 前会通过 Obsidian 内置 PDF.js 本地读取 PDF 元数据与第一页文本，提取标题/DOI 线索；若发现 DOI，工具层会强制先走 `crossref_doi` 精确核验，全部本地候选尝试失败后才允许最多两次模糊搜索。绝对路径不会进入模型提示，PDF 预检也不会上传原文件。
- 轻量文献入库新增最终栅格人工身份确认门：文件名、PDF 元数据和文本层只用于发现候选；插件从同一授权快照渲染前 3 页供用户选择标题页，并要求明确确认 Crossref 记录。确认回执绑定任务 ID、快照 SHA-256、页面栅格 SHA-256、渲染参数和 Crossref 记录哈希；缺少回执、切换任务/PDF/记录或渲染失败时不会进入 MinerU 或 Wiki 写入阶段。

### Changed

- 文献入库的任务默认策略现在可选择自动、轻量 Agent 或 Codex CLI 运行方式；各任务的模型覆盖改为由内置模型目录、CLI 探测结果和已配置自定义模型共同生成的下拉列表，未知的历史配置值仍会作为自定义项保留。
- 轻量文献入库的「生成原文 Markdown」不再依赖工具包目录和 Python：插件直接调用 mineru-open-api CLI（npm），在插件内完成暂存、校验（单一 md/json、标题完整性、引用资产存在性与路径逃逸防护）与原子发布（create-only，写入阅读器兼容的 `_extraction/manifest.json` + `validation.json`）。设置 → 工具链与运行环境新增「组件就绪状态」清单（MinerU CLI / 工具包目录 / Python / Codex CLI 各自解锁什么、是否就绪）。

### Fixed

- 外部安全审查后的轻量入库边界加固：本地 PDF 先按 128 MiB 上限、取消信号和前后文件状态生成私有不可变快照，并由 SHA-256 同时绑定身份预检、人工视觉确认与 MinerU 输入；Crossref 最终记录必须由用户对照该快照的最终渲染页面明确确认。精确重复的路径与 citekey 只从 Vault 工具回执推导。npm shim 只接受 `mineru-open-api` 包名及其声明的 bin 入口。MinerU 输出和阅读器加载均增加目录深度、文件数、累计字节、JSON 深度、图片数/像素及 manifest 覆盖预算，拒绝符号链接、junction 和特殊文件；同一 citekey 由发布锁串行化。停止/超时只有在实际观察到子进程关闭后才返回，暂存清理不跟随链接。任务侧车和 Vault 文本读取也增加了持久化前及读取前后的大小上限。这里的 SHA-256 用于同一次流程内的完整性与一致性校验，不代表签名、发布者身份或来源真实性。
- 文献入库与阅读器的运行时规则已收敛为单一职责模块：入库提示词/输入解析不再与状态机和写入边界混杂，阅读位置恢复不再属于图片修复模块；`visual-repair.json` 现在明确只是派生缓存，阅读器始终从已验证的 `article.md` 与 `mineru-result.json` 生成当前确定性显示计划，旧包或同版本但内容不一致的缓存不能继续影响图片合并、图注归属或正文初始位置。视觉算法版本与兼容判断也改为单一常量，避免加载器和生成器各自维护版本分支。
- 原生 MinerU 入库现在会在同一原子 staging 内生成、验证并由 manifest 的 size/SHA-256 绑定 `viewer-index.json`、`visual-repair.json` 与只读 `visual-candidates.json`；候选包只含确定性的复核 ID、几何与结构信号，不含资产路径或原文，也不会被阅读器自动执行。旧包缺少 sidecar 时仍会从原始 JSON 的页码、bbox、相邻关系、Markdown 图片顺序和图注信号在内存中重建。整页仅含连续视觉分片时可按精确页覆盖从 PDF 重建，完整大图与其内含重复子图也会按一一对应关系折叠；无 `source.pdf` 的裁剪计划强制降为复核。持久化和运行时两条路径共用输入哈希、块内容、Markdown occurrence、PDF 来源声明和结构资源上限的反向绑定，失败时整组回退原图；不修改 `article.md`、原始图片、JSON 或 PDF，现有包无需重新入库。
- 轻量入库身份阶段改为插件强制的 Vault-first 顺序：必须先检索 `papers/`、`Clippings/` 与 `wiki/sources/`，可从已有候选取得未截断标题和 DOI 后直接进行 `crossref_doi` 精确核验；完成本地预检前 Crossref/Web 工具会拒绝调用。避免截断 PDF 文件名和模型错误改写检索词耗尽两次模糊搜索预算后误报冲突。
- npm 0.5.x 的 `mineru-open-api` 使用无扩展名 Node 包装器查找平台原生程序；插件现在校验 npm 包结构后直接启动其中的 `mineru-open-api` 原生二进制，并让设置页 CLI 检查复用同一解析器，不再尝试把 Obsidian/Electron 当作 Node 运行时。旧逻辑会以 0 退出但留下空暂存目录。输出发现失败时也会列出暂存文件，便于区分空产物与布局变化。
- 精确重复现在按两个独立产物层判断：`papers/` 与 `Clippings/` 同属原文层，`wiki/sources/` 属于分析层。已有分析笔记但缺原文时仅补 MinerU 包；已有 papers article 或 Clipping 但缺分析时读取该原文补 Wiki；两层都存在才整项 no-op。补全时沿用可确认的既有 citekey，不创建 `-2` 分叉记录，也不覆盖已有输出。
- 轻量入库身份阶段不再允许模型无休止重复 Crossref 模糊搜索：每阶段最多两次，并在候选结果中明确引导 DOI 精确核验和 Vault 查重；提示词新增提交前工具清单。轻量 Agent 的单轮模型请求超时最低提升到 60 秒（仍受任务总预算约束），避免较长工具转录在 Direct API 默认 20 秒处中断。
- 轻量文献入库现在能在同一次任务中读取刚由 MinerU 原子发布的 `papers/<citekey>/article.md`：摘要阶段使用绑定发布回执的 `article_read` 直接经 Vault adapter 取得标题、目录、摘要与主要章节证据包，不再等待 Obsidian 异步文件索引。模型未成功读取该回执或 MinerU 未返回有效文章时不会创建 `wiki/sources/` 摘要笔记，也不会静默降级为仅依据元数据生成。
- 文献阅读器首次打开含图片的 Markdown 时，正文现在固定从顶部开始；右侧「图片与图注」仍可默认展示第一张图，但该参考栏默认值不再冒充已保存的正文阅读锚点并触发 `scrollIntoView`。已有真实阅读锚点或 PDF 页码的恢复行为保持不变。
- MinerU 设置现在可通过 Obsidian SecretStorage 选择或创建 API Token，插件只在 `data.json` 中保存凭据名称，并在运行时通过 `MINERU_TOKEN` 传给 CLI；CLI 配置和系统环境变量仍可继续使用。Windows npm PowerShell shim 的版本检查会主动关闭标准输入，不再等待 10 秒超时；从 npm shim 解析出的 JavaScript 入口在 Obsidian/Electron 中以 Node 模式启动。
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
