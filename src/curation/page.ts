import { parseYaml } from "obsidian";
import { objectDigest } from "../papers/identity";
import { literalLearningBlock } from "../learning/curated-block";
import { readingPathCode } from "../reading/export";
import { sanitizeQueryNoteFilename } from "../services/query-note";
import { DRAFT_ID, DRAFT_KINDS, draftDate, draftObject, draftMaterialText, type KnowledgeDraft } from "./draft";
import { draftRevision, type DraftRevision, type KnowledgeDraftStore, type DraftSummary } from "./draft-store";
import type { SourceStorage } from "../sources/storage";

export const PAGE_FOLDERS = { concept: "wiki/concepts", method: "wiki/methods", synthesis: "wiki/synthesis" } as const;
const INDEX = { concept: "研究主题索引.md", method: "研究方法索引.md", synthesis: "研究主题索引.md" } as const;
const ROOT = "knowledge-pages", LIMIT = 1024 * 1024;
export interface PageWrite { role: "page" | "index" | "log"; path: string; before: string | null; after: string; }
export interface PagePlan { version: 1; draft: DraftRevision; path: string; created: string; directories: string[]; writes: PageWrite[]; }
export interface PageRecord { plan: PagePlan; complete: boolean; }
export interface PageFiles {
	read(path: string): Promise<string | null>;
	list(): Promise<string[]>;
	directory(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(write: PageWrite, signal?: AbortSignal): Promise<void>;
}
const sameTitle = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const link = (path: string): string => "[[" + path.slice(0, -3) + "]]";
export function pagePath(draft: KnowledgeDraft, filename = sanitizeQueryNoteFilename(draft.title)): string {
	const stem = filename.replace(/\.md$/i, "");
	if (!stem || stem.length > 100 || stem !== stem.trim() || /[\\/\[\]|#%<>:"?*\x00-\x1f\x7f]/.test(stem) || /^[.]/.test(stem) || /[. ]$/.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) throw new Error("请填写有效文件名（不含目录或特殊路径字符，最多 100 字符）");
	return PAGE_FOLDERS[draft.kind] + "/" + stem + ".md";
}
export function knowledgePageText(r: DraftRevision): string {
	const d = r.draft;
	const fields = { title: d.title, type: d.kind, status: "unreviewed", evidence_basis: "unverified", knowledge_source: "user-draft", draft_id: d.id, draft_revision: r.digest };
	// Reuse the existing literal learning boundary: no raw user HTML, link execution, or evidence promotion.
	return ["---", ...Object.entries(fields).map(([key, value]) => key + ": " + JSON.stringify(value)), "---", "",
		"# " + d.title.replace(/([\\`*_{}\[\]()#+.!|~<>-])/g, "\\$1"), "", "本页由已保存草稿创建，正文与附带材料均待审阅。创建页面不代表科学或教学核验通过。", "",
		literalLearningBlock("用户草稿正文（个人理解，未核验）：\n\n" + d.body), "", literalLearningBlock("附带材料（草稿保存时的历史快照）：\n\n" + draftMaterialText(d.material, true)), ""].join("\n");
}
function sideWrites(draft: DraftRevision, path: string, created: string, index: string | null, log: string | null): PageWrite[] {
	const entry = link(path), stamp = `草稿 ${draft.draft.id} / ${draft.digest}`;
	return [
		{ role: "index", path: INDEX[draft.draft.kind], before: index, after: (index ?? (draft.draft.kind === "method" ? "# 研究方法索引\n" : "# 研究主题索引\n")).trimEnd() + "\n\n- " + entry + " · 待审阅\n" },
		{ role: "log", path: "wiki/log.md", before: log, after: (log ?? "# 知识库维护日志\n").trimEnd() + "\n\n- " + created + " 从草稿创建 " + entry + "（" + DRAFT_KINDS[draft.draft.kind] + "）；" + readingPathCode(stamp) + "。正文与历史材料待审阅，未作论文证据核验。\n" }
	];
}
export function validatePagePlan(raw: unknown): PagePlan {
	const v = draftObject(raw, ["version", "draft", "path", "created", "directories", "writes"]), p = v as unknown as PagePlan;
	if (p.version !== 1 || !p.draft || p.draft.version !== 1 || p.draft.digest !== draftRevision(p.draft.draft, p.draft.parent).digest || !draftDate(p.created) || typeof p.path !== "string" || p.path !== pagePath(p.draft.draft, p.path.split("/").pop()) || !Array.isArray(p.directories) || !Array.isArray(p.writes) || p.writes.length !== 3) throw new Error("建页预览记录无效");
	draftObject(p.draft, ["version", "parent", "draft", "digest"]);
	const dirs = ["wiki", PAGE_FOLDERS[p.draft.draft.kind]];
	if (p.directories.some((d, i) => !dirs.includes(d) || p.directories.indexOf(d) !== i) || p.directories.join() !== dirs.filter(d => p.directories.includes(d)).join()) throw new Error("建页目录越界");
	for (const w of p.writes) { draftObject(w, ["role", "path", "before", "after"]); if (typeof w.after !== "string" || Buffer.byteLength(w.after) > LIMIT || w.before !== null && (typeof w.before !== "string" || Buffer.byteLength(w.before) > LIMIT)) throw new Error("建页文件超过 1 MiB 或字段无效"); }
	const expected: PageWrite[] = [{ role: "page", path: p.path, before: null, after: knowledgePageText(p.draft) }, ...sideWrites(p.draft, p.path, p.created, p.writes[1].before, p.writes[2].before)];
	if (JSON.stringify(expected) !== JSON.stringify(p.writes)) throw new Error("建页内容与草稿、索引或日志不一致");
	if (Buffer.byteLength(JSON.stringify(p)) > 8 * LIMIT) throw new Error("建页记录超过 8 MiB 上限");
	return structuredClone(p);
}

/** One immutable creation intent per draft. No replacement/deletion of a page, draft, or journal. */
export class KnowledgePages {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(readonly drafts: KnowledgeDraftStore, private io: SourceStorage, private files: PageFiles) {}
	async record(id: string, signal?: AbortSignal): Promise<PageRecord | null> {
		if (!DRAFT_ID.test(id)) throw new Error("草稿标识无效"); signal?.throwIfAborted();
		const bytes = await this.io.read(`${ROOT}/${id}.json`, 8 * LIMIT), marker = await this.io.read(`${ROOT}/${id}.complete`, 64); signal?.throwIfAborted();
		if (!bytes) { if (marker) throw new Error("建页记录缺失，完成标记保留，请复查"); return null; }
		const plan = validatePagePlan(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		if (plan.draft.draft.id !== id || marker && new TextDecoder().decode(marker) !== objectDigest(plan)) throw new Error("建页记录身份或完成标记不一致");
		return { plan, complete: !!marker };
	}
	private async verifyDraft(r: DraftRevision, current: boolean, signal?: AbortSignal): Promise<void> {
		const h = await this.drafts.read(r.draft.id, signal);
		if (h.issues.length || h.pending.length || !h.revisions.some(v => v.digest === r.digest && objectDigest(v) === objectDigest(r)) || current && h.current?.digest !== r.digest) throw new Error("草稿版本已变化或有未完成保存，请重读草稿再预览");
	}
	private async duplicates(d: KnowledgeDraft, path: string, own = false, signal?: AbortSignal): Promise<void> {
		const paths = await this.files.list(); if (paths.length > 5000) throw new Error("知识页超过 5,000 个，无法完成查重"); let budget = 16 * LIMIT;
		const targetName = sameTitle(path), targetStem = sameTitle(path.split("/").pop()!.slice(0, -3)), title = sameTitle(d.title);
		for (const candidate of paths) {
			signal?.throwIfAborted(); if (own && candidate === path) continue;
			if (sameTitle(candidate) === targetName) throw new Error("目标路径已有文件：" + candidate);
			if (!Object.values(PAGE_FOLDERS).some(f => candidate.startsWith(f + "/")) || !candidate.toLowerCase().endsWith(".md")) continue;
			const text = await this.files.read(candidate); if (text === null) throw new Error("查重期间笔记变化，请重试"); budget -= Buffer.byteLength(text); if (budget < 0) throw new Error("查重超过 16 MiB 读取预算");
			const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); const meta = front ? parseYaml(front[1]) : {};
			const titles = [candidate.split("/").pop()!.slice(0, -3), typeof meta?.title === "string" ? meta.title : "", ...(/^#\s+(.+)$/m.exec(text.slice(front?.[0].length || 0))?.slice(1) || [])];
			if (titles.some(t => t && [title, targetStem].includes(sameTitle(t))) || meta?.draft_id === d.id) throw new Error("已有同名或同一草稿的知识页，请先查看：" + candidate);
		}
	}
	async preview(id: string, revision: string, filename: string, signal?: AbortSignal): Promise<PagePlan> {
		if (await this.record(id, signal)) throw new Error("已有建页记录，请查看或恢复原记录");
		const h = await this.drafts.read(id, signal), r = h.current; if (!r || r.digest !== revision) throw new Error("草稿版本已变化，请重新读取"); await this.verifyDraft(r, true, signal);
		const path = pagePath(r.draft, filename); await this.duplicates(r.draft, path, false, signal);
		if (await this.files.read(path) !== null) throw new Error("目标文件已存在，不能覆盖");
		const directories: string[] = []; for (const dir of ["wiki", PAGE_FOLDERS[r.draft.kind]]) if (!await this.files.directory(dir)) directories.push(dir);
		const writes: PageWrite[] = [{ role: "page", path, before: null, after: knowledgePageText(r) }], created = new Date().toISOString();
		writes.push(...sideWrites(r, path, created, await this.files.read(INDEX[r.draft.kind]), await this.files.read("wiki/log.md"))); signal?.throwIfAborted();
		return validatePagePlan({ version: 1, draft: r, path, created, directories, writes });
	}
	private async preflight(p: PagePlan, recovery: boolean, signal?: AbortSignal, checkDuplicates = false): Promise<void> {
		await this.verifyDraft(p.draft, !recovery, signal); if (checkDuplicates) await this.duplicates(p.draft.draft, p.path, recovery, signal);
		for (const dir of ["wiki", PAGE_FOLDERS[p.draft.draft.kind]]) if (!await this.files.directory(dir) && !p.directories.includes(dir)) throw new Error("预览后的目录已缺失：" + dir);
		for (const w of p.writes) { signal?.throwIfAborted(); const text = await this.files.read(w.path); if (text !== w.before && !(recovery && text === w.after)) throw new Error("预览后文件已变化，停止写入：" + w.path); }
	}
	private async exactCreate(path: string, bytes: Uint8Array): Promise<void> {
		try { await this.io.create(path, bytes); } catch (error) { const saved = await this.io.read(path, bytes.length); if (!saved || !Buffer.from(saved).equals(Buffer.from(bytes))) throw error; }
	}
	apply(raw: PagePlan, signal?: AbortSignal): Promise<PageRecord> {
		const p = validatePagePlan(raw); const work = this.queue.then(async () => {
			const prior = await this.record(p.draft.draft.id, signal);
			if (prior) { if (objectDigest(prior.plan) !== objectDigest(p)) throw new Error("已保存另一份建页预览，请重读记录"); if (prior.complete) return prior; }
			await this.preflight(p, !!prior, signal, true); signal?.throwIfAborted();
			if (!prior) { await this.io.mkdir(ROOT); signal?.throwIfAborted(); await this.exactCreate(`${ROOT}/${p.draft.draft.id}.json`, Buffer.from(JSON.stringify(p))); }
			await this.preflight(p, true, signal);
			for (const dir of p.directories) { signal?.throwIfAborted(); await this.files.mkdir(dir); }
			for (const w of p.writes) {
				// Check all approved files between writes, protecting later edits during partial recovery.
				await this.preflight(p, true, signal, w.role === "page"); signal?.throwIfAborted(); await this.files.write(w, signal);
			}
			for (const w of p.writes) if (await this.files.read(w.path) !== w.after) throw new Error("保存后文件已变化，原文件保留：" + w.path);
			signal?.throwIfAborted(); await this.exactCreate(`${ROOT}/${p.draft.draft.id}.complete`, Buffer.from(objectDigest(p)));
			return { plan: p, complete: true };
		}); this.queue = work.catch(() => undefined); return work;
	}
	async summaries(signal?: AbortSignal): Promise<{ entries: DraftSummary[]; issues: string[] }> {
		const result = await this.drafts.summaries(signal);
		for (const entry of result.entries) { try { const r = await this.record(entry.id, signal); if (r) { entry.page = { path: r.plan.path, complete: r.complete }; entry.revision = objectDigest({ history: entry.revision, page: r }); if (r.complete && await this.files.read(r.plan.path) === null) entry.issues.push("已创建页面缺失，请按原路径核对；不会自动重建。"); } } catch (error) { signal?.throwIfAborted(); entry.issues.push("建页记录读取失败：" + String(error)); } }
		return result;
	}
}
