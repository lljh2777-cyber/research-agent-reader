import { App, MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import { readAnnotationRecords } from "./annotation-service";
import { excerptMatches, excerptRevision, prepareExcerpt } from "./excerpt";
import type { AnnotationRecord } from "./types";

export interface ExcerptRef { annotationPath: string; id: string; }
export interface ExcerptSnapshot { record: AnnotationRecord; digest: string; }
export interface ExcerptList { entries: ExcerptSnapshot[]; issues: string[]; }
const ROOT = "wiki/annotations/", MAX_FILE = 128 * 1024;
const MANUAL_START = "<!-- agent-dashboard:manual-start -->", MANUAL_END = "<!-- agent-dashboard:manual-end -->";
const META = /<!-- agent-dashboard:annotation-meta (\{[^\r\n]*\}) -->/g;
const validPath = (path: string): boolean => /^wiki\/annotations\/ann-excerpt-[a-f0-9]{48}\.md$/.test(path);
const digest = (text: string): string => excerptRevision(text).digest;

/** A strict, single-record snapshot. Unknown body text is retained, never regenerated. */
export function readExcerptSnapshot(content: string, ref: ExcerptRef): ExcerptSnapshot {
	if (!validPath(ref.annotationPath) || ref.annotationPath !== ROOT + ref.id + ".md" || content.length > MAX_FILE) throw new Error("摘录路径或文件大小不符合读取范围");
	const parsed = readAnnotationRecords(content, ref.annotationPath), record = parsed.records[0];
	if (parsed.errors.length || parsed.records.length !== 1 || record.id !== ref.id || !record.excerpt || !record.sourceAnchor) throw new Error("摘录凭据损坏或存在重复记录，请打开文档检查");
	const markers = ["annotation-start " + record.id + " -->", "annotation-meta ", "manual-start -->", "manual-end -->", "ai-start -->", "ai-end -->", "annotation-end " + record.id + " -->"];
	let previous = -1;
	for (const marker of markers) {
		const value = "<!-- agent-dashboard:" + marker, at = content.indexOf(value);
		if (at <= previous || content.indexOf(value, at + value.length) !== -1) throw new Error("摘录分区标记损坏或重复，请打开文档检查");
		previous = at;
	}
	if ([...content.matchAll(META)].length !== 1) throw new Error("摘录元数据无法唯一识别");
	return { record, digest: digest(content) };
}

/** Compare the entire file inside Vault.process; change only the personal section and update times. */
export function patchExcerptNote(content: string, expected: ExcerptSnapshot, manualText: string, now: string): string {
	if (manualText.length > 10000 || manualText.includes("<!-- agent-dashboard:")) throw new Error("个人备注过长或包含批注控制标记，未保存");
	const latest = readExcerptSnapshot(content, expected.record);
	if (latest.digest !== expected.digest) throw new Error("摘录已被其他窗口或同步修改；草稿已保留，请重新读取并核对最新备注后保存");
	const note = manualText.trim();
	if (note === latest.record.manualText) return content;
	const start = content.indexOf(MANUAL_START) + MANUAL_START.length, end = content.indexOf(MANUAL_END);
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	let next = content.slice(0, start) + eol + note + eol + content.slice(end);
	next = next.replace(META, (_all, json: string) => {
		const meta = JSON.parse(json); meta.updatedAt = now;
		return "<!-- agent-dashboard:annotation-meta " + JSON.stringify(meta).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + " -->";
	});
	// Update only existing generated timestamps. Preserve extra prose and unknown metadata fields.
	next = next.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/, (_all, start: string, body: string, end: string) => start + body.replace(/^updated: [^\r\n]*/m, `updated: ${JSON.stringify(now)}`) + end);
	const old = "- 更新：" + latest.record.updatedAt;
	const blockStart = next.indexOf("<!-- agent-dashboard:annotation-start ");
	const contextStart = next.indexOf("### 保存时的原文上下文", blockStart);
	const at = next.indexOf(old, blockStart);
	if (at >= 0 && at < contextStart) next = next.slice(0, at) + "- 更新：" + now + next.slice(at + old.length);
	return next;
}

