"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");
const readPlugin = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");

const actions = readPlugin("src/actions.ts");
const modal = readPlugin("src/modals/action-input.ts");
const identityConfirmationModal = readPlugin("src/modals/human-identity-confirmation.ts");
const serializer = readPlugin("src/runtime/action-request.ts");
const settings = readPlugin("src/runtime/settings.ts");
const settingsTab = readPlugin("src/settings/settings-tab.ts");
const dashboard = readPlugin("src/views/dashboard.ts");
const dashboardData = readPlugin("src/services/dashboard-data.ts");
const processExecution = readPlugin("src/runtime/process-execution.ts");
const mineruProcess = readPlugin("src/runtime/mineru-process.ts");
const pluginSource = readPlugin("src/plugin.ts");
const mineruPublish = readPlugin("src/agent/mineru-publish.ts");
const vaultTreeReconcile = readPlugin("src/runtime/vault-tree-reconcile.ts");

assert.match(actions, /id:\s*"paper-ingest"[\s\S]*agent:\s*"paper-intake-pipeline"/);
assert.match(actions, /id:\s*"pdf-xray"[\s\S]*已有 MinerU article\.md/);
assert.match(modal, /生成原文 Markdown/);
assert.match(modal, /创建初步文章 Wiki/);
assert.match(modal, /文章 Wiki 内容来源/);
assert.match(modal, /MinerU 高精度提取/);
assert.match(modal, /precision extract/);
assert.match(modal, /解析模型/);
assert.match(modal, /VLM · 推荐/);
assert.match(modal, /Pipeline · 保守提取/);
assert.match(modal, /文档语言/);
assert.match(modal, /扫描件 OCR/);
assert.match(modal, /识别公式/);
assert.match(modal, /识别表格/);
assert.match(modal, /页面范围与超时/);
assert.match(modal, /页面范围/);
assert.match(modal, /提取超时（秒）/);
assert.match(modal, /mineruModel:/);
assert.match(modal, /mineruPages:/);
assert.match(modal, /"原始 PDF", true/);
assert.match(modal, /"已有 article\.md", false/);
assert.match(modal, /describeCliExecutable\([\s\S]*"mineru"/);
assert.match(serializer, /kind:\s*"dashboard-action-request"/);
assert.match(serializer, /papers\/、wiki\/、Clippings\//);
assert.match(serializer, /withRootIsolationInstruction/);
assert.match(serializer, /mineruExecutable:/);
assert.match(serializer, /mineruBaseUrl:/);
assert.match(settings, /MINERU_CLI_PATH/);
assert.match(settings, /mineru-open-api\.cmd/);
assert.match(settingsTab, /MinerU 可执行文件/);
assert.match(settingsTab, /MinerU API Token/);
assert.match(settingsTab, /SecretComponent/);
assert.match(settings, /mineruSecretId/);
assert.match(settingsTab, /MinerU 私有服务地址/);
assert.match(settingsTab, /MinerU 文献解析/);
assert.match(settingsTab, /每次确认远程上传/);
assert.match(settingsTab, /CLI 可用性检查/);
assert.match(settings, /mineruDefaultModel/);
assert.match(settings, /mineruDefaultLanguage/);
assert.match(settings, /mineruDefaultIncludeSourcePdf/);
assert.match(modal, /this\.plugin\.settings\.mineruDefaultModel/);
assert.match(modal, /this\.plugin\.settings\.mineruDefaultTimeoutSeconds/);
assert.match(modal, /uploadConfirmation/);
assert.match(modal, /候选标题/);
assert.match(modal, /候选 DOI/);
assert.match(modal, /identityCandidateTitle/);
assert.match(modal, /identityCandidateDoi/);
assert.match(identityConfirmationModal, /pageAbortController\?\.abort\(\)/);
assert.match(identityConfirmationModal, /await this\.preview\.decode\(\)/);
assert.match(identityConfirmationModal, /generation !== this\.loadGeneration/);
assert.match(identityConfirmationModal, /this\.confirmButton\?\.setAttribute\("disabled", "true"\)/);
assert.match(dashboard, /serializeActionRequest\(/);
assert.match(pluginSource, /outcome\.filesWritten\.includes\(articlePath\)[\s\S]*?reconcilePublishedPackage\(articlePath\)/);
assert.match(pluginSource, /reconcilePublishedVaultTree/);
assert.match(pluginSource, /onLayoutReady[\s\S]*?reconcileMissingPublishedPackages/);
assert.match(pluginSource, /adapter\.list\("papers"\)[\s\S]*?adapter\.exists\(articlePath, true\)/);
assert.match(vaultTreeReconcile, /reconcileInternalFile/);
// Stop routing must be resolved by the plugin (loop → direct query →
// process), never inferred from executionConfig.backend in the dashboard.
assert.match(dashboard, /requestStopRun\(run: TaskRun\): void[\s\S]*?stopTaskRun\(run\.id\)/);
assert.doesNotMatch(dashboard, /isCliBackendId\(backend\)[\s\S]{0,200}stopDirectVaultQuery\(run\.id\)/);
// Light-agent modal contract: runner choice, MinerU readiness gate, and the
// honest source-layer separation and no-silent-downgrade disclaimer.
assert.match(modal, /运行方式/);
assert.match(modal, /lightPaperIngestAvailable\(\)/);
assert.match(modal, /lightAgentMineruReady\(\)/);
assert.match(modal, /原文层（papers \+ Clippings）和分析层（wiki\/sources）/);
assert.match(modal, /两层相互独立且均不覆盖已有内容/);
assert.match(modal, /原文层 Markdown（papers \/ Clippings）/);
assert.match(modal, /提取失败不会静默改用元数据/);
assert.match(modal, /仅复用已有原文（papers \/ Clippings）/);
assert.match(modal, /没有可用原文时，需先完成原文转换/);
assert.doesNotMatch(modal, /元数据与用户说明（不读取 PDF）|内容来自元数据与用户说明/);
assert.match(
	mineruPublish,
	/mineru-open-api-\$\{process\.platform\}-\$\{process\.arch\}/,
	"npm MinerU launchers must resolve the platform-native binary without Electron",
);
assert.match(mineruPublish, /validateMineruNodeEntry\(entry\)[\s\S]{0,240}resolvePackagedMineruBinary\(validated\.packageRoot\)[\s\S]{0,160}return \{ command: nativeBinary, baseArgs: \[\] \}/);
// 任务默认策略: paper-ingest gains a default-runner dropdown and the model
// override is a recognized-model list, not free text.
assert.match(settingsTab, /默认运行方式/);
assert.match(settingsTab, /自动（优先轻量 Agent）|自动（有可用/);
assert.match(settingsTab, /actionModelChoices/);
assert.match(
	settingsTab,
	/setName\("模型覆盖"\)\s*\n\s*\.setDesc\("从当前后端识别到的模型中选择[^"]*"\)\s*\n\s*\.addDropdown/,
	"task-defaults model override must be a recognized-model dropdown",
);
assert.match(settingsTab, /两种运行方式：轻量 Agent/);
assert.match(settings, /runner: ActionRunnerPreference|runner\?: "auto" \| "light" \| "cli"|runnerRaw === "light"/);
assert.match(modal, /actionExecutionDefaults\["paper-ingest"\]\?\.runner/);
assert.match(actions, /知识库体检[\s\S]*papers 与 Clippings 不参与常规体检/);
assert.match(actions, /三主目录链接边界/);
assert.match(dashboardData, /isExcludedMaintenancePath/);
assert.match(dashboardData, /isExcludedVaultHealthPath\(value\)/);
assert.match(dashboardData, /Source note（Vault 相对路径）：\$\{record\.path\}/);
assert.doesNotMatch(dashboardData, /Source note：knowledge-base\/\$\{record\.path\}/);
assert.match(processExecution, /tool-library[\s\S]*scripts[\s\S]*run_vault_action\.py/);
assert.match(processExecution, /probeMineruCli[\s\S]*child\.stdin\.end\(\)/);
assert.match(processExecution, /probeMineruCli[\s\S]*resolveMineruCommand\(executable\)/);

assert.match(pluginSource, /getMineruToken\(\)/);
assert.match(mineruProcess, /mineruEnv\.MINERU_TOKEN = mineruToken/);
assert.doesNotMatch(mineruProcess, /mineruEnv\.ELECTRON_RUN_AS_NODE/);

console.log("DASHBOARD_OPTIONAL_WORKFLOW_CONTRACT_TESTS_OK");
