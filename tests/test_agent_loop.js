"use strict";

const assert = require("node:assert/strict");
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
	normalizePath: (value) => value,
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
			"  createVaultSearchTool,",
			"  createVaultReadTool,",
			"  createVaultListTool,",
			"  createHttpJsonTool,",
			"  createMineruExtractTool,",
			"  createWriteNoteTool,",
			"  createWebSearchTool,",
			"  buildMineruHelperArgs,",
			"  VaultWriteJournal,",
			'} from "./src/agent/tools";',
			"export {",
			"  buildPaperIngestSystemPrompt,",
			"  buildPaperIngestUserMessage,",
			"  buildPaperIngestTools,",
			"  parsePaperIngestFinalResult,",
			"  PAPER_INGEST_ALLOWED_HOSTS,",
			"  PAPER_INGEST_WRITE_SCOPE,",
			'} from "./src/agent/paper-ingest-flow";',
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
	renderToolCatalog,
	createVaultReadTool,
	createVaultListTool,
	createHttpJsonTool,
	createMineruExtractTool,
	createWriteNoteTool,
	createWebSearchTool,
	buildMineruHelperArgs,
	VaultWriteJournal,
	buildPaperIngestSystemPrompt,
	buildPaperIngestUserMessage,
	buildPaperIngestTools,
	parsePaperIngestFinalResult,
	PAPER_INGEST_ALLOWED_HOSTS,
	PAPER_INGEST_WRITE_SCOPE,
} = hookModule.exports;
Module._load = originalLoad;

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
			read: async (file) => files.get(file.path) ?? "",
			adapter,
		},
	};
}

function createFakeProvider(turns) {
	let call = 0;
	const calls = [];
	return {
		calls,
		async complete(request) {
			calls.push(request.messages.map((message) => `${message.role}:${String(message.content).slice(0, 2000)}`));
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
		onStep: (step) => steps.push(step.kind),
	});
	assert.equal(result.status, "completed");
	assert.equal(result.final.ok, true);
	assert.equal(toolCalls.length, 1);
	assert.equal(toolCalls[0].value, "hi");
	assert.deepEqual(steps, ["tool", "final"]);
	assert.match(result.trace, /调用 echo/);
	assert.match(result.trace, /echo → echoed/);
	// The loop system prompt embeds the tool catalog and the protocol.
	assert.match(provider.calls[0][0], /工具循环协议/);
	assert.match(provider.calls[0][0], /echo/);
}

async function testLoopRejectsUnknownToolAndRepairsProtocol() {
	const provider = createFakeProvider([
		"我想调用一个不存在的工具",
		JSON.stringify({ action: "tool", tool: "nope", arguments: {} }),
		JSON.stringify({ action: "final", result: { recovered: true } }),
	]);
	const result = await runBoundedAgentLoop({
		system: "s",
		user: "u",
		tools: [{
			name: "real",
			description: "d",
			parameters: {},
			async execute() { return { output: "ok" }; },
		}],
		provider,
		model: "m",
	});
	assert.equal(result.status, "completed");
	assert.equal(result.final.recovered, true);
	assert.match(result.trace, /未知工具 nope/);
}

async function testLoopFailsAfterRepeatedProtocolViolation() {
	const provider = createFakeProvider(["不是 JSON", "还不是 JSON"]);
	const result = await runBoundedAgentLoop({
		system: "s",
		user: "u",
		tools: [],
		provider,
		model: "m",
	});
	assert.equal(result.status, "failed");
	assert.match(result.error, /工具循环协议/);
}

async function testLoopBudgetExhaustion() {
	const provider = createFakeProvider([
		() => JSON.stringify({ action: "tool", tool: "loop", arguments: {} }),
	]);
	let executions = 0;
	const result = await runBoundedAgentLoop({
		system: "s",
		user: "u",
		tools: [{
			name: "loop",
			description: "d",
			parameters: {},
			async execute() {
				executions += 1;
				return { output: "still running" };
			},
		}],
		provider,
		model: "m",
		maxSteps: 4,
	});
	assert.equal(result.status, "budget-exhausted");
	assert.equal(executions, 4);
	assert.match(result.error, /最大轮数/);
}

