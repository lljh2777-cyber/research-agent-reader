# Research Agent Reader

Research Agent Reader 是一个桌面端 Obsidian 插件，面向以原文证据为基础的科研文献阅读与知识沉淀：保存可靠来源、逐步理解论文、核对依据，并将有价值的阅读内容整理为可复用笔记。

未来开发以[开发路线：科研阅读、主题学习与知识沉淀](docs/development-roadmap.md)为准：接通文献详情、统一添加、摘录和知识整理，再独立推进存储迁移、翻译与专题对照。新增主题学习扩展，允许从主题、目标与基础开始，使用对话和思维导图学习一般知识；资料阅读继续保持原文证据规则。

[主题学习](docs/topic-study-t12.md)支持无资料的逐单元讲解、主支线对话和学习导图，并可[手动标记理解状态、预览与导出记录](docs/topic-records-t13.md)。入口为「主题路线（预览）→ 确认路线 → 打开学习预览」，页面打开与重载不自动调用模型。`0.56.1` 新增 [T1.3C 教学规则版本化与同题对照](docs/topic-teaching-t13c.md)：新请求使用 v2，旧 v1 回答和导出保持可读。两版九题首次回答均已留档；v2 更短、部分追问更聚焦，但仍有事实错误和过度承诺，不能认定教学质量提升，继续保持开发预览。

[T1.3D](docs/topic-quality-t13d.md) 保持 v2 规则不变，完成统计推理与 Python 迭代器两组八题首次真实答题，并核对旧答中的事实与能力承诺。新题仍暴露概念外推问题，独立教学审阅待完成，不能据此扩大教学质量声明。

[deepseek-flash 试用](docs/topic-model-deepseek-flash.md)与[迁移题补测](docs/topic-model-deepseek-transfer.md)沿用同一 v2 规则，现已留档十七题有效回答。前两次迁移运行的余额不足失败保留，用户充值后完成八题；本批核心概念解释整体优于此前 qwen，仍有能力承诺、条件遗漏与迭代器协议错误。作为学习预览优先候选，默认模型与预览状态不变，独立审阅仍待完成。

[R1 首批导航](docs/library-navigation-r1.md)已在 `0.53.0` 交付：从工作台的「文献库」搜索和筛选记录，打开详情、指定原文、阅读会话与笔记；旧 MinerU 可按需核验单个包。`0.57.0` 接入[人工阅读状态](docs/library-reading-state-r1.md)，`0.58.0` 接入[主要笔记选择](docs/library-primary-note-r1.md)：文献详情支持明确选择、更换、清除及打开主要笔记，同名笔记按路径区分。保存保留阅读状态，正文或关联变化会阻止旧编辑覆盖。`0.59.0` 已完成[首页主次入口整理](docs/dashboard-home-r1.md)，`0.60.0` 已接入[待处理摘要与最近整理](docs/dashboard-summary-r1.md)，`0.61.0` 接入[文献关联代码入口](docs/library-code-links-r1.md)，`0.61.1` 已完成[R1 工程收尾](docs/r1-closeout.md)，补齐真实 PDF/JATS 原生验证并修复阅读器标签标题；下一步进入 R2 入库与待处理流程；主题学习继续保持预览，独立审阅作为单独门槛保留。

[R0 工程开发已收尾](docs/r0-closeout.md)：文献聚合、人工决定存储与旧资料兼容成为本次导航基础；3 篇论文、18 题的固定样本和首次回答仍保留。独立人工科学审阅尚未完成，工程检查不代表模型回答质量通过。`pnpm test:r0` 可运行专用回归。

