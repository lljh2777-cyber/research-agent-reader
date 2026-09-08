import { parseYaml } from "obsidian";
import { contentHash } from "../retrieval/chunks";

export interface RegistrationWrite { path: string; before: string | null; after: string; }
export interface RegistrationPlan { version: 1; id: string; notePath: string; created: string; full: boolean; scope: string; writes: RegistrationWrite[]; state: "prepared" | "applied" | "recovery"; }
export interface RegistrationIO {
	read(path: string): Promise<string | null>;
	write(path: string, before: string | null, after: string): Promise<void>;
	save(plan: RegistrationPlan): Promise<void>;
}
const CSV = "tool-library/metadata/papers.csv", BIB = "tool-library/references.bib";
const header = "citekey,title,authors,year,venue,doi,arxiv,zotero_key,bibtex_key,source_path,converted_path,status,updated";
const scalar = (v: unknown): string => String(v || "").replace(/[\r\n]+/g, " ").trim();
const csv = (v: string): string => '"' + v.replace(/"/g, '""') + '"';
const bib = (v: string): string => v.replace(/[\\{}%&#_$]/g, c => "\\" + c);
const normalizeDoi = (value: unknown): string => scalar(value).replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").toLowerCase();

export function ingestRegistrationAvailability(notePath: string, note: string | null): { eligible: boolean; reason: string } {
	if (!/^wiki\/sources\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/.test(notePath) || !note) return { eligible: false, reason: "文章 Wiki 不存在或路径无效" };
	try {
		const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note), m = fm && parseYaml(fm[1]);
		if (!m || m.ingest_mode !== "lightweight") return { eligible: false, reason: "本次复用了既有笔记，无需按轻量入库再次登记" };
		if (!scalar(m.title) || scalar(m.citekey) !== notePath.split("/").pop()!.slice(0, -3) || !["pending", "indexed", "registered"].includes(scalar(m.registry_status))) return { eligible: false, reason: "轻量入库元数据不完整，请先核对" };
		return { eligible: true, reason: "预览索引与书目修改，不调用模型" };
	} catch { return { eligible: false, reason: "文章元数据无法解析，请先核对" }; }
}

export function parseRegistryCsv(text: string): string[][] {
	const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else if (quoted || !cell) quoted = !quoted; else throw new Error("书目 CSV 引号格式无效"); }
		else if (!quoted && (c === "," || c === "\n")) { row.push(cell.replace(/\r$/, "")); cell = ""; if (c === "\n") { if (row.some(Boolean)) rows.push(row); row = []; } }
		else cell += c;
	}
	if (quoted) throw new Error("书目 CSV 引号未闭合"); if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); } return rows;
}

