/**
 * Closed Markdown boundary for content that originates outside the plugin.
 * Obsidian's renderer invokes globally registered processors, so active
 * Markdown must never pass from MinerU/model output into that renderer.
 */

const DIRECT_IMAGE_RE = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\)))?\s*\)/g;
const INLINE_LINK_RE = /\[([^\]\r\n]+)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\)))?\s*\)/g;
const RAW_HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<![A-Za-z!-]|<\?/;
const FENCE_LINE_RE = /^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])?[ \t]*(?:`{3,}|~{3,})/;
const INDENTED_CODE_RE = /^(?:[ \t]*>[ \t]*)*(?:\t| {4})\S/;
const REFERENCE_DEFINITION_RE = /^[ \t]{0,3}\[[^\]\r\n]+\]:/;
const CALLOUT_RE = /^[ \t]*(?:>[ \t]*)+\[![^\]\r\n]+\]/i;
const DIRECTIVE_RE = /^[ \t]*(?:::|`{3,}|~{3,})/;
const BLOCK_ID_RE = /(?:^|\s)\^[A-Za-z0-9-]{1,100}\s*$/;

export interface SafeMarkdownViolation {
	kind: string;
	detail: string;
}

function safeAlt(value: string): string {
	return String(value || "").replace(/[\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Return content after a bounded sequence of CommonMark quote/list containers. */
function markdownContainerContent(value: string): string {
	let rest = String(value || "");
	for (let depth = 0; depth < 16; depth += 1) {
		const quote = /^[ \t]{0,3}>[ \t]?/.exec(rest);
		if (quote) {
			rest = rest.slice(quote[0].length);
			continue;
		}
		const list = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(rest);
		if (list) {
			rest = rest.slice(list[0].length);
			continue;
		}
		break;
	}
	return rest;
}

function normalizeLocalImageTarget(value: string): string {
	let target = String(value || "").trim();
	try { target = decodeURIComponent(target); } catch { /* Keep literal bytes. */ }
	target = target.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!target || target.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return "";
	const parts = target.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return "";
	if (!/\.(?:png|jpe?g|webp)$/i.test(target)) return "";
	return parts.join("/");
}

function passiveText(value: string): string {
	return String(value || "")
		.replace(/\\/g, "\\\\")
		.replace(/`/g, "'")
		.replace(/([*_{}\[\]<>#!~|])/g, "\\$1")
		.replace(/%{2}/g, "%\\%");
}

function htmlTokenEnd(value: string, start: number): number {
	let quote = "";
	for (let index = start + 1; index < value.length; index += 1) {
		const char = value[index];
		if (quote) {
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return index + 1;
	}
	return -1;
}

function htmlImageTarget(token: string): string {
	const match = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token);
	return normalizeLocalImageTarget(match?.[1] || match?.[2] || match?.[3] || "");
}

/** Convert every raw HTML token to passive text/newlines or a canonical local image. */
function stripRawHtml(value: string): string {
	let result = "";
	let cursor = 0;
	while (cursor < value.length) {
		const relative = value.slice(cursor).search(RAW_HTML_TAG_RE);
		if (relative < 0) return result + value.slice(cursor);
		const start = cursor + relative;
		result += value.slice(cursor, start);
		const end = htmlTokenEnd(value, start);
		if (end < 0) {
			result += "&lt;";
			cursor = start + 1;
			continue;
		}
		const token = value.slice(start, end);
		const tag = /^<\/?\s*([A-Za-z][A-Za-z0-9-]*)/.exec(token)?.[1]?.toLowerCase() || "";
		if (tag === "img") {
			const target = htmlImageTarget(token);
			result += target ? `\n![](${target})\n` : "\n[已移除非本地图片]\n";
		} else if (["br", "p", "div", "tr", "table", "thead", "tbody", "tfoot", "ul", "ol", "li"].includes(tag)) {
			result += "\n";
		} else if (["td", "th"].includes(tag)) {
			result += " | ";
		}
		cursor = end;
	}
	return result;
}

function sanitizeInline(value: string): string {
	let line = value;
	line = line.replace(/!\[\[([^\]\r\n]*)\]\]/g, (_match, label: string) => `[嵌入：${safeAlt(label)}]`);
	line = line.replace(/\[\[([^\]\r\n]*)\]\]/g, (_match, label: string) => safeAlt(String(label).split("|").pop() || label));
	line = line.replace(DIRECT_IMAGE_RE, (_match, alt: string, angle: string, plain: string) => {
		const target = normalizeLocalImageTarget(angle || plain || "");
		return target ? `![${safeAlt(alt)}](${target})` : `[已移除非本地图片：${safeAlt(alt)}]`;
	});
	line = line.replace(/!\[([^\]\r\n]*)\]\[[^\]\r\n]*\]/g, (_match, alt: string) => (
		`[已移除引用式图片：${safeAlt(alt)}]`
	));
	line = line.replace(/!\[([^\]\r\n]*)\](?!\s*(?:\(|\[))/g, (_match, alt: string) => (
		`[已移除引用式图片：${safeAlt(alt)}]`
	));
	line = line.replace(INLINE_LINK_RE, (_match, label: string, angle: string, plain: string) => {
		const target = String(angle || plain || "").trim();
		return /^(?:https:\/\/|mailto:|#)/i.test(target) ? `[${label}](${target})` : label;
	});
	line = line.replace(/\[([^\]\r\n]+)\]\[[^\]\r\n]*\]/g, "$1");
	line = line.replace(/`+/g, "'");
	line = line.replace(/%{2}/g, "%\\%");
	const containerContent = markdownContainerContent(line);
	if (/^\[![^\]\r\n]+\]/i.test(containerContent)) line = line.replace(/\[!/, "\\[!");
	if (/^::/.test(containerContent)) line = line.replace(/::/, "\\::");
	if (DIRECTIVE_RE.test(line)) line = `\\${line}`;
	return line;
}

/**
 * Build the display-only article.md. The publisher stores original MinerU
 * bytes separately as a non-Markdown .txt evidence artifact.
 */
export function derivePassiveMineruMarkdown(markdown: string): string {
	const withoutHtml = stripRawHtml(String(markdown || ""));
	const output: string[] = [];
	let fence = "";
	for (const rawLine of withoutHtml.split(/\r?\n/)) {
		const structuralLine = markdownContainerContent(rawLine);
		const match = /^[ \t]*(`{3,}|~{3,})/.exec(structuralLine);
		if (match) {
			const marker = match[1][0];
			if (!fence) fence = marker;
			else if (fence === marker) fence = "";
			output.push("> " + passiveText(rawLine));
			continue;
		}
		if (fence || INDENTED_CODE_RE.test(rawLine)) {
			output.push("> " + passiveText(rawLine.trimStart()));
			continue;
		}
		if (REFERENCE_DEFINITION_RE.test(rawLine)) {
			output.push(passiveText(rawLine));
			continue;
		}
		output.push(sanitizeInline(rawLine));
	}
	const result = output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
	const violations = validatePassiveMarkdown(result, { allowLocalImages: true });
	if (violations.length) {
		throw new Error(`无法生成安全 article.md：${violations.slice(0, 3).map((item) => item.detail).join("；")}`);
	}
	return result;
}

export function validatePassiveMarkdown(
	markdown: string,
	options: { allowLocalImages?: boolean; allowedImagePaths?: ReadonlySet<string> } = {},
): SafeMarkdownViolation[] {
	const violations: SafeMarkdownViolation[] = [];
	const value = String(markdown || "");
	const lines = value.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const structuralLine = markdownContainerContent(line);
		const at = `第 ${index + 1} 行`;
		if (FENCE_LINE_RE.test(line) || /^[ \t]*(?:`{3,}|~{3,})/.test(structuralLine)) {
			violations.push({ kind: "fenced-code", detail: `${at}包含 fenced code` });
		}
		if (INDENTED_CODE_RE.test(line) || /^(?:\t| {4})\S/.test(structuralLine)) {
			violations.push({ kind: "indented-code", detail: `${at}包含缩进代码块` });
		}
		if (REFERENCE_DEFINITION_RE.test(structuralLine)) {
			const target = /^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:<([^>\r\n]+)>|([^\s\r\n]+))/.exec(structuralLine);
			const href = String(target?.[1] || target?.[2] || "").trim();
			if (!/^(?:https:\/\/|mailto:|#)/i.test(href)) {
				violations.push({ kind: "reference-definition", detail: `${at}包含非白名单引用定义` });
			}
		}
		if (CALLOUT_RE.test(line) || /^\[![^\]\r\n]+\]/i.test(structuralLine)) {
			violations.push({ kind: "plugin-callout", detail: `${at}包含插件/Callout 指令` });
		}
		if (DIRECTIVE_RE.test(line) || /^::/.test(structuralLine)) {
			violations.push({ kind: "plugin-directive", detail: `${at}包含块级插件指令` });
		}
		if (BLOCK_ID_RE.test(line)) violations.push({ kind: "block-id", detail: `${at}包含 Obsidian block ID` });
	}
	if (RAW_HTML_TAG_RE.test(value)) violations.push({ kind: "raw-html", detail: "包含原始 HTML/XML 指令" });
	if (/!\[\[|\[\[/.test(value)) violations.push({ kind: "obsidian-embed", detail: "包含 Obsidian embed/wikilink" });
	if (/%{2}/.test(value)) violations.push({ kind: "obsidian-comment", detail: "包含 Obsidian 注释指令" });
	if (/`/.test(value)) violations.push({ kind: "code-span", detail: "包含可被插件解释的代码语法" });
	if (/~{3,}/.test(value)) violations.push({ kind: "fenced-code", detail: "包含 tilde fenced code" });
	for (const match of value.matchAll(INLINE_LINK_RE)) {
		const start = match.index || 0;
		if (start > 0 && value[start - 1] === "!") continue;
		const target = String(match[2] || match[3] || "").trim();
		if (!/^(?:https:\/\/|mailto:|#)/i.test(target)) {
			violations.push({ kind: "link", detail: `包含非白名单链接：${target.slice(0, 120)}` });
		}
	}
	for (const match of value.matchAll(/<([A-Za-z][A-Za-z0-9+.-]*:[^>\r\n]+)>/g)) {
		if (!/^(?:https:\/\/|mailto:)/i.test(match[1])) {
			violations.push({ kind: "autolink", detail: `包含非白名单 URI 自动链接：${match[1].slice(0, 120)}` });
		}
	}

	let consumedUntil = 0;
	DIRECT_IMAGE_RE.lastIndex = 0;
	for (const match of value.matchAll(DIRECT_IMAGE_RE)) {
		const start = match.index || 0;
		if (value.slice(consumedUntil, start).includes("![")) {
			violations.push({ kind: "reference-image", detail: "包含引用式或非规范图片" });
		}
		consumedUntil = start + match[0].length;
		const target = normalizeLocalImageTarget(match[2] || match[3] || "");
		if (!options.allowLocalImages || !target) {
			violations.push({ kind: "image", detail: "包含不允许的图片或外部图片" });
		} else if (options.allowedImagePaths && !options.allowedImagePaths.has(target)) {
			violations.push({ kind: "unbound-image", detail: `图片未绑定 Manifest：${target}` });
		}
	}
	if (value.slice(consumedUntil).includes("![")) {
		violations.push({ kind: "reference-image", detail: "包含引用式或非规范图片" });
	}
	return violations;
}

export function assertPassiveMineruMarkdown(
	markdown: string,
	allowedImagePaths?: ReadonlySet<string>,
): void {
	const violations = validatePassiveMarkdown(markdown, { allowLocalImages: true, allowedImagePaths });
	if (violations.length) {
		throw new Error(`article.md 含活动或未绑定 Markdown：${violations.slice(0, 5).map((item) => item.detail).join("；")}`);
	}
}

export function validateModelNoteBodyMarkdown(body: string): SafeMarkdownViolation[] {
	return validatePassiveMarkdown(body, { allowLocalImages: false });
}
