import { parseYaml, type App } from "obsidian";
import { ExcerptLibraryService, type ExcerptRef } from "../annotations/excerpt-library";
import { excerptMatches, prepareExcerpt, supportsExcerpt } from "../annotations/excerpt";
import { contentHash } from "../retrieval/chunks";
import { objectDigest } from "../papers/identity";
import { noteIdentifiers } from "../papers/note-identity";
import { ReadingDocumentLoader } from "../reading/document";
import { structuredTargetCompatible } from "../reading/structured-reference";
import { readingPathCode } from "../reading/export";
import { curationParagraphs, curationTarget, protectedPrefix } from "./policy";
import type { CurationContext, CurationSuggestion } from "./types";

const RULE = "excerpt-curation-v1";
const meta = (text: string): Record<string, unknown> => parseYaml(protectedPrefix(text).replace(/^\uFEFF?---\r?\n|\r?\n---(?:\r?\n|$)/g, "")) || {};
const key = (c: CurationContext): string => objectDigest({ rule: RULE, input: c.excerpt, source: c.source, target: c.target });
const literal = (text: string): string => text.replace(/\\/g, "\\\\").replace(/([`*_{}\[\]()#+.!|~<>-])/g, "\\$1");
export function excerptAddition(context: CurationContext): string {
	const input = context.excerpt!, r = input.snapshot.record;
	const quote = (value: string) => value.split(/\r?\n/).map(line => "> " + literal(line)).join("\n");
	return (r.sourcePath.startsWith("Clippings/") ? "剪藏原句（外部资料）：" : "原文摘录（文字记录）：") + "\n\n" + quote(r.selectedText)
		+ "\n\n来源：" + readingPathCode(r.sourcePath) + "；字符 " + r.sourceAnchor!.start + "–" + r.sourceAnchor!.end
		+ "；文本版本 " + readingPathCode(r.excerpt!.digest) + "；摘录 " + readingPathCode(r.annotationPath)
		+ (input.includeManual ? "\n\n个人备注（用户记录，未作论文证据核验）：\n\n" + quote(r.manualText) : "");
}
export function excerptSuggestion(context: CurationContext): CurationSuggestion {
	return { id: "s-0", kind: "add", paragraphId: context.excerpt!.paragraphId, claim: "补充所选摘录", text: excerptAddition(context), reason: "用户选择的原句与可选个人备注；没有生成新结论。", citations: [], warnings: [], applicable: true, decision: "pending" };
}
/** Manual excerpts have a fixed renderer, never the model suggestion validator or an editable claim. */
export function validateExcerptContext(context: CurationContext): void {
	const input = context.excerpt, r = input?.snapshot?.record;
	if (!input || input.version !== 1 || !r || !r.excerpt || !r.sourceAnchor || !supportsExcerpt(r.sourcePath)
		|| !["markdown", "article", "structured"].includes(input.sourceMode) || typeof input.includeManual !== "boolean"
		|| typeof r.manualText !== "string" || r.manualText.length > 10000 || input.includeManual && !r.manualText.trim()
		|| !/^ann-excerpt-[a-f0-9]{48}$/.test(r.id) || r.annotationPath !== `wiki/annotations/${r.id}.md` || !/^[a-f0-9]{64}$/.test(input.snapshot.digest)
		|| context.ruleVersion !== RULE || context.sessionId !== "" || context.nodeIds.length !== 0 || context.learningHash !== input.snapshot.digest
		|| context.backendId !== "none" || context.model !== "" || context.prompt !== "" || context.evidence.length !== 0 || !context.sourceCompatible
		|| context.source.path !== r.sourcePath || context.source.kind !== (input.sourceMode === "markdown" ? "article" : input.sourceMode)
		|| !curationTarget(context.target.path) || contentHash(context.target.text) !== context.target.hash
		|| !curationParagraphs(context.target.text).some(p => p.id === input.paragraphId)
		|| objectDigest(context.target.paragraphs) !== objectDigest(curationParagraphs(context.target.text)) || context.key !== key(context)) throw new Error("摘录整理凭据无效，请重新选择摘录和目标");
}
export function validateExcerptSuggestion(raw: unknown, context: CurationContext, index: number): CurationSuggestion {
	validateExcerptContext(context); const expected = excerptSuggestion(context), value = raw as CurationSuggestion;
	if (index !== 0 || !value || objectDigest({ ...value, decision: "pending" }) !== objectDigest(expected)) throw new Error("摘录整理内容已变化，请从摘录重新准备");
	return expected;
}
export function excerptNoteText(context: CurationContext): string {
	validateExcerptContext(context); const paragraph = context.target.paragraphs.find(p => p.id === context.excerpt!.paragraphId)!;
	const text = context.target.text, eol = text.includes("\r\n") ? "\r\n" : "\n";
	return text.slice(0, paragraph.end) + eol + eol + excerptAddition(context).replace(/\n/g, eol) + text.slice(paragraph.end);
}
async function read(app: App, path: string, limit: number): Promise<string> {
	const file = app.vault.getFileByPath(path); if (!file || file.stat?.size > limit) throw new Error("文件缺失或超过读取上限：" + path);
	const text = await app.vault.read(file);
	if (text.length > limit || file.path !== path || app.vault.getFileByPath(path) !== file) throw new Error("读取期间文件移动或替换：" + path);
	return text;
}
async function source(app: App, sourcePath: string, signal?: AbortSignal): Promise<{ mode: NonNullable<CurationContext["excerpt"]>["sourceMode"]; source: CurationContext["source"]; text: string }> {
	if (!supportsExcerpt(sourcePath)) throw new Error("摘录来源不在支持范围");
	const text = await read(app, sourcePath, 32 * 1024 * 1024); signal?.throwIfAborted();
	if (/^papers\/[^/]+\/article\.md$/.test(sourcePath)) {
		const mode = app.vault.getAbstractFileByPath(sourcePath.replace(/article\.md$/, "_source/manifest.json")) ? "structured" : "article";
		const adapter = app.vault.adapter as { getBasePath?: () => string }; if (!adapter?.getBasePath) throw new Error("原文包核验需要桌面本地知识库");
		const document = await new ReadingDocumentLoader(app, adapter.getBasePath()).open(mode, sourcePath);
		try { signal?.throwIfAborted(); await document.verify(); if (await read(app, sourcePath, 32 * 1024 * 1024) !== text) throw new Error("核验期间原文变化"); return { mode, source: structuredClone(document.source), text }; }
		finally { await document.destroy(); }
	}
	if (sourcePath.startsWith("papers/") && sourcePath.split("/").length !== 2) throw new Error("包内摘录请从已验证的 article.md 开始");
	return { mode: "markdown", source: { kind: "article", path: sourcePath, fingerprint: contentHash(text), title: sourcePath.split("/").slice(-1)[0].slice(0, -3) }, text };
}
function compatible(context: CurationContext, sourceText: string, targetText: string): void {
	if (!context.target.path.startsWith("wiki/sources/")) return;
	const metadata = meta(targetText);
	if ([metadata.depth, metadata.reading_depth, metadata.status].includes("metadata-only")) throw new Error("目标仅有元数据，请先准备有依据的来源笔记");
	if (context.source.path.startsWith("Clippings/")) throw new Error("剪藏摘录可整理到概念、方法或综合笔记；不能据此补写论文来源笔记");
	if (context.source.kind === "structured") { if (!structuredTargetCompatible(context.source, context.target.path, metadata)) throw new Error("JATS 原文与目标论文或版本不一致"); return; }
	const sourceIds = noteIdentifiers(meta(sourceText)), targetIds = noteIdentifiers(metadata);
	const conflict = (["doi", "pmid", "pmcid"] as const).some(k => sourceIds[k] && targetIds[k] && sourceIds[k] !== targetIds[k]);
	const samePath = [metadata.source_path, metadata.article_path].includes(context.source.path);
	const packageKey = /^papers\/([^/]+)\/article\.md$/.exec(context.source.path)?.[1];
	if (conflict || !(samePath || packageKey && context.target.path === `wiki/sources/${packageKey}.md`)) throw new Error("目标论文与摘录来源无法准确匹配，请选择关联路径明确的笔记");
}
export async function prepareExcerptCuration(app: App, ref: ExcerptRef, targetPath: string, paragraphId: string, includeManual: boolean, signal?: AbortSignal): Promise<CurationContext> {
	const stable = { ...ref }; signal?.throwIfAborted(); if (!curationTarget(targetPath)) throw new Error("请选择已有的来源、概念、方法或综合笔记");
	const snapshot = await new ExcerptLibraryService(app).load(stable, signal), original = await source(app, snapshot.record.sourcePath, signal);
	const text = await read(app, targetPath, 160000); signal?.throwIfAborted();
	if (text.includes(readingPathCode(snapshot.record.annotationPath))) throw new Error("目标笔记已有这条摘录的来源记录，请先查看已有内容或修订历史，避免重复补充");
	const context: CurationContext = { excerpt: { version: 1, snapshot, paragraphId, includeManual, sourceMode: original.mode }, ruleVersion: RULE, key: "", sessionId: "", nodeIds: [], learningHash: snapshot.digest,
		title: "摘录 · " + snapshot.record.selectedText.slice(0, 100), source: original.source, target: { path: targetPath, title: String(meta(text).title || targetPath), text, hash: contentHash(text), paragraphs: curationParagraphs(text) },
		evidence: [], backendId: "none", backendName: "本地摘录", model: "", prompt: "", estimate: 0, sourceCompatible: true, warnings: ["仅保存原句与用户备注；未核验图像或升级科学阅读深度。"] };
	context.key = key(context); validateExcerptContext(context); compatible(context, original.text, text);
	await verifyExcerptCuration(app, context, context.target.hash, signal); return context;
}
export async function verifyExcerptCuration(app: App, context: CurationContext, targetHash: string, signal?: AbortSignal): Promise<void> {
	validateExcerptContext(context); signal?.throwIfAborted(); const input = context.excerpt!, r = input.snapshot.record;
	const current = await new ExcerptLibraryService(app).load(r, signal);
	if (current.digest !== input.snapshot.digest || objectDigest(current.record) !== objectDigest(r)) throw new Error("摘录或个人备注已变化，请重新准备预览");
	const original = await source(app, r.sourcePath, signal);
	if (original.mode !== input.sourceMode || objectDigest(original.source) !== objectDigest(context.source) || !excerptMatches(r, original.text)) throw new Error("原文版本已变化，请重新核对摘录");
	const anchor = r.sourceAnchor!, receipt = r.excerpt!;
	const prepared = prepareExcerpt({ sourcePath: r.sourcePath, selectedText: r.selectedText, sourceStart: anchor.start, sourceEnd: anchor.end, prefix: anchor.prefix, suffix: anchor.suffix, sourceRevision: { algorithm: receipt.algorithm, digest: receipt.digest, length: receipt.length }, section: "", context: "", isTableCell: false, anchorRect: {} as DOMRect }, original.text);
	if (prepared.id !== r.id) throw new Error("摘录 ID 与准确位置不一致");
	const target = await read(app, context.target.path, 1000000);
	if (contentHash(target) !== targetHash) throw new Error("目标笔记已变化，请重新预览");
	compatible(context, original.text, target); signal?.throwIfAborted();
}
