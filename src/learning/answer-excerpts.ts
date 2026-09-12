import { TFile, type App } from "obsidian";
import { objectDigest } from "../papers/identity";
import { excerptRevision } from "../annotations/excerpt";
import { readingPathCode } from "../reading/export";
import { ANSWER_EXCERPT_ROOT, validAnswerExcerptPath } from "./answer-excerpt-path";
import { validateAnswerSnapshot, type AnswerSnapshot, type AnswerRef } from "./answer-snapshot";

export interface AnswerExcerpt {
	version: 1; id: string; answer: AnswerSnapshot; start: number; end: number; note: string; created: string; updated: string;
}
export interface AnswerExcerptFile { path: string; digest: string; record: AnswerExcerpt; }
export interface AnswerExcerptList { entries: AnswerExcerptFile[]; issues: string[]; }
export type AnswerReader = (ref: AnswerRef, signal?: AbortSignal) => Promise<AnswerSnapshot>;
const MAX_FILE = 2 * 1024 * 1024, MARKER = /<!-- rar-answer-excerpt (\{[^\r\n]*\}) -->/g;
const fileHash = (text: string): string => excerptRevision(text).digest;
const pathFor = (id: string): string => `${ANSWER_EXCERPT_ROOT}/${id}.md`;
const identity = (answer: AnswerSnapshot, start: number, end: number): string => "answer-" + objectDigest({ answer: answer.digest, start, end }).slice(0, 48);
const fence = (text: string): string => { let width = 3; for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1); const ticks = "`".repeat(width); return ticks + "text\n" + text + "\n" + ticks; };
export const answerExcerptText = (record: AnswerExcerpt): string => record.answer.content.slice(record.start, record.end);
export function prepareAnswerExcerpt(answer: AnswerSnapshot, start = 0, end = answer.content.length, note = "", date = new Date().toISOString()): AnswerExcerpt {
	answer = validateAnswerSnapshot(answer);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > answer.content.length || !answer.content.slice(start, end).trim()) throw new Error("请在这条回答中选择非空文字");
	const splitsCharacter = (at: number): boolean => /[\uD800-\uDBFF]/.test(answer.content[at - 1] || "") && /[\uDC00-\uDFFF]/.test(answer.content[at] || "");
	if (splitsCharacter(start) || splitsCharacter(end)) throw new Error("选区切开了一个字符，请重新选择完整文字");
	if (typeof note !== "string" || note.length > 10000) throw new Error("个人备注超过一万字符");
	if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error("摘录时间无效");
	return { version: 1, id: identity(answer, start, end), answer, start, end, note, created: date, updated: date };
}
export function renderAnswerExcerpt(record: AnswerExcerpt): string {
	const a = record.answer, r = a.ref;
	return ["---", "type: learning-answer-excerpt", "title: " + JSON.stringify(a.title + " · AI 回答摘录"), "evidence_basis: ai-answer", "created: " + record.created, "updated: " + record.updated, "---", "",
		"# AI 回答摘录", "", "以下文字摘自已保存的 AI 回答，不是论文原句，不代表科学或教学核验通过。个人备注单独保留。", "",
		"来源类型：" + (r.kind === "topic" ? "主题学习 · 模型一般知识" : a.context.kind === "code" ? "代码交互学习 · AI 解释，未据此执行代码" : "资料交互阅读 · AI 解释"), "",
		"回答标题：" + readingPathCode(a.title), "", "问题：" + readingPathCode(a.question), "",
		"模型：" + readingPathCode(a.provider || "未记录供应商") + " · " + readingPathCode(a.model || "未记录模型"), "",
		"会话：" + readingPathCode(r.kind === "topic" ? r.topicId : r.sessionId) + "；节点：" + readingPathCode(r.nodeId), "",
		"回答版本：" + readingPathCode(a.digest) + "；字符：" + record.start + "–" + record.end + "（UTF-16）", "",
		"来源位置：" + readingPathCode(a.context.location) + (r.kind === "topic" ? "；路线：" + readingPathCode(r.route) + "；请求：" + readingPathCode(a.context.requestId) + "；教学规则：" + readingPathCode(a.context.rule) : ""), "",
		...(a.context.correction ? ["此处保留历史回答；已选核对节点：" + readingPathCode(a.context.correction), ""] : []),
		"## AI 回答片段", "", fence(answerExcerptText(record)), "", "## 个人备注", "", fence(record.note), "",
		"<!-- rar-answer-excerpt " + JSON.stringify(record).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + " -->", ""].join("\n");
}
export function readAnswerExcerpt(text: string, path: string): AnswerExcerptFile {
	if (!validAnswerExcerptPath(path) || Buffer.byteLength(text) > MAX_FILE) throw new Error("学习摘录路径无效或超过读取上限");
	const matches = [...text.matchAll(MARKER)]; if (matches.length !== 1) throw new Error("学习摘录凭据缺失或重复，请直接打开文档检查");
	const r: AnswerExcerpt = JSON.parse(matches[0][1]), expected = prepareAnswerExcerpt(r.answer, r.start, r.end, r.note, r.created);
	if (r.version !== 1 || r.id !== expected.id || path !== pathFor(r.id) || !Number.isFinite(Date.parse(r.updated)) || new Date(r.updated).toISOString() !== r.updated || r.updated < r.created || text !== renderAnswerExcerpt(r)) throw new Error("学习摘录内容或凭据被修改，请直接打开文档核对；未覆盖用户内容");
	return { path, record: structuredClone(r), digest: fileHash(text) };
}

