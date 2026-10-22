import { verifyCliAdjustmentClaim } from "./cli-evidence-guard";

const boundaries = /[。！？.!?;\n，,；]/;
const denial = /不能|不应|不可|并非|不是|不等于|无法|是否|未说明|未报告|未知|假设|如果|\b(?:not|no|whether|unknown|unreported|if)\b/i;

function sourceAffirms(source: string, pattern: RegExp): boolean {
	return [...source.matchAll(pattern)].some(match => {
		const prefix = source.slice(0, match.index).split(boundaries).pop() || "";
		const suffix = source.slice(match.index! + match[0].length).split(boundaries)[0];
		return !denial.test(prefix) && !/未(?:被)?(?:报告|说明)|\bnot\s+(?:reported|stated)\b/i.test(suffix);
	});
}

function meaningAffirms(meaning: string, pattern: RegExp): boolean {
	return meaning.split(boundaries).some(clause => [...clause.matchAll(pattern)].some(match =>
		!denial.test(clause.slice(0, match.index)) && !/无法判断|缺乏依据|未获支持|没有依据|不支持/.test(clause.slice(match.index! + match[0].length))));
}

function verifyStrength(meaning: string, quote: string): void {
	// Ordinary degree wording is not a reported significance test. Keep this
	// guard narrow: explicit significance language remains eligible for paraphrase.
	if (/\bmarkedly\s+different\b/i.test(quote) && !/\bsignifican(?:t|ce|tly)\b|统计显著/i.test(quote)
		&& meaningAffirms(meaning, /显著(?:性|地)?(?:差异|不同)|(?:差异|不同)(?:在统计上)?(?:具有)?显著(?:性)?|统计(?:上)?显著/g)) {
		throw new Error("释义将明显差异写为显著差异，原文引句未明确统计显著性；请使用中性程度表述，未保留");
	}
	const assertions = /(?:较|很|非常|更)?(?:强|弱)(?:烈)?(?:的)?(?:关联|相关性?|效应)|(?:高度|密切|紧密)(?:关联|相关)|(?:关联|相关性?|效应)(?:强度|程度)?(?:较|很|非常)?(?:强|弱)(?!度|强|弱)|(?:较|很|非常)?(?:大|小)(?:的)?效应/g;
	for (const clause of meaning.split(boundaries)) {
		for (const match of clause.matchAll(assertions)) {
			if (denial.test(clause.slice(0, match.index)) || /无法判断|缺乏依据|未获支持/.test(clause.slice(match.index! + match[0].length))) continue;
			const weak = /弱|小/.test(match[0]), effect = /效应/.test(match[0]);
			const pattern = effect
				? weak ? /(?:small|weak)\s+effect|(?:小|弱)(?:的)?效应/gi : /(?:large|strong)\s+effect|(?:大|强)(?:的)?效应/gi
				: weak ? /weak\s+(?:association|correlation)|weakly\s+(?:associated|correlated)|弱(?:的)?(?:关联|相关性?)/gi : /strong\s+(?:association|correlation)|strongly\s+(?:associated|correlated)|(?:强(?:的)?|密切|高度|紧密)(?:关联|相关性?)/gi;
			if (!sourceAffirms(quote, pattern)) throw new Error("解释添加了原文引句未给出的关联强弱或效应大小判断；未保留，不自动重试或更换模型");
		}
	}
}

function verifyPurpose(meaning: string, quote: string): void {
	const ratioClaim = meaningAffirms(meaning, /(?:上皮|肿瘤细胞|间质|基质).{0,50}(?:比例|占比|构成).{0,25}(?:均衡|均等|相等|平衡)/g);
	const ratioSource = /(?:equal|balanced)\s+(?:cell\s+)?(?:proportions|ratios)|(?:proportions|ratios)\s+(?:were\s+)?(?:equal|balanced)|(?:比例|占比).{0,25}(?:相等|均衡)/gi;
	if (ratioClaim && !sourceAffirms(quote, ratioSource)) throw new Error("解释把研究目的扩写为比例均衡，原文引句没有该依据；未保留");
	const threshold = /(?:上皮|肿瘤细胞).{0,25}(?:门槛|阈值|含量)/.test(meaning);
	const mechanism = meaningAffirms(meaning, /(?:信号|差异).{0,50}(?:均衡|减少|避免|减弱|主导|稀释)|(?:减少|避免|减弱|消除).{0,50}(?:干扰|信号|差异)/g);
	if (!threshold || !mechanism) return;
	const explicit = /(?:reduce(?:d|s)?|decrease(?:d|s)?|prevent(?:ed|s)?|balance(?:d|s)?).{0,55}(?:interference|variation|variance|signal)|(?:减少|降低|避免).{0,35}(?:干扰|变异|信号|差异)/gi;
	// A purpose ("to reduce") is not a reported achieved effect.
	const supported = [...quote.matchAll(explicit)].some(match => {
		const prefix = quote.slice(0, match.index).split(boundaries).pop() || "";
		return !denial.test(prefix) && !/\b(?:to|in order to)\s+(?:help\s+)?$|目的|为了|旨在/i.test(prefix);
	});
	if (!supported) throw new Error("解释补充了原文引句未报告的阈值作用或信号机制；未保留");
}

