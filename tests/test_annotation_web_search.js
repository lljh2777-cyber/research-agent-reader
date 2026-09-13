const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { AnnotationService } = loadReading("annotations/annotation-service.ts");
const { generateDirectExplanation } = loadReading("annotations/direct-explanation.ts");
const { searchTavily } = loadReading("services/web-search.ts");
const { OpenAICompatibleProvider } = loadReading("providers/adapters.ts");

const profile = { id: "api", type: "openai-compatible", name: "Test API", model: "model", timeoutSeconds: 2, baseUrl: "https://api.example.test/v1", lastTest: { ok: true }, webSearch: "auto" };
const selection = { sourcePath: "papers/private-title/article.md", selectedText: "graph neural network", section: "Methods", context: "Nearby article context" };
const source = (i, url = `https://example.org/paper-${i}`) => ({ title: `Paper ${i}`, url, content: `Evidence ${i}`, publishedAt: "" });
function fixture(backend, settings = {}) {
	const calls = [], cli = [], searches = [];
	const plugin = {
		settings: { annotationBackendId: "api", activeProviderId: "api", annotationMaxTokens: 900, annotationWebSearchEnabled: true, annotationWebSearchTimeoutSeconds: 30, ...settings },
		getProviderProfile: id => id === "api" ? profile : null,
		resolveWebSearchBackend: () => backend || { kind: "tavily", search: async (queries, options) => { searches.push({ queries, options }); return [source(1)]; } },
		createLLMProvider: () => ({ complete: async (request, options) => { calls.push({ request, options }); return { text: "按本文语境解释这个概念。[1]" }; } }),
		getDashboardAction: () => ({ id: "annotation-explain" }), resolveCliActionExecutionConfig: () => ({ model: "cli-model" }),
		runVaultAction: async (...args) => { cli.push(args); return { exitCode: 0, stdout: "CLI explanation", stderr: "" }; }, requestVaultActionStop: () => {},
	};
	return { service: new AnnotationService({}, plugin), plugin, calls, cli, searches };
}
const base = { profile, system: "Explain a selected phrase.", user: "Local context", query: "a query", maxTokens: 900, timeoutMs: 1000, registerCancel: () => {} };