> Public release status: `0.31.0` beta is published at
> [GitHub Releases](https://github.com/lljh2777-cyber/research-agent-reader/releases/latest).
> The plugin is not yet listed in the Obsidian Community directory.

`0.76.0` 新增 [R3.8 学习摘录补充](docs/answer-excerpt-curation-r38.md)：从学习回答摘录分别选择 AI 片段、人工修订与备注，预览后补充到已有概念、方法或综合笔记；保留内容角色，复用修订恢复与撤销。学习文本块排除本插件的正式证据检索，不据此补写论文来源笔记。

`0.77.0` 新增 [R3.9 原生 PDF 摘录](docs/pdf-excerpts-r39.md)：在 PDF 同一页划选文字，点击“批注 → 保存摘录”，保留原句、页内上下文与个人备注；可编辑备注、重载找回并回到准确原页。文件变化时保留历史记录并阻止旧定位。当前尚不支持跨页或扫描图像。

`0.78.0` 接通 [R3.10 PDF 摘录补充](docs/pdf-excerpt-curation-r310.md)：从摘录详情选择“补充到已有笔记”，明确选择原句、可选备注和插入位置，预览后确认；保留文件页码与来源版本，可重开批次、中断恢复和撤销。未登记 PDF 限于概念、方法和综合笔记；论文来源笔记还须匹配已核验原文包的身份、路径与版本。

`0.79.0` 新增 [R3.11 新知识页草稿](docs/knowledge-drafts-r311.md)：从「知识整理 → 新知识页草稿」开始手写，或从原文／学习摘录带入固定材料。预览后保存，支持重开、版本回看、冲突保护及中断恢复；待处理中心可返回指定草稿。草稿保存在插件记录中，不进入正式证据检索，尚不创建正式知识页。

The `codex/research-learning-map` development branch is at `0.79.0`; the beta
release link above remains the published release.

`0.62.0` 开始 [R2：无需模型添加文献信息](docs/metadata-intake-r2.md)。在「文献库 → 添加文献信息」输入 DOI、PMID、PMCID 或支持的论文链接，查询、核对后仅保存书目信息，并直接在库中查看。保留作者、年份与查询来源，重复标识复用已有记录；不为保存书目信息生成论文笔记。跨阶段待处理中心按路线归 R3。

`0.63.0` 已接通[本地 PDF 添加与恢复](docs/local-pdf-intake-r2.md)：选择文件并查询文献标识，声明版本、核对实际页面后保存原文。无需模型，PDF 不上传；版本默认未核验。添加记录可恢复中断的保存或登记，重新选择文件必须匹配原内容。相同本地内容与版本复用原文包，保存后可在文献库查看并打开。底层来源约定见[共用保存器](docs/local-pdf-core-r2.md)。

`0.64.0` 已接通[统一添加文献入口](docs/paper-intake-r2.md)：在「文献库 → 添加文献」查询和保存书目信息，再继续查找全文或添加本地 PDF；后续沿用已确认身份，不重复查询。已有 PDF／JATS 可以直接打开，也可从本地文件或本地恢复记录开始。全文请求仍需选择内容与版本范围后明确启动，获取失败或取消不会撤回已保存的文献记录。旧书目、本地 PDF 和全文命令保持可用。

`0.65.0` 接通[文献详情中的来源补充与续办](docs/paper-continuation-r2.md)：选择已保存完整书目信息的文献，可直接查找全文或添加本地 PDF。后续窗口按精确标识展示此文献的获取和本地添加记录，可继续核对、保存与登记。打开前重新核对记录和归属，旧元数据、人工状态与处理快照保持不变；缺少书目信息的旧记录显示继续路径。

`0.66.0` 接通[已保存原文的转换与初始笔记](docs/saved-source-processing-r2.md)：在文献详情的 PDF 原文卡片选择“转换正文 / 生成初始笔记”，分别选择输出和笔记依据。单独转换正文无需模型，上传前需同意 MinerU 转换并核对实际 PDF 页面；JATS 卡片可打开已有的初始笔记与草稿恢复流程。处理请求绑定所选原文版本，重载后可以继续；来源变化会阻止继续写入，原文保存结果不因后续失败撤回。

`0.67.0` 接通[未核验人工条目](docs/manual-metadata-r2.md)：查询无结果或暂时缺少有效标识时，在“添加文献”中选择“手工登记（未核验）”，填写、预览后保存。标题必填，作者、年份、待核对线索和备注可留空；手工保存不联网、不调用模型。记录可搜索、重载后查看及重新查询书目；手填标识不会自动关联已有文献，查询结果也不会自动升级或合并人工条目。

`0.67.1` 完成[R2 真实转换与初始笔记验收增量](docs/r2-acceptance.md)：修复 Obsidian 桌面辅助进程未创建笔记的问题，补充固定的摘要级证据提示，验证真实 MinerU、deepseek-flash、失败后续办和登记恢复。初始笔记的文件创建需要系统 PATH 中可用的独立 Node.js。新增 `pnpm test:r2` 统一回归。

`0.68.0` 完成[R2 工程收尾](docs/r2-closeout.md)：转换清单中的 PDF 哈希与文件大小匹配已核验原文时，MinerU 正文可以和书目、PDF、Wiki 出现在同一文献详情中；同内容的本地与在线 PDF 继续保留独立版本。转换包仍需单独核验正文和资源，正文或身份冲突会阻止沿用 PDF 关联。此关联只在读取时计算，无需改写转换正文。下一步进入 R3 的快速摘录与待处理流程，科学与教学审阅继续单独验收。

`0.69.0` 接通 [R3.1 无模型保存摘录](docs/excerpts-r31.md)：在原文 Markdown 中划选文字，点击“批注 → 保存摘录”，保留原句、上下文、文本版本和可选个人备注。相同版本与位置复用已有文件，原文变化时提示复查；重新划选可找回摘录，也可打开独立摘录文档编辑备注。当前支持 `papers/`、`Clippings/` 下的 Markdown，PDF 原生选区、摘录列表及后续整理继续开发。新增 `pnpm test:r3` 专项入口。

`0.70.0` 补齐 [R3.2 摘录列表与个人备注编辑](docs/excerpts-r32.md)：在“文献库 → 摘录”搜索原句、来源或备注，查看历史上下文并回到原文的准确选区。备注保存检查整个文件是否被修改；冲突时保留草稿，重新读取可对照最新备注。原文变化停止定位，历史记录继续保留。下一步开发跨阶段待处理中心，R3 尚未整体收尾。

`0.71.0` 接通 [R3.3 待处理中心](docs/pending-center-r33.md)：从首页、文献库“待处理”或同名命令查看书目、全文获取、入库转换、摘录和审阅复查记录。支持搜索、分阶段筛选与刷新，返回前重新核对准确对象；读取不完整时列出提示，不推断缺少全文或转换正文。中心只读取保存记录，续办和审阅仍在原功能完成。下一步接入摘录补充到已有笔记的预览与受控写入。

`0.72.0` 接通 [R3.4 摘录补充到已有笔记](docs/excerpt-curation-r34.md)：从摘录详情选择目标笔记与插入段落，明确勾选原句和可选个人备注，核对逐文件预览后确认补充。全过程不调用模型；来源、摘录或目标变化阻止旧预览写入，支持修订恢复和预览撤销。剪藏与个人备注保留独立标注，不自动升级阅读深度或结束整条摘录的待整理状态。

`0.73.0` 补齐 [R3.5 摘录整理历史与完成标记](docs/excerpt-history-r35.md)：摘录详情可查看已保存的补充目标、修订前后内容与撤销记录，并准确打开当前目标笔记。支持手动“标记整理完成／重新待整理”与状态筛选；完成标记不会隐藏来源变化或无法核对的复查项。历史只读，修改备注或状态后，旧的待应用预览须重新核对。下一步接入学习回答摘录，R3 尚未整体收尾。

`0.74.0` 接通 [R3.6 学习回答摘录](docs/answer-excerpts-r36.md)：从资料阅读或主题学习的已完成回答保存全文或片段，固定回答版本、模型和准确节点，独立编辑个人备注。支持搜索、重复保存复用、重载找回与返回回答；来源变化和并发修改阻止旧操作。AI 摘录保留学习内容身份，并从知识检索中排除。下一步补齐人工修订稿与待处理联动，R3 继续进行。

`0.75.0` 接通 [R3.7 人工修订稿与待处理联动](docs/answer-revisions-r37.md)：学习摘录保留原始 AI 回答，支持独立人工改写、预览确认及个人备注编辑。可手动标记完成、重新待整理和筛选；修订或备注变化后重新待整理，回答变化或无法核对时仍保留复查项。待处理中心可返回准确摘录。人工内容继续保留独立角色，不自动进入知识检索或正式笔记。

`0.52.2` 修复真实 JATS 中的公式文档壳和备用图片误计数：DESeq2 可继续转换，Sopa 的公式与备用资源缺口已消除。旧转换器与来源包保持可回放，未展开的补充材料仍显示缺口。范围与测试见 [R0 公式修复](docs/jats-formulas-r0.md)。

全文获取与多来源入库的后续设计见[架构与开发流程](docs/fulltext-acquisition-design.md)。
总体设计基于 `0.43.2`，各阶段按实现说明验收。
`0.51.2` 修复粘贴 Nature 文章链接后「查找全文」禁用的问题。支持 Nature `/articles/<文章标识>` 页面与 `.pdf` 链接，忽略查询参数和页内锚点，转换为 DOI 后沿用原有身份与全文查询。其他不支持的链接会提示改用 DOI、PMID 或 PMCID；识别链接不代表已找到可用全文。

`0.51.1` 完成全文入库与 JATS 功能检查：修复正文外主图漏读、公式重复、Wiki 标识冲突和长摘要工具预算，优化重复来源核验及保存状态反馈，保留旧转换器与历史来源。验收范围与限制见[完整检查记录](docs/fulltext-acquisition-review.md)。

`0.51.0` 完成 M6 的阅读助手与既有 Wiki 修订步骤：JATS 会话可核对文字依据、准备后续操作卡，并对已有正式笔记生成建议、预览差异、应用或撤销。引用保留固定版本、正文块、XML 与字符范围；来源变化和用户编辑会阻止不一致写入。助手仍只读取文字，整理流程按需读取同版本图像，不自动升级 X-Ray。详见 [M6 助手与修订实现](docs/fulltext-acquisition-m6-curation.md)。

`0.50.0` 已完成 M6 的初始文章 Wiki 步骤：在已保存的 JATS 图文阅读器点击「文章 Wiki」，或在交互阅读中点击「生成文章 Wiki」。模型读取固定原文生成摘要级草稿；核对完整内容与证据片段后保存，再预览入库登记。草稿可恢复，保存只创建新笔记，已有 Wiki 可直接打开或继续登记。详见 [M6 Wiki 实现](docs/fulltext-acquisition-m6-wiki.md)。

`0.49.0` 已完成 M6 的交互阅读步骤：在已保存的 JATS 图文阅读器点击「交互深读」，或在新建阅读中选择「已保存 JATS article.md」。支持主线、支线、图像证据、会话恢复和保留来源快照的学习记录导出。详见 [M6 交互阅读实现](docs/fulltext-acquisition-m6-reading.md)。

`0.48.0` 已完成 M5：在「获取全文 → 获取内容」选择 JATS XML，可获取 PMC 的正文与同版本图片。
核对主文章信息后可无模型、无 MinerU 保存图文原文，支持章节、图表与参考文献跳转。
缺图、公式降级或未展开内容会列出缺口；部分结果需明确接受后保存，也可重新查询。
原文包保留 XML、来源清单、原始媒体与确定性投影；JATS 使用正文块定位，不提供 PDF 页码同步。
使用流程与验收范围见[全文获取 M5](docs/fulltext-acquisition-m5.md)。
`0.47.0` 已完成 M4：已获取的 PDF 可通过「仅保存原文」在标题页确认后保存，无需配置模型或 MinerU。
正式原文包按论文、版本和文件内容区分，并独立登记 `papers/index.md`；保存 PDF 不代表已转换正文或生成 Wiki。
索引登记失败可单独补登记，中断恢复先核对已写文件，保留用户修改。
新获取入口的身份与去重由来源目录确定，模型负责后续正文生成；旧本地 PDF 入库仍保留原有确认流程。
使用流程与验收范围见[全文获取 M4](docs/fulltext-acquisition-m4.md)。
此前 M3 已实现：PMC 无可用 PDF 时可查询 Unpaywall，并按稿件策略尝试开放 PDF 候选。
在「设置 → 全文来源」中填写联系邮箱并启用回退；查询会将 DOI 和邮箱发送给 Unpaywall。
获取结果可无模型预览，也可通过「继续入库」选择模型和输出，复用已校验 PDF 完成身份核对、MinerU 和 Wiki 流程。
获取与入库分别保存状态，入库失败后可用同一 PDF 重新续办。
使用流程和验收范围见[全文获取 M3](docs/fulltext-acquisition-m3.md)；PMC 基础能力见 [M2](docs/fulltext-acquisition-m2.md)，开发演示见 [M1](docs/fulltext-acquisition-m1.md)。

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
- query public Europe PMC/Crossref metadata by paper identifier and, after
  source selection, download a PMC or Unpaywall-discovered PDF into the plugin's
  `fulltext/production/` storage. Optional Unpaywall lookup sends the DOI and an
  explicitly configured contact email to its API; the email stays in local
  settings and is excluded from acquisition records. Acquisition uses direct
  HTTPS without model calls, cookies, API keys, or system/Obsidian proxy settings.
  Each PDF target and redirect must pass public-address checks. Cached PDFs,
  metadata and partial attempts are retained. Continuing into intake requires
  selecting a model and, for MinerU conversion, a new upload confirmation;
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