function paragraph(value: unknown, limit: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit || /[\r\n]/.test(value)) throw new Error("CLI 批注字段无效或超限；未保留");
	if (/(?:^|[。；])\s*(?:一般知识(?:[／/]解释性推断)?|背景知识|解释性推断)[：:]/.test(value)) throw new Error("本次原文释义不接受额外背景推演；未保留");
	return value.trim();
}

/** Reproduced extensions only; this does not claim general semantic verification. */
function verifyScope(meaning: string, quote: string): void {
	for (const [claim, source] of [
		[/药物(?:发现|开发|研发)|合成化学空间/, /drug\s+(?:discovery|development)|synthetic\s+chemical\s+space|药物(?:发现|开发|研发)|合成化学空间/i],
		[/随机森林/, /random\s+forests?|随机森林/i],
	] as [RegExp, RegExp][]) {
		if (!source.test(quote)) for (const clause of meaning.split(boundaries)) {
			const match = claim.exec(clause);
			if (match && !denial.test(clause.slice(0, match.index))) throw new Error("释义补入引句之外的背景或方法身份；未保留，不自动重试");
		}
	}
	if (/(?:译文|翻译).{0,40}(?:准确|一致|正确|无误|无歧义)|无歧义或错误/.test(meaning)) throw new Error("释义包含自由撰写的翻译审阅结论；未保留");
	const sourceDescribesFigure = sourceAffirms(quote, /\bfig(?:ure)?s?\.?\s*\d+[a-z]?(?:\s*[–-]\s*[a-z])?\s+(?:shows?|illustrates?|depicts?|demonstrates?|presents?)\b|(?:shown|illustrated|depicted)\s+in\s+(?:fig(?:ure)?\.?|图)|图\s*\d+[a-z]?(?:中)?(?:显示|展示|说明|呈现)/gi);
	for (const clause of meaning.split(boundaries)) {
		const claim = /(?:图\s*(?:\d[\da-zA-Z\s–—.,-]*|中|上)|如图|从图)[^。！？;；]{0,35}?(?:显示|展示|表明|证明|揭示|说明|呈现|反映|描绘|可见|所示)/g;
		for (const match of clause.matchAll(claim)) {
			const prefix = clause.slice(0, match.index! + match[0].length);
			if (/不能|无法|没有|并非|未(?:核对|查看|显示|展示|说明)/.test(prefix)) continue;
			if (!sourceDescribesFigure) throw new Error("释义推断了未核对的图示内容；图号仅是引用，未保留");
		}
	}
}

export function renderCliGroundedExplanation(text: string, evidence: string, language?: "en" | "zh-CN", selectedText = "", translationStatus?: "possible-match" | "difference"): string {
	let parsed: unknown;
	try { parsed = JSON.parse(text.trim().replace(/^```json\s*\n([\s\S]*)\n```$/, "$1")); }
	catch { throw new Error("CLI 未返回有效的原文引句与释义；未保留，不自动重试或更换模型"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CLI 原文释义结构无效；未保留");
	const result = parsed as Record<string, unknown>, keys = Object.keys(result);
	if (keys.some(key => key !== "claims") || !Array.isArray(result.claims) || result.claims.length < 1 || result.claims.length > 2) throw new Error("CLI 原文释义结构无效或含额外背景字段；未保留");
	const comparison = language === "zh-CN" ? translationStatus === "difference"
		? "模型提示选区可能存在差异；下文仅按候选英文引句释义，译文与对应关系仍待人工核对。"
		: "下文仅按候选英文引句释义；句子定位不代表译文准确或无歧义，译文与对应关系仍待人工核对。" : undefined;
	const quotes: string[] = [], meanings: string[] = [];
	for (const claim of result.claims) {
		if (!claim || typeof claim !== "object" || Array.isArray(claim) || Object.keys(claim).some(key => !["quote", "meaning"].includes(key))) throw new Error("CLI 释义条目无效；未保留");
		const row = claim as Record<string, unknown>, meaning = paragraph(row.meaning, 800);
		if (typeof row.quote !== "string" || !row.quote.trim() || row.quote.length > 1200) throw new Error("CLI 原文引句无效或超限；未保留");
		const quote = row.quote.trim().replace(/\r\n/g, "\n");
		if (!evidence.replace(/\r\n/g, "\n").includes(quote)) throw new Error("CLI 引句不在本次实际提供的原文中；未保留");
		verifyCliAdjustmentClaim(meaning, quote); verifyStrength(meaning, quote); verifyPurpose(meaning, quote); verifyScope(meaning, quote);
		quotes.push(quote); meanings.push(meaning);
	}
	if (quotes.join("").length > 1800) throw new Error("CLI 原文引句总长度超限；未保留");
	const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
	if (language !== "zh-CN" && selectedText && !quotes.some(quote => normalize(quote).includes(normalize(selectedText)) || normalize(selectedText).includes(normalize(quote)))) throw new Error("CLI 引句未覆盖本次所选文字；未保留");
	const label = language ? "英文依据：" : "原文依据：";
	return `${comparison ? `译文对照：${comparison}\n\n` : ""}${label}${meanings.join(" ")}\n\n对应原文：\n${quotes.map(quote => quote.split("\n").map(line => `> ${line}`).join("\n")).join("\n\n")}`;
}
