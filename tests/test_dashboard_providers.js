"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const Module = require("module");
const path = require("path");
const { testProviderHttpLifecycle } = require("./test_provider_http_lifecycle");

let requestHandler = async () => {
	throw new Error("Unexpected HTTP request");
};
const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") {
		class Base {}
		class TFile extends Base {}
		class FileSystemAdapter extends Base {}
		class SecretComponentStub {}
		return {
			Component: Base,
			FileSystemAdapter,
			ItemView: Base,
			MarkdownRenderer: { render: async () => {} },
			Modal: Base,
			Notice: class {},
			Plugin: Base,
			PluginSettingTab: Base,
			SecretComponent: SecretComponentStub,
			Setting: class {},
			TFile,
			normalizePath: (value) => value,
			requestUrl: (options) => requestHandler(options),
			setIcon: () => {},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const pluginPath = path.resolve(
	__dirname,
	"../main.js",
);
const pluginSourceRoot = path.resolve(
	__dirname,
	"../src",
);
const AgentDashboardPlugin = require(pluginPath);
Module._load = originalLoad;
const pluginSource = fs.readdirSync(pluginSourceRoot, { recursive: true })
	.filter((file) => String(file).endsWith(".ts"))
	.sort()
	.map((file) => fs.readFileSync(path.join(pluginSourceRoot, file), "utf8"))
	.join("\n");

assert.match(pluginSource, /id:\s*"gpt-5\.6-luna"/);
assert.match(pluginSource, /label:\s*"GPT-5\.6-Luna"/);
assert.match(pluginSource, /gpt-5\.6-luna[\s\S]*supportsFast:\s*true/);

global.window = {
	setTimeout,
	clearTimeout,
};

function makePlugin(profile) {
	const plugin = new AgentDashboardPlugin();
	plugin.app = {
		secretStorage: {
			getSecret: (secretId) => secretId === "openai-main" ? "sk-test-secret" : null,
		},
	};
	plugin.settings = {
		toolkitRoot: "D:\\example",
		codexExecutable: "codex.exe",
		codexModel: "gpt-5.6-terra",
		codexReasoningEffort: "medium",
		pythonExecutable: "D:\\python\\python.exe",
		rscriptExecutable: "Rscript.exe",
		codePracticeTimeoutSeconds: 30,
		taskTimeoutMinutes: 60,
		activeProviderId: profile.id,
		providerProfiles: [profile],
		providerTimeoutSeconds: 20,
		openaiApiKey: "must-not-persist",
		githubToken: "must-not-persist",
	};
	plugin.providerHttpRequest = async (options) => {
		let result;
		try {
			result = await requestHandler({
				...options,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
			});
		} catch (error) {
			if (/ECONNREFUSED|connection refused/i.test(error.message)) {
				error.type = "local-service-offline";
			}
			throw error;
		}
		let json = null;
		try {
			json = result.text ? JSON.parse(result.text) : null;
		} catch {
			json = null;
		}
		if (result.status < 200 || result.status >= 300) {
			const detail = json?.error?.message || result.text || `HTTP ${result.status}`;
			const error = new Error(detail);
			error.type = result.status === 401 || result.status === 403 ? "authentication" : "http";
			error.status = result.status;
			throw error;
		}
		return { ...result, json };
	};
	plugin.saveSettings = async () => {};
	return plugin;
}

async function main() {
	const providerSelectIndex = pluginSource.indexOf('.setName("LLM Provider")');
	const secretIndex = pluginSource.indexOf('.setName("API Key / 凭据")');
	const endpointIndex = pluginSource.indexOf('.setName("API Base URL")');
	const fetchModelsIndex = pluginSource.indexOf('.setName("获取可用模型")');
	const selectModelIndex = pluginSource.indexOf('.setName("选择模型")');
	const testConnectionIndex = pluginSource.indexOf('.setName("测试连接")');
	assert.ok(providerSelectIndex < secretIndex);
	assert.ok(secretIndex < endpointIndex);
	assert.ok(endpointIndex < fetchModelsIndex);
	assert.ok(fetchModelsIndex < selectModelIndex);
	assert.ok(selectModelIndex < testConnectionIndex);
	assert.ok(
		pluginSource.includes('text.inputEl.addEventListener("blur"'),
		"provider name should commit on blur",
	);
	assert.ok(
		pluginSource.includes('event.key !== "Enter" || event.isComposing'),
		"provider name Enter handling should preserve IME composition",
	);
	assert.ok(pluginSource.includes('.setName("视觉输入")'));
	assert.ok(pluginSource.includes("visionConfigured"));
	assert.ok(!pluginSource.includes('.setName("Qwen3.7-Plus 联网搜索")'));
	assert.ok(
		pluginSource.includes("联网与轻量 Agent 工具按具体功能单独授权")
			&& pluginSource.includes("任何 Vault 写入都由插件侧安全边界执行")
			&& pluginSource.includes("知识问答、联网搜索与轻量 Agent 的供应商"),
		"Direct API settings should distinguish read-only queries from explicitly authorized tools",
	);
	assert.ok(pluginSource.includes("this.app.metadataCache?.getFileCache?.(file)?.frontmatter"));
	assert.ok(!pluginSource.includes('wiki/methods/single-cell-rna-seq'));
	assert.ok(pluginSource.includes("this.recordByPath = new Map()"));
	assert.ok(pluginSource.includes("version !== this.loadVersion"));
	const migrationPlugin = new AgentDashboardPlugin();
	migrationPlugin.loadData = async () => ({
		settings: {
			toolkitRoot: path.resolve(__dirname, "../.."),
			providerProfiles: [{
				id: "provider-qwen",
				name: "Qwen3.7-Plus",
				type: "openai-compatible",
				baseUrl: "https://api.example.test/v1",
				model: "qwen3.7-plus",
				capabilities: { streaming: true, pdf: false, vision: false },
				lastTest: { ok: true },
			}],
		},
		querySessions: [],
		taskRuns: [],
	});
	migrationPlugin.saveData = async () => {};
	await migrationPlugin.loadSettings();
	assert.strictEqual(
		migrationPlugin.settings.providerProfiles[0].capabilities.vision,
		true,
		"known Qwen3.7 profiles should migrate to visual input support",
	);
	assert.strictEqual(
		migrationPlugin.settings.providerProfiles[0].capabilities.visionConfigured,
		false,
	);

	const profile = {
		id: "provider-openai",
		name: "OpenAI test",
		type: "openai",
		baseUrl: "https://api.openai.test",
		model: "model-a",
		secretId: "openai-main",
		timeoutSeconds: 5,
		capabilities: { streaming: true, pdf: true, vision: true },
		apiKey: "must-not-persist",
	};
	const plugin = makePlugin(profile);

	const stored = plugin.sanitizeSettingsForStorage();
	assert.strictEqual(stored.openaiApiKey, undefined);
	assert.strictEqual(stored.githubToken, undefined);
	assert.strictEqual(stored.providerProfiles[0].apiKey, undefined);
	assert.strictEqual(stored.providerProfiles[0].secretId, "openai-main");
	assert.ok(!JSON.stringify(stored).includes("must-not-persist"));
	assert.strictEqual(stored.activeProviderId, "");

	for (const type of ["openai", "anthropic", "openai-compatible", "ollama", "lm-studio"]) {
		const adapter = plugin.createLLMProvider({
			...profile,
			id: `provider-${type}`,
			type,
		});
		assert.strictEqual(typeof adapter.testConnection, "function");
		assert.strictEqual(typeof adapter.listModels, "function");
		assert.strictEqual(typeof adapter.complete, "function");
	}
	assert.strictEqual(typeof plugin.createLLMProvider("codex-cli").testConnection, "function");

	const calls = [];
	requestHandler = async (options) => {
		calls.push(options);
		if (options.url.endsWith("/v1/models")) {
			return {
				status: 200,
				text: JSON.stringify({
					data: [
						{ id: "model-a", owned_by: "test" },
						{ id: "model-b", owned_by: "test" },
					],
				}),
				headers: {},
			};
		}
		const body = JSON.parse(options.body);
		if (body.stream) {
			return {
				status: 200,
				text: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: [DONE]",
				headers: { "content-type": "text/event-stream" },
			};
		}
		return {
			status: 200,
			text: JSON.stringify({ output_text: "OK" }),
			headers: {},
		};
	};

	const provider = plugin.createLLMProvider("provider-openai");
	assert.strictEqual(typeof provider.listModels, "function");
	assert.strictEqual(typeof provider.complete, "function");
	assert.strictEqual(typeof provider.probeStreaming, "function");
	const result = await provider.testConnection();
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.model, "model-a");
	assert.strictEqual(result.modelCount, 2);
	assert.strictEqual(result.streaming.verified, true);
	assert.strictEqual(result.pdf.supported, true);
	assert.strictEqual(result.responsePreview, "OK");
	assert.ok(calls.every((call) => call.headers.Authorization === "Bearer sk-test-secret"));
	assert.ok(calls.every((call) => !String(call.body || "").includes("confidential-research-workspace")));

	plugin.settings.activeProviderId = "";
	const persistedResult = await plugin.testProviderConnection("provider-openai");
	assert.strictEqual(persistedResult.ok, true);
	assert.strictEqual(profile.lastTest.ok, true);
	assert.strictEqual(profile.lastTest.streamingVerified, true);
	assert.strictEqual(plugin.settings.activeProviderId, "provider-openai");
	assert.strictEqual(plugin.sanitizeSettingsForStorage().activeProviderId, "provider-openai");

	requestHandler = async () => ({
		status: 401,
		text: JSON.stringify({ error: { message: "invalid API key" } }),
		headers: {},
	});
	await assert.rejects(
		() => provider.listModels(),
		(error) => plugin.normalizeProviderError(error).type === "authentication",
	);

	requestHandler = async () => ({
		status: 200,
		text: "not-json",
		headers: {},
	});
	await assert.rejects(
		() => provider.listModels(),
		(error) => plugin.normalizeProviderError(error).type === "protocol",
	);

	const ollamaProfile = {
		...profile,
		id: "provider-ollama",
		type: "ollama",
		name: "Local Ollama",
		baseUrl: "http://127.0.0.1:11434",
		model: "qwen3",
		secretId: "",
		capabilities: { streaming: true, pdf: false, vision: false },
	};
	plugin.settings.providerProfiles.push(ollamaProfile);
	requestHandler = async () => {
		throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
	};
	await assert.rejects(
		() => plugin.listProviderModels("provider-ollama"),
		(error) => plugin.normalizeProviderError(error).type === "local-service-offline",
	);

	const streamServer = http.createServer((request, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.write('data: {"delta":"A"}\n\n');
		setTimeout(() => {
			response.end('data: {"delta":"B"}\n\ndata: [DONE]\n\n');
		}, 10);
	});
	await new Promise((resolve) => streamServer.listen(0, "127.0.0.1", resolve));
	const streamEvents = [];
	try {
		const address = streamServer.address();
		await plugin.providerHttpStream({
			url: `http://127.0.0.1:${address.port}/stream`,
			method: "POST",
			body: { stream: true },
			format: "sse",
			timeoutMs: 1000,
			onEvent: (event) => streamEvents.push(event),
		});
	} finally {
		await new Promise((resolve) => streamServer.close(resolve));
	}
	assert.deepStrictEqual(streamEvents, [
		'{"delta":"A"}',
		'{"delta":"B"}',
		"[DONE]",
	]);

	const transportPlugin = new AgentDashboardPlugin();
	let delayedSocketClosed = false;
	const delayedServer = http.createServer((_request, response) => {
		const delayedResponse = setTimeout(() => {
			if (!response.destroyed) response.end('{"late":true}');
		}, 5000);
		response.on("close", () => {
			delayedSocketClosed = true;
			clearTimeout(delayedResponse);
		});
	});
	await new Promise((resolve) => delayedServer.listen(0, "127.0.0.1", resolve));
	try {
		const address = delayedServer.address();
		await assert.rejects(
			() => transportPlugin.providerHttpRequest({
				url: `http://127.0.0.1:${address.port}/slow`,
				timeoutMs: 3000,
			}),
			(error) => ["connect-timeout", "read-timeout"].includes(error.type),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(delayedSocketClosed, true);
	} finally {
		await new Promise((resolve) => delayedServer.close(resolve));
	}
	await testProviderHttpLifecycle(transportPlugin);

	const settingsTabSource = fs.readFileSync(
		path.join(__dirname, "..", "src", "settings", "settings-tab.ts"),
		"utf8",
	);
	assert.match(settingsTabSource, /"阅读 · 开箱即用"/);
	assert.match(settingsTabSource, /"AI 助手"/);
	assert.match(settingsTabSource, /"可选扩展 · 高级"/);
	assert.match(settingsTabSource, /title: "工具链与运行环境"/);
	assert.match(settingsTabSource, /agent-dashboard-settings-navigation-badge/);
	assert.match(settingsTabSource, /is-\$\{options\.badge\.tone\}/);
	assert.match(
		fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8"),
		/\.agent-dashboard-settings-navigation-badge\.is-ok/,
	);

	console.log("DASHBOARD_PROVIDER_TEST_OK");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
