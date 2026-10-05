"use strict";
const esbuild = require("esbuild"), Module = require("node:module"), path = require("node:path");
let loaded;
module.exports = function load() {
	if (loaded) return loaded;
	const entry = path.resolve(__dirname, "../src/storage/validation.ts");
	const output = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"], loader: { ".md": "text" }, logLevel: "silent" });
	const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = Module._nodeModulePaths(path.dirname(entry));
	const original = compiled.require.bind(compiled);
	const unavailable = () => { throw Error("Native Obsidian API unavailable in read-only storage validation"); };
	class NativeUnavailable { constructor() { unavailable(); } }
	const bridge = new Proxy({ TFile: NativeUnavailable, MarkdownView: NativeUnavailable, Modal: NativeUnavailable, ItemView: NativeUnavailable, Notice: NativeUnavailable }, { get: (object, key) => Object.hasOwn(object, key) ? object[key] : unavailable });
	compiled.require = name => name === "obsidian" ? bridge : original(name);
	compiled._compile(output.outputFiles[0].text, entry); loaded = compiled.exports; return loaded;
};
