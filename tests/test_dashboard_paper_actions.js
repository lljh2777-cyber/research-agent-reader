"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");
const readPlugin = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");

const actions = readPlugin("src/actions.ts");
const modal = readPlugin("src/modals/action-input.ts");
const serializer = readPlugin("src/runtime/action-request.ts");
const settings = readPlugin("src/runtime/settings.ts");
const settingsTab = readPlugin("src/settings/settings-tab.ts");
const dashboard = readPlugin("src/views/dashboard.ts");
const dashboardData = readPlugin("src/services/dashboard-data.ts");
const processExecution = readPlugin("src/runtime/process-execution.ts");

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
assert.match(dashboard, /serializeActionRequest\(/);
// Stop routing must be resolved by the plugin (loop → direct query →
// process), never inferred from executionConfig.backend in the dashboard.
assert.match(dashboard, /requestStopRun\(run: TaskRun\): void[\s\S]*?stopTaskRun\(run\.id\)/);
assert.doesNotMatch(dashboard, /isCliBackendId\(backend\)[\s\S]{0,200}stopDirectVaultQuery\(run\.id\)/);
// Light-agent modal contract: runner choice, MinerU readiness gate, and the
// honest no-PDF-reading disclaimer.
assert.match(modal, /运行方式/);
assert.match(modal, /lightPaperIngestAvailable\(\)/);
assert.match(modal, /lightAgentMineruReady\(\)/);
assert.match(modal, /不会读取 PDF 正文/);
assert.match(actions, /知识库体检[\s\S]*papers 与 Clippings 不参与常规体检/);
assert.match(actions, /三主目录链接边界/);
assert.match(dashboardData, /isExcludedMaintenancePath/);
assert.match(dashboardData, /isExcludedVaultHealthPath\(value\)/);
assert.match(processExecution, /tool-library[\s\S]*scripts[\s\S]*run_vault_action\.py/);

console.log("DASHBOARD_OPTIONAL_WORKFLOW_CONTRACT_TESTS_OK");
