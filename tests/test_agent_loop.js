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
			"  resolveArticleVaultPath,",
			"  PAPER_INGEST_READ_PREFIXES,",
			'} from "./src/agent/paper-ingest-flow";',
			"export { articleHeadContainsTitle } from './src/agent/agent-loop-service';",
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
	VaultWriteJournal,
	buildIdentitySystemPrompt,
	buildIdentityUserMessage,
	buildDraftSystemPrompt,
	buildDraftTools,
	buildIdentityTools,
	parseIdentityResult,
	parseNoteDraft,
	resolveArticleVaultPath,
	PAPER_INGEST_READ_PREFIXES,
	articleHeadContainsTitle,
} = hookModule.exports;
Module._load = originalLoad;

const createContext = () => ({
	signal: new AbortController().signal,
	deadline: Date.now() + 600000,
	remainingMs: () => 600000,
});

function createFakeVault(files) {
	const written = [];
	const adapter = {
		exists: async (target) => {
			const normalized = String(target).replace(/\\/g, "/");
			if (files.has(normalized)) return true;
			for (const key of files.keys()) {
				if (key.startsWith(`${normalized}/`)) return true;
			}
			return written.some((entry) => entry.path === normalized);
		},
		write: async (target, data) => {
			written.push({ path: String(target), data: String(data) });
		},
		mkdir: async () => {},
	};
	const toStubFile = (filePath) => {
		const extension = filePath.split(".").pop() || "";
		return Object.assign(new ObsidianTFile(), { path: filePath, extension });
	};
	return {
		written,
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

async function testLoopToolRoundtrip() {
	const toolCalls = [];
	const tools = [{
		name: "echo",
		description: "echoes input",
		parameters: { value: "任意字符串" },
		required: ["value"],
		async execute(args) {
			toolCalls.push(args);
			return { output: `echo:${args.value}`, summary: "echoed" };
		},
	}];
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "echo", arguments: { value: "hi" } }),
		JSON.stringify({ action: "final", result: { ok: true, value: "hi" } }),
	]);
	const steps = [];
	const result = await runBoundedAgentLoop({
		system: "测试系统提示",
		user: "开始任务",
		tools,
		provider,
		model: "test-model",
		maxTokens: 4096,
		onStep: (step) => steps.push(step.kind),
	});
	assert.equal(result.status, "completed");
	assert.equal(result.final.ok, true);
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0].value, "hi");
	assert.deepEqual(steps, ["tool", "final"]);
	assert.match(result.trace, /调用 echo/);
	assert.match(result.trace, /echo → echoed/);
	assert.match(provider.calls[0][0], /工具循环协议/);
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

async function testLoopUnknownToolAndBudget() {
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "nope", arguments: {} }),
		JSON.stringify({ action: "final", result: { recovered: true } }),
	]);
	const result = await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "real", description: "d", parameters: {},
			async execute() { return { output: "ok" }; },
		}],
		provider, model: "m", maxTokens: 2048,
	});
	assert.equal(result.status, "completed");
	assert.match(result.trace, /未知工具 nope/);

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
}

async function testLoopCancellationAndTruncation() {
	let cancelled = false;
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "wait", arguments: {} }),
		JSON.stringify({ action: "final", result: {} }),
	]);
	const result = await runBoundedAgentLoop({
		system: "s", user: "u",
		tools: [{
			name: "wait", description: "d", parameters: {},
			async execute(args, context) {
				assert.ok(context && typeof context.remainingMs === "function", "tools must receive a context");
				cancelled = true;
				return { output: "done waiting" };
			},
		}],
		provider, model: "m", maxTokens: 2048,
		isCancelled: () => cancelled,
	});
	assert.equal(result.status, "cancelled");

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

	// Hard budget: with only 10 chars left, at most 10 chars may pass through.
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

async function testVaultSearchTool() {
	const retriever = {
		retrieve: async (question) => ({
			lexical_seeds: question.includes("Existing")
				? [{ path: "wiki/sources/existing.md", title: "Existing", score: 3 }]
				: [],
		}),
	};
	const tool = createVaultSearchTool(retriever);
	const found = await tool.execute({ question: "Existing related" }, createContext());
	assert.match(found.output, /wiki\/sources\/existing\.md/);
	const empty = await tool.execute({ question: "nothing" }, createContext());
	assert.match(empty.output, /没有找到/);
	await tool.execute({ question: "" }, createContext()).then(() => {
		assert.fail("expected empty question to be rejected");
	}, (error) => {
		assert.match(error.message, /question/);
	});
}