export function planIngestRegistration(notePath: string, files: Record<string, string | null>, full: boolean, id: string, created: string, scope: string): RegistrationPlan {
	if (!/^wiki\/sources\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/.test(notePath)) throw new Error("请选择入库产生的文章 Wiki");
	const note = files[notePath]; const fm = note && /^---\r?\n([\s\S]*?)\r?\n---/.exec(note);
	if (!note || !fm) throw new Error("文章 Wiki 缺少元数据"); const m = parseYaml(fm[1]) as Record<string, unknown>;
	if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("文章元数据无效");
	const key = notePath.split("/").pop()!.slice(0, -3), title = scalar(m.title), doi = normalizeDoi(m.doi);
	if (!title || scalar(m.citekey) !== key || m.ingest_mode !== "lightweight" || !["pending", "indexed", "registered"].includes(scalar(m.registry_status))) throw new Error("仅支持元数据完整的轻量入库笔记");
	if (!/^\d{4}-\d\d-\d\dT/.test(created) || !/^[A-Za-z0-9._-]+$/.test(id) || !scope) throw new Error("登记记录无效");
	const writes: RegistrationWrite[] = []; const put = (path: string, after: string) => { const before = files[path] ?? null; if (before !== after) writes.push({ path, before, after }); };
	const targetStatus = full || m.registry_status === "registered" ? "registered" : "indexed";
	put(notePath, note.replace(fm[0], fm[0].replace(/^registry_status:.*$/m, 'registry_status: "' + targetStatus + '"')));
	const index = files["文献索引.md"] || "# 文献索引\n"; const stem = notePath.slice(0, -3);
	if (!["[[" + stem + "]]", "[[" + stem + "|", "[[" + key + "]]", "[[" + key + "|"] .some(t => index.includes(t))) put("文献索引.md", index.trimEnd() + "\n\n- [[" + stem + "]]\n");
	const source = scalar(m.source_path);
	if (/^papers\/[^/]+\/article\.md$/.test(source)) {
		const index = files["papers/index.md"] || "# 原文包索引\n";
		if (!index.includes("`" + source + "`")) put("papers/index.md", index.trimEnd() + "\n\n- `" + source + "`\n");
	}
	if (full) {
		const existing = files[CSV] || header + "\n"; const rows = parseRegistryCsv(existing); const columns = rows[0];
		if (!columns || !["citekey", "title", "doi", "status", "updated"].every(c => columns.includes(c)) || new Set(columns).size !== columns.length || rows.slice(1).some(r => r.length !== columns.length)) throw new Error("papers.csv 列结构不兼容，未改动登记文件");
		const at = (r: string[], c: string) => r[columns.indexOf(c)] || "";
		const matches = rows.slice(1).filter(r => at(r, "citekey") === key || doi && normalizeDoi(at(r, "doi")) === doi);
		if (matches.some(r => at(r, "citekey") !== key || normalizeDoi(at(r, "doi")) !== doi || at(r, "title") !== title) || matches.length > 1) throw new Error("CSV 中的 citekey、DOI 或标题存在冲突，请先核对");
		if (!matches.length) {
			const values: Record<string, string> = { citekey: key, bibtex_key: key, title, authors: scalar(m.authors), year: scalar(m.year), doi, source_path: m.source_kind === "pdf" ? source : "", converted_path: m.source_kind === "article" ? source : "", status: scalar(m.depth), updated: created.slice(0, 10) };
			put(CSV, existing.trimEnd() + "\n" + columns.map(c => csv(values[c] || "")).join(",") + "\n");
		}
		const references = files[BIB] || ""; const entries = [...references.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)];
		const entryDoi = (entry: string): string => { const found = /\bdoi\s*=\s*(?:\{([^{}]*)\}|"([^"]*)"|([^,\s}]+))/i.exec(entry); return normalizeDoi(found && (found[1] || found[2] || found[3])); };
		if (entries.filter(e => e[1] === key).length > 1 || doi && entries.some((e, index) => e[1] !== key && entryDoi(references.slice(e.index, entries[index + 1]?.index)) === doi)) throw new Error("BibTeX 中的 citekey 或 DOI 存在重复条目，请先核对");
		const match = entries.find(e => e[1] === key);
		if (match) {
			const next = entries.find(e => e.index! > match.index!); const entry = references.slice(match.index, next?.index);
			if (entryDoi(entry) !== doi || !entry.includes(bib(title))) throw new Error("BibTeX 中已有同名条目，请先核对标题与 DOI");
		} else put(BIB, references.trimEnd() + `\n\n@misc{${key},\n  title = {${bib(title)}},\n${/^\d{4}$/.test(scalar(m.year)) ? "  year = {" + scalar(m.year) + "},\n" : ""}${doi ? "  doi = {" + bib(doi) + "},\n" : ""}}\n`);
	}
	if (writes.length) put("wiki/log.md", (files["wiki/log.md"] || "# 知识库维护日志\n").trimEnd() + `\n\n- ${created} 登记 [[${stem}]]；${full ? "同步 CSV、BibTeX 与索引" : "同步当前库索引；外部书目登记仍待完成"}；记录 ${id}。\n`);
	return { version: 1, id, notePath, created, full, scope, writes, state: "prepared" };
}

/** Serial owner, preflight, snapshots and exact-content recovery. No model calls. */
export class IngestRegistrationWriter {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private io: RegistrationIO) {}
	apply(plan: RegistrationPlan): Promise<RegistrationPlan> {
		const task = this.queue.then(async () => {
			if (plan.version !== 1 || !Array.isArray(plan.writes)) throw new Error("登记记录格式无效");
			// Rebuild deterministic edits from the stored before-text, rejecting tampered after-text/paths.
			const before = Object.fromEntries(plan.writes.map(w => [w.path, w.before]));
			if (!before[plan.notePath]) before[plan.notePath] = await this.io.read(plan.notePath);
			for (const p of ["文献索引.md", "papers/index.md", "wiki/log.md", CSV, BIB]) if (!(p in before)) before[p] = await this.io.read(p);
			const rebuilt = planIngestRegistration(plan.notePath, before, plan.full, plan.id, plan.created, plan.scope);
			if (JSON.stringify(rebuilt.writes) !== JSON.stringify(plan.writes)) throw new Error("登记预览与保存记录不一致，请重新预览");
			for (const w of plan.writes) { const now = await this.io.read(w.path); if (now !== w.before && now !== w.after) throw new Error("文件已编辑，停止登记：" + w.path); }
			const result = structuredClone(plan); await this.io.save(result);
			try { for (const w of result.writes) { if (await this.io.read(w.path) !== w.after) await this.io.write(w.path, w.before, w.after); }
				result.state = "applied"; await this.io.save(result); return result;
			} catch (error) { result.state = "recovery"; await this.io.save(result); throw error; }
		}); this.queue = task.catch(() => undefined); return task;
	}
}

export const registrationFiles = (notePath: string): string[] => [notePath, "文献索引.md", "papers/index.md", "wiki/log.md", CSV, BIB];
export const registrationHash = (text: string): string => contentHash(text);