export class AnswerExcerptService {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly app: App, private readonly answer: AnswerReader) {}
	async load(path: string, signal?: AbortSignal): Promise<AnswerExcerptFile> {
		signal?.throwIfAborted(); if (!validAnswerExcerptPath(path)) throw new Error("学习摘录路径无效");
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.stat.size > MAX_FILE) throw new Error("学习摘录缺失或超过读取上限");
		const text = await this.app.vault.read(file); signal?.throwIfAborted();
		if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("读取期间学习摘录已移动或替换");
		return readAnswerExcerpt(text, path);
	}
	async list(signal?: AbortSignal): Promise<AnswerExcerptList> {
		const result: AnswerExcerptList = { entries: [], issues: [] }, files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(ANSWER_EXCERPT_ROOT + "/")).sort((a, b) => a.path.localeCompare(b.path));
		if (files.length > 500) result.issues.push("学习摘录超过 500 份，本次仅读取前 500 份。"); let bytes = 0;
		for (const file of files.slice(0, 500)) {
			signal?.throwIfAborted(); bytes += file.stat.size; if (bytes > 32 * 1024 * 1024) { result.issues.push("学习摘录达到 32 MiB 读取上限，保留未显示文档。"); break; }
			try { result.entries.push(await this.load(file.path, signal)); } catch (error) { signal?.throwIfAborted(); result.issues.push(file.path + "：" + String(error)); }
		}
		result.entries.sort((a, b) => b.record.created.localeCompare(a.record.created) || a.path.localeCompare(b.path)); return result;
	}
	async verify(answer: AnswerSnapshot, signal?: AbortSignal): Promise<void> {
		const stable = validateAnswerSnapshot(answer), latest = await this.answer(stable.ref, signal); signal?.throwIfAborted();
		if (latest.digest !== stable.digest) throw new Error("回答版本、引用或核对状态已变化，请重新选择回答；历史摘录保留");
	}
	save(input: AnswerExcerpt, signal?: AbortSignal): Promise<{ file: AnswerExcerptFile; reused: boolean; warning?: string }> {
		const record = structuredClone(input), path = pathFor(record.id), text = renderAnswerExcerpt(record); readAnswerExcerpt(text, path);
		return this.serial(async () => {
			signal?.throwIfAborted(); await this.verify(record.answer, signal);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing) { const file = await this.load(path, signal); return { file, reused: true }; }
			for (const directory of ["wiki", "wiki/qa", ANSWER_EXCERPT_ROOT]) {
				signal?.throwIfAborted(); if (this.app.vault.getAbstractFileByPath(directory)) continue;
				try { await this.app.vault.createFolder(directory); } catch (error) { if (!this.app.vault.getAbstractFileByPath(directory)) throw error; }
			}
			await this.verify(record.answer, signal); signal?.throwIfAborted();
			let reused = false;
			try { await this.app.vault.create(path, text); }
			catch (error) {
				// The same deterministic excerpt may have committed before a failed response, or in another window.
				if (!this.app.vault.getAbstractFileByPath(path)) throw error;
				await this.load(path); reused = true;
			}
			const file = await this.load(path);
			try { await this.verify(record.answer, signal); return { file, reused }; }
			catch (error) { return { file, reused, warning: "摘录已保存；保存后回答暂时无法确认，保留历史并请复查：" + String(error) }; }
		});
	}
	saveNote(input: AnswerExcerptFile, note: string, signal?: AbortSignal): Promise<AnswerExcerptFile> {
		const expected = structuredClone(input);
		return this.serial(async () => {
			await this.load(expected.path, signal); const file = this.app.vault.getAbstractFileByPath(expected.path); if (!(file instanceof TFile)) throw new Error("学习摘录缺失");
			if (typeof note !== "string" || note.length > 10000) throw new Error("个人备注超过一万字符"); let intended: string | undefined;
			try { await this.app.vault.process(file, text => {
				signal?.throwIfAborted(); if (file.path !== expected.path || this.app.vault.getAbstractFileByPath(expected.path) !== file || fileHash(text) !== expected.digest) throw new Error("学习摘录已被其他窗口修改，请重新读取；草稿仍保留");
				const latest = readAnswerExcerpt(text, expected.path); intended = note === latest.record.note ? text : renderAnswerExcerpt({ ...latest.record, note, updated: new Date(Math.max(Date.now(), Date.parse(latest.record.updated))).toISOString() }); return intended;
			}); } catch (error) {
				if (intended === undefined || file.path !== expected.path || this.app.vault.getAbstractFileByPath(expected.path) !== file || await this.app.vault.read(file) !== intended) throw error;
			}
			const saved = await this.load(expected.path); if (saved.digest !== fileHash(intended!)) throw new Error("写入后摘录再次变化，请重新读取核对"); return saved;
		});
	}
	private serial<T>(run: () => Promise<T>): Promise<T> { const result = this.queue.then(run); this.queue = result.catch(() => undefined); return result; }
}
