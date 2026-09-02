"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
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
			"  createBoundArticleReadTool,",
			"  buildArticleEvidencePacket,",
			"  createVaultListTool,",
			"  createVaultSearchTool,",
			"  createVaultDoiSearchTool,",
			"  createCrossrefSearchTool,",
			"  createCrossrefDoiTool,",
			"  createWebSearchTool,",
			"  runAuthorizedMineruExtract,",
			"  mineruReadiness,",
			"  commitSourceNote,",
			"  validateSourceNoteContent,",
			"  yamlSafeScalar,",
			"  VaultWriteJournal,",
			'} from "./src/agent/tools";',
			"export {",
			"  publishMineruPackage,",
			"  resolveMineruCommand,",
			"  mineruCliArgs,",
			"  normalizePagesValue,",
			"  validateStagedPackage,",
			"} from './src/agent/mineru-publish';",
			"export {",
			"  buildIdentitySystemPrompt,",
			"  buildIdentityUserMessage,",
			"  buildDraftSystemPrompt,",
			"  buildDraftTools,",
			"  buildIdentityTools,",
			"  parseIdentityResult,",
			"  parseNoteDraft,",
			"  validateIdentityReceipts,",
			"  validateDraftReceipts,",
			"  bindIdentityMetadataFromReceipts,",
			"  evaluateDraftPhase,",
			"  computeIngestOutcomeStatus,",
			"  planExactDuplicateOutputs,",
			"  resolveExactDuplicateLayers,",
			"  resolveExactDuplicateCitekey,",
			"  deriveBibliographicCitekey,",
			"  resolveUniqueCitekey,",
			"  deriveArticleVaultPath,",
			"  resolveArticleVaultPath,",
			"  parsePaperIngestInput,",
			"  stripMatchingQuotes,",
			"  PAPER_INGEST_READ_PREFIXES,",
			'} from "./src/agent/paper-ingest-flow";',
			"export { createAuthorizedPdfSnapshot, disposeAuthorizedPdfSnapshot, extractLocalPdfIdentityEvidence, extractPdfDoiCandidates, MAX_LOCAL_PDF_BYTES } from './src/agent/pdf-identity';",
			"export { articleHeadContainsTitle, articleMarkdownTitleMatches, resolvePaperTitleZh } from './src/agent/agent-loop-service';",
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
	createBoundArticleReadTool,
	buildArticleEvidencePacket,
	createVaultListTool,
	createVaultSearchTool,
	createVaultDoiSearchTool,
	createCrossrefSearchTool,
	createCrossrefDoiTool,
	createWebSearchTool,
	runAuthorizedMineruExtract,
	mineruReadiness,
	resolveMineruCommand,
	mineruCliArgs,
	publishMineruPackage,
	normalizePagesValue,
	validateStagedPackage,
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
	validateDraftReceipts,
	bindIdentityMetadataFromReceipts,
	evaluateDraftPhase,
	computeIngestOutcomeStatus,
	planExactDuplicateOutputs,
	resolveExactDuplicateLayers,
	resolveExactDuplicateCitekey,
	deriveBibliographicCitekey,
	resolveUniqueCitekey,
	deriveArticleVaultPath,
	resolveArticleVaultPath,
	parsePaperIngestInput,
	stripMatchingQuotes,
	PAPER_INGEST_READ_PREFIXES,
	extractLocalPdfIdentityEvidence,
	extractPdfDoiCandidates,
	createAuthorizedPdfSnapshot,
	disposeAuthorizedPdfSnapshot,
	MAX_LOCAL_PDF_BYTES,
	articleHeadContainsTitle,
	articleMarkdownTitleMatches,
	resolvePaperTitleZh,
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
	const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rar-agent-vault-"));
	for (const [relativePath, content] of files.entries()) {
		const fullPath = path.join(vaultRoot, ...String(relativePath).split("/"));
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, String(content), "utf8");
	}
	const written = [];
	const created = [];
	const adapter = {
		getBasePath: () => vaultRoot,
		getFullPath: (target) => path.join(vaultRoot, ...String(target || "").split("/")),
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
			const fullPath = path.join(vaultRoot, ...normalized.split("/"));
			if (fs.existsSync(fullPath)) return fs.readFileSync(fullPath, "utf8");
			const entry = [...written, ...created].find((item) => item.path === normalized);
			if (!entry) throw new Error(`文件不存在：${normalized}`);
			return entry.data;
		},
	};
	const toStubFile = (filePath) => {
		const extension = filePath.split(".").pop() || "";
		const fullPath = path.join(vaultRoot, ...String(filePath).split("/"));
		const size = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
		return Object.assign(new ObsidianTFile(), { path: filePath, extension, stat: { size } });
	};
	const create = async (target, data) => {
		const normalized = String(target).replace(/\\/g, "/");
		if (files.has(normalized) || created.some((entry) => entry.path === normalized)) {
			throw new Error("File already exists");
		}
		const entry = { path: normalized, data: String(data) };
		created.push(entry);
		const fullPath = path.join(vaultRoot, ...normalized.split("/"));
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, String(data), { encoding: "utf8", flag: "wx" });
		return toStubFile(normalized);
	};
	return {
		vaultRoot,
		written,
		created,
		createShouldFail: options.createShouldFail || false,
		vault: {
			getAbstractFileByPath: (target) => {
				const normalized = String(target).replace(/\\/g, "/");
				return fs.existsSync(path.join(vaultRoot, ...normalized.split("/"))) ? toStubFile(normalized) : null;
			},
			getMarkdownFiles: () => [...files.keys()]
				.filter((key) => key.endsWith(".md"))
				.map(toStubFile),
			getFiles: () => [...files.keys()].map(toStubFile),
			read: async (file) => fs.readFileSync(path.join(vaultRoot, ...String(file.path).split("/")), "utf8"),
			adapter,
			create: async (target, data) => {
				if (options.createShouldFail) throw new Error("File already exists");
				return create(target, data);
			},
		},
	};
}

async function testVaultAncestorLinksAreRejected() {
	const clippingVault = createFakeVault(new Map());
	const outsideClippings = fs.mkdtempSync(path.join(os.tmpdir(), "rar-outside-clippings-"));
	fs.writeFileSync(path.join(outsideClippings, "paper.md"), "# Outside Paper", "utf8");
	try {
		fs.symlinkSync(outsideClippings, path.join(clippingVault.vaultRoot, "Clippings"), "junction");
		const read = createVaultReadTool({ app: clippingVault }, PAPER_INGEST_READ_PREFIXES);
		await assert.rejects(
			read.execute({ path: "Clippings/paper.md" }, createContext()),
			/符号链接|junction/,
		);
		const bound = createBoundArticleReadTool({ app: clippingVault }, "Clippings/paper.md");
		await assert.rejects(bound.execute({}, createContext()), /符号链接|junction/);
	} catch (error) {
		if (!error || error.code !== "EPERM") throw error;
	}

	const wikiVault = createFakeVault(new Map());
	const outsideWiki = fs.mkdtempSync(path.join(os.tmpdir(), "rar-outside-wiki-"));
	try {
		fs.symlinkSync(outsideWiki, path.join(wikiVault.vaultRoot, "wiki"), "junction");
		await assert.rejects(commitSourceNote({ app: wikiVault }, "blocked_2026", {
			title: "Blocked Paper", title_zh: "被阻止的论文", authors: "", year: "2026", doi: "",
			researchQuestion: "问题", conclusion: "结论", motivation: "动机", evidenceGaps: "", notes: [],
		}), /符号链接|junction/);
		assert.equal(fs.existsSync(path.join(outsideWiki, "sources", "blocked_2026.md")), false);
	} catch (error) {
		if (!error || error.code !== "EPERM") throw error;
	}
}

function createFakeProvider(turns) {
	let call = 0;
	const calls = [];
	const requestOptions = [];
	return {
		calls,
		requestOptions,
		turnCount: () => call,
		async complete(request, options = {}) {
			calls.push(request.messages.map((message) => `${message.role}:${String(message.content)}`));
			requestOptions.push(options);
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
			return {
				output: `echo:${args.value}`,
				summary: "echoed",
				receiptData: { query: String(args.value), titles: ["Echo Result"] },
			};
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
		providerTimeoutMs: 45000,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.final.ok, true);
	assert.equal(provider.requestOptions[0].timeoutMs, 45000, "loop must pass the light-agent provider turn timeout");
	assert.equal(result.toolCalls.length, 2, "plugin must record one receipt per tool execution");
	assert.equal(result.toolCalls[0].tool, "echo");
	assert.equal(result.toolCalls[0].ok, true);
	assert.match(result.toolCalls[0].argsSummary, /value=hi/);
	assert.equal(result.toolCalls[0].resultSummary, "echoed");
	assert.equal(result.toolCalls[0].evidencePreview, "echo:hi");
	assert.deepEqual(result.toolCalls[0].data, { query: "hi", titles: ["Echo Result"] });
	assert.equal(result.toolCalls[1].tool, "boom");
	assert.equal(result.toolCalls[1].ok, false);
	assert.equal(result.toolCalls[1].evidencePreview, "");
	assert.equal(result.toolCalls[1].data, undefined);
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
			async execute() {
				return {
					output: "x".repeat(20000),
					summary: "s".repeat(1000),
					receiptData: {
						query: "q".repeat(2000),
						titles: ["Repeated", "Repeated", "Observed"],
					},
				};
			},
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
	assert.equal(truncation.toolCalls[0].resultSummary.length, 500);
	assert.equal(truncation.toolCalls[0].evidencePreview.length, 12000);
	assert.equal(truncation.toolCalls[0].data.query.length, 1200);
	assert.deepEqual(truncation.toolCalls[0].data.titles, ["Repeated", "Observed"]);

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
		["Clippings/Original Paper.md", "# Original Paper\n\nClipping 正文"],
		["papers/demo/image.png", "binary"],
		["diary/private.md", "隐私内容"],
	]));
	const readTool = createVaultReadTool({ app: fake }, PAPER_INGEST_READ_PREFIXES);
	const ok = await readTool.execute({ path: "papers/demo/article.md" }, createContext());
	assert.match(ok.output, /共 200 字符/);
	assert.deepEqual(ok.receiptData.paths, ["papers/demo/article.md"]);
	const clipping = await readTool.execute({ path: "Clippings/Original Paper.md" }, createContext());
	assert.match(clipping.output, /Clipping 正文/);
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
	assert.deepEqual(listed.receiptData.paths, ["wiki/sources/a.md"]);
	await listTool.execute({ folder: "diary" }, createContext()).then(() => {
		assert.fail("expected out-of-scope listing to be rejected");
	}, (error) => {
		assert.match(error.message, /超出读取范围/);
	});
}

