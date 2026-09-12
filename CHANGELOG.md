# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Human answer revisions and pending work — 0.75.0

- 学习摘录新增独立人工修订稿，明确起草、预览再确认保存；原始 AI 回答与个人备注保留，两个未保存草稿独立保护。
- 新增手动整理完成、重新待整理和筛选，修改内容后重新待整理；无变化操作保持原状态。按需升级单份记录为 v2，旧 v1 浏览不迁移。
- 待处理中心接入学习摘录，准确返回前重新核对文件和回答状态；已完成但回答变化或无法核对的摘录保留复查项。
- 10 组新专项、相关回归和原生编辑、冲突、重载、状态、导航、取消及窄窗口验收通过。测试库 984 个原有受保护文件、原 14 个标签页恢复，无新增数据。范围见 [R3.7 记录](docs/answer-revisions-r37.md)。

### Saved AI learning answer excerpts — 0.74.0

- 资料阅读与主题学习的已完成回答可保存全文或精确片段，固定回答、模型、会话／路线与请求凭据；个人备注独立编辑，重复保存复用已有记录。
- 新增学习摘录列表、搜索、重载找回与准确返回节点。写入和返回重新核对回答版本；整份文件冲突保护、保留草稿重读、取消和已提交结果复查保持历史。
- AI 内容以独立类型保存到 `wiki/qa/answer-excerpts/`，排除通用词法、学习与正式知识检索，暂不进入原文摘录的补充和完成流程。
- 新增 12 组专项及相关回归通过；原生资料阅读保存、备注冲突、重复、重载、划选、返回和窄窗口通过，主题界面使用模拟历史验证。测试库原有 983 个受保护文件和 14 个标签页恢复，保留 1 个新学习摘录。范围见 [R3.6 记录](docs/answer-excerpts-r36.md)。

### Excerpt history and manual completion — 0.73.0

- 摘录详情按精确记录展示整理批次、补充目标、修改前后内容与撤销状态；复用写入侧验证规则，读取历史不初始化恢复服务或调用模型。
- 新增手动整理完成、重新待整理及状态筛选；整份文件比较保护原句、个人备注、AI 内容和额外字段，旧归档任务继续在原功能处理。
- 待处理中心只在完成且来源明确一致时移出摘录；来源变化、缺失或无法核对仍列为复查，独立修订恢复事项保留。
- 9 组新专项及相关回归通过；原生完成状态重载、历史展开、准确返回、异常与窄视口验收，修正多余分页按钮。测试库 983 个受保护文件及原 14 个标签页恢复，隔离范围见 [R3.5 记录](docs/excerpt-history-r35.md)。

### Manual excerpt curation with guarded revisions — 0.72.0

- 摘录详情可选择已有笔记和插入段落，明确勾选原句与可选个人备注，逐文件预览后确认补充；无需阅读会话或模型。
- 固定文字和独立角色标注保留来源、文本版本与位置；普通 Markdown 核对全文，MinerU/JATS 沿用原文包验证，论文来源笔记保持身份限制。
- 复用现有整理、修订、恢复与撤销，每步检查摘录和目标版本；重复预览与已有来源记录阻止重复补充，已应用批次返回修订历史。
- 15 组新专项、相关回归、原生写入／重载／撤销和窄视口验证通过；983 个受保护文件及原十四个标签页恢复。具体隔离边界和未验收范围见 [R3.4 记录](docs/excerpt-curation-r34.md)。

### Read-only cross-stage pending center — 0.71.0

- 首页、文献库和命令面板接通待处理中心，按五个阶段搜索与筛选已保存记录；独立读取失败、达到上限和未核验来源明确提示。
- 返回前重新检查记录凭据和准确目标，过期或缺失时停止，不选择同名替代；本地添加、全文获取与知识整理支持返回指定记录。
- 复用既有只读适配器，不初始化恢复服务；不完整扫描不推断全文和转换缺口，已获取结果按保存包与文献身份核对。
- 定向回归、原生三个入口、失败取消、准确返回、重载和窄视口验收通过；983 个受保护文件不变，原十四个标签页恢复。范围与模拟边界见 [R3.3 记录](docs/pending-center-r33.md)。

### Excerpt browsing and guarded personal notes — 0.70.0

