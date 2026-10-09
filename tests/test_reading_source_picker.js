/* In-memory directory and dialog stubs. No writes, cleanup or model requests. */
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers");
const root = path.resolve("vault"); let closed = false, listed = [], outside = false;
const entry = (name, kind = "file") => ({ name, isDirectory: () => kind === "folder", isSymbolicLink: () => kind === "link", isFile: () => kind === "file" });
const fs = { realpath: async filename => outside && filename !== root ? path.resolve("outside") : filename,
	opendir: async () => ({ async *[Symbol.asyncIterator]() { try { yield* listed; } finally { closed = true; } } }) };
let options, parent; const remote = { getCurrentWindow: () => "window", dialog: { showOpenDialog: async (window, config) => { parent = window; options = config; return { canceled: true, filePaths: [] }; } } };
const api = loadReading("reading/source-picker.ts", { "node:fs/promises": fs, electron: { remote }, "@electron/remote": remote });
(async () => {
	assert(api.acceptsSourceFile("code", "中文 路径/Analysis.R")); assert(!api.acceptsSourceFile("code", "README.md"));
	assert(api.acceptsSourceFile("pdf", "paper.PDF")); assert(!api.acceptsSourceFile("article", "summary.md")); assert(api.acceptsSourceFile("article", "papers/id/article.md"));
	await api.systemSourceDialog(api.sourceDialogOptions("code", true, "project", root));
	assert.equal(parent, "window"); assert.deepEqual(options.properties, ["openDirectory"]); assert.equal(options.defaultPath, path.join(root, "project")); assert(!options.filters);
	const result = await api.chooseSystemSource("code", false, "", root, async config => { assert.deepEqual(config.filters[0].extensions, ["py", "r", "R"]); return { canceled: false, filePaths: [path.join(root, "中文 路径", "a.py")] }; });
	assert.equal(result, path.join(root, "中文 路径", "a.py"));
	assert.equal(await api.chooseSystemSource("pdf", false, "old.pdf", root, async () => ({ canceled: true, filePaths: [path.join(root, "new.pdf")] })), undefined);
	await assert.rejects(api.chooseSystemSource("article", false, "", root, async () => ({ canceled: false, filePaths: [path.join(root, "summary.md")] })), /article.md/);
	assert.throws(() => api.sourceDialogOptions("pdf", true, "", root));
	for (const relative of ["../outside", "safe/../../outside", "a\\b", "D:/outside"]) assert.throws(() => api.vaultSourcePath(root, relative));
	assert.equal(api.vaultSourcePath(root, ""), root); assert.equal(api.vaultSourcePath(root, "中文 目录/analysis.R"), path.join(root, "中文 目录", "analysis.R"));
	listed = [entry("z.py"), entry("目录", "folder"), entry(".obsidian", "folder"), entry("escape", "link"), entry("a.R"), entry("a.pdf"), entry("article.md"), entry("notes.md")];
	assert.deepEqual((await api.listVaultSources(root, "", "code")).map(e => e.name), ["目录", "a.R", "z.py"]); assert(closed);
	assert.deepEqual((await api.listVaultSources(root, "", "pdf")).map(e => e.name), ["目录", "a.pdf"]);
	assert.deepEqual((await api.listVaultSources(root, "", "article")).map(e => e.name), ["目录", "article.md"]);
	outside = true; await assert.rejects(api.listVaultSources(root, "escape", "code"), /Vault 外部/); outside = false;
	listed = Array.from({ length: 5001 }, (_, i) => entry("file" + i + ".py")); closed = false; await assert.rejects(api.listVaultSources(root, "", "code"), /项目过多/); assert(closed, "iterator closes on limit failure");
	console.log("READING_SOURCE_PICKER_OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
