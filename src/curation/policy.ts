import { contentHash } from "../retrieval/chunks";
import { validateModelNoteBodyMarkdown } from "../security/safe-markdown";
import type { CurationContext, CurationParagraph, CurationSuggestion, SuggestionKind } from "./types";
import { validateExcerptSuggestion } from "./excerpt";
import { validateAnswerExcerptSuggestion } from "./answer-excerpt";

export const CURATION_TARGETS = ["sources", "concepts", "methods", "synthesis"].map(folder => "wiki/" + folder + "/");
export const curationTarget = (file: string): boolean => CURATION_TARGETS.some(prefix => file.startsWith(prefix)) && file.endsWith(".md") && !/[\\[\]|#%<>:\r\n]/.test(file) && !file.split("/").some(part => !part || part.startsWith("."));
export const estimatedTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
export function protectedPrefix(text: string): string { const front = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] || ""; return front; }
/** Stable paragraph offsets into the exact file; metadata/headings/fenced blocks cannot be edited. */
export function curationParagraphs(text: string): CurationParagraph[] {
	const result: CurationParagraph[] = []; const front = protectedPrefix(text); let heading = "正文"; let start = front.length; let fenced = ""; let end = start;
	const flush = (): void => { const raw = text.slice(start, end); const trimmed = raw.trim(); if (trimmed && trimmed.length <= 6000) { const from = start + raw.indexOf(trimmed); result.push({ id: "p-" + from + "-" + contentHash(trimmed).slice(0, 10), heading, start: from, end: from + trimmed.length, text: trimmed }); } };
	for (const match of text.slice(front.length).matchAll(/^.*(?:\n|$)/gm)) {
		const line = match[0]; const offset = front.length + match.index; const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) { if (!fenced) { flush(); fenced = fence[1]; } else if (fence[1][0] === fenced[0] && fence[1].length >= fenced.length) fenced = ""; start = end = offset + line.length; continue; }
		if (fenced) { start = end = offset + line.length; continue; }
		const title = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		if (title || !line.trim()) { flush(); if (title) heading = title[1]; start = end = offset + line.length; } else { end = offset + line.length; }
	}
	flush(); return result;
}
const numbers = (text: string): string[] => text.match(/\d+(?:[.,]\d+)*(?:%|％)?/g) || [];
const units = (text: string): string[] => text.match(/(?<![A-Za-z])(?:μg|µg|ug|mg|ng|pg|kg|mM|μM|µM|nM|mm|nm|μm|µm)(?:\/(?:mL|ml|L|kg))?(?![A-Za-z])/g) || [];
const compact = (text: string): string => text.replace(/[\s，。,.!！?？*`]/g, "");
export function validateSuggestion(raw: unknown, context: CurationContext, index: number): CurationSuggestion {
	if (context.answerExcerpt) return validateAnswerExcerptSuggestion(raw, context, index);
	if (context.excerpt) return validateExcerptSuggestion(raw, context, index);
	if (!raw || typeof raw !== "object") throw new Error("整理建议结构无效");
	const value = raw as Record<string, unknown>; const kinds: SuggestionKind[] = ["add", "replace", "covered", "condition", "conflict", "insufficient"];
	if (!kinds.includes(value.kind as SuggestionKind) || typeof value.claim !== "string" || typeof value.text !== "string" || typeof value.reason !== "string" || typeof value.paragraphId !== "string" || !Array.isArray(value.citations)) throw new Error("整理建议缺少必要字段");
	if (value.citations.length > 8) throw new Error("单条建议超过 8 处引用，请拆分为更聚焦的观点后重试");
	if (value.claim.length > 500 || value.text.length > 4000 || value.reason.length > 1600) throw new Error("单条整理建议过长，请缩小范围");
	const warnings: string[] = []; const paragraph = context.target.paragraphs.find(item => item.id === value.paragraphId); const citations: CurationSuggestion["citations"] = [];
	for (const item of value.citations) {
		if (!item || typeof item.id !== "string") throw new Error("证据引用缺少 id，必须使用本批提供的证据编号");
		const evidence = context.evidence.find(e => e.id === item.id);
		const selected = evidence?.quotes?.find(q => q.id === item.quoteId);
		const quote = typeof item.quote === "string" ? item.quote : selected?.text;
		if (typeof quote !== "string" || !quote.trim() || quote.length > 1400) throw new Error(!evidence ? "引用证据编号不存在：" + item.id.slice(0, 100) : !selected && item.quoteId !== undefined ? "引用原句编号不属于该证据：" + String(item.quoteId).slice(0, 100) : "引用原句为空或超过 1400 字符，请选择本批提供的原句");
		citations.push({ id: item.id, quote, ...(typeof item.quoteId === "string" ? { quoteId: item.quoteId } : {}) });
		if (item.quoteId !== undefined && (!selected || evidence!.text.slice(selected.start, selected.end) !== selected.text || quote !== selected.text)) warnings.push("引用编号与原文位置不一致");
		if (!evidence || !evidence.text.includes(quote)) warnings.push("引用无法在本轮证据中定位");
		else if (!["本文原文", "论文依据", "背景解释"].includes(evidence.role) || /metadata-only/.test(evidence.depth)) warnings.push("引用属于来源边界或非事实内容");
	}
	if (!paragraph) warnings.push("目标段落不存在");
	if (value.kind === "replace" && paragraph && /\[\[|\]\(/.test(paragraph.text)) warnings.push("替换会影响原段落链接，请改为追加补充");
	if (!citations.length) warnings.push("缺少可核对的证据引用");
	if (!context.sourceCompatible) warnings.push("来源笔记与当前论文身份未匹配");
	if (value.text.trim() && (validateModelNoteBodyMarkdown(value.text).length || /^\s*#{1,6}\s/m.test(value.text) || /\[\[|\]\(|\[\^[^\]]*\]|^\s*---\s*$/m.test(value.text))) warnings.push("建议正文包含未授权结构或链接");
	const quoted = citations.map(c => c.quote).join("\n");
	if (numbers(value.text).some(n => !numbers(quoted).includes(n))) warnings.push("建议中的数值未在引用原句中出现");
	if (units(value.text).some(unit => !units(quoted).includes(unit))) warnings.push("建议中的单位未在引用原句中出现");
	const proposedText = value.text;
	if (citations.some(c => /未|没有|不/.test(c.quote) && compact(c.quote).replace(/未|没有|不/g, "") === compact(proposedText))) warnings.push("建议与原句的否定关系不一致");
	if (/(?:图\s*\d|figure\s*\d)/i.test(value.text) && !citations.some(c => context.evidence.find(e => e.id === c.id)?.visual)) warnings.push("本轮未直接读取相关图像，图表判断需复核");
	if (["add", "replace", "condition"].includes(String(value.kind)) && !value.text.trim()) warnings.push("没有待写入的正文");
	let kind = value.kind as SuggestionKind;
	const comparison = value.comparison as CurationSuggestion["comparison"];
	if (kind === "conflict" && context.ruleVersion === "curation-v2" && (!comparison || typeof comparison.targetQuote !== "string" || !comparison.targetQuote.trim() || !paragraph?.text.includes(comparison.targetQuote) || !citations.some(c => c.id === comparison.evidenceId))) {
		kind = "insufficient"; warnings.push("缺少双方可定位依据，暂按证据不足处理；不能从未验证推断相反结论");
	}
	return { id: "s-" + index, kind, modelKind: kinds.includes(value.modelKind as SuggestionKind) ? value.modelKind as SuggestionKind : value.kind as SuggestionKind,
		...(comparison && typeof comparison.targetQuote === "string" && typeof comparison.evidenceId === "string" ? { comparison } : {}), paragraphId: value.paragraphId, claim: value.claim, text: value.text, reason: value.reason,
		citations, warnings: [...new Set(warnings)], applicable: ["add", "replace", "condition"].includes(kind) && warnings.length === 0, decision: "pending" };
}
export function parseCurationResult(text: string, context: CurationContext): CurationSuggestion[] {
	let raw;
	try { raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
	catch { throw new Error("模型返回的整理内容不是有效 JSON；未改写笔记，请重试"); }
	if (!raw || !Array.isArray(raw.suggestions) || raw.suggestions.length > 5 || !raw.suggestions.length) throw new Error("模型须返回一至五条结构化建议");
	return raw.suggestions.map((value: unknown, index: number) => validateSuggestion(value, context, index));
}
