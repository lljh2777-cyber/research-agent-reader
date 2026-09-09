import * as https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout, clearTimeout } from "node:timers";
import { SourceError } from "./errors";
import { oaUrl } from "./url-policy";

const HOSTS = new Set(["www.ebi.ac.uk", "api.crossref.org", "pmc-oa-opendata.s3.amazonaws.com", "api.unpaywall.org"]);
export function sourceUrl(raw: string): URL {
	let url: URL; try { url = new URL(raw); } catch { throw new SourceError("invalid_url", "来源地址格式无效"); }
	if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !HOSTS.has(url.hostname) || raw.length > 4096) throw new SourceError("blocked_url", "该地址不属于受支持的 HTTPS 来源");
	return url;
}
function v6number(address: string): bigint {
	const halves = address.split("::"); if (halves.length > 2 || address.includes(".")) return 0n;
	const left = halves[0] ? halves[0].split(":") : [], right = halves[1] ? halves[1].split(":") : [];
	const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n);
}
export function publicAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a,b,c] = address.split(".").map(Number);
		return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && [0,2].includes(c)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
	}
	if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
	const value = v6number(address), inRange = (base: string, bits: number) => value >> BigInt(128 - bits) === v6number(base) >> BigInt(128 - bits);
	return inRange("2000::", 3) && ![ ["2001::",23], ["2001:db8::",32], ["2002::",16], ["3fff::",20] ].some(([base,bits]) => inRange(String(base), Number(bits)));
}
function sameAddress(actual: string | undefined, expected: string): boolean {
	if (!actual) return false;
	const normalized = actual.replace(/^::ffff:/i, "");
	return normalized === expected || (isIP(normalized) === 6 && isIP(expected) === 6 && v6number(normalized) === v6number(expected));
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason || new SourceError("cancelled", "请求已停止"));
		if (signal.aborted) { promise.catch(() => undefined); abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason || new SourceError("cancelled", "请求已停止")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	});
}
class Gate {
	private active = 0;
	constructor(private limit: number) {}
	async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
		while (this.active >= this.limit) await delay(25, signal);
		signal.throwIfAborted(); this.active++; try { return await work(); } finally { this.active--; }
	}
}
export interface ByteSink { write(bytes: Uint8Array): Promise<void>; }
export interface ByteResponse { status: number; headers: Record<string, string>; bytes: Uint8Array; }
export interface DownloadPolicy { dynamic?: boolean; budget?: { received: number; limit: number }; }
export interface SourceTransport {
	metadata(url: string, signal: AbortSignal): Promise<ByteResponse>;
	download(url: string, signal: AbortSignal, sink: ByteSink, progress: (received: number, total?: number) => void, policy?: DownloadPolicy): Promise<void>;
}
export interface TransportDeps { lookup: typeof lookup; request: typeof https.request; }
/** Direct HTTPS only. No ambient proxy, browser cookies, credentials or shared socket agent. */
export class HttpsSourceTransport implements SourceTransport {
	private metadataGate = new Gate(2); private fileGate = new Gate(1);
	private hostNext = new Map<string, number>();
	constructor(private deps: TransportDeps = { lookup, request: https.request }) {}
	private async pace(host: string, signal: AbortSignal): Promise<void> {
		const at = Math.max(Date.now(), this.hostNext.get(host) || 0); this.hostNext.set(host, at + 400); await delay(Math.max(0, at - Date.now()), signal);
	}
	async metadata(url: string, signal: AbortSignal): Promise<ByteResponse> {
		return this.metadataGate.run(signal, async () => {
			for (let attempt = 0; ; attempt++) {
				const chunks: Uint8Array[] = [];
				const response = await this.transfer(url, signal, { write: async bytes => { chunks.push(bytes); } }, 2 * 1024 * 1024, 12000);
				if (attempt === 0 && [429,502,503,504].includes(response.status)) {
					const raw = response.headers["retry-after"], requested = /^\d+$/.test(raw || "") ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : 500;
					if (Number.isFinite(requested) && requested >= 0 && requested <= 3000) { await delay(Math.max(400, requested), signal); continue; }
				}
				return { ...response, bytes: Buffer.concat(chunks) };
			}
		});
	}
	async download(url: string, signal: AbortSignal, sink: ByteSink, progress: (received: number, total?: number) => void, policy?: DownloadPolicy): Promise<void> {
		await this.fileGate.run(signal, async () => { await this.transfer(url, signal, sink, 64 * 1024 * 1024, 120000, progress, policy); });
	}
	private async transfer(raw: string, parent: AbortSignal, sink: ByteSink, limit: number, timeout: number, progress?: (received: number, total?: number) => void, policy?: DownloadPolicy): Promise<{status: number; headers: Record<string,string>}> {
		const controller = new AbortController(), relay = () => controller.abort(parent.reason);
		parent.addEventListener("abort", relay, { once: true }); if (parent.aborted) relay();
		const timer = setTimeout(() => controller.abort(new SourceError("timeout", "来源请求超时，请检查直连网络后重试")), timeout);
		let bytes = 0;
		try {
			const validateUrl = policy?.dynamic ? oaUrl : sourceUrl;
			let url = validateUrl(raw);
			for (let redirects = 0; ; redirects++) {
				await this.pace(url.hostname, controller.signal);
				const answers = await abortable(this.deps.lookup(url.hostname, { all: true }), controller.signal);
				if (!answers.length || answers.some(a => !publicAddress(a.address))) throw new SourceError("blocked_address", "来源域名解析到非公网地址；本版本不支持代理 DNS 或私网目标");
				const selected = answers.find(a => a.family === 4) || answers[0];
				const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
					const request = this.deps.request(url, { agent: false, family: selected.family, servername: url.hostname, signal: controller.signal,
						lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
						headers: { "User-Agent": "Research-Agent-Reader/0.46.0", Accept: progress ? "application/pdf, application/octet-stream" : "application/json, application/xml, text/xml", "Accept-Encoding": "identity" },
					}, resolve);
					const connectTimer = setTimeout(() => request.destroy(new SourceError("connect_timeout", "来源连接超时")), 15000);
					request.once("socket", socket => { socket.once("secureConnect", () => { clearTimeout(connectTimer); if (!sameAddress(socket.remoteAddress, selected.address)) request.destroy(new SourceError("address_changed", "实际连接地址与已验证地址不一致")); }); });
					request.setTimeout(30000, () => request.destroy(new SourceError("idle_timeout", "来源长时间未传输数据")));
					request.once("error", reject); request.once("close", () => clearTimeout(connectTimer)); request.end();
				});
				const status = response.statusCode || 0, headers: Record<string,string> = {};
				for (const [key, value] of Object.entries(response.headers)) if (typeof value === "string") headers[key.toLowerCase()] = value;
				if ([301,302,303,307,308].includes(status)) {
					response.destroy(); if (redirects >= 3 || !headers.location) throw new SourceError("redirect_limit", "来源重定向次数超限");
					const next = validateUrl(new URL(headers.location, url).href); if (!policy?.dynamic && next.origin !== url.origin) throw new SourceError("cross_origin_redirect", "来源跳转到其他站点，本版本停止此请求"); url = next; continue;
				}
				try {
					if (headers["content-encoding"] && headers["content-encoding"] !== "identity") throw new SourceError("encoded_response", "来源返回压缩响应，本版本仅接收原始字节");
					if (progress && status !== 200) throw new SourceError("http_" + status, `PDF 来源返回 HTTP ${status}；请重新查询来源`);
					if (progress && !/^(application\/(pdf|octet-stream|x-pdf|binary)|binary\/octet-stream)(;|$)/i.test(headers["content-type"] || "")) throw new SourceError("not_pdf", "来源返回的不是 PDF 文件类型");
					const length = headers["content-length"];
					if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) throw new SourceError("size_limit", "来源响应大小无效或超过上限");
					const total = length === undefined ? undefined : Number(length);
					for await (const rawChunk of response) { controller.signal.throwIfAborted(); const chunk = Buffer.from(rawChunk); bytes += chunk.length;
						if (policy?.budget) { policy.budget.received += chunk.length; if (policy.budget.received > policy.budget.limit) throw new SourceError("total_size_limit", "本次候选获取累计超过 128 MiB，已停止"); }
						if (bytes > limit) throw new SourceError("size_limit", "实际接收字节超过上限，已停止传输");
						await abortable(sink.write(chunk), controller.signal); progress?.(bytes, total || undefined);
					}
					controller.signal.throwIfAborted(); if (total !== undefined && bytes !== total) throw new SourceError("truncated", "文件传输不完整");
					return { status, headers };
				} finally { response.destroy(); }
			}
		} catch (error) {
			if (controller.signal.aborted) throw controller.signal.reason || new SourceError("cancelled", "获取已停止");
			if (error instanceof SourceError) throw error;
			throw new SourceError("network_error", "无法完成 HTTPS 直连；本功能不继承系统或 Obsidian 代理，请检查网络后重试");
		} finally { clearTimeout(timer); parent.removeEventListener("abort", relay); }
	}
}
