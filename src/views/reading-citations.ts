import { readingCitations } from "../reading/presentation";

export function renderReadingCitations(content: HTMLElement, ids: string[], markdown: string,
	render: (group: HTMLElement, id: string) => boolean): void {
	const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); const texts: Text[] = []; let current: Node | null;
	while ((current = walker.nextNode())) if (!current.parentElement?.closest("a, button, pre, .math, .math-inline, .math-block")) texts.push(current as Text);
	for (const text of texts) {
		const matches = readingCitations(text.data, ids, markdown); if (!matches.length) continue;
		const fragment = document.createDocumentFragment(); let offset = 0;
		for (const match of matches) {
			fragment.append(text.data.slice(offset, match.start)); const group = document.createElement("span"); group.className = "reading-citation"; group.dataset.readingCitation = match.raw;
			for (const id of match.ids) {
				if (!render(group, id)) group.append("[" + id + "]");
			}
			fragment.append(group); offset = match.end;
		}
		fragment.append(text.data.slice(offset)); text.parentElement?.closest("code")?.classList.add("reading-citation-code"); text.replaceWith(fragment);
	}
}
