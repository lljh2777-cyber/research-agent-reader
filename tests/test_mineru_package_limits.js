"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");
class TFile {
	constructor(filePath, size) {
		this.path = filePath;
		this.stat = { size, mtime: 0, ctime: 0 };
	}
}
const obsidianStub = {
	App: class {},
	TFile,
	normalizePath: (value) => String(value).replace(/\\/g, "/").replace(/\/+/g, "/"),
};
const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, parent, isMain);
};
const hookEntry = path.join(pluginRoot, "tests", "mineru-package-limits-hooks.ts");
const hookBuild = esbuild.buildSync({
	entryPoints: [path.join(pluginRoot, "src", "mineru", "package-loader.ts")],
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
Module._load = originalLoad;
const { MineruPackageLoader } = hookModule.exports;

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
	return Buffer.from(JSON.stringify(value), "utf8");
}

function baseFiles(options = {}) {
	const packagePath = "papers/demo_2026";
	const article = options.article || Buffer.from("# Demo Paper\n\n正文。", "utf8");
	const mineru = options.mineru || jsonBytes([{ type: "title", page_idx: 0, text: "Demo Paper" }]);
	const outputs = options.outputs || [
		{ path: "article.md", size: article.length, sha256: sha256(article) },
		{ path: "mineru-result.json", size: mineru.length, sha256: sha256(mineru) },
	];
	const manifest = options.manifest || {
		schema_version: 1,
		source: { path: "demo.pdf", size: 10, sha256: "a".repeat(64) },
		outputs,
		derived_contracts: [],
	};
	const files = new Map([
		[`${packagePath}/article.md`, article],
		[`${packagePath}/mineru-result.json`, mineru],
		[`${packagePath}/_extraction/validation.json`, jsonBytes({ status: "passed" })],
		[`${packagePath}/_extraction/manifest.json`, jsonBytes(manifest)],
	]);
	for (const [filePath, bytes] of options.extraFiles || []) files.set(`${packagePath}/${filePath}`, bytes);
	return { packagePath, files };
}

function fakeApp(files, statOverrides = new Map(), fullRoot = "") {
	const tFiles = new Map([...files].map(([filePath, bytes]) => [
		filePath,
		new TFile(filePath, statOverrides.get(filePath) ?? bytes.length),
	]));
	return {
		vault: {
			adapter: fullRoot ? { getFullPath: (filePath) => path.join(fullRoot, ...filePath.split("/")) } : {},
			getAbstractFileByPath(filePath) { return tFiles.get(filePath) || null; },
			async readBinary(file) {
				const bytes = files.get(file.path);
				return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			},
		},
	};
}

async function loadPackage(fixture, statOverrides) {
	return await new MineruPackageLoader(fakeApp(fixture.files, statOverrides)).load(
		`${fixture.packagePath}/article.md`,
	);
}

async function testValidSmallPackageLoads() {
	const loaded = await loadPackage(baseFiles());
	assert.equal(loaded.title, "Demo Paper");
}

async function testManifestRecordBudget() {
	const fixture = baseFiles();
	const article = fixture.files.get(`${fixture.packagePath}/article.md`);
	const mineru = fixture.files.get(`${fixture.packagePath}/mineru-result.json`);
	const outputs = [
		{ path: "article.md", size: article.length, sha256: sha256(article) },
		{ path: "mineru-result.json", size: mineru.length, sha256: sha256(mineru) },
		...Array.from({ length: 8191 }, (_value, index) => ({
			path: `images/${index}.png`, size: 1, sha256: "a".repeat(64),
		})),
	];
	fixture.files.set(`${fixture.packagePath}/_extraction/manifest.json`, jsonBytes({
		schema_version: 1, source: {}, outputs, derived_contracts: [],
	}));
	await assert.rejects(loadPackage(fixture), /记录数超过/);
}

async function testPostReadLengthBudget() {
	const fixture = baseFiles({ article: Buffer.alloc(16 * 1024 * 1024 + 1, 0x41) });
	const articlePath = `${fixture.packagePath}/article.md`;
	await assert.rejects(loadPackage(fixture, new Map([[articlePath, 1]])), /实际读取结果超过/);
}

async function testDeepJsonRejectedBeforeNormalization() {
	const deep = `${"[".repeat(65)}0${"]".repeat(65)}`;
	const fixture = baseFiles({ mineru: Buffer.from(deep, "utf8") });
	await assert.rejects(loadPackage(fixture), /嵌套深度超过/);
}

async function testUnmanifestedViewerAssetRejected() {
	const article = Buffer.from("# Demo Paper\n\n![](images/missing.png)\n", "utf8");
	const mineru = jsonBytes([{ type: "image", page_idx: 0, img_path: "images/missing.png" }]);
	const fixture = baseFiles({ article, mineru });
	await assert.rejects(loadPackage(fixture), /引用资产未登记/);
}

async function testImagePixelBombRejected() {
	const article = Buffer.from("# Demo Paper\n\n![](images/bomb.png)\n", "utf8");
	const mineru = jsonBytes([{ type: "image", page_idx: 0, img_path: "images/bomb.png" }]);
	const png = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png, 0);
	png.writeUInt32BE(50_000, 16);
	png.writeUInt32BE(50_000, 20);
	const outputs = [
		{ path: "article.md", size: article.length, sha256: sha256(article) },
		{ path: "mineru-result.json", size: mineru.length, sha256: sha256(mineru) },
		{ path: "images/bomb.png", size: png.length, sha256: sha256(png) },
	];
	const fixture = baseFiles({ article, mineru, outputs, extraFiles: [["images/bomb.png", png]] });
	await assert.rejects(loadPackage(fixture), /图片解码像素超过/);
}

