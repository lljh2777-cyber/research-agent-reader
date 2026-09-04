"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.join(__dirname, "..", "node_modules", "esbuild"));

const pluginRoot = path.resolve(__dirname, "..");
let currentDocument = null;
const obsidianStub = {
	loadPdfJs: async () => ({
		getDocument: () => ({ promise: Promise.resolve(currentDocument), destroy: async () => {} }),
	}),
};
const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, parent, isMain);
};
const entry = path.join(pluginRoot, "src", "mineru", "pdf-renderer.ts");
const build = esbuild.buildSync({
	entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node", target: "node20",
	external: ["obsidian"], logLevel: "silent",
});
const loaded = new Module(entry, module);
loaded.filename = entry;
loaded.paths = Module._nodeModulePaths(pluginRoot);
loaded._compile(build.outputFiles[0].text, entry);
Module._load = originalLoad;
const { MineruPdfRenderer } = loaded.exports;
global.window = { devicePixelRatio: 1 };

function documentFixture(numPages, viewport) {
	return {
		numPages,
		getPage: async () => ({
			getViewport: ({ scale }) => ({ width: viewport.width * scale, height: viewport.height * scale }),
			getTextContent: async () => ({ items: [] }),
			render: () => ({ promise: Promise.resolve(), cancel() {} }),
		}),
		destroy: async () => {},
	};
}

function canvasFixture() {
	return {
		width: 0, height: 0, style: {},
		getContext: () => ({}),
	};
}

async function testPdfLimits() {
	const tooMany = new MineruPdfRenderer();
	currentDocument = documentFixture(2049, { width: 612, height: 792 });
	await assert.rejects(tooMany.loadBytes(new Uint8Array([1])), /2048 页安全上限/);

	const extremeAspect = new MineruPdfRenderer();
	currentDocument = documentFixture(1, { width: 100000, height: 1 });
	await extremeAspect.loadBytes(new Uint8Array([1]));
	await assert.rejects(
		extremeAspect.renderPage(1, canvasFixture(), 800, 1),
		/长宽比超过安全上限/,
	);

	const extremeCanvas = new MineruPdfRenderer();
	currentDocument = documentFixture(1, { width: 1000, height: 1000 });
	await extremeCanvas.loadBytes(new Uint8Array([1]));
	await assert.rejects(
		extremeCanvas.renderPage(1, canvasFixture(), 10000, 4),
		/Canvas 尺寸或像素数超过安全上限/,
	);
	await extremeCanvas.destroy();
}

testPdfLimits().then(() => {
	console.log("MINERU_PDF_LIMITS_TESTS_OK");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