async function testLoopCancellation() {
	let cancelled = false;
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "wait", arguments: {} }),
		JSON.stringify({ action: "final", result: {} }),
	]);
	const result = await runBoundedAgentLoop({
		system: "s",
		user: "u",
		tools: [{
			name: "wait",
			description: "d",
			parameters: {},
			async execute() {
				cancelled = true;
				return { output: "done waiting" };
			},
		}],
		provider,
		model: "m",
		isCancelled: () => cancelled,
	});
	assert.equal(result.status, "cancelled");
}

async function testLoopToolOutputBudget() {
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "firehose", arguments: {} }),
		JSON.stringify({ action: "final", result: {} }),
	]);
	const result = await runBoundedAgentLoop({
		system: "s",
		user: "u",
		tools: [{
			name: "firehose",
			description: "d",
			parameters: {},
			async execute() {
				return { output: "x".repeat(5000), summary: "big" };
			},
		}],
		provider,
		model: "m",
		maxToolResultChars: 500,
		maxToolOutputChars: 600,
	});
	assert.equal(result.status, "completed");
	// The tool result fed back to the model must be truncated.
	const toolResultMessage = provider.calls[1]
		.find((message) => message.startsWith("user:<tool_result tool=\"firehose\""));
	assert.ok(toolResultMessage, "tool result message missing from transcript");
	assert.ok(toolResultMessage.includes("已截断"));
	assert.ok(toolResultMessage.length < 1200);
}

function testVaultReadTool() {
	const fake = createFakeVault(new Map([
		["papers/demo/article.md", "A".repeat(200)],
		["papers/demo/image.png", "binary"],
	]));
	const tool = createVaultReadTool({ app: fake });
	return tool.execute({ path: "papers/demo/article.md" }).then((result) => {
		assert.match(result.output, /共 200 字符/);
		return tool.execute({ path: "papers/demo/image.png" }).then(() => {
			assert.fail("expected image read to be rejected");
		}, (error) => {
			assert.match(error.message, /只支持文本文件/);
			return tool.execute({ path: "../etc/passwd" }).then(() => {
				assert.fail("expected traversal to be rejected");
			}, (traversalError) => {
				assert.match(traversalError.message, /非法路径/);
			});
		});
	});
}

async function testVaultListTool() {
	const fake = createFakeVault(new Map([
		["wiki/sources/a.md", ""],
		["wiki/sources/b.md", ""],
		["papers/c/article.md", ""],
		["papers/c/figure.png", ""],
	]));
	const mdTool = createVaultListTool({ app: fake });
	const md = await mdTool.execute({ folder: "wiki/sources" });
	assert.match(md.output, /wiki\/sources\/a\.md/);
	assert.doesNotMatch(md.output, /papers\/c\/article\.md/);
	const pngTool = await mdTool.execute({ folder: "papers/c", extension: "png" });
	assert.match(pngTool.output, /figure\.png/);
}

async function testHttpJsonToolAllowlist() {
	const requests = [];
	const tool = createHttpJsonTool({
		httpGetJson: async (url) => {
			requests.push(url);
			return { status: 200, json: { ok: true }, text: "" };
		},
	}, [...PAPER_INGEST_ALLOWED_HOSTS]);
	const allowed = await tool.execute({ url: "https://api.crossref.org/works?query=test" });
	assert.match(allowed.output, /"ok": true/);
	await tool.execute({ url: "https://evil.example.com/steal" }).then(() => {
		assert.fail("expected non-allowlisted host to be rejected");
	}, (error) => {
		assert.match(error.message, /不在白名单/);
	});
	await tool.execute({ url: "http://api.crossref.org/works" }).then(() => {
		assert.fail("expected plain http to be rejected");
	}, (error) => {
		assert.match(error.message, /https/);
	});
	assert.equal(requests.length, 1);
}

async function testMineruToolBuildsHelperArgs() {
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
				stdout: `${JSON.stringify({ status: "published", package: "D:/vault/papers/demo/article.md", validation: { ok: true } })}\n`,
				stderr: "",
			};
		},
	};
	const tool = createMineruExtractTool(deps);
	const result = await tool.execute({
		source: "D:/raw/paper.pdf",
		citekey: "demo_2026",
		model: "vlm",
		formula: false,
		includeSourcePdf: true,
	});
	assert.match(result.output, /D:\/vault\/papers\/demo\/article\.md/);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].pythonExecutable, "D:/python/python.exe");
	assert.deepEqual(runs[0].cliArgs.slice(0, 2), [
		"D:/toolkit/tool-library/scripts/run_mineru_extract.py",
		"--project-root",
	]);
	assert.ok(runs[0].cliArgs.includes("--no-formula"));
	assert.ok(runs[0].cliArgs.includes("--include-source-pdf"));
	assert.ok(runs[0].cliArgs.includes("--base-url"));

	const failingTool = createMineruExtractTool({
		...deps,
		runHelper: async () => ({ exitCode: 2, stdout: "", stderr: "MinerU upstream 500" }),
	});
	await failingTool.execute({ source: "D:/raw/paper.pdf", citekey: "demo_2026" }).then(() => {
		assert.fail("expected non-zero helper exit to throw");
	}, (error) => {
		assert.match(error.message, /MinerU 提取失败/);
	});
}

