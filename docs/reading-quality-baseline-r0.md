# R0 第五批：科学阅读质量样本与离线证据基线

实施日期：2026-09-11。开发运行版本保持 `0.52.1`；本批新增开发工具、公开样本契约和复核材料，没有修改插件运行逻辑或部署测试插件。承接[旧资料兼容与性能记录](library-compatibility-r0.md)。

已固定 3 篇合法全文、每篇 6 题，共 18 题，并核验全部指定原文位置。**尚未运行模型答题，参考要点均为模型辅助整理、待独立人工复核。** 本批完成样本准备和可复现的来源检查，不代表科学回答质量通过，R0 尚未整体验收。

## 样本与原文授权

| 样本 | 原文与作者 | 固定版本 | 题目选择的来源 |
|---|---|---|---|
| `deseq2` | Michael I Love、Wolfgang Huber、Simon Anders（2014），[Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2](https://doi.org/10.1186/s13059-014-0550-8) | `PMC4302049.1`，PDF 21 页 | 6 题使用 PDF |
| `sopa` | Quentin Blampey 等（2024），[Sopa: a technology-invariant pipeline for analyses of image-based spatial omics](https://doi.org/10.1038/s41467-024-48981-z) | `PMC11167053.1`，PDF 12 页 | 6 题使用 JATS，按题读取原图 |
| `survey` | Yuji Masataka、Takeshi Sugiyama、Yoshiyuki Akahoshi、Toshihiko Matsumoto（2022 年在线发表，2023 年卷期），[Risk factors for cannabis use disorders and cannabis psychosis in Japan: Second report of a survey on cannabis‐related health problems among community cannabis users using social networking services](https://doi.org/10.1002/npr2.12307) | `PMC10009416.1`，PDF 10 页 | 6 题使用 JATS，其中 2 题核对 PDF 表格 |

三篇 XML 的授权声明均为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。中文题目与参考要点为根据论文整理的改编材料，原始 PDF、XML 与图像未改写。该授权归属各原作者，不随项目代码的 MIT 许可重新授权。取用第三方素材时仍需遵守原图署名中的例外。

来源按 [PMC 官方云数据说明](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/)取得，固定到版本 `.1` 的元数据、XML、PDF 和元数据列出的主图；未下载或展开补充材料。仓库只保存来源 URL、字节摘要、题目和参考要点，全文与图像保存在仓库和 Obsidian Vault 之外。

## 固定问题与证据范围

完整题目、原文位置、参考要点与禁止越界项见 [r0-v1.json](../tests/fixtures/reading-quality/r0-v1.json)。

| 题目 | 观察重点 |
|---|---|
| D01–D03 | DESeq2 的计数输入、负二项模型、自然对数与 log2、异常值处理的重复数条件 |
| D04–D06 | 图 1 的收缩与例外、21→81 的 Top-100 重叠含义、转录本长度变化的局限 |
| S01–S03 | Sopa 的算法分工、图 2 坐标与每核 RAM 单位、重叠与合并阈值 |
| S04–S06 | 图 3 指标与外推柱、数据取得条件、“最高 100 倍”的适用范围 |
| C01–C03 | 调查抽样与纳入分母、年龄分组和使用年限的构造、自报问卷与临床诊断的区别 |
| C04–C06 | 原文表格与正文的数值差异、置信区间和显著性、观察性设计的推断边界 |

PDF 位置从文件第 1 页开始编号，页文本摘要绑定原 PDF 的 SHA-256。JATS 使用实际转换器产生的块 ID、XML 路径及块文本摘要。题目明确选择主来源；JATS 失败不会自动换成 PDF。此模式为 `fixed-evidence-qa`：已向模型提供选定证据，不能据此评估检索召回、自动选证、连续导读或完整交互流程。

6 题要求图像，共涉及 5 个不同视图：DESeq2 PDF 第 3 页、Sopa 图 2 和图 3、调查论文 PDF 第 5 和第 6 页。整理参考要点时已实际查看这些图表并结合题目对应正文核对。没有逐图检查所有主图，不将任一论文升级为 `x-ray`。

模型输入只包含固定指令、题目、证据片段和需提供的图像描述；参考要点另存。图像描述使用 `required_not_yet_provided`，不冒充图像已发送或已被模型读取。后续运行须另存实际图像提交记录、模型输出、用量和失败，独立复核者依据原文裁定。

## 本次真实来源检查

[原始观察记录](../tests/fixtures/reading-quality/r0-v1-observation.json)绑定运行版本、生产代码提交和相关转换实现摘要，结果如下：

| 样本 | 当前 JATS 路径结果 | 保留的缺口 |
|---|---|---|
| DESeq2 | `blocked` | 与获取服务相同的无资源预转换报“JATS 缺口过多”；未继续资源阶段，缺图数记录为未检查，而非 0 |
| Sopa | `partial` | 38 条诊断：18 条公式不支持、18 项公式 GIF 缺失、2 条未展开的补充块引用 |
| 调查论文 | `partial` | 1 项补充材料未展开 |

全部 27 个固定文件（19,271,911 字节）通过大小和 SHA-256 校验，18 题的指定证据锚点通过核验。此结果只能说明指定范围可重现：它不证明完整 JATS 可用，也不证明参考答案正确。未放宽转换器限制或改写原文来消除失败。

调查论文 C04 特意保留原文内部差异：表 2 的调整后 OR 为 `1.671`，摘要及结果正文为 `1.672`；对应区间和 p 值相同。题目要求明确报告这个差异，不在缺少原始回归输出时替作者选择一个“正确值”。依据见[论文表 2 与结果部分](https://pmc.ncbi.nlm.nih.gov/articles/PMC10009416/)。

样本摘要为解析后 `JSON.stringify(spec)` 的 SHA-256，不是 JSON 文件原始字节摘要：

```text
baselineHash: 5813eb3900aca67f3d5150a586880ec20c0d4587f4626c239c9727ed35c0caf7
instructionsHash: f5b1584ca2aa57435a27aa70d85b63bc312720a3901745a4654a816785b38994
```

后续修复保留这份历史观察。来源字节、题目、证据范围或参考要点变化时另建基线版本，并记录变更原因；不能用新转换结果覆盖旧失败。模型输入自身也保存包含指令、题目、证据和图像请求的摘要。

## 复现与导出

在项目根目录执行。下列目录是仓库外的开发材料目录，输出文件必须使用未占用的名字；不写正式 Vault，不覆盖或清理已有文件。

```powershell
D:\python\python.exe -X utf8 scripts/capture-reading-quality.py E:/research-reader/quality-baseline-20260911/sources
node scripts/reading-quality-baseline.cjs verify E:/research-reader/quality-baseline-20260911/sources
node scripts/reading-quality-baseline.cjs inputs E:/research-reader/quality-baseline-20260911/sources E:/research-reader/quality-baseline-20260911/model-inputs-new.json
node scripts/reading-quality-baseline.cjs review E:/research-reader/quality-baseline-20260911/sources E:/research-reader/quality-baseline-20260911/review-new.md
pnpm test:quality-baseline
```

`capture` 仅在固定文件缺失时访问指定 PMC 云地址，拒绝重定向，先核对字节和摘要再以独占创建方式保存。已有文件只能校验复用。重新生成 `pdf-text.json` 需要 PyMuPDF `1.27.2.3`；工具不安装依赖。v1 捕获使用 Windows CRLF 作为外层 JSON 换行，脚本显式保持该序列化方式，内嵌原文文本不变；其他环境若提取字节不同则停止，不更新冻结摘要。

`verify`、`inputs` 和 `review` 都只读本地来源，不调用模型或网络。导出目标的父目录须已存在，且位于仓库、来源目录和 Obsidian Vault 外；已有输出直接报错。复核包包含完整选定片段和原图／PDF 链接，模型输入不包含参考要点。不得将复核包当作模型输入。

## 验收范围和下一步

工程回归覆盖来源身份和摘要错误、PDF/JATS 定位错误、主来源不可用、图像缺失、输入与答案隔离、原始失败记录保留以及禁止自动标记科学通过。历史记录中的 `scientificAnswerStatus: not_run` 与 `independentReviewStatus: pending` 始终保留。

本次已通过：新增质量基线测试、现有阅读质量回归、JATS 投影回归、TypeScript 类型检查、生产构建、28 项发布审计及 89 个本地文档链接检查。Python 脚本语法检查通过；在另一个空目录执行公开捕获脚本，实际请求 24 个固定文件并重新提取 3 份 PDF 文本，所得来源检查与全部模型输入均和原始记录一致。再次导出到已有文件、仓库、来源目录或测试 Vault 均被拒绝，已有文件摘要不变。未运行含批量清理逻辑的旧全量测试入口，也未把这些工程通过项计作科学答案通过。

下一步优先定位真实 JATS 公式与资源路径失败，按转换器版本保留兼容和原始失败；随后在冻结输入上执行实际模型答题，逐项记录未回答、数字单位、限定条件、图像提交、越界结论、模型与规则版本、实际用量及独立人工判断。人工复核尚未完成时只报告观察，不将模型自评转为科学验收。

本批证据来源为公开论文的定点全文／图表检查、项目代码检查和离线工具运行。科学处理仅限题目所需范围，无完整 X-Ray 结论。没有创建论文笔记、修改原文包、科研索引或 Vault 日志；没有安装依赖、付费模型调用或正式数据迁移。原生界面与测试库部署未执行，因为本批未改变插件运行行为。
