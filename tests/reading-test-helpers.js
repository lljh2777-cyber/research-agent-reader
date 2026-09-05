const esbuild = require("esbuild");
const Module = require("node:module");
const path = require("node:path");
exports.loadReading = (file, mocks = {}) => {
	const entry = path.resolve(__dirname, "../src/", file);
	const output = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian", ...Object.keys(mocks)], loader: { ".md": "text" }, logLevel: "silent" });
	const loaded = new Module(entry, module); loaded.filename = entry; loaded.paths = Module._nodeModulePaths(path.dirname(entry));
	const original = loaded.require.bind(loaded);
	loaded.require = (name) => Object.hasOwn(mocks, name) ? mocks[name] : name === "obsidian" ? {} : original(name);
	loaded._compile(output.outputFiles[0].text, entry); return loaded.exports;
};
exports.memoryStorage = () => {
	const files = new Map();
	return { files, fail: false, async list() { return [...files.keys()]; }, async read(id) { return files.get(id); }, async write(id, text) { if (this.fail) throw new Error("disk full"); files.set(id, text); } };
};
