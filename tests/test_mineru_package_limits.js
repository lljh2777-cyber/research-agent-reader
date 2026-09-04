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
		[`${packagePath}/_extraction/validation.json`, jsonBytes(options.validation || { status: "passed" })],
		[`${packagePath}/_extraction/manifest.json`, jsonBytes(manifest)],
	]);
	for (const [filePath, bytes] of options.extraFiles || []) files.set(`${packagePath}/${filePath}`, bytes);
	return { packagePath, files };
}

function attachViewerIndex(fixture, viewerIndex) {
	const viewerBytes = jsonBytes(viewerIndex);
	const manifestPath = `${fixture.packagePath}/_extraction/manifest.json`;
	const manifest = JSON.parse(fixture.files.get(manifestPath).toString("utf8"));
	manifest.derived_contracts = [{
		path: "_extraction/viewer-index.json",
		size: viewerBytes.length,
		sha256: sha256(viewerBytes),
	}];
	fixture.files.set(manifestPath, jsonBytes(manifest));
	fixture.files.set(`${fixture.packagePath}/_extraction/viewer-index.json`, viewerBytes);
	return fixture;
}

function fakeApp(files, statOverrides = new Map(), fullRoot = "") {
	const vaultRoot = fullRoot || fs.mkdtempSync(path.join(os.tmpdir(), "mineru-package-vault-"));
	if (!fullRoot) {
		for (const [filePath, bytes] of files) {
			const absolute = path.join(vaultRoot, ...filePath.split("/"));
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			fs.writeFileSync(absolute, bytes);
		}
	}
	const tFiles = new Map([...files].map(([filePath, bytes]) => [
		filePath,
		new TFile(filePath, statOverrides.get(filePath) ?? bytes.length),
	]));
	return {
		vault: {
			adapter: {
				getBasePath: () => vaultRoot,
				getFullPath: (filePath) => path.join(vaultRoot, ...String(filePath || "").split("/")),
			},
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
	assert.equal(loaded.sourceMarkdownDisposition, "passive");
	assert.equal(loaded.articleMarkdown, "# Demo Paper\n\n正文。");
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
	await assert.rejects(loadPackage(fixture, new Map([[articlePath, 1]])), /超过安全上限/);
}

async function testDeepJsonRejectedBeforeNormalization() {
	const deep = `${"[".repeat(65)}0${"]".repeat(65)}`;
	const fixture = baseFiles({ mineru: Buffer.from(deep, "utf8") });
	await assert.rejects(loadPackage(fixture), /嵌套深度超过/);
}

async function testViewerIndexFanoutFallsBackBeforeMapping() {
	const tooManyPages = attachViewerIndex(baseFiles(), {
		schema_version: 1,
		pages: Array.from({ length: 2_049 }, (_value, page_idx) => ({ page_idx, blocks: [] })),
		markdown_images: [],
		issues: [],
	});
	const pageFallback = await loadPackage(tooManyPages);
	assert.equal(pageFallback.viewerIndex.pages.length, 1);
	assert.ok(pageFallback.issues.some((issue) => /结构不受支持/.test(issue)));

	const nestedFanout = attachViewerIndex(baseFiles(), {
		schema_version: 1,
		pages: [{
			page_idx: 0,
			blocks: [{
				source_index: 0,
				markdown_image_ids: Array.from({ length: 513 }, (_value, index) => `image-${index}`),
			}],
		}],
		markdown_images: [],
		issues: [],
	});
	const nestedFallback = await loadPackage(nestedFanout);
	assert.equal(nestedFallback.viewerIndex.pages.length, 1);
	assert.ok(nestedFallback.issues.some((issue) => /结构复杂度上限/.test(issue)));
}

async function testLegacyActiveMarkdownIsDerivedBeforeReaderLoad() {
	for (const injection of [
		"H<sub>2</sub>O 与 x<sup>2</sup>",
		"```some-active-language\npayload\n```",
		"![tracking][remote]\n\n[remote]: https://example.invalid/opened",
		"![[Vault embed]]",
		"<iframe src=https://example.invalid></iframe>",
	]) {
		const original = Buffer.from(`# Demo Paper\n\n${injection}\n`, "utf8");
		const fixture = baseFiles({
			article: original,
		});
		const loaded = await loadPackage(fixture);
		assert.equal(loaded.sourceMarkdownDisposition, "runtime-derived");
		assert.doesNotMatch(loaded.articleMarkdown, /<\/?(?:sub|sup|iframe)\b|```|!\[\[|\[remote\]:/i);
		assert.ok(loaded.issues.some((issue) => /内存中生成安全阅读副本/.test(issue)));
		assert.deepEqual(fixture.files.get(`${fixture.packagePath}/article.md`), original);
	}
}

async function testClaimedPassivePackageStillRejectsActiveMarkdown() {
	const fixture = baseFiles({
		article: Buffer.from("# Demo Paper\n\nH<sup>2</sup>O\n", "utf8"),
		validation: { status: "passed", checks: { passive_markdown_closed: true } },
	});
	await assert.rejects(loadPackage(fixture), /声明 article\.md 已安全闭合.*原始 HTML/s);
}

async function testLegacyCompatibilityRunsOnlyAfterManifestVerification() {
	const fixture = baseFiles({
		article: Buffer.from("# Demo Paper\n\nH<sup>2</sup>O\n", "utf8"),
	});
	const manifestPath = `${fixture.packagePath}/_extraction/manifest.json`;
	const manifest = JSON.parse(fixture.files.get(manifestPath).toString("utf8"));
	manifest.outputs.find((record) => record.path === "article.md").sha256 = "f".repeat(64);
	fixture.files.set(manifestPath, jsonBytes(manifest));
	await assert.rejects(loadPackage(fixture), /哈希与 manifest\.json 不一致：article\.md/);
}

async function testLegacyViewerCacheIsIgnoredAfterRuntimeDerivation() {
	const article = Buffer.from("# Demo Paper\n\nH<sup>2</sup>O\n", "utf8");
	const mineru = jsonBytes([{ type: "title", page_idx: 0, text: "Demo Paper" }]);
	const fixture = attachViewerIndex(baseFiles({ article, mineru }), {
		schema_version: 1,
		status: "complete",
		inputs: {
			article: { path: "article.md", sha256: sha256(article) },
			mineru_result: { path: "mineru-result.json", sha256: sha256(mineru) },
		},
		markdown_images: [],
		pages: [{ page_idx: 0, blocks: [] }],
		issues: [],
	});
	const loaded = await loadPackage(fixture);
	assert.equal(loaded.sourceMarkdownDisposition, "runtime-derived");
	assert.ok(loaded.issues.some((issue) => /原始 HTML 偏移.*安全阅读副本/.test(issue)));
}

async function testLegacySourcePdfUsesSourceRecordBinding() {
	const sourcePdf = Buffer.from("%PDF-1.7\nlegacy-source\n", "utf8");
	const fixture = baseFiles({ extraFiles: [["_extraction/source.pdf", sourcePdf]] });
	const manifestPath = `${fixture.packagePath}/_extraction/manifest.json`;
	const manifest = JSON.parse(fixture.files.get(manifestPath).toString("utf8"));
	manifest.source = {
		path: "ignored-host-specific-source.pdf",
		size: sourcePdf.length,
		sha256: sha256(sourcePdf),
	};
	fixture.files.set(manifestPath, jsonBytes(manifest));
	const loaded = await loadPackage(fixture);
	assert.deepEqual(Buffer.from(loaded.verifiedPdfBytes), sourcePdf);

	manifest.source.sha256 = "f".repeat(64);
	fixture.files.set(manifestPath, jsonBytes(manifest));
	await assert.rejects(loadPackage(fixture), /source\.pdf.*旧版 manifest\.json 来源哈希不一致/);
}

async function testUnmanifestedViewerAssetRejected() {
	const article = Buffer.from("# Demo Paper\n\n![](images/missing.png)\n", "utf8");
	const mineru = jsonBytes([{ type: "image", page_idx: 0, img_path: "images/missing.png" }]);
	const fixture = baseFiles({ article, mineru });
	await assert.rejects(loadPackage(fixture), /未绑定 Manifest|引用资产未登记/);
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
	await assert.rejects(loadPackage(fixture), /不受像素预算保护的图片格式|不允许的图片/);
}

async function testVerifiedImageBytesAreRetainedAndGifRejected() {
	const article = Buffer.from("# Demo Paper\n\n![](images/static.png)\n", "utf8");
	const mineru = jsonBytes([{ type: "image", page_idx: 0, img_path: "images/static.png" }]);
	const png = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png, 0);
	png.writeUInt32BE(2, 16);
	png.writeUInt32BE(3, 20);
	const outputs = [
		{ path: "article.md", size: article.length, sha256: sha256(article) },
		{ path: "mineru-result.json", size: mineru.length, sha256: sha256(mineru) },
		{ path: "images/static.png", size: png.length, sha256: sha256(png) },
	];
	const loaded = await loadPackage(baseFiles({
		article, mineru, outputs, extraFiles: [["images/static.png", png]],
	}));
	assert.deepEqual(Buffer.from(await loaded.verifiedAssetBlobs.get("images/static.png").arrayBuffer()), png);

	const gifArticle = Buffer.from("# Demo Paper\n\n![](images/animated.gif)\n", "utf8");
	const gifMineru = jsonBytes([{ type: "image", page_idx: 0, img_path: "images/animated.gif" }]);
	const gif = Buffer.from("474946383961020003000000", "hex");
	const gifOutputs = [
		{ path: "article.md", size: gifArticle.length, sha256: sha256(gifArticle) },
		{ path: "mineru-result.json", size: gifMineru.length, sha256: sha256(gifMineru) },
		{ path: "images/animated.gif", size: gif.length, sha256: sha256(gif) },
	];
	await assert.rejects(loadPackage(baseFiles({
		article: gifArticle, mineru: gifMineru, outputs: gifOutputs,
		extraFiles: [["images/animated.gif", gif]],
	})), /拒绝 GIF|不允许的图片/);
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

async function testSymlinkedPapersAncestorRejected() {
	const fixture = baseFiles();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-reader-root-link-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-reader-outside-papers-"));
	for (const [filePath, bytes] of fixture.files) {
		const relative = filePath.replace(/^papers\//, "");
		const absolute = path.join(outside, ...relative.split("/"));
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, bytes);
	}
	try {
		fs.symlinkSync(outside, path.join(root, "papers"), "junction");
		await assert.rejects(
			new MineruPackageLoader(fakeApp(fixture.files, new Map(), root)).load(`${fixture.packagePath}/article.md`),
			/符号链接|junction/,
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
	await testViewerIndexFanoutFallsBackBeforeMapping();
	await testLegacyActiveMarkdownIsDerivedBeforeReaderLoad();
	await testClaimedPassivePackageStillRejectsActiveMarkdown();
	await testLegacyCompatibilityRunsOnlyAfterManifestVerification();
	await testLegacyViewerCacheIsIgnoredAfterRuntimeDerivation();
	await testLegacySourcePdfUsesSourceRecordBinding();
	await testUnmanifestedViewerAssetRejected();
	await testImagePixelBombRejected();
	await testUnsupportedViewerImageFormatRejected();
	await testVerifiedImageBytesAreRetainedAndGifRejected();
	await testSymlinkedPackageAssetRejected();
	await testSymlinkedPapersAncestorRejected();
	console.log("MINERU_PACKAGE_LIMITS_TESTS_OK");
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