- 文献库、命令面板及已有摘录小窗接通可搜索的摘录列表，显示原句、历史上下文、版本与个人备注。
- 保存备注在文件写入回调内核对完整版本，外部修改时保留草稿；失败可重试，保留来源、AI 字段和额外正文。
- 回到原文重新核对准确位置、文本版本和编辑器内容，来源变化停止定位；修复自动阅读器接管 Markdown 后选区失效。
- 原生桌面／窄视口、三个入口、冲突与失败恢复通过；范围、文件保护与后续开发见 [R3.2 记录](docs/excerpts-r32.md)。

### R1 native source closeout — 0.61.1

- 修复阅读器复用标签时仍显示上一篇文献标题：加载、成功与失败状态同步刷新标签，关闭及过期加载继续隔离。
- 真实 PDF/JATS 保存包的原文显示、正确来源阅读设置、缺失保护和重载恢复通过；新增标题回归，R1 共 13 组测试通过。
- [R1 完成工程收尾](docs/r1-closeout.md)，下一步进入 R2。测试库保留两份真实 QA 原文包，独立科学／教学审阅状态不变。

### R1 acceptance checkpoint — 0.61.0

- 新增 `pnpm test:r1`，统一运行 12 组无批量清理的定向回归；产品版本与行为不变。
- 混合来源隔离路由、版本变更拒绝、真实笔记与指定 PDF 历史会话、空库／失败／取消及窄面板检查通过。记录历史打开的时间字段写入，保留首次文件保护断言失败结果。
- [R1 验收记录](docs/r1-acceptance.md)明确真实 PDF/JATS 新来源包原生端到端覆盖仍待补齐，不把模拟样本计作全文渲染通过。

### Paper-linked code notes — 0.61.0

- 文献详情展示直接相连的代码项目／脚本笔记与代码学习导出，标明完整路径和链接方向。只读 Obsidian 缓存，明确缓存延迟和关联范围，不推断官方实现。
- 打开前重新核对关联和文件存在性，支持取消；身份冲突、缺失或变动时不选择同名替代。定向回归和原生文件跳转验收通过。
- 测试库更新至 `0.61.0`，正式内容保持不变；范围见 [R1 代码关联记录](docs/library-code-links-r1.md)。下一步为混合来源库整体验收。

### Dashboard pending work and recent curation — 0.60.0

- 首页只读汇总未完成任务、待审阅、需复查／恢复及最近三条修订；明确保存状态、统计不完整与读取上限，不在首页恢复遗留任务或调用模型。
- 最近修订按 ID 打开，失联时不替代；整理批次入口保留中断生成记录的可达性，支持刷新和任务筛选。
- 定向回归、类型检查、构建及原生导航与窄面板验收通过。测试库部署至 `0.60.0`，897 个受保护文件和 13 个原有标签页保持不变。详见 [R1 摘要记录](docs/dashboard-summary-r1.md)。关联代码及 R1 整体验收仍待完成。

### Dashboard primary and secondary navigation — 0.59.0

- 工作台以文献库、阅读空间、知识整理为三个主入口；入库、深读和检索等保持可见，代码分析、练习、体检和导出进入扩展区。有工具任务运行时自动展开，保留指定任务的停止入口。
- 统一当前入口的“文献深读／论文笔记”文案，保留旧 action ID、命令、请求字段与历史。原有最近阅读和任务结果继续展示。
- 工程回归及原生入口、派发、运行状态、430 px 布局验收通过；测试库更新至 `0.59.0`，897 个受保护文件和 13 个原有标签页不变，无模型调用。范围见 [R1 首页记录](docs/dashboard-home-r1.md)。待处理摘要、最近整理和关联代码仍待补齐，不宣告 R1 整体完成。

### Primary paper note selection — 0.58.0

- 文献详情新增主要笔记选择、更换、明确清除与打开入口；只列出同一文献的候选，以完整路径区分同名笔记，不自动选择唯一候选。
- 编辑读取原人工决定，失联的旧主要笔记保留原路径并提示重新选择或清除；正文变化、身份缺口和并发记录继续阻止不一致保存。只写主要笔记选择，保留阅读状态、原笔记和旧修订。
- 两类人工编辑共用异步保存守卫，页面同时只编辑一项。定向回归与原生隔离样本验收通过，覆盖取消、失败重试、重载、窄面板以及旧阅读状态兼容；测试库部署至 `0.58.0`，897 个受保护文件和原有 13 个标签页不变，无模型调用。
- 完整范围见 [R1 主要笔记](docs/library-primary-note-r1.md)。下一步整理首页、文案与次级入口，再进行 R1 整体验收；主题学习质量门槛未变。

