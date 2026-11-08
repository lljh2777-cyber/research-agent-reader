import { evidenceSentences } from "../annotations/cli-evidence-scope";

export interface ReadingSentence { start: number; end: number; text: string; complete: boolean; hints?: SentenceHints; }
export interface SentenceMark { start: number; end: number; key?: string; }
interface SentenceHints { keys: Set<string>; quantities: Set<string>; references: Set<string>; figures: Set<string>; scripts: Set<string>; }
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
export function readingSentences(text: string, marks: readonly SentenceMark[] = []): ReadingSentence[] {
	let cursor = 0;
	return evidenceSentences(text).map(sentence => {
		const start = text.indexOf(sentence, cursor), end = start + sentence.length;
		// Reject likely fragments and an uppercase mass-spectrometry acronym
		// mistaken for the honorific "Ms." by the shared evidence splitter.
		const uncertainBoundary = cursor > 0 && /^["'“‘(]*[a-z]{2,}(?:\s|[,.])/u.test(sentence)
			|| /\bMS\.\s+[A-Za-z]/u.test(sentence);
		cursor = end;
		return { start, end, text: compact(sentence),
			complete: !uncertainBoundary && /[.!?。！？]["'”’\])）】」』》]*$/u.test(sentence) && /[\p{L}\p{N}]/u.test(sentence),
			hints: sentenceHints(text, start, end, marks) };
	});
}

// Use displayed text for ranges, but do not turn an inline reference or exponent into a prose number.
function sentenceHints(text: string, start: number, end: number, marks: readonly SentenceMark[]): SentenceHints {
	const hints: SentenceHints = { keys: new Set(), quantities: new Set(), references: new Set(), figures: new Set(), scripts: new Set() };
	let plain = "", cursor = start;
	for (const mark of marks) {
		if (mark.end <= start) continue;
		if (mark.start >= end) break;
		plain += text.slice(cursor, Math.max(cursor, mark.start)) + " ";
		cursor = Math.max(cursor, Math.min(end, mark.end));
		if (mark.start < start || mark.end > end || !mark.key) continue;
		if (mark.key.startsWith("script:")) { hints.scripts.add(mark.key); continue; }
		hints.keys.add(mark.key);
		if (mark.key.startsWith("ref:")) hints.references.add(mark.key);
		if (mark.key.startsWith("fig:")) hints.figures.add(mark.key);
	}
	plain += text.slice(cursor, end);
	for (const [word] of plain.matchAll(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)*(?![A-Za-z0-9])/g)) {
		if (word.length > 40 || !/^(?:[A-Z]{2,}|[A-Z][a-z]{3,}|[A-Za-z]+\d)|[A-Z].*[A-Z]/.test(word)
			|| /^(?:figs?|figure|table|refs?|eqs?|the|these|this|with|from|using|when|however)$/i.test(word)) continue;
		hints.keys.add("id:" + word.toLowerCase());
	}
	for (const m of plain.matchAll(/(?<![A-Za-z0-9.])([−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![A-Za-z0-9]|\.\d)(?:\s*(thousand\b|million\b|billion\b|万|亿|[%％]))?/gi)) {
		const unit = (m[2] ?? "").toLowerCase();
		const scale = unit === "thousand" ? 1e3 : unit === "万" ? 1e4 : unit === "million" ? 1e6 : unit === "亿" ? 1e8 : unit === "billion" ? 1e9 : 1;
		const value = Number(m[1].replace(/,/g, "").replace("−", "-")) * scale;
		if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) continue;
		const percent = unit === "%" || unit === "％";
		const key = "num:" + value + (percent ? "%" : "");
		hints.quantities.add(key);
		if (percent || Math.abs(value) >= 10 || !Number.isInteger(value)) hints.keys.add(key);
	}
	return hints;
}

type IndexPair = [number, number];
function uniqueOwners(sentences: ReadingSentence[]): Map<string, number> {
	const owners = new Map<string, number>();
	sentences.forEach((sentence, i) => {
		for (const key of sentence.hints?.keys ?? []) owners.set(key, owners.has(key) ? -1 : i);
	});
	return owners;
}
const conflict = (a: Set<string>, b: Set<string>): boolean =>
	a.size > 0 && b.size > 0 && (a.size !== b.size || [...a].some(key => !b.has(key)));

/** Locate local 1:1 anchors, then fill only a single unambiguous gap bracketed by anchors. */
function localSentencePairs(en: ReadingSentence[], zh: ReadingSentence[]): Array<[ReadingSentence, ReadingSentence]> {
	if (en.length < 2 || zh.length < 2 || en.length > 128 || zh.length > 128) return [];
	const enOwners = uniqueOwners(en), zhOwners = uniqueOwners(zh);
	const byEn = en.map(() => new Map<number, string[]>()), byZh = zh.map(() => new Set<number>());
	for (const [key, i] of enOwners) {
		const j = zhOwners.get(key);
		if (i < 0 || j === undefined || j < 0) continue;
		const list = byEn[i].get(j) ?? [];
		list.push(key); byEn[i].set(j, list); byZh[j].add(i);
	}
	const lengths = (sentences: ReadingSentence[]): number => sentences.reduce((total, sentence) => total + sentence.text.length, 0);
	const relative = lengths(en) / Math.max(1, lengths(zh));
	const compatible = (i: number, j: number, tolerance: number): boolean => {
		const a = en[i], b = zh[j], left = a.hints, right = b.hints;
		const ratio = a.text.length / Math.max(1, b.text.length) / relative;
		return a.complete && b.complete && !!left && !!right && ratio >= 1 / tolerance && ratio <= tolerance
			&& en.filter(s => s.text === a.text).length === 1 && zh.filter(s => s.text === b.text).length === 1
			&& !conflict(left.quantities, right.quantities) && !conflict(left.references, right.references)
			&& !conflict(left.figures, right.figures) && !conflict(left.scripts, right.scripts);
	};
	const anchors: IndexPair[] = [];
	for (const [i, candidates] of byEn.entries()) {
		if (candidates.size !== 1) continue;
		const [j, keys] = candidates.entries().next().value!;
		if (byZh[j].size !== 1 || !compatible(i, j, 1.8)) continue;
		const refs = keys.filter(key => key.startsWith("ref:") || key.startsWith("fig:")).length;
		const ids = keys.filter(key => key.startsWith("id:")).length;
		const numbers = keys.length - refs - ids;
		// A shared number, label, or identifier on its own may identify the topic rather than the sentence.
		if (refs >= 2 || refs >= 1 && ids + numbers >= 1 || ids >= 2 || ids >= 1 && numbers >= 2) anchors.push([i, j]);
	}
	// Leave crossing matches unpainted. The other monotone anchors can still be used.
	const monotone = anchors.filter(([, j], i) => !anchors.some(([, other], k) => k < i && other >= j || k > i && other <= j));
	// A distinctive name may identify only one half of a split translation.
	// In an uneven paragraph, require a comparable length and a neighboring 1:1 anchor.
	const comparable = en.length === zh.length ? monotone : monotone.filter(([i, j]) => compatible(i, j, 1.55));
	const ordered = en.length === zh.length ? comparable : comparable.filter(([i, j], k) =>
		[comparable[k - 1], comparable[k + 1]].some(other => other && Math.abs(other[0] - i) === 1 && other[0] - i === other[1] - j));
	const accepted: IndexPair[] = [];
	for (let k = 0; k < ordered.length; k++) {
		const [i, j] = ordered[k];
		accepted.push([i, j]);
		const next = ordered[k + 1];
		if (next?.[0] === i + 2 && next[1] === j + 2
			&& (!byEn[i + 1].size || byEn[i + 1].size === 1 && byEn[i + 1].has(j + 1))
			&& (!byZh[j + 1].size || byZh[j + 1].size === 1 && byZh[j + 1].has(i + 1))
			&& compatible(i + 1, j + 1, 1.55)) accepted.push([i + 1, j + 1]);
	}
	return accepted.map(([i, j]) => [en[i], zh[j]]);
}

export function matchReadingSentences(en: ReadingSentence[], zh: ReadingSentence[], explicit: readonly ExplicitSentencePair[] = []): Array<[ReadingSentence, ReadingSentence]> {
	if (!explicit.length) return en.length === 1 && zh.length === 1 && en[0].complete && zh[0].complete ? [[en[0], zh[0]]] : localSentencePairs(en, zh);
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
