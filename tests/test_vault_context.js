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
			'export { readVaultEvidencePackets } from "./src/services/vault-evidence";',
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
	assert.ok(trace.candidate_paths.includes("wiki/methods/singler-annotation.md"));
	assert.ok(!trace.candidate_paths.includes("papers/old.md"));

	const chineseTrace = await retriever.retrieve("信息熵");
	assert.ok(chineseTrace.candidate_paths.includes("wiki/concepts/entropy.md"));

	const emptyTrace = await retriever.retrieve("量子色动力学 QCD");
	assert.deepStrictEqual(emptyTrace.candidate_paths, []);

	const expandedTrace = await retriever.retrieve("怎么做注释", ["SingleR"]);
	assert.ok(expandedTrace.candidate_paths.includes("wiki/methods/singler-annotation.md"));
	assert.ok(expandedTrace.lexical_seeds.includes("singler"));

	notes[2].body = "现在讨论 SingleR 和细胞注释。";
	notes[2].mtime = 9;
	const refreshed = await retriever.retrieve("SingleR");
	assert.ok(refreshed.candidate_paths.includes("papers/old.md"));
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
}

async function testRetrievalDispatcher() {
	const plugin = Object.create(DashboardPlugin.prototype);
	const lexicalCalls = [];
	plugin.getLexicalRetriever = () => ({
		retrieve: async (question, expandedTerms) => {
			lexicalCalls.push({ question, expandedTerms });
			return {
				stage: "in-plugin-lexical",
				engine: "in-plugin-lexical",
				lexical_seeds: ["x"],
				candidate_paths: ["wiki/a.md"],
			};
		},
	});

	plugin.settings = { toolkitRoot: "", pythonExecutable: "" };
	const fallbackTrace = await plugin.runVaultRetrievalPreflight("run-1", "问题", []);
	assert.equal(fallbackTrace.engine, "in-plugin-lexical");
	assert.equal(fallbackTrace.fallback, undefined);
	assert.equal(lexicalCalls.length, 1);

	const toolkitDir = fs.mkdtempSync(path.join(os.tmpdir(), "rar-toolkit-"));
	try {
		plugin.settings = { toolkitRoot: toolkitDir, pythonExecutable: process.execPath };
		const missingTrace = await plugin.runVaultRetrievalPreflight("run-2", "问题", []);
		assert.equal(missingTrace.engine, "in-plugin-lexical");
		assert.match(String(missingTrace.fallback.reason), /检索脚本不存在/);
		assert.equal(lexicalCalls.length, 2);

		const scriptDir = path.join(toolkitDir, "tool-library", "scripts");
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, "retrieve_vault.py"), "print('ok')\n");
		let delegated = null;
		plugin.directQueryService = {
			runRetrievalPreflight: async (runId, question, expandedTerms) => {
				delegated = { runId, question, expandedTerms };
				return { stage: "lexical-seed+ppr", lexical_seeds: ["x"], candidate_paths: [] };
			},
		};
		const toolkitTrace = await plugin.runVaultRetrievalPreflight("run-3", "问题", ["term"]);
		assert.equal(toolkitTrace.stage, "lexical-seed+ppr");
		assert.equal(delegated.runId, "run-3");
		assert.deepStrictEqual(delegated.expandedTerms, ["term"]);
		assert.equal(lexicalCalls.length, 2);
	} finally {
		fs.rmSync(toolkitDir, { recursive: true, force: true });
	}
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
	plugin.app = {
		vault: {
			getAbstractFileByPath: (value) => {
				if (value === imageFile.path) return imageFile;
				if (value === missingStatFile.path) return missingStatFile;
				return null;
			},
			readBinary: async (file) => (file === imageFile ? bytes : Buffer.alloc(0)),
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
	await assert.rejects(
		() => plugin.readVaultImageData({ path: "wiki/notes/record.txt" }),
		(error) => /仅支持 Vault 内/.test(error.message),
	);
}

Promise.resolve()
	.then(() => {
		testMigrateLegacySettingsKeys();
		testTokenizeForLexicalRetrieval();
	})
	.then(() => testLexicalRetriever())
	.then(() => testReadVaultEvidencePackets())
	.then(() => testRetrievalDispatcher())
	.then(() => testImageAttachmentVaultAccess())
	.then(() => console.log("VAULT_CONTEXT_TESTS_OK"))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
