// A narrow guard for a reproduced failure, not a scientific-content validator.
// Missing adjustment details must not become an assertion of no adjustment.
export function verifyCliAdjustmentClaim(text: string, evidence: string): void {
	const sourceMentions = /unadjusted|not adjusted|without (?:covariate |statistical )?adjustment|no (?:covariate |statistical )?adjustment|未经(?:调整|校正)|未(?:做|作|进行)?(?:协变量)?(?:调整|校正)/gi;
	const unsupported = /未报告|未说明|未提供|未知|是否|并非|不等于|不能|不应|假设|如果|\b(?:not|whether|unknown|unspecified|unreported|if)\b/i;
	const supported = [...evidence.matchAll(sourceMentions)].some(match => {
		const start = match.index!, prefix = evidence.slice(Math.max(0, start - 70), start).split(/[。！？.;\n]/).pop() || "";
		const suffix = evidence.slice(start + match[0].length, start + match[0].length + 70).split(/[。！？.;\n]/)[0];
		return !unsupported.test(prefix + suffix);
	});
	if (supported) return;
	const assertions = /(?:属于|理解为|代表|表示|是|为)[^。！？\n]{0,24}?(?:未经(?:调整|校正)|未(?:调整|校正))/g;
	for (const match of text.matchAll(assertions)) {
		const prefix = text.slice(Math.max(0, match.index! - 18), match.index).split(/[。！？；\n]/).pop() || "";
		const qualifier = prefix + match[0].split(/未经|未调整|未校正/)[0];
		if (/(?:不能|不应|不可|并非|不是|未必|不等于|无法|是否|可能|可以|若|如果|假设)/.test(qualifier)) continue;
		throw new Error("解释将未提供的调整信息断言为未调整；未保留，请对照原文核对。插件不会自动重试或更换模型");
	}
}
