import type { App } from "obsidian";
import { answerExcerptText, readAnswerExcerpt, renderAnswerExcerpt, type AnswerExcerptService, type AnswerExcerptFile } from "../learning/answer-excerpts";
import { literalLearningBlock } from "../learning/curated-block";
import { objectDigest } from "../papers/identity";
import { contentHash } from "../retrieval/chunks";
import { curationParagraphs, curationTarget } from "./policy";
import type { CurationContext, CurationSuggestion } from "./types";

export const ANSWER_CONTENT_ROLES = { ai: "原始 AI 回答片段", human: "人工修订稿（基于 AI 回答）", note: "个人备注" } as const;
export type AnswerContentRole = keyof typeof ANSWER_CONTENT_ROLES;
export const answerCurationTarget = (path: string): boolean => curationTarget(path) && !path.startsWith("wiki/sources/");
const RULE = "answer-excerpt-curation-v1";
const key = (c: CurationContext): string => objectDigest({ rule: RULE, input: c.answerExcerpt, source: c.source, target: c.target });
export function answerRoleText(file: AnswerExcerptFile, role: AnswerContentRole): string {
	return role === "ai" ? answerExcerptText(file.record) : role === "human" ? file.record.humanRevision?.text || "" : file.record.note;
}
export function answerExcerptAddition(context: CurationContext): string {
	const input = context.answerExcerpt!, file = input.snapshot, r = file.record, a = r.answer;
	return literalLearningBlock(["学习背景与个人理解（未作原文、科学或教学核验，不作为论文证据）", "",
		...input.roles.flatMap(role => [ANSWER_CONTENT_ROLES[role] + "：", answerRoleText(file, role), ""]),
		"回答标题：" + a.title, "问题：" + a.question, "模型：" + a.provider + " · " + a.model,
		"学习摘录：" + file.path, "摘录版本：" + file.digest, "回答版本：" + a.digest,
		"选区：" + r.start + "–" + r.end + "（UTF-16）", "回答标识：" + JSON.stringify(a.ref),
		"学习来源（未核验原文）：" + a.context.location].join("\n"));
}
export function answerExcerptSuggestion(context: CurationContext): CurationSuggestion {
	return { id: "s-0", kind: "add", paragraphId: context.answerExcerpt!.paragraphId, claim: "补充学习背景与个人理解", text: answerExcerptAddition(context), reason: "明确保留所选内容角色；核对保存回答版本，不核验论文结论。", citations: [], warnings: [], applicable: true, decision: "pending" };
}
export function validateAnswerExcerptContext(context: CurationContext): void {
	const input = context.answerExcerpt;
	if (!input || context.excerpt || input.version !== 1 || !input.snapshot || !Array.isArray(input.roles) || !input.roles.length || input.roles.length > 3
		|| input.roles.some((role, i) => !(role in ANSWER_CONTENT_ROLES) || input.roles.indexOf(role) !== i || !answerRoleText(input.snapshot, role).trim())
		|| input.roles.join() !== (Object.keys(ANSWER_CONTENT_ROLES) as AnswerContentRole[]).filter(role => input.roles.includes(role)).join()) throw new Error("学习摘录内容角色无效，请明确选择已有内容");
	const snapshot = readAnswerExcerpt(renderAnswerExcerpt(input.snapshot.record), input.snapshot.path);
	if (snapshot.digest !== input.snapshot.digest || context.ruleVersion !== RULE || context.key !== key(context) || context.sessionId !== "" || context.nodeIds.length !== 0
		|| context.learningHash !== snapshot.digest || context.evidence.length || context.backendId !== "none" || context.model !== "" || context.prompt !== "" || context.estimate !== 0 || !context.sourceCompatible
		|| objectDigest(context.source) !== objectDigest({ kind: "article", path: snapshot.path, title: snapshot.record.answer.title, fingerprint: snapshot.digest })
		|| !answerCurationTarget(context.target.path) || contentHash(context.target.text) !== context.target.hash
		|| objectDigest(context.target.paragraphs) !== objectDigest(curationParagraphs(context.target.text)) || !context.target.paragraphs.some(p => p.id === input.paragraphId)
		|| context.target.text.includes(snapshot.path) || answerExcerptAddition(context).length > 40000) throw new Error("学习摘录整理凭据无效、重复或超过四万字符，请重新准备");
}
export function validateAnswerExcerptSuggestion(raw: unknown, context: CurationContext, index: number): CurationSuggestion {
	validateAnswerExcerptContext(context); const expected = answerExcerptSuggestion(context), value = raw as CurationSuggestion;
	if (index !== 0 || !value || objectDigest({ ...value, decision: "pending" }) !== objectDigest(expected)) throw new Error("学习摘录内容已变化，请重新准备"); return expected;
}
export function answerExcerptNoteText(context: CurationContext): string {
	validateAnswerExcerptContext(context); const paragraph = context.target.paragraphs.find(p => p.id === context.answerExcerpt!.paragraphId)!;
	const text = context.target.text, eol = text.includes("\r\n") ? "\r\n" : "\n";
	return text.slice(0, paragraph.end) + eol + eol + answerExcerptAddition(context).replace(/\r?\n/g, eol) + text.slice(paragraph.end);
}
async function readTarget(app: App, path: string, limit: number): Promise<string> {
	const file = app.vault.getFileByPath(path); if (!file || file.stat?.size > limit) throw new Error("目标笔记缺失或超过读取上限");
	const text = await app.vault.read(file); if (text.length > limit || file.path !== path || app.vault.getFileByPath(path) !== file) throw new Error("读取期间目标移动、替换或超过上限"); return text;
}
export async function prepareAnswerExcerptCuration(app: App, service: AnswerExcerptService, path: string, targetPath: string, paragraphId: string, roles: AnswerContentRole[], signal?: AbortSignal): Promise<CurationContext> {
	roles = [...roles];
	signal?.throwIfAborted(); if (!answerCurationTarget(targetPath)) throw new Error("学习内容只能补充到已有概念、方法或综合笔记");
	const snapshot = await service.load(path, signal), text = await readTarget(app, targetPath, 160000);
	if (text.includes(snapshot.path)) throw new Error("目标已有这条学习摘录，请先查看已有内容或修订历史");
	const context: CurationContext = { answerExcerpt: { version: 1, snapshot, paragraphId, roles: [...roles] }, ruleVersion: RULE, key: "", sessionId: "", nodeIds: [], learningHash: snapshot.digest,
		title: "学习摘录 · " + snapshot.record.answer.title, source: { kind: "article", path: snapshot.path, title: snapshot.record.answer.title, fingerprint: snapshot.digest },
		target: { path: targetPath, title: targetPath, text, hash: contentHash(text), paragraphs: curationParagraphs(text) }, evidence: [], backendId: "none", backendName: "本地学习整理", model: "", prompt: "", estimate: 0, sourceCompatible: true,
		warnings: ["只核对已保存回答与摘录版本；未核验原始 PDF、代码或科学主张。", "所选学习内容单独标记并排除正式证据检索；不会自动标记整理完成。"] };
	context.key = key(context); await verifyAnswerExcerptCuration(app, service, context, context.target.hash, signal); return context;
}
export async function verifyAnswerExcerptCuration(app: App, service: AnswerExcerptService | undefined, context: CurationContext, targetHash: string, signal?: AbortSignal): Promise<void> {
	validateAnswerExcerptContext(context); signal?.throwIfAborted(); if (!service) throw new Error("学习回答核对服务不可用");
	const expected = context.answerExcerpt!.snapshot, latest = await service.load(expected.path, signal);
	if (latest.digest !== expected.digest || objectDigest(latest.record) !== objectDigest(expected.record)) throw new Error("学习摘录、修订稿、备注或状态已变化，请重新准备预览");
	await service.verify(expected.record.answer, signal);
	if (contentHash(await readTarget(app, context.target.path, 1000000)) !== targetHash) throw new Error("目标笔记已变化，请重新预览"); signal?.throwIfAborted();
}
