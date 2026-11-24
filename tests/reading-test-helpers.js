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
	return { files, fail: false, async list() { return [...files.keys()]; }, async read(id) { return files.get(id); },
		async readFile(id) { return { text: await this.read(id), mtime: new Date("2020-01-01T00:00:00Z") }; },
		async write(id, text) { if (this.fail) throw new Error("disk full"); files.set(id, text); } };
};

exports.temporaryFileStorage = async () => {
	const { FileReadingStorage } = exports.loadReading("reading/store.ts");
	const directory = await require("node:fs/promises").mkdtemp(path.join(require("node:os").tmpdir(), "reading-dispose-"));
	return new FileReadingStorage(directory);
};

// Use the production resolver and adapter with a caller-supplied provider transport.
exports.paperPlugin = plugin => {
	const { resolvePaperProfileId } = exports.loadReading("reading/paper-agent.ts");
	const { DirectReadingBackend } = exports.loadReading("reading/backend.ts");
	plugin.paperProfileId = (id, annotation) => resolvePaperProfileId(plugin.settings, id, annotation);
	plugin.createPaperBackend = (id, { model, gpt }) => {
		const profile = plugin.getProviderProfile(id);
		const provider = plugin.createLLMProvider({ ...profile, model });
		return new DirectReadingBackend(Object.assign(provider, provider.capabilities ? {} : { capabilities: { vision: false } }), profile.name, model, false, false, undefined, id, gpt);
	};
	return plugin;
};