function testMineruHelperArgValidation() {
	const missingToolkit = buildMineruHelperArgs({
		toolkitRoot: "",
		mineruExecutable: "mineru",
		mineruBaseUrl: "",
		pythonExecutable: "python",
		runHelper: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	}, { source: "a.pdf", citekey: "x" });
	assert.match(missingToolkit.error, /工具包目录/);

	const badCitekey = buildMineruHelperArgs({
		toolkitRoot: "D:/t",
		mineruExecutable: "m",
		mineruBaseUrl: "",
		pythonExecutable: "p",
		runHelper: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	}, { source: "a.pdf", citekey: "../escape" });
	assert.match(badCitekey.error, /citekey/);

	const built = buildMineruHelperArgs({
		toolkitRoot: "D:/t/",
		mineruExecutable: "m",
		mineruBaseUrl: "",
		pythonExecutable: "p",
		runHelper: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	}, { source: "a.PDF", citekey: "ok_2026", timeoutSeconds: 99999 });
	assert.equal(built.error, undefined);
	assert.ok(built.cliArgs.includes("99999") === false);
	assert.ok(built.cliArgs.includes("1800"));
}

async function testWriteNoteScopeGuard() {
	const fake = createFakeVault(new Map([["wiki/index.md", ""]]));
	const journal = new VaultWriteJournal();
	const tool = createWriteNoteTool({ app: fake }, PAPER_INGEST_WRITE_SCOPE, journal);
	const ok = await tool.execute({
		path: "wiki/sources/demo_2026.md",
		content: "# Demo\n正文",
	});
	assert.match(ok.output, /wiki\/sources\/demo_2026\.md/);
	assert.deepEqual(journal.paths(), ["wiki/sources/demo_2026.md"]);

	await tool.execute({ path: "papers.csv", content: "x" }).then(() => {
		assert.fail("expected non-scope path to be rejected");
	}, (error) => {
		assert.match(error.message, /路径越界/);
	});
	await tool.execute({ path: "wiki/sources/../../evil.md", content: "x" }).then(() => {
		assert.fail("expected traversal to be rejected");
	}, (error) => {
		assert.match(error.message, /越界|不合法/);
	});
	await tool.execute({ path: "wiki/sources/empty.md", content: "  " }).then(() => {
		assert.fail("expected empty content to be rejected");
	}, (error) => {
		assert.match(error.message, /content 不能为空/);
	});
	assert.equal(fake.written.length, 1);
}

async function testWebSearchToolQueryCaps() {
	const tool = createWebSearchTool({
		http: { httpRequest: async () => ({ status: 200, json: {} }) },
		apiKey: "tvly-test",
		maxResults: 5,
		timeoutMs: 1000,
	});
	await tool.execute({ queries: [] }).then(() => {
		assert.fail("expected empty queries to be rejected");
	}, (error) => {
		assert.match(error.message, /至少一个检索词/);
	});
	await tool.execute({ queries: "not-an-array" }).then(() => {
		assert.fail("expected non-array queries to be rejected");
	}, (error) => {
		assert.match(error.message, /至少一个检索词/);
	});
	await tool.execute({ queries: ["", "  "] }).then(() => {
		assert.fail("expected blank queries to be rejected");
	}, (error) => {
		assert.match(error.message, /至少一个检索词/);
	});
	const noKey = createWebSearchTool({
		http: { httpRequest: async () => ({ status: 200, json: {} }) },
		apiKey: "",
		maxResults: 5,
		timeoutMs: 1000,
	});
	await noKey.execute({ queries: ["test"] }).then(() => {
		assert.fail("expected missing key to be rejected");
	}, (error) => {
		assert.match(error.message, /Tavily API Key/);
	});
}

