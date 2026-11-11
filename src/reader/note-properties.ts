import { annotationDisplayText } from "../annotations/markdown-selection";
import type { BilingualLanguage } from "./bilingual-document";

export interface NotePropertiesState { language?: BilingualLanguage; expanded?: true; }
export interface NoteProperty { key: string; values: string[]; list: boolean; }
export interface ReadingNoteProperties { path: string; title: string; fields: NoteProperty[]; }

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
		? value as Record<string, unknown> : undefined;
}

export function normalizeNoteProperties(value: unknown, bilingual: boolean): NotePropertiesState | undefined {
	const input = object(value);
	const language = bilingual && (input?.language === "en" || input?.language === "zh-CN") ? input.language : undefined;
	return language || input?.expanded === true
		? { ...(language ? { language } : {}), ...(input?.expanded === true ? { expanded: true } : {}) } : undefined;
}

const MAX_HEADER = 128 * 1024;
const limit = (text: string, size: number): string => text.length > size ? text.slice(0, size) + "…" : text;
function displayValue(value: unknown, budget: { nodes: number }, depth = 0): string {
	if (--budget.nodes < 0) return "…";
	if (typeof value === "string") return limit(value.trim(), 12000);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Date && Number.isFinite(value.getTime())) {
		const iso = value.toISOString();
		return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
	}
	if (depth >= 3) return value && typeof value === "object" ? "…" : "";
	if (Array.isArray(value)) return limit(value.slice(0, 24).map(item => displayValue(item, budget, depth + 1)).filter(Boolean).join("、"), 12000);
	const mapping = object(value);
	return mapping ? limit(Object.entries(mapping).slice(0, 24).map(([key, item]) => `${limit(key, 200)}: ${displayValue(item, budget, depth + 1)}`).join("\n"), 12000) : "";
}

/** Read a bounded frontmatter snapshot. YAML values are display data, never HTML. */
export function readNoteProperties(path: string, text: string, parse: (yaml: string) => unknown, language?: BilingualLanguage): ReadingNoteProperties {
	const opener = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
	let bodyStart = opener ? text.length : 0, meta: Record<string, unknown> | undefined;
	if (opener) {
		const header = text.slice(opener[0].length, MAX_HEADER);
		const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(header);
		if (close && (close.index + close[0].length < header.length || text.length <= MAX_HEADER)) {
			bodyStart = opener[0].length + close.index + close[0].length;
			try { meta = object(parse(header.slice(0, close.index))); } catch { /* An invalid header must not block reading. */ }
		}
	}
	const fields: NoteProperty[] = [];
	for (const [key, value] of Object.entries(meta ?? {}).slice(0, 80)) {
		const list = Array.isArray(value);
		const budget = { nodes: 160 };
		const values = list ? value.slice(0, 64).map(item => displayValue(item, budget)).filter(Boolean) : [displayValue(value, budget)].filter(Boolean);
		fields.push({ key: limit(key, 200), values, list });
	}
	const keys = language === "zh-CN" ? ["titleZh", "title_zh", "title_zh-CN", "title"]
		: language === "en" ? ["titleEn", "title_en", "title"] : ["title"];
	const title = keys.map(key => meta && Object.prototype.hasOwnProperty.call(meta, key) && typeof meta[key] === "string" ? meta[key].trim() : "").find(Boolean);
	const heading = /^\uFEFF?(?:[ \t]*\r?\n)* {0,3}#[ \t]+([^\r\n]+)/.exec(text.slice(bodyStart, bodyStart + 4096))?.[1];
	const fallback = heading ? annotationDisplayText(heading.replace(/\s+#+\s*$/, "")) : "";
	return { path, title: limit(title || fallback || path.split("/").pop()?.replace(/\.md$/i, "") || path, 1000), fields };
}

export function notePropertyUrl(value: string): string | undefined {
	if (!/^https?:\/\/[^\s]+$/i.test(value)) return;
	try { const url = new URL(value); if (url.hostname && !url.username && !url.password) return url.href; } catch { /* Display invalid URLs as text. */ }
}