export class ExcerptLibraryService {
	constructor(private readonly app: App, private readonly openMarkdown?: (file: TFile) => Promise<WorkspaceLeaf>) {}
	async load(ref: ExcerptRef, signal?: AbortSignal): Promise<ExcerptSnapshot> {
		const stable = { annotationPath: ref.annotationPath, id: ref.id };
		signal?.throwIfAborted();
		if (!validPath(stable.annotationPath)) throw new Error("摘录路径不符合读取范围");
		const file = this.app.vault.getAbstractFileByPath(stable.annotationPath);
		if (!(file instanceof TFile)) throw new Error("摘录文档已缺失，请刷新列表");
		if (file.stat?.size > MAX_FILE) throw new Error("摘录文档超过读取上限，请直接打开检查");
		const content = await this.app.vault.read(file); signal?.throwIfAborted();
		if (file.path !== stable.annotationPath || this.app.vault.getAbstractFileByPath(stable.annotationPath) !== file) throw new Error("摘录文档在读取时已移动或替换，请刷新列表");
		return readExcerptSnapshot(content, stable);
	}
	async list(signal?: AbortSignal): Promise<ExcerptList> {
		const entries: ExcerptSnapshot[] = [], issues: string[] = [];
		const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(ROOT + "ann-excerpt-")).sort((a, b) => a.path.localeCompare(b.path));
		if (files.length > 2000) issues.push("摘录超过 2000 份，本次仅读取前 2000 份；其余文档仍保留在批注目录。");
		for (const file of files.slice(0, 2000)) {
			signal?.throwIfAborted();
			try { entries.push(await this.load({ annotationPath: file.path, id: file.basename }, signal)); }
			catch (error) { signal?.throwIfAborted(); issues.push(file.path + "：" + (error instanceof Error ? error.message : String(error))); }
		}
		entries.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id));
		return { entries, issues };
	}
	async status(snapshot: ExcerptSnapshot, signal?: AbortSignal): Promise<string> {
		const latest = await this.load(snapshot.record, signal);
		if (latest.digest !== snapshot.digest) return "摘录文档已变化，请重新读取后核对来源与最新备注";
		const record = latest.record;
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		if (!(file instanceof TFile)) return "原文已缺失；保留历史摘录，需复查";
		if (file.stat?.size > 32 * 1024 * 1024) return "原文超过核对上限，保留历史摘录，需复查";
		const text = await this.app.vault.read(file); signal?.throwIfAborted();
		return excerptMatches(record, text) ? "Markdown 文本与保存时一致；未据此核验 PDF、图片或科学结论" : "原文版本已变化；保留历史摘录，需复查";
	}
	async saveNote(snapshot: ExcerptSnapshot, manualText: string, signal?: AbortSignal): Promise<ExcerptSnapshot> {
		// Capture primitive inputs before the first asynchronous boundary.
		const expected = { digest: snapshot.digest, record: { ...snapshot.record } };
		await this.load(expected.record, signal);
		const file = this.app.vault.getAbstractFileByPath(expected.record.annotationPath);
		if (!(file instanceof TFile)) throw new Error("摘录文档已缺失");
		let intended: string | undefined;
		try {
			await this.app.vault.process(file, content => {
				signal?.throwIfAborted();
				if (file.path !== expected.record.annotationPath || this.app.vault.getAbstractFileByPath(expected.record.annotationPath) !== file) throw new Error("摘录文档在保存前已移动或替换，未写入");
				intended = patchExcerptNote(content, expected, manualText, new Date().toISOString());
				return intended;
			});
		} catch (error) {
			// A write can commit before its response fails. Only accept the exact intended file.
			if (intended !== undefined && await this.app.vault.read(file) === intended) return readExcerptSnapshot(intended, expected.record);
			throw error;
		}
		const saved = await this.app.vault.read(file);
		if (saved !== intended) throw new Error("写入后摘录再次发生变化；草稿已保留，请重新读取核对");
		return readExcerptSnapshot(saved, expected.record);
	}
	async openSource(ref: ExcerptRef, signal?: AbortSignal): Promise<void> {
		const snapshot = await this.load(ref, signal), record = snapshot.record;
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		if (!(file instanceof TFile)) throw new Error("原文已缺失；请保留历史摘录并复查来源");
		if (file.stat?.size > 32 * 1024 * 1024) throw new Error("原文超过定位核对上限");
		const content = await this.app.vault.read(file); signal?.throwIfAborted();
		if (!excerptMatches(record, content)) throw new Error("原文版本已变化，未跳转到相似段落；请查看保存时的上下文");
		const anchor = record.sourceAnchor!;
		// Confirm that the canonical ID still describes this exact occurrence.
		const { algorithm, digest, length } = record.excerpt!;
		const prepared = prepareExcerpt({ sourcePath: record.sourcePath, selectedText: record.selectedText, sourceStart: anchor.start, sourceEnd: anchor.end, prefix: anchor.prefix, suffix: anchor.suffix, sourceRevision: { algorithm, digest, length }, section: "", context: "", isTableCell: false, anchorRect: {} as DOMRect }, content);
		if (prepared.id !== record.id) throw new Error("摘录位置与记录 ID 不一致，请复查文档");
		signal?.throwIfAborted();
		const leaf = this.openMarkdown ? await this.openMarkdown(file) : this.app.workspace.getLeaf("tab");
		if (!this.openMarkdown) await leaf.openFile(file, { active: true, state: { mode: "source" } });
		signal?.throwIfAborted();
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || view.file?.path !== record.sourcePath || view.editor.getValue() !== content) throw new Error("原文已打开，但编辑器文本不一致，未定位选区");
		if ((await this.load(record, signal)).digest !== snapshot.digest || await this.app.vault.read(file) !== content) throw new Error("打开期间来源或摘录已变化，未定位选区");
		signal?.throwIfAborted();
		if (view.file?.path !== record.sourcePath || view.editor.getValue() !== content) throw new Error("编辑器内容已变化，未定位选区");
		const from = view.editor.offsetToPos(anchor.start), to = view.editor.offsetToPos(anchor.end);
		view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true); view.editor.focus();
	}
}
