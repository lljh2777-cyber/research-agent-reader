# T1.3A：理解标记、学习记录导出与教学样本

交付日期：2026-09-11。开发版本 `0.56.0`，部署至 `paper-test`。本批完成 T1.3 的工程功能与样本准备；**T1.3B 真实答题和独立教学审阅尚未完成**，主题学习继续标为开发预览。

## 使用方式

在已有主题学习的回答下，通过“我的理解（用户自评）”选择已理解、待回看或仍有疑问，也可恢复为未标记。导图展示对应自评；主线生成进度保持独立。已保存的讲解无需模型配置也能标记或导出。

点击“导出学习记录”，选择选中节点、当前主线／支线或完整学习记录。当前主线／支线不包含其他分支；只导出已返回的回答，明确显示跳过的未完成节点数，未发送问题不包含在内。预览保留固定目标、基础、学习路线、可读的主支线位置、正文、自评及供应商报告用量。

保存位置为 `wiki/qa/topic-learning/<topicId>/<内容摘要>.md`。相同内容可打开已有文件；若原文件已被用户编辑或未完整保存，保留它并提供“另存副本”。正文或理解标记在预览后发生变化时，要求刷新预览。不会向原笔记写入新正文，也不会用模型重写学习回答。

导出属性明确为 `type: topic-learning-record`、`knowledge_source: model-knowledge` 和 `verification_status: unverified`，不含虚构论文来源或 X-Ray 状态。自评是用户理解状态，不是事实核验或教学质量结论。

## 实现与兼容边界

| 文件 | 职责 |
|---|---|
| [`study.ts`](../src/topic-learning/study.ts)、[`study-service.ts`](../src/topic-learning/study-service.ts) | 追加 `understanding` 事件，绑定节点与实际回答请求 ID，记录用户来源和时间；相同状态不重复写入 |
| [`study-workspace.ts`](../src/topic-learning/study-workspace.ts)、[`topic-study.ts`](../src/views/topic-study.ts) | 原生自评控件、导图状态和重载恢复 |
| [`export.ts`](../src/topic-learning/export.ts)、[`topic-export.ts`](../src/views/topic-export.ts) | 确定范围、被动呈现、完整预览、历史校验、独占创建与另存副本 |
| [`export-path.ts`](../src/topic-learning/export-path.ts) | 独立导出域与路径识别 |
| [`lexical-retrieval.ts`](../src/query/lexical-retrieval.ts)、[`curation/learning.ts`](../src/curation/learning.ts) | 排除主题导出及缓存属性标记的主题记录，避免进入旧检索和资料学习索引 |

新版本可重放 T1.2 原有事件，无需迁移、改写或重新生成回答；旧记录默认为未标记。新增自评也计入同一学习记录的 512 次事件上限，标记不改变原始请求或响应。生成与标记互斥，旧编辑凭据不能覆盖外部更新。旧版程序不认识新增事件，降级前应保留升级后的完整记录；没有自动降级转换。

导出前后使用固定根、独占创建和字节核对，单文件上限 16 MiB。写入失败会保留已产生的文件；不删除、覆盖或自动修复。关闭预览在创建前可取消，已经开始的文件写入可能完成并保留。不同历史版本各自导出，导出不是完整会话备份或可反向导入的项目包；完整恢复仍依靠原学习日志。

正式知识检索原本不包含 `wiki/qa/`；本批补上旧全文词法搜索和资料学习索引的主题域排除。主题导出不登记为论文，不写文献索引，也不自动作为已有正式笔记的整理材料。单独搜索主题学习记录留给后续显式主题域功能。

## 教学样本已固定，回答未运行

[`t1-v1.json`](../tests/fixtures/topic-quality/t1-v1.json) 包含两个目标、九个按顺序执行的问题：零基础机器学习中的输入、目标、泛化、预处理泄漏、空库引用和最新排名；会 Python 但不懂微积分时的损失、梯度与参数更新。每题分别保存期望检查点和失败反例。