async function testBoundArticleReadBypassesIndexLag() {
	const articlePath = "papers/demo_2026/article.md";
	const article = [
		"# Demo Paper",
		"",
		"## Abstract",
		"This study asks whether a path-bound reader can summarize a newly published article.",
		"",
		"## 1. Introduction",
		"The Obsidian file index may lag behind an atomic filesystem publish.",
		"",
		"## 2. Methods",
		"The plugin reads through the Vault adapter and binds the path to the MinerU receipt.",
		"",
		"## 3. Results",
		"The article is available before getAbstractFileByPath can resolve it.",
		"",
		"# 4. Conclusion",
		"Receipt-bound adapter reads remove the same-run indexing race.",
	].join("\n") + "\n" + "Supplementary detail. ".repeat(900);
	const fake = createFakeVault(new Map([[articlePath, article]]));
	// Simulate a package written directly to disk in this run: adapter sees it,
	// while Obsidian's asynchronous TFile index still returns null.
	fake.vault.getAbstractFileByPath = () => null;
	const tool = createBoundArticleReadTool({ app: fake }, articlePath);
	const result = await tool.execute({ mode: "overview", path: "diary/private.md" }, createContext());
	assert.match(result.output, /path=papers\/demo_2026\/article\.md mode=overview/);
	assert.match(result.output, /This study asks whether/);
	assert.match(result.output, /Receipt-bound adapter reads/);
	assert.deepEqual(result.receiptData.paths, [articlePath]);
	assert.ok(result.receiptData.queryTerms.includes("overview"));
	assert.ok(result.output.length < 24000, "overview packet must stay within the draft tool result budget");

	const page = await tool.execute({ mode: "page", offset: article.indexOf("## 3. Results") }, createContext());
	assert.match(page.output, /mode=page/);
	assert.match(page.output, /## 3\. Results/);
	assert.deepEqual(page.receiptData.paths, [articlePath]);

	assert.throws(
		() => createBoundArticleReadTool({ app: fake }, "wiki/sources/demo.md"),
		/原文回执路径不合法/,
	);
	const clippingPath = "Clippings/Demo Paper.md";
	const clippingFake = createFakeVault(new Map([[clippingPath, article]]));
	const clippingTool = createBoundArticleReadTool({ app: clippingFake }, clippingPath);
	const clippingOverview = await clippingTool.execute({ mode: "overview" }, createContext());
	assert.deepEqual(clippingOverview.receiptData.paths, [clippingPath]);
	assert.match(clippingOverview.output, /Demo Paper/);

	const packet = buildArticleEvidencePacket(article);
	assert.ok(packet.sections.includes("摘要小节"));
	assert.ok(packet.sections.includes("结论小节"));
	assert.match(packet.content, /文章目录/);
	assert.ok(packet.selectedChars <= 22500);

	const goodReceipt = [{
		tool: "article_read",
		ok: true,
		argsSummary: "mode=overview",
		data: { paths: [articlePath], queryTerms: ["overview", "摘要小节"], titles: ["Demo Paper"] },
	}];
	assert.deepEqual(validateDraftReceipts(articlePath, "Demo Paper", goodReceipt), []);
	assert.match(validateDraftReceipts(articlePath, "Demo Paper", [{
		...goodReceipt[0], tool: "vault_read",
	}]).join("；"), /未成功读取/);
	assert.match(validateDraftReceipts(articlePath, "Demo Paper", [{
		...goodReceipt[0], data: { paths: [articlePath], queryTerms: ["page"] },
	}]).join("；"), /未成功读取/);
	assert.match(validateDraftReceipts(articlePath, "Demo Paper", [{
		...goodReceipt[0], data: { paths: ["papers/other/article.md"], queryTerms: ["overview"] },
	}]).join("；"), /未成功读取/);
	assert.match(validateDraftReceipts(articlePath, "Different Paper", goodReceipt).join("；"), /标题一致/);
}

async function testVaultSearchScopeFiltering() {
	const calls = [];
	const retriever = {
		retrieve: async (question, expandedTerms, options) => {
			calls.push(options);
			// The private result would outrank the in-scope one globally.
			return {
				lexical_terms: question.toLowerCase().split(/\s+/),
				lexical_seeds: question.includes("limit")
					? [
						{ path: "wiki/sources/review.md", title: "Demo Paper Review", score: 10 },
						{ path: "wiki/sources/demo.md", title: "Demo Paper", score: 9 },
					]
					: question.includes("secret")
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
	assert.deepEqual(found.receiptData.candidates, [{ path: "wiki/sources/a.md", title: "Demo" }]);
	assert.deepEqual(found.receiptData.queryTerms, ["secret", "demo"]);
	assert.equal(calls[0] && calls[0].allowedPrefixes[0], "wiki/sources", "retriever must be asked to scope ranking itself");
	const limited = await tool.execute({ question: "limit Demo Paper", limit: 1 }, createContext());
	assert.match(limited.output, /review\.md/);
	assert.doesNotMatch(limited.output, /demo\.md/, "model-visible output should honor the display limit");
	assert.deepEqual(
		limited.receiptData.candidates.map((candidate) => candidate.path),
		["wiki/sources/review.md", "wiki/sources/demo.md"],
		"security receipt must retain every bounded hit despite a smaller model display limit",
	);
	await tool.execute({ question: "" }, createContext()).then(() => {
		assert.fail("expected empty question to be rejected");
	}, (error) => {
		assert.match(error.message, /question/);
	});
}

async function testVaultDoiExactSearch() {
	const fake = createFakeVault(new Map([
		["wiki/sources/exact.md", "---\ntitle: Exact Existing Note\ndoi: 10.1000/demo\n---\n正文"],
		["Clippings/Exact Original.md", "---\ntitle: Exact Original\ndoi: 10.1000/demo\n---\n原文"],
		["wiki/sources/same-registrar.md", "---\ntitle: Other Note\ndoi: 10.1000/other\n---\n正文"],
		["wiki/sources/legal-dot.md", "---\ntitle: Legal Trailing Dot\ndoi: 10.1000/legal.\n---\n正文"],
		["wiki/sources/legal-no-dot.md", "---\ntitle: No Trailing Dot\ndoi: 10.1000/legal\n---\n正文"],
		["papers/body-hit/article.md", "# Body Hit Only\n\n正文引用 https://doi.org/10.1000/demo"],
	]));
	const tool = createVaultDoiSearchTool({ app: fake }, PAPER_INGEST_READ_PREFIXES);
	const found = await tool.execute({ doi: "https://doi.org/10.1000/DEMO" }, createContext());
	assert.deepEqual(found.receiptData.candidates, [
		{ path: "Clippings/Exact Original.md", title: "Exact Original" },
		{ path: "wiki/sources/exact.md", title: "Exact Existing Note" },
	]);
	assert.deepEqual(found.receiptData.dois, ["10.1000/DEMO"]);
	assert.doesNotMatch(found.output, /same-registrar|body-hit/);
	const missing = await tool.execute({ doi: "10.1000/missing" }, createContext());
	assert.deepEqual(missing.receiptData.candidates, []);
	assert.equal(missing.receiptData.dois, undefined);
	const legalTrailingDot = await tool.execute({ doi: "10.1000/legal." }, createContext());
	assert.deepEqual(legalTrailingDot.receiptData.candidates, [{
		path: "wiki/sources/legal-dot.md",
		title: "Legal Trailing Dot",
	}], "legal DOI suffix punctuation must not be stripped or merged with another DOI");
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
	assert.match(searchResult.output, /下一步.*crossref_doi/);
	assert.deepEqual(searchResult.receiptData.titles, ["Demo Paper: A Study"]);
	assert.deepEqual(searchResult.receiptData.dois, ["10.1000/demo"]);
	assert.deepEqual(searchResult.receiptData.bibliographicRecords, [{
		title: "Demo Paper: A Study",
		doi: "10.1000/demo",
		authors: "Wang J.",
		year: "2026",
	}]);
	assert.equal(signals[0], context.signal, "crossref requests must carry the run signal");

	const doi = createCrossrefDoiTool(deps);
	const doiResult = await doi.execute({ doi: "https://doi.org/10.1000/found" }, createContext());
	assert.match(doiResult.output, /10\.1000\/found/);
	assert.deepEqual(doiResult.receiptData, {
		query: "10.1000/found",
		titles: ["Found"],
		dois: ["10.1000/found"],
		bibliographicRecords: [{ title: "Found", doi: "10.1000/found", authors: "", year: "" }],
	});
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

function testMineruCliArgsAndReadiness() {
	assert.equal(mineruReadiness({ mineruExecutable: "", vaultRoot: "D:/v", runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }).ready, false);
	assert.equal(
		mineruReadiness({ mineruExecutable: "mineru-open-api", vaultRoot: "", runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }).ready,
		true,
		"native pipeline needs only the CLI; no toolkit or Python",
	);

	const cliArgs = mineruCliArgs({
		source: "D:/raw/paper.pdf",
		citekey: "demo_2026",
		model: "vlm",
		language: "en",
		ocr: true,
		formula: false,
		table: true,
		pages: "1-3,7",
		timeoutSeconds: 900,
		includeSourcePdf: false,
	}, "D:/stage/extract");
	assert.deepEqual(cliArgs, [
		"extract", "D:/raw/paper.pdf",
		"--model", "vlm",
		"--language", "en",
		"--format", "md,json",
		"--timeout", "900",
		"--output", "D:/stage/extract",
		"--formula=false",
		"--table",
		"--ocr",
		"--pages", "1-3,7",
	]);
	const auto = mineruCliArgs({
		source: "a.pdf", citekey: "x", model: "auto", language: "en", ocr: false,
		formula: true, table: true, pages: "", timeoutSeconds: 600,
		includeSourcePdf: false,
	}, "out");
	assert.ok(!auto.includes("--model"), "auto model must omit the flag");
	assert.equal(auto[auto.indexOf("--format") + 1], "md,json");
	assert.ok(auto.includes("--formula") && auto.includes("--table"));
	assert.equal(normalizePagesValue("1-3"), "1-3");
	assert.throws(() => normalizePagesValue("3-1"), /不能倒序/);
	assert.throws(() => normalizePagesValue("abc"), /不合法/);
}

function testResolveMineruCommand() {
	const os = require("node:os");
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-cmd-"));
	try {
		const entry = path.join(base, "node_modules", "mineru-open-api", "dist", "cli.js");
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.writeFileSync(entry, "// entry");
		const packageRoot = path.join(base, "node_modules", "mineru-open-api");
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "mineru-open-api",
			bin: { "mineru-open-api": "dist/cli.js" },
		}));
		const shimPath = path.join(base, "mineru-open-api.cmd");
		fs.writeFileSync(shimPath, [
			"@ECHO off",
			"IF EXIST \"%~dp0\\node.exe\" SET \"_prog=%~dp0\\node.exe\"",
			"\"%_prog%\"  \"%~dp0\\node_modules\\mineru-open-api\\dist\\cli.js\" %*",
		].join("\r\n"));
		const resolved = resolveMineruCommand(shimPath);
		const canonicalEntry = fs.realpathSync.native
			? fs.realpathSync.native(entry)
			: fs.realpathSync(entry);
		assert.equal(resolved.command, process.execPath);
		assert.equal(resolved.baseArgs[0], canonicalEntry);

		const extensionlessEntry = path.join(base, "node_modules", "mineru-open-api", "bin", "mineru-open-api");
		fs.mkdirSync(path.dirname(extensionlessEntry), { recursive: true });
		fs.writeFileSync(extensionlessEntry, "#!/usr/bin/env node\nconsole.log('wrapper');\n");
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "mineru-open-api",
			bin: { "mineru-open-api": "bin/mineru-open-api" },
		}));
		const currentNpmShim = path.join(base, "current-mineru-open-api.cmd");
		fs.writeFileSync(currentNpmShim, [
			"@ECHO off",
			'"%_prog%"  "%~dp0\\node_modules\\mineru-open-api\\bin\\mineru-open-api" %*',
		].join("\r\n"));
		const currentResolved = resolveMineruCommand(currentNpmShim);
		assert.equal(currentResolved.command, process.execPath);
		assert.equal(path.basename(currentResolved.baseArgs[0]), "mineru-open-api");
		assert.equal(path.extname(currentResolved.baseArgs[0]), "", "current npm launcher is extensionless");

		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "mineru-open-api",
			bin: { "mineru-open-api": "dist/cli.js" },
		}));
		const direct = resolveMineruCommand(entry);
		assert.equal(direct.command, process.execPath);
		assert.equal(direct.baseArgs.length, 1);
		assert.equal(
			fs.realpathSync.native
				? fs.realpathSync.native(direct.baseArgs[0])
				: fs.realpathSync(direct.baseArgs[0]),
			canonicalEntry,
		);
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "mineru-open-api",
			bin: { "mineru-open-api": "bin/mineru-open-api" },
		}));

		const platformPackage = `mineru-open-api-${process.platform}-${process.arch}`;
		if (["darwin", "linux", "win32"].includes(process.platform) && ["arm64", "x64"].includes(process.arch)) {
			const platformRoot = path.join(packageRoot, "node_modules", platformPackage);
			const nativeName = process.platform === "win32" ? "mineru-open-api.exe" : "mineru-open-api";
			const nativeBinary = path.join(platformRoot, "bin", nativeName);
			fs.mkdirSync(path.dirname(nativeBinary), { recursive: true });
			fs.writeFileSync(path.join(platformRoot, "package.json"), JSON.stringify({ name: platformPackage }));
			fs.writeFileSync(nativeBinary, "native fixture");
			const nativeResolved = resolveMineruCommand(currentNpmShim);
			assert.equal(nativeResolved.command, fs.realpathSync.native
				? fs.realpathSync.native(nativeBinary)
				: fs.realpathSync(nativeBinary));
			assert.deepEqual(nativeResolved.baseArgs, [], "npm platform binary must bypass Electron/Node wrapper");
		}

		const brokenShim = path.join(base, "broken.cmd");
		fs.writeFileSync(brokenShim, "@ECHO off\nREM nothing useful");
		assert.throws(() => resolveMineruCommand(brokenShim), /无法从 npm shim 解析/);
		assert.throws(() => resolveMineruCommand(path.join(base, "missing.cmd")), /不存在/);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
}

