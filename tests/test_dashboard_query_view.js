"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
class ObsidianBase {}
class ObsidianTFile extends ObsidianBase {
	constructor(values = {}) {
		super();
		Object.assign(this, values);
	}
}
class ObsidianFileSystemAdapter extends ObsidianBase {}
const TFileStub = ObsidianTFile;
const obsidianStub = {
	Component: ObsidianBase,
	FileSystemAdapter: ObsidianFileSystemAdapter,
	ItemView: ObsidianBase,
	MarkdownRenderer: { render: async () => {} },
	Modal: ObsidianBase,
	Notice: class {},
	Plugin: ObsidianBase,
	PluginSettingTab: ObsidianBase,
	Setting: class {},
	TFile: ObsidianTFile,
	normalizePath: (value) => value,
	setIcon: () => {},
};
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, parent, isMain);
};

const pluginPath = path.resolve(
	__dirname,
	"../main.js",
);
const pluginSourceRoot = path.resolve(
	__dirname,
	"../src",
);
const fixtureProjectRoot = path.resolve(__dirname, "fixtures", "project");
const AgentDashboardPlugin = require(pluginPath);
Module._load = originalLoad;
const pluginSource = fs.readdirSync(pluginSourceRoot, { recursive: true })
	.filter((file) => String(file).endsWith(".ts"))
	.sort()
	.map((file) => fs.readFileSync(path.join(pluginSourceRoot, file), "utf8"))
	.join("\n");
