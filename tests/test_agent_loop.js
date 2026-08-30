"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");

class ObsidianBase {}
class ObsidianTFile extends ObsidianBase {}
class ObsidianFileSystemAdapter extends ObsidianBase {}

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
	normalizePath: (value) => String(value).replace(/([^:])\\+/g, "$1/").replace(/\/+/g, "/"),
	setIcon: () => {},
};
const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, parent, isMain);
};
require(path.join(pluginRoot, "main.js"));

const hookEntry = path.join(pluginRoot, "tests", "agent-loop-hooks.ts");
const hookBuild = esbuild.buildSync({
	stdin: {
		contents: [
			"export { runBoundedAgentLoop, extractFirstJsonObject, renderToolCatalog }",
			'  from "./src/agent/loop";',
			"export {",
			"  createVaultReadTool,",
			"  createVaultListTool,",
			"  createVaultSearchTool,",
			"  createCrossrefSearchTool,",
			"  createCrossrefDoiTool,",
			"  createWebSearchTool,",
			"  buildMineruHelperArgs,",
			"  runAuthorizedMineruExtract,",
			"  mineruReadiness,",
			"  commitSourceNote,",
			"  validateSourceNoteContent,",
			"  yamlSafeScalar,",
			"  VaultWriteJournal,",
			'} from "./src/agent/tools";',
			"export {",
			"  buildIdentitySystemPrompt,",
			"  buildIdentityUserMessage,",
			"  buildDraftSystemPrompt,",
			"  buildDraftTools,",
			"  buildIdentityTools,",
			"  parseIdentityResult,",
			"  parseNoteDraft,",
			"  validateIdentityReceipts,",
			"  evaluateDraftPhase,",
			"  computeIngestOutcomeStatus,",
			"  resolveUniqueCitekey,",
			"  deriveArticleVaultPath,",
			"  resolveArticleVaultPath,",
			"  parsePaperIngestInput,",
			"  stripMatchingQuotes,",
			"  PAPER_INGEST_READ_PREFIXES,",
			'} from "./src/agent/paper-ingest-flow";',
			"export { articleHeadContainsTitle } from './src/agent/agent-loop-service';",
			"export { isSameRealPath, canonicalRealPath } from './src/agent/path-binding';",
			"export { normalizeTaskRunArtifacts, normalizeStoredTaskRuns } from './src/runtime/persistence';",
		].join("\n"),
		resolveDir: pluginRoot,
		sourcefile: hookEntry,
		loader: "ts",
	},
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	external: ["obsidian"],
	logLevel: "silent",
});
const hookModule = new Module(hookEntry, module);
hookModule.filename = hookEntry;
hookModule.paths = Module._nodeModulePaths(pluginRoot);
hookModule._compile(hookBuild.outputFiles[0].text, hookEntry);
const {
	runBoundedAgentLoop,
	extractFirstJsonObject,
	createVaultReadTool,
	createVaultListTool,
	createVaultSearchTool,
	createCrossrefSearchTool,
	createCrossrefDoiTool,
	createWebSearchTool,
	buildMineruHelperArgs,
	runAuthorizedMineruExtract,
	mineruReadiness,
	commitSourceNote,
	validateSourceNoteContent,
	yamlSafeScalar,
	VaultWriteJournal,
	buildIdentitySystemPrompt,
	buildIdentityUserMessage,
	buildDraftSystemPrompt,
	buildDraftTools,
	buildIdentityTools,
	parseIdentityResult,
	parseNoteDraft,
	validateIdentityReceipts,
	evaluateDraftPhase,
	computeIngestOutcomeStatus,
	resolveUniqueCitekey,
	deriveArticleVaultPath,
	resolveArticleVaultPath,
	parsePaperIngestInput,
	stripMatchingQuotes,
	PAPER_INGEST_READ_PREFIXES,
	articleHeadContainsTitle,
	isSameRealPath,
	normalizeTaskRunArtifacts,
	normalizeStoredTaskRuns,
} = hookModule.exports;
Module._load = originalLoad;

const createContext = () => ({
	signal: new AbortController().signal,
	deadline: Date.now() + 600000,
	remainingMs: () => 600000,
});

function createFakeVault(files, options = {}) {
	const written = [];
	const created = [];
	const adapter = {
		exists: async (target) => {
			const normalized = String(target).replace(/\\/g, "/");
			if (files.has(normalized)) return true;
			for (const key of files.keys()) {
				if (key.startsWith(`${normalized}/`)) return true;
			}
			return [...written, ...created].some((entry) => entry.path === normalized);
		},
		write: async (target, data) => {
			written.push({ path: String(target), data: String(data) });
		},
		mkdir: async () => {},
		read: async (target) => {
			const normalized = String(target).replace(/\\/g, "/");
			if (files.has(normalized)) return files.get(normalized);
			const entry = [...written, ...created].find((item) => item.path === normalized);
			if (!entry) throw new Error(`文件不存在：${normalized}`);
			return entry.data;
		},
	};
	const toStubFile = (filePath) => {
		const extension = filePath.split(".").pop() || "";
		return Object.assign(new ObsidianTFile(), { path: filePath, extension });
	};
	const create = async (target, data) => {
		const normalized = String(target).replace(/\\/g, "/");
		if (files.has(normalized) || created.some((entry) => entry.path === normalized)) {
			throw new Error("File already exists");
		}
		const entry = { path: normalized, data: String(data) };
		created.push(entry);
		return toStubFile(normalized);
	};
	return {
		written,
		created,
		createShouldFail: options.createShouldFail || false,
		vault: {
			getAbstractFileByPath: (target) => {
				const normalized = String(target).replace(/\\/g, "/");
				return files.has(normalized) ? toStubFile(normalized) : null;
			},
			getMarkdownFiles: () => [...files.keys()]
				.filter((key) => key.endsWith(".md"))
				.map(toStubFile),
			getFiles: () => [...files.keys()].map(toStubFile),
			read: async (file) => files.get(String(file.path)) ?? "",
			adapter,
			create: async (target, data) => {
				if (options.createShouldFail) throw new Error("File already exists");
				return create(target, data);
			},
		},
	};
}

