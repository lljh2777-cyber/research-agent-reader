import type { App } from "obsidian";
import { objectDigest } from "../papers/identity";
import { FileSourceStorage } from "../sources/storage";
import { bilingualPaths, isBilingualEntry, loadBilingualDocument, type BilingualBlock, type BilingualDocument, type BilingualLanguage } from "../reader/bilingual-document";
import type { AnnotationRecord } from "./types";

/** Reading provenance only: structural pairing does not establish translation quality. */
export interface BilingualReceipt {
	version: 1; language: BilingualLanguage; root: string;
	digests: { en: string; "zh-CN": string; metadata: string };
	status: string; humanReview: string; block: { id: string; start: number; end: number };
	selection: { start: number; end: number };
	english?: { start: number; end: number; text: string };
}
export const isTranslationPath = (path: string): boolean => /\.zh-CN\.md$/i.test(path);
export function quoteLabel(record: Pick<AnnotationRecord, "sourcePath" | "bilingual">): string {
	return record.bilingual?.language === "zh-CN" ? "中文译文摘录" : isTranslationPath(record.sourcePath) ? "译文摘录（配对未确认）" : record.bilingual ? "英文来源摘录" : "原文摘录";
}
export function bilingualDescription(r: BilingualReceipt): string {
	return `结构对应，语义仍需核对；译文状态 ${r.status}；人工审阅 ${r.humanReview}；英文版本 ${r.digests.en}；译文版本 ${r.digests["zh-CN"]}`;
}
export function bilingualReceipt(doc: BilingualDocument, language: BilingualLanguage, block: BilingualBlock, start: number, end: number): BilingualReceipt {
	const pair = doc.pairs.find(p => p[language].id === block.id), english = doc.syncAvailable && pair ? pair.en : undefined;
	return { version: 1, language, root: doc.root, digests: { en: doc.files.en.digest, "zh-CN": doc.files["zh-CN"].digest, metadata: doc.metadataDigest }, status: doc.status, humanReview: doc.humanReview,
		block: { id: block.id, start: block.start, end: block.end }, selection: { start, end },
		...(english && english.end - english.start <= 16000 ? { english: { start: english.start, end: english.end, text: doc.files.en.text.slice(english.start, english.end) } } : {}) };
}
export function validBilingualReceipt(value: unknown, path: string, anchor: AnnotationRecord["sourceAnchor"], selected: string): value is BilingualReceipt {
	if (!isBilingualEntry(path)) return false;
	const r = value as BilingualReceipt | undefined, paths = bilingualPaths(path);
	const range = (v: { start: number; end: number } | undefined): boolean => Boolean(v && Number.isSafeInteger(v.start) && Number.isSafeInteger(v.end) && v.start >= 0 && v.end > v.start && v.end <= 32 * 1024 * 1024);
	return Boolean(r && r.version === 1 && ["en", "zh-CN"].includes(r.language) && (r.language === "en" ? paths.en : paths.zh) === path && r.root === paths.root
		&& r.digests && [r.digests.en, r.digests["zh-CN"], r.digests.metadata].every(d => typeof d === "string" && /^[a-f0-9]{64}$/.test(d))
		&& ["not-started", "in-progress", "needs-review", "reviewed", "failed", "unknown"].includes(r.status) && ["reviewed", "not-reviewed", "unknown"].includes(r.humanReview)
		&& range(r.block) && /^b-\d+$/.test(r.block.id) && range(r.selection) && r.selection.end === r.selection.start + selected.length
		&& anchor && r.selection.start === anchor.start && r.selection.end === anchor.end && anchor.start >= r.block.start && anchor.end <= r.block.end
		&& (!r.english || range(r.english) && typeof r.english.text === "string" && r.english.text.length <= 16000 && r.english.end - r.english.start === r.english.text.length));
}
export function requiresBilingualProof(app: App, path: string): boolean {
	return isTranslationPath(path) || Boolean(isBilingualEntry(path) && app.vault.getAbstractFileByPath(bilingualPaths(path).metadata));
}
export async function readBilingual(app: App, path: string, signal?: AbortSignal): Promise<BilingualDocument> {
	const adapter = app.vault.adapter as { getBasePath?: () => string };
	if (!adapter?.getBasePath) throw new Error("双语来源核对需要桌面本地知识库");
	return loadBilingualDocument(new FileSourceStorage(adapter.getBasePath()), path, signal);
}
export async function verifyBilingual(app: App, record: Pick<AnnotationRecord, "sourcePath" | "selectedText" | "sourceAnchor" | "bilingual">, signal?: AbortSignal): Promise<BilingualDocument | undefined> {
	const r = record.bilingual;
	if (!r) { if (requiresBilingualProof(app, record.sourcePath)) throw new Error("双语配对凭据未确认，请重新划选；历史记录仍保留"); return; }
	if (!validBilingualReceipt(r, record.sourcePath, record.sourceAnchor, record.selectedText)) throw new Error("双语批注来源凭据无效");
	const doc = await readBilingual(app, record.sourcePath, signal), file = doc.files[r.language], block = file.blocks.find(b => b.id === r.block.id);
	if (!block || file.text.slice(r.selection.start, r.selection.end) !== record.selectedText || objectDigest(bilingualReceipt(doc, r.language, block, r.selection.start, r.selection.end)) !== objectDigest(r)) throw new Error("双语资料版本已变化；保留历史批注，请重新打开核对");
	return doc;
}

// The renderer owns these bindings. Source offsets never come from injected Markdown attributes.
export interface BilingualSelectionContext { document: BilingualDocument; language: BilingualLanguage; block: BilingualBlock; }
const contexts = new WeakMap<Element, (element: Element) => BilingualSelectionContext>();
export function bindBilingualSelection(root: Element, context: (element: Element) => BilingualSelectionContext): void { contexts.set(root, context); }
export function bilingualSelectionContext(element: Element): BilingualSelectionContext | undefined {
	for (let current: Element | null = element; current; current = current.parentElement) { const context = contexts.get(current); if (context) return context(element); }
	return undefined;
}