async function testUnsupportedViewerImageFormatRejected() {
	const article = Buffer.from("# Demo Paper\n\n![](images/vector.svg)\n", "utf8");
	const mineru = jsonBytes([{ type: "image", page_idx: 0, img_path: "images/vector.svg" }]);
	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', "utf8");
	const outputs = [
		{ path: "article.md", size: article.length, sha256: sha256(article) },
		{ path: "mineru-result.json", size: mineru.length, sha256: sha256(mineru) },
		{ path: "images/vector.svg", size: svg.length, sha256: sha256(svg) },
	];
	const fixture = baseFiles({ article, mineru, outputs, extraFiles: [["images/vector.svg", svg]] });
	await assert.rejects(loadPackage(fixture), /不受像素预算保护的图片格式/);
}

async function testSymlinkedPackageAssetRejected() {
	const fixture = baseFiles();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-reader-nofollow-"));
	for (const [filePath, bytes] of fixture.files) {
		const absolute = path.join(root, ...filePath.split("/"));
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, bytes);
	}
	const articlePath = `${fixture.packagePath}/article.md`;
	const absoluteArticle = path.join(root, ...articlePath.split("/"));
	const outside = path.join(root, "outside.md");
	fs.writeFileSync(outside, fixture.files.get(articlePath));
	fs.unlinkSync(absoluteArticle);
	try {
		fs.symlinkSync(outside, absoluteArticle, "file");
		await assert.rejects(
			new MineruPackageLoader(fakeApp(fixture.files, new Map(), root)).load(articlePath),
			/符号链接|junction|特殊文件/,
		);
	} catch (error) {
		if (!error || error.code !== "EPERM") throw error;
	}
}

(async () => {
	await testValidSmallPackageLoads();
	await testManifestRecordBudget();
	await testPostReadLengthBudget();
	await testDeepJsonRejectedBeforeNormalization();
	await testUnmanifestedViewerAssetRejected();
	await testImagePixelBombRejected();
	await testUnsupportedViewerImageFormatRejected();
	await testSymlinkedPackageAssetRejected();
	console.log("MINERU_PACKAGE_LIMITS_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