const queryViewSource = fs.readFileSync(
	path.join(pluginSourceRoot, "views/query-wiki.ts"),
	"utf8",
);
const dashboardViewSource = fs.readFileSync(
	path.join(pluginSourceRoot, "views/dashboard.ts"),
	"utf8",
);
const pluginStyles = fs.readFileSync(
	path.resolve(pluginSourceRoot, "../styles.css"),
	"utf8",
);
const entrySource = fs.readFileSync(path.join(pluginSourceRoot, "main.ts"), "utf8").trim();
assert.match(dashboardViewSource, /rollbackEvent\?\.status === "rolled-back"/);
assert.match(dashboardViewSource, /自动回滚不完整，请检查变更清单/);
assert.strictEqual(
	entrySource,
	'export { default } from "./plugin";',
	"TypeScript entry point should remain a minimal strict re-export",
);
for (const modalSource of [
	"modals/action-input.ts",
	"modals/practice-note.ts",
	"modals/task-result.ts",
	"modals/vault-image-picker.ts",
]) {
	assert.ok(fs.existsSync(path.join(pluginSourceRoot, modalSource)));
	assert.ok(
		!fs.readFileSync(path.join(pluginSourceRoot, modalSource), "utf8").includes("@ts-nocheck"),
		`${modalSource} should remain under strict TypeScript checking`,
	);
}
for (const strictSource of [
	"plugin.ts",
	"providers/adapters.ts",
	"providers/http-transport.ts",
	"query/direct-query-service.ts",
	"runtime/lifecycle-state.ts",
	"runtime/persistence.ts",
	"runtime/process-execution.ts",
	"services/dashboard-data.ts",
	"services/vault-lint.ts",
	"settings/settings-tab.ts",
	"views/code-practice.ts",
	"views/dashboard.ts",
	"views/mineru-reader.ts",
	"views/query-wiki.ts",
	"mineru/normalization.ts",
	"mineru/package-loader.ts",
	"mineru/pdf-renderer.ts",
	"mineru/reader-markdown.ts",
	"mineru/types.ts",
	"types/contracts.ts",
]) {
	assert.ok(fs.existsSync(path.join(pluginSourceRoot, strictSource)));
	assert.ok(
		!fs.readFileSync(path.join(pluginSourceRoot, strictSource), "utf8").includes("@ts-nocheck"),
		`${strictSource} should remain under strict TypeScript checking`,
	);
}
const settingsSource = fs.readFileSync(
	path.join(pluginSourceRoot, "settings/settings-tab.ts"),
	"utf8",
);
const processExecutionSource = fs.readFileSync(
	path.join(pluginSourceRoot, "runtime/process-execution.ts"),
	"utf8",
);
const runtimeSettingsSource = fs.readFileSync(
	path.join(pluginSourceRoot, "runtime/settings.ts"),
	"utf8",
);
for (const settingsPage of [
	'renderSettingsHome(containerEl)',
	'renderRuntimeSettings(containerEl)',
	'renderMineruSettings(containerEl)',
	'renderReaderSettings(containerEl)',
	'renderTaskDefaultsSettings(containerEl)',
	'renderDataSettings(containerEl)',
	'renderCodexSettings(containerEl)',
	'renderClaudeSettings(containerEl)',
	'renderOpenCodeSettings(containerEl)',
	'renderAnnotationSettings(containerEl)',
	'renderDirectApiSettings(containerEl)',
]) {
	assert.ok(
		settingsSource.includes(settingsPage),
		`settings should retain the ${settingsPage} navigation target`,
	);
}
assert.ok(
	settingsSource.includes('type SettingsPage =')
		&& settingsSource.includes('| "opencode"')
		&& settingsSource.includes('| "direct-api"')
		&& settingsSource.includes('| "mineru"')
		&& settingsSource.includes('| "reader"')
		&& settingsSource.includes('| "tasks"')
		&& settingsSource.includes('| "data"'),
	"settings should retain a dedicated page state for each configuration module",
);
assert.ok(
	settingsSource.includes('title: "MinerU 文献解析"')
		&& settingsSource.includes('title: "文献阅读器"')
		&& settingsSource.includes('title: "任务默认策略"')
		&& settingsSource.includes('title: "数据与诊断"'),
	"settings home should expose MinerU, reader, task defaults, and diagnostics modules",
);
assert.ok(
	runtimeSettingsSource.includes("actionExecutionDefaults")
		&& runtimeSettingsSource.includes("queryDefaultBackendId")
		&& runtimeSettingsSource.includes("taskHistoryLimit")
		&& runtimeSettingsSource.includes("queryMessageLimit"),
	"settings persistence should define task defaults and bounded history controls",
);
assert.ok(
	settingsSource.includes('setIcon(chevron, "chevron-right")')
		&& settingsSource.includes('"aria-label": "返回设置首页"'),
	"settings should retain forward and back navigation affordances",
);
assert.ok(
	fs.readFileSync(path.join(pluginSourceRoot, "types/contracts.ts"), "utf8")
		.includes("export interface PluginHost"),
	"shared runtime contracts should expose the PluginHost boundary",
);
assert.ok(
	queryViewSource.includes("getClaudeDefaultModelLabel")
		&& queryViewSource.includes("claudeModel.parentElement.hidden = !usingClaude")
		&& queryViewSource.includes("executionOverridesByBackend"),
	"query settings should keep Codex and Claude model overrides independent",
);
assert.ok(
	queryViewSource.includes('label: "Agent（知识库 / 联网）"')
		&& queryViewSource.includes('label: "Direct API（仅知识库）"'),
	"query backend selection should visibly separate Agent and Direct API capabilities",
);
assert.ok(
	pluginStyles.includes(".query-wiki-settings-field[hidden]")
		&& pluginStyles.includes("display: none !important;"),
	"query settings should honor hidden backend-specific fields",
);
assert.ok(
	processExecutionSource.includes('"app-server"')
		&& processExecutionSource.includes('method: "model/list"')
		&& processExecutionSource.includes('"CC Switch 用户设置"')
		&& processExecutionSource.includes('"官方 Claude Code"'),
	"CLI model discovery should distinguish official Claude and CC Switch settings",
);
assert.ok(
	settingsSource.includes('.addOption("official", "官方 Codex CLI")')
		&& settingsSource.includes('.addOption("cc-switch", "CC Switch")')
		&& processExecutionSource.includes('model_provider="openai"'),
	"Codex settings should separate official OpenAI and CC Switch configuration sources",
);
assert.ok(
	settingsSource.includes('.addOption("official", "官方 Claude Code")')
		&& settingsSource.includes('.addOption("cc-switch", "CC Switch")'),
	"Claude settings should expose explicit official and CC Switch configuration sources",
);
assert.ok(
	settingsSource.includes('.addOption("official", "官方 OpenCode Zen")')
		&& settingsSource.includes('this.plugin.testProviderConnection("opencode")')
		&& processExecutionSource.includes('["models", "opencode"]')
		&& processExecutionSource.includes('"OpenCode models · CC Switch"'),
	"OpenCode settings should separate official Zen and CC Switch configuration sources",
);
assert.ok(
	processExecutionSource.includes('"--probe-backend"')
		&& processExecutionSource.includes("spawn(pythonExecutable, args")
		&& processExecutionSource.includes('"未配置 Python 可执行文件"')
		&& processExecutionSource.includes("统一 runner 不存在："),
	"OpenCode connection tests should run through the configured Python runner",
);
assert.ok(
	runtimeSettingsSource.includes('"CODEX_CLI_PATH"')
		&& runtimeSettingsSource.includes('"CLAUDE_CODE_PATH"')
		&& runtimeSettingsSource.includes('"OPENCODE_PATH"')
		&& runtimeSettingsSource.includes("process.env.PATH")
		&& runtimeSettingsSource.includes('"where.exe"'),
	"CLI executable detection should support environment variables and system PATH",
);
assert.ok(
	runtimeSettingsSource.includes('"scoop", "shims", "claude.exe"')
		&& runtimeSettingsSource.includes('"npm", "claude.cmd"')
		&& runtimeSettingsSource.includes('"scoop", "shims", "opencode.exe"')
		&& runtimeSettingsSource.includes('"npm", "codex.cmd"'),
	"CLI executable detection should include common package-manager locations",
);
assert.ok(
	!runtimeSettingsSource.includes("C:\\\\Users\\\\Thomas Wade"),
	"CLI defaults must not contain a user-specific executable path",
);
assert.ok(
	settingsSource.includes('"重新检测"')
		&& settingsSource.includes("自动检测来源：")
		&& settingsSource.includes("describeCliExecutable")
		&& settingsSource.includes("detectCliExecutable"),
	"runtime settings should display detection sources and provide re-detection controls",
);
assert.ok(
	processExecutionSource.includes("prepareCliSpawn")
		&& processExecutionSource.includes('replace(/\\.(?:cmd|bat)$/i, ".ps1")')
		&& processExecutionSource.includes('"powershell.exe"'),
	"Windows npm CLI shims should execute through their PowerShell wrapper without shell mode",
);
assert.ok(
	queryViewSource.includes('attr: { value: "opencode" }')
		&& queryViewSource.includes('this.executionOverridesByBackend["opencode"]')
		&& queryViewSource.includes("openCodeModel.parentElement.hidden = !usingOpenCode"),
	"query settings should expose independent OpenCode model controls",
);

