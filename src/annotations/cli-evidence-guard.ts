// A narrow guard for a reproduced failure, not a scientific-content validator.
// Missing adjustment details must not become an assertion of no adjustment.
export function verifyCliAdjustmentClaim(text: string, evidence: string): void {
	const sourceMentions = /unadjusted|not adjusted|without (?:covariate |statistical )?adjustment|no (?:covariate |statistical )?adjustment|未经(?:调整|校正)|未(?:做|作|进行)?(?:协变量)?(?:调整|校正)/gi;
	const uncertainBefore = /未报告|未说明|未提供|未知|是否|并非|不等于|不能|不应|假设|如果|\b(?:whether|unknown|unspecified|unreported|if)\b|\b(?:do|does|did)\s+not\s+(?:report|state|describe|provide|specify)\b|\b(?:no|not|never|rather than|instead of)\s+(?:an?\s+)?$/i;
	const uncertainAfter = /未(?:被)?(?:报告|说明|提供|进行)|未知|不明|\b(?:not|never)\s+(?:(?:been|explicitly|clearly)\s+)?(?:reported|specified|provided|described|known|stated|performed|conducted)\b/i;
	const supported = [...evidence.matchAll(sourceMentions)].some(match => {
		const start = match.index!, prefix = evidence.slice(Math.max(0, start - 70), start).split(/[。！？.!?;\n，,；]/).pop() || "";
		const suffix = evidence.slice(start + match[0].length, start + match[0].length + 70).split(/[。！？.!?;\n，,；]/)[0];
		// An unrelated denial of causation is not a denial of adjustment.
		return !uncertainBefore.test(prefix) && !uncertainAfter.test(suffix);
	});
	if (supported) return;
	const assertions = /(?:属于|理解为|代表|表示|是|为)[^。！？\n]{0,24}?(?:未经(?:调整|校正)|未(?:调整|校正))/g;
	for (const clause of text.split(/[。！？.!?;\n，,；]/)) {
		for (const match of clause.matchAll(assertions)) {
			const qualifier = clause.slice(0, match.index) + match[0].split(/未经|未调整|未校正/)[0];
			// Uncertainty in an earlier clause must not hide a later assertion.
			if (/(?:不能|不应|不可|并非|不是|未必|不等于|无法|是否|可能|可以|若|如果|假设|则|那么)/.test(qualifier)) continue;
			throw new Error("解释将未提供的调整信息断言为未调整；未保留，请对照原文核对。插件不会自动重试或更换模型");
		}
	}
}
