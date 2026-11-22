import type { ReadingSession } from "../reading/types";

import { conclusionTitle, MAIN_GUIDE, type GuideTarget } from "../reading/inline-guide";

export interface MapPassage {
	id: string;
	quote: string;
	chapter: string;
	order: number;
}

interface MapNode {
	id: string;
	label: string;
	caption: string;
	kind: "passage" | "turn" | "guide";
	links?: GuideTarget[];
	answer?: string;
	parent?: MapNode;
	children: MapNode[];
	turns: number;
	forks: number;
}

function excerpt(text: string, limit: number): string {
	const plain = text.replace(/\s+/g, " ").trim();
	return plain.length > limit ? plain.slice(0, limit - 1) + "…" : plain;
}

/** Parent IDs are saved when a question is asked, independently of display order. */
export function paperMapTree(session: ReadingSession, passages: MapPassage[], evidence = new Map<string, GuideTarget[]>()) {
	const roots: MapNode[] = [];
	const nodes = new Map<string, MapNode>();
	for (const p of [...passages].sort((a, b) => a.order - b.order)) {
		const root: MapNode = { id: p.id, label: p.quote, caption: p.chapter, kind: "passage", children: [], turns: 0, forks: 0 };
		roots.push(root);
		nodes.set(root.id, root);
	}
	const saved = new Map(session.nodes.map(n => [n.id, n]));
	const parents = new Map<string, string>();
	if (session.mainIds?.length) {
		const main: MapNode = {id: MAIN_GUIDE, kind:"guide", label:"全文带读", caption:"主线", turns:0, forks:0, children:[]};
		roots.unshift(main);
		nodes.set(main.id, main);
		for (const [i,id] of session.mainIds.entries()) {
			const n = saved.get(id);
			if (!n) continue;
			nodes.set(id, {id, kind:"turn", caption:"结论 · 第 " + (i+1) + " 轮", label:conclusionTitle(n),
				children:[], turns:1, forks:0, links:evidence.get(id)});
			parents.set(id, MAIN_GUIDE);
		}
	}
	for (const branch of session.branches) {
		branch.nodeIds.forEach((id, i) => {
			const n = saved.get(id);
			if (!n) return;
			const fork = !i && !branch.annotation;
			const parent = i ? n.parentId : branch.annotation?.id || branch.parentNodeId;
			if (!parent) return;
			const caption = (fork ? "子分支 · " : i ? "追问 · " : "") + "第 " + (i + 1) + " 轮";
			nodes.set(id, { id, label: n.question || n.title, caption, kind: "turn", answer: excerpt(n.content.split(/\n\s*\n/)[0].replace(/\[b-[\w-]+\]|\*\*/g, ""), 110),
				children: [], turns: 1, forks: 0 });
			parents.set(id, parent);
		});
	}
	for (const [id, parentId] of parents) {
		const parent = nodes.get(parentId);
		if (!parent) continue;
		const node = nodes.get(id)!;
		parent.children.push(node);
		node.parent = parent;
	}
	// Only count descendants actually reachable from verified passages.
	const reachable = [...roots];
	for (let i = 0; i < reachable.length; i++) {
		const node = reachable[i];
		const branch = saved.get(node.id)?.branchId;
		if (branch) node.children.sort((a, b) => Number(saved.get(b.id)?.branchId === branch) - Number(saved.get(a.id)?.branchId === branch));
		for (const child of node.children) reachable.push(child);
	}
	for (let i = reachable.length - 1; i >= 0; i--) {
		const n = reachable[i];
		if (n.parent) {
			n.parent.turns += n.turns;
			const branchStart = n.parent.kind === "turn" && saved.get(n.id)?.branchId !== saved.get(n.parent.id)?.branchId;
			n.parent.forks += n.forks + (branchStart ? 1 : 0);
		}
	}
	return { roots, nodes: new Map(reachable.map(n => [n.id, n])) };
}

export class PaperDiscussionMap {
	private readonly toggle: HTMLButtonElement;
	private readonly stage: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly list: HTMLElement;
	private tree: ReturnType<typeof paperMapTree> = { roots: [], nodes: new Map() };
	private selected = "";
	private expanded = new Set<string>();

