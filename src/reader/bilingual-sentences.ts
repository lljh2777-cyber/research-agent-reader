import { evidenceSentences } from "../annotations/cli-evidence-scope";

export interface ReadingSentence { start: number; end: number; text: string; complete: boolean; }
export interface ExplicitSentencePair { blockId: string; en: string; "zh-CN": string; }
const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const compact = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** Optional reading aid; never used as an annotation evidence receipt. */
export function readSentenceAlignment(value: unknown, enDigest: string, zhDigest: string): ExplicitSentencePair[] {
	const input = record(value), digests = record(input?.digests);
	if (input?.schemaVersion !== 1 || digests?.en !== enDigest || digests?.["zh-CN"] !== zhDigest
		|| !Array.isArray(input.pairs) || input.pairs.length > 2000) return [];
	const pairs: ExplicitSentencePair[] = [];
	for (const value of input.pairs) {
		const pair = record(value);
		if (typeof pair?.blockId !== "string" || !/^p-\d{1,5}$/.test(pair.blockId)
			|| typeof pair.en !== "string" || typeof pair["zh-CN"] !== "string") return [];
		const en = compact(pair.en), zh = compact(pair["zh-CN"]);
		if (!en || !zh || en.length > 3000 || zh.length > 3000) return [];
		pairs.push({ blockId: pair.blockId, en, "zh-CN": zh });
	}
	return pairs;
}

/** Return offsets in the displayed paragraph, including its real inline punctuation. */
export function readingSentences(text: string): ReadingSentence[] {
	let cursor = 0;
	return evidenceSentences(text).map(sentence => {
		const start = text.indexOf(sentence, cursor), end = start + sentence.length;
		cursor = end;
		return { start, end, text: compact(sentence),
			complete: /[.!?。！？]["'”’\])）】」』》]*$/u.test(sentence) && /[\p{L}\p{N}]/u.test(sentence) };
	});
}

export function matchReadingSentences(en: ReadingSentence[], zh: ReadingSentence[], explicit: readonly ExplicitSentencePair[] = []): Array<[ReadingSentence, ReadingSentence]> {
	if (!explicit.length) return en.length === 1 && zh.length === 1 && en[0].complete && zh[0].complete ? [[en[0], zh[0]]] : [];
	// A repeated quote or an explicit one-to-many relationship is ambiguous in both directions.
	const unique = (sentences: ReadingSentence[], text: string): ReadingSentence | undefined => {
		const matches = sentences.filter(sentence => sentence.text === text);
		return matches.length === 1 && matches[0].complete ? matches[0] : undefined;
	};
	const frequency = (language: "en" | "zh-CN"): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const pair of explicit) counts.set(pair[language], (counts.get(pair[language]) ?? 0) + 1);
		return counts;
	};
	const enCounts = frequency("en"), zhCounts = frequency("zh-CN"), matches: Array<[ReadingSentence, ReadingSentence]> = [];
	for (const pair of explicit) {
		if (enCounts.get(pair.en) !== 1 || zhCounts.get(pair["zh-CN"]) !== 1) continue;
		const left = unique(en, pair.en), right = unique(zh, pair["zh-CN"]);
		if (left && right) matches.push([left, right]);
	}
	return matches;
}