const plugin = new AgentDashboardPlugin();
const cleanVaultPlugin = new AgentDashboardPlugin();
cleanVaultPlugin.settings = {
	projectRoot: "",
	pythonExecutable: "",
	codexExecutable: "",
	claudeExecutable: "",
	openCodeExecutable: "",
	rscriptExecutable: "",
	mineruExecutable: "",
};
assert.deepStrictEqual(
	cleanVaultPlugin.checkRuntime({ id: "vault-lint", label: "知识库体检" }),
	{
		ready: true,
		message: "内置知识库体检可用；不需要 Research Vault Toolkit、Python 或 Agent CLI。",
	},
);
const optionalRuntime = cleanVaultPlugin.checkRuntime(
	{ id: "synthesis", label: "综合分析", writes: true },
	"codex-cli",
);
assert.strictEqual(optionalRuntime.ready, false);
assert.match(optionalRuntime.message, /可选工具包/);
assert.match(optionalRuntime.message, /内置阅读器、批注和知识库体检不受影响/);
plugin.taskRuns = [
	{
		id: "run-complete",
		actionId: "synthesis",
		status: "done",
		startedAt: "2026-07-26T00:00:00Z",
	},
	{
		id: "run-active",
		actionId: "synthesis",
		status: "running",
		startedAt: "2026-07-26T01:00:00Z",
	},
];
assert.strictEqual(plugin.getRunningTaskRun("synthesis").id, "run-active");
assert.strictEqual(plugin.getRunningTaskRun("vault-lint"), null);
plugin.taskRuns = [];