function createFakeProvider(turns) {
	let call = 0;
	const calls = [];
	return {
		calls,
		turnCount: () => call,
		async complete(request) {
			calls.push(request.messages.map((message) => `${message.role}:${String(message.content)}`));
			assert.ok(request.maxTokens >= 512, "loop must pass an explicit maxTokens >= 512");
			const turn = turns[Math.min(call, turns.length - 1)];
			call += 1;
			return { text: typeof turn === "function" ? turn(call) : turn };
		},
	};
}

function testExtractFirstJsonObject() {
	const fenced = "说明\n```json\n{\"action\":\"tool\",\"tool\":\"a\",\"arguments\":{\"x\":1}}\n```";
	const parsed = extractFirstJsonObject(fenced);
	assert.equal(parsed.json.action, "tool");
	assert.equal(parsed.json.arguments.x, 1);

	const nested = "前缀 {\"action\":\"final\",\"result\":{\"files\":[\"a{b}.md\"]}} 后缀";
	assert.equal(extractFirstJsonObject(nested).json.result.files[0], "a{b}.md");

	const inString = "{\"action\":\"tool\",\"arguments\":{\"note\":\"brace } inside\"}}";
	assert.equal(extractFirstJsonObject(inString).json.action, "tool");

	// An invalid first balanced object must not block a later valid payload.
	const invalidFirst = "{invalid} 说明文字 {\"action\":\"final\",\"result\":{}}";
	assert.equal(extractFirstJsonObject(invalidFirst).json.action, "final");

	assert.equal(extractFirstJsonObject("没有 JSON").json, null);
}

async function testLoopToolRoundtripAndReceipts() {
	const tools = [{
		name: "echo",
		description: "echoes input",
		parameters: { value: "任意字符串" },
		required: ["value"],
		async execute(args) {
			return { output: `echo:${args.value}`, summary: "echoed" };
		},
	}, {
		name: "boom",
		description: "always fails",
		parameters: {},
		async execute() {
			throw new Error("boom");
		},
	}];
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "echo", arguments: { value: "hi" } }),
		JSON.stringify({ action: "tool", tool: "boom", arguments: {} }),
		JSON.stringify({ action: "final", result: { ok: true } }),
	]);
	const result = await runBoundedAgentLoop({
		system: "测试系统提示",
		user: "开始任务",
		tools,
		provider,
		model: "test-model",
		maxTokens: 4096,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.final.ok, true);
	assert.equal(result.toolCalls.length, 2, "plugin must record one receipt per tool execution");
	assert.equal(result.toolCalls[0].tool, "echo");
	assert.equal(result.toolCalls[0].ok, true);
	assert.match(result.toolCalls[0].argsSummary, /value=hi/);
	assert.equal(result.toolCalls[1].tool, "boom");
	assert.equal(result.toolCalls[1].ok, false);
}

async function testLoopRepairsNonConsecutiveProtocolErrors() {
	const provider = createFakeProvider([
		"不是 JSON",
		JSON.stringify({ action: "final", result: { first: true } }),
	]);
	const first = await runBoundedAgentLoop({
		system: "s", user: "u", tools: [], provider, model: "m", maxTokens: 2048,
	});
	assert.equal(first.status, "completed", "第一次协议错误应允许修复");

	const provider2 = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "real", arguments: {} }),
		"还不是 JSON",
		JSON.stringify({ action: "final", result: { recovered: true } }),
	]);
	const second = await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "real", description: "d", parameters: {},
			async execute() { return { output: "ok" }; },
		}],
		provider: provider2, model: "m", maxTokens: 2048,
	});
	assert.equal(second.status, "completed", "合法轮次之后的单次协议错误应重置计数");
	assert.equal(second.final.recovered, true);

	const provider3 = createFakeProvider(["不是 JSON", "还不是 JSON"]);
	const third = await runBoundedAgentLoop({
		system: "s", user: "u", tools: [], provider: provider3, model: "m", maxTokens: 2048,
	});
	assert.equal(third.status, "failed");
	assert.match(third.error, /工具循环协议/);
}

async function testLoopCancellationAbortsSignalDuringTools() {
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "wait", arguments: {} }),
		JSON.stringify({ action: "final", result: {} }),
	]);
	let cancelled = false;
	let signalDuringTool = null;
	const controller = new AbortController();
	const result = await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "wait", description: "d", parameters: {},
			async execute(args, context) {
				assert.ok(context && typeof context.remainingMs === "function", "tools must receive a context");
				cancelled = true;
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 900));
				signalDuringTool = context.signal.aborted;
				return { output: "done waiting" };
			},
		}],
		provider, model: "m", maxTokens: 2048,
		signal: controller.signal,
		isCancelled: () => cancelled,
	});
	assert.equal(result.status, "cancelled", "external cancel must end the loop");
	assert.equal(signalDuringTool, true, "context signal must be aborted while the tool is running");
}

async function testLoopBudgetAndTruncation() {
	const loopProvider = createFakeProvider([
		() => JSON.stringify({ action: "tool", tool: "loop", arguments: {} }),
	]);
	let executions = 0;
	const budgeted = await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "loop", description: "d", parameters: {},
			async execute() { executions += 1; return { output: "still running" }; },
		}],
		provider: loopProvider, model: "m", maxTokens: 2048, maxSteps: 4,
	});
	assert.equal(budgeted.status, "budget-exhausted");
	assert.equal(executions, 4);
	assert.match(budgeted.error, /最大轮数/);

	const truncationProvider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "firehose", arguments: {} }),
		JSON.stringify({ action: "final", result: {} }),
	]);
	const truncation = await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "firehose", description: "d", parameters: {},
			async execute() { return { output: "x".repeat(5000), summary: "big" }; },
		}],
		provider: truncationProvider, model: "m", maxTokens: 2048,
		maxToolResultChars: 500,
		maxToolOutputChars: 600,
	});
	assert.equal(truncation.status, "completed");
	const toolResultMessage = truncationProvider.calls[1]
		.find((message) => message.startsWith("user:<tool_result tool=\"firehose\""));
	assert.ok(toolResultMessage, "tool result message missing from transcript");
	assert.ok(toolResultMessage.includes("已截断"));

	const budgetProvider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "f", arguments: {} }),
		JSON.stringify({ action: "tool", tool: "f", arguments: {} }),
		JSON.stringify({ action: "final", result: {} }),
	]);
	await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "f", description: "d", parameters: {},
			async execute() { return { output: "y".repeat(600) }; },
		}],
		provider: budgetProvider, model: "m", maxTokens: 2048,
		maxToolResultChars: 1000,
		maxToolOutputChars: 610,
	});
	const secondResult = budgetProvider.calls[2]
		.find((message) => message.startsWith("user:<tool_result tool=\"f\""));
	assert.ok(secondResult.length <= 1000, `budget floor must cap output, got ${secondResult.length}`);
}

