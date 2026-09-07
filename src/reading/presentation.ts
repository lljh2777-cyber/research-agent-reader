/** Only known evidence identifiers become citations; unmatched markers stay visible. */
export function readingCitations(text: string, evidenceIds: string[], markdown = text): Array<{ start: number; end: number; raw: string; ids: string[] }> {
	const known = new Set(evidenceIds); const matches = [];
	for (const match of text.matchAll(/\[(?:证据\s*ID\s*[:：]\s*)?([^\[\]\n]+)\]/gi)) {
		const ids = match[1].split(/[,，、]\s*/).map((id) => id.trim());
		if (ids.length && ids.every((id) => known.has(id))) matches.push({ start: match.index!, end: match.index! + match[0].length, raw: match[0], ids });
	}
	// The passive Markdown renderer converts inline-code backticks to apostrophes.
	// Remove those display wrappers only when the original really used code fences.
	for (const wrapper of text.matchAll(/'([^'\n]+)'/g)) {
		if (!markdown.includes("`" + wrapper[1] + "`")) continue;
		const start = wrapper.index!; const end = start + wrapper[0].length;
		const contained = matches.filter((item) => item.start > start && item.end < end);
		if (!contained.length) continue;
		let remainder = ""; let offset = start + 1;
		for (const item of contained) { remainder += text.slice(offset, item.start); offset = item.end; }
		remainder += text.slice(offset, end - 1);
		if (!/^[,，\s]*$/.test(remainder)) continue;
		const index = matches.indexOf(contained[0]); matches.splice(index, contained.length, { start, end, raw: "`" + wrapper[1] + "`", ids: contained.flatMap((item) => item.ids) });
	}
	return matches;
}

/** Reverse display-only citation labels before mapping selections to stored Markdown. */
export function readingSelectionText(range: Range): string {
	const fragment = range.cloneContents();
	fragment.querySelectorAll<HTMLElement>("[data-reading-citation]").forEach((node) => node.replaceWith(node.dataset.readingCitation || ""));
	return fragment.textContent || "";
}