assert.ok(
	pluginSource.includes('value: healthScore === null ? "—" : String(healthScore)'),
	"health metric should use the latest lint report or show no result",
);
assert.ok(
	!pluginSource.includes("100 - linkReport.broken.length * 2 - missingFrontmatter"),
	"health metric must not fall back to an estimated default score",
);
assert.ok(
	pluginSource.includes("const scrollTop = this.contentEl.scrollTop;"),
	"code-practice rendering should preserve the current scroll position",
);
assert.ok(
	pluginSource.includes('this.language === "r"')
		&& pluginSource.includes('editor.setRangeText("<-", editor.selectionStart, editor.selectionEnd, "end")'),
	"R code-practice cells should support Alt+- for the assignment operator",
);
assert.ok(
	pluginSource.includes('isRunning ? "点击停止" : "空闲"'),
	"running Dashboard actions should expose a manual stop control",
);

const priorMessages = Array.from({ length: 12 }, (_, index) => ({
	role: index % 2 === 0 ? "user" : "assistant",
	status: "done",
	content: `${index % 2 === 0 ? "问题" : "回答"} ${index}`,
}));
const payload = JSON.parse(
	plugin.buildQueryActionInput("详细讲讲这个方法", priorMessages),
);

assert.strictEqual(payload.kind, "query-session");
assert.strictEqual(payload.question, "详细讲讲这个方法");
assert.strictEqual(payload.mode, "web");
assert.strictEqual(payload.recent_turns.length, 8);
assert.strictEqual(payload.recent_turns[0].content, "问题 4");
assert.ok(payload.conversation_summary.includes("对话起点：问题 0"));
assert.ok(!payload.question.includes("回答"));

const vaultPayload = JSON.parse(
	plugin.buildQueryActionInput("仅检查已有证据", priorMessages, "vault"),
);
assert.strictEqual(vaultPayload.mode, "vault");
const imagePayload = JSON.parse(
	plugin.buildQueryActionInput(
		"解释这张图",
		priorMessages,
		"vault",
		[{
			path: "wiki/assets/figures/example.png",
			name: "example.png",
			mimeType: "image/png",
			size: 128,
			sourceNotePath: "wiki/sources/example.md",
		}],
	),
);
assert.strictEqual(imagePayload.attachments.length, 1);
assert.strictEqual(
	imagePayload.attachments[0].path,
	"wiki/assets/figures/example.png",
);
assert.ok(
	queryViewSource.includes('backendId === "claude-code"')
		&& (
			queryViewSource.includes("Claude Code `Read`")
			|| queryViewSource.includes("图片由 Read 工具按本地路径读取")
		),
	"Claude Code query mode should expose validated Vault image attachments",
);

const session = plugin.makeQuerySession();
assert.strictEqual(session.retrievalMode, "web");
assert.strictEqual(session.queryBackendId, "codex-cli");

const claudePlugin = new AgentDashboardPlugin();
claudePlugin.settings = {
	projectRoot: path.resolve(__dirname, "../.."),
	codexExecutable: process.execPath,
	codexModel: "gpt-5.6-terra",
	codexReasoningEffort: "medium",
	claudeExecutable: process.execPath,
	claudeModel: "",
	claudeReasoningEffort: "high",
	annotationBackendId: "claude-code",
	providerProfiles: [],
};
assert.strictEqual(
	claudePlugin.resolveQueryBackendId("claude-code"),
	"claude-code",
);
const claudeExecution = claudePlugin.resolveCliActionExecutionConfig(
	{ id: "vault-retrieval", reasoningEffort: "medium" },
	"claude-code",
);
assert.strictEqual(claudeExecution.backend, "claude-code");
assert.strictEqual(claudeExecution.model, "");
assert.strictEqual(claudeExecution.reasoningEffort, "high");
assert.strictEqual(claudeExecution.serviceTier, "default");
assert.ok(
	pluginSource.includes('"--backend-executable"')
		&& pluginSource.includes('executionConfig.backend === "claude-code"'),
	"local action execution should pass the selected CLI adapter and executable",
);

