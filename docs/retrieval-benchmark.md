# 检索模型的离线与在线对比

这套开发工具评估 `BAAI/bge-m3` 和 `BAAI/bge-reranker-v2-m3` 是否有助于当前知识库检索。它不改变插件默认检索、学习笔记、阅读会话或入库规则。脚本依赖仓库现有的 Node 与 esbuild，未增加依赖。

## 实验范围

比较三组文件级检索结果：

| 组别 | 候选产生 | 最后排序 |
|---|---|---|
| 当前词法 | 实际 `LexicalVaultRetriever`，原有分词、评分及前 10 篇上限 | 原有文件分数 |
| 词法＋重排 | 原有前 10 篇中的片段，按词法分数保留前 64 个 | BGE 重排，按文件最高片段分数合并 |
| 混合＋重排 | 词法与稠密向量各前 64 个片段，RRF 融合后保留 64 个 | 相同 BGE 重排及文件合并 |

正文按照标题边界切分，每片最长 1,800 个 JavaScript 字符，相邻长片重叠 160 字符。标题和章节附在模型输入前。向量使用模型默认 1,024 维并做 L2 归一化，以内积计算余弦相似度；本实验不启用 BGE-M3 的稀疏或多向量输出。RRF 常数为 60。

所有组使用相同语料快照。范围与交互阅读的知识库补充检索一致：`wiki/sources`、`concepts`、`methods`、`datasets`、`synthesis`、`mocs`、`projects`、`entities`、`code`、`r`、`linux`。原文包、学习导出、批注、日志、顶层导航索引和 `wiki/index.md` 不纳入本轮，避免示例和历史生成回答影响基准。上述范围内的 MOC 和项目页仍会参与检索；它们作为导航线索的价值需要与直接证据区分。

本轮只比较内置词法候选这一层，没有调用查询改写、外部 Toolkit 的检索扩展或生成模型。重排组也增加了片段切分，收益不能全部归因于模型本身。真实应用还包括证据读取、来源过滤、回答生成和用户交互，需要后续单独验收。

## 固定数据与指标

问题由实际使用场景改述，至少覆盖中英表达、缩写、概念区分、相似主题、证据边界及资料不足。问题需要逐项附上已阅读笔记中的原文片段；相同主题的问题放在同一个 `dev` 或 `heldout` 分组，避免近义题跨组。模型调用前冻结题目、语料、切分参数和词法实现的哈希，不根据留出集的排名改标注。

私有 `questions.json` 是数组，每项如下；资料不足的问题改用 `noAnswer: true` 与 `absenceReason`，也可附说明缺口的原文片段：

```json
{
  "id": "Q01",
  "split": "heldout",
  "category": "概念区分",
  "family": "example-topic",
  "query": "这两个概念为什么不能互相替代？",
  "noAnswer": false,
  "answer": "参考答案应包含的要点",
  "evidence": [{ "path": "wiki/methods/example.md", "quote": "逐字核对的原文片段" }]
}
```

主要指标是 Hit@1、Hit@5、已标注参考文件 Recall@5 和 MRR@5。命中表示找到了至少一篇标注参考文件；多文献问题应另外检查是否覆盖全部必要依据。参考文件并非穷尽相关性标注，因此不报告完整 precision、科学结论正确率或人工金标准准确率。

资料不足的问题单独展示候选及分数。相关性很高仍可能缺少要求的表格、样本值、运行记录或因果证据；没有生成答案时，不计算幻觉率或拒答准确率。代理编写的题目与标签应明确标记为尚未经过用户独立评审。

## 运行方法

先运行合成测试：

```powershell
pnpm test:retrieval-benchmark
```

在仓库与 Vault 之外选择新的本地实验目录。`capture(app, outputDirectory)` 必须在 Obsidian 中执行，从当前 Vault 读取 Markdown 和真实元数据，创建 `corpus.json`。通过开发者控制台或 Obsidian CLI 调用模块；不要把实际语料或密钥写入仓库。然后在本机 Node 中执行：

```powershell
node scripts/retrieval-benchmark.cjs prepare C:/benchmark-private/run-001
node scripts/retrieval-benchmark.cjs online C:/benchmark-private/run-001
node scripts/retrieval-benchmark.cjs report C:/benchmark-private/run-001
```

`prepare` 读取事先编写的 `questions.json` 并验证引用，生成切片、协议和词法基线。首次生成采用排他创建，已经固定的实验不要覆盖；新参数使用新目录。

`online` 从现有进程环境变量 `SILICONFLOW_API_KEY` 读取凭据。也提供 `online-stdin`，供 Obsidian 通过 Node 子进程的标准输入传递 `app.secretStorage.getSecret("siliconflow")`；请使用 `spawn` 的参数数组和 `windowsHide: true`，不要把密钥拼入命令行、终端历史、文件或日志。在 Obsidian 内直接运行在线模块可能受到 Electron 的 Worker 限制，推荐本机 Node 子进程。

在线运行会将选定范围的笔记片段和问题发送到固定的硅基流动 API。仅请求上述两个普通模型，不切换 `Pro/` 或其他模型。服务端授权和限流决定请求是否成功，脚本不修改套餐。首次构建需要处理所有片段，后续可利用当前实验的本地向量和重排缓存继续。

程序串行请求、预留限流余量并设置超时；仅对 429、503、504 做有限重试。查看 `progress.json` 与 `online.json` 判断进度。中断后重新运行同一实验会复用已成功保存的缓存，不把未完成的组报告为完成。报告中的基线耗时来自快照读取，重排耗时与完整在线查询耗时须分开解释。

本地输出包括语料快照、问题、冻结协议、片段、基线、向量缓存、重排缓存、进度、在线结果和报告。它们可能包含笔记全文、路径和实验问题，禁止提交到公开仓库。脚本不会自动清理文件；每次报告都会核对来源哈希，原笔记变化只记录为完整性变化。

## 检查与边界

合成测试使用内存文件系统和模拟 HTTPS，验证切分覆盖、短证据段、范围排除、引用失配、重复排名、无答案计数、向量和重排响应、认证失败、缓存恢复、协议篡改及来源变化。测试不使用真实凭据、外网、磁盘写入或删除清理。它证明测试工具行为，不能替代真实模型效果验证。

本工具不把相似度解释为事实一致、重复或可自动合并，不回写正式笔记，不升级原文阅读深度。若实验显示收益，下一阶段再实现统一检索接口、来源质量约束、增量索引与可审阅的导出关联建议。

接口依据：[硅基流动 Embeddings API](https://api-docs.siliconflow.cn/docs/api/embeddings-post)、[Rerank API](https://api-docs.siliconflow.cn/docs/api/rerank-post)。
