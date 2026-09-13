import { randomUUID } from "node:crypto";
import { contentHash } from "../retrieval/chunks";
import { readingPathCode } from "../reading/export";
import { curationParagraphs, curationTarget, protectedPrefix, validateSuggestion } from "./policy";
import type { CurationService } from "./service";
import type { CurationReview, CurationRevision, CurationSuggestion, RevisionWrite } from "./types";
import { excerptNoteText, validateExcerptContext } from "./excerpt";
import { answerExcerptNoteText, validateAnswerExcerptContext } from "./answer-excerpt";

const indices = { sources: "文献索引.md", concepts: "研究主题索引.md", methods: "研究方法索引.md", synthesis: "研究主题索引.md" };
const link = (file: string): string => "[[" + file.replace(/\.md$/, "") + "]]";
function revisionLog(revision: Pick<CurationRevision, "id" | "created" | "undoOf" | "suggestionIds">, review: CurationReview, indexed: boolean): string {
	if (revision.undoOf) return "\n- " + revision.created + " 撤销整理修订 " + readingPathCode(revision.undoOf) + "；恢复 " + link(review.context.target.path) + " 的前一内容；新修订 " + readingPathCode(revision.id) + "。索引入口保留。\n";
	if (review.context.answerExcerpt) return "\n- " + revision.created + " 保存学习背景至 " + link(review.context.target.path) + "；修订 " + readingPathCode(revision.id) + "；学习摘录 " + readingPathCode(review.context.answerExcerpt.snapshot.path) + "；内容角色分别保留，未作论文证据核验。" + (indexed ? "已补充索引入口。" : "索引入口已存在或对应索引文件缺失，未改动索引。") + "\n";
	if (review.context.excerpt) return "\n- " + revision.created + " 整理摘录至 " + link(review.context.target.path) + "；修订 " + readingPathCode(revision.id) + "；摘录 " + readingPathCode(review.context.excerpt.snapshot.record.annotationPath) + "；原句与个人备注分别保留，未调用模型。" + (indexed ? "已补充索引入口。" : "索引入口已存在或对应索引文件缺失，未改动索引。") + "\n";
	return "\n- " + revision.created + " 整理学习内容至 " + link(review.context.target.path) + "；修订 " + readingPathCode(revision.id) + "；会话 " + readingPathCode(review.context.sessionId) + "；采用 " + revision.suggestionIds.length + " 条建议。" + (indexed ? "已补充索引入口。" : "索引入口已存在或对应索引文件缺失，未改动索引。") + "\n";
}
export function curationNoteText(review: CurationReview, selectedIds: string[]): string {
	const ids = new Set(selectedIds); const choices = review.suggestions.filter(s => ids.has(s.id));
	if (!ids.size || ids.size !== selectedIds.length || choices.length !== ids.size || choices.some(s => !s.applicable || s.decision !== "pending")) throw new Error("请选择尚未处理且证据完整的建议");
	if (review.context.answerExcerpt) {
		validateAnswerExcerptContext(review.context); if (choices.length !== 1 || review.suggestions.length !== 1) throw new Error("每次只整理一条学习摘录");
		validateSuggestion(choices[0], review.context, 0); return answerExcerptNoteText(review.context);
	}
	if (review.context.excerpt) {
		validateExcerptContext(review.context); if (choices.length !== 1 || review.suggestions.length !== 1) throw new Error("每次只整理一条摘录");
		validateSuggestion(choices[0], review.context, 0); return excerptNoteText(review.context);
	}
	const context = review.context; const paragraphs = curationParagraphs(context.target.text); const edits = new Map<string, CurationSuggestion[]>();
	for (const suggestion of choices) {
		if (!validateSuggestion(suggestion, context, review.suggestions.indexOf(suggestion)).applicable) throw new Error("建议内容或证据校验失败");
		const original = paragraphs.find(p => p.id === suggestion.paragraphId); if (!original) throw new Error("目标段落定位失效");
		if (suggestion.kind === "replace" && /\[\[|\]\(/.test(original.text)) throw new Error("替换会影响原段落链接，请改为追加补充");
		const group = edits.get(original.id) || []; group.push(suggestion); edits.set(original.id, group);
	}
	let text = context.target.text;
	for (const paragraph of paragraphs.filter(p => edits.has(p.id)).sort((a, b) => b.start - a.start)) {
		const suggestions = edits.get(paragraph.id)!; const replacements = suggestions.filter(s => s.kind === "replace"); if (replacements.length > 1) throw new Error("同一段落只能选择一条替换建议");
		const render = (suggestion: CurationSuggestion): string => {
			const citations = suggestion.citations.map(citation => {
				const evidence = context.evidence.find(e => e.id === citation.id)!;
				const location = evidence.kind === "vault" && curationTarget(evidence.path) ? link(evidence.path) : readingPathCode(evidence.path);
				const structured = evidence.structured ? "，" + readingPathCode(`JATS ${context.source.structured!.manifest.sourceVersionId}；块 ${evidence.structured.blockId}；XML ${evidence.structured.xmlPath}`) : "";
				return location + structured + (evidence.page ? "，第 " + evidence.page + " 页" : "") + (evidence.start !== undefined ? "，字符 " + evidence.start + "–" + evidence.end : "") + "：“" + citation.quote.replace(/[\r\n]+/g, " ").replace(/[<>\[\]`]/g, "") + "”";
			});
			return suggestion.text.trim() + "\n\n依据：" + [...new Set(citations)].join("；");
		};
		const body = [replacements.length ? render(replacements[0]) : paragraph.text, ...suggestions.filter(s => s.kind !== "replace").map(render)].join("\n\n");
		text = text.slice(0, paragraph.start) + body + text.slice(paragraph.end);
	}
	if (protectedPrefix(text) !== protectedPrefix(context.target.text) || JSON.stringify(text.match(/^#{1,6}\s+.+$/gm)) !== JSON.stringify(context.target.text.match(/^#{1,6}\s+.+$/gm))) throw new Error("修改越过正文边界");
	return text;
}
/** Shared validation for writes and read-only excerpt history. */
export function validateCurationRevision(revision: CurationRevision, reviews: ReadonlyMap<string, CurationReview>, revisions: ReadonlyMap<string, CurationRevision>): CurationReview {
	if (revision.version !== 1 || !/^c-[a-f0-9-]{36}$/.test(revision.id) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(revision.created) || !Array.isArray(revision.suggestionIds)) throw new Error("修订标识无效");
	const review = reviews.get(revision.reviewId); if (!review || !Array.isArray(revision.writes) || revision.writes.length < 2 || revision.writes.length > 3) throw new Error("修订记录无法校验");
	const targetPath = review.context.target.path; const indexPath = indices[targetPath.split("/")[1] as keyof typeof indices];
	if (!curationTarget(targetPath) || revision.writes.filter(w => w.role === "target").length !== 1 || revision.writes.filter(w => w.role === "log").length !== 1 || new Set(revision.writes.map(w => w.path)).size !== revision.writes.length) throw new Error("修订目标无效");
	for (const write of revision.writes) {
		if (write.role === "target" ? write.path !== targetPath : write.role === "index" ? write.path !== indexPath : write.role === "log" ? write.path !== "wiki/log.md" : true) throw new Error("修订路径越界");
		if (typeof write.after !== "string" || write.after.length > 1000000 || contentHash(write.after) !== write.afterHash || (write.before === null ? write.beforeHash !== null : typeof write.before !== "string" || contentHash(write.before) !== write.beforeHash)) throw new Error("修订内容指纹错误");
		if (write.role !== "log" && write.before === null) throw new Error("本版仅修改已有正式笔记和索引");
	}
	const target = revision.writes.find(w => w.role === "target")!;
	const index = revision.writes.find(w => w.role === "index"); const log = revision.writes.find(w => w.role === "log")!;
	if (index && (revision.undoOf || index.after !== index.before!.trimEnd() + "\n\n- " + link(targetPath) + "\n")) throw new Error("索引修改与预览规则不一致");
	if (log.after !== (log.before || "# 知识库维护日志\n") + revisionLog(revision, review, !!index)) throw new Error("日志修改与预览规则不一致");
	if (!revision.undoOf) {
		const pending = structuredClone(review); pending.suggestions.forEach(s => { if (revision.suggestionIds.includes(s.id)) s.decision = "pending"; });
		if (target.before !== review.context.target.text || target.after !== curationNoteText(pending, revision.suggestionIds)) throw new Error("修订与已审阅建议不一致");
	} else {
		const record = revisions.get(revision.undoOf); const original = record?.writes.find(w => w.role === "target");
		if (!original || record?.state !== "applied" || record.undoOf || record.reviewId !== review.id || target.before !== original.after || target.after !== original.before) throw new Error("撤销记录不匹配");
	}
	return review;
}
export class CurationWriter {
	constructor(private service: CurationService) {}
	private async read(path: string): Promise<string | null> { const file = this.service.app.vault.getFileByPath(path); return file ? this.service.app.vault.cachedRead(file) : null; }
	private write(path: string, before: string | null, after: string, role: RevisionWrite["role"]): RevisionWrite { return { path, before, after, beforeHash: before === null ? null : contentHash(before), afterHash: contentHash(after), role }; }
	async preview(reviewId: string, selectedIds: string[], revisionId = "c-" + randomUUID(), created = new Date().toISOString(), signal?: AbortSignal): Promise<CurationRevision> {
		await this.service.ready(); const review = this.service.reviews.get(reviewId);
		if (!review || review.state !== "ready") throw new Error("建议已过期或尚未准备好");
		if ([...this.service.revisions.values()].some(r => r.reviewId === reviewId && r.suggestionIds.some(id => selectedIds.includes(id)))) throw new Error("这些建议已有修订记录，请从记录查看或恢复，避免重复应用");
		await this.service.verify(review.context, review.context.target.hash, signal);
		const target = review.context.target; const after = curationNoteText(review, selectedIds); const writes = [this.write(target.path, target.text, after, "target")];
		const indexPath = indices[target.path.split("/")[1] as keyof typeof indices]; const indexText = await this.read(indexPath);
		const stem = target.path.slice(0, -3); const basename = stem.split("/").slice(-1)[0];
		if (indexText !== null && !["[[" + stem + "]]", "[[" + stem + "|", "[[" + stem + "#", "[[" + basename + "]]", "[[" + basename + "|"] .some(value => indexText.includes(value))) writes.push(this.write(indexPath, indexText, indexText.trimEnd() + "\n\n- " + link(target.path) + "\n", "index"));
		const log = await this.read("wiki/log.md"); const line = revisionLog({ id: revisionId, created, suggestionIds: selectedIds }, review, writes.some(w => w.role === "index"));
		writes.push(this.write("wiki/log.md", log, (log || "# 知识库维护日志\n") + line, "log"));
		signal?.throwIfAborted(); return { version: 1, id: revisionId, reviewId, suggestionIds: [...selectedIds], created, updated: created, state: "prepared", writes, error: "" };
	}
	apply(preview: CurationRevision, signal?: AbortSignal): Promise<CurationRevision> {
		preview = structuredClone(preview);
		return this.service.serial(async () => {
			signal?.throwIfAborted(); const prior = this.service.revisions.get(preview.id); if (prior) return prior.state === "applied" ? this.finish(prior) : this.execute(prior, signal);
			const rebuilt = await this.preview(preview.reviewId, preview.suggestionIds, preview.id, preview.created, signal);
			if (JSON.stringify(rebuilt.writes) !== JSON.stringify(preview.writes)) throw new Error("预览后笔记、索引或日志已变化，请刷新修改预览");
			signal?.throwIfAborted(); await this.service.saveRevision(rebuilt); return this.execute(rebuilt, signal);
		});
	}
	resume(id: string): Promise<CurationRevision> { return this.service.serial(async () => { await this.service.ready(); const revision = this.service.revisions.get(id); if (!revision) throw new Error("修订记录不存在"); return revision.state === "applied" ? this.finish(revision) : this.execute(revision); }); }
	private validate(revision: CurationRevision): CurationReview { return validateCurationRevision(revision, this.service.reviews, this.service.revisions); }
	private async finish(revision: CurationRevision): Promise<CurationRevision> {
		const review = this.validate(revision);
		if (!revision.undoOf && revision.suggestionIds.some(id => review.suggestions.find(s => s.id === id)?.decision !== "applied")) {
			const updated = structuredClone(review); updated.suggestions.forEach(s => { if (revision.suggestionIds.includes(s.id)) s.decision = "applied"; });
			if (updated.suggestions.some(s => s.decision === "pending" && s.applicable)) { updated.state = "stale"; updated.error = "选中修改已应用，其余建议需要基于新版本重新准备"; }
			updated.updated = revision.updated; await this.service.save(updated);
		}
		return revision;
	}
	private async execute(stored: CurationRevision, signal?: AbortSignal): Promise<CurationRevision> {
		const revision = structuredClone(stored); const review = this.validate(revision); const target = revision.writes.find(w => w.role === "target")!;
		try {
			signal?.throwIfAborted();
			const current = await this.read(target.path);
			if (current === null || ![target.beforeHash, target.afterHash].includes(contentHash(current))) throw new Error("目标笔记已有后续编辑，无法直接应用或恢复");
			if (!revision.undoOf) await this.service.verify(review.context, contentHash(current), signal);
			// Preflight every file before the first write. Recovery accepts already-applied files only by exact hash.
			for (const write of revision.writes) { const text = await this.read(write.path); const hash = text === null ? null : contentHash(text); if (hash !== write.beforeHash && hash !== write.afterHash) throw new Error("文件已变化，需要重新核对：" + write.path); }
			revision.state = "applying"; revision.updated = new Date().toISOString(); await this.service.saveRevision(revision);
			for (const write of revision.writes) {
				signal?.throwIfAborted();
				if (!revision.undoOf && (review.context.excerpt || review.context.answerExcerpt)) {
					const currentTarget = await this.read(target.path); if (currentTarget === null || ![target.beforeHash, target.afterHash].includes(contentHash(currentTarget))) throw new Error("目标笔记已有后续编辑，停止剩余写入");
					await this.service.verify(review.context, contentHash(currentTarget), signal);
				}
				if (!revision.undoOf && review.context.source.kind === "structured") {
					const currentTarget = await this.read(target.path), currentHash = currentTarget === null ? null : contentHash(currentTarget);
					if (!currentHash || ![target.beforeHash, target.afterHash].includes(currentHash)) throw new Error("目标笔记已有后续编辑，停止剩余写入");
					await this.service.verify(review.context, currentHash);
				}
				const file = this.service.app.vault.getFileByPath(write.path);
				if (!file) { if (write.before !== null) throw new Error("待更新文件缺失"); await this.service.app.vault.create(write.path, write.after); }
				else await this.service.app.vault.process(file, text => { signal?.throwIfAborted(); if ((review.context.excerpt || review.context.answerExcerpt) && (file.path !== write.path || this.service.app.vault.getFileByPath(write.path) !== file)) throw new Error("写入前文件移动或替换：" + write.path); const hash = contentHash(text); if (hash === write.afterHash) return text; if (hash !== write.beforeHash) throw new Error("写入前文件已变化：" + write.path); return write.after; });
			}
			if (!revision.undoOf && review.context.source.kind === "structured") await this.service.verify(review.context, target.afterHash);
			if (!revision.undoOf && (review.context.excerpt || review.context.answerExcerpt)) await this.service.verify(review.context, target.afterHash, signal);
			revision.state = "applied"; revision.error = ""; revision.updated = new Date().toISOString(); await this.service.saveRevision(revision);
			return await this.finish(revision);
		} catch (error) {
			if (revision.state !== "applied") { revision.state = "recovery"; revision.error = error instanceof Error ? error.message : "应用中断"; revision.updated = new Date().toISOString(); await this.service.saveRevision(revision); }
			throw error;
		}
	}
	async previewUndo(id: string): Promise<CurationRevision> {
		await this.service.ready(); const original = this.service.revisions.get(id); if (!original || original.state !== "applied" || original.undoOf) throw new Error("请选择已完成的原修订");
		if ([...this.service.revisions.values()].some(r => r.undoOf === id)) throw new Error("已有撤销记录，请查看或恢复该记录");
		const target = original.writes.find(w => w.role === "target")!; if (await this.read(target.path) !== target.after) throw new Error("笔记已有后续编辑，请先在差异中核对，不能直接覆盖");
		const revisionId = "c-" + randomUUID(); const created = new Date().toISOString(); const log = await this.read("wiki/log.md");
		return { version: 1, id: revisionId, reviewId: original.reviewId, suggestionIds: [], created, updated: created, state: "prepared", error: "", undoOf: id,
			writes: [this.write(target.path, target.after, target.before!, "target"), this.write("wiki/log.md", log, (log || "# 知识库维护日志\n") + revisionLog({ id: revisionId, created, undoOf: id, suggestionIds: [] }, this.service.reviews.get(original.reviewId)!, false), "log")] };
	}
	applyUndo(preview: CurationRevision): Promise<CurationRevision> {
		return this.service.serial(async () => {
			const prior = this.service.revisions.get(preview.id); if (prior) return prior.state === "applied" ? prior : this.execute(prior);
			this.validate(preview); if (!preview.undoOf || [...this.service.revisions.values()].some(r => r.undoOf === preview.undoOf)) throw new Error("撤销记录无效或已经存在");
			await this.service.saveRevision(preview); return this.execute(preview);
		});
	}
}