async function testDirectApiQuery() {
	const profile = {
		id: "provider-deepseek",
		name: "ds-v4-pro",
		type: "openai-compatible",
		baseUrl: "https://api.example.test",
		model: "deepseek-v4-pro",
		secretId: "deepseek-main",
		timeoutSeconds: 20,
		capabilities: { streaming: true, pdf: false, vision: false },
		lastTest: { ok: true },
	};
	plugin.settings = {
		projectRoot: fixtureProjectRoot,
		providerProfiles: [profile],
	};
	assert.deepStrictEqual(plugin.getVerifiedProviderProfiles().map((item) => item.id), [profile.id]);
	assert.strictEqual(plugin.resolveQueryBackendId(profile.id), profile.id);
	assert.strictEqual(plugin.resolveQueryBackendId("missing-provider"), "codex-cli");
	const safeEvidence = plugin.readVaultEvidencePacket({
		candidate_paths: ["wiki/index.md", "../AGENTS.md"],
	});
	assert.strictEqual(safeEvidence.length, 1);
	assert.strictEqual(safeEvidence[0].path, "wiki/index.md");

	const evidence = [{
		path: "wiki/methods/example.md",
		wikilink: "[[wiki/methods/example]]",
		content: "# Example\nVault evidence",
	}];
	const trace = {
		stage: "lexical-seed+graph-expansion",
		lexical_seeds: [{ path: "wiki/methods/example.md" }],
		graph_expansion: [],
		fallback: { used: false, paths: [] },
		candidate_paths: ["wiki/methods/example.md"],
	};
	const events = [];
	let directRequest = null;
	plugin.runVaultRetrievalPreflight = async () => trace;
	plugin.readVaultEvidencePacket = () => evidence;
	plugin.createLLMProvider = () => ({
		complete: async (request) => {
			directRequest = request;
			return { text: "基于 [[wiki/methods/example]] 的回答。" };
		},
	});
	const result = await plugin.runDirectVaultQuery(
		"run-direct",
		profile.id,
		"这个方法是什么？",
		priorMessages,
		"vault",
		{ onEvent: (event) => events.push(event) },
	);
	assert.strictEqual(result.exitCode, 0);
	assert.ok(result.stdout.includes("[[wiki/methods/example]]"));
	assert.strictEqual(result.events[0].type, "retrieval-preflight");
	assert.ok(events.some((event) => event.type === "retrieval-preflight"));
	assert.strictEqual(directRequest.model, "deepseek-v4-pro");
	assert.ok(directRequest.messages[0].content.includes("只能依据本次提供的 Vault 证据"));
	assert.ok(directRequest.messages.at(-1).content.includes("wiki/methods/example.md"));
	assert.strictEqual(plugin.isQueryExecutionActive("run-direct", profile.id), false);

	profile.name = "Qwen3.7-Plus";
	profile.model = "qwen3.7-plus";
	profile.capabilities.vision = true;
	profile.lastTest.streamingVerified = false;
	let visionRequest = null;
	plugin.createLLMProvider = () => ({
		complete: async (request) => {
			visionRequest = request;
			return { text: "图像回答" };
		},
	});
	const imagePath = "wiki/assets/figures/li_cellular_2026/figure-1.png";
	const secondImagePath = "wiki/assets/figures/li_cellular_2026/figure-2.png";
	const visionResult = await plugin.runDirectVaultQuery(
		"run-vision",
		profile.id,
		"联合分析这两张图",
		[],
		"vault",
		{},
		[
			{
				path: imagePath,
				name: "figure-1.png",
				sourceNotePath: "wiki/sources/li_cellular_2026.md",
			},
			{
				path: secondImagePath,
				name: "figure-2.png",
				sourceNotePath: "wiki/sources/li_cellular_2026.md",
			},
		],
	);
	assert.strictEqual(visionResult.stdout, "图像回答");
	assert.deepStrictEqual(
		visionResult.events[0].payload.linked_note_paths,
		["wiki/sources/li_cellular_2026.md"],
	);
	const visionContent = visionRequest.messages.at(-1).content;
	assert.ok(Array.isArray(visionContent));
	assert.strictEqual(visionContent[0].type, "image_url");
	assert.ok(visionContent[0].image_url.url.startsWith("data:image/png;base64,"));
	assert.strictEqual(visionContent[1].type, "image_url");
	assert.ok(visionContent[1].image_url.url.startsWith("data:image/png;base64,"));
	assert.strictEqual(visionContent.at(-1).type, "text");
	assert.ok(visionContent.at(-1).text.includes("实际检查图片像素"));
	assert.ok(visionContent.at(-1).text.includes("图片 2"));
	assert.ok(visionContent.at(-1).text.includes("wiki/sources/li_cellular_2026.md"));
	const normalizedVisionSession = plugin.normalizeQuerySession({
		messages: [{
			role: "user",
			content: "联合分析这两张图",
			attachments: [
				{ path: imagePath, name: "figure-1.png" },
				{ path: secondImagePath, name: "figure-2.png" },
			],
		}],
	});
	assert.strictEqual(normalizedVisionSession.messages[0].attachments[0].path, imagePath);
	assert.strictEqual(normalizedVisionSession.messages[0].attachments[1].path, secondImagePath);
	assert.ok(!JSON.stringify(normalizedVisionSession).includes("base64"));
	assert.throws(
		() => plugin.readVaultImageData({ path: "../outside.png" }),
		(error) => /超出当前 Vault/.test(error.message),
	);

	await assert.rejects(
		() => plugin.runDirectVaultQuery(
			"run-web",
			profile.id,
			"联网搜索",
			[],
			"web",
		),
		(error) => /Direct API 仅用于知识库内检索/.test(error.message),
	);
	assert.ok(
		queryViewSource.includes("option.disabled = this.session.retrievalMode === \"web\""),
		"Direct API options should remain available for vault mode but be disabled in web mode",
	);

	const expansionCalls = [];
	plugin.runVaultRetrievalPreflight = async (_runId, _question, expandedTerms = []) => {
		expansionCalls.push(expandedTerms);
		return expandedTerms.length
			? {
				...trace,
				stage: "llm-keyword+ppr",
				retrieval_label: "LLM+PPR",
				keyword_expansion: { used: true, terms: expandedTerms },
			}
			: {
				stage: "no-match-fallback",
				retrieval_label: "NoMatch+Index",
				lexical_seeds: [],
				graph_expansion: [],
				fallback: { used: true, paths: [] },
				candidate_paths: [],
			};
	};
	let expansionCompletion = 0;
	plugin.createLLMProvider = () => ({
		complete: async () => {
			expansionCompletion += 1;
			return expansionCompletion === 1
				? { text: "{\"keywords\":[\"SingleR annotation\",\"cell type annotation\"]}" }
				: { text: "扩展检索回答" };
		},
	});
	const expanded = await plugin.runDirectVaultQuery(
		"run-expansion",
		profile.id,
		"细胞身份判定",
		[],
		"vault",
	);
	assert.strictEqual(expanded.stdout, "扩展检索回答");
	assert.deepStrictEqual(expansionCalls[1], ["SingleR annotation", "cell type annotation"]);
	assert.strictEqual(expanded.events[0].payload.retrieval_label, "LLM+PPR");

	plugin.runVaultRetrievalPreflight = async () => trace;
	profile.lastTest.streamingVerified = true;
	const streamEvents = [];
	plugin.createLLMProvider = () => ({
		stream: async (_request, onDelta) => {
			onDelta("流式");
			onDelta("回答");
			return { text: "流式回答" };
		},
		complete: async () => {
			throw new Error("streaming should avoid non-streaming completion");
		},
	});
	const streamed = await plugin.runDirectVaultQuery(
		"run-stream",
		profile.id,
		"流式测试",
		[],
		"vault",
		{ onEvent: (event) => streamEvents.push(event) },
	);
	assert.strictEqual(streamed.stdout, "流式回答");
	assert.deepStrictEqual(
		streamEvents.filter((event) => event.type === "assistant-delta").map((event) => event.delta),
		["流式", "回答"],
	);

	plugin.createLLMProvider = () => ({
		stream: async (_request, onDelta) => {
			onDelta("不完整");
			throw new Error("stream disconnected");
		},
		complete: async () => ({ text: "回退回答" }),
	});
	const fallbackEvents = [];
	const fallbackResult = await plugin.runDirectVaultQuery(
		"run-stream-fallback",
		profile.id,
		"回退测试",
		[],
		"vault",
		{ onEvent: (event) => fallbackEvents.push(event) },
	);
	assert.strictEqual(fallbackResult.stdout, "回退回答");
	assert.ok(fallbackEvents.some((event) => event.type === "assistant-reset"));
	assert.ok(fallbackEvents.some(
		(event) => event.type === "status" && event.stage === "stream-fallback",
	));

	const figurePath = "wiki/assets/figures/example/figure-1.png";
	const unreferencedPath = "wiki/assets/figures/example/figure-2.png";
	const autoFigurePath = "wiki/assets/figures/example/figure-3.png";
	const sourceNote = new TFileStub({
		path: "wiki/sources/example.md",
		basename: "example",
	});
	const methodNote = new TFileStub({
		path: "wiki/methods/example-method.md",
		basename: "example-method",
	});
	const figureFile = new TFileStub({
		path: figurePath,
		name: "figure-1.png",
		stat: { size: 1024 },
	});
	const autoFigureFile = new TFileStub({
		path: autoFigurePath,
		name: "figure-3.png",
		stat: { size: 2048 },
	});
	const filesByPath = new Map([
		[sourceNote.path, sourceNote],
		[methodNote.path, methodNote],
		[figurePath, figureFile],
		[autoFigurePath, autoFigureFile],
	]);
	plugin.app = {
		vault: {
			getAbstractFileByPath: (value) => filesByPath.get(value) || null,
			getMarkdownFiles: () => [sourceNote, methodNote],
		},
		metadataCache: {
			resolvedLinks: {
				[sourceNote.path]: { [figurePath]: 2 },
			},
			getFileCache: (file) => {
				if (file.path === sourceNote.path) {
					return {
						frontmatter: { title_zh: "示例论文" },
						embeds: [
							{ link: figurePath },
							{ link: figurePath },
							{ link: autoFigurePath },
						],
					};
				}
				return {
					frontmatter: { title: "Example method" },
					embeds: [{ link: figurePath }],
				};
			},
			getFirstLinkpathDest: (link) => filesByPath.get(link) || null,
		},
	};
	const referenceIndex = plugin.buildVaultImageReferenceIndex([
		{ path: figurePath },
		{ path: unreferencedPath },
	]);
	assert.deepStrictEqual(referenceIndex.get(figurePath), [
		{ path: sourceNote.path, title: "示例论文", count: 2 },
		{ path: methodNote.path, title: "Example method", count: 1 },
	]);
	assert.deepStrictEqual(referenceIndex.get(unreferencedPath), []);

	const linkedNotes = plugin.extractQuestionNoteFiles(
		"请分析 obsidian://open?vault=knowledge-base&file=wiki%2Fsources%2Fexample中的图片，并联系 [[wiki/methods/example-method|方法页]]。",
	);
	assert.deepStrictEqual(
		linkedNotes.map((file) => file.path),
		[sourceNote.path, methodNote.path],
	);
	const discovered = await plugin.resolveQuestionImageAttachments(
		"请分析 obsidian://open?vault=knowledge-base&file=wiki%2Fsources%2Fexample中的图片",
	);
	assert.strictEqual(discovered.discoveredCount, 2);
	assert.deepStrictEqual(
		discovered.attachments.map((attachment) => attachment.path),
		[figurePath, autoFigurePath],
	);
	assert.ok(discovered.attachments.every(
		(attachment) => attachment.sourceNotePath === sourceNote.path,
	));
}