(async () => {
	const tavily = fixture();
	const explained = await tavily.service.generateExplanation(selection, () => {});
	assert.equal(tavily.calls.length, 1, "shallow search should not need a keyword-planning model call");
	assert.equal(tavily.cli.length, 0);
	assert.equal(tavily.searches[0].options.totalResults, 3);
	assert.ok(tavily.searches[0].queries.length <= 2);
	assert.ok(!JSON.stringify(tavily.searches[0].queries).includes(selection.sourcePath));
	assert.equal(tavily.calls[0].request.webSearch, undefined, "Tavily must not also enable native search");
	assert.ok(tavily.calls[0].request.messages[1].content.includes("Evidence 1"));
	assert.match(explained.text, /https:\/\/example.org\/paper-1/);
	assert.match(explained.provider, /Tavily/);
	const offline = fixture(undefined, { annotationWebSearchEnabled: false });
	await offline.service.generateExplanation(selection, () => {});
	assert.equal(offline.searches.length, 0); assert.equal(offline.calls[0].request.webSearch, undefined);
	const auto = fixture(undefined, { annotationBackendId: "auto" });
	await auto.service.generateExplanation(selection, () => {}); assert.equal(auto.calls.length, 1); assert.equal(auto.cli.length, 0);
	const unavailable = { kind: "unavailable", reason: "未配置 Tavily API Key" };
	const explicit = fixture(unavailable);
	await assert.rejects(() => explicit.service.generateExplanation(selection, () => {}), /未配置 Tavily/);
	assert.equal(explicit.calls.length + explicit.cli.length, 0, "explicit API failures must not silently switch provider");
	const fallback = fixture(unavailable, { annotationBackendId: "auto" });
	await fallback.service.generateExplanation(selection, () => {}); assert.equal(fallback.cli.length, 1); assert.equal(fallback.cli[0][3].retrievalMode, "web");
	const missing = fixture(undefined, { annotationBackendId: "removed-profile" });
	await assert.rejects(() => missing.service.generateExplanation(selection, () => {}), /配置不存在/); assert.equal(missing.cli.length, 0);
	const forcedCli = fixture(undefined, { annotationBackendId: "claude-code" });
	await forcedCli.service.generateExplanation(selection, () => {}); assert.equal(forcedCli.cli.length, 1); assert.equal(forcedCli.calls.length, 0);
	const native = fixture({ kind: "native", protocol: "qwen" });
	const nativeText = await native.service.generateExplanation(selection, () => {});
	assert.deepEqual(native.calls[0].request.webSearch, { protocol: "qwen", maxResults: 3 });
	assert.match(nativeText.text, /未返回可追溯链接/);

	// Verify real adapter request bodies, not only the helper's abstract request.
	for (const protocol of ["qwen", "openrouter", "zhipu", "deepseek"]) {
		const requests = [];
		const adapter = new OpenAICompatibleProvider({
			getProviderSecretValue: () => "test-key",
			providerHttpRequest: async options => { requests.push(options); return { status: 200, json: { choices: [{ message: { content: "解释见[原始论文](https://example.org/paper)" } }] } }; },
		}, { ...profile, capabilities: {} });
		const answer = await generateDirectExplanation({ ...base, provider: adapter, backend: { kind: "native", protocol } });
		assert.match(answer.text, /插件未独立核验/);
		if (protocol === "qwen") assert.equal(requests[0].body.enable_search, true);
		if (protocol === "openrouter") assert.equal(requests[0].body.plugins[0].max_results, 3);
		if (protocol === "zhipu") assert.equal(requests[0].body.tools[0].web_search.enable, true);
		if (protocol === "deepseek") { assert.ok(requests[0].url.endsWith("/responses")); assert.equal(requests[0].body.tools[0].type, "web_search"); }
	}
	const noSources = await generateDirectExplanation({ ...base, backend: { kind: "tavily", search: async () => [] }, provider: { complete: async () => ({ text: "基于语境解释。" }) } });
	assert.match(noSources.text, /尚未经联网核验/);
	const bareNative = await generateDirectExplanation({ ...base, backend: { kind: "native", protocol: "qwen" }, provider: { complete: async () => ({ text: "原始文献见 https://arxiv.org/abs/2005.11401。" }) } });
	assert.match(bareNative.text, /来源（供应商回答提供）/); assert.ok(!bareNative.text.includes("未返回可追溯链接"));
	await assert.rejects(() => generateDirectExplanation({ ...base, backend: { kind: "tavily", search: async () => [source(1)] }, provider: { complete: async () => ({ text: "See https://unread.example.org [1]" }) } }), /未检索到的来源链接/);
	await assert.rejects(() => generateDirectExplanation({ ...base, backend: { kind: "tavily", search: async () => [source(1)] }, provider: { complete: async () => ({ text: "Unsupported [9]" }) } }), /无效来源编号/);
	const many = await generateDirectExplanation({ ...base, backend: { kind: "tavily", search: async () => [source(0, "javascript:alert(1)"), source(1), source(1), source(2), source(3), source(4)] }, provider: { complete: async () => ({ text: "解释。[1]" }) } });
	assert.ok(!many.text.includes("javascript:")); assert.ok(!many.text.includes("paper-4"));
	let cancelGeneration, transportCancelled = false;
	const cancelled = generateDirectExplanation({ ...base, registerCancel: fn => { cancelGeneration = fn; }, provider: { complete: async (_, options) => { options.registerCancel(() => { transportCancelled = true; }); return new Promise(() => {}); } } });
	cancelGeneration(); await assert.rejects(() => cancelled, /已取消/); assert.equal(transportCancelled, true);
	let searchCancelled = false, laterCalls = 0;
	const timedOut = generateDirectExplanation({ ...base, timeoutMs: 20, backend: { kind: "tavily", search: async (_, options) => { options.signal.addEventListener("abort", () => { searchCancelled = true; }); await new Promise(resolve => setTimeout(resolve, 45)); return [source(1)]; } }, provider: { complete: async () => { laterCalls++; return { text: "late" }; } } });
	await assert.rejects(() => timedOut, /超时/); await new Promise(resolve => setTimeout(resolve, 55));
	assert.equal(searchCancelled, true); assert.equal(laterCalls, 0, "late search results cannot start a model request after timeout");
	const immediate = generateDirectExplanation({ ...base, registerCancel: fn => fn(), provider: { complete: async () => { throw new Error("must not run"); } } });
	await assert.rejects(() => immediate, /已取消/);
	let requests = 0;
	const limited = await searchTavily({ httpRequest: async () => { requests++; return { status: 200, json: { results: Array.from({ length: 8 }, (_, i) => source(i)) } }; } }, "test", ["one", "two", "three"], { maxResults: 3, totalResults: 3, maxQueries: 2, timeoutMs: 1000 });
	assert.equal(limited.length, 3); assert.equal(requests, 1);
	const controller = new AbortController(); let cancelSearch;
	const searching = searchTavily({ httpRequest: options => new Promise((resolve, reject) => { options.registerCancel(() => { cancelSearch = true; reject(new Error("transport aborted")); }); }) }, "test", ["query"], { maxResults: 3, timeoutMs: 1000, signal: controller.signal });
	controller.abort(new Error("cancel search")); await assert.rejects(() => searching, /cancel search/); assert.equal(cancelSearch, true);
	await assert.rejects(() => searchTavily({ httpRequest: async () => ({ status: 401, json: null }) }, "bad", ["query"], { maxResults: 3, timeoutMs: 1000 }), /未授权/);
	console.log("ANNOTATION_WEB_SEARCH_OK (routing, native adapters, Tavily, evidence, cancellation, deadline)");
})().catch(error => { console.error(error); process.exitCode = 1; });
