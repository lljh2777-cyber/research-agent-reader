import * as http from "node:http";
import * as https from "node:https";

import type {
	NormalizedProviderError,
	ProviderHttpRequestOptions,
	ProviderHttpResponse,
	ProviderHttpStreamOptions,
	ProviderHttpStreamResponse,
} from "../types/contracts";
import {
	ProviderConnectionError,
	parseProviderJson,
	providerErrorMessage,
} from "./shared";

const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MIN_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function normalizeTimeout(value: unknown): number {
	return Math.max(
		MIN_TIMEOUT_MS,
		Math.min(MAX_TIMEOUT_MS, Number(value || DEFAULT_TIMEOUT_MS)),
	);
}

function normalizeResponseLimit(value: unknown): number {
	return Math.max(
		MIN_MAX_RESPONSE_BYTES,
		Math.min(MAX_MAX_RESPONSE_BYTES, Number(value || DEFAULT_MAX_RESPONSE_BYTES)),
	);
}

function parseEndpoint(value: string): URL {
	try {
		return new URL(value);
	} catch {
		throw new ProviderConnectionError("configuration", `无效 endpoint：${value}`);
	}
}

function transportFor(endpoint: URL): typeof http | typeof https {
	return endpoint.protocol === "https:" ? https : http;
}

function httpError(
	status: number,
	endpoint: string,
	payload: unknown,
	fallback: string,
): ProviderConnectionError {
	const detail = providerErrorMessage(payload, fallback || `HTTP ${status}`);
	let type = "http";
	if (status === 401 || status === 403) type = "authentication";
	else if (status === 404 && /model/i.test(detail)) type = "model-not-found";
	else if (status === 404) type = "endpoint-not-found";
	else if (status === 408 || status === 504) type = "timeout";
	else if (status === 429) type = "rate-limit";
	else if (status >= 500) type = "server";
	return new ProviderConnectionError(type, detail, { status, endpoint });
}