async function testSerializedSettingsSnapshots() {
	const persistencePlugin = new AgentDashboardPlugin();
	persistencePlugin.settings = {
		projectRoot: "first-root",
		providerProfiles: [],
		activeProviderId: "",
	};
	persistencePlugin.taskRuns = [{
		id: "run-1",
		output: "x".repeat(50000),
		error: "",
	}];
	persistencePlugin.querySessions = [{
		id: "session-1",
		messages: Array.from({ length: 40 }, (_, index) => ({
			id: `message-${index}`,
			content: "y".repeat(10000),
			error: "",
		})),
	}];
	persistencePlugin.activeQuerySessionId = "session-1";
	const snapshots = [];
	persistencePlugin.saveData = async (snapshot) => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		snapshots.push(snapshot);
	};
	const first = persistencePlugin.saveSettings();
	persistencePlugin.settings.projectRoot = "second-root";
	const second = persistencePlugin.saveSettings();
	await Promise.all([first, second]);
	assert.deepStrictEqual(
		snapshots.map((snapshot) => snapshot.settings.projectRoot),
		["first-root", "second-root"],
	);
	assert.strictEqual(snapshots[0].taskRuns[0].output.length, 12000);
	assert.strictEqual(snapshots[0].querySessions[0].messages.length, 30);
	assert.strictEqual(
		snapshots[0].querySessions[0].messages[0].content.length,
		8000,
	);
}

