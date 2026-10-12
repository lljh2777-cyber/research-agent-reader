/** Keep source identities and widths attached to the same panes when changing display order. */
export function sourceSplitRatio(displayRatio: number, reversed: boolean): number { return reversed ? 1 - displayRatio : displayRatio; }

export function applySplitLayout(workspace: HTMLElement, sourceRatio: number, reversed: boolean): void {
	const children = Array.from(workspace.children) as HTMLElement[];
	const left = children.find(el => el.dataset.splitSide === "left"), right = children.find(el => el.dataset.splitSide === "right"), splitter = children.find(el => el.getAttribute("role") === "separator");
	// Read positions before changing grid widths: reading scrollTop after the CSS change can clamp it in a transient column.
	const scrollers = [left, right].map(el => el?.querySelector<HTMLElement>(".agent-bilingual-scroll"));
	const positions = scrollers.map(el => el?.scrollTop ?? 0);
	const displayRatio = sourceSplitRatio(sourceRatio, reversed);
	workspace.style.setProperty("--bilingual-left", displayRatio + "fr");
	workspace.style.setProperty("--bilingual-right", (1 - displayRatio) + "fr");
	splitter?.setAttribute("aria-valuenow", String(Math.round(displayRatio * 100)));
	if (!left || !right || !splitter) return;
	const first = reversed ? right : left, last = reversed ? left : right;
	if (children[0] === first && children[1] === splitter && children[2] === last) return;
	workspace.append(first, splitter, last);
	for (const [i, scroller] of scrollers.entries()) if (scroller) scroller.scrollTop = positions[i];
}