async function testVaultReadAndListScoping() {
	const fake = createFakeVault(new Map([
		["wiki/sources/a.md", "---\ntitle: A\n---\n正文"],
		["papers/demo/article.md", "A".repeat(200)],
		["papers/demo/image.png", "binary"],
		["diary/private.md", "隐私内容"],
	]));
	const readTool = createVaultReadTool({ app: fake }, PAPER_INGEST_READ_PREFIXES);
	const ok = await readTool.execute({ path: "papers/demo/article.md" }, createContext());
	assert.match(ok.output, /共 200 字符/);
	await readTool.execute({ path: "diary/private.md" }, createContext()).then(() => {
		assert.fail("expected out-of-scope read to be rejected");
	}, (error) => {
		assert.match(error.message, /超出读取范围/);
	});
	await readTool.execute({ path: "../etc/passwd" }, createContext()).then(() => {
		assert.fail("expected traversal to be rejected");
	}, (error) => {
		assert.match(error.message, /非法路径/);
	});
	await readTool.execute({ path: "papers/demo/image.png" }, createContext()).then(() => {
		assert.fail("expected binary read to be rejected");
	}, (error) => {
		assert.match(error.message, /只支持文本文件/);
	});

	const listTool = createVaultListTool({ app: fake }, PAPER_INGEST_READ_PREFIXES);
	const listed = await listTool.execute({ folder: "wiki/sources" }, createContext());
	assert.match(listed.output, /wiki\/sources\/a\.md/);
	assert.doesNotMatch(listed.output, /diary/);
	await listTool.execute({ folder: "diary" }, createContext()).then(() => {
		assert.fail("expected out-of-scope listing to be rejected");
	}, (error) => {
		assert.match(error.message, /超出读取范围/);
	});
}

async function testVaultSearchScopeFiltering() {
	const calls = [];
	const retriever = {
		retrieve: async (question, expandedTerms, options) => {
			calls.push(options);
			// The private result would outrank the in-scope one globally.
			return {
				lexical_seeds: question.includes("secret")
					? [
						{ path: "private/secret.md", title: "个人计划", score: 9 },
						{ path: "wiki/sources/a.md", title: "Demo", score: 2 },
					]
					: [{ path: "wiki/sources/a.md", title: "Demo", score: 2 }],
			};
		},
	};
	const tool = createVaultSearchTool(retriever, PAPER_INGEST_READ_PREFIXES);
	const found = await tool.execute({ question: "secret Demo" }, createContext());
	assert.doesNotMatch(found.output, /private\/secret\.md/, "out-of-scope paths must never reach the model");
	assert.match(found.output, /wiki\/sources\/a\.md/);
	assert.equal(calls[0] && calls[0].allowedPrefixes[0], "wiki/sources", "retriever must be asked to scope ranking itself");
	await tool.execute({ question: "" }, createContext()).then(() => {
		assert.fail("expected empty question to be rejected");
	}, (error) => {
		assert.match(error.message, /question/);
	});
}

async function testCrossrefDomainTools() {
	const requests = [];
	const signals = [];
	const deps = {
		httpGetJson: async (url, timeoutMs, options) => {
			requests.push(url);
			signals.push(options && options.signal);
			if (url.includes("query.bibliographic")) {
				return {
					status: 200,
					json: {
						message: {
							items: [{
								DOI: "10.1000/demo",
								title: ["Demo Paper: A Study"],
								author: [{ family: "Wang", given: "J." }],
								issued: { "date-parts": [[2026]] },
								"container-title": ["Journal of Tests"],
							}],
						},
					},
					text: "",
				};
			}
			if (url.includes("10.1000%2Ffound")) {
				return { status: 200, json: { message: { DOI: "10.1000/found", title: ["Found"] } }, text: "" };
			}
			return { status: 404, json: null, text: "" };
		},
	};
	const search = createCrossrefSearchTool(deps);
	const context = createContext();
	const searchResult = await search.execute({ query: "Demo Paper & Special/Chars" }, context);
	const decoded = decodeURIComponent(requests[0]);
	assert.ok(requests[0].startsWith("https://api.crossref.org/works?query.bibliographic="));
	assert.match(decoded, /Demo Paper & Special\/Chars/);
	assert.match(searchResult.output, /10\.1000\/demo/);
	assert.equal(signals[0], context.signal, "crossref requests must carry the run signal");

	const doi = createCrossrefDoiTool(deps);
	const doiResult = await doi.execute({ doi: "https://doi.org/10.1000/found" }, createContext());
	assert.match(doiResult.output, /10\.1000\/found/);
	assert.ok(requests[1].startsWith("https://api.crossref.org/works/10.1000%2Ffound"));
	await doi.execute({ doi: "10.1000/missing" }, createContext()).then(() => {
		assert.fail("expected 404 DOI to be rejected");
	}, (error) => {
		assert.match(error.message, /没有这个 DOI/);
	});
	await doi.execute({ doi: "not-a-doi" }, createContext()).then(() => {
		assert.fail("expected malformed DOI to be rejected");
	}, (error) => {
		assert.match(error.message, /格式不合法/);
	});
}

