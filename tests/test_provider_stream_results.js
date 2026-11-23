"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { loadReading } = require("./reading-test-helpers");
const { OpenAIProvider, OpenAICompatibleProvider, LMStudioProvider, AnthropicProvider, OllamaProvider } = loadReading("providers/adapters.ts");
const { DirectReadingBackend } = loadReading("reading/backend.ts");
const { outputLimitReached } = loadReading("providers/shared.ts");

const request = { messages: [{ role: "user", content: "Question" }] };
const config = { baseUrl: "https://unit.test/v1", secretId: "placeholder", model: "model", timeoutSeconds: 5 };
const responseDelta = delta => ({ type: "response.output_text.delta", delta });
const chatChunk = (delta, finish_reason = null) => ({
	object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
});
const responseUsage = { input_tokens: 9, output_tokens: 2, total_tokens: 11 };
const chatUsage = { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 };

function fakeTransport(events, httpBody = "") {
	const requests = [];
	return {
		app: { secretStorage: { getSecret: () => "placeholder" } },
		requests,
		async providerHttpRequest() { return { status: 200, text: httpBody }; },
		async providerHttpStream(options) {
			requests.push(options);
			const cancelled = Object.assign(new Error("cancelled by reader"), { type: "cancelled" });
			let stopped = false;
			options.registerCancel?.(() => { stopped = true; });
			for (const event of events) {
				options.onEvent(typeof event === "string" ? event : JSON.stringify(event));
				if (stopped) throw cancelled;
			}
			return { status: 200, headers: {}, endpoint: options.url };
		},
	};
}

const responses = {
	name: "Responses", Adapter: OpenAIProvider, type: "openai", delta: responseDelta, usage: responseUsage,
	normal: [{ type: "response.completed", response: { status: "completed", usage: responseUsage } }],
	limited: [{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: responseUsage } }],
	failures: [{ type: "response.failed", response: { status: "failed", error: { message: "capacity exhausted" } } },
		{ type: "error", code: "server_error", message: "capacity exhausted" },
		{ error: { message: "capacity exhausted" } }],
	httpBody: { object: "response", status: "completed", output_text: "ordinary" },
	stop: raw => raw?.incomplete_details?.reason ?? raw?.status, success: "completed", limit: "max_output_tokens",
};
const chat = {
	name: "Chat Completions", Adapter: OpenAICompatibleProvider, type: "openai-compatible", delta: text => chatChunk({ content: text }), usage: chatUsage,
	normal: [chatChunk({}, "stop"), { object: "chat.completion.chunk", choices: [], usage: chatUsage }, "[DONE]"],
	limited: [chatChunk({}, "length"), { choices: [], usage: chatUsage }, "[DONE]"],
	failures: [{ error: { message: "capacity exhausted", code: "server_error" } }],
	httpBody: { object: "chat.completion", choices: [{ message: { content: "ordinary" }, finish_reason: "stop" }] },
	stop: raw => raw?.choices?.[0]?.finish_reason, success: "stop", limit: "length",
};

for (const protocol of [responses, chat]) describe(protocol.name, () => {
	const fixture = (events, httpBody) => {
		const host = fakeTransport(events, httpBody);
		const provider = new protocol.Adapter(host, { ...config, type: protocol.type });
		return { host, provider };
	};
	it("returns text, reported usage and stop reason", async () => {
		const { provider, host } = fixture([protocol.delta("part"), protocol.delta(" two"), ...protocol.normal]);
		const deltas = [];
		const result = await provider.stream(request, text => deltas.push(text));
		assert.deepEqual(deltas, ["part", " two"]);
		assert.equal(result.text, "part two");
		assert.equal(protocol.stop(result.raw), protocol.success);
		assert.deepEqual(result.raw.usage, protocol.usage);
		assert.equal(await provider.probeStreaming(request), true);
		if (protocol === chat) assert.equal(host.requests[0].body.stream_options.include_usage, true);
	});
	it("rejects the server error after a text delta", async () => {
		for (const failure of protocol.failures) {
			const { provider } = fixture([protocol.delta("partial"), failure]);
			await assert.rejects(provider.stream(request, () => {}), /capacity exhausted/);
			await assert.rejects(provider.probeStreaming(request), /capacity exhausted/);
		}
	});
	it("returns an explicit truncation and reports usage to the reading backend", async () => {
		const { provider } = fixture([protocol.delta("partial"), ...protocol.limited]);
		const result = await provider.stream(request, () => {});
		assert.equal(result.text, "partial");
		assert.equal(protocol.stop(result.raw), protocol.limit);
		assert.equal(outputLimitReached(result.raw), true);
		const backend = new DirectReadingBackend(provider, "test", "model", true);
		let usage;
		await assert.rejects(backend.complete({ system: "", prompt: "Q", images: [], signal: new AbortController().signal,
			rejectTruncated: true, onUsage: value => { usage = value; } }), /模型输出达到上限/);
		assert.deepEqual([usage.input, usage.output], [9, 2]);
	});
	it("rejects EOF and a bare [DONE] without a model terminal event", async () => {
		for (const ending of [[], ["[DONE]"]]) {
			const { provider } = fixture([protocol.delta("partial"), ...ending]);
			await assert.rejects(provider.stream(request, () => {}), error => error.type === "protocol");
			await assert.rejects(provider.probeStreaming(request), error => error.type === "protocol");
		}
	});
	for (const [label, httpBody] of [["empty HTTP 200", ""], ["ordinary JSON", JSON.stringify(protocol.httpBody)]]) {
		it("rejects " + label + " during generation and probing", async () => {
			const { provider } = fixture([], httpBody);
			await assert.rejects(provider.stream(request, () => {}), error => error.type === "protocol");
			await assert.rejects(provider.probeStreaming(request), error => error.type === "protocol");
		});
	}
	it("does not verify streaming from a successful ordinary request", async () => {
		const { provider } = fixture([], JSON.stringify(protocol.httpBody));
		await assert.rejects(provider.probeStreaming(request), error => error.type === "protocol");
	});
	it("propagates cancellation after the first delta", async () => {
		const { provider } = fixture([protocol.delta("partial"), ...protocol.normal]);
		let cancel;
		await assert.rejects(provider.stream(request, () => cancel(), { registerCancel: callback => { cancel = callback; } }),
			error => error.type === "cancelled" && error.message === "cancelled by reader");
	});
});

it("DeepSeek search and LM Studio use the terminal result for their selected protocol", async () => {
	for (const [Adapter, type, protocol, options] of [
		[OpenAICompatibleProvider, "openai-compatible", responses, { webSearch: { protocol: "deepseek" } }],
		[LMStudioProvider, "lm-studio", chat, {}],
	]) {
		const provider = new Adapter(fakeTransport([protocol.delta("partial"), ...protocol.limited]), { ...config, type });
		const result = await provider.stream({ ...request, ...options }, () => {});
		assert.equal(protocol.stop(result.raw), protocol.limit);
	}
});

it("Anthropic SSE and Ollama NDJSON keep their existing stream and probe behavior", async () => {
	for (const [Adapter, type, format, event] of [
		[AnthropicProvider, "anthropic", "sse", { type: "content_block_delta", delta: { text: "hello" } }],
		[OllamaProvider, "ollama", "ndjson", { message: { content: "hello" }, done: false }],
	]) {
		const host = fakeTransport([event]);
		const provider = new Adapter(host, { ...config, type });
		assert.equal((await provider.stream(request, () => {})).text, "hello");
		assert.equal(host.requests[0].format, format);
		assert.equal(await provider.probeStreaming(request), true);
	}
});