function testPaperIngestFlowPromptAndContract() {
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
	const system = buildPaperIngestSystemPrompt(options);
	assert.match(system, /身份核验、去重、citekey 选定始终先执行/);
	assert.match(system, /mineru_extract/);
	assert.match(system, /api\.crossref\.org/);
	assert.match(system, /abstract-level/);
	assert.match(system, /papers\.csv/);

	const noConfirm = buildPaperIngestSystemPrompt({ ...options, remoteUploadConfirmed: false });
	assert.match(noConfirm, /不得调用 mineru_extract/);

	const noMarkdown = buildPaperIngestSystemPrompt({ ...options, createArticleMarkdown: false });
	assert.doesNotMatch(noMarkdown, /mineru_extract 生成原文包/);

	const user = buildPaperIngestUserMessage(options);
	assert.match(user, /D:\/raw\/demo\.pdf/);
	assert.match(user, /重点处理图 2/);

	const parsed = parsePaperIngestFinalResult({
		status: "completed",
		citekey: "demo_2026",
		title: "Demo Paper",
		articlePath: "papers/demo_2026/article.md",
		filesWritten: ["papers/demo_2026/article.md"],
	});
	assert.equal(parsed.status, "completed");
	assert.deepEqual(parsed.filesWritten, ["papers/demo_2026/article.md"]);
	assert.equal(parsePaperIngestFinalResult({ status: "nonsense" }), null);
	assert.equal(parsePaperIngestFinalResult(null), null);
}

async function testBuildPaperIngestToolsAllowlist() {
	const fake = createFakeVault(new Map([]));
	const calls = [];
	const { tools } = buildPaperIngestTools({
		vault: { app: fake },
		http: { httpGetJson: async () => ({ status: 200, json: null, text: "" }) },
		mineru: {
			toolkitRoot: "D:/t",
			mineruExecutable: "m",
			mineruBaseUrl: "",
			pythonExecutable: "p",
			runHelper: async (args) => {
				calls.push(args);
				return { exitCode: 0, stdout: "{}", stderr: "" };
			},
		},
		tavily: {
			http: { httpRequest: async () => ({ status: 200, json: {} }) },
			apiKey: "",
			maxResults: 5,
			timeoutMs: 1000,
		},
		lexicalRetriever: { retrieve: async () => ({ lexical_seeds: [] }) },
	}, {
		sourcePdfPath: "a.pdf",
		requestNotes: "",
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
	});
	const names = tools.map((tool) => tool.name);
	assert.ok(names.includes("mineru_extract"));
	assert.ok(names.includes("write_note"));
	assert.ok(!names.includes("web_search"), "无 Tavily Key 时不暴露 web_search 工具");

	const withoutMarkdown = buildPaperIngestTools({
		vault: { app: fake },
		http: { httpGetJson: async () => ({ status: 200, json: null, text: "" }) },
		mineru: {
			toolkitRoot: "D:/t",
			mineruExecutable: "m",
			mineruBaseUrl: "",
			pythonExecutable: "p",
			runHelper: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
		},
		tavily: {
			http: { httpRequest: async () => ({ status: 200, json: {} }) },
			apiKey: "tvly-x",
			maxResults: 5,
			timeoutMs: 1000,
		},
		lexicalRetriever: { retrieve: async () => ({ lexical_seeds: [] }) },
	}, {
		sourcePdfPath: "a.pdf",
		requestNotes: "",
		createArticleMarkdown: false,
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
		remoteUploadConfirmed: false,
	});
	const names2 = withoutMarkdown.tools.map((tool) => tool.name);
	assert.ok(!names2.includes("mineru_extract"));
	assert.ok(names2.includes("web_search"));
	assert.equal(calls.length, 0);
}

