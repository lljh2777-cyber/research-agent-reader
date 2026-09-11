# R0 第六批：真实 JATS 公式与备用资源修复

实施日期：2026-09-11。开发版本 `0.52.2`，新转换器为 `rar-jats-3`。承接[科学阅读质量样本](reading-quality-baseline-r0.md)，修复 DESeq2 整篇转换阻塞和 Sopa 公式／备用图片缺口。

## 原因与实现

固定样本中，DESeq2 的 100 处公式和 Sopa 的 18 处公式都包含 `documentclass`、`usepackage`、版面设置及 `begin/end document`，公式本身位于文档壳内。v2 将这些完整文档当作数学表达式处理，因不支持的命令降级；DESeq2 的预转换还触发了 200 项缺口上限。

同一公式的 TeX、MathML 和 GIF 位于 `alternatives` 内。旧资源收集会把备用 GIF 也列为必需图片，而固定版本媒体清单没有这些 GIF。JATS 对 `alternatives` 的定义是同一内容的不同表示，参见 [NISO JATS 官方说明](https://jats.nlm.nih.gov/publishing/tag-library/1.4/element/alternatives.html)。

新增 [tex.ts](../src/jats/tex.ts) 只识别受限的文档壳、已知包声明与版面设置，提取数学正文；它不执行 LaTeX、不加载声明的包，也不运行宏定义。未知前导内容、未知命令、超长／过深表达式、不成对括号、环境错配、内部美元符号或未转义注释仍会降级并保留诊断。补充支持样本实际使用的 `textit`、`ell`、`gtrsim`、`prime`、`mathop`、`bf` 和 `rm`；比较符号转换成等价的 `lt`／`gt` 命令，避免向 Markdown 输出 HTML 分隔符。命令范围依据 [MathJax 3.2 官方文档](https://docs.mathjax.org/en/v3.2/input/tex/macros/index.html)，并在本机实际引擎复测。

只有实际采用可用 TeX 的那个 `alternatives` 组才免除备用图片要求。公式不支持、候选不唯一、组外图片，以及仍按纯文本处理的图注、表格或参考文献区域，继续保留原有资源要求。没有提高 XML、公式、资源或缺口预算，也没有启用 GIF 下载或联网寻找替代图片。

## 同一批来源的复测

来源与题目保持原样；版本、授权、作者和文件清单见[样本文档](reading-quality-baseline-r0.md)。新结果另存为 [v3 观察记录](../tests/fixtures/reading-quality/r0-v1-jats3-observation.json)，保留[原始 v2 失败记录](../tests/fixtures/reading-quality/r0-v1-observation.json)。

| 样本 | v2 观察 | v3 观察 |
|---|---|---|
| DESeq2 | 预转换阻塞，报“JATS 缺口过多” | 可生成 269 个块；100 处公式可用，9 项主图资源完整；仍有 1 个未展开补充 PDF 的引用目标 |
| Sopa | 38 条诊断，其中 18 处公式降级、18 项备用 GIF 缺失 | 144 个块；18 处公式可用，5 项主图资源完整；保留 2 个未展开补充材料的引用目标 |
| 调查论文 | 1 项补充材料未展开 | 150 个块、1 项主图资源；原缺口保留 |

三篇仍为 `partial`，保存时沿用部分结果确认流程。资源完整和可渲染不代表公式已经独立科学审阅，也不代表补充材料已经读取。

## 旧资料和质量样本兼容

未指定转换器的历史快照继续使用 v1；已保存的 v2 和 v3 包分别按自身版本重新投影、校验。转换器版本参与投影摘要，旧阅读定位、旧包内容和来源映射不被后台重写。重新查询 JATS 并保存时使用 v3，新旧包能属于同一论文并分别保存；单独读取旧包不会自动升级它。

质量工具的 `verify`、`inputs` 和 `review` 显式固定到 `rar-jats-2`，因此重新运行仍复现旧基线。新增 `observe` 对同一批文件另测当前转换器，报告 JATS 证据块的 `unchanged`、`changed` 或 `unavailable`，不改写题目锚点或参考要点：

```powershell
node scripts/reading-quality-baseline.cjs observe E:/research-reader/quality-baseline-20260911/sources E:/research-reader/quality-baseline-20260911/jats-v3-observation-new.json
```

输出仍只创建新文件，沿用来源、仓库和 Vault 的写入边界。本次 18 题在历史转换器上的锚点全部通过；其中 22 个 JATS 证据条目在 v3 的块 ID、XML 路径及文本摘要保持一致。DESeq2 的 6 题继续明确选择 PDF，未自动改为 JATS。所有科学答题状态仍为 `not_run`，独立人工复核仍为 `pending`。

## 工程与原生运行验收

- 9 组 JATS 回归通过，覆盖新公式解析、拒绝路径、110 处带备用图片的公式获取、原资源预算、旧版本原样回放、同论文 v2/v3 双包共存、入库、阅读、Wiki 与知识整理。
- 5 组文献库回归、质量基线测试、类型检查、生产构建及 28 项发布审计通过。测试保留隔离文件，不执行批量清理；未运行含旧清理操作的全量入口。
- 测试库 Obsidian `1.13.7` 的 MathJax `3.2.2` 对全部 118 处公式执行渲染，没有异常或数学错误节点；4 个真实公式块经原生 Markdown 渲染器处理后也无错误节点。此项是实际引擎和 DOM 验证，不是 118 处公式的人工科学审阅。截图未可靠捕获预览弹窗，因此不作为视觉验收证据。
- 已备份并更新 `E:/paper-test` 的三个插件产物，重载后版本为 `0.52.2`。897 个受保护文件摘要不变；临时验收弹窗和运行时测试接口已释放。原生检查没有创建正式原文包、论文笔记或调用模型，完整保存／重开路径由内存回归覆盖。

本批修改插件转换代码、开发工具、测试、版本文件和阶段文档。公开全文仅用于定点转换与显示验证，未形成新的论文结论或升级 X-Ray；正式 Vault、科研索引及日志未更新。没有依赖安装、原文改写或数据迁移。

下一步在冻结问题上记录真实模型答题、实际图像输入和用量，再进行独立人工复核。补充材料仍未展开，应继续作为明确缺口，不能把本次转换修复计作 R0 科学质量验收通过。
