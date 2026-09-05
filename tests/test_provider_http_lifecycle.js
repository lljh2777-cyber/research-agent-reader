"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const Module = require("node:module");

async function withServer(handler, run) {
	const server = http.createServer(handler);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		await run(`http://127.0.0.1:${server.address().port}`);
	} finally {
		const closed = new Promise((resolve) => server.close(resolve));
		server.closeAllConnections();
		await closed;
	}
}

async function rejectsWithin(promise, type, label, deadlineMs = 1500) {
	let timer;
	try {
		await assert.rejects(
			Promise.race([
				promise,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`${label}: request did not settle`)), deadlineMs);
				}),
			]),
			(error) => error.type === type,
			label,
		);
	} finally {
		clearTimeout(timer);
	}
}

async function testProviderHttpLifecycle(transport) {
	await withServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end('{"ok":true}');
	}, async (url) => {
		const result = await transport.providerHttpRequest({ url });
		assert.deepEqual(result.json, { ok: true }, "a complete response must still succeed");
	});

	await withServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.end('data: {"delta":"complete"}\n\ndata: [DONE]\n\n');
	}, async (url) => {
		const events = [];
		await transport.providerHttpStream({ url, format: "sse", onEvent: (event) => events.push(event) });
		assert.deepEqual(events, ['{"delta":"complete"}', "[DONE]"]);
	});

	// Send headers and body first, so the failure belongs to IncomingMessage,
	// not to ClientRequest's pre-response error path. The deadline is shorter
	// than the transport's 3-second minimum timeout and catches a stuck Promise.
	await withServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
		response.write('{"partial":', () => {
			const timer = setTimeout(() => response.destroy(), 25);
			response.once("close", () => clearTimeout(timer));
		});
	}, async (url) => {
		await rejectsWithin(transport.providerHttpRequest({ url, timeoutMs: 3000 }), "network", "partial JSON body");
	});

	await withServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.write('data: {"delta":"A"}\n\ndata: {"delta":"unfinished', () => {
			const timer = setTimeout(() => response.destroy(), 25);
			response.once("close", () => clearTimeout(timer));
		});
	}, async (url) => {
		const events = [];
		await rejectsWithin(transport.providerHttpStream({
			url, format: "sse", timeoutMs: 3000, onEvent: (event) => events.push(event),
		}), "network", "partial SSE body");
		assert.deepEqual(events, ['{"delta":"A"}'], "an incomplete final event must not be delivered");
	});

	for (const streaming of [false, true]) {
		let sentFirstChunk;
		const firstChunk = new Promise((resolve) => { sentFirstChunk = resolve; });
		await withServer((_request, response) => {
			response.writeHead(200, { "Content-Type": streaming ? "text/event-stream" : "application/json" });
			response.write(streaming ? 'data: {"delta":"A"}\n\n' : '{"partial":', sentFirstChunk);
		}, async (url) => {
			let cancel;
			const options = { url, timeoutMs: 3000, registerCancel: (callback) => { cancel = callback; } };
			const pending = streaming
				? transport.providerHttpStream({ ...options, format: "sse", onEvent: () => {} })
				: transport.providerHttpRequest(options);
			const rejected = rejectsWithin(pending, "cancelled", streaming ? "cancel SSE" : "cancel JSON");
			await firstChunk;
			cancel();
			cancel();
			await rejected;
		});
	}

	// A read timeout must reject directly and keep its original classification,
	// even though destroying the response also emits aborted/error/close events.
	await withServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		response.write('data: {"delta":"A"}\n\n');
	}, async (url) => {
		await rejectsWithin(transport.providerHttpStream({
			url, format: "sse", timeoutMs: 3000, onEvent: () => {},
		}), "read-timeout", "SSE read timeout", 5000);
	});
}

module.exports = { testProviderHttpLifecycle };

if (require.main === module) {
	// Focused source-level run: compile only the transport in memory, leaving
	// main.js and the filesystem untouched. The full provider suite also calls
	// these cases against the normal production bundle.
	const { outputFiles } = require("esbuild").buildSync({
		entryPoints: [path.resolve(__dirname, "../src/providers/http-transport.ts")],
		bundle: true,
		write: false,
		platform: "node",
		format: "cjs",
		target: "node20",
	});
	const compiled = new Module(__filename, module);
	compiled.filename = __filename;
	compiled.paths = module.paths;
	compiled._compile(outputFiles[0].text, __filename);
	const transport = new compiled.exports.ProviderHttpTransport();
	testProviderHttpLifecycle({
		providerHttpRequest: (options) => transport.request(options),
		providerHttpStream: (options) => transport.stream(options),
	}).then(() => {
		console.log("PROVIDER_HTTP_LIFECYCLE_TEST_OK");
	}).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