async function testLoopEndToEndWithVaultTools() {
	const fake = createFakeVault(new Map([
		["wiki/sources/existing.md", "---\ntitle: Existing\n---\n正文"],
	]));
	const retriever = {
		retrieve: async (question) => ({
			lexical_seeds: question.includes("Existing")
				? [{ path: "wiki/sources/existing.md", title: "Existing", score: 3 }]
				: [],
		}),
	};
	const { tools } = buildPaperIngestTools({
		vault: { app: fake },
		http: {
			httpGetJson: async () => ({
				status: 200,
				json: { "message": { items: [{ DOI: "10.1000/demo", title: ["Demo Paper"] }] } },
				text: "",
			}),
		},
		mineru: {
			toolkitRoot: "",
			mineruExecutable: "",
			mineruBaseUrl: "",
			pythonExecutable: "",
			runHelper: async () => ({ exitCode: 1, stdout: "", stderr: "unavailable" }),
		},
		tavily: {
			http: { httpRequest: async () => ({ status: 200, json: {} }) },
			apiKey: "",
			maxResults: 5,
			timeoutMs: 1000,
		},
		lexicalRetriever: retriever,
	}, {
		sourcePdfPath: "D:/raw/demo.pdf",
		requestNotes: "",
		createArticleMarkdown: false,
		createArticleWiki: true,
		articleWikiSource: "pdf",
		mineruModel: "vlm",
		mineruLanguage: "en",
		mineruOcr: false,
		mineruFormula: true,
		mineruTable: true,
		mineruPages: "",
		mineruTimeoutSeconds: 600,
		mineruIncludeSourcePdf: false,
		remoteUploadConfirmed: false,
	});
	const provider = createFakeProvider([
		JSON.stringify({ action: "tool", tool: "http_get_json", arguments: { url: "https://api.crossref.org/works?query=demo" } }),
		JSON.stringify({ action: "tool", tool: "vault_search", arguments: { question: "Demo Paper Existing" } }),
		JSON.stringify({
			action: "tool",
			tool: "write_note",
			arguments: {
				path: "wiki/sources/demo_2026.md",
				content: "---\ntitle: Demo Paper\ntitle_zh: 演示论文\ntype: source\ndepth: abstract-level\n---\n\n## 研究问题\nDemo。",
			},
		}),
		JSON.stringify({
			action: "final",
			result: {
				status: "completed",
				citekey: "demo_2026",
				title: "Demo Paper",
				title_zh: "演示论文",
				wikiPath: "wiki/sources/demo_2026.md",
				filesWritten: ["wiki/sources/demo_2026.md"],
				notes: ["未找到已验证 article 包，内容来源为 PDF 信息"],
			},
		}),
	]);
	const result = await runBoundedAgentLoop({
		system: buildPaperIngestSystemPrompt({
			sourcePdfPath: "D:/raw/demo.pdf",
			requestNotes: "",
			createArticleMarkdown: false,
			createArticleWiki: true,
			articleWikiSource: "pdf",
			mineruModel: "vlm",
			mineruLanguage: "en",
			mineruOcr: false,
			mineruFormula: true,
			mineruTable: true,
			mineruPages: "",
			mineruTimeoutSeconds: 600,
			mineruIncludeSourcePdf: false,
			remoteUploadConfirmed: false,
		}),
		user: buildPaperIngestUserMessage({
			sourcePdfPath: "D:/raw/demo.pdf",
			requestNotes: "",
			createArticleMarkdown: false,
			createArticleWiki: true,
			articleWikiSource: "pdf",
			mineruModel: "vlm",
			mineruLanguage: "en",
			mineruOcr: false,
			mineruFormula: true,
			mineruTable: true,
			mineruPages: "",
			mineruTimeoutSeconds: 600,
			mineruIncludeSourcePdf: false,
			remoteUploadConfirmed: false,
		}),
		tools,
		provider,
		model: "test-model",
	});
	assert.equal(result.status, "completed", result.error);
	const parsed = parsePaperIngestFinalResult(result.final);
	assert.equal(parsed.citekey, "demo_2026");
	assert.equal(parsed.wikiPath, "wiki/sources/demo_2026.md");
	assert.equal(fake.written.length, 1);
	assert.match(fake.written[0].data, /title_zh: 演示论文/);
	assert.match(result.trace, /已写入 wiki\/sources\/demo_2026\.md/);
}

(async () => {
	testExtractFirstJsonObject();
	await testLoopToolRoundtrip();
	await testLoopRejectsUnknownToolAndRepairsProtocol();
	await testLoopFailsAfterRepeatedProtocolViolation();
	await testLoopBudgetExhaustion();
	await testLoopCancellation();
	await testLoopToolOutputBudget();
	await testVaultReadTool();
	await testVaultListTool();
	await testHttpJsonToolAllowlist();
	await testMineruToolBuildsHelperArgs();
	testMineruHelperArgValidation();
	await testWriteNoteScopeGuard();
	await testWebSearchToolQueryCaps();
	testPaperIngestFlowPromptAndContract();
	await testBuildPaperIngestToolsAllowlist();
	await testLoopEndToEndWithVaultTools();
	console.log("AGENT_LOOP_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