/**
 * Behavioral publish test: a fake MinerU CLI materializes real extraction
 * outputs into --output, and the pipeline must publish a reader-compatible
 * package (manifest schema v1 with matching hashes, validation.json passed)
 * into the vault — create-only.
 */
async function testMineruPublishPipeline() {
	const os = require("node:os");
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-publish-"));
	const stageRoot = path.join(base, "stage");
	const vaultRoot = path.join(base, "vault");
	fs.mkdirSync(stageRoot, { recursive: true });
	fs.mkdirSync(vaultRoot, { recursive: true });
	const sourcePdf = path.join(base, "demo.pdf");
	fs.writeFileSync(sourcePdf, Buffer.from("%PDF-1.4 fake"));

	// A fake npm shim + entry, so resolveMineruCommand can verify them.
	const shimEntry = path.join(base, "node_modules", "mineru-open-api", "dist", "cli.js");
	fs.mkdirSync(path.dirname(shimEntry), { recursive: true });
	fs.writeFileSync(shimEntry, "// fake entry");
	fs.writeFileSync(path.join(base, "node_modules", "mineru-open-api", "package.json"), JSON.stringify({
		name: "mineru-open-api",
		bin: { "mineru-open-api": "dist/cli.js" },
	}));
	const fakeShim = path.join(base, "mineru-open-api.cmd");
	fs.writeFileSync(fakeShim, [
		"@ECHO off",
		"\"%_prog%\"  \"%~dp0\\node_modules\\mineru-open-api\\dist\\cli.js\" %*",
	].join("\r\n"));

	const writeExtraction = (outputDir, options = {}) => {
		const mdDir = path.join(outputDir, "auto", "md");
		fs.mkdirSync(mdDir, { recursive: true });
		const imageName = options.imageName || "pic.jpg";
		fs.mkdirSync(path.join(mdDir, "images"), { recursive: true });
		if (options.missingImage !== true) {
			fs.writeFileSync(path.join(mdDir, "images", imageName), Buffer.from("fake-image"));
		}
		const body = options.shortMarkdown
			? "too short"
			: "# Demo Paper Title\n\n引言内容。\n\n![Fig 1](images/" + imageName + ")\n\n" + "正文".repeat(60);
		fs.writeFileSync(path.join(mdDir, "article.md"), body, "utf8");
		const jsonDir = path.join(outputDir, "auto", "json");
		fs.mkdirSync(jsonDir, { recursive: true });
		const elements = options.excessiveElements === true
			? Array.from({ length: 8193 }, (_value, index) => ({ type: "text", page_idx: index }))
			: options.invalidPageIdx === true
				? [{ type: "title", page_idx: 2048 }]
			: [[
			{ type: "title", page_idx: 0 },
			{
				type: "image",
				page_idx: options.escapingAsset === true ? 1 : 0,
				img_path: options.escapingAsset === true ? "..\\..\\outside.png" : "images/" + imageName,
			},
		]];
		fs.writeFileSync(
			path.join(jsonDir, "demo_content_list.json"),
			JSON.stringify(elements),
			"utf8",
		);
		if (options.escapingAsset === true) {
			fs.writeFileSync(path.join(outputDir, "outside.png"), Buffer.from("outside"));
		}
	};

	const calls = [];
	const makeDeps = (options = {}) => ({
		vaultRoot,
		mineruExecutable: options.executable || fakeShim,
		stageRoot,
		runCommand: async (request) => {
			calls.push(request);
			if (request.cliArgs[0] === "version") {
				return { exitCode: 0, stdout: "mineru-open-api version v0.0.0-test", stderr: "" };
			}
			if (options.failExtract === true) {
				return { exitCode: 2, stdout: "", stderr: "MinerU upstream 500" };
			}
			const outputIndex = request.cliArgs.indexOf("--output");
			const outputDir = request.cliArgs[outputIndex + 1];
			writeExtraction(outputDir, options);
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	});

	const args = {
		source: sourcePdf,
		sourceName: path.basename(sourcePdf),
		expectedSourceSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(sourcePdf)).digest("hex"),
		citekey: "demo_2026",
		model: "vlm",
		language: "en",
		ocr: false,
		formula: true,
		table: true,
		pages: "",
		timeoutSeconds: 600,
		includeSourcePdf: false,
	};
	const receipt = await publishMineruPackage(makeDeps(), args, {
		signal: new AbortController().signal,
		timeoutMs: 600000,
	});
	const packagePath = path.join(vaultRoot, "papers", "demo_2026");
	assert.equal(receipt.packagePath, packagePath);
	assert.equal(receipt.validation.status, "passed");
	assert.equal(fs.existsSync(path.join(packagePath, "article.md")), true);
	assert.equal(fs.existsSync(path.join(packagePath, "mineru-result.json")), true);
	assert.equal(fs.existsSync(path.join(packagePath, "images", "pic.jpg")), true);
	const validation = JSON.parse(
		fs.readFileSync(path.join(packagePath, "_extraction", "validation.json"), "utf8"),
	);
	assert.equal(validation.status, "passed");
	assert.equal(validation.page_count, 1);
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packagePath, "_extraction", "manifest.json"), "utf8"),
	);
	assert.equal(manifest.schema_version, 1);
	assert.equal(manifest.extractor, "mineru-open-api");
	assert.equal(manifest.outputs.length, 3, "article + json + image must be registered");
	const articleRecord = manifest.outputs.find((record) => record.path === "article.md");
	const expectedHash = require("node:crypto")
		.createHash("sha256")
		.update(fs.readFileSync(path.join(packagePath, "article.md")))
		.digest("hex");
	assert.equal(articleRecord.sha256, expectedHash);
	assert.equal(manifest.derived_contracts.length, 3);
	for (const relativePath of [
		"_extraction/viewer-index.json",
		"_extraction/visual-repair.json",
		"_extraction/visual-candidates.json",
	]) {
		const contractPath = path.join(packagePath, ...relativePath.split("/"));
		assert.equal(fs.existsSync(contractPath), true, `${relativePath} must be persisted`);
		const contractRecord = manifest.derived_contracts.find((record) => record.path === relativePath);
		assert.ok(contractRecord, `${relativePath} must be registered`);
		assert.equal(
			contractRecord.sha256,
			require("node:crypto").createHash("sha256").update(fs.readFileSync(contractPath)).digest("hex"),
		);
	}
	assert.equal(validation.checks.viewer_index_contract_valid, true);
	assert.equal(validation.checks.visual_repair_contract_valid, true);
	assert.equal(validation.checks.visual_candidates_contract_valid, true);
	const viewerContract = JSON.parse(
		fs.readFileSync(path.join(packagePath, "_extraction", "viewer-index.json"), "utf8"),
	);
	assert.equal(viewerContract.inputs.article.sha256, expectedHash);
	const repairContract = JSON.parse(
		fs.readFileSync(path.join(packagePath, "_extraction", "visual-repair.json"), "utf8"),
	);
	assert.equal(repairContract.algorithm_version, "visual-repair-v1.11");
	assert.equal(repairContract.inputs.article.sha256, expectedHash);
	const candidateContract = JSON.parse(
		fs.readFileSync(path.join(packagePath, "_extraction", "visual-candidates.json"), "utf8"),
	);
	assert.equal(candidateContract.contract, "mineru-visual-candidates");
	assert.equal(candidateContract.status, "empty");
	assert.equal(candidateContract.inputs.article.sha256, expectedHash);
	assert.deepEqual(candidateContract.policy.allowed_verdicts, ["accept", "reject", "abstain"]);

	// Pure derived contracts are deterministic across equivalent publishes.
	const deterministic = await publishMineruPackage(
		makeDeps(),
		{ ...args, citekey: "deterministic_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	);
	for (const relativePath of ["viewer-index.json", "visual-repair.json", "visual-candidates.json"]) {
		assert.deepEqual(
			fs.readFileSync(path.join(deterministic.packagePath, "_extraction", relativePath)),
			fs.readFileSync(path.join(packagePath, "_extraction", relativePath)),
			`${relativePath} must be byte-deterministic`,
		);
	}

	// Create-only: a second publish for the same citekey must fail.
	const duplicate = await publishMineruPackage(makeDeps(), args, {
		signal: new AbortController().signal,
		timeoutMs: 600000,
	}).then(() => null, (error) => error);
	assert.match(duplicate.message, /不会覆盖/);

	// Missing referenced image → validation failure, nothing published.
	const broken = await publishMineruPackage(
		makeDeps({ missingImage: true }),
		{ ...args, citekey: "broken_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(broken.message, /缺失或为空/);
	assert.equal(fs.existsSync(path.join(vaultRoot, "papers", "broken_2026")), false);

	// Structural resource limits fail inside staging and expose no final package.
	const excessive = await publishMineruPackage(
		makeDeps({ excessiveElements: true }),
		{ ...args, citekey: "excessive_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(excessive.message, /超过安全上限/);
	assert.equal(fs.existsSync(path.join(vaultRoot, "papers", "excessive_2026")), false);

	// A sparse but out-of-range flat page index is rejected before contracts are written.
	const invalidPage = await publishMineruPackage(
		makeDeps({ invalidPageIdx: true }),
		{ ...args, citekey: "invalid_page_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(invalidPage.message, /page_idx/);
	assert.equal(fs.existsSync(path.join(vaultRoot, "papers", "invalid_page_2026")), false);

	// Short markdown fails the title/length gate.
	const short = await publishMineruPackage(
		makeDeps({ shortMarkdown: true }),
		{ ...args, citekey: "short_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(short.message, /为空或过短|缺少文档标题/);

	// Escaping asset reference is rejected before publish.
	const escaping = await publishMineruPackage(
		makeDeps({ escapingAsset: true }),
		{ ...args, citekey: "escape_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(escaping.message, /越出包目录/);

	// Upstream failure surfaces the CLI error.
	const failing = await publishMineruPackage(
		makeDeps({ failExtract: true }),
		{ ...args, citekey: "fail_2026" },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(failing.message, /MinerU 退出码 2/);

	// includeSourcePdf registers the PDF with the source hash.
	const withPdf = await publishMineruPackage(
		makeDeps(),
		{ ...args, citekey: "withpdf_2026", includeSourcePdf: true },
		{ signal: new AbortController().signal, timeoutMs: 600000 },
	);
	assert.equal(fs.existsSync(path.join(withPdf.packagePath, "_extraction", "source.pdf")), true);
	const pdfManifest = JSON.parse(
		fs.readFileSync(path.join(withPdf.packagePath, "_extraction", "manifest.json"), "utf8"),
	);
	const expectedPdfHash = require("node:crypto")
		.createHash("sha256")
		.update(fs.readFileSync(sourcePdf))
		.digest("hex");
	assert.equal(pdfManifest.source.sha256, expectedPdfHash);
	assert.equal(
		pdfManifest.outputs.some((record) => record.path === "_extraction/source.pdf"),
		true,
	);

	// Pre-aborted signal → immediate cancellation.
	const controller = new AbortController();
	controller.abort();
	const cancelled = await publishMineruPackage(
		makeDeps(),
		{ ...args, citekey: "cancel_2026" },
		{ signal: controller.signal, timeoutMs: 600000 },
	).then(() => null, (error) => error);
	assert.match(cancelled.message, /已取消/);

	fs.rmSync(base, { recursive: true, force: true });
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
	const content = await fake.vault.adapter.read("wiki/sources/demo_2026.md");
	assert.match(content, /title: "Demo Paper: A Study"/);
	assert.match(content, /title_zh: "演示论文：一项研究"/);
	assert.match(content, /authors: "Wang, J\.; Li, H\.""/.source ? /authors: "Wang, J\.; Li, H\."/ : /authors/);
	assert.match(content, /doi: "10\.1000\/demo"/);
	assert.match(content, /ingest_mode: "lightweight"/);
	assert.match(content, /registry_status: "pending"/);
	assert.match(content, /## 研究问题/);
	assert.deepEqual(validateSourceNoteContent(content), []);
	const missingTitleZh = await commitSourceNote(
		{ app: fake },
		"missing_title_zh",
		{ ...fields, title_zh: "" },
		"",
	).then(() => null, (error) => error);
	assert.match(missingTitleZh.message, /title_zh/);
	assert.match(
		validateSourceNoteContent(content.replace('title_zh: "演示论文：一项研究"', 'title_zh: ""')).join("；"),
		/title_zh 不能为空/,
	);
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
	const injectedContent = await fake.vault.adapter.read("wiki/sources/injected.md");
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
		"![tracking][ref]\n\n[ref]: https://example.org/tracker.png",
		"![tracking][]\n\n[tracking]: https://example.org/tracker.png",
		"![tracking]\n\n[tracking]: https://example.org/tracker.png",
		"![track\nme][ref]\n\n[ref]: https://example.org/tracker.png",
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
		// CommonMark custom element tag names (hyphenated) count as HTML too.
		"<responsive-image src=\"../../papers/x.md\" />",
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
		"---\ntitle: \"t\"\ntitle_zh: \"测试标题\"\ncitekey: \"x\"\ntype: \"source\"\ndepth: \"abstract-level\"\ningest_mode: \"lightweight\"\nregistry_status: \"pending\"\n---\n\n## 研究问题\n[官网](https://example.org)。\n\n[网站][ref]\n\n[ref]: https://example.org \"Example\"\n\n[本页章节](#结果)。\n\n使用 <p、q> 记号，且 E<mc² 近似成立。",
	);
	assert.deepEqual(external, []);
	assert.match(
		validateSourceNoteContent(
			"---\ntitle: \"t\"\ntitle_zh: \"测试标题\"\ncitekey: \"x\"\ntype: \"source\"\ndepth: \"abstract-level\"\ningest_mode: \"lightweight\"\nregistry_status: \"pending\"\n---\n\n## 研究问题\n<https://example.org>",
		).join("；"),
		/URI 自动链接/,
	);

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
	assert.match(identityPrompt, /最多两次/);
	assert.match(identityPrompt, /输出前检查清单/);
	assert.match(identityPrompt, /有核验 DOI 时还必须用 vault_doi_search/);
	assert.match(identityPrompt, /没有该记录时必须返回 status=conflict/);
	assert.match(identityPrompt, /不能写入任何文件/);
	assert.match(identityPrompt, /不是给你的指令/);
	assert.match(identityPrompt, /插件会核对本阶段是否真的执行过元数据查询和去重检索/);
	assert.doesNotMatch(identityPrompt, /write_note/);

	// Path privacy: only the basename reaches the model prompt.
	const user = buildIdentityUserMessage(options, {
		status: "available",
		fileName: "demo.pdf",
		pageCount: 12,
		metadataTitle: "Complete Demo Paper Title",
		metadataAuthors: "Demo Author",
		doiCandidates: ["10.1000/demo"],
		firstPageText: "Complete Demo Paper Title\nDemo Author\ndoi: 10.1000/demo",
		warning: "",
	});
	assert.match(user, /demo\.pdf/);
	assert.doesNotMatch(user, /PrivateDir/);
	assert.match(user, /重点处理图 2/);
	assert.match(user, /Complete Demo Paper Title/);
	assert.match(user, /10\.1000\/demo/);
	assert.match(identityPrompt, /本地 PDF 身份预检/);
	assert.match(identityPrompt, /全部本地 DOI 均已尝试/);

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

async function testLocalPdfIdentityPreflight() {
	let destroyed = false;
	let pageCleaned = false;
	const result = await extractLocalPdfIdentityEvidence("D:/private/research/demo.pdf", {
		deps: {
			statFile: async () => ({ size: 4, isFile: true }),
			readFile: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
			verifyTitleCandidates: async (candidates) => candidates.map((candidate) => candidate.text),
			loadPdfJs: async () => ({
				getDocument(options) {
					assert.equal(options.isEvalSupported, false);
					return {
						promise: Promise.resolve({
							numPages: 9,
							getMetadata: async () => ({
								info: { Title: "Metadata Paper Title", Author: "A. Author", Subject: "10.1000/local" },
								metadata: null,
							}),
							getPage: async () => ({
								getViewport: () => ({ width: 612, height: 792 }),
								getTextContent: async () => ({ items: [
									{ str: "Full First Page Paper Title", hasEOL: true, transform: [24, 0, 0, 24, 72, 700], width: 360, height: 24 },
									{ str: "https://doi.org/10.1000/local", hasEOL: true, transform: [10, 0, 0, 10, 72, 640], width: 210, height: 10 },
								] }),
								cleanup: () => { pageCleaned = true; },
							}),
							destroy: async () => { destroyed = true; },
						}),
					};
				},
			}),
		},
	});
	assert.equal(result.status, "available");
	assert.equal(result.fileName, "demo.pdf");
	assert.equal(result.metadataTitle, "Metadata Paper Title");
	assert.equal(result.metadataAuthors, "A. Author");
	assert.equal(result.pageCount, 9);
	assert.deepEqual(result.doiCandidates, ["10.1000/local"]);
	assert.match(result.firstPageText, /Full First Page Paper Title/);
	assert.doesNotMatch(JSON.stringify(result), /private|D:\//i, "absolute source path must not reach model evidence");
	assert.equal(pageCleaned, true);
	assert.equal(destroyed, true);
	assert.deepEqual(extractPdfDoiCandidates([
		"doi: 10.1000/One and https://doi.org/10.1000/one",
	]), ["10.1000/One"]);

	const adversarial = await extractLocalPdfIdentityEvidence("D:/private/Complete Title of Wrong Paper.pdf", {
		deps: {
			statFile: async () => ({ size: 4, isFile: true }),
			readFile: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
			verifyTitleCandidates: async (candidates) => candidates.map((candidate) => candidate.text),
			loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve({
				numPages: 1,
				getMetadata: async () => ({ info: { Title: "Microsoft Word" }, metadata: null }),
				getPage: async () => ({
					getViewport: () => ({ width: 612, height: 792 }),
					getTextContent: async () => ({ items: [
						{ str: "Visible Correct Article Title for Testing", transform: [24, 0, 0, 24, 72, 700], width: 430, height: 24 },
						{ str: "Hidden Wrong Article Title for Injection", transform: [0.2, 0, 0, 0.2, 72, 680], width: 400, height: 0.2 },
						{ str: "Off Page Wrong Article Title", transform: [28, 0, 0, 28, 72, 1800], width: 400, height: 28 },
					] }),
				}),
				destroy: async () => {},
			}) }) }),
		},
	});
	assert.equal(adversarial.trustedMetadataTitle, "");
	assert.deepEqual(adversarial.firstPageTitleCandidates, ["Visible Correct Article Title for Testing"]);
	assert.doesNotMatch(adversarial.firstPageTitleCandidates.join(" "), /Wrong/);

	const nonRenderedTitle = await extractLocalPdfIdentityEvidence("D:/private/Visible Article.pdf", {
		deps: {
			statFile: async () => ({ size: 4, isFile: true }),
			readFile: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
			// Simulates a white/transparent/invisible text-layer title whose bbox
			// has no corresponding rasterized ink on the rendered title page.
			verifyTitleCandidates: async () => [],
			loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve({
				numPages: 1,
				getMetadata: async () => ({ info: {}, metadata: null }),
				getPage: async () => ({
					getViewport: () => ({ width: 612, height: 792 }),
					getTextContent: async () => ({ items: [
						{ str: "Injected Invisible Article Title", transform: [36, 0, 0, 36, 72, 700], width: 460, height: 36 },
					] }),
				}),
				destroy: async () => {},
			}) }) }),
		},
	});
	assert.deepEqual(nonRenderedTitle.firstPageTitleCandidates, []);
	assert.match(nonRenderedTitle.warning, /没有唯一的高置信标题块|不能自动确认身份/);

	let oversizedReadCalled = false;
	const oversized = await extractLocalPdfIdentityEvidence("D:/private/oversized.pdf", {
		deps: {
			statFile: async () => ({ size: MAX_LOCAL_PDF_BYTES + 1, isFile: true }),
			readFile: async () => {
				oversizedReadCalled = true;
				return new Uint8Array();
			},
			loadPdfJs: async () => { throw new Error("must not load PDF.js"); },
		},
	});
	assert.equal(oversized.status, "unavailable");
	assert.equal(oversizedReadCalled, false, "oversized PDF must be rejected before readFile");

	let underlyingReadAborted = false;
	let markReadStarted;
	const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
	const controller = new AbortController();
	const cancelled = extractLocalPdfIdentityEvidence("D:/private/cancel.pdf", {
		signal: controller.signal,
		deps: {
			statFile: async () => ({ size: 4, isFile: true }),
			readFile: async (_path, signal) => await new Promise((_resolve, reject) => {
				markReadStarted();
				signal.addEventListener("abort", () => {
					underlyingReadAborted = true;
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				}, { once: true });
			}),
			loadPdfJs: async () => { throw new Error("must not load PDF.js"); },
		},
	});
	await readStarted;
	controller.abort();
	await assert.rejects(cancelled, /取消/);
	assert.equal(underlyingReadAborted, true, "AbortSignal must reach the underlying read");

	const snapshotRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pdf-snapshot-test-"));
	const original = path.join(snapshotRoot, "selected.pdf");
	const bytesA = Buffer.from("%PDF-1.4 authorized A");
	const bytesB = Buffer.from("%PDF-1.4 replaced B");
	fs.writeFileSync(original, bytesA);
	const snapshot = await createAuthorizedPdfSnapshot(original);
	fs.writeFileSync(original, bytesB);
	assert.deepEqual(fs.readFileSync(snapshot.path), bytesA, "snapshot bytes must not follow later path replacement");
	assert.equal(
		snapshot.sha256,
		require("node:crypto").createHash("sha256").update(bytesA).digest("hex"),
	);
	await disposeAuthorizedPdfSnapshot(snapshot);
	const linked = path.join(snapshotRoot, "linked.pdf");
	try {
		fs.symlinkSync(original, linked, "file");
		await assert.rejects(
			createAuthorizedPdfSnapshot(linked),
			/普通文件.*符号链接|符号链接.*junction/,
			"authorization must not follow a user-selected mutable symlink",
		);
	} catch (error) {
		if (!error || error.code !== "EPERM") throw error;
	}
	fs.rmSync(snapshotRoot, { recursive: true, force: true });
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
	const metadataReceipt = (title = "Demo Paper", doi = "10.1000/demo") => ({
		tool: "crossref_search",
		ok: true,
		argsSummary: "query=Demo Paper",
		resultSummary: "1 条候选",
		evidencePreview: `标题: ${title}`,
		data: {
			query: "Demo Paper",
			titles: [title],
			dois: doi ? [doi] : [],
			bibliographicRecords: [{ title, doi, authors: "Doe Jane", year: "2026" }],
		},
	});
	const doiReceipt = (title = "Demo Paper", doi = "10.1000/demo") => ({
		tool: "crossref_doi",
		ok: true,
		argsSummary: `doi=https://doi.org/${doi}`,
		resultSummary: `DOI ${doi} 已核验`,
		evidencePreview: `[1] DOI: ${doi}\n标题: ${title}`,
		data: {
			query: doi,
			titles: [title],
			dois: [doi],
			bibliographicRecords: [{
				title,
				doi,
				authors: "Doe Jane; Roe Richard",
				year: "2026",
			}],
		},
	});
	const queryTerms = (query) => String(query).toLowerCase().match(/[a-z0-9][a-z0-9+#._-]{1,}/g) || [];
	const vaultReceipt = (query = "Demo Paper", candidates = [], actualTerms = queryTerms(query)) => ({
		tool: "vault_candidates",
		ok: true,
		argsSummary: `question=${query}`,
		resultSummary: `${candidates.length} 个候选`,
		evidencePreview: candidates.length ? "候选存在" : "没有找到相关笔记。",
		data: {
			query,
			queryTerms: actualTerms,
			paths: candidates.map((candidate) => candidate.path),
			titles: candidates.map((candidate) => candidate.title),
			candidates,
		},
	});
	const vaultDoiReceipt = (doi = "10.1000/demo", candidates = []) => ({
		tool: "vault_doi_search",
		ok: true,
		resultSummary: `${candidates.length} 个同 DOI source note`,
		data: {
			query: doi,
			...(candidates.length ? { dois: [doi] } : {}),
			paths: candidates.map((candidate) => candidate.path),
			titles: candidates.map((candidate) => candidate.title),
			candidates,
		},
	});
	// First-round "verified" without any tool work must be rejected.
	assert.match(
		validateIdentityReceipts(identity, [])[0],
		/元数据查询/,
	);
	const missingDedup = validateIdentityReceipts(identity, [metadataReceipt()]);
	assert.equal(missingDedup.length, 2, "missing dedup lookup AND unverified DOI must both be rejected");
	assert.match(missingDedup[0], /去重检索/);
	assert.match(missingDedup[1], /crossref_doi/);
	assert.deepEqual(
		validateIdentityReceipts(identity, [
			metadataReceipt(),
			vaultReceipt(),
			vaultDoiReceipt(),
			doiReceipt(),
		]),
		[],
		"full receipts must pass (doi.org prefix and casing normalized)",
	);
	const emptyMetadata = validateIdentityReceipts({ ...identity, doi: "" }, [
		{
			tool: "crossref_search",
			ok: true,
			argsSummary: "query=Demo Paper",
			resultSummary: "0 条候选",
			evidencePreview: "Crossref 没有返回候选。",
			data: { query: "Demo Paper" },
		},
		vaultReceipt(),
	]);
	assert.match(emptyMetadata.join("；"), /没有返回任何.*候选/);
	const unsupportedTitle = validateIdentityReceipts({ ...identity, doi: "", title: "Different Paper" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Different Paper"),
	]);
	assert.match(unsupportedTitle.join("；"), /不包含模型声明的原文标题/);
	const zeroResultTitleSpoof = validateIdentityReceipts({
		...identity,
		doi: "",
		title: "Crossref 没有返回候选",
	}, [
		metadataReceipt("Demo Paper", ""),
		{
			tool: "crossref_search",
			ok: true,
			argsSummary: "query=missing",
			resultSummary: "0 条候选",
			evidencePreview: "Crossref 没有返回候选。",
			data: { query: "missing" },
		},
		vaultReceipt("Crossref 没有返回候选"),
	]);
	assert.match(zeroResultTitleSpoof.join("；"), /不包含模型声明的原文标题/);
	const bodyTextTitleSpoof = validateIdentityReceipts({ ...identity, doi: "", title: "Journal of Tests" }, [
		{
			...metadataReceipt("Demo Paper", ""),
			evidencePreview: "标题: Demo Paper\n期刊: Journal of Tests",
		},
		vaultReceipt("Journal of Tests"),
	]);
	assert.match(bodyTextTitleSpoof.join("；"), /不包含模型声明的原文标题/);
	const unrelatedNoneLookup = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Unrelated Paper"),
	]);
	assert.match(unrelatedNoneLookup.join("；"), /完整原文标题/);
	const exactWithoutBoundPath = validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt("Demo Paper", ""), vaultReceipt()]);
	assert.match(exactWithoutBoundPath.join("；"), /未被 Vault 检索回执支持/);
	const exactWithSpoofedArgument = validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt("Demo Paper", ""), {
		...vaultReceipt("wiki/sources/demo_2026.md", [
			{ path: "wiki/sources/other_2026.md", title: "Other Paper" },
		]),
		argsSummary: "question=wiki/sources/demo_2026.md",
	}]);
	assert.match(exactWithSpoofedArgument.join("；"), /未被 Vault 检索回执支持/);
	const exactWithWrongCandidateTitle = validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt("Demo Paper", ""), vaultReceipt("Demo Paper", [
		{ path: "wiki/sources/demo_2026.md", title: "Unrelated Paper" },
	])]);
	assert.match(exactWithWrongCandidateTitle.join("；"), /标题或 DOI 一致证据/);
	assert.deepEqual(validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md（标题一致）"],
	}, [metadataReceipt("Demo Paper", ""), vaultReceipt("Demo Paper", [
		{ path: "wiki/sources/demo_2026.md", title: "Demo Paper" },
	])]), []);
	assert.deepEqual(validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "exact",
		duplicates: ["`wiki/sources/My Paper.md`（标题一致）"],
	}, [metadataReceipt("Demo Paper", ""), vaultReceipt("Demo Paper", [
		{ path: "wiki/sources/My Paper.md", title: "Demo Paper" },
	])]), [], "backtick-wrapped paths with spaces must remain intact");
	assert.deepEqual(validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "possible",
		duplicates: ["wiki/sources/张三.md（疑似同一文献）"],
	}, [metadataReceipt("Demo Paper", ""), vaultReceipt("Demo Paper", [
		{ path: "wiki/sources/张三.md", title: "旧标题" },
	])]), [], "legacy unquoted Unicode Markdown paths should remain compatible");
	const exactDoiFromSearchOnly = validateIdentityReceipts({
		...identity,
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt(), doiReceipt(), vaultReceipt("10.1000/demo", [
		{ path: "wiki/sources/demo_2026.md", title: "Demo Paper" },
	])]);
	assert.match(exactDoiFromSearchOnly.join("；"), /标题或 DOI 一致证据/);
	assert.deepEqual(validateIdentityReceipts({
		...identity,
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt(), doiReceipt(), vaultDoiReceipt("10.1000/demo", [
		{ path: "wiki/sources/demo_2026.md", title: "Legacy Title" },
	])]), [], "an authoritative exact DOI receipt should prove the duplicate directly");
	assert.deepEqual(validateIdentityReceipts({
		...identity,
		duplicateStatus: "exact",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt(), doiReceipt(), {
		tool: "vault_candidate_read",
		ok: true,
		argsSummary: "path=wiki/sources/demo_2026.md",
		data: {
			query: "wiki/sources/demo_2026.md",
			paths: ["wiki/sources/demo_2026.md"],
			titles: ["Demo Paper"],
			dois: ["10.1000/demo"],
		},
	}]), []);
	const mismatchedDoiTitle = validateIdentityReceipts(identity, [
		metadataReceipt(),
		doiReceipt("Unrelated Paper"),
		vaultReceipt(),
	]);
	assert.match(mismatchedDoiTitle.join("；"), /对应标题的 crossref_doi/);
	const inconsistentNone = validateIdentityReceipts({
		...identity,
		doi: "",
		duplicateStatus: "none",
		duplicates: ["wiki/sources/demo_2026.md"],
	}, [metadataReceipt("Demo Paper", ""), vaultReceipt()]);
	assert.match(inconsistentNone.join("；"), /duplicateStatus 为 none/);

	const omittedDoi = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt(),
		vaultReceipt(),
	]);
	assert.match(omittedDoi.join("；"), /对应标题的 crossref_doi/);

	const webOnly = validateIdentityReceipts({ ...identity, doi: "" }, [{
		tool: "web_search",
		ok: true,
		data: {
			bibliographicRecords: [{ title: "Demo Paper", doi: "", authors: "", year: "" }],
		},
	}, vaultReceipt()]);
	assert.match(webOnly.join("；"), /网页结果不能单独作为 verified/);

	const noneWithExactCandidate = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Demo Paper", [{ path: "wiki/sources/existing_2026.md", title: "Demo Paper" }]),
	]);
	assert.match(noneWithExactCandidate.join("；"), /同标题或同 citekey 候选/);

	const emptyThenExact = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Demo Paper"),
		vaultReceipt("Demo Paper", [{ path: "wiki/sources/existing_2026.md", title: "Demo Paper" }]),
	]);
	assert.match(emptyThenExact.join("；"), /同标题或同 citekey 候选/);
	const nonqualifyingSearchCannotHideExact = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Demo Paper"),
		vaultReceipt("other lookup", [{ path: "wiki/sources/existing_2026.md", title: "Demo Paper" }]),
	]);
	assert.match(nonqualifyingSearchCannotHideExact.join("；"), /同标题或同 citekey 候选/);
	const globalReadConflict = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Demo Paper"),
		{
			tool: "vault_candidate_read",
			ok: true,
			data: { paths: ["wiki/sources/existing_2026.md"], titles: ["Demo Paper"] },
		},
	]);
	assert.match(globalReadConflict.join("；"), /Vault 读取回执冲突/);

	const noisyTerms = Array.from({ length: 24 }, (_, index) => `noise${index}`);
	const noisyQueryBypass = validateIdentityReceipts({ ...identity, doi: "" }, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt(`${noisyTerms.join(" ")} Demo Paper`, [], noisyTerms),
	]);
	assert.match(noisyQueryBypass.join("；"), /实际使用.*检索词/);

	const punctuationVariantBypass = validateIdentityReceipts({
		...identity,
		doi: "",
		title: "Demo-Paper",
	}, [
		metadataReceipt("Demo Paper", ""),
		vaultReceipt("Demo-Paper", [], ["demo-paper"]),
	]);
	assert.match(
		punctuationVariantBypass.join("；"),
		/实际使用.*检索词/,
		"dedup must use the Crossref-bound canonical title, not the model punctuation variant",
	);

	const doiCandidate = { path: "wiki/sources/other_2025.md", title: "Wrong Title" };
	const titleOnlyDoiDedup = validateIdentityReceipts(identity, [
		metadataReceipt(),
		doiReceipt(),
		vaultReceipt(),
	]);
	assert.match(titleOnlyDoiDedup.join("；"), /没有用 vault_doi_search/);
	const exactDoiCandidate = validateIdentityReceipts(identity, [
		metadataReceipt(),
		doiReceipt(),
		vaultReceipt(),
		vaultDoiReceipt("10.1000/demo", [doiCandidate]),
	]);
	assert.match(exactDoiCandidate.join("；"), /DOI 精确查重回执冲突/);
	assert.deepEqual(validateIdentityReceipts(identity, [
		metadataReceipt(),
		doiReceipt(),
		vaultReceipt(),
		vaultDoiReceipt(),
	]), [], "an empty authoritative DOI lookup plus an empty title lookup may be none");

	const localPdfEvidence = {
		status: "available",
		fileName: "demo-paper.pdf",
		pageCount: 12,
		metadataTitle: "Demo Paper for Secure Local Identity",
		trustedMetadataTitle: "Demo Paper for Secure Local Identity",
		firstPageTitleCandidates: ["Demo Paper for Secure Local Identity"],
		metadataAuthors: "Doe Jane",
		doiCandidates: ["10.1000/cited-reference"],
		firstPageText: "Demo Paper for Secure Local Identity\nDoe Jane\nReferences include 10.1000/cited-reference",
		warning: "",
	};
	const localBoundIdentity = { ...identity, title: "Demo Paper for Secure Local Identity" };
	assert.deepEqual(validateIdentityReceipts(localBoundIdentity, [
		metadataReceipt(localBoundIdentity.title),
		doiReceipt(localBoundIdentity.title),
		vaultReceipt(localBoundIdentity.title),
		vaultDoiReceipt(),
	], localPdfEvidence), [], "Crossref identity must remain bound to local PDF title evidence");
	const citedIdentity = {
		...identity,
		title: "Cited Reference",
		doi: "10.1000/cited-reference",
		citekey: "cited_2026",
	};
	const citedReceipts = [
		metadataReceipt("Cited Reference", "10.1000/cited-reference"),
		doiReceipt("Cited Reference", "10.1000/cited-reference"),
		vaultReceipt("Cited Reference"),
		vaultDoiReceipt("10.1000/cited-reference"),
	];
	assert.match(
		validateIdentityReceipts(citedIdentity, citedReceipts, {
			...localPdfEvidence,
			fileName: "Cited Reference.pdf",
		}).join("；"),
		/本地 PDF 标题证据不一致/,
		"a DOI appearing in references must not rebind the selected PDF to another paper",
	);
	assert.match(
		validateIdentityReceipts(localBoundIdentity, [
			metadataReceipt(localBoundIdentity.title),
			doiReceipt(localBoundIdentity.title),
			vaultReceipt(localBoundIdentity.title),
			vaultDoiReceipt(),
		], {
			...localPdfEvidence,
			firstPageTitleCandidates: ["Entirely Different Article Title"],
		}).join("；"),
		/元数据标题与第一页标题证据冲突/,
	);
	assert.match(
		validateIdentityReceipts(localBoundIdentity, [
			metadataReceipt(localBoundIdentity.title),
			doiReceipt(localBoundIdentity.title),
			vaultReceipt(localBoundIdentity.title),
			vaultDoiReceipt(),
		], {
			...localPdfEvidence,
			metadataTitle: "",
			trustedMetadataTitle: "",
			firstPageText: "",
			firstPageTitleCandidates: [],
			fileName: "scan.pdf",
		}).join("；"),
		/没有可用于确定性身份绑定的标题证据/,
		"verified intake must fail closed when the PDF yields no deterministic title evidence",
	);

	const cyrillicIdentity = { ...identity, doi: "", title: "Анализ данных", citekey: "ivanov_2026" };
	assert.deepEqual(validateIdentityReceipts(cyrillicIdentity, [
		metadataReceipt("Анализ данных", ""),
		vaultReceipt("Анализ данных", [], ["анализ", "данных"]),
	]), []);

	const boundIdentity = bindIdentityMetadataFromReceipts({
		...identity,
		title: "Demo & Paper",
		authors: "Invented Author",
		year: "1999",
	}, [metadataReceipt("Demo &amp; Paper"), doiReceipt("Demo &amp; Paper")]);
	assert.equal(boundIdentity.title, "Demo & Paper");
	assert.equal(boundIdentity.authors, "Doe Jane; Roe Richard");
	assert.equal(boundIdentity.year, "2026");
	assert.equal(boundIdentity.doi, "10.1000/demo");

	const punctuationDoiIdentity = {
		...identity,
		title: "Punctuation DOI",
		doi: "10.1000/legal.",
	};
	const punctuationDoiReceipts = [
		metadataReceipt("Punctuation DOI", "10.1000/legal."),
		doiReceipt("Punctuation DOI", "10.1000/legal."),
		vaultReceipt("Punctuation DOI"),
		vaultDoiReceipt("10.1000/legal."),
	];
	assert.deepEqual(validateIdentityReceipts(punctuationDoiIdentity, punctuationDoiReceipts), []);
	assert.equal(
		bindIdentityMetadataFromReceipts({ ...punctuationDoiIdentity }, punctuationDoiReceipts).doi,
		"10.1000/legal.",
		"binding must preserve legal trailing DOI punctuation",
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
	assert.match(blocked.blocker, /有效 article\.md 回执/);
	const allowed = evaluateDraftPhase(options, "papers/x/article.md", false);
	assert.equal(allowed.run, true);
	const noSilentDowngrade = evaluateDraftPhase({ ...options, articleWikiSource: "auto" }, "", false);
	assert.equal(noSilentDowngrade.run, false);
	assert.match(noSilentDowngrade.blocker, /不做静默降级/);
	const metadataOnly = evaluateDraftPhase({
		...options,
		createArticleMarkdown: false,
		articleWikiSource: "auto",
	}, "", false);
	assert.equal(metadataOnly.run, true);
	assert.match(metadataOnly.downgradeNote, /元数据与用户说明/);

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

function testExactDuplicateCompletesMissingOutputs() {
	const options = { createArticleMarkdown: true, createArticleWiki: true };
	assert.deepEqual(planExactDuplicateOutputs(options, {
		sourcePath: "",
		analysisPath: "wiki/sources/cho_pan-cancer_2026.md",
	}), { needsMarkdown: true, needsWiki: false, noOp: false });
	assert.deepEqual(planExactDuplicateOutputs(options, {
		sourcePath: "papers/cho_pan-cancer_2026/article.md",
		analysisPath: "",
	}), { needsMarkdown: false, needsWiki: true, noOp: false });
	assert.deepEqual(planExactDuplicateOutputs(options, {
		sourcePath: "Clippings/Pan-cancer spatial atlas.md",
		analysisPath: "wiki/sources/cho_pan-cancer_2026.md",
	}), { needsMarkdown: false, needsWiki: false, noOp: true });
	assert.deepEqual(planExactDuplicateOutputs(options, {
		sourcePath: "",
		analysisPath: "",
	}), { needsMarkdown: true, needsWiki: true, noOp: false });
	const identity = {
		title: "Pan-cancer spatial atlas of tertiary lymphoid structures",
		doi: "10.1126/science.adz2742",
		citekey: "cho_pan-cancer_2026",
	};
	const receipts = [
		{
			tool: "vault_candidates", ok: true, argsSummary: "fixed query",
			data: {
				queryTerms: ["pan-cancer", "spatial", "atlas", "of", "tertiary", "lymphoid", "structures"],
				candidates: [
				{ path: "Clippings/Pan-cancer spatial atlas.md", title: identity.title },
				{ path: "wiki/sources/unrelated.md", title: "Unrelated paper" },
				],
			},
		},
		{
			tool: "vault_doi_search", ok: true, argsSummary: "doi",
			data: {
				query: identity.doi, dois: [identity.doi],
				candidates: [{ path: "wiki/sources/cho_pan-cancer_2026.md", title: identity.title }],
			},
		},
	];
	assert.deepEqual(resolveExactDuplicateLayers(identity, receipts), {
		sourcePath: "Clippings/Pan-cancer spatial atlas.md",
		analysisPath: "wiki/sources/cho_pan-cancer_2026.md",
		citekey: "cho_pan-cancer_2026",
		conflict: "",
	});
	assert.equal(resolveExactDuplicateCitekey(identity, receipts), "cho_pan-cancer_2026");
	assert.equal(resolveExactDuplicateCitekey(identity, [{
		tool: "vault_candidates", ok: true, data: {
			candidates: [{ path: "wiki/sources/forged_2026.md", title: "Unrelated paper" }],
		},
	}]), "", "model-like paths without receipt title/DOI evidence cannot steer citekey");
	const conflictingLayers = resolveExactDuplicateLayers(
		{ ...identity, duplicates: ["wiki/sources/forged_model_key.md"] },
		[{
			tool: "vault_doi_search", ok: true,
			data: {
				query: identity.doi,
				dois: [identity.doi],
				candidates: [
					{ path: "papers/receipt_source_key/article.md", title: identity.title },
					{ path: "wiki/sources/receipt_analysis_key.md", title: identity.title },
				],
			},
		}],
	);
	assert.match(conflictingLayers.conflict, /多个 citekey|citekey 不一致/);
	assert.equal(conflictingLayers.citekey, "", "model duplicate prose cannot resolve receipt-layer ambiguity");
	assert.equal(
		deriveBibliographicCitekey({
			authors: "Cho, K. S.; Liu, Y.",
			title: "Pan-cancer spatial atlas of tertiary lymphoid structures",
			year: "2026",
		}),
		"cho_pan_cancer_2026",
		"legacy Clippings receive a deterministic Crossref-bound key rather than a model-authored path",
	);
}

function testResolvedTitleTranslationMatchesCommittedDraft() {
	assert.equal(
		resolvePaperTitleZh({ title_zh: "身份阶段译名" }, { title_zh: "笔记阶段审校译名" }),
		"笔记阶段审校译名",
	);
	assert.equal(resolvePaperTitleZh({ title_zh: "身份阶段译名" }, { title_zh: "" }), "身份阶段译名");
	assert.equal(resolvePaperTitleZh(null, null), "");
}

async function testPhaseToolsetsAreRead() {
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
	const identityTools = buildIdentityTools(deps);
	const identityNames = identityTools.map((tool) => tool.name);
	assert.deepEqual(identityNames.filter((name) => name === "mineru_extract" || name === "write_note"), []);
	assert.deepEqual(identityNames.filter((name) => name === "vault_list" || name === "vault_read" || name === "vault_search"), []);
	assert.ok(identityNames.includes("crossref_search"));
	assert.ok(identityNames.includes("vault_candidates"));
	assert.ok(identityNames.includes("vault_candidate_read"));
	assert.ok(identityNames.includes("vault_doi_search"));
	assert.equal(identityNames[0], "vault_candidates", "local identity preflight must be the first exposed tool");
	const limitedCrossref = identityTools.find((tool) => tool.name === "crossref_search");
	const blockedBeforeVault = await limitedCrossref.execute({ query: "premature" }, createContext())
		.then(() => null, (error) => error);
	assert.match(blockedBeforeVault.message, /必须先调用 vault_candidates/);
	const gatedDoi = identityTools.find((tool) => tool.name === "crossref_doi");
	const blockedDoi = await gatedDoi.execute({ doi: "10.1000/demo" }, createContext())
		.then(() => null, (error) => error);
	assert.match(blockedDoi.message, /必须先调用 vault_candidates/);
	const identityVaultSearch = identityTools.find((tool) => tool.name === "vault_candidates");
	await identityVaultSearch.execute({}, createContext());
	const candidateRead = identityTools.find((tool) => tool.name === "vault_candidate_read");
	await assert.rejects(
		candidateRead.execute({ candidate_id: "../../diary/private.md" }, createContext()),
		/候选句柄无效/,
		"injected PDF text cannot turn candidate_id into an arbitrary Vault path",
	);
	await limitedCrossref.execute({ query: "first" }, createContext());
	await limitedCrossref.execute({ query: "second" }, createContext());
	const exhausted = await limitedCrossref.execute({ query: "third" }, createContext())
		.then(() => null, (error) => error);
	assert.match(exhausted.message, /最多调用两次/);

	const localDoiDeps = {
		...deps,
		http: {
			httpGetJson: async () => ({
				status: 200,
				json: { message: { DOI: "10.1000/local", title: ["Local PDF Paper"] } },
				text: "",
			}),
		},
	};
	const localDoiTools = buildIdentityTools(localDoiDeps, { doiCandidates: ["10.1000/local"] });
	await localDoiTools.find((tool) => tool.name === "vault_candidates")
		.execute({}, createContext());
	const localDoiSearch = localDoiTools.find((tool) => tool.name === "crossref_search");
	const blockedFuzzy = await localDoiSearch.execute({ query: "Local PDF Paper" }, createContext())
		.then(() => null, (error) => error);
	assert.match(blockedFuzzy.message, /必须先逐个调用 crossref_doi/);
	await localDoiTools.find((tool) => tool.name === "crossref_doi")
		.execute({ doi: "10.1000/local" }, createContext());
	const fuzzyAfterExact = await localDoiSearch.execute({ query: "Local PDF Paper" }, createContext());
	assert.equal(fuzzyAfterExact.summary, "1 条候选", "a local DOI may be a cited paper; title-bound fuzzy fallback remains available");

	const draftNames = buildDraftTools(deps).map((tool) => tool.name);
	assert.deepEqual(draftNames.filter((name) => name === "mineru_extract" || name === "write_note"), []);
	assert.deepEqual(draftNames.filter((name) => name === "crossref_search"), []);
	const boundDraftNames = buildDraftTools(deps, "papers/demo_2026/article.md").map((tool) => tool.name);
	assert.deepEqual(boundDraftNames, ["article_read"]);
}

async function testArticleHeadTitleGate() {
	assert.equal(
		articleMarkdownTitleMatches("# Cells &amp; Systems\n\nBody", "Cells & Systems"),
		true,
		"the pure pre-commit title gate must share entity normalization with read-back",
	);
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
	const multilingual = createFakeVault(new Map([
		["papers/korean/article.md", "# 공간 전사체학을 위한 그래프 기반 기초 모델\n\n서론"],
		["papers/arabic/article.md", "# نموذج تأسيسي قائم على الرسوم البيانية\n\nمقدمة"],
		["papers/chinese-short/article.md", "# 细胞命运\n\n正文"],
		["papers/entity/article.md", "# Cells &amp; Systems\n\nBody"],
		["papers/body-only/article.md", "# Other Title\n\nThe claimed Demo Paper appears only in body text."],
		["papers/later-h1/article.md", "# Wrong Package Title\n\n# Demo Paper\n\nBody"],
		["papers/fenced-h1/article.md", "---\ntitle: Wrong Package\n---\n\n```markdown\n# Demo Paper\n```\n\n# Wrong Package Title"],
		["papers/fake-close/article.md", "```text\n```not-a-close\n# Demo Paper\n```\n\n# Wrong Package Title"],
	]));
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/korean/article.md", "공간 전사체학을 위한 그래프 기반 기초 모델"),
		true,
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/arabic/article.md", "نموذج تأسيسي قائم على الرسوم البيانية"),
		true,
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/chinese-short/article.md", "细胞命运"),
		true,
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/entity/article.md", "Cells & Systems"),
		true,
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/body-only/article.md", "Demo Paper"),
		false,
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/later-h1/article.md", "Demo Paper"),
		false,
		"a later matching H1 must not override a conflicting package title",
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/fenced-h1/article.md", "Demo Paper"),
		false,
		"an H1 inside YAML or a fenced code block must not satisfy the package title gate",
	);
	assert.equal(
		await articleHeadContainsTitle({ app: multilingual }, "papers/fake-close/article.md", "Demo Paper"),
		false,
		"a fenced line with trailing info is not a CommonMark closing fence",
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


(async () => {
	testExtractFirstJsonObject();
	await testLoopToolRoundtripAndReceipts();
	await testLoopRepairsNonConsecutiveProtocolErrors();
	await testLoopCancellationAbortsSignalDuringTools();
	await testLoopBudgetAndTruncation();
	await testVaultReadAndListScoping();
	await testVaultAncestorLinksAreRejected();
	await testBoundArticleReadBypassesIndexLag();
	await testVaultSearchScopeFiltering();
	await testVaultDoiExactSearch();
	await testCrossrefDomainTools();
	await testWebSearchToolValidation();
	testMineruCliArgsAndReadiness();
	testResolveMineruCommand();
	await testMineruPublishPipeline();
	await testCommitSourceNoteSafety();
	await testArticlePathBinding();
	await testResolveUniqueCitekey();
	testIdentityAndDraftContracts();
	await testLocalPdfIdentityPreflight();
	testIdentityReceiptGate();
	testDraftGateAndStatusSemantics();
	testExactDuplicateCompletesMissingOutputs();
	testResolvedTitleTranslationMatchesCommittedDraft();
	await testPhaseToolsetsAreRead();
	await testArticleHeadTitleGate();
	testYamlScalarSafety();
	testParsePaperIngestInput();
	testArtifactsPersistenceRoundTrip();
	console.log("AGENT_LOOP_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
