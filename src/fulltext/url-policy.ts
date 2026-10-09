import { isIP } from "node:net";
import { SourceError } from "./errors";

/** An OA location grants a public HTTPS target, never a credential or local network capability. */
export function oaUrl(raw: string): URL {
	let url: URL; try { url = new URL(raw); } catch { throw new SourceError("oa_url", "开放来源的 PDF 地址无效"); }
	if (raw.length > 4096 || url.protocol !== "https:" || url.port || url.username || url.password || url.hash
		|| isIP(url.hostname.replace(/^\[|\]$/g,"")) || !url.hostname.includes(".") || /\.(localhost|local|internal|lan|home|test|invalid)$/.test(url.hostname)
		|| [...url.searchParams.keys()].some(key => /email|token|signature|credential|auth|api.?key|secret|^key$|^sig$|^policy$|^expires$|^x-amz-|^x-goog-/i.test(key))) {
		throw new SourceError("oa_url", "开放来源地址不符合 HTTPS 公网策略，或包含认证/签名参数；请在官方页面查看");
	}
	return url;
}

export function contactEmail(value: unknown): string {
	if (typeof value !== "string" || value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())) throw new SourceError("unpaywall_email", "请在全文来源设置中填写有效联系邮箱", "needs_configuration");
	return value.trim();
}