async function testWebSearchToolValidation() {
	const tool = createWebSearchTool({
		http: { httpRequest: async () => ({ status: 200, json: {} }) },
		apiKey: "tvly-test",
		maxResults: 5,
		timeoutMs: 1000,
	});
	await tool.execute({ queries: [] }, createContext()).then(() => {
		assert.fail("expected empty queries to be rejected");
	}, (error) => {
		assert.match(error.message, /至少一个检索词/);
	});
	const noKey = createWebSearchTool({
		http: { httpRequest: async () => ({ status: 200, json: {} }) },
		apiKey: "",
		maxResults: 5,
		timeoutMs: 1000,
	});
	await noKey.execute({ queries: ["test"] }, createContext()).then(() => {
		assert.fail("expected missing key to be rejected");
	}, (error) => {
		assert.match(error.message, /Tavily API Key/);
	});
}

function testMineruHelperArgValidation() {
	const deps = {
		toolkitRoot: "D:/t",
		mineruExecutable: "m",
		mineruBaseUrl: "",
		pythonExecutable: "p",
		runHelper: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	};
	const missingToolkit = buildMineruHelperArgs({ ...deps, toolkitRoot: "" }, { source: "a.pdf", citekey: "x" });
	assert.match(missingToolkit.error, /工具包目录/);

	const badCitekey = buildMineruHelperArgs(deps, { source: "a.pdf", citekey: "../escape" });
	assert.match(badCitekey.error, /citekey/);

	const badSource = buildMineruHelperArgs(deps, { source: "a.txt", citekey: "ok" });
	assert.match(badSource.error, /PDF/);

	const built = buildMineruHelperArgs(deps, { source: "a.PDF", citekey: "ok_2026", timeoutSeconds: 99999 });
	assert.equal(built.error, undefined);
	assert.ok(built.cliArgs.includes("1800"));
	assert.ok(built.cliArgs.includes("a.PDF"));
}

