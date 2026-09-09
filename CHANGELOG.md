# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fulltext acquisition M3 — 0.46.0

- 新增可选 Unpaywall 回退和独立「全文来源」设置。联系邮箱由用户填写，查询时发送至 Unpaywall，不进入获取记录；遍历 OA locations，只接收符合稿件策略的直接 PDF。
- 首个候选失败后按列表尝试后续候选；PMC 文件失败后发现的新 OA 候选需再次选择。动态 HTTPS 目标及每次重定向均核对公网 DNS 和实际连接，拒绝私网、认证或签名地址；单文件 64 MiB，累计接收上限 128 MiB，总活动预算 5 分钟。
- 已获取 PDF 可「继续入库」，独立选择模型、输出及 MinerU 上传授权。绑定快照哈希和任务引用，仍执行原有视觉身份确认与去重；失败续办复用 PDF，保留参数但重新取得授权。
- 获取和入库任务分别保存状态与双向关联。新入口触达的授权副本、MinerU 暂存目录及任务输出保留，避免通过旧清理路径删除文件。
- 新增 OA、入库文件保留与原生续办专项；完成公开 JOSS PDF 的真实下载、预览和重载后零网络复用。详见 [M3 实现与验收](docs/fulltext-acquisition-m3.md)。

### Fulltext acquisition M2 — 0.45.0

- 正式接入 Europe PMC 精确标识、Crossref 元数据和 PMC 云版本清单。用户核对论文与版本后获取 PDF，支持出版版本及可选的作者接受稿。
- 下载使用有界 HTTPS 直连与固定来源，校验实际连接地址、字节数、PMC MD5、本地 SHA-256 和 PDF 可解析性；清单变化、身份冲突、断流及超限均停止完成提交。
- 增加无模型的本地 PDF 翻页预览。区分首页身份线索匹配与身份待核对，正文证据仍未深读。
- 真实文件与不可变快照独立保存；重载和标识别名复用前核验文件哈希。未完成文件保留，重试创建新尝试，既有入库及演示保持兼容。
- 增加传输、PMC 与文件存储专项，以及公开样本的原生下载、预览、重载验收。详见 [M2 实现与验收](docs/fulltext-acquisition-m2.md)。

### Fulltext acquisition M1 — 0.44.0

- 新增不依赖模型配置的全文获取入口，识别 DOI、PMID、PMCID 及对应官方链接；真实来源尚未接入，正式下载按钮保持禁用。
- 独立开发命令提供虚构论文流程演示，支持候选选择、模拟进度、停止、重试和插件重载后的记录恢复。演示回执与正式历史分开保存。
- 获取服务使用尝试标识隔离迟到事件，阶段记录与完成回执独立持久化；文件采用追加修订和完成标记，保存失败不显示完成，不自动删除旧记录。
- 新增全文获取内存专项及原生 Obsidian 界面验收。详见 [M1 使用与开发说明](docs/fulltext-acquisition-m1.md)。

### Changed

- 导图增加节点全文搜索、空白处拖动平移、适应视野和返回最新主线；搜索自动展开相关折叠支线，小窗显示问题来源路径并支持返回起点，保留固定窗口的位置与大小。
- 划选回答先显示追问与复制工具条，明确操作后才建立引用追问；输入区标明新建支线、继续当前支线或引用子支线，仅导图模式的主输入框可收起并保留草稿。
- 阅读会话改为可搜索的管理面板，支持分组、置顶、重命名、归档与恢复；演示和测试默认隐藏，新测试独立存储，相同且未变化的来源默认继续已有会话。
- 阅读小窗支持四边、四角拖动缩放与键盘微调，增大右下角操作区域；压缩标题栏、边距和输入区，长问题自动增高，正文获得更多可用空间。
- 重新设计交互深读界面：青绿色主线与暖金色追问、分段模式切换、编号导图节点、阅读路线与进度、更宽松的正文排版及悬浮输入区，适配深浅主题与窄分栏。
- 正文中的已知证据标记显示为可点击数字，来源列表默认收起；划选时还原原始引用，保存与导出的回答不被改写。浮窗增加边界约束，分栏支持键盘调整。

### Added

- 新增学习内容整理工作台与知识库维护面板：一至三个已完成节点、已有正式笔记、逐条证据核对、候选编辑与忽略、选择差异、来源检查和修订追踪。
- 新增独立学习记录向量索引，排除演示和测试，仅提供相似内容候选；正式问答的证据索引继续独立。
- Direct API 与 Codex CLI 共用整理 SKILL、结构化结果校验和持久化缓存；显示接口报告或估算用量，主动重新生成保留前批结果。预览与历史操作不调用模型。
- 正式段落写入使用修改前快照、文件指纹预检、串行修订日志和部分失败恢复；撤销前预览并拒绝覆盖后续手工编辑。保留标题、元数据、深度与既有链接。
- 新增 `pnpm test:curation`、冻结反例的双后端评估与 Obsidian 只读预览验收。开发版本更新为 `0.33.0`，尚未发布 Release；准确性与用量限制详见知识整理说明。
- 新增可选 BGE 混合检索与重排，独立 Float32 本地索引支持增量更新、停止续建和变更检查。Direct API 知识库对话、两后端交互深读与导出关联共用片段检索，展示论文范围、内容角色和实际来源。
- 学习笔记导出增加完整预览、关联片段勾选、同范围重复导出识别、变化区段比较和修订历史；保留旧版及手工编辑，来源发生变化时要求重新预览。
- 新增 `pnpm test:knowledge` 内存回归及不创建笔记的 Obsidian 关联预览验收。