async function testClaudeCliModelDiscovery() {
	const discoveryPlugin = new AgentDashboardPlugin();
	discoveryPlugin.settings = {
		projectRoot: path.resolve(__dirname, "../.."),
		claudeExecutable: process.execPath,
		claudeConfigSource: "official",
		claudeModel: "qwen-test-model",
		claudeReasoningEffort: "medium",
		providerProfiles: [],
	};
	const discovery = await discoveryPlugin.discoverCliModels("claude-code", true);
	assert.strictEqual(discovery.backendId, "claude-code");
	assert.strictEqual(discovery.effectiveModel, "qwen-test-model");
	assert.ok(discovery.models.some((model) => model.id === "qwen-test-model"));
	assert.strictEqual(discovery.source, "插件设置覆盖");
	assert.strictEqual(
		discoveryPlugin.getCliModelDiscovery("claude-code").effectiveModel,
		"qwen-test-model",
	);
}

async function testConfigurableDefaultsAndHistory() {
	const defaultsPlugin = new AgentDashboardPlugin();
	defaultsPlugin.settings.actionExecutionDefaults.synthesis = {
		backend: "codex-cli",
		model: "gpt-settings-test",
		reasoningEffort: "low",
		serviceTier: "default",
	};
	const synthesisAction = { id: "synthesis", model: "gpt-action", reasoningEffort: "high" };
	const execution = defaultsPlugin.resolveActionExecutionConfig(synthesisAction);
	assert.strictEqual(execution.model, "gpt-settings-test");
	assert.strictEqual(execution.reasoningEffort, "low");
	assert.strictEqual(execution.modelSource, "任务设置");

	defaultsPlugin.settings.queryDefaultBackendId = "codex-cli";
	defaultsPlugin.settings.queryDefaultRetrievalMode = "vault";
	assert.strictEqual(defaultsPlugin.makeQuerySession().retrievalMode, "vault");

	defaultsPlugin.taskRuns = [
		{ id: "done", status: "done" },
		{ id: "running", status: "running" },
	];
	defaultsPlugin.querySessions = [{ id: "old", messages: [{ id: "message" }] }];
	defaultsPlugin.saveData = async () => {};
	assert.strictEqual(await defaultsPlugin.clearCompletedTaskHistory(), 1);
	assert.deepStrictEqual(defaultsPlugin.taskRuns.map((run) => run.id), ["running"]);
	await defaultsPlugin.resetQueryHistory();
	assert.strictEqual(defaultsPlugin.querySessions.length, 1);
	assert.deepStrictEqual(defaultsPlugin.querySessions[0].messages, []);
}

Promise.all([
	testDirectApiQuery(),
	testSerializedSettingsSnapshots(),
	testClaudeCliModelDiscovery(),
	testConfigurableDefaultsAndHistory(),
])
	.then(() => console.log("DASHBOARD_QUERY_VIEW_TEST_OK"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