function networkError(error: unknown, endpoint: string): ProviderConnectionError {
	if (error instanceof ProviderConnectionError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const type = /cancelled|已停止/i.test(message)
		? "cancelled"
		: /ECONNREFUSED|connection refused/i.test(message)
			? "local-service-offline"
			: /ENOTFOUND|ERR_NAME_NOT_RESOLVED|DNS/i.test(message)
				? "dns"
				: "network";
	return new ProviderConnectionError(type, message, { endpoint });
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (error instanceof ProviderConnectionError) {
		return {
			type: error.type,
			status: error.status,
			endpoint: error.endpoint,
			message: error.message,
		};
	}
	if (
		error
		&& typeof error === "object"
		&& "type" in error
		&& typeof error.type === "string"
	) {
		const candidate = error as {
			type: string;
			status?: unknown;
			endpoint?: unknown;
			message?: unknown;
		};
		return {
			type: candidate.type,
			status: Number(candidate.status || 0),
			endpoint: String(candidate.endpoint || ""),
			message: error instanceof Error
				? error.message
				: String(candidate.message || candidate.type),
		};
	}
	return {
		type: "unknown",
		status: 0,
		endpoint: "",
		message: error instanceof Error ? error.message : String(error),
	};
}

export class ProviderHttpTransport {
	request(options: ProviderHttpRequestOptions): Promise<ProviderHttpResponse> {
		const timeoutMs = normalizeTimeout(options.timeoutMs);
		const maxResponseBytes = normalizeResponseLimit(options.maxResponseBytes);
		return new Promise<ProviderHttpResponse>((resolve, reject) => {
			let endpoint: URL;
			try {
				endpoint = parseEndpoint(options.url);
			} catch (error) {
				reject(error);
				return;
			}
			const transport = transportFor(endpoint);
			const body = options.body === undefined ? "" : JSON.stringify(options.body);
			const headers = {
				...(options.headers || {}),
				...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
			};
			let settled = false;
			let phase = "connect";
			let responseBytes = 0;
			let totalTimer: ReturnType<typeof setTimeout> | null = null;
			const chunks: string[] = [];
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				if (totalTimer !== null) clearTimeout(totalTimer);
				callback();
			};
			const request = transport.request(endpoint, {
				method: options.method || "GET",
				headers,
			}, (response) => {
				phase = "read";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					responseBytes += Buffer.byteLength(chunk);
					if (responseBytes > maxResponseBytes) {
						request.destroy(new ProviderConnectionError(
							"response-too-large",
							`响应体超过 ${Math.round(maxResponseBytes / 1024 / 1024)} MB 上限`,
							{ endpoint: options.url },
						));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					const text = chunks.join("");
					const json = parseProviderJson(text);
					const status = Number(response.statusCode || 0);
					if (status < 200 || status >= 300) {
						finish(() => reject(httpError(
							status,
							options.url,
							json,
							text.slice(0, 500),
						)));
						return;
					}
					finish(() => resolve({
						status,
						endpoint: options.url,
						headers: response.headers || {},
						text,
						json,
					}));
				});
			});
			totalTimer = setTimeout(() => {
				request.destroy(new ProviderConnectionError(
					phase === "connect" ? "connect-timeout" : "read-timeout",
					`请求超过 ${Math.round(timeoutMs / 1000)} 秒`,
					{ endpoint: options.url },
				));
			}, timeoutMs);
			request.setTimeout(timeoutMs, () => {
				request.destroy(new ProviderConnectionError(
					phase === "connect" ? "connect-timeout" : "read-timeout",
					`请求超过 ${Math.round(timeoutMs / 1000)} 秒`,
					{ endpoint: options.url },
				));
			});
			request.on("error", (error) => {
				finish(() => reject(networkError(error, options.url)));
			});
			options.registerCancel?.(() => {
				request.destroy(new ProviderConnectionError(
					"cancelled",
					"已停止本轮查询",
					{ endpoint: options.url },
				));
			});
			if (body) request.write(body);
			request.end();
		});
	}

	stream(options: ProviderHttpStreamOptions): Promise<ProviderHttpStreamResponse> {
		const timeoutMs = normalizeTimeout(options.timeoutMs);
		const maxResponseBytes = normalizeResponseLimit(options.maxResponseBytes);
		return new Promise<ProviderHttpStreamResponse>((resolve, reject) => {
			let endpoint: URL;
			try {
				endpoint = parseEndpoint(options.url);
			} catch (error) {
				reject(error);
				return;
			}
			const transport = transportFor(endpoint);
			const body = options.body === undefined ? "" : JSON.stringify(options.body);
			const headers = {
				...(options.headers || {}),
				...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
			};
			let settled = false;
			let responseText = "";
			let buffer = "";
			let responseBytes = 0;
			let totalTimer: ReturnType<typeof setTimeout> | null = null;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				if (totalTimer !== null) clearTimeout(totalTimer);
				callback();
			};
			const request = transport.request(endpoint, {
				method: options.method || "POST",
				headers,
			}, (response) => {
				const status = Number(response.statusCode || 0);
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					responseBytes += Buffer.byteLength(chunk);
					if (responseBytes > maxResponseBytes) {
						request.destroy(new ProviderConnectionError(
							"response-too-large",
							`响应体超过 ${Math.round(maxResponseBytes / 1024 / 1024)} MB 上限`,
							{ endpoint: options.url },
						));
						return;
					}
					responseText = `${responseText}${chunk}`.slice(-200000);
					if (status < 200 || status >= 300) return;
					buffer += chunk.replace(/\r\n/g, "\n");
					if (options.format === "ndjson") {
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						lines.map((line) => line.trim()).filter(Boolean).forEach(options.onEvent);
						return;
					}
					const events = buffer.split("\n\n");
					buffer = events.pop() || "";
					for (const event of events) {
						const data = event
							.split("\n")
							.filter((line) => line.startsWith("data:"))
							.map((line) => line.slice(5).trimStart())
							.join("\n");
						if (data) options.onEvent(data);
					}
				});
				response.on("end", () => {
					if (status < 200 || status >= 300) {
						const payload = parseProviderJson(responseText);
						finish(() => reject(httpError(
							status,
							options.url,
							payload,
							responseText.slice(0, 500),
						)));
						return;
					}
					const tail = buffer.trim();
					if (tail) {
						if (options.format === "ndjson") {
							options.onEvent(tail);
						} else {
							const data = tail
								.split("\n")
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trimStart())
								.join("\n");
							if (data) options.onEvent(data);
						}
					}
					finish(() => resolve({
						status,
						endpoint: options.url,
						headers: response.headers || {},
					}));
				});
			});
			request.setTimeout(timeoutMs, () => {
				request.destroy(new ProviderConnectionError(
					"read-timeout",
					`请求超过 ${Math.round(timeoutMs / 1000)} 秒`,
					{ endpoint: options.url },
				));
			});
			totalTimer = setTimeout(() => {
				request.destroy(new ProviderConnectionError(
					"read-timeout",
					`请求超过 ${Math.round(timeoutMs / 1000)} 秒`,
					{ endpoint: options.url },
				));
			}, timeoutMs);
			request.on("error", (error) => {
				if (settled) return;
				finish(() => reject(networkError(error, options.url)));
			});
			options.registerCancel?.(() => {
				request.destroy(new ProviderConnectionError(
					"cancelled",
					"已停止本轮查询",
					{ endpoint: options.url },
				));
			});
			if (body) request.write(body);
			request.end();
		});
	}
}
