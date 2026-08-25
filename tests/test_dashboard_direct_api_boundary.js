"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const esbuild = require(path.resolve(__dirname, "../node_modules/esbuild"));

const pluginPath = path.resolve(__dirname, "..", "main.js");
const pluginRoot = path.resolve(__dirname, "..");

class ObsidianBase {}

const obsidianStub = {
	Component: ObsidianBase,
	ItemView: ObsidianBase,
	MarkdownRenderer: { render: async () => {} },
	Modal: ObsidianBase,
	Notice: class {},
	Plugin: ObsidianBase,
	PluginSettingTab: ObsidianBase,
	SecretComponent: ObsidianBase,
	Setting: ObsidianBase,
	normalizePath: (value) => value,
	requestUrl: async () => {
		throw new Error("requestUrl must not be called by the boundary test");
	},
	setIcon: () => {},
};

const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") return obsidianStub;
	return originalLoad.call(this, request, parent, isMain);
};
const DashboardPlugin = require(pluginPath);
Module._load = originalLoad;

const hookEntry = path.join(pluginRoot, "tests", "direct-api-hooks.ts");
const hookBuild = esbuild.buildSync({
	stdin: {
		contents: [
			'export { normalizeProviderProfile } from "./src/providers/profile";',
			'export { OpenAICompatibleProvider } from "./src/providers/adapters";',
		].join("\n"),
		resolveDir: pluginRoot,
		sourcefile: hookEntry,
		loader: "ts",
	},
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	target: "node20",
	logLevel: "silent",
});
const hookModule = new Module(hookEntry, module);
hookModule.filename = hookEntry;
hookModule.paths = Module._nodeModulePaths(pluginRoot);
hookModule._compile(hookBuild.outputFiles[0].text, hookEntry);
const hooks = hookModule.exports;
const profile = hooks.normalizeProviderProfile({
	id: "legacy-qwen-web",
	name: "Qwen",
	type: "openai-compatible",
	baseUrl: "https://example.invalid/compatible-mode/v1",
	model: "qwen3.7-plus",
	webSearch: {
		enabled: true,
		configured: true,
		protocol: "qwen-chat-completions",
		forcedSearch: true,
		searchStrategy: "max",
		assignedSites: ["nature.com"],
		timeoutSeconds: 75,
	},
	lastTest: {
		ok: true,
		webSearchVerified: true,
	},
});
assert.equal(profile.webSearch, undefined);
assert.equal(profile.lastTest.webSearchVerified, undefined);

const provider = new hooks.OpenAICompatibleProvider({}, profile);
assert.equal(provider.capabilities.webSearch, undefined);
const messages = [{ role: "user", content: "test" }];
const plainBody = provider.chatBody({ model: profile.model, messages });
assert.equal(plainBody.enable_search, undefined);
assert.equal(plainBody.search_options, undefined);
const staleSearchBody = provider.chatBody({
	model: profile.model,
	messages,
	webSearch: true,
});
assert.equal(staleSearchBody.enable_search, undefined);
assert.equal(staleSearchBody.search_options, undefined);

(async () => {
	let capturedOptions = null;
	provider.request = async (_route, options) => {
		capturedOptions = options;
		return {
			json: {
				choices: [{ message: { content: "OK" } }],
			},
		};
	};
	provider.headers = async () => ({ "Content-Type": "application/json" });
	await provider.complete({
		model: profile.model,
		messages,
	}, {
		timeoutMs: 30000,
	});
	assert.equal(capturedOptions.timeoutMs, 30000);
	assert.equal(capturedOptions.body.enable_search, undefined);

	const plugin = Object.create(DashboardPlugin.prototype);
	plugin.querySessions = [
		{
			id: "empty-current",
			title: "新对话",
			messages: [],
			updatedAt: "2026-07-25T12:00:00.000Z",
		},
		{
			id: "kept-session",
			title: "已有问题",
			messages: [{ role: "user", content: "test" }],
			updatedAt: "2026-07-25T11:00:00.000Z",
		},
	];
	plugin.activeQuerySessionId = "empty-current";
	let saveCount = 0;
	plugin.saveSettings = async () => {
		saveCount += 1;
	};
	const nextSession = await plugin.deleteActiveQuerySession();
	assert.equal(nextSession.id, "kept-session");
	assert.equal(plugin.querySessions.length, 1);
	assert.equal(plugin.activeQuerySessionId, "kept-session");
	assert.equal(saveCount, 1);

	plugin.querySessions = [{
		id: "only-empty",
		title: "新对话",
		messages: [],
		updatedAt: "2026-07-25T12:00:00.000Z",
	}];
	plugin.activeQuerySessionId = "only-empty";
	const reusedSession = await plugin.createQuerySession();
	assert.equal(reusedSession.id, "only-empty");
	assert.equal(plugin.querySessions.length, 1);
	console.log("Direct API boundary tests passed.");
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