### Human paper reading state — 0.57.0

- 文献详情增加人工阅读状态编辑，支持未标记、未开始、正在阅读、用户标记已读和待回看；只有明确保存才追加记录，列表展示同一状态。阅读完成不代表讲解完成、节点理解、笔记审阅或 X-Ray 通过。
- 编辑绑定准备时的文献和记录凭据，保留主要笔记选择；外部更新、身份不明和并发冲突阻止覆盖。取消与关闭隔离迟到响应，保存失败保留草稿，提交成功与后续目录刷新失败分别提示。
- 定向回归、类型检查、生产构建和发布结构检查通过；原生验收使用库外隔离样本，覆盖五态切换、失败重试、重载恢复和 430 px 面板。测试库部署到 `0.57.0`，897 个受保护文件不变，无模型调用。
- 范围与限制见 [R1 人工阅读状态](docs/library-reading-state-r1.md)。主要笔记选择与 R1 整体收尾继续排在后续；主题预览和独立审阅门槛保持原样。

### DeepSeek transfer completion — evaluation record

- 只读网关日志将两次迁移题失败定位到上游 HTTP 402 `Insufficient Balance`，补充[余额诊断](docs/topic-model-deepseek-flash.md#2026-09-11-补测与余额诊断)，保留原始未知原因记录。
- 用户确认充值后，以相同冻结题单和配置完成第三次迁移运行的八题；累计十九次尝试、十七份有效回答和两次保留失败，无运行内自动重试。
- [八题对照](docs/topic-model-deepseek-transfer.md)显示随机分配与迭代状态解释改善，也暴露自定义迭代器协议混淆和其他条件遗漏。DeepSeek 成为学习预览优先候选，独立审阅仍待完成。
- 文档和观察检查、旧材料保护检查通过；插件代码、教学规则、默认模型、部署与上游预算配置不变。

### deepseek-flash teaching trial — evaluation record

- 用现有 deepseek-flash 配置完成相同 v2 规则下的九题首次回答，与 qwen 原答只读比较；核心概念解释整体改善，仍有能力承诺和重复反向条件遗漏，详见[试用报告](docs/topic-model-deepseek-flash.md)。
- 迁移题 S01 调用传输后未收到响应，保留失败并停止，其余七题未开始；不补写回答或将计划十七题记成全部成功。
- 仅新增观察和文档；教学规则、默认模型、插件 `0.56.1`、测试库和既有运行材料保持不变，独立教学审阅仍待完成。

### Topic transfer questions and factual review — development tooling

- 新增统计推理与 Python 迭代器两组八题，使用已冻结且未修改的 v2 规则完成首次真实答题。参考要点与模型输入分开保存，旧 v1 / v2 九题和历史观察保持原样。
- 准备工具支持显式选择题组；运行器按冻结题数限制调用、按清单展示状态，兼容旧九题历史。登记文件绑定摘要，报告拒绝新运行清单题号缺失或与计划不符。
- 核对旧答的预测／目标、梯度方向、清梯度、模型选择和资料承诺问题。新题仍有事实与条件错误，独立审阅待完成，详见 [T1.3D](docs/topic-quality-t13d.md)。插件保持 `0.56.1`。
- 下一步继续 R1 人工阅读状态与主要笔记选择；主题学习保持预览，不以其他功能交付解除质量门槛。

### Versioned topic teaching and comparison — 0.56.1

- 新请求使用教学规则 v2，强调当前问题、概念条件和步骤职责；请求历史与新导出记录规则版本。保留 v1 规则、旧日志摘要和原导出字节，支持混合版本继续学习及显式重试，未知版本拒绝读取。
- 冻结 v2 同题基线，目标、路线、九题及判断要点与 v1 一致。新增逐题并列审阅工具，验证实际首次回答与上下文，拒绝改变标准或模型配置的比较；完整记录保留在库外。
- 同一配置模型完成第二次九题首次答题，无重试。回答变短但仍有事实错误及过度承诺，不报告教学提升或通过率。独立审阅仍待完成，详情见 [T1.3C 记录](docs/topic-teaching-t13c.md)。
- 相关主题、旧阅读回归、类型检查、生产构建和发布结构检查通过；测试库部署到 `0.56.1`，原生兼容、旧导出和手工编辑保留验证通过。公开 beta 版本未变。

### Topic teaching benchmark — development tooling

- 新增 T1.3B 真实教学运行器，使用冻结路线、实际主题服务及现有 Direct API 适配器，逐题保存首次请求、响应、学习日志和接口报告用量；请求先写盘再发送，失败停止、无自动重试，不写测试库会话或笔记。
- 新增只读重放与审阅包工具，核对实际祖先内容、主支线关系、首次响应和字节摘要；评判要点不进入模型输入，开发者自查与独立教学审阅分开。插件保持 `0.56.0`，未修改教学规则，详见 [T1.3B 记录](docs/topic-quality-t13b.md)。
- `pnpm test:topic-quality` 覆盖实际服务与模拟传输、分支隔离、结构化输出、取消与迟到响应、额外调用和写盘失败、跨进程恢复及报告篡改检查；保留测试文件，不使用批量清理。

### Topic understanding marks and export — 0.56.0

- 主题讲解新增用户理解标记，与模型生成进度分开；绑定具体回答并追加保存，支持撤回为未标记。模型和自检不能自动赋予理解状态。
- 新增节点、当前主线／支线、完整记录导出，保存到 `wiki/qa/topic-learning/`。预览与固定历史绑定，相同内容复用已有文件，手工编辑或未完整保存的文件保留并提供显式另存副本。
- 主题导出保留一般知识来源、用户自评、主支线关系和报告用量；排除于旧词法搜索、正式知识检索与资料学习索引。被动渲染不嵌入模型图片或执行代码。
- 固定两个学习目标、九个教学问题及参考要点，准备材料与被测输入分开；真实答题和独立审阅仍待完成。本批继续保持开发预览，见 [T1.3 首批记录](docs/topic-records-t13.md)。

### Topic dialogue and learning map preview — 0.55.0

- 已确认路线新增“打开学习预览”：显式选择模型后逐单元生成讲解，支持主线、支线续问、嵌套支线及返回原主线位置；对话和导图使用同一节点 ID，支持折叠、缩放和定位当前节点。
- 独立追加事件保存固定路线、每次请求、返回与接口报告用量；失败／取消可显式重试同一节点，重载不自动重发。更改路线生成独立学习记录，已有正文保持原样。
- 只发送当前节点的祖先对话，不混入其他支线；一般知识标记保留，未读取资料不能充当库内引用。共享导图布局与被动 Markdown 渲染，不修改资料阅读的证据规则。
- 内存、真实文件跨进程恢复、相关阅读回归与原生界面验收通过；没有真实模型请求。工程范围、容量限制和后续 T1.3 教学审阅见 [T1.2 交付记录](docs/topic-study-t12.md)。

### Topic route preview — 0.54.0

- 工作台新增“主题路线（预览）”与独立命令：无资料保存主题、目标和基础，手动编辑 2–12 个单元及先修关系，保存与确认路线。
- 显式选择已验证模型后可生成路线，展示本次接口报告用量、失败和取消；页面打开与恢复不会自动生成。主题讲解、对话和导图尚未开放。
- 历史版本可查看并明确复制；外部更新不能被旧草稿覆盖，取消后的迟到结果不提交。当前标签页保留编辑草稿，输入时保持原生输入节点。
- 定向工程检查与独立存储的原生验收通过；真实供应商调用为零，测试库 897 个受保护文件不变。范围见 [T1.1 交付记录](docs/topic-planning-t11.md)。

### Paper library navigation — 0.53.0

- 工作台新增文献库与独立命令，支持搜索、筛选、分页展示、详情、原文版本、指定会话、笔记及批注；不把待关联条目当成已确认论文。
- 打开来源前重新核对指纹与版本，旧 MinerU 支持单包核验；缺失会话不回落到其他最近会话。来源校验、生成进度与人工理解状态分别展示。
- 单次扫描可取消，失败保留上次结果，迟到结果及关闭后的回调不会更新界面；430 px 面板上下排列。学习入口显式区分资料／主题，主题 UI 尚未开放。
- 在测试库完成原生点击与重载恢复，零模型调用，897 个受保护文件不变；[实现与验证记录](docs/library-navigation-r1.md)说明真实和模拟场景。R1 人工状态与主要笔记编辑仍待完成。

### Topic learning T0 — session and route foundations

- 将主题学习纳入开发路线，区分资料阅读和主题学习的来源要求、入口、状态与保存资格；R0 科学审阅保持待完成，既有阅读证据规则未放宽。
- 新增无文件依赖的主题会话、显式路线生成、手动调整和确认服务；独立追加修订保存，覆盖取消、迟到结果、恢复、存储失败和并发诊断。模型路线明确来源于一般知识，不登记为文献。
- 新增 `pnpm test:topic-learning`，使用内存模拟与保留的隔离文件样本。尚未接入主题 UI、正文讲解、导图和导出，未调用真实模型或部署插件；版本保持 `0.52.2`。后续步骤见[主题学习开发流程](docs/topic-learning-development.md)。

### R0 engineering closeout — 0.52.2 baseline

- 汇总 R0 工程验收矩阵、已知问题与 R1 只读导航边界，修正路线中“尚未运行真实问答”等过时状态；18 题独立人工科学审阅仍保持待完成，不将工程收尾计作科学通过。
- 新增 `pnpm test:r0`，串联 16 个定向测试入口。原生两次查询一致、取消有效、供应商请求为零，900 个受保护文件及布局不变；[收尾记录](docs/r0-closeout.md)保留 5 个旧包未核验、性能范围及用量口径限制。
- 未修改插件运行逻辑或重新部署，版本保持 `0.52.2`；历史来源、参考要点和首次模型响应保持原样。

### R0 live fixed-evidence QA — development tools

- 新增固定输入准备、PDF 页图像渲染、显式模型答题和复核报告工具。每题保留实际请求、首次响应与图像摘要，失败即停，无自动重试；输出只创建在仓库、原文、计划及 Vault 之外。
- 非流式调用复用已验证的 OpenAI-compatible 配置；18 题均保存首次回答，6 道图像题保留实际提交记录，900 个测试库受保护文件不变。报告保留用量原始字段及不可相加的异常，区分图像传输、引用格式与独立科学审阅。
- 保留阈值前后矛盾、额外条件和超范围推断等复核线索，不报告科学通过率或推算费用。
- 本批保持插件 `0.52.2`，未改阅读规则和正式数据；运行结果与复现方式见 [R0 真实模型答题](docs/reading-quality-runner-r0.md)。

### JATS publisher formulas and alternative assets — 0.52.2

- 新增 `rar-jats-3`，受限识别公式外的出版文档壳并保留数学正文；仅在实际采用 TeX 时免除同组备用图片要求，未知公式继续报告缺口。
- DESeq2 从转换阻塞恢复为部分可用，Sopa 的 18 处公式和 18 项备用图片缺口消除；未展开补充材料仍需明确接受。旧转换器、已保存包和阅读定位保留。
- 原质量基线固定 v2，新增独立观察新版结果的工具；实际 MathJax 检查 118 处公式，测试库 897 个受保护文件不变。验收范围见 [R0 JATS 公式修复](docs/jats-formulas-r0.md)，模型答题与独立科学审阅仍待完成。

### R0 scientific reading samples — development tools

- 固定 3 篇 CC BY 全文、18 个问题、来源字节摘要及 PDF/JATS 原文锚点，提供只创建新文件的来源捕获、离线核验、模型输入与人工复核包导出工具。
- 模型输入和暂定参考要点分开；图像请求不冒充实际视觉读取。保存真实转换失败、未运行模型和待独立人工复核状态，不以定位校验代替科学质量判断。
- 本批不改变插件运行行为，版本保持 `0.52.1`；范围和复现方式见 [R0 科学阅读质量样本](docs/reading-quality-baseline-r0.md)。

### Legacy library compatibility and read baseline — 0.52.1

- 显式单包 MinerU 核验复用现有完整加载器，清单产物及图像读取计入同一次预算并支持取消；普通查询保留未核验状态，损坏原文不降级。
- 新增外部 `annotation_schema: 2` 的只读兼容，保留内容角色和原样来源信息；未知仓库与版本算法不按本地同名路径强行关联。
- 新增真实完整加载器的 5 个兼容场景和混合格式性能脚本；测试库 5 个旧包核验通过，3 条外部批注可读，879 个受保护文件不变。科学质量样本与文献详情尚待开发，范围见 [R0 兼容与性能记录](docs/library-compatibility-r0.md)。

### Persistent paper decisions — 0.52.0

- 新增人工阅读状态和主要笔记选择的准备／保存接口；复用已有 `paperId`，编辑凭据包含归组、修订头和笔记哈希，旧凭据或错误笔记不能直接保存。
- 插件目录使用追加修订和内容绑定的提交标记，支持重新加载、未提交尝试后的重试，以及保留双方历史的并发选择；损坏的已提交记录明确阻止写入。
- 来源入库纳入已保存身份及传递关联，原文包缺失后仍能沿用 ID，并阻止精确标识、ID 和 citekey 冲突。
- 40 个内存场景、隔离磁盘及独立进程恢复测试通过；原生查询和拒绝路径保持 879 个受保护文件不变。文献详情及编辑控件留待 R1，完整验收与限制见 [R0 人工记录](docs/library-records-r0.md)。

### Paper library read adapters — 0.51.3

- 新增显式只读查询，适配来源包、磁盘阅读会话、Wiki 与本插件批注；不初始化阅读恢复、分配文献身份、访问模型或网络。
- 来源与会话只按核验过的类型及固定指纹绑定；坏包不可降级成普通 Markdown，重复批注 ID、用途错误、旧包核验和不支持格式均报告问题。
- 27 个内存场景及相关回归通过。测试库两次实际扫描结果一致，879 个受保护文件哈希和布局不变；详见 [R0 实现与基线](docs/library-r0.md)。持久记录、科学质量基线与文献详情仍待后续开发。

### Paper library foundation — R0 first step

- 新增纯文献聚合契约：按已有精确标识或 paperId 关联，保持各来源版本与对象独立，冲突和无标识旧资料不自动合并或分配新身份。
- 分开来源能力、获取状态、主线生成、人工阅读与笔记审阅；复用现有节点理解标记，审阅绑定正文哈希。
- 第一批的 15 个内存场景覆盖确定性、只读边界、传递冲突及 2,000 条记录共享诊断。当时仅交付纯投影，运行版本保持 `0.51.2`；第二批进展见上。

### Nature fulltext input fix — 0.51.2

- 修复 Nature 文章页面与 PDF 链接无法启用「查找全文」的问题；按固定域名和文章路径提取 DOI，继续交由现有身份服务校验。
- 输入框展示具体校验原因和不支持链接的替代输入方式。回归覆盖用户报告的地址、查询参数、旧式文章标识、无效路径及仿冒域名；原生界面检查覆盖按钮启用、点击提交与错误恢复。

### Fulltext and JATS verification fixes — 0.51.1

- JATS 新转换器保留根级浮动图表，避免段内独立公式重复输出；旧快照与原文包继续按原转换器校验。
- Wiki 检查与独立登记均拒绝冲突 DOI / PMID / PMCID；无 DOI 的旧笔记可使用其他精确标识。
- 概览按实际 JSON 大小限制片段，避免长摘要无法开始；重复来源核验保留完整文件检查并减少重复转换，图文关系使用块索引。
- 修正 JATS 候选版本与重试提示、保存完成后的按钮状态。125 项原生检查和 9 次公开元数据请求的结果见[检查记录](docs/fulltext-acquisition-review.md)。

### Fulltext acquisition M6 assistant and revisions — 0.51.0

- JATS 会话开放阅读助手与「整理进知识库」，沿用现有工具、操作卡、建议选择、差异预览、修订记录及撤销流程。
- 助手历史和整理证据保留固定来源、版本、正文块、字符范围及 XML 位置；图像引用绑定实际资源。原文变化后仍可查看助手历史文字，新的操作和原文跳转会停止。
- 对来源笔记检查论文标识与 JATS 版本凭据，拒绝同标题但 DOI 不同、版本不一致的目标。整理实际读取本轮图像，保留转换缺口，不修改 frontmatter 或阅读深度。
- JATS 修订每次写入前重新核对来源和目标内容，部分失败可恢复，用户后续编辑不会被覆盖。原生界面与专项模拟验收见 [M6 助手与修订](docs/fulltext-acquisition-m6-curation.md)。

### Fulltext acquisition M6 initial Wiki — 0.50.0

- 已保存的 JATS 原文可生成初始文章 Wiki：受限正文工具返回实际读取片段，草稿保留中文译名、摘要级正文、原文块引用和固定来源凭据。
- 生成、完整预览、保存、登记分别执行；私有草稿记录接入任务历史，关闭或重载后可继续核对与保存。来源变化、伪造引用、重复笔记或用户编辑会阻止不一致写入。
- 沿用只创建新文件的 Wiki 写入与入库登记。保存意图和回执支持中断续办，独立库更新本库索引与日志，完整工作区可登记 CSV / BibTeX。恢复和登记不再次调用模型。
- JATS 阅读助手与既有笔记修订仍待适配，不自动升级 X-Ray。详见 [实现与验收](docs/fulltext-acquisition-m6-wiki.md)。

### Fulltext acquisition M6 interactive reading — 0.49.0

- 新增明确的 JATS 结构化阅读来源，复用论文阅读空间。会话固定来源包清单、版本、投影和文件摘要，旧 PDF / MinerU / 代码会话保持兼容。
- JATS 主线与支线引用绑定正文块、UTF-16 字符范围及图像资源；图像实际解码并提交给模型后才记录视觉读取。图注和正文交叉引用可关联同版本图片，不伪造 PDF 页码。
- 图文阅读器提供「交互深读」入口，证据窗口可跳转到原文块。学习导出保留清单和当时引用片段；来源变化会阻止新讲解与核对，历史仍可查看和导出。
- M6 分步交付：本版支持交互阅读与学习记录导出；正式文章 Wiki、阅读助手与知识整理的 JATS 凭据适配仍待下一步。详见 [实现与验收](docs/fulltext-acquisition-m6-reading.md)。

### Fulltext acquisition M5 — 0.48.0

- 新增 PMC JATS 获取内容选项，XML 与引用图片绑定同一版本和来源清单摘要，逐文件核对 MD5 / SHA-256；沿用原有任务、取消、恢复和缓存机制。
- 新增受限 XML 解析与确定性正文投影：主文章身份、章节、段落、列表、图形摘要、图注、表格、受支持的 TeX 与参考文献均有源节点映射。复杂表格保留行列跨度，未支持内容明确记录缺口。
- 新增无需模型或 MinerU 的 JATS 身份确认与原文保存；部分结果单独接受，正式包清单最后提交，保存与索引补登记分开恢复。
- SourceCatalog 统一发现 PDF / JATS / 旧转换与 Wiki；相同来源版本但清单变化时保留新包。阅读器严格分派包类型，图片只读取已校验字节，不伪造 PDF 页码和版面坐标。
- 新增四组 JATS 专项与真实 Obsidian 界面 28 项检查；图形摘要、复杂表格、缺口确认、索引失败重试及图片解码均已验证。范围和限制见 [M5 实现与验收](docs/fulltext-acquisition-m5.md)。

### Fulltext acquisition M4 — 0.47.0

- 新增无需模型或 MinerU 的「仅保存原文」动作，展示真实 PDF 页面并取得 v2 身份确认，保存独立 PDF 包与原文索引。
- 新增共享身份、SourceCatalog 与来源保存服务。论文标识、书目 citekey 和包目录分别处理；同 DOI 的不同稿件类型、来源版本或 PDF 内容分别保留，PDF、转换正文和 Wiki 分层查重。
- 正式 PDF 包采用固定文件清单、逐文件校验和清单末尾提交；缺失、损坏或未知 `_source` 包不能降级为普通 Markdown / MinerU。PDF 阅读入口核验包内容与清单。
- 保存计划绑定设备和快照；中断后只复用本事务的完整文件，拒绝接管未知目录或覆盖用户修改。原文提交与索引登记分别记录，索引失败可单独补登记。
- 新获取入库使用确定性身份和 v2 页面确认，模型仅生成正文。转换复用核对源 PDF 与解析参数；旧 v1 仍执行原有凭据校验，并读取新 PDF 包的书目关联。
- 新增来源保存、实际文件系统、来源入库三组专项与原生界面 21 项检查；详见 [M4 实现与验收](docs/fulltext-acquisition-m4.md)。

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