async function testCrossrefDomainTools() {
	const requests = [];
	const deps = {
		httpGetJson: async (url) => {
			requests.push(url);
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
	const searchResult = await search.execute({ query: "Demo Paper & Special/Chars" }, createContext());
	const decoded = decodeURIComponent(requests[0]);
	assert.ok(requests[0].startsWith("https://api.crossref.org/works?query.bibliographic="));
	assert.match(decoded, /Demo Paper & Special\/Chars/);
	assert.match(searchResult.output, /10\.1000\/demo/);
	assert.match(searchResult.output, /Journal of Tests/);

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

async function testCommitSourceNoteCreateOnly() {
	const fake = createFakeVault(new Map([["wiki/sources/existing.md", "已有内容"]]));
	const journal = new VaultWriteJournal();
	const fields = {
		title: "Demo Paper: A Study",
		title_zh: "演示论文：一项研究",
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
		"ingest_mode: lightweight\nregistry_status: pending",
	);
	assert.equal(receipt.path, "wiki/sources/demo_2026.md");
	assert.equal(receipt.operation, "create");
	assert.match(fake.written[0].data, /title_zh: 演示论文：一项研究/);
	assert.match(fake.written[0].data, /ingest_mode: lightweight/);
	assert.match(fake.written[0].data, /## 研究问题/);
	journal.record(receipt);
	assert.deepEqual(journal.paths(), ["wiki/sources/demo_2026.md"]);

	// Create-only: an existing note must never be overwritten.
	const overwrite = await commitSourceNote({ app: fake }, "existing", fields, "").then(() => null, (error) => error);
	assert.ok(overwrite instanceof Error);
	assert.match(overwrite.message, /不会覆盖/);
	assert.equal(fake.written.length, 1);

	const badCitekey = await commitSourceNote({ app: fake }, "../evil", fields, "").then(() => null, (error) => error);
	assert.match(badCitekey.message, /citekey 不合法/);
}

async function testResolveArticleVaultPathLayouts() {
	const rootLayout = createFakeVault(new Map([["papers/x/article.md", "# T"]]));
	assert.equal(await resolveArticleVaultPath({ app: rootLayout }, "x"), "papers/x/article.md");
	const nestedLayout = createFakeVault(new Map([["knowledge-base/papers/x/article.md", "# T"]]));
	assert.equal(
		await resolveArticleVaultPath({ app: nestedLayout }, "x"),
		"knowledge-base/papers/x/article.md",
	);
	const missing = createFakeVault(new Map([]));
	assert.equal(await resolveArticleVaultPath({ app: missing }, "x"), "");
}

function testIdentityAndDraftContracts() {
	const options = {
		sourcePdfPath: "D:/raw/demo.pdf",
		requestNotes: "重点处理图 2",
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
	assert.doesNotMatch(identityPrompt, /write_note/);

	const user = buildIdentityUserMessage(options);
	assert.match(user, /D:\/raw\/demo\.pdf/);
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
		citekey: "demo_2026",
		title: "Demo Paper",
		doi: "https://doi.org/10.1000/demo",
		notes: ["PDF 正文未读取；说明文字带 / 和 \\ 不应被路径化"],
	});
	assert.equal(verified.status, "verified");
	assert.equal(verified.doi, "10.1000/demo");
	assert.match(verified.notes[0], /不应被路径化/);

	assert.throws(() => parseIdentityResult({ status: "verified", citekey: "bad citekey!" }), /citekey 不合法/);
	const conflict = parseIdentityResult({ status: "conflict", conflicts: ["DOI 与标题不一致"], citekey: "" });
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
	// Very short titles skip the heuristic gate.
	assert.equal(await articleHeadContainsTitle({ app: fake }, "papers/other/article.md", "Tiny"), true);
	assert.equal(await articleHeadContainsTitle({ app: fake }, "papers/none/article.md", "Anything At All"), false);
}

(async () => {
	testExtractFirstJsonObject();
	await testLoopToolRoundtrip();
	await testLoopRepairsNonConsecutiveProtocolErrors();
	await testLoopUnknownToolAndBudget();
	await testLoopCancellationAndTruncation();
	await testVaultReadAndListScoping();
	await testVaultSearchTool();
	await testCrossrefDomainTools();
	await testWebSearchToolValidation();
	testMineruHelperArgValidation();
	await testAuthorizedMineruExtract();
	await testCommitSourceNoteCreateOnly();
	await testResolveArticleVaultPathLayouts();
	testIdentityAndDraftContracts();
	testPhaseToolsetsAreRead();
	await testArticleHeadTitleGate();
	console.log("AGENT_LOOP_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
