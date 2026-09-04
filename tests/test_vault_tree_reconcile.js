"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");
const entry = path.join(pluginRoot, "src", "runtime", "vault-tree-reconcile.ts");
const build = esbuild.buildSync({
	entryPoints: [entry],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	logLevel: "silent",
});
const loaded = new Module(entry, module);
loaded.filename = entry;
loaded.paths = Module._nodeModulePaths(pluginRoot);
loaded._compile(build.outputFiles[0].text, entry);
const { reconcilePublishedVaultTree } = loaded.exports;

async function testTreeIsReconciledParentFirst() {
	const calls = [];
	let indexed = false;
	const listings = new Map([
		["papers/demo_2026", {
			folders: ["papers/demo_2026/images", "papers/demo_2026/_extraction"],
			files: ["papers/demo_2026/mineru-result.json", "papers/demo_2026/article.md"],
		}],
		["papers/demo_2026/images", {
			folders: [],
			files: ["papers/demo_2026/images/figure.png"],
		}],
		["papers/demo_2026/_extraction", {
			folders: [],
			files: ["papers/demo_2026/_extraction/manifest.json"],
		}],
	]);
	const result = await reconcilePublishedVaultTree({
		async list(folder) { return listings.get(folder); },
		async reconcileInternalFile(filePath) {
			calls.push(filePath);
			if (filePath === "papers/demo_2026/article.md") indexed = true;
		},
	}, "papers/demo_2026", () => indexed);
	assert.deepEqual(calls.slice(0, 3), [
		"papers/demo_2026",
		"papers/demo_2026/_extraction",
		"papers/demo_2026/images",
	]);
	assert.ok(calls.indexOf("papers/demo_2026/article.md") > calls.indexOf("papers/demo_2026/images"));
	assert.deepEqual(result, { supported: true, reconciledEntries: 7, articleIndexed: true });
}

async function testUnsupportedAdapterLeavesWatcherFallback() {
	let listed = false;
	const result = await reconcilePublishedVaultTree({
		async list() { listed = true; return { folders: [], files: [] }; },
	}, "papers/demo_2026", () => false);
	assert.equal(listed, false);
	assert.deepEqual(result, { supported: false, reconciledEntries: 0, articleIndexed: false });
}

async function testDelayedVaultIndexSettlementIsObserved() {
	let indexed = false;
	const result = await reconcilePublishedVaultTree({
		async list() {
			return { folders: [], files: ["papers/demo_2026/article.md"] };
		},
		reconcileInternalFile(filePath) {
			if (filePath === "papers/demo_2026/article.md") {
				setTimeout(() => { indexed = true; }, 10);
			}
		},
	}, "papers/demo_2026", () => indexed);
	assert.equal(result.articleIndexed, true);
}

async function testEscapingInventoryIsRejected() {
	await assert.rejects(reconcilePublishedVaultTree({
		async list() {
			return { folders: [], files: ["papers/other/secrets.md"] };
		},
		async reconcileInternalFile() {},
	}, "papers/demo_2026", () => false), /越出原文包/);
}

(async () => {
	await testTreeIsReconciledParentFirst();
	await testUnsupportedAdapterLeavesWatcherFallback();
	await testDelayedVaultIndexSettlementIsObserved();
	await testEscapingInventoryIsRejected();
	console.log("VAULT_TREE_RECONCILE_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
