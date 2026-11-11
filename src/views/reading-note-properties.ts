import { parseYaml } from "obsidian";
import type { BilingualLanguage } from "../reader/bilingual-document";
import { notePropertyUrl, readNoteProperties, type NotePropertiesState, type ReadingNoteProperties } from "../reader/note-properties";

type NoteSource = { path: string; text: string };
type Options = {
	signal: AbortSignal; state?: NotePropertiesState; beforeChange?(): void; onChange(state: NotePropertiesState | undefined): void;
} & ({ source: NoteSource } | { sources: Record<BilingualLanguage, NoteSource>; defaultLanguage: BilingualLanguage });

let panelId = 0;

export function renderReadingNoteProperties(parent: HTMLElement, options: Options): void {
	const bilingual = "sources" in options;
	const panel = parent.createEl("section", { cls: "agent-reading-note-properties", attr: { "aria-label": "笔记属性" } });
	const bar = panel.createDiv({ cls: "agent-reading-note-bar" });
	const title = bar.createEl("h2", { cls: "agent-reading-note-title", attr: { "aria-live": "polite" } });
	const controls = bar.createDiv({ cls: "agent-reading-note-controls" });
	const id = "agent-reading-note-fields-" + ++panelId;
	const languages = new Map<BilingualLanguage, HTMLButtonElement>();
	let expanded = options.state?.expanded === true, language = bilingual ? options.state?.language ?? options.defaultLanguage : undefined;
	const cache = new Map<BilingualLanguage | undefined, ReadingNoteProperties>();
	const toggle = controls.createEl("button", { attr: { type: "button", "aria-controls": id, "data-reading-note-toggle": "" } });
	const details = panel.createDiv({ cls: "agent-reading-note-details", attr: { id, role: "region", "aria-label": "笔记属性列表", tabindex: "0" } });

	const show = (): void => {
		const source = "sources" in options ? options.sources[language ?? options.defaultLanguage] : options.source;
		let note = cache.get(language);
		if (!note) { note = readNoteProperties(source.path, source.text, parseYaml, language); cache.set(language, note); }
		title.setText(note.title); title.title = note.title;
		panel.title = source.path;
		toggle.setText(expanded ? "隐藏属性" : "显示属性");
		toggle.setAttribute("aria-expanded", String(expanded));
		for (const [key, button] of languages) button.setAttribute("aria-pressed", String(key === language));
		details.hidden = !expanded;
		details.empty();
		if (!expanded) return;
		if (!note.fields.length) { details.createDiv({ text: "这份笔记没有可显示的属性。", cls: "agent-reading-note-empty" }); return; }
		const list = details.createEl("dl", { cls: "agent-reading-note-list" });
		for (const field of note.fields) {
			const row = list.createDiv({ cls: "agent-reading-note-field" });
			row.createEl("dt", { text: field.key });
			const value = row.createEl("dd");
			if (field.list) value.classList.add("agent-reading-note-values");
			if (!field.values.length) value.setText("—");
			for (const item of field.values) {
				const url = notePropertyUrl(item);
				const label = /^\[\[([^\[\]]+)\]\]$/.exec(item)?.[1].split("|").pop() || item;
				const cls = field.list ? "agent-reading-note-value" : undefined;
				if (url) value.createEl("a", { text: item, cls, attr: { href: url, target: "_blank", rel: "noopener noreferrer" } });
				else value.createSpan({ text: label, cls });
			}
		}
		details.scrollTop = 0;
	};
	const change = (update: () => void): void => {
		options.beforeChange?.();
		update();
		show();
		options.onChange(expanded || language ? { ...(expanded ? { expanded: true } : {}), ...(language ? { language } : {}) } : undefined);
	};
	if (bilingual) {
		const group = controls.createDiv({ cls: "agent-reading-note-language", attr: { role: "group", "aria-label": "笔记属性语言" } });
		for (const key of ["zh-CN", "en"] as const) {
			const button = group.createEl("button", { text: key === "zh-CN" ? "中文" : "English", attr: { type: "button", "data-reading-note-language": key } });
			languages.set(key, button);
			button.addEventListener("click", () => { if (language !== key) change(() => { language = key; }); }, { signal: options.signal });
		}
	}
	toggle.addEventListener("click", () => change(() => { expanded = !expanded; }), { signal: options.signal });
	show();
}