数据泄漏要点使用 [scikit-learn 官方文档](https://scikit-learn.org/stable/common_pitfalls.html)核对；梯度计算和参数更新的职责使用 [PyTorch 官方教程](https://docs.pytorch.org/tutorials/beginner/basics/optimization_tutorial.html)核对。其余教学适配和来源诚实标准来自产品契约与一般知识，整体参考状态仍为暂定。这些外部资料用于准备复核要点，没有作为被测会话已读取的证据。

[`冻结观察`](../tests/fixtures/topic-quality/t1-v1-observation.json) 记录基线、提示规则与输入摘要，状态明确为 `modelAnswerStatus: not_run`、`independentReviewStatus: pending`。题目、参考要点或教学规则变化会使冻结检查失败，需要建立新的明确基线；不能事后修改原要点来消除模型错误。

[`准备工具`](../scripts/topic-quality-baseline.cjs) 只创建新的库外目录和四份文件：完整规范、去掉参考答案的输入步骤、冻结观察及待填写审阅表。它不调用模型、不读取密钥、不自动评分，也不生成虚假的请求回执。运行方式：

```powershell
node scripts/topic-quality-baseline.cjs prepare <新的库外绝对目录>
```

本次准备结果保留在 `E:/research-reader/topic-t13-20260911/teaching-baseline/`。下一步实现并执行显式真实运行，逐步使用实际祖先回答，保存实际请求、首次响应和原始用量；随后由独立审阅者分别检查事实、适用条件、教学适配、来源诚实和主支线连续性。当前模拟回答不进入该质量样本。

## 工程验证

新增 `pnpm test:topic-records` 覆盖手动标记、旧回答保留、导出范围、预览过期、重复保存、编辑保留、显式副本、取消、写入失败和检索隔离，以及九题基线与答案隔离。扩展 `pnpm test:topic-study` 的真实文件测试，在新进程恢复理解标记并识别已经导出的相同文件；原事件和未完成写入保留。

通过的定向回归包括 `pnpm test:topic-learning`、`pnpm test:topic-workspace`、`pnpm test:library-browser`、`pnpm test:dashboard`，以及 `test_learning_library.js`、`test_knowledge_retrieval.js`、`test_dashboard_query_view.js`、`test_retrieval_benchmark.js`、`test_reading_export.js`、`test_reading_export_review.js`、`test_reading_layout.js`、`test_reading_domains.js`。完成类型检查、生产构建与 28 项发布结构检查。未运行含批量删除的旧全量入口。

额外运行的旧工作台测试最初因“尚未体检”和“运行中 · 点击停止”的过时文案断言失败；核对当前实现后修正这两处断言，复测通过，没有为迎合旧断言修改工作台行为。

原生 Obsidian 验收使用库外真实文件和模拟模型，每次完整场景仅 3 次显式模拟讲解，真实供应商请求为零。通过手动标记、无需模型的标记、过期预览拦截、重复导出、保留手工修改、另存副本、430 px 面板和弹窗、实际插件重载及草稿恢复。导出文件的实际字节与预览一致；自动打开回调用库外文件检查替代，没有在测试库写入模拟学习笔记。截图验收修复了被宿主样式意外显示的副本按钮。

开始验收时 Obsidian 未运行，首次 CLI 准备／重载失败；启动测试库后继续并完成验收。结束时恢复原 13 个标签页 ID 与类型，关闭调试和焦点模拟；897 个受保护文件哈希不变，没有新增研究内容文件。脚本、截图和文件保护清单保留在 `E:/research-reader/topic-t13-20260911/`。

本次更新插件代码、测试、开发文档和冻结样本；正式 Vault、论文笔记、知识索引与 Vault 日志均未修改，因此不更新这些索引和日志。代码经过实际构建与工程执行，未形成新论文结论，科学处理深度不适用。独立教学审阅与 R0 独立科学审阅继续待完成；公网发布仍是既有 beta。