	constructor(toolbar: HTMLElement, private workspace: HTMLElement,
		private jump: (id: string, kind: MapNode["kind"], link?: GuideTarget) => void) {
		this.toggle = toolbar.createEl("button", { text: "本文思路", attr: { type: "button", "aria-expanded": "false" } });
		this.stage = document.createElement("div");
		this.stage.className = "rar-map-stage";
		workspace.before(this.stage);
		this.stage.append(workspace);
		this.panel = this.stage.createEl("nav", { cls: "rar-paper-map", attr: { "aria-label": "本文思路" } });
		this.panel.hidden = true;
		const bar = this.panel.createDiv({cls:"rar-map-bar"});
		bar.createEl("strong", {text:"本文思路"});
		const close = bar.createEl("button", {text:"收起", attr:{type:"button"}});
		close.onclick = () => { this.setOpen(false); this.toggle.focus(); };
		this.list = this.panel.createEl("ul", {cls:"rar-map-tree"});
		this.toggle.onclick = () => this.setOpen(Boolean(this.panel.hidden));
		this.panel.onkeydown = e => { if (e.key === "Escape") close.click(); };
	}

	private setOpen(open: boolean) {
		this.panel.hidden = !open;
		this.toggle.setAttribute("aria-expanded", String(open));
		if (open) {
			this.expanded.clear();
			this.expandPath();
			this.draw();
		}
	}

	private expandPath() {
		for (let n = this.tree.nodes.get(this.selected); n; n = n.parent) this.expanded.add(n.id);
	}

	update(session: ReadingSession | undefined, passages: MapPassage[], selected: string, evidence: Map<string, GuideTarget[]>) {
		this.tree = session ? paperMapTree(session, passages, evidence) : { roots: [], nodes: new Map() };
		if (selected !== this.selected) {
			this.selected = selected;
			this.expandPath();
		}
		if (!this.panel.hidden) this.draw();
	}

	private draw() {
		this.list.empty();
		if (!this.tree.nodes.has(MAIN_GUIDE)) {
			const start = this.list.createEl("li").createEl("button", {text:"开始全文带读", attr:{type:"button"}});
			start.onclick = () => { if (this.stage.clientWidth < 1040) this.setOpen(false); this.jump(MAIN_GUIDE, "guide"); };
		}
		const path = new Set<string>();
		for (let n = this.tree.nodes.get(this.selected); n; n = n.parent) path.add(n.id);
		const row = (list: HTMLElement, node: MapNode) => {
			const item = list.createEl("li", {cls:"rar-map-node"});
			item.dataset.mapId = node.id;
			const line = item.createDiv({cls:"rar-map-line"});
			if (path.has(node.id)) line.classList.add("is-path");
			const open = this.expanded.has(node.id);
			if (node.children.length || node.links?.length) {
				const arrow = line.createEl("button", {cls:"rar-map-arrow", text:open ? "▾" : "▸", attr:{type:"button",
					"aria-label": (open ? "折叠 " : "展开 ") + node.label, "aria-expanded":String(open)}});
				arrow.onclick = () => {
					if (open) this.expanded.delete(node.id); else this.expanded.add(node.id);
					this.draw();
					this.list.querySelector<HTMLElement>('[data-map-id="' + CSS.escape(node.id) + '"] > .rar-map-line > .rar-map-arrow')?.focus({preventScroll:true});
				};
			}
			const target = line.createEl("button", {cls:"rar-map-target", attr:{type:"button",title:node.label}});
			target.dataset.kind = node.kind;
			if (node.id === this.selected) target.setAttribute("aria-current","location");
			const caption = target.createSpan({cls:"rar-map-caption",text:node.caption});
			if (node.kind === "passage" || (!open && node.children.length)) caption.append(" · " + node.turns + " 轮" + (node.forks ? " · " + node.forks + " 个子分支" : ""));
			target.createSpan({cls:"rar-map-label",text:excerpt(node.label, node.kind === "passage" ? 72 : 80)});
			if (node.id === this.selected && node.answer) target.createSpan({cls:"rar-map-answer",text:node.answer});
			target.onclick = () => {
				if (this.stage.clientWidth < 1040) this.setOpen(false);
				this.jump(node.id, node.kind);
			};
			if (open && (node.children.length || node.links?.length)) {
				const children = item.createEl("ul");
				for (const link of node.links || []) {
					const kind = link.kind === "text" ? "原文" : link.kind === "figure" ? "图" : "表";
					const b = children.createEl("li").createEl("button",{cls:"rar-guide-link",text:kind+" · "+excerpt(link.label,64),attr:{type:"button",title:link.label}});
					b.onclick = () => { if (this.stage.clientWidth < 1040) this.setOpen(false); this.jump(node.id, "turn", link); };
				}
				for (const child of node.children) row(children, child);
			}
		};
		for (const n of this.tree.roots) row(this.list, n);
	}

	dispose() {
		this.toggle.remove();
		this.stage.replaceWith(this.workspace);
	}
}
