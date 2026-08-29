"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");

class ObsidianBase {}
class ObsidianTFile extends ObsidianBase {
	constructor(values = {}) {
		super();
		Object.assign(this, values);
	}
}
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
const DashboardPlugin = require(path.join(pluginRoot, "main.js"));

const hookEntry = path.join(pluginRoot, "tests", "vault-context-hooks.ts");
const hookBuild = esbuild.buildSync({
	stdin: {
		contents: [
			'export { migrateLegacySettingsKeys } from "./src/runtime/settings";',
			"export { LexicalVaultRetriever, tokenizeForLexicalRetrieval }",
			'  from "./src/query/lexical-retrieval";',
			'export { readVaultEvidencePackets, makeVaultSourcePathResolver }',
			'  from "./src/services/vault-evidence";',
			'export { saveQueryAnswerNote, sanitizeQueryNoteFilename }',
			'  from "./src/services/query-note";',
			'export { normalizeQueryVaultSources } from "./src/query/normalization";',
			'export { ProcessExecutionService, resolveCliProcessCwd }',
			'  from "./src/runtime/process-execution";',
			'export { DirectQueryService } from "./src/query/direct-query-service";',
			'export { QueryWikiView } from "./src/views/query-wiki";',
			'export { MAX_VAULT_IMAGE_BYTES } from "./src/config";',
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
	migrateLegacySettingsKeys,
	LexicalVaultRetriever,
	tokenizeForLexicalRetrieval,
	readVaultEvidencePackets,
	makeVaultSourcePathResolver,
	normalizeQueryVaultSources,
	saveQueryAnswerNote,
	sanitizeQueryNoteFilename,
	ProcessExecutionService,
	resolveCliProcessCwd,
	DirectQueryService,
	QueryWikiView,
	MAX_VAULT_IMAGE_BYTES,
} = hookModule.exports;
Module._load = originalLoad;

function testMigrateLegacySettingsKeys() {
	const migrated = migrateLegacySettingsKeys({
		projectRoot: "D:\\old-workspace",
		querySessionLimit: 5,
	});
	assert.equal(migrated.changed, true);
	assert.equal(migrated.settings.toolkitRoot, "D:\\old-workspace");
	assert.equal("projectRoot" in migrated.settings, false);
	assert.equal(migrated.settings.querySessionLimit, 5);

	const kept = migrateLegacySettingsKeys({ projectRoot: "D:\\old", toolkitRoot: "D:\\new" });
	assert.equal(kept.changed, true);
	assert.equal(kept.settings.toolkitRoot, "D:\\new");
	assert.equal("projectRoot" in kept.settings, false);

	const untouched = migrateLegacySettingsKeys({ toolkitRoot: "D:\\new" });
	assert.equal(untouched.changed, false);
	assert.equal(untouched.settings.toolkitRoot, "D:\\new");
}

function testTokenizeForLexicalRetrieval() {
	const tokens = tokenizeForLexicalRetrieval("细胞类型 SingleR 注释");
	assert.ok(tokens.includes("singler"));
	assert.ok(tokens.includes("细胞"));
	assert.ok(tokens.includes("类型"));
	assert.ok(!tokens.includes("细胞类型"));
	assert.deepStrictEqual(tokenizeForLexicalRetrieval(""), []);

	// The cap is a per-call budget: query side 24, index side may keep more.
	const manyTokens = Array.from(
		{ length: 40 },
		(_, index) => `w${String(index).padStart(2, "0")}x`,
	).join(" ");
	assert.equal(tokenizeForLexicalRetrieval(manyTokens).length, 24);
	assert.equal(tokenizeForLexicalRetrieval(manyTokens, 2_000).length, 40);
	assert.equal(tokenizeForLexicalRetrieval(manyTokens, Number.POSITIVE_INFINITY).length, 40);
}

function makeLexicalApp(notes) {
	const noteByPath = new Map(notes.map((note) => [note.path, note]));
	return {
		vault: {
			getMarkdownFiles: () => notes.map((note) => new ObsidianTFile({
				path: note.path,
				basename: path.basename(note.path, ".md"),
				stat: { mtime: note.mtime || 0, size: 128 },
			})),
			cachedRead: async (file) => noteByPath.get(file.path)?.body || "",
		},
		metadataCache: {
			getFileCache: (file) => {
				const note = noteByPath.get(file.path);
				if (!note) return null;
				return { frontmatter: { title: note.title || "", tags: note.tags || [] }, tags: [] };
			},
		},
	};
}

async function testLexicalRetriever() {
	const notes = [
		{
			path: "wiki/methods/singler-annotation.md",
			mtime: 5,
			body: "SingleR 细胞类型注释流程，依赖 celldex 参考集。",
			tags: ["single-cell"],
			title: "SingleR 注释",
		},
		{
			path: "wiki/concepts/entropy.md",
			mtime: 4,
			body: "信息熵与热力学熵的区别。",
			tags: [],
			title: "熵",
		},
		{
			path: "papers/old.md",
			mtime: 3,
			body: "无关内容。",
			tags: [],
			title: "旧文献",
		},
	];
	const retriever = new LexicalVaultRetriever(makeLexicalApp(notes));
	const trace = await retriever.retrieve("SingleR 细胞类型注释怎么做？");
	assert.equal(trace.stage, "in-plugin-lexical");
	assert.equal(trace.engine, "in-plugin-lexical");
	assert.equal(trace.retrieval_label, "内置词法检索");
	assert.equal(trace.retriever.selected, "in-plugin-lexical");
	assert.ok(trace.lexical_terms.includes("singler"));
	assert.ok(trace.candidate_paths.includes("wiki/methods/singler-annotation.md"));
	assert.ok(!trace.candidate_paths.includes("papers/old.md"));
	// lexical_seeds must stay page candidates (path/title objects), not tokens.
	assert.ok(trace.lexical_seeds.length >= 1);
	assert.ok(trace.lexical_seeds.every((seed) => seed.path && seed.title));

	const chineseTrace = await retriever.retrieve("信息熵");
	assert.ok(chineseTrace.candidate_paths.includes("wiki/concepts/entropy.md"));

	const emptyTrace = await retriever.retrieve("量子色动力学 QCD");
	assert.deepStrictEqual(emptyTrace.candidate_paths, []);
	assert.equal(emptyTrace.lexical_seeds.length, 0);

	const expandedTrace = await retriever.retrieve("怎么做注释", ["SingleR"]);
	assert.ok(expandedTrace.candidate_paths.includes("wiki/methods/singler-annotation.md"));
	assert.ok(expandedTrace.lexical_terms.includes("singler"));
	assert.ok(expandedTrace.lexical_seeds.some((seed) => (
		seed.path === "wiki/methods/singler-annotation.md"
		&& String(seed.title).includes("SingleR 注释")
	)));

	notes[2].body = "现在讨论 SingleR 和细胞注释。";
	notes[2].mtime = 9;
	const refreshed = await retriever.retrieve("SingleR");
	assert.ok(refreshed.candidate_paths.includes("papers/old.md"));
}

async function testBodyTokenLimit() {
	// The target term appears after 100 earlier unique body tokens; with the
	// old shared 48-token cap it never entered the index.
	const body = [
		...Array.from({ length: 100 }, (_, index) => `term${index}`),
		"late-target-marker",
	].join(" ");
	const retriever = new LexicalVaultRetriever(makeLexicalApp([
		{ path: "wiki/long-note.md", mtime: 1, body, title: "长笔记", tags: [] },
	]));
	const trace = await retriever.retrieve("late-target-marker");
	assert.ok(trace.candidate_paths.includes("wiki/long-note.md"));
}

async function testBodyIndexBudgetResume() {
	const notes = [
		{ path: "wiki/a.md", mtime: 10, body: "alpha-body-marker", title: "Alpha", tags: [] },
		{ path: "wiki/b.md", mtime: 5, body: "beta-late-marker", title: "Beta", tags: [] },
	];
	// Calls: deadline, budget check A (inside), budget check B (over budget).
	const clockQueue = [0, 0, Number.MAX_SAFE_INTEGER];
	const clock = () => (clockQueue.length ? clockQueue.shift() : 0);
	const retriever = new LexicalVaultRetriever(makeLexicalApp(notes), { now: clock });

	const firstTrace = await retriever.retrieve("beta-late-marker");
	assert.deepStrictEqual(firstTrace.candidate_paths, []);

	// The untouched-mtime file whose body was never indexed must be completed
	// on the next refresh instead of being skipped forever.
	const secondTrace = await retriever.retrieve("beta-late-marker");
	assert.ok(secondTrace.candidate_paths.includes("wiki/b.md"));

	const alphaTrace = await retriever.retrieve("alpha-body-marker");
	assert.ok(alphaTrace.candidate_paths.includes("wiki/a.md"));
}

async function testExpansionTermQuota() {
	const longQuestion = "我想了解单细胞转录组数据分析中参考集构建细胞类型注释方法比较与基准评估的实际应用有哪些";
	const retriever = new LexicalVaultRetriever(makeLexicalApp([
		{
			path: "wiki/methods/singler.md",
			mtime: 1,
			body: "SingleR 基于 celldex 参考集做注释。",
			title: "SingleR",
			tags: [],
		},
	]));
	const trace = await retriever.retrieve(longQuestion, ["SingleR", "celldex"]);
	// Expansion terms keep a reserved quota even when the question alone
	// produces more than the combined token budget.
	assert.ok(trace.lexical_terms.includes("singler"));
	assert.ok(trace.lexical_terms.includes("celldex"));
	assert.ok(trace.lexical_terms.length <= 24);
	assert.ok(trace.candidate_paths.includes("wiki/methods/singler.md"));
}

async function testReadVaultEvidencePackets() {
	const fileA = new ObsidianTFile({ path: "wiki/a.md", stat: { size: 10 } });
	const app = {
		vault: {
			getAbstractFileByPath: (value) => (value === "wiki/a.md" ? fileA : null),
			cachedRead: async (file) => (file.path === "wiki/a.md" ? "内容A" : ""),
		},
	};
	const packets = await readVaultEvidencePackets(app, {
		candidate_paths: [
			"wiki/a.md",
			"knowledge-base/wiki/b.md",
			"../outside.md",
			"notes/image.png",
			"wiki/a.md",
		],
	});
	assert.equal(packets.length, 1);
	assert.equal(packets[0].path, "wiki/a.md");
	assert.equal(packets[0].wikilink, "[[wiki/a]]");
	assert.equal(packets[0].content, "内容A");
	assert.deepStrictEqual(await readVaultEvidencePackets(app, { candidate_paths: [] }), []);

	// A real top-level knowledge-base/ folder must win over the legacy prefix
	// strip; the strip only applies when the exact path does not exist.
	const fileByPath = {
		"knowledge-base/wiki/dup.md": new ObsidianTFile({
			path: "knowledge-base/wiki/dup.md",
			stat: { size: 10 },
		}),
		"wiki/dup.md": new ObsidianTFile({ path: "wiki/dup.md", stat: { size: 10 } }),
		"wiki/only-legacy.md": new ObsidianTFile({
			path: "wiki/only-legacy.md",
			stat: { size: 10 },
		}),
	};
	const contentByPath = {
		"knowledge-base/wiki/dup.md": "顶层目录内容",
		"wiki/dup.md": "精确路径内容",
		"wiki/only-legacy.md": "仅旧路径内容",
	};
	const mixedApp = {
		vault: {
			getAbstractFileByPath: (value) => fileByPath[value] || null,
			cachedRead: async (file) => contentByPath[file.path] || "",
		},
	};
	const mixed = await readVaultEvidencePackets(mixedApp, {
		candidate_paths: ["knowledge-base/wiki/dup.md", "knowledge-base/wiki/only-legacy.md"],
	});
	assert.equal(mixed.length, 2);
	assert.equal(mixed[0].path, "knowledge-base/wiki/dup.md");
	assert.equal(mixed[0].content, "顶层目录内容");
	assert.equal(mixed[1].path, "wiki/only-legacy.md");
	assert.equal(mixed[1].content, "仅旧路径内容");
}

async function testRetrievalDispatcher() {
	const plugin = Object.create(DashboardPlugin.prototype);
	const lexicalCalls = [];
	const makeLexicalTrace = () => ({
		stage: "in-plugin-lexical",
		engine: "in-plugin-lexical",
		lexical_terms: ["x"],
		lexical_seeds: [{ path: "wiki/a.md", title: "A", score: 6 }],
		candidate_paths: ["wiki/a.md"],
		retriever: { selected: "in-plugin-lexical" },
	});
	plugin.getLexicalRetriever = () => ({
		retrieve: async (question, expandedTerms) => {
			lexicalCalls.push({ question, expandedTerms });
			return makeLexicalTrace();
		},
	});

	plugin.settings = { toolkitRoot: "", pythonExecutable: "" };
	const defaultTrace = await plugin.runVaultRetrievalPreflight("run-1", "问题", []);
	assert.equal(defaultTrace.engine, "in-plugin-lexical");
	assert.equal(defaultTrace.retriever_fallback, undefined);
	assert.equal(defaultTrace.retriever.reason, undefined);
	assert.equal(lexicalCalls.length, 1);

	const toolkitDir = fs.mkdtempSync(path.join(os.tmpdir(), "rar-toolkit-"));
	try {
		plugin.settings = { toolkitRoot: toolkitDir, pythonExecutable: process.execPath };
		const missingTrace = await plugin.runVaultRetrievalPreflight("run-2", "问题", []);
		assert.equal(missingTrace.engine, "in-plugin-lexical");
		assert.equal(missingTrace.retriever_fallback, undefined);
		assert.match(String(missingTrace.retriever.reason), /检索脚本不存在/);
		assert.equal(lexicalCalls.length, 2);

		const scriptDir = path.join(toolkitDir, "tool-library", "scripts");
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, "retrieve_vault.py"), "print('ok')\n");
		let delegated = null;
		plugin.directQueryService = {
			runRetrievalPreflight: async (runId, question, expandedTerms) => {
				delegated = { runId, question, expandedTerms };
				return {
					stage: "lexical-seed+ppr",
					lexical_seeds: [{ path: "wiki/a.md" }],
					candidate_paths: ["wiki/a.md"],
				};
			},
		};
		const toolkitTrace = await plugin.runVaultRetrievalPreflight("run-3", "问题", ["term"]);
		assert.equal(toolkitTrace.stage, "lexical-seed+ppr");
		assert.equal(delegated.runId, "run-3");
		assert.deepStrictEqual(delegated.expandedTerms, ["term"]);
		assert.equal(lexicalCalls.length, 2);

		plugin.directQueryService = {
			runRetrievalPreflight: async () => {
				throw new Error("Python 进程退出码 1");
			},
		};
		const failedTrace = await plugin.runVaultRetrievalPreflight("run-4", "问题", []);
		assert.equal(failedTrace.engine, "in-plugin-lexical");
		assert.equal(failedTrace.retriever_fallback.used, true);
		assert.equal(failedTrace.retriever_fallback.from, "toolkit");
		assert.equal(failedTrace.retriever_fallback.to, "in-plugin-lexical");
		assert.match(String(failedTrace.retriever_fallback.reason), /工具链检索失败/);
		assert.match(String(failedTrace.retriever_fallback.reason), /Python 进程退出码 1/);
		assert.equal(lexicalCalls.length, 3);
	} finally {
		fs.rmSync(toolkitDir, { recursive: true, force: true });
	}
}

async function testKeywordExpansionTrigger() {
	// Regression: expansion must trigger whenever there are no candidate
	// paths, even when the trace already carries query tokens or string seeds.
	const profile = {
		id: "provider-test",
		name: "test-provider",
		type: "openai-compatible",
		baseUrl: "https://api.example.test",
		model: "test-model",
		secretId: "test-secret",
		timeoutSeconds: 20,
		capabilities: { streaming: false, pdf: false, vision: false },
		lastTest: { ok: true },
	};
	const preflightCalls = [];
	const providerCalls = [];
	const service = new DirectQueryService({
		state: { directQueryRuns: new Map() },
		processExecution: {},
		getSettings: () => ({ toolkitRoot: "" }),
		getProviderProfile: () => profile,
		createProvider: () => ({
			complete: async (request) => {
				providerCalls.push(request);
				if (providerCalls.length === 1) {
					return { text: '{"keywords":["SingleR","celldex"]}' };
				}
				return { text: "根据 [[wiki/methods/singler.md]] 的回答。" };
			},
		}),
		normalizeProviderError: (error) => ({
			type: "error",
			status: 0,
			endpoint: "",
			message: String(error?.message || error),
		}),
		runRetrievalPreflight: async (runId, question, expandedTerms = []) => {
			preflightCalls.push({ runId, question, expandedTerms });
			if (expandedTerms.length === 0) {
				return {
					stage: "in-plugin-lexical",
					lexical_terms: ["细胞", "注释"],
					lexical_seeds: ["细胞", "注释"],
					candidate_paths: [],
					retriever: { selected: "in-plugin-lexical" },
				};
			}
			return {
				stage: "in-plugin-lexical",
				lexical_terms: ["singler", "celldex", "细胞", "注释"],
				lexical_seeds: [{ path: "wiki/methods/singler.md", title: "SingleR", score: 6 }],
				candidate_paths: ["wiki/methods/singler.md"],
				retriever: { selected: "in-plugin-lexical" },
			};
		},
		readEvidencePacket: async (trace) => trace.candidate_paths.map((candidatePath) => ({
			path: candidatePath,
			wikilink: `[[${String(candidatePath).replace(/\.md$/i, "")}]]`,
			content: "证据内容",
		})),
		readVaultImageData: async () => {
			throw new Error("unused");
		},
	});
	const result = await service.run(
		"run-expand",
		"profile-test",
		"细胞注释有哪些方法？",
		[],
		"vault",
	);
	assert.equal(result.exitCode, 0);
	assert.equal(preflightCalls.length, 2);
	assert.deepStrictEqual(preflightCalls[1].expandedTerms, ["SingleR", "celldex"]);
	assert.equal(providerCalls.length, 2);
	const retrievalEvent = result.events.find((event) => event.type === "retrieval-preflight");
	assert.equal(retrievalEvent.payload.keyword_expansion.used, true);
	assert.deepStrictEqual(retrievalEvent.payload.keyword_expansion.terms, ["SingleR", "celldex"]);
	assert.ok(result.stdout.includes("[[wiki/methods/singler.md]]"));
}

function makeFakeElement(tag) {
	const element = {
		tag,
		cls: "",
		text: "",
		attr: {},
		children: [],
		disabled: false,
		listeners: {},
		createEl(childTag, opts = {}) {
			const child = makeFakeElement(childTag);
			if (opts.cls) child.cls = opts.cls;
			if (opts.text !== undefined) child.text = String(opts.text);
			if (opts.attr) child.attr = opts.attr;
			element.children.push(child);
			return child;
		},
		createDiv(opts) {
			return element.createEl("div", opts);
		},
		createSpan(opts) {
			return element.createEl("span", opts);
		},
		addEventListener(type, listener) {
			element.listeners[type] = listener;
		},
	};
	return element;
}

function collectElements(element, into = []) {
	into.push(element);
	for (const child of element.children) collectElements(child, into);
	return into;
}

function makeTraceRenderView(opened) {
	const viewLike = {
		app: { workspace: { openLinkText: (pathValue) => opened.push(pathValue) } },
	};
	viewLike.displayRetrievalStage = QueryWikiView.prototype.displayRetrievalStage;
	viewLike.displayRetrieverName = QueryWikiView.prototype.displayRetrieverName;
	viewLike.renderTraceGroup = QueryWikiView.prototype.renderTraceGroup;
	viewLike.renderRetrievalTrace = QueryWikiView.prototype.renderRetrievalTrace;
	return viewLike;
}

function testQueryWikiTraceRendering() {
	const opened = [];
	const viewLike = makeTraceRenderView(opened);

	// In-plugin lexical traces must render clickable page candidates, not
	// disabled buttons without a path or title.
	const lexicalTrace = {
		stage: "in-plugin-lexical",
		retrieval_label: "内置词法检索",
		lexical_terms: ["singler", "细胞"],
		lexical_seeds: [{
			path: "wiki/methods/singler-annotation.md",
			title: "SingleR 注释",
			score: 12,
		}],
		candidate_paths: ["wiki/methods/singler-annotation.md"],
		graph_expansion: [],
		retriever: { selected: "in-plugin-lexical" },
	};
	const lexicalRoot = makeFakeElement("root");
	viewLike.renderRetrievalTrace(lexicalRoot, lexicalTrace);
	const lexicalNodes = collectElements(lexicalRoot);
	assert.ok(lexicalNodes.some((node) => (
		node.text.includes("内置词法检索") && node.text.includes("1 个种子")
	)));
	assert.ok(lexicalNodes.some((node) => node.text === "查询词：singler、细胞"));
	const seedButton = lexicalNodes.find(
		(node) => node.tag === "button" && node.text === "SingleR 注释",
	);
	assert.ok(seedButton, "lexical seed should render as a titled button");
	assert.equal(seedButton.disabled, false);
	assert.equal(seedButton.attr.title, "wiki/methods/singler-annotation.md");
	seedButton.listeners.click();
	assert.ok(opened.includes("wiki/methods/singler-annotation.md"));

	// A toolkit failure fallback must surface its real reason in the trace.
	const failedRoot = makeFakeElement("root");
	viewLike.renderRetrievalTrace(failedRoot, {
		stage: "in-plugin-lexical",
		retrieval_label: "内置词法检索",
		lexical_terms: ["x"],
		lexical_seeds: [],
		candidate_paths: [],
		graph_expansion: [],
		retriever_fallback: {
			used: true,
			from: "toolkit",
			to: "in-plugin-lexical",
			reason: "工具链检索失败，已改用内置词法检索：Python 进程退出码 1",
		},
	});
	const failedNodes = collectElements(failedRoot);
	assert.ok(failedNodes.some((node) => (
		node.text.includes("检索器回退：Research Vault Toolkit → 内置词法检索")
		&& node.text.includes("Python 进程退出码 1")
	)));

	// A configured-but-unavailable toolkit is reported without fallback wording.
	const unavailableRoot = makeFakeElement("root");
	viewLike.renderRetrievalTrace(unavailableRoot, {
		stage: "in-plugin-lexical",
		lexical_seeds: [],
		graph_expansion: [],
		retriever: {
			selected: "in-plugin-lexical",
			reason: "检索脚本不存在：/tool/tool-library/scripts/retrieve_vault.py",
		},
	});
	const unavailableNodes = collectElements(unavailableRoot);
	assert.ok(unavailableNodes.some((node) => (
		node.text.includes("检索器：内置词法检索（检索脚本不存在")
	)));

	// The original "no reliable seeds → direction index" fallback stays intact.
	const directionRoot = makeFakeElement("root");
	viewLike.renderRetrievalTrace(directionRoot, {
		stage: "no-match-fallback",
		retrieval_label: "NoMatch+Index",
		lexical_seeds: [],
		graph_expansion: [],
		fallback: { used: true, paths: ["notes/index.md"], reason: "" },
	});
	const directionNodes = collectElements(directionRoot);
	assert.ok(directionNodes.some(
		(node) => node.text === "未找到可靠词法种子，已回退到方向索引。",
	));
	const directionButton = directionNodes.find(
		(node) => node.tag === "button" && node.text === "notes/index",
	);
	assert.ok(directionButton);
	assert.equal(directionButton.disabled, false);
}

async function testImageAttachmentVaultAccess() {
	const plugin = Object.create(DashboardPlugin.prototype);
	const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const imageFile = new ObsidianTFile({
		path: "wiki/assets/figures/example/figure-1.png",
		stat: { mtime: 1, size: bytes.length },
	});
	const missingStatFile = new ObsidianTFile({
		path: "wiki/assets/figures/example/figure-2.png",
		stat: { mtime: 1, size: 9 * 1024 * 1024 },
	});
	const misReportedFile = new ObsidianTFile({
		path: "wiki/assets/figures/example/figure-3.png",
		stat: { mtime: 1, size: 3 },
	});
	const misReportedBytes = Buffer.alloc(2048, 7);
	const oversizedReadFile = new ObsidianTFile({
		path: "wiki/assets/figures/example/figure-4.png",
		stat: { mtime: 1, size: 128 },
	});
	plugin.app = {
		vault: {
			getAbstractFileByPath: (value) => {
				if (value === imageFile.path) return imageFile;
				if (value === missingStatFile.path) return missingStatFile;
				if (value === misReportedFile.path) return misReportedFile;
				if (value === oversizedReadFile.path) return oversizedReadFile;
				return null;
			},
			readBinary: async (file) => {
				if (file === imageFile) return bytes;
				if (file === misReportedFile) return misReportedBytes;
				if (file === oversizedReadFile) return Buffer.alloc(MAX_VAULT_IMAGE_BYTES + 1);
				return Buffer.alloc(0);
			},
		},
	};
	const payload = await plugin.readVaultImageData({
		path: "wiki/assets/figures/example/figure-1.png",
		name: "figure-1.png",
	});
	assert.equal(payload.attachment.size, bytes.length);
	assert.ok(payload.content.image_url.url.startsWith("data:image/png;base64,"));
	assert.ok(
		payload.content.image_url.url.endsWith(bytes.toString("base64")),
	);

	// A stale stat.size must not leak into the attachment: the size reported
	// to the provider is the number of bytes actually read.
	const misReported = await plugin.readVaultImageData({
		path: misReportedFile.path,
	});
	assert.equal(misReported.attachment.size, misReportedBytes.length);
	assert.equal(
		misReported.content.image_url.url.length,
		`data:image/png;base64,`.length + misReportedBytes.toString("base64").length,
	);

	await assert.rejects(
		() => plugin.readVaultImageData({ path: "wiki/assets/figures/missing.png" }),
		(error) => /不存在于当前 Vault/.test(error.message),
	);
	await assert.rejects(
		() => plugin.readVaultImageData({ path: "wiki/assets/../../etc/passwd.png" }),
		(error) => /超出当前 Vault/.test(error.message),
	);
	await assert.rejects(
		() => plugin.readVaultImageData({ path: "wiki/assets/figures/example/figure-2.png" }),
		(error) => /MiB 上限/.test(error.message),
	);
	// TOCTOU: bytes read can exceed the stale stat.size — still rejected.
	await assert.rejects(
		() => plugin.readVaultImageData({ path: "wiki/assets/figures/example/figure-4.png" }),
		(error) => /MiB 上限/.test(error.message),
	);
	await assert.rejects(
		() => plugin.readVaultImageData({ path: "wiki/notes/record.txt" }),
		(error) => /仅支持 Vault 内/.test(error.message),
	);
}

async function testVaultSourcePathEndToEnd() {
	const contentByPath = {
		"knowledge-base/wiki/dup.md": "顶层目录内容",
		"wiki/dup.md": "精确路径内容",
		"wiki/only-legacy.md": "仅旧路径内容",
	};
	const fileByPath = Object.fromEntries(Object.entries(contentByPath).map((
		[filePath, content],
	) => [filePath, new ObsidianTFile({ path: filePath, stat: { size: content.length } })]));
	const app = {
		vault: {
			getAbstractFileByPath: (value) => fileByPath[value] || null,
			cachedRead: async (file) => contentByPath[file.path] || "",
		},
	};

	// Evidence layer reads both real files without rewriting their paths.
	const packets = await readVaultEvidencePackets(app, {
		candidate_paths: ["knowledge-base/wiki/dup.md", "wiki/dup.md"],
	});
	assert.deepStrictEqual(packets.map((packet) => packet.path), [
		"knowledge-base/wiki/dup.md",
		"wiki/dup.md",
	]);

	// buildRetrievalResult keeps those paths in vault_sources.
	const payload = DirectQueryService.prototype.buildRetrievalResult(
		"对比 [[knowledge-base/wiki/dup]] 与 [[wiki/dup]]。",
		packets,
		{ fallback: { used: false, paths: [] } },
		{
			id: "provider-test",
			name: "test-provider",
			type: "openai-compatible",
			baseUrl: "https://api.example.test",
			model: "test-model",
			timeoutSeconds: 20,
			capabilities: { streaming: false, pdf: false, vision: false },
			lastTest: { ok: true },
		},
	);
	assert.deepStrictEqual(payload.vault_sources.map((source) => source.path), [
		"knowledge-base/wiki/dup.md",
		"wiki/dup.md",
	]);

	// Source normalization resolves against the Vault: exact paths win, both
	// distinct sources survive dedupe, and only missing exact paths fall back
	// to the legacy prefix strip.
	const normalized = normalizeQueryVaultSources(payload.vault_sources, {
		resolveVaultPath: makeVaultSourcePathResolver(app),
	});
	assert.deepStrictEqual(normalized.map((source) => source.path), [
		"knowledge-base/wiki/dup.md",
		"wiki/dup.md",
	]);
	assert.deepStrictEqual(normalized.map((source) => source.cited), [true, true]);

	const resolver = makeVaultSourcePathResolver(app);
	assert.equal(resolver("knowledge-base/wiki/only-legacy.md"), "wiki/only-legacy.md");
	assert.equal(resolver("knowledge-base/wiki/ghost.md"), "knowledge-base/wiki/ghost.md");
	assert.equal(
		normalizeQueryVaultSources(
			[{ path: "wiki/dup.md", cited: true }, { path: "WIKI/DUP.MD", cited: true }],
			{ resolveVaultPath: resolver },
		).length,
		1,
	);

	// Persisted sessions go through the same vault-aware resolution, keeping
	// both same-named sources distinct across the load path.
	const plugin = Object.create(DashboardPlugin.prototype);
	plugin.app = app;
	plugin.settings = { queryMessageLimit: 50 };
	const session = plugin.normalizeQuerySession({
		id: "session-1",
		messages: [{
			id: "message-1",
			role: "assistant",
			content: "回答",
			status: "done",
			vaultSources: [
				{ path: "knowledge-base/wiki/dup.md", cited: true },
				{ path: "wiki/dup.md", cited: true },
				{ path: "knowledge-base/wiki/only-legacy.md", cited: true },
			],
		}],
	});
	assert.deepStrictEqual(
		session.messages[0].vaultSources.map((source) => source.path),
		["knowledge-base/wiki/dup.md", "wiki/dup.md", "wiki/only-legacy.md"],
	);
}

function testCliProcessCwd() {
	// Independent CLI processes never spawn inside a missing toolkit root.
	assert.equal(resolveCliProcessCwd(""), process.cwd());
	assert.equal(resolveCliProcessCwd("   "), process.cwd());
	assert.equal(resolveCliProcessCwd("Z:/definitely/not/a/real/dir"), process.cwd());
	assert.equal(resolveCliProcessCwd(os.tmpdir()), os.tmpdir());
}

async function testRunVaultActionToolkitGuard() {
	const service = Object.create(ProcessExecutionService.prototype);
	await assert.rejects(
		() => service.runVaultAction({
			runId: "guard-1",
			action: { id: "vault-retrieval", label: "知识库检索", writes: false },
			input: "",
			executionConfig: null,
			settings: { toolkitRoot: "" },
		}),
		(error) => /未配置工具包目录/.test(error.message),
	);

	const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rar-empty-root-"));
	try {
		await assert.rejects(
			() => service.runVaultAction({
				runId: "guard-2",
				action: { id: "vault-retrieval", label: "知识库检索", writes: false },
				input: "",
				executionConfig: null,
				settings: { toolkitRoot: emptyRoot },
			}),
			(error) => /统一 runner 不存在/.test(error.message),
		);
		// The guard must run before any stop-file directory is created.
		assert.equal(fs.existsSync(path.join(emptyRoot, "tool-library")), false);
	} finally {
		fs.rmSync(emptyRoot, { recursive: true, force: true });
	}
}

function makeQueryNoteApp(createdPaths) {
	return {
		vault: {
			existing: new Set(),
			getAbstractFileByPath(value) {
				return this.existing.has(value) || createdPaths.has(value) ? { path: value } : null;
			},
			async createFolder(segment) {
				this.existing.add(segment);
			},
			async create(filePath, content) {
				createdPaths.set(filePath, content);
				return { path: filePath };
			},
		},
	};
}

async function testSaveQueryAnswerNote() {
	const createdPaths = new Map();
	const app = makeQueryNoteApp(createdPaths);
	const savedPath = await saveQueryAnswerNote(app, {
		folder: "wiki/qa",
		question: "RNA-seq 是什么？",
		answer: "RNA-seq 是转录组测序。",
		sources: ["wiki/methods/rna-seq.md", "wiki/methods/rna-seq.md", "notes/other.md"],
		sessionTitle: "知识库对话",
		createdAt: "2026-08-29T12:30:00.000Z",
	});
	assert.match(savedPath, /^wiki\/qa\/\d{8}-\d{4} RNA-seq 是什么？\.md$/);
	const content = createdPaths.get(savedPath);
	assert.ok(content.includes('"title: RNA-seq 是什么？"') || content.includes("title:"));
	assert.ok(content.includes("type: qa"));
	assert.ok(content.includes("  - qa"));
	assert.ok(content.includes("# RNA-seq 是什么？"));
	assert.ok(content.includes("RNA-seq 是转录组测序。"));
	assert.ok(content.includes("- [[wiki/methods/rna-seq]]"));
	assert.ok(content.includes("- [[notes/other]]"));
	assert.equal(content.match(/\[\[wiki\/methods\/rna-seq\]\]/g).length, 1, "duplicate sources dedupe");

	// Same question again -> a distinct file, no overwrite.
	const secondPath = await saveQueryAnswerNote(app, {
		folder: "wiki/qa",
		question: "RNA-seq 是什么？",
		answer: "第二次回答",
		sources: [],
		sessionTitle: "知识库对话",
		createdAt: "2026-08-29T12:30:00.000Z",
	});
	assert.notEqual(secondPath, savedPath);
	assert.match(secondPath, / RNA-seq 是什么？ 2\.md$/);

	// Unsafe filenames are sanitized; empty folder falls back to wiki/qa.
	assert.equal(sanitizeQueryNoteFilename('a/b\\c:d*e?"f<g>|i'), "a b c d e f g i");
	const fallbackPath = await saveQueryAnswerNote(app, {
		folder: "  ",
		question: "  ",
		answer: "回答",
		sources: [],
		sessionTitle: "会话",
	});
	assert.match(fallbackPath, /^wiki\/qa\/\d{8}-\d{4} 未命名问答\.md$/);

	await assert.rejects(
		() => saveQueryAnswerNote(app, {
			folder: "../outside",
			question: "x",
			answer: "y",
			sources: [],
			sessionTitle: "s",
		}),
		(error) => /超出当前 Vault/.test(error.message),
	);

	// Plugin-level entry: question lookup, empty-answer rejection.
	const plugin = Object.create(DashboardPlugin.prototype);
	plugin.app = app;
	plugin.settings = { queryNotesFolder: "wiki/qa" };
	plugin.querySessions = [{
		id: "session-1",
		title: "RNA-seq 学习",
		retrievalMode: "vault",
		queryBackendId: "codex-cli",
		createdAt: "2026-08-29T12:00:00.000Z",
		updatedAt: "2026-08-29T12:00:00.000Z",
		messages: [
			{ id: "m1", role: "user", content: "RNA-seq 是什么？", status: "done", createdAt: "2026-08-29T12:00:00.000Z" },
			{
				id: "m2",
				role: "assistant",
				content: "转录组测序回答。",
				status: "done",
				createdAt: "2026-08-29T12:01:00.000Z",
				vaultSources: [{ path: "wiki/methods/rna-seq.md", title: "rna-seq", cited: true }],
			},
		],
	}];
	const pluginPath = await plugin.saveQueryAnswerNote("session-1", "m2");
	assert.match(pluginPath, /^wiki\/qa\/\d{8}-\d{4} RNA-seq 是什么？\.md$/);
	assert.ok(createdPaths.get(pluginPath).includes("转录组测序回答。"));
	await assert.rejects(
		() => plugin.saveQueryAnswerNote("session-1", "missing"),
		(error) => /找不到要落笔记的回答/.test(error.message),
	);

	// The query view must expose a visible per-answer entry.
	const queryViewSource = fs.readFileSync(
		path.join(pluginRoot, "src", "views", "query-wiki.ts"),
		"utf8",
	);
	assert.match(queryViewSource, /query-wiki-message-note/);
	assert.match(queryViewSource, /落为笔记：保存为 Markdown 笔记/);
	assert.match(queryViewSource, /saveQueryAnswerNote\(sessionId: string, messageId: string\): Promise<string>;/);
	const pluginSource = fs.readFileSync(path.join(pluginRoot, "src", "plugin.ts"), "utf8");
	assert.match(pluginSource, /async saveQueryAnswerNote\(sessionId: string, messageId: string\)/);
	const settingsSource = fs.readFileSync(
		path.join(pluginRoot, "src", "settings", "settings-tab.ts"),
		"utf8",
	);
	assert.match(settingsSource, /queryNotesFolder/);
	assert.match(
		fs.readFileSync(path.join(pluginRoot, "src", "runtime", "settings.ts"), "utf8"),
		/queryNotesFolder: "wiki\/qa"/,
	);
}

Promise.resolve()
	.then(() => {
		testMigrateLegacySettingsKeys();
		testTokenizeForLexicalRetrieval();
	})
	.then(() => testLexicalRetriever())
	.then(() => testBodyTokenLimit())
	.then(() => testBodyIndexBudgetResume())
	.then(() => testExpansionTermQuota())
	.then(() => testReadVaultEvidencePackets())
	.then(() => testRetrievalDispatcher())
	.then(() => testKeywordExpansionTrigger())
	.then(() => testQueryWikiTraceRendering())
	.then(() => testVaultSourcePathEndToEnd())
	.then(() => testCliProcessCwd())
	.then(() => testRunVaultActionToolkitGuard())
	.then(() => testSaveQueryAnswerNote())
	.then(() => testImageAttachmentVaultAccess())
	.then(() => console.log("VAULT_CONTEXT_TESTS_OK"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
