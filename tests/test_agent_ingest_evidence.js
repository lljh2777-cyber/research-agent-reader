"use strict";

// Pure-memory regressions: compile source in memory and replace only the
// filesystem boundary. The package validator and ingest service are real.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

const pluginRoot = path.resolve(__dirname, "..");
const filename = path.join(__dirname, "ingest-evidence-hooks.cjs");
const compiled = esbuild.buildSync({
	stdin: {
		contents: [
			'export { AgentLoopService } from "./src/agent/agent-loop-service";',
			'export { evaluateDraftPhase, validateDraftReceipts, parseNoteDraft } from "./src/agent/paper-ingest-flow";',
		].join("\n"),
		resolveDir: pluginRoot,
		loader: "ts",
	},
	bundle: true,
	write: false,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["obsidian", "*trusted-vault-fs"],
	logLevel: "silent",
});

class TFile {}
const trustedFs = {
	async resolveTrustedVaultPath(_adapter, relativePath) {
		return { relativePath, absolutePath: relativePath };
	},
	async readTrustedVaultFile(adapter, relativePath, limit) {
		const value = adapter.files.get(relativePath);
		if (value === undefined) throw new Error(`Missing memory file: ${relativePath}`);
		const bytes = Buffer.from(value);
		assert.ok(bytes.byteLength <= limit);
		return bytes;
	},
};
const originalLoad = Module._load;
let hooks;
try {
	Module._load = function (request, parent, isMain) {
		if (request === "obsidian") return {
			TFile,
			normalizePath: (value) => String(value).replace(/\\/g, "/"),
		};
		if (request.endsWith("trusted-vault-fs")) return trustedFs;
		return originalLoad.call(this, request, parent, isMain);
	};
	const compiledModule = new Module(filename, module);
	compiledModule.filename = filename;
	compiledModule.paths = Module._nodeModulePaths(pluginRoot);
	compiledModule._compile(compiled.outputFiles[0].text, filename);
	hooks = compiledModule.exports;
} finally {
	Module._load = originalLoad;
}

const { AgentLoopService, evaluateDraftPhase, validateDraftReceipts, parseNoteDraft } = hooks;
const articlePath = "papers/demo_2026/article.md";
const packagePath = "papers/demo_2026";
const title = "Demo Paper";

function createPackage() {
	const files = new Map([
		[articlePath, Buffer.from("# Demo Paper\n\n## Abstract\nObserved study evidence.\n")],
		[`${packagePath}/mineru-result.json`, Buffer.from("[]")],
	]);
	const manifest = {
		schema_version: 1,
		outputs: [...files].map(([filePath, bytes]) => ({
			path: filePath.slice(packagePath.length + 1),
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		})),
	};
	files.set(`${packagePath}/_extraction/manifest.json`, Buffer.from(JSON.stringify(manifest)));
	files.set(`${packagePath}/_extraction/validation.json`, Buffer.from(JSON.stringify({ status: "passed" })));
	return files;
}

function serviceFor(files) {
	const app = { vault: {
		adapter: { files, exists: async (filePath) => files.has(filePath) },
		getAbstractFileByPath: (filePath) => files.has(filePath)
			? Object.assign(new TFile(), { path: filePath, extension: filePath.split(".").pop(), stat: { size: files.get(filePath).length } })
			: null,
	} };
	return new AgentLoopService({ app });
}

function testDraftEvidenceGate() {
	for (const source of ["auto", "pdf", "article"]) {
		const options = { createArticleWiki: true, createArticleMarkdown: false, articleWikiSource: source };
		const decision = evaluateDraftPhase(options, "", false);
		assert.equal(decision.run, false, `${source} must not synthesize from metadata alone`);
		assert.ok(decision.blocker);
		assert.equal(decision.downgradeNote, "");
		assert.equal(evaluateDraftPhase(options, articlePath, false).run, true);
	}
	const readReceipt = [{
		tool: "article_read", ok: true,
		data: { paths: [articlePath], queryTerms: ["overview"], titles: [title] },
	}];
	const insufficient = parseNoteDraft({
		status: "insufficient-evidence", title, title_zh: "演示论文",
		researchQuestion: "Should not be committed", conclusion: "Should not be committed",
	});
	assert.match(validateDraftReceipts(articlePath, title, readReceipt, insufficient.status).join("；"), /证据不足/);
	assert.match(validateDraftReceipts("", title, []).join("；"), /没有已验证/);
	assert.deepEqual(validateDraftReceipts(articlePath, title, readReceipt, "completed"), []);
	assert.match(validateDraftReceipts(articlePath, "Another Paper", readReceipt).join("；"), /标题一致/);
}

async function testExistingPackagesAreValidatedBeforeReuse() {
	const observed = { sourcePath: articlePath, analysisPath: "" };
	const valid = createPackage();
	assert.deepEqual(await serviceFor(valid).resolveExistingOutputs("demo_2026", observed), observed);

	for (const missing of ["mineru-result.json", "_extraction/manifest.json", "_extraction/validation.json"]) {
		const files = new Map([...createPackage()].filter(([filePath]) => filePath !== `${packagePath}/${missing}`));
		await assert.rejects(serviceFor(files).resolveExistingOutputs("demo_2026", observed), undefined, `must reject missing ${missing}`);
	}
	const failed = createPackage();
	failed.set(`${packagePath}/_extraction/validation.json`, Buffer.from('{"status":"failed"}'));
	await assert.rejects(serviceFor(failed).resolveExistingOutputs("demo_2026", observed), /未通过/);

	const changed = createPackage();
	changed.set(articlePath, Buffer.from(changed.get(articlePath).toString().replace("Observed", "Invented")));
	await assert.rejects(serviceFor(changed).resolveExistingOutputs("demo_2026", observed), /哈希/);

	const missingImage = createPackage();
	const manifestPath = `${packagePath}/_extraction/manifest.json`;
	const manifest = JSON.parse(missingImage.get(manifestPath).toString());
	manifest.outputs.push({ path: "images/figure-1.png", size: 1, sha256: "a".repeat(64) });
	missingImage.set(manifestPath, Buffer.from(JSON.stringify(manifest)));
	await assert.rejects(serviceFor(missingImage).resolveExistingOutputs("demo_2026", observed), /文件不存在/);

	const clippingPath = "Clippings/Demo Paper.md";
	const clipping = new Map([[clippingPath, Buffer.from("# Demo Paper\nOriginal clipping text.")]]);
	assert.deepEqual(await serviceFor(clipping).resolveExistingOutputs("demo_2026", {
		sourcePath: clippingPath, analysisPath: "",
	}), { sourcePath: clippingPath, analysisPath: "" });
}

(async () => {
	testDraftEvidenceGate();
	await testExistingPackagesAreValidatedBeforeReuse();
	console.log("AGENT_INGEST_EVIDENCE_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