async function testAuthorizedMineruExtract() {
	const readiness = mineruReadiness({
		toolkitRoot: "", mineruExecutable: "", mineruBaseUrl: "", pythonExecutable: "",
		runHelper: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	});
	assert.equal(readiness.ready, false);

	const runs = [];
	const deps = {
		toolkitRoot: "D:/toolkit",
		mineruExecutable: "mineru-open-api",
		mineruBaseUrl: "https://mineru.example/api",
		pythonExecutable: "D:/python/python.exe",
		runHelper: async (args) => {
			runs.push(args);
			return {
				exitCode: 0,
				stdout: `${JSON.stringify({ status: "published", package: "D:\\vault\\papers\\demo_2026", validation: { ok: true } })}\n`,
				stderr: "",
			};
		},
	};
	const receipt = await runAuthorizedMineruExtract(
		deps,
		{
			// The authorized PDF is bound by the caller (plugin), never by the model.
			source: "D:/raw/paper.pdf",
			citekey: "demo_2026",
			formula: false,
			includeSourcePdf: true,
		},
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	);
	assert.match(receipt.packagePath, /D:\/vault\/papers\/demo_2026$/);
	assert.equal(runs.length, 1);
	assert.ok(runs[0].cliArgs.includes("D:/raw/paper.pdf"));
	assert.ok(runs[0].cliArgs.includes("--no-formula"));
	assert.ok(runs[0].cliArgs.includes("--base-url"));

	const failing = await runAuthorizedMineruExtract(
		{ ...deps, runHelper: async () => ({ exitCode: 2, stdout: "", stderr: "MinerU upstream 500" }) },
		{ source: "D:/raw/paper.pdf", citekey: "demo_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.ok(failing instanceof Error);
	assert.match(failing.message, /MinerU 提取失败/);

	const controller = new AbortController();
	controller.abort();
	const aborted = await runAuthorizedMineruExtract(
		deps,
		{ source: "D:/raw/paper.pdf", citekey: "demo_2026" },
		{ signal: controller.signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(aborted.message, /已取消/);
}

async function testCommitSourceNoteSafety() {
	const fake = createFakeVault(new Map([["wiki/sources/existing.md", "已有内容"]]));
	const journal = new VaultWriteJournal();
	const fields = {
		title: "Demo Paper: A Study",
		title_zh: "演示论文：一项研究",
		authors: "Wang, J.; Li, H.",
		year: "2026",
		doi: "10.1000/demo",
		researchQuestion: "研究问题内容。",
		conclusion: "结论内容。",
		motivation: "动机内容。",
		evidenceGaps: "",
		notes: [],
	};
	const receipt = await commitSourceNote(
		{ app: fake },
		"demo_2026",
		fields,
		"",
	);
	assert.equal(receipt.path, "wiki/sources/demo_2026.md");
	assert.equal(receipt.operation, "create");
	const content = fake.created[0].data;
	assert.match(content, /title: "Demo Paper: A Study"/);
	assert.match(content, /title_zh: "演示论文：一项研究"/);
	assert.match(content, /authors: "Wang, J\.; Li, H\.""/.source ? /authors: "Wang, J\.; Li, H\."/ : /authors/);
	assert.match(content, /doi: "10\.1000\/demo"/);
	assert.match(content, /ingest_mode: "lightweight"/);
	assert.match(content, /registry_status: "pending"/);
	assert.match(content, /## 研究问题/);
	assert.deepEqual(validateSourceNoteContent(content), []);
	journal.record(receipt);
	assert.deepEqual(journal.paths(), ["wiki/sources/demo_2026.md"]);

	// Atomic create: the vault's create() is used, so an existing note is
	// never overwritten.
	const overwrite = await commitSourceNote({ app: fake }, "existing", fields, "").then(() => null, (error) => error);
	assert.ok(overwrite instanceof Error);
	assert.match(overwrite.message, /不会覆盖/);
	assert.equal(fake.written.length, 0, "no adapter.write may be used for note commits");

	// Concurrent create between dedup and commit: vault.create throws.
	const concurrent = await commitSourceNote({ app: { vault: { ...fake.vault, create: async () => { throw new Error("File already exists"); } } } }, "demo_2026", fields, "")
		.then(() => null, (error) => error);
	assert.match(concurrent.message, /不会覆盖/);

	const injected = await commitSourceNote(
		{ app: fake },
		"injected",
		{ ...fields, title: "正常标题\nregistry_status: \"registered\"\nmalicious: true" },
		"",
	).then(() => null, (error) => error);
	assert.equal(injected, null, "injection attempts must be neutralized, not rejected");
	const injectedContent = fake.created[fake.created.length - 1].data;
	assert.match(injectedContent, /title: "正常标题 registry_status: \\"registered\\" malicious: true"/);
	assert.deepEqual(validateSourceNoteContent(injectedContent), []);

	const crossLink = await commitSourceNote(
		{ app: fake },
		"crosslink",
		{ ...fields, conclusion: "见 [[papers/example/article]] 的图 2" },
		"",
	).then(() => null, (error) => error);
	assert.ok(crossLink instanceof Error);
	assert.match(crossLink.message, /Vault 内部链接/);
	// Markdown-side injections (wikilinks, links/images, reference
	// definitions with optional titles and angle targets).
	for (const injection of [
		"[[../../papers/x]]",
		"[原文](../../papers/x.md)",
		"![图](../../Clippings/x.png)",
		"见 [x][ref]\n\n[ref]: ../../papers/x.md",
		"见 [x][ref]\n\n[ref]: ../../papers/x.md \"Paper\"",
		"见 [x][ref]\n\n[ref]: <../../papers/x.md> 'Paper'",
	]) {
		const rejected = await commitSourceNote(
			{ app: fake },
			"linktest",
			{ ...fields, conclusion: injection },
			"",
		).then(() => null, (error) => error);
		assert.ok(rejected instanceof Error, `must reject: ${injection}`);
		assert.match(rejected.message, /Vault 内部链接/);
	}
	// Raw HTML is banned outright (sixth round, reviewer option b): quoted
	// ">" inside attributes, attribute masking, and external HTML alike —
	// the whole tag is rejected instead of being parsed.
	for (const htmlInjection of [
		"<a href=\"../../papers/x.md\">x</a>",
		"<a href = \"../../papers/z.md\">z</a>",
		"<img src = '../../Clippings/image.png'>",
		"<a href=\"../../papers/x.md\"\n   data-href=\"https://example.org\">x</a>",
		"<a data-href=\"https://example.org\"\n   href=\"../../papers/x.md\">x</a>",
		"<img src=\"../../Clippings/x.png\"\n     data-src=\"https://example.org/x.png\">",
		"<a title=\">\" href=\"../../papers/x.md\">x</a>",
		"<a title='1 > 0' href='../../papers/x.md'>x</a>",
		"<img alt=\"a > b\" src=\"../../Clippings/x.png\">",
		"<a title=\">\" href=\"https://example.org\">x</a>",
		"<div data-href=\"../../papers/x.md\">metadata only</div>",
	]) {
		const rejected = await commitSourceNote(
			{ app: fake },
			"htmltest",
			{ ...fields, conclusion: htmlInjection },
			"",
		).then(() => null, (error) => error);
		assert.ok(rejected instanceof Error, `must reject raw HTML: ${htmlInjection}`);
		assert.match(rejected.message, /原始 HTML/);
	}
	// External links stay allowed as Markdown; math prose and autolinks
	// must not trip the raw-HTML detector.
	const external = validateSourceNoteContent(
		"---\ntitle: \"t\"\ntitle_zh: \"\"\ncitekey: \"x\"\ntype: \"source\"\ndepth: \"abstract-level\"\ningest_mode: \"lightweight\"\nregistry_status: \"pending\"\n---\n\n## 研究问题\n[官网](https://example.org)。\n\n[网站][ref]\n\n[ref]: https://example.org \"Example\"\n\n[本页章节](#结果)。\n\n使用 <p、q> 记号，且 E<mc² 近似成立；自动链接 <https://example.org> 也可用。",
	);
	assert.deepEqual(external, []);

	const badCitekey = await commitSourceNote({ app: fake }, "../evil", fields, "").then(() => null, (error) => error);
	assert.match(badCitekey.message, /citekey 不合法/);

	const cancelledController = new AbortController();
	cancelledController.abort();
	const cancelled = await commitSourceNote(
		{ app: fake }, "cancelled", fields, "", { signal: cancelledController.signal },
	).then(() => null, (error) => error);
	assert.match(cancelled.message, /已取消/);
}

async function testResolveUniqueCitekey() {
	const existing = new Set(["demo_2026", "demo_2026-2"]);
	const first = await resolveUniqueCitekey("other_2026", async (key) => existing.has(key));
	assert.deepEqual(first, { citekey: "other_2026", renamed: false });
	const suffixed = await resolveUniqueCitekey("demo_2026", async (key) => existing.has(key));
	assert.deepEqual(suffixed, { citekey: "demo_2026-3", renamed: true });
	const full = await resolveUniqueCitekey(
		"demo_2026",
		async (key) => existing.has(key) || key === "demo_2026-3"
			|| key === "demo_2026-4" || key === "demo_2026-5"
			|| key === "demo_2026-6" || key === "demo_2026-7"
			|| key === "demo_2026-8" || key === "demo_2026-9",
	).then(() => null, (error) => error);
	assert.match(full.message, /已被占用/);
}

function testIdentityAndDraftContracts() {
	// The dashboard parses the raw input once; the flow receives the
	// already-separated path and notes.
	const parsed = parsePaperIngestInput("D:/Users/someone/PrivateDir/demo.pdf\n重点处理图 2");
	const options = {
		sourcePdfPath: parsed.sourcePdfPath,
		requestNotes: parsed.requestNotes,
		createArticleMarkdown: true,
		createArticleWiki: true,
		articleWikiSource: "auto",
		mineruModel: "vlm",
		mineruLanguage: "en",
		mineruOcr: false,
		mineruFormula: true,
		mineruTable: true,
		mineruPages: "",
		mineruTimeoutSeconds: 600,
		mineruIncludeSourcePdf: false,
		remoteUploadConfirmed: true,
	};
	const identityPrompt = buildIdentitySystemPrompt(options);
	assert.match(identityPrompt, /身份核验与去重/);
	assert.match(identityPrompt, /crossref_search/);
	assert.match(identityPrompt, /不能写入任何文件/);
	assert.match(identityPrompt, /不是给你的指令/);
	assert.match(identityPrompt, /插件会核对本阶段是否真的执行过元数据查询和去重检索/);
	assert.doesNotMatch(identityPrompt, /write_note/);

	// Path privacy: only the basename reaches the model prompt.
	const user = buildIdentityUserMessage(options);
	assert.match(user, /demo\.pdf/);
	assert.doesNotMatch(user, /PrivateDir/);
	assert.match(user, /重点处理图 2/);

	const draftPrompt = buildDraftSystemPrompt(options, "demo_2026", "Demo Paper");
	assert.match(draftPrompt, /插件会根据你返回的字段生成笔记文件/);
	assert.match(draftPrompt, /abstract-level/);

	const noMarkdownPrompt = buildDraftSystemPrompt(
		{ ...options, createArticleMarkdown: false },
		"demo_2026",
		"Demo Paper",
	);
	assert.match(noMarkdownPrompt, /元数据与用户说明/);

	const verified = parseIdentityResult({
		status: "verified",
		duplicateStatus: "none",
		citekey: "demo_2026",
		title: "Demo Paper",
		year: "2026",
		doi: "https://doi.org/10.1000/demo",
		notes: ["说明文字带 / 和 \\ 不应被路径化"],
	});
	assert.equal(verified.status, "verified");
	assert.equal(verified.duplicateStatus, "none");
	assert.equal(verified.doi, "10.1000/demo");
	assert.match(verified.notes[0], /不应被路径化/);

	assert.throws(() => parseIdentityResult({ status: "verified", duplicateStatus: "none", citekey: "bad citekey!" }), /citekey 不合法/);
	assert.throws(() => parseIdentityResult({ status: "verified", duplicateStatus: "none", citekey: "ok_2026", title: "" }), /原文标题/);
	assert.throws(() => parseIdentityResult({ status: "verified", duplicateStatus: "none", citekey: "ok_2026", title: "Demo Paper", year: "20X6" }), /四位数字/);
	assert.equal(parseIdentityResult({ status: "verified", citekey: "ok_2026", title: "Demo Paper" }), null, "duplicateStatus is required for verified identities");
	const conflict = parseIdentityResult({ status: "conflict", duplicateStatus: "possible", conflicts: ["DOI 与标题不一致"], citekey: "" });
	assert.equal(conflict.status, "conflict");
	assert.equal(parseIdentityResult({ status: "nonsense" }), null);
	assert.equal(parseIdentityResult(null), null);

	const draft = parseNoteDraft({
		status: "completed",
		title: "Demo Paper",
		title_zh: "演示论文",
		research_question: "研究问题",
		conclusion: "结论",
		motivation: "动机",
		evidence_gaps: "缺口",
	});
	assert.equal(draft.title_zh, "演示论文");
	assert.equal(draft.researchQuestion, "研究问题");
	assert.equal(draft.evidenceGaps, "缺口");
	const longSection = "x".repeat(9000);
	assert.equal(parseNoteDraft({ status: "completed", conclusion: longSection }).conclusion.length, 6000);
}

function testIdentityReceiptGate() {
	const identity = {
		status: "verified",
		duplicateStatus: "none",
		citekey: "demo_2026",
		title: "Demo Paper",
		title_zh: "",
		authors: "",
		year: "2026",
		doi: "10.1000/demo",
		duplicates: [],
		conflicts: [],
		notes: [],
	};
	// First-round "verified" without any tool work must be rejected.
	assert.match(
		validateIdentityReceipts(identity, [])[0],
		/元数据查询/,
	);
	const missingDedup = validateIdentityReceipts(identity, [
		{ tool: "crossref_search", ok: true, argsSummary: "query=demo" },
	]);
	assert.equal(missingDedup.length, 2, "missing dedup lookup AND unverified DOI must both be rejected");
	assert.match(missingDedup[0], /去重检索/);
	assert.match(missingDedup[1], /crossref_doi/);
	assert.deepEqual(
		validateIdentityReceipts(identity, [
			{ tool: "crossref_search", ok: true, argsSummary: "query=demo" },
			{ tool: "vault_search", ok: true, argsSummary: "question=demo" },
			{ tool: "crossref_doi", ok: true, argsSummary: "doi=https://doi.org/10.1000/DEMO · " },
		]),
		[],
		"full receipts must pass (doi.org prefix and casing normalized)",
	);
}

function testDraftGateAndStatusSemantics() {
	const options = {
		sourcePdfPath: "a.pdf",
		requestNotes: "",
		createArticleMarkdown: true,
		createArticleWiki: true,
		articleWikiSource: "article",
		mineruModel: "vlm",
		mineruLanguage: "en",
		mineruOcr: false,
		mineruFormula: true,
		mineruTable: true,
		mineruPages: "",
		mineruTimeoutSeconds: 600,
		mineruIncludeSourcePdf: false,
		remoteUploadConfirmed: true,
	};
	// Strict article mode without a verified package must not draft.
	const blocked = evaluateDraftPhase(options, "", false);
	assert.equal(blocked.run, false);
	assert.match(blocked.blocker, /已有 article\.md/);
	const allowed = evaluateDraftPhase(options, "papers/x/article.md", false);
	assert.equal(allowed.run, true);
	const downgraded = evaluateDraftPhase({ ...options, articleWikiSource: "auto" }, "", false);
	assert.equal(downgraded.run, true);
	assert.match(downgraded.downgradeNote, /元数据与用户说明/);

	// Technical errors are "failed", never dressed up as conflicts — even
	// when a conflict blocker exists alongside them.
	assert.equal(
		computeIngestOutcomeStatus({
			cancelled: false, conflicts: [], errors: ["Provider timeout"],
			identityConflict: false, markdownSatisfied: true, wikiSatisfied: true,
		}),
		"failed",
	);
	assert.equal(
		computeIngestOutcomeStatus({
			cancelled: false, conflicts: ["article 模式缺少包"], errors: ["MinerU upstream 500"],
			identityConflict: false, markdownSatisfied: false, wikiSatisfied: false,
		}),
		"failed",
		"technical errors take precedence over conflict labels",
	);
	assert.equal(
		computeIngestOutcomeStatus({
			cancelled: false, conflicts: ["疑似重复"], errors: [],
			identityConflict: false, markdownSatisfied: true, wikiSatisfied: true,
		}),
		"conflict",
	);
	assert.equal(
		computeIngestOutcomeStatus({
			cancelled: false, conflicts: [], errors: [],
			identityConflict: false, markdownSatisfied: false, wikiSatisfied: true,
		}),
		"failed",
	);
	assert.equal(
		computeIngestOutcomeStatus({
			cancelled: false, conflicts: [], errors: [],
			identityConflict: false, markdownSatisfied: true, wikiSatisfied: true,
		}),
		"completed",
	);
	assert.equal(
		computeIngestOutcomeStatus({
			cancelled: true, conflicts: [], errors: [],
			identityConflict: false, markdownSatisfied: true, wikiSatisfied: true,
		}),
		"failed",
	);
}

function testPhaseToolsetsAreRead() {
	const fake = createFakeVault(new Map([]));
	const deps = {
		vault: { app: fake },
		http: { httpGetJson: async () => ({ status: 200, json: null, text: "" }) },
		mineru: {
			toolkitRoot: "D:/t", mineruExecutable: "m", mineruBaseUrl: "", pythonExecutable: "p",
			runHelper: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
		},
		tavily: {
			http: { httpRequest: async () => ({ status: 200, json: {} }) },
			apiKey: "tvly-x",
			maxResults: 5,
			timeoutMs: 1000,
		},
		lexicalRetriever: { retrieve: async () => ({ lexical_seeds: [] }) },
	};
	const identityNames = buildIdentityTools(deps).map((tool) => tool.name);
	assert.deepEqual(identityNames.filter((name) => name === "mineru_extract" || name === "write_note"), []);
	assert.ok(identityNames.includes("crossref_search"));
	assert.ok(identityNames.includes("vault_search"));

	const draftNames = buildDraftTools(deps).map((tool) => tool.name);
	assert.deepEqual(draftNames.filter((name) => name === "mineru_extract" || name === "write_note"), []);
	assert.deepEqual(draftNames.filter((name) => name === "crossref_search"), []);
}

async function testArticleHeadTitleGate() {
	const fake = createFakeVault(new Map([
		["papers/demo/article.md", "# Novae: A Graph-Based Foundation Model for Spatial Transcriptomics\n\nIntroduction"],
		["papers/other/article.md", "# Completely Different Title Here\n\nBody"],
	]));
	assert.equal(
		await articleHeadContainsTitle({ app: fake }, "papers/demo/article.md", "Novae: A Graph-Based Foundation Model for Spatial Transcriptomics"),
		true,
	);
	assert.equal(
		await articleHeadContainsTitle({ app: fake }, "papers/other/article.md", "Novae: A Graph-Based Foundation Model for Spatial Transcriptomics"),
		false,
	);
	// Empty/short titles fail the gate instead of passing it.
	assert.equal(await articleHeadContainsTitle({ app: fake }, "papers/other/article.md", "Tiny"), false);
	assert.equal(await articleHeadContainsTitle({ app: fake }, "papers/other/article.md", ""), false);
	assert.equal(await articleHeadContainsTitle({ app: fake }, "papers/none/article.md", "Anything At All Here"), false);
}

function testYamlScalarSafety() {
	assert.equal(yamlSafeScalar("plain"), "\"plain\"");
	assert.equal(yamlSafeScalar("a\nb: c"), "\"a b: c\"");
	assert.equal(yamlSafeScalar("单引号'与\"双引号"), "\"单引号'与\\\"双引号\"");
	assert.doesNotMatch(yamlSafeScalar("标题\n---"), /真实换行|标题\n/);
}

async function testArticlePathBinding() {
	// Published inside the vault (knowledge-base layout) → accepted.
	const vaultRoot = "D:/Obsidian Vault/DemoVault";
	const inside = deriveArticleVaultPath(
		"D:/Obsidian Vault/DemoVault/papers/demo_2026",
		vaultRoot,
	);
	assert.equal(inside, "papers/demo_2026/article.md");

	const nested = deriveArticleVaultPath(
		"D:/Obsidian Vault/DemoVault/knowledge-base/papers/demo_2026",
		`${vaultRoot}/knowledge-base`,
	);
	assert.equal(nested, "papers/demo_2026/article.md");

	// Windows native separators and case differences fold on win32 only.
	const winNative = deriveArticleVaultPath(
		"D:\\Obsidian Vault\\DemoVault\\knowledge-base\\papers\\demo_2026",
		"d:/obsidian vault/demovault/knowledge-base",
		"win32",
	);
	assert.equal(winNative, "papers/demo_2026/article.md");
	// On POSIX, differing case is a different directory.
	const posixCase = deriveArticleVaultPath(
		"/home/user/Toolkit/papers/demo_2026",
		"/home/user/toolkit",
		"linux",
	);
	assert.equal(posixCase, "");

	// Published in a different toolkit → never claimed as this run's receipt.
	const outside = deriveArticleVaultPath(
		"D:/ResearchToolkit/knowledge-base/papers/demo_2026",
		vaultRoot,
	);
	assert.equal(outside, "");

	// A stale same-citekey package in the vault cannot be claimed either —
	// the path must come from the published location.
	const vault = createFakeVault(new Map([["papers/demo_2026/article.md", "# 旧包"]]));
	const claimed = await resolveArticleVaultPath(
		{ app: vault },
		"D:/ResearchToolkit/knowledge-base/papers/demo_2026",
		vaultRoot,
	);
	assert.equal(claimed, "", "stale same-citekey vault files must not be claimed");

	const resolvedInside = await resolveArticleVaultPath(
		{ app: vault },
		"D:/Obsidian Vault/DemoVault/papers/demo_2026",
		vaultRoot,
	);
	assert.equal(resolvedInside, "papers/demo_2026/article.md");
}

function testParsePaperIngestInput() {
	// Quoted Windows paths (very common when pasting from Explorer).
	const doubleQuoted = parsePaperIngestInput("\"D:\\Research Papers\\demo.pdf\"\n重点检查图 2");
	assert.equal(doubleQuoted.sourcePdfPath, "D:\\Research Papers\\demo.pdf");
	assert.equal(doubleQuoted.requestNotes, "重点检查图 2");
	assert.equal(parsePaperIngestInput("'D:\\x\\y.pdf'").sourcePdfPath, "D:\\x\\y.pdf");
	assert.equal(parsePaperIngestInput("`D:\\x\\y.pdf`").sourcePdfPath, "D:\\x\\y.pdf");
	const posix = parsePaperIngestInput("/home/user/Research Papers/demo.pdf\n备注");
	assert.equal(posix.sourcePdfPath, "/home/user/Research Papers/demo.pdf");
	assert.equal(posix.requestNotes, "备注");
	const fileUrl = parsePaperIngestInput("file:///D:/Research%20Papers/demo.pdf\n说明");
	// fileURLToPath is platform-dependent (D:\... on Windows, /D:/... on
	// POSIX); the invariant is decoding + a .pdf path lands in sourcePdfPath.
	const expectedFileUrlPath = require("node:url").fileURLToPath("file:///D:/Research%20Papers/demo.pdf");
	assert.equal(fileUrl.sourcePdfPath, expectedFileUrlPath);
	assert.match(fileUrl.sourcePdfPath, /demo\.pdf$/);
	assert.equal(fileUrl.requestNotes, "说明");
	// A first line that is not a path leaves the whole input as notes.
	const notes = parsePaperIngestInput("帮我入库一篇关于单细胞测序的论文");
	assert.equal(notes.sourcePdfPath, "");
	assert.match(notes.requestNotes, /单细胞测序/);
	// Unquoted round-trip keeps working.
	const plain = parsePaperIngestInput("D:\\raw\\demo.pdf\n重点处理图 2");
	assert.equal(plain.sourcePdfPath, "D:\\raw\\demo.pdf");
	assert.equal(plain.requestNotes, "重点处理图 2");
	assert.equal(stripMatchingQuotes("  \"a\"  "), "a");
}

function testArtifactsPersistenceRoundTrip() {
	const stored = [{
		id: "run-1",
		actionId: "paper-ingest",
		label: "文献入库",
		agent: "light-agent",
		summary: "s",
		executionConfig: null,
		status: "done",
		startedAt: "2026-08-30T00:00:00Z",
		finishedAt: "2026-08-30T00:01:00Z",
		exitCode: 0,
		output: "trace",
		error: "",
		artifacts: {
			articlePath: "papers\\demo_2026\\article.md",
			wikiPath: "wiki/sources/demo_2026.md",
			filesWritten: ["wiki/sources/demo_2026.md", "papers\\demo\\article.md"],
		},
	}];
	// Full snapshot round-trip: JSON serialize/deserialize, then normalize.
	const serialized = JSON.parse(JSON.stringify(stored));
	const restored = normalizeStoredTaskRuns(serialized);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].artifacts.articlePath, "papers/demo_2026/article.md");
	assert.equal(restored[0].artifacts.wikiPath, "wiki/sources/demo_2026.md");
	assert.deepEqual(restored[0].artifacts.filesWritten, [
		"wiki/sources/demo_2026.md",
		"papers/demo/article.md",
	]);

	// Malicious or absolute artifacts are dropped on load.
	const hostile = normalizeTaskRunArtifacts({
		articlePath: "C:\\evil\\article.md",
		wikiPath: "wiki/../../evil.md",
		filesWritten: ["papers/../secrets.md", "/abs/path.md", "ok.md"],
	});
	assert.equal(hostile.articlePath, "");
	assert.equal(hostile.wikiPath, "");
	assert.deepEqual(hostile.filesWritten, ["ok.md"]);
	assert.equal(normalizeTaskRunArtifacts({}), undefined);
}

function testRealpathVaultAlignment() {
	const os = require("node:os");
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-vault-"));
	const toolkitRoot = path.join(base, "toolkit");
	const knowledgeBase = path.join(toolkitRoot, "knowledge-base");
	fs.mkdirSync(knowledgeBase, { recursive: true });
	try {
		// Vault = toolkitRoot/knowledge-base (the only supported layout).
		assert.equal(isSameRealPath(knowledgeBase, path.join(toolkitRoot, "knowledge-base")), true);
		// Windows-style trailing separators must not break the comparison;
		// on POSIX a backslash is an ordinary filename character, so only the
		// platform-native separator variant is asserted there.
		if (process.platform === "win32") {
			assert.equal(isSameRealPath(`${knowledgeBase}\\`, path.join(toolkitRoot, "knowledge-base")), true);
		} else {
			assert.equal(isSameRealPath(`${knowledgeBase}/`, path.join(toolkitRoot, "knowledge-base")), true);
		}
		// Vault = toolkitRoot itself must be rejected.
		assert.equal(isSameRealPath(toolkitRoot, path.join(toolkitRoot, "knowledge-base")), false);
		// Unrelated directories are rejected.
		assert.equal(isSameRealPath(base, knowledgeBase), false);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
}

(async () => {
	testExtractFirstJsonObject();
	await testLoopToolRoundtripAndReceipts();
	await testLoopRepairsNonConsecutiveProtocolErrors();
	await testLoopCancellationAbortsSignalDuringTools();
	await testLoopBudgetAndTruncation();
	await testVaultReadAndListScoping();
	await testVaultSearchScopeFiltering();
	await testCrossrefDomainTools();
	await testWebSearchToolValidation();
	testMineruHelperArgValidation();
	await testAuthorizedMineruExtract();
	await testCommitSourceNoteSafety();
	await testArticlePathBinding();
	await testResolveUniqueCitekey();
	testIdentityAndDraftContracts();
	testIdentityReceiptGate();
	testDraftGateAndStatusSemantics();
	testPhaseToolsetsAreRead();
	await testArticleHeadTitleGate();
	testYamlScalarSafety();
	testParsePaperIngestInput();
	testArtifactsPersistenceRoundTrip();
	testRealpathVaultAlignment();
	console.log("AGENT_LOOP_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