- PDF 深读默认打开交互阅读空间：主线箭头逐步讲解，双模式导图、可固定和拖动的小窗、连续支线与划选子支线共享同一会话。
- 新增独立阅读存储、自动恢复、节点草稿与主线背景快照；旧支线保留创建时背景，长对话压缩上下文并保留完整本地记录。
- 原始 PDF 和已验证 MinerU 包统一提供原文证据；Direct API 与独立只读 Codex CLI 加载仓库内的通用导读 SKILL，校验输出后推进主线。
- 按需检索本地知识库、查看来源与页面图像，并将节点、支线或完整学习会话导出到 `wiki/qa/`。原有一次性深读和独立知识库对话继续保留。
- 新增不执行文件清理的 `pnpm test:reading` 回归入口，以及显式运行的 Obsidian 交互验收脚本。

### Fixed

- 作者＋年份、DOI 等明确论文约束在候选召回前生效，避免用其他论文的相似表格替代；文件变化后旧向量和片段不会关联到新正文。
- 导出关联查询使用论文标题和节点主题，避免长回答与提问提示语让重排偏向无关边界段落；高相关分继续只作排序依据。

- `papers/` 与 `Clippings/` 的批注独立保存选区定位信息，不再改写原文或创建跨目录来源链接；重新划选同一文字可打开原有批注。
- 轻量入库必须有可读取的原文才能创建摘要级 Wiki，模型返回证据不足时停止写入；复用既有 MinerU 包前重新验证清单、哈希与资产。
- 模型接口在接收部分响应后断开时会结束请求并报告错误，超时与取消不再依赖额外的网络错误事件。
- 普通 Markdown 的图片提取和正文投影使用一致的识别及编号规则，保留行内图片并避免独立图片锚点错位。
- PDF 阅读区保留完整文档滚动空间，按可见范围增减页面并回收离窗画布，支持连续滚动翻页。

## [0.31.0] - 2026-09-04

### Added

- 轻量文献入库在访问 Crossref 前会通过 Obsidian 内置 PDF.js 本地读取 PDF 元数据与第一页文本，提取标题/DOI 线索；若发现 DOI，工具层会强制先走 `crossref_doi` 精确核验，全部本地候选尝试失败后才允许最多两次模糊搜索。绝对路径不会进入模型提示，PDF 预检也不会上传原文件。
- 轻量文献入库新增最终栅格人工身份确认门：文件名、PDF 元数据和文本层只用于发现候选；插件从同一授权快照渲染前 3 页供用户选择标题页，并要求明确确认 Crossref 记录。确认回执绑定任务 ID、快照 SHA-256、页面栅格 SHA-256、渲染参数和 Crossref 记录哈希；缺少回执、切换任务/PDF/记录或渲染失败时不会进入 MinerU 或 Wiki 写入阶段。

### Changed

- 文献入库的任务默认策略现在可选择自动、轻量 Agent 或 Codex CLI 运行方式；各任务的模型覆盖改为由内置模型目录、CLI 探测结果和已配置自定义模型共同生成的下拉列表，未知的历史配置值仍会作为自定义项保留。
- 轻量文献入库的「生成原文 Markdown」不再依赖工具包目录和 Python：插件直接调用 mineru-open-api CLI（npm），在插件内完成暂存、校验（单一 md/json、标题完整性、引用资产存在性与路径逃逸防护）与原子发布（create-only，写入阅读器兼容的 `_extraction/manifest.json` + `validation.json`）。设置 → 工具链与运行环境新增「组件就绪状态」清单（MinerU CLI / 工具包目录 / Python / Codex CLI 各自解锁什么、是否就绪）。

### Fixed

- 原子发布的 MinerU 原文包现在会在任务完成后把最终目录树显式同步到 Obsidian Vault 索引；插件启动时也会补同步磁盘已存在但文件列表尚未发现的 `papers/<citekey>/` 包。同步只刷新内存索引，不改写 `article.md`、图片、JSON 或 PDF。
- 阅读器可安全加载旧版、已验证但仍含 `<sup>`、`<sub>` 等原始 HTML 的 MinerU 包：先按原始字节验证 manifest 大小与 SHA-256，再只在内存生成被动 Markdown 并重建 Viewer Index；旧包文件保持不变。声明已经安全闭合的新包若仍含活动 Markdown 会继续失败关闭，未绑定 manifest 的图片也不会被放行。
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
