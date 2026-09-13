import { randomUUID } from "node:crypto";
import { TFile, type App } from "obsidian";
import { objectDigest } from "../papers/identity";
import { contentHash } from "../retrieval/chunks";
import { readExcerptSnapshot, ExcerptLibraryService, type ExcerptRef } from "../annotations/excerpt-library";
import { readAnswerExcerpt, type AnswerExcerptService } from "../learning/answer-excerpts";
import { ANSWER_CONTENT_ROLES, answerRoleText, type AnswerContentRole } from "./answer-excerpt";
import { readingPathCode } from "../reading/export";

export const DRAFT_KINDS = { concept: "概念", method: "方法", synthesis: "综合" } as const;
export const DRAFT_ID = /^d-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const DRAFT_HASH = /^[a-f0-9]{64}$/;
export type DraftMaterial = { kind: "excerpt"; path: string; raw: string; digest: string; excerptId: string; includeNote: boolean }
	| { kind: "answer"; path: string; raw: string; digest: string; roles: AnswerContentRole[] };
export interface KnowledgeDraft { version: 1; id: string; kind: keyof typeof DRAFT_KINDS; title: string; body: string; material: DraftMaterial | null; created: string; updated: string; }
export const draftDate = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function draftObject(raw: unknown, keys: string[]): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== [...keys].sort().join()) throw new Error("草稿记录字段无效");
	return raw as Record<string, unknown>;
}
export function validateDraftMaterial(raw: unknown): DraftMaterial | null {
	if (raw === null) return null;
	const kind = (raw as DraftMaterial)?.kind;
	const v = draftObject(raw, kind === "excerpt" ? ["kind", "path", "raw", "digest", "excerptId", "includeNote"] : ["kind", "path", "raw", "digest", "roles"]);
	if (typeof v.path !== "string" || typeof v.raw !== "string" || v.raw.length > 2 * 1024 * 1024 || typeof v.digest !== "string" || contentHash(v.raw) !== v.digest) throw new Error("草稿附带材料或文件版本无效");
	if (kind === "excerpt") {
		const snapshot = readExcerptSnapshot(v.raw, { annotationPath: v.path, id: String(v.excerptId) });
		if (typeof v.includeNote !== "boolean" || v.includeNote && !snapshot.record.manualText.trim()) throw new Error("请明确选择已有个人备注");
	} else if (kind === "answer") {
		const file = readAnswerExcerpt(v.raw, v.path), roles = v.roles as AnswerContentRole[];
		if (!Array.isArray(roles) || !roles.length || roles.some(role => !Object.prototype.hasOwnProperty.call(ANSWER_CONTENT_ROLES, role) || !answerRoleText(file, role).trim())
			|| roles.join() !== (Object.keys(ANSWER_CONTENT_ROLES) as AnswerContentRole[]).filter(role => roles.includes(role)).join()) throw new Error("请选择有效的学习摘录内容角色");
	} else throw new Error("草稿材料类型无效");
	return structuredClone(raw) as DraftMaterial;
}
export function validateKnowledgeDraft(raw: unknown): KnowledgeDraft {
	const v = draftObject(raw, ["version", "id", "kind", "title", "body", "material", "created", "updated"]);
	if (v.version !== 1 || typeof v.id !== "string" || !DRAFT_ID.test(v.id) || typeof v.kind !== "string" || !Object.prototype.hasOwnProperty.call(DRAFT_KINDS, v.kind)
		|| typeof v.title !== "string" || !v.title.trim() || v.title.length > 200 || /[\r\n\x00-\x1f]/.test(v.title)
		|| typeof v.body !== "string" || v.body.length > 40000 || !draftDate(v.created) || !draftDate(v.updated) || v.created > v.updated) throw new Error("草稿标题、正文、类型或时间无效（标题最多 200 字符，正文最多 40,000 字符）");
	validateDraftMaterial(v.material); return structuredClone(raw) as KnowledgeDraft;
}
export function newKnowledgeDraft(material: DraftMaterial | null = null): KnowledgeDraft {
	const now = new Date().toISOString(); return { version: 1, id: "d-" + randomUUID(), title: "", body: "", kind: "concept", material: validateDraftMaterial(material), created: now, updated: now };
}
const literal = (s: string) => s.replace(/\\/g, "\\\\").replace(/([`*_{}\[\]()#+.!|~<>-])/g, "\\$1");
const quote = (s: string) => s.split(/\r?\n/).map(line => "> " + literal(line)).join("\n");
export function draftMaterialText(material: DraftMaterial | null): string {
	const m = validateDraftMaterial(material); if (!m) return "没有附带材料。正文为用户草稿，来源与结论尚未核验。";
	if (m.kind === "excerpt") {
		const r = readExcerptSnapshot(m.raw, { annotationPath: m.path, id: m.excerptId }).record;
		return "保存时的原文摘录（文字记录，当前来源及科学结论待核对）：\n\n" + quote(r.selectedText) + "\n\n来源：" + readingPathCode(r.sourcePath)
			+ (r.pdfExcerpt ? `；PDF 第 ${r.pdfExcerpt.page} / ${r.pdfExcerpt.pageCount} 页（文件页码）` : "")
			+ `；字符 ${r.sourceAnchor!.start}–${r.sourceAnchor!.end}；原文版本 ` + readingPathCode((r.pdfExcerpt || r.excerpt)!.digest)
			+ "\n\n摘录：" + readingPathCode(m.path) + "；快照：" + readingPathCode(m.digest)
			+ (m.includeNote ? "\n\n个人备注（未核验）：\n\n" + quote(r.manualText) : "");
	}
	const f = readAnswerExcerpt(m.raw, m.path), a = f.record.answer;
	return "学习材料（AI 回答或基于 AI 的人工记录，不是论文证据）：\n\n" + m.roles.map(role => ANSWER_CONTENT_ROLES[role] + "：\n\n" + quote(answerRoleText(f, role))).join("\n\n")
		+ "\n\n摘录：" + readingPathCode(m.path) + "；快照：" + readingPathCode(m.digest) + "\n\n回答版本：" + readingPathCode(a.digest)
		+ "；模型：" + readingPathCode(a.provider + " · " + a.model) + "；来源：" + readingPathCode(a.context.location);
}
export function renderKnowledgeDraft(raw: KnowledgeDraft): string {
	const d = validateKnowledgeDraft(raw);
	return "# " + literal(d.title) + "\n\n新知识页草稿 · " + DRAFT_KINDS[d.kind] + "\n\n尚未创建正式知识页，正文和材料均待审阅。\n\n## 用户草稿正文\n\n" + d.body
		+ "\n\n## 附带材料（保存时的快照）\n\n" + draftMaterialText(d.material);
}
export async function readDraftMaterial(app: App, input: { kind: "excerpt"; ref: ExcerptRef; includeNote: boolean } | { kind: "answer"; path: string; roles: AnswerContentRole[] }, signal?: AbortSignal): Promise<DraftMaterial> {
	const stable = structuredClone(input), path = stable.kind === "excerpt" ? stable.ref.annotationPath : stable.path; signal?.throwIfAborted();
	const file = app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile) || file.extension !== "md" || file.stat.size > 2 * 1024 * 1024) throw new Error("摘录缺失或超过读取上限");
	const raw = await app.vault.read(file); signal?.throwIfAborted();
	if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file) throw new Error("摘录读取期间移动或替换");
	return validateDraftMaterial({ kind: stable.kind, path, raw, digest: contentHash(raw), ...(stable.kind === "excerpt" ? { excerptId: stable.ref.id, includeNote: stable.includeNote } : { roles: stable.roles }) })!;
}
/** Historical material remains editable as a draft when its current source is missing. Never silently replace it. */
export async function draftMaterialStatus(app: App, answers: AnswerExcerptService, material: DraftMaterial | null, signal?: AbortSignal): Promise<string> {
	const m = validateDraftMaterial(material); if (!m) return "手写草稿，没有附带来源；尚未核验。";
	try {
		const current = await readDraftMaterial(app, m.kind === "excerpt" ? { kind: "excerpt", ref: { id: m.excerptId, annotationPath: m.path }, includeNote: m.includeNote } : { kind: "answer", path: m.path, roles: m.roles }, signal);
		if (objectDigest(current) !== objectDigest(m)) return "当前摘录已变化；草稿保留历史快照，需复查。";
		if (m.kind === "answer") { await answers.verify(readAnswerExcerpt(m.raw, m.path).record.answer, signal); return "与保存回答版本一致；不代表原文或教学核验通过。"; }
		return await new ExcerptLibraryService(app).status(readExcerptSnapshot(m.raw, { id: m.excerptId, annotationPath: m.path }), signal);
	} catch (error) { signal?.throwIfAborted(); return "来源暂时无法核对，历史草稿保留：" + String(error); }
}
