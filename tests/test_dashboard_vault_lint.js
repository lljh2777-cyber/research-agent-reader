"use strict";

const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
class ObsidianBase {}
class ObsidianTFile extends ObsidianBase {
	constructor(filePath) {
		super();
		this.path = filePath;
		this.name = filePath.split("/").pop();
		this.basename = this.name.replace(/\.md$/i, "");
		this.extension = "md";
		this.stat = { mtime: 1, ctime: 1, size: 1 };
	}
}
class ObsidianFileSystemAdapter extends ObsidianBase {}
const obsidianStub = {
	Component: ObsidianBase,
	FileSystemAdapter: ObsidianFileSystemAdapter,
	ItemView: ObsidianBase,
	MarkdownRenderer: { render: async () => {} },
	MarkdownView: ObsidianBase,
	Menu: ObsidianBase,
	Modal: ObsidianBase,
	Notice: class {},
	Plugin: ObsidianBase,
	PluginSettingTab: ObsidianBase,
	Setting: class {},
	TFile: ObsidianTFile,
	normalizePath: (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, ""),
	setIcon: () => {},
};
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, parent, isMain);
};

const AgentDashboardPlugin = require(path.resolve(__dirname, "../main.js"));
Module._load = originalLoad;

function makeVault() {
	const content = new Map([
		["wiki/index.md", "# Wiki\n\n[[wiki/methods/good]]"],
		["wiki/methods/good.md", "---\ntitle: Good\ntype: method\n---\n\n[[Clippings/Clip]]"],
		["wiki/methods/broken.md", "---\ntitle: Broken\ntype: method\n---\n\n[[missing-note]]"],
		["研究方法索引.md", "# Index\n\n[[wiki/methods/broken]]"],
		["papers/a/article.md", "# Paper\n\n![Figure](images/a.png)\n\n[[not-real]]\n\n[[wiki/methods/good]]"],
		["Clippings/Clip.md", "# Clip\n\n![Remote](https://example.com/a.png)\n\n[[papers/a/article]]"],
		["Clippings/Noisy.md", "# Noisy\n\n[[missing-in-clippings]]"],
	]);
	const files = [...content.keys()].map((filePath) => new ObsidianTFile(filePath));
	const fileByPath = new Map(files.map((file) => [file.path, file]));
	return {
		getMarkdownFiles: () => files,
		cachedRead: async (file) => content.get(file.path),
		getName: () => "test-vault",
		adapter: new ObsidianFileSystemAdapter(),
		fileByPath,
	};
}

async function run() {
	const vault = makeVault();
	const plugin = new AgentDashboardPlugin();
	plugin.app = {
		vault,
		metadataCache: {
			getFirstLinkpathDest: (target) => {
				const normalized = target.endsWith(".md") ? target : `${target}.md`;
				return vault.fileByPath.get(normalized) || null;
			},
		},
	};
	plugin.settings = {};

	const action = {
		id: "vault-lint",
		label: "知识库体检",
		agent: "Research Agent Reader 内置体检",
		description: "",
		requiresInput: false,
		writes: false,
		enabled: true,
	};
	const result = await plugin.runVaultAction("lint-test", action, "");
	assert.strictEqual(result.exitCode, 1);
	assert.match(result.stdout, /体检范围：wiki\/ 与 Vault 顶层 Markdown/);
	assert.match(result.stdout, /排除范围：papers\/、Clippings\//);

	const report = plugin.getLintStatus().latest;
	assert.ok(report);
	assert.deepStrictEqual(report.scope.excluded, ["papers/", "Clippings/"]);
	assert.deepStrictEqual(report.scope.boundary_only, ["papers/", "Clippings/"]);
	assert.strictEqual(report.stats.markdown_count, 4);
	assert.strictEqual(report.stats.boundary_file_count, 3);
	assert.strictEqual(report.summary.errors, 4);
	assert.strictEqual(report.summary.warnings, 0);

	const crossRoot = report.findings.filter((finding) => finding.code === "cross-root-link");
	assert.strictEqual(crossRoot.length, 3);
	assert.deepStrictEqual(
		crossRoot.map((finding) => finding.path).sort(),
		["Clippings/Clip.md", "papers/a/article.md", "wiki/methods/good.md"],
	);
	assert.ok(report.findings.some((finding) => (
		finding.code === "missing-wikilink-target"
		&& finding.path === "wiki/methods/broken.md"
	)));
	assert.ok(!report.findings.some((finding) => finding.message.includes("missing-in-clippings")));
	assert.ok(!report.findings.some((finding) => finding.message.includes("not-real")));
	assert.ok(!report.findings.some((finding) => finding.message.includes("images/a.png")));

	console.log("AGENT_DASHBOARD_VAULT_LINT_TEST_OK");
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
