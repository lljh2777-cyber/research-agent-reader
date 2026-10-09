"use strict";

const assert = require("node:assert/strict");
const { createHash, webcrypto } = require("node:crypto");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require("esbuild");

// All Vault files are in memory: this regression never rewrites a fixture or
// removes files. Compile the actual service, rather than mirroring its logic.
class TFile {
	constructor(filePath) {
		this.path = filePath;
		this.basename = path.posix.basename(filePath, ".md");
		this.extension = "md";
	}
}
const entry = path.resolve(__dirname, "../src/annotations/annotation-service.ts");
const compiled = esbuild.buildSync({
	entryPoints: [entry], bundle: true, write: false, format: "cjs",
	platform: "node", target: "node20", external: ["obsidian"], logLevel: "silent",
});
const loaded = new Module(entry, module);
loaded.filename = entry;
loaded.paths = Module._nodeModulePaths(path.dirname(entry));
const originalRequire = loaded.require.bind(loaded);
loaded.require = (name) => name === "obsidian" ? {
	TFile, MarkdownView: class {}, Notice: class {}, normalizePath: (value) => value.replace(/\\/g, "/"),
} : originalRequire(name);
loaded._compile(compiled.outputFiles[0].text, entry);
const { AnnotationService } = loaded.exports;
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function memoryVault(sourcePath, markdown) {
	const entries = new Map([[sourcePath, { file: new TFile(sourcePath), text: markdown }]]);
	const writes = [];
	return { entries, writes, app: { vault: {
		getAbstractFileByPath: (name) => entries.get(name)?.file || null,
		read: async (file) => entries.get(file.path).text,
		createFolder: async (name) => { entries.set(name, { file: { path: name } }); },
		create: async (name, text) => {
			assert.equal(entries.has(name), false);
			const file = new TFile(name);
			entries.set(name, { file, text });
			writes.push(name);
			return file;
		},
		process: async (file, transform) => {
			entries.get(file.path).text = transform(entries.get(file.path).text);
			writes.push(file.path);
		},
	} } };
}

function select(sourcePath, content, selectedText, occurrence = 0) {
	let start = -1;
	for (let i = 0; i <= occurrence; i++) start = content.indexOf(selectedText, start + 1);
	assert.ok(start >= 0);
	const end = start + selectedText.length;
	return { sourcePath, selectedText, sourceStart: start, sourceEnd: end,
		prefix: content.slice(Math.max(0, start - 80), start), suffix: content.slice(end, end + 80),
		section: "Results", context: content, isTableCell: false, anchorRect: {},
	};
}

async function main() {
	for (const sourcePath of ["papers/example/article.md", "Clippings/example.md"]) {
		const source = "# Results\n\nFirst result: the selected passage.\n\n<!-- note -->\nSecond result: the selected passage.\n<!-- agent-dashboard:annotation-start quoted -->\n";
		const state = memoryVault(sourcePath, source);
		const service = new AnnotationService(state.app, {});
		const selection = select(sourcePath, source, "the selected passage", 1);
		const beforeHash = createHash("sha256").update(source).digest("hex");
		const record = await service.createAnnotation(selection, { manualText: "Independent note" });
		assert.equal(state.entries.get(sourcePath).text, source);
		assert.equal(createHash("sha256").update(state.entries.get(sourcePath).text).digest("hex"), beforeHash);
		assert.ok(state.writes.every((name) => name.startsWith("wiki/annotations/")));
		assert.doesNotMatch(state.entries.get(record.annotationPath).text, /\[\[(?:papers|Clippings)\//i);
		assert.doesNotMatch(state.entries.get(record.annotationPath).text, /<!-- note -->/);
		assert.equal((state.entries.get(record.annotationPath).text.match(/<!-- agent-dashboard:annotation-start /g) || []).length, 1);
		assert.equal(record.sourceAnchor.start, selection.sourceStart);

		// Reload the service and serialized record, then reopen the exact occurrence.
		const reloaded = new AnnotationService(state.app, {});
		const found = await reloaded.findAnnotationForSelection(selection);
		assert.equal(found.id, record.id);
		assert.equal(found.manualText, "Independent note");
		assert.equal(found.sourceAnchor.prefix, record.sourceAnchor.prefix);
		assert.equal(found.sourceAnchor.suffix, record.sourceAnchor.suffix);
		assert.equal(await reloaded.findAnnotationForSelection(select(sourcePath, source, selection.selectedText)), null);
		await reloaded.updateAnnotation(found, { manualText: "Updated note" });
		assert.equal((await reloaded.findAnnotationForSelection(selection)).manualText, "Updated note");
		assert.equal(state.entries.get(sourcePath).text, source);

		const beforeWrites = state.writes.length;
		await assert.rejects(() => reloaded.createAnnotation({ ...selection, selectedText: "no longer present" }, {}));
		assert.equal(state.writes.length, beforeWrites, "stale selections must fail before saving a record");
	}

	// Authored wiki notes retain their existing inline-link interaction.
	const sourcePath = "wiki/concepts/example.md";
	const source = "# Example\n\nA selected passage.\n";
	const state = memoryVault(sourcePath, source);
	const service = new AnnotationService(state.app, {});
	const record = await service.createAnnotation(select(sourcePath, source, "selected passage"), {});
	assert.match(state.entries.get(sourcePath).text, /\[\[wiki\/annotations\/example#\^ann-[^|]+\|selected passage\]\]/);
	assert.equal(record.sourceAnchor, undefined);
	console.log("ANNOTATION_SOURCE_INTEGRITY_TEST_OK");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
