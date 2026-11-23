import { investigatePaper, type PaperTrace } from "../reading/paper-agent";
import type { ReadingEvidence } from "../reading/types";
import { supportsGptAnnotations, gptAnnotationRequest, type GptChoices } from "./gpt-options";
import { parseBilingualMarkdown } from "../reader/bilingual-document";
import { annotationEvidence, attachContextQuotes, contextSentences, quoteOffset } from "./argument-context";
import { isClipperPath, requireClipper } from "../library/clipper";
import {
	App,
	MarkdownView,
	Notice,
	TFile,
	normalizePath,
	type MarkdownPostProcessorContext,
} from "obsidian";

import type AgentDashboardPlugin from "../plugin";
import { generateDirectExplanation } from "./direct-explanation";
import { objectDigest } from "../papers/identity";
import { bilingualDescription, bilingualReceipt, bilingualSelectionContext, isTranslationPath, quoteLabel, readStandaloneBilingual, requiresBilingualProof, validBilingualReceipt, verifyBilingual } from "./bilingual";
import { isDetachedMarkdownSelection } from "./manual-source";
import { annotationDisplayText, captureMarkdownRange, expandMarkdownSelection, markdownNeedsDetached, validSelectionSize } from "./markdown-selection";
import { excerptMatches, excerptRevision, listedExcerpt, prepareExcerpt, supportsExcerpt, validExcerpt } from "./excerpt";
import { supportsPdfExcerpt, validPdfExcerpt, pdfExcerptId } from "./pdf-excerpt";
import { captureNativePdfSelection, hasNativePdfSelection, verifyPdfSelection, pdfExcerptStatus } from "./native-pdf-excerpt";
import { ANNOTATION_COLORS, annotationColor, isAnnotationColor } from "./colors";
import type {
	AnnotationDraft,
	AnnotationExplanation,
	AnnotationRecord,
	AnnotationSelection,
} from "./types";

const ANNOTATION_FOLDER = "wiki/annotations";
const BLOCK_START = "<!-- agent-dashboard:annotation-start ";
const BLOCK_END = "<!-- agent-dashboard:annotation-end ";
const META_PREFIX = "<!-- agent-dashboard:annotation-meta ";
const MANUAL_START = "<!-- agent-dashboard:manual-start -->";
const MANUAL_END = "<!-- agent-dashboard:manual-end -->";
const AI_START = "<!-- agent-dashboard:ai-start -->";
const AI_END = "<!-- agent-dashboard:ai-end -->";
const CONTEXT_LIMIT = 2600;
const MAX_SELECTION_LENGTH = 600;

function normalizeCliReceipt(value: unknown, allowSelection = true): AnnotationRecord["aiCli"] {
	if (!value || typeof value !== "object") return undefined;
	const receipt = value as Record<string, unknown>;
	if (typeof receipt.requestedModel !== "string" || !receipt.requestedModel.trim() || receipt.requestedModel.length > 200) return undefined;
	const usage: Record<string, number> = {};
	if (receipt.usage && typeof receipt.usage === "object") for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
		const v = (receipt.usage as Record<string, unknown>)[key];
		if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) usage[key] = v;
	}
	return { requestedModel: receipt.requestedModel,
		...(typeof receipt.reportedModel === "string" && receipt.reportedModel.length <= 200 ? { reportedModel: receipt.reportedModel } : {}),
		...(Object.keys(usage).length ? { usage } : {}),
		...(typeof receipt.costUsd === "number" && Number.isFinite(receipt.costUsd) && receipt.costUsd >= 0 ? { costUsd: receipt.costUsd } : {}),
		...(allowSelection && receipt.evidenceSelection ? { evidenceSelection: normalizeCliReceipt(receipt.evidenceSelection, false) } : {}),
	};
}

interface AnnotationMeta {
	paperTraces?: PaperTrace[];
	color?: AnnotationRecord["color"];
	aiCli?: AnnotationRecord["aiCli"];
	id: string;
	sourcePath: string;
	selectedText: string;
	section: string;
	sourceAnchor?: AnnotationRecord["sourceAnchor"];
	excerpt?: AnnotationRecord["excerpt"];
	excerptListed?: boolean;
	aiEdited?: boolean;
	pdfExcerpt?: AnnotationRecord["pdfExcerpt"];
	bilingual?: AnnotationRecord["bilingual"];
	aiProvider: string;
	aiModel: string;
	createdAt: string;
	updatedAt: string;
	archiveStatus: AnnotationRecord["archiveStatus"];
	archiveTargets: string[];
	archiveRunId: string;
	archiveError: string;
}

type ExplanationSelection = Pick<AnnotationSelection, "selectedText" | "section" | "context" | "sourcePath" | "bilingual"> & { sourceStart?: number };

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeEmbeddedText(value: unknown): string {
	return String(value || "")
		.split(BLOCK_START).join("")
		.split(BLOCK_END).join("")
		.split(META_PREFIX).join("")
		.split(MANUAL_START).join("")
		.split(MANUAL_END).join("")
		.split(AI_START).join("")
		.split(AI_END).join("")
		.trim();
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

export function usesDetachedAnnotations(sourcePath: string): boolean {
	return isTranslationPath(sourcePath) || /^(papers|Clippings)\//i.test(normalizePath(sourcePath));
}

function sourceReference(sourcePath: string): string {
	if (!usesDetachedAnnotations(sourcePath)) return `[[${sourcePath.replace(/\.md$/i, "")}]]`;
	const fence = "`".repeat(Math.max(0, ...(sourcePath.match(/`+/g) || []).map((run) => run.length)) + 1);
	return `${fence} ${sourcePath} ${fence}`;
}

function parseSourceAnchor(value: unknown): AnnotationRecord["sourceAnchor"] {
	if (!value || typeof value !== "object") return undefined;
	const anchor = value as Record<string, unknown>;
	if (!Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end)
		|| Number(anchor.start) < 0 || Number(anchor.end) <= Number(anchor.start)
		|| typeof anchor.prefix !== "string" || anchor.prefix.length > 80
		|| typeof anchor.suffix !== "string" || anchor.suffix.length > 80) return undefined;
	return { start: Number(anchor.start), end: Number(anchor.end), prefix: anchor.prefix, suffix: anchor.suffix };
}

function normalizeArchiveTarget(value: unknown): string {
	return String(value || "")
		.trim()
		.replace(/^\[\[/, "")
		.replace(/\]\]$/, "")
		.split("|", 1)[0]
		.replace(/\.md$/i, "")
		.replace(/^\/+/, "");
}

type ArchiveUpdate = Partial<Pick<AnnotationRecord, "archiveStatus" | "archiveTargets" | "archiveRunId" | "archiveError">>;

const archiveStatusLabels = { none: "未归档", pending: "归档中", completed: "已归档", failed: "归档失败" };

function archiveTargetLinks(targets: string[]): string {
	return targets.map(target => `[[${normalizeArchiveTarget(target)}]]`).join("、") || "无";
}

function patchArchiveMetadata(json: string, updates: ArchiveUpdate): string {
	const replacements = new Map(Object.entries(updates).map(([key, value]) =>
		[key, JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")] as const));
	const missing = new Set(replacements.keys());
	const members: string[] = [];
	let depth = 0, start = 1;
	// Split only at top-level delimiters so other JSON values keep their original spelling.
	for (const match of json.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],]/g)) {
		const token = match[0], at = match.index!;
		if (depth === 1 && (token === "," || token === "}")) {
			const member = json.slice(start, at);
			const prefix = /^(\s*("(?:\\.|[^"\\])*")\s*:\s*)/.exec(member)!;
			const key = JSON.parse(prefix[2]) as string;
			const replacement = replacements.get(key);
			members.push(replacement === undefined ? member : prefix[1] + replacement + member.slice(member.trimEnd().length));
			missing.delete(key);
			start = at + 1;
		}
		if (token === "{" || token === "[") depth++;
		if (token === "}" || token === "]") depth--;
	}
	for (const key of missing) members.push(JSON.stringify(key) + ":" + replacements.get(key));
	return "{" + members.join(",") + "}";
}

function patchArchiveDisplay(block: string, latest: AnnotationRecord, updates: ArchiveUpdate): string {
	const afterBody = block.indexOf(AI_END) + AI_END.length;
	const heading = /^### 归档[ \t]*(\r?\n)/m.exec(block.slice(afterBody));
	if (!heading) throw new Error("找不到批注归档分区，未写入");
	const start = afterBody + heading.index + heading[0].length, eol = heading[1];
	let tail = block.slice(start);
	const endOfSection = new RegExp("^#{1,3}[ \\t]|^\\^" + escapeRegExp(latest.id) + "\\r?$|^<!-- agent-dashboard:annotation-end ", "m");
	const patchField = (pattern: RegExp, replace: (line: string) => string, previous?: string) => {
		const end = tail.search(endOfSection);
		const matches = Array.from(tail.matchAll(pattern)).filter(match => match.index! < end);
		const candidates = matches.length > 1 ? matches.filter(match => match[0] === previous) : matches;
		if (candidates.length !== 1) throw new Error("无法定位批注归档字段，未写入");
		const match = candidates[0], at = match.index!;
		tail = tail.slice(0, at) + replace(match[0]) + tail.slice(at + match[0].length);
	};
	if (updates.archiveStatus !== undefined) {
		const status = "- 状态：" + archiveStatusLabels[updates.archiveStatus];
		patchField(/^- 状态：[^\r\n]*/gm, () => status, "- 状态：" + archiveStatusLabels[latest.archiveStatus]);
	}
	const message = updates.archiveError?.replace(/\r?\n/g, eol);
	const addError = message && !latest.archiveError;
	if (updates.archiveTargets !== undefined || addError) {
		const targets = updates.archiveTargets && "- 知识节点：" + archiveTargetLinks(updates.archiveTargets);
		patchField(/^- 知识节点：[^\r\n]*/gm, line => (targets ?? line) + (addError ? eol + "- 说明：" + message : ""),
			"- 知识节点：" + archiveTargetLinks(latest.archiveTargets));
	}
	if (latest.archiveError && message !== undefined && updates.archiveError !== latest.archiveError) {
		const old = latest.archiveError.split(/\r?\n/).map(escapeRegExp).join("\\r?\\n");
		patchField(new RegExp("^- 说明：" + old + "\\r?\\n", "gm"),
			line => message ? "- 说明：" + message + (line.endsWith("\r\n") ? "\r\n" : "\n") : "");
	}
	return block.slice(0, start) + tail;
}

function countOccurrences(content: string, value: string): number[] {
	const offsets: number[] = [];
	let cursor = 0;
	while (cursor <= content.length - value.length) {
		const index = content.indexOf(value, cursor);
		if (index === -1) break;
		offsets.push(index);
		cursor = index + Math.max(1, value.length);
	}
	return offsets;
}

export function findSourceAnchorOffset(content: string, text: string, anchor: NonNullable<AnnotationRecord["sourceAnchor"]>): number | null {
	const matches = (offset: number): boolean => content.slice(offset, offset + text.length) === text
		&& content.slice(Math.max(0, offset - anchor.prefix.length), offset) === anchor.prefix
		&& content.slice(offset + text.length, offset + text.length + anchor.suffix.length) === anchor.suffix;
	if (anchor.end === anchor.start + text.length && matches(anchor.start)) return anchor.start;
	const offsets = countOccurrences(content, text).filter(matches);
	return offsets.length === 1 ? offsets[0] : null;
}

function commonSuffixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let count = 0;
	while (
		count < limit
		&& left.charCodeAt(left.length - count - 1) === right.charCodeAt(right.length - count - 1)
	) {
		count += 1;
	}
	return count;
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let count = 0;
	while (count < limit && left.charCodeAt(count) === right.charCodeAt(count)) count += 1;
	return count;
}

function lineOffset(content: string, line: number): number {
	if (line <= 0) return 0;
	let cursor = 0;
	let currentLine = 0;
	while (currentLine < line && cursor < content.length) {
		const next = content.indexOf("\n", cursor);
		if (next === -1) return content.length;
		cursor = next + 1;
		currentLine += 1;
	}
	return cursor;
}

function currentHeading(content: string, offset: number): string {
	const lines = content.slice(0, offset).split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
		if (match) return match[2].replace(/\s+#+\s*$/, "").trim();
	}
	return "";
}

function isInsideProtectedMarkdown(content: string, start: number, end: number): boolean {
	const lineStart = content.lastIndexOf("\n", start - 1) + 1;
	const nextBreak = content.indexOf("\n", end);
	const lineEnd = nextBreak === -1 ? content.length : nextBreak;
	const line = content.slice(lineStart, lineEnd);
	const relativeStart = start - lineStart;
	const relativeEnd = end - lineStart;
	const protectedPatterns = [
		/\[\[[^\]]+\]\]/g,
		/\[[^\]]+\]\([^)]+\)/g,
		/`[^`]+`/g,
	];
	return protectedPatterns.some((pattern) => {
		for (const match of line.matchAll(pattern)) {
			const matchStart = match.index || 0;
			const matchEnd = matchStart + match[0].length;
			if (relativeStart < matchEnd && relativeEnd > matchStart) return true;
		}
		return false;
	});
}

function parseMeta(raw: string): AnnotationMeta | null {
	const match = new RegExp(`${escapeRegExp(META_PREFIX)}(\\{[^\\r\\n]*\\}) -->`).exec(raw);
	if (!match) return null;
	try {
		const value = JSON.parse(match[1]) as Partial<AnnotationMeta>;
		const sourceAnchor = parseSourceAnchor(value.sourceAnchor);
		if (value.color !== undefined && !isAnnotationColor(value.color)) return null;
		if (value.bilingual !== undefined && (value.pdfExcerpt || !validBilingualReceipt(value.bilingual, String(value.sourcePath || ""), sourceAnchor, String(value.selectedText || "")))) return null;
		if (value.pdfExcerpt !== undefined && (value.excerpt !== undefined || !supportsPdfExcerpt(String(value.sourcePath || ""))
			|| !validPdfExcerpt(value.pdfExcerpt, sourceAnchor, String(value.selectedText || ""))
			|| value.id !== pdfExcerptId(String(value.sourcePath), value.pdfExcerpt, sourceAnchor!.start, sourceAnchor!.end))) return null;
		if (value.excerpt !== undefined && (!supportsExcerpt(String(value.sourcePath || "")) || !validExcerpt(value.excerpt, sourceAnchor, String(value.selectedText || "")))) return null;
		const status = String(value.archiveStatus || "none");
		return {
			id: String(value.id || ""),
			...(value.color ? { color: value.color } : {}),
			sourcePath: String(value.sourcePath || ""),
			selectedText: String(value.selectedText || ""),
			section: String(value.section || ""),
			sourceAnchor,
			...(value.excerpt ? { excerpt: value.excerpt } : {}),
			...(typeof value.excerptListed === "boolean" ? { excerptListed: value.excerptListed } : {}),
			...(value.aiEdited === true ? { aiEdited: true } : {}),
			...(value.pdfExcerpt ? { pdfExcerpt: value.pdfExcerpt } : {}),
			...(value.bilingual ? { bilingual: value.bilingual } : {}),
			aiProvider: String(value.aiProvider || ""),
			aiModel: String(value.aiModel || ""),
			...(Array.isArray(value.paperTraces) ? {paperTraces:value.paperTraces} : {}),
			...(value.aiCli ? { aiCli: normalizeCliReceipt(value.aiCli) } : {}),
			createdAt: String(value.createdAt || ""),
			updatedAt: String(value.updatedAt || ""),
			archiveStatus: status === "pending" || status === "completed" || status === "failed"
				? status
				: "none",
			archiveTargets: Array.isArray(value.archiveTargets)
				? value.archiveTargets.map(normalizeArchiveTarget).filter(Boolean)
				: [],
			archiveRunId: String(value.archiveRunId || ""),
			archiveError: String(value.archiveError || ""),
		};
	} catch {
		return null;
	}
}

function readMarkedSection(raw: string, start: string, end: string): string {
	const startIndex = raw.indexOf(start);
	if (startIndex === -1) return "";
	const contentStart = startIndex + start.length;
	const endIndex = raw.indexOf(end, contentStart);
	if (endIndex === -1) return "";
	return raw.slice(contentStart, endIndex).trim();
}

/** Read existing annotation blocks without invoking any view, model, relocation or writer. */
export function readAnnotationRecords(content: string, annotationPath: string): { records: AnnotationRecord[]; errors: string[] } {
	const records: AnnotationRecord[] = [], errors: string[] = [], seen = new Set<string>(), duplicates = new Set<string>();
	const parts = content.split(BLOCK_START).slice(1);
	if (parts.length > 2000) throw new Error("单文件批注超过读取上限");
	for (const part of parts) {
		const opening = /^([A-Za-z0-9_-]{1,200}) -->/.exec(part), raw = BLOCK_START + part;
		if (!opening) { errors.push("批注起始标记无效"); continue; }
		const id = opening[1], end = `${BLOCK_END}${id} -->`, endAt = raw.indexOf(end);
		if (seen.has(id)) { duplicates.add(id); errors.push("重复批注 ID，所有同名记录均待核对：" + id); continue; }
		seen.add(id);
		const block = endAt >= 0 ? raw.slice(0, endAt + end.length) : "", meta = parseMeta(block);
		if (!meta || meta.id !== id || !meta.sourcePath || !meta.selectedText) { errors.push("批注标记、元数据或 ID 不一致：" + id); continue; }
		if ([[MANUAL_START, MANUAL_END], [AI_START, AI_END]].some(([start, end]) => {
			const at = block.indexOf(start), until = block.indexOf(end);
			return (at < 0) !== (until < 0) || at >= 0 && until < at;
		})) { errors.push("批注内容分区未闭合：" + id); continue; }
		records.push({ ...meta, annotationPath, manualText: readMarkedSection(block, MANUAL_START, MANUAL_END), aiText: readMarkedSection(block, AI_START, AI_END) });
	}
	if (!parts.length && content.trim()) errors.push("未发现可识别的批注记录，文件已保留");
	return { records: records.filter(record => !duplicates.has(record.id)), errors };
}

export class AnnotationService {
	private readonly explanations = new Set<AbortController>();
	constructor(
		private readonly app: App,
		private readonly plugin: AgentDashboardPlugin,
	) {}

	async dispose(): Promise<void> {
		for (const controller of this.explanations) controller.abort(new Error("批注解释已取消"));
	}

	private async selectionProvenance(path: string, content: string, start: number, end: number, captured?: ReturnType<typeof bilingualSelectionContext>): Promise<Pick<AnnotationSelection, "bilingual">> {
		const doc = captured?.document || await readStandaloneBilingual(this.app, path);
		if (!doc) return {};
		const language = captured?.language || (path === doc.files.en.path ? "en" : "zh-CN");
		const file = doc.files[language], block = captured?.block || file.blocks.find(b => start >= b.start && end <= b.end);
		if (file.path !== path || file.text !== content || !block || start < block.start || end > block.end) {
			if (!captured) return {};
			throw new Error("选区与双语资料版本或段落不一致，请重新打开划选");
		}
		return { bilingual: bilingualReceipt(doc, language, block, start, end) };
	}
	private requireExplanationProof(source: Pick<AnnotationSelection, "sourcePath" | "bilingual">): void {
		if (!source.bilingual && requiresBilingualProof(this.app, source.sourcePath)) {
			throw new Error("对应英文段落未确认。可保存手动批注、颜色和摘录；请核对双语配对后重新划选以使用 AI 对照解释");
		}
	}

	openModelSettings(): void { this.plugin.openModelSettings("annotations"); }

	private async sourceText(path: string): Promise<string> {
		if (isClipperPath(path)) return requireClipper(this.app).text(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error("批注来源不存在");
		return this.app.vault.read(file);
	}

	private async verifySelection(selection: AnnotationSelection, signal?: AbortSignal): Promise<void> {
		await verifyBilingual(this.app, { ...selection, sourceAnchor: { start: selection.sourceStart, end: selection.sourceEnd, prefix: selection.prefix, suffix: selection.suffix } }, signal);
	}

	decorateMarkdownSection(
		element: HTMLElement,
		context: MarkdownPostProcessorContext,
	): void {
		if (!context.sourcePath || context.sourcePath.startsWith(`${ANNOTATION_FOLDER}/`)) return;
		const info = context.getSectionInfo(element);
		element.dataset.agentAnnotationSource = context.sourcePath;
		if (info) {
			element.dataset.agentAnnotationLineStart = String(info.lineStart);
			element.dataset.agentAnnotationLineEnd = String(info.lineEnd);
		}
	}

	canCaptureSelection(): boolean {
		if (hasNativePdfSelection(this.app)) return true;
		if (this.canCaptureDomSelection()) return true;
		return this.canCaptureEditorSelection();
	}

	canCaptureDomSelection(): boolean {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
		const range = selection.getRangeAt(0);
		const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? range.commonAncestorContainer as HTMLElement
			: range.commonAncestorContainer.parentElement;
		if (!element) return false;
		if (!element.closest(".markdown-reading-view, .markdown-preview-view")) return false;
		if (element.closest("input, textarea, button, pre, code, .agent-annotation-popover")) return false;
		const source = element.closest<HTMLElement>("[data-agent-annotation-source]");
		return Boolean(source?.dataset.agentAnnotationSource);
	}

	/**
	 * Live Preview / source mode renders plain text through CodeMirror, so the
	 * post-processor stamps and DOM selections do not exist there. Editor
	 * selections are captured through the Editor API instead.
	 */
	canCaptureEditorSelection(): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return false;
		if (view.file.path.startsWith(`${ANNOTATION_FOLDER}/`)) return false;
		const editor = view.editor;
		if (!editor || typeof editor.getSelection !== "function") return false;
		return String(editor.getSelection() || "").trim().length > 0;
	}

	async captureSelection(): Promise<AnnotationSelection> {
		if (hasNativePdfSelection(this.app)) return captureNativePdfSelection(this.app);
		if (this.canCaptureDomSelection()) return this.captureFromDom();
		return this.captureFromEditor();
	}

	private async captureFromDom(): Promise<AnnotationSelection> {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
			throw new Error("请先在笔记或阅读视图中选择需要批注的文字");
		}
		const range = selection.getRangeAt(0);
		if (!selection.toString().trim()) throw new Error("选区中没有可批注的文字");
		const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? range.commonAncestorContainer as HTMLElement
			: range.commonAncestorContainer.parentElement;
		if (!element || !element.closest(".markdown-reading-view, .markdown-preview-view")) {
			throw new Error("第一版只支持 Markdown 阅读视图中的文字选区");
		}
		const block = element.closest<HTMLElement>("p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6");
		const endpointBlock = (node: Node): Element | null => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest("p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6") || null;
		if (!block || !block.contains(range.startContainer) || !block.contains(range.endContainer)) {
			throw new Error("第一版只支持同一段落或标题内的选区");
		}
		if (endpointBlock(range.startContainer) !== endpointBlock(range.endContainer)) throw new Error("请在同一段落或标题内划选，暂不支持跨段批注");
		const sectionElement = element.closest<HTMLElement>("[data-agent-annotation-source]");
		const bilingual = bilingualSelectionContext(element);
		const sourcePath = bilingual ? bilingual.document.files[bilingual.language].path : String(sectionElement?.dataset.agentAnnotationSource || "");
		const content = await this.sourceText(sourcePath);
		if (bilingual && content !== bilingual.document.files[bilingual.language].text) throw new Error("双语资料已变化，请重新打开划选");
		const lineStart = Number.parseInt(
			String(sectionElement?.dataset.agentAnnotationLineStart || "0"),
			10,
		);
		const lineEnd = Number.parseInt(
			String(sectionElement?.dataset.agentAnnotationLineEnd || ""),
			10,
		);
		const segmentStart = bilingual ? bilingual.block.start : lineOffset(content, Number.isFinite(lineStart) ? lineStart : 0);
		const segmentEnd = bilingual ? bilingual.block.end : Number.isFinite(lineEnd)
			? lineOffset(content, lineEnd + 1)
			: content.length;
		const mapped = captureMarkdownRange(block, range, content, segmentStart, segmentEnd);
		const sourceStart = mapped.start, sourceEnd = mapped.end, selectedText = content.slice(sourceStart, sourceEnd);
		if (!validSelectionSize(selectedText)) throw new Error(`单次最多批注 ${MAX_SELECTION_LENGTH} 个可见字符，含链接源码最多 2400 个字符`);
		if (selectedText.includes("<!-- agent-dashboard:")) throw new Error("选区包含批注控制标记，请重新划选");
		const contextStart = Math.max(0, sourceStart - Math.floor(CONTEXT_LIMIT / 2));
		const contextEnd = Math.min(content.length, sourceEnd + Math.floor(CONTEXT_LIMIT / 2));
		return {
			sourcePath,
			...(await this.selectionProvenance(sourcePath, content, sourceStart, sourceEnd, bilingual)),
			...(isDetachedMarkdownSelection(element) || markdownNeedsDetached(selectedText) ? { detached: true } : {}),
			...(mapped.expanded ? { linkSelectionExpanded: true } : {}),
			...(supportsExcerpt(sourcePath) ? { sourceRevision: excerptRevision(content) } : {}),
			selectedText,
			section: currentHeading(content, sourceStart),
			context: content.slice(contextStart, contextEnd).trim(),
			sourceStart,
			sourceEnd,
			prefix: content.slice(Math.max(0, sourceStart - 80), sourceStart),
			suffix: content.slice(sourceEnd, sourceEnd + 80),
			isTableCell: block.matches("td, th"),
			anchorRect: range.getBoundingClientRect(),
		};
	}

	private async captureFromEditor(): Promise<AnnotationSelection> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.file.extension !== "md") {
			throw new Error("无法确定选区对应的 Markdown 文件");
		}
		if (view.file.path.startsWith(`${ANNOTATION_FOLDER}/`)) {
			throw new Error("批注文档本身不能再批注");
		}
		const editor = view.editor;
		if (!editor || typeof editor.getSelection !== "function") {
			throw new Error("第一版只支持 Markdown 阅读视图或编辑器中的文字选区");
		}
		const ranges = editor.listSelections();
		if (!ranges.length) throw new Error("请先在笔记中选择需要批注的文字");
		const raw = String(editor.getSelection() || "");
		let selectedText = raw.trim();
		if (!selectedText) throw new Error("选区中没有可批注的文字");
		if (/[\r\n]/.test(raw)) throw new Error("请在同一段落的单行源码内划选；跨源码行请使用阅读视图");
		const content = await this.app.vault.read(view.file);
		const offsetHead = editor.posToOffset(ranges[0].head);
		const offsetAnchor = editor.posToOffset(ranges[0].anchor);
		// The editor may use LF offsets for a file whose source uses CRLF.
		const usesCRLF = content.includes("\r\n");
		const sourceHead = usesCRLF ? lineOffset(content, ranges[0].head.line) + ranges[0].head.ch : offsetHead;
		const sourceAnchor = usesCRLF ? lineOffset(content, ranges[0].anchor.line) + ranges[0].anchor.ch : offsetAnchor;
		let sourceStart = Math.min(sourceHead, sourceAnchor);
		let sourceEnd = Math.max(sourceHead, sourceAnchor);
		if (
			!Number.isFinite(sourceStart)
			|| !Number.isFinite(sourceEnd)
			|| content.slice(sourceStart, sourceEnd) !== raw
		) {
			throw new Error("选中文字与原文不一致，请重新划选后重试");
		}
		sourceStart += raw.length - raw.trimStart().length;
		sourceEnd -= raw.length - raw.trimEnd().length;
		const expanded = expandMarkdownSelection(content, sourceStart, sourceEnd), linkSelectionExpanded = expanded.start !== sourceStart || expanded.end !== sourceEnd;
		sourceStart = expanded.start; sourceEnd = expanded.end; selectedText = content.slice(sourceStart, sourceEnd);
		if (!validSelectionSize(selectedText)) throw new Error(`单次最多批注 ${MAX_SELECTION_LENGTH} 个可见字符，含链接源码最多 2400 个字符`);
		if (selectedText.includes("<!-- agent-dashboard:")) throw new Error("选区包含批注控制标记，请重新划选");
		const contextStart = Math.max(0, sourceStart - Math.floor(CONTEXT_LIMIT / 2));
		const contextEnd = Math.min(content.length, sourceEnd + Math.floor(CONTEXT_LIMIT / 2));
		const lineStart = content.lastIndexOf("\n", Math.max(0, sourceStart - 1)) + 1;
		const lineEndIndex = content.indexOf("\n", sourceEnd);
		const line = content.slice(lineStart, lineEndIndex === -1 ? undefined : lineEndIndex);
		const isTableCell = (line.match(/\|/g)?.length ?? 0) >= 2;
		const headFirst = offsetHead >= offsetAnchor;
		// Obsidian's Editor typings do not expose CM6 coordinates; access the
		// underlying view structurally so the popover can anchor the selection.
		const cmView = (
			editor as unknown as {
				cm?: {
					coordsAtPos?: (offset: number) => {
						left: number;
						right: number;
						top: number;
						bottom: number;
					} | null;
				};
			}
		).cm;
		const coords = typeof cmView?.coordsAtPos === "function"
			? cmView.coordsAtPos(headFirst ? offsetHead : offsetAnchor)
			: null;
		const anchorRect = coords
			? new DOMRect(
				coords.left,
				coords.top,
				Math.max(1, (coords.right ?? coords.left) - coords.left),
				Math.max(1, (coords.bottom ?? coords.top) - coords.top),
			)
			: new DOMRect(0, 0, 1, 1);
		return {
			sourcePath: view.file.path,
			...(markdownNeedsDetached(selectedText) ? { detached: true } : {}),
			...(linkSelectionExpanded ? { linkSelectionExpanded: true } : {}),
			...(await this.selectionProvenance(view.file.path, content, sourceStart, sourceEnd)),
			...(supportsExcerpt(view.file.path) ? { sourceRevision: excerptRevision(content) } : {}),
			selectedText,
			section: currentHeading(content, sourceStart),
			context: content.slice(contextStart, contextEnd).trim(),
			sourceStart,
			sourceEnd,
			prefix: content.slice(Math.max(0, sourceStart - 80), sourceStart),
			suffix: content.slice(sourceEnd, sourceEnd + 80),
			isTableCell,
			anchorRect,
		};
	}

	/** Create-only excerpt, scoped by exact text revision and occurrence. No source edits or model dependency. */
	async createExcerpt(selection: AnnotationSelection, manualText = "", signal?: AbortSignal): Promise<AnnotationRecord> {
		selection = { ...selection, sourceRevision: selection.sourceRevision && { ...selection.sourceRevision }, pdfExcerpt: selection.pdfExcerpt && { ...selection.pdfExcerpt }, bilingual: selection.bilingual && structuredClone(selection.bilingual) };
		if (manualText.length > 10000 || manualText.includes("<!-- agent-dashboard:")) throw new Error("个人备注过长或包含批注控制标记，未保存");
		signal?.throwIfAborted();
		const source = this.app.vault.getAbstractFileByPath(selection.sourcePath);
		if ((!isClipperPath(selection.sourcePath) || selection.pdfExcerpt) && (!(source instanceof TFile) || (selection.pdfExcerpt ? source.extension.toLowerCase() !== "pdf" : source.extension !== "md"))) throw new Error("摘录原文不存在");
		const content = selection.pdfExcerpt ? "" : await this.sourceText(selection.sourcePath);
		if (!selection.pdfExcerpt) await this.verifySelection(selection, signal);
		const prepared = selection.pdfExcerpt ? await verifyPdfSelection(this.app, selection, signal) : prepareExcerpt(selection, content);
		const annotationPath = `${ANNOTATION_FOLDER}/${prepared.id}.md`;
		const reuse = async (): Promise<AnnotationRecord | null> => {
			if (!this.app.vault.getAbstractFileByPath(annotationPath)) return null;
			const file = this.app.vault.getAbstractFileByPath(annotationPath);
			if (!(file instanceof TFile)) throw new Error("摘录目标已被其他内容占用");
			const parsed = readAnnotationRecords(await this.app.vault.read(file), annotationPath), record = parsed.records[0];
			if (parsed.errors.length || parsed.records.length !== 1 || record.id !== prepared.id || record.sourcePath !== selection.sourcePath
				|| record.selectedText !== selection.selectedText || record.sourceAnchor?.start !== selection.sourceStart || record.sourceAnchor?.end !== selection.sourceEnd
				|| objectDigest(record.pdfExcerpt || record.excerpt || null) !== objectDigest(prepared.receipt) || objectDigest(record.bilingual || null) !== objectDigest(selection.bilingual || null)) throw new Error("已有摘录凭据冲突，原文件保持不变");
			return record;
		};
		const existing = await reuse(); signal?.throwIfAborted(); if (existing) return existing;
		await this.ensureFolder(ANNOTATION_FOLDER); signal?.throwIfAborted();
		if (selection.pdfExcerpt) await verifyPdfSelection(this.app, selection, signal);
		else { prepareExcerpt(selection, await this.sourceText(selection.sourcePath)); await this.verifySelection(selection, signal); }
		signal?.throwIfAborted();
		if (!isClipperPath(selection.sourcePath) && (source?.path !== selection.sourcePath || this.app.vault.getAbstractFileByPath(selection.sourcePath) !== source)) throw new Error("原文在保存前已移动或替换，请重新选择");
		const now = new Date().toISOString(), record: AnnotationRecord = {
			id: prepared.id, annotationPath, sourcePath: selection.sourcePath, selectedText: selection.selectedText,
			section: selection.pdfExcerpt ? `PDF 第 ${selection.pdfExcerpt.page} 页（文件页码）` : currentHeading(content, selection.sourceStart), sourceAnchor: { start: selection.sourceStart, end: selection.sourceEnd, prefix: selection.prefix, suffix: selection.suffix },
			...(prepared.receipt.algorithm === "pdf-bytes-sha256" ? { pdfExcerpt: prepared.receipt } : { excerpt: prepared.receipt }),
			...(selection.bilingual ? { bilingual: selection.bilingual } : {}),
			manualText: manualText.trim(), aiText: "", aiProvider: "", aiModel: "", createdAt: now, updatedAt: now,
			archiveStatus: "none", archiveTargets: [], archiveRunId: "", archiveError: "",
		};
		try { await this.app.vault.create(annotationPath, this.renderNewDocument(record)); }
		catch (error) { const winner = await reuse(); if (winner) return winner; throw error; }
		// Confirm the complete written record; a committed write may survive a caller closing its view.
		const saved = await reuse(); if (!saved) throw new Error("摘录写入后无法确认，请重新选择同段文字重试"); return saved;
	}

	async getExcerptStatus(record: AnnotationRecord): Promise<string> {
		if (record.pdfExcerpt) return pdfExcerptStatus(this.app, record);
		try { await verifyBilingual(this.app, record); } catch (error) { return String(error instanceof Error ? error.message : error); }
		if (isClipperPath(record.sourcePath)) return excerptMatches(record, await this.sourceText(record.sourcePath)) ? "外部原文与保存版本一致" : "外部原文版本已变化，保留历史摘录";
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		if (!(file instanceof TFile)) return "原文已缺失；保留历史摘录，需复查";
		return excerptMatches(record, await this.app.vault.read(file)) ? "当前 Markdown 文本与保存时一致；未据此核验 PDF、图片或科学结论" : "原文版本已变化；保留历史摘录，需复查";
	}

	async createAnnotation(
		selection: AnnotationSelection,
		draft: AnnotationDraft,
	): Promise<AnnotationRecord> {
		if (selection.pdfExcerpt) throw new Error("PDF 选区请使用保存摘录");
		selection = { ...selection, bilingual: selection.bilingual && structuredClone(selection.bilingual) };
		if (draft.aiText?.trim()) this.requireExplanationProof(selection);
		await this.verifySelection(selection);
		const sourceFile = this.app.vault.getAbstractFileByPath(selection.sourcePath);
		if (!(sourceFile instanceof TFile)) throw new Error("原始 Markdown 文件不存在");
		const color = annotationColor(draft.color);
		const detached = !!color || usesDetachedAnnotations(sourceFile.path) || !!selection.bilingual || selection.detached === true || markdownNeedsDetached(selection.selectedText);
		const content = await this.app.vault.read(sourceFile);
		if (selection.bilingual || isTranslationPath(selection.sourcePath)) prepareExcerpt(selection, content);
		const location = this.relocateSelection(content, selection);
		await this.ensureFolder(ANNOTATION_FOLDER);
		const annotationPath = await this.resolveAnnotationPath(sourceFile);
		const now = new Date().toISOString();
		const record: AnnotationRecord = {
			id: this.createAnnotationId(),
			...(color ? { color } : {}),
			annotationPath,
			sourcePath: selection.sourcePath,
			selectedText: selection.selectedText,
			section: selection.section,
			...(selection.bilingual ? { bilingual: selection.bilingual } : {}),
			...(detached ? { sourceAnchor: {
				start: location.start,
				end: location.end,
				prefix: content.slice(Math.max(0, location.start - 80), location.start),
				suffix: content.slice(location.end, location.end + 80),
			} } : {}),
			manualText: sanitizeEmbeddedText(draft.manualText),
			aiText: sanitizeEmbeddedText(draft.aiText),
			aiProvider: String(draft.aiProvider || ""),
			aiModel: String(draft.aiModel || ""),
			...(draft.paperTraces ? { paperTraces: draft.paperTraces } : {}),
			aiCli: normalizeCliReceipt(draft.aiCli),
			createdAt: now,
			updatedAt: now,
			archiveStatus: "none",
			archiveTargets: [],
			archiveRunId: "",
			archiveError: "",
		};
		await this.verifySelection(selection);
		await this.writeRecord(record);
		if (detached) return record;
		try {
			await this.app.vault.process(sourceFile, (content) => {
				const location = this.relocateSelection(content, selection);
				const linkTarget = annotationPath.replace(/\.md$/i, "");
				const aliasSeparator = selection.isTableCell ? "\\|" : "|";
				const link = `[[${linkTarget}#^${record.id}${aliasSeparator}${selection.selectedText}]]`;
				return `${content.slice(0, location.start)}${link}${content.slice(location.end)}`;
			});
		} catch (error) {
			record.archiveError = "批注内容已保存，但原文链接写入失败";
			await this.writeRecord(record);
			throw error;
		}
		return record;
	}

	/** New selections have one note for this exact occurrence and source revision. */
	async saveSelectionAnnotation(selection: AnnotationSelection, draft: AnnotationDraft, forGuide = false): Promise<AnnotationRecord> {
		selection = structuredClone({ ...selection, anchorRect: {} }) as AnnotationSelection;
		if (selection.pdfExcerpt) return this.createExcerpt(selection, draft.manualText);
		if (draft.aiText?.trim()) this.requireExplanationProof(selection);
		if (!forGuide && !draft.manualText?.trim() && !draft.aiText?.trim() && !annotationColor(draft.color) && !draft.excerptListed) throw new Error("请填写备注、选择颜色或收录摘录");
		if ((await this.findAnnotationsForSelection(selection)).length) throw new Error("此选区已有批注，请重新打开后继续修改");
		const source = this.app.vault.getAbstractFileByPath(selection.sourcePath);
		const content = await this.sourceText(selection.sourcePath);
		const { id, receipt } = prepareExcerpt({ ...selection, bilingual: undefined }, content);
		const annotationPath = `${ANNOTATION_FOLDER}/${id}.md`;
		const now = new Date().toISOString();
		const record = this.applyDraft({
			id, annotationPath, sourcePath: selection.sourcePath, selectedText: selection.selectedText, section: selection.section,
			sourceAnchor: { start: selection.sourceStart, end: selection.sourceEnd, prefix: selection.prefix, suffix: selection.suffix },
			excerpt: receipt, excerptListed: false, ...(selection.bilingual ? { bilingual: selection.bilingual } : {}),
			manualText: "", aiText: "", aiProvider: "", aiModel: "", createdAt: now, updatedAt: now,
			archiveStatus: "none", archiveTargets: [], archiveRunId: "", archiveError: "",
		}, draft, now);
		await this.ensureFolder(ANNOTATION_FOLDER);
		await this.verifySelection(selection);
		if (this.app.vault.getAbstractFileByPath(selection.sourcePath) !== source || await this.sourceText(selection.sourcePath) !== content) throw new Error("批注来源在保存前已变化，请重新选择");
		try { await this.app.vault.create(annotationPath, this.renderNewDocument(record)); }
		catch (error) {
			const saved = await this.loadAnnotation(annotationPath, id);
			if (saved && objectDigest(saved) === objectDigest(record)) return saved;
			if (this.app.vault.getAbstractFileByPath(annotationPath)) throw new Error("此选区已有批注，请重新打开后继续修改");
			throw error;
		}
		return record;
	}

	async findAnnotationForSelection(selection: AnnotationSelection): Promise<AnnotationRecord | null> {
		const records = await this.findAnnotationsForSelection(selection);
		return records.length === 1 ? records[0] : null;
	}

	async findAnnotationsForSelection(selection: AnnotationSelection): Promise<AnnotationRecord[]> {
		if (!selection.pdfExcerpt) await this.verifySelection(selection);
		const sourceFile = this.app.vault.getAbstractFileByPath(selection.sourcePath);
		if (!(sourceFile instanceof TFile) && !isClipperPath(selection.sourcePath)) return [];
		if (selection.pdfExcerpt) {
			const prepared = await verifyPdfSelection(this.app, selection);
			const excerpt = await this.loadAnnotation(`${ANNOTATION_FOLDER}/${prepared.id}.md`, prepared.id);
			return excerpt?.pdfExcerpt && excerpt.sourcePath === selection.sourcePath && objectDigest(excerpt.pdfExcerpt) === objectDigest(prepared.receipt) ? [excerpt] : [];
		}
		const source = await this.sourceText(selection.sourcePath), matches: AnnotationRecord[] = [];
		if (selection.sourceRevision) {
			const canonical = prepareExcerpt({ ...selection, bilingual: undefined }, source);
			const ids = new Set([canonical.id, prepareExcerpt(selection, source).id]);
			for (const id of ids) {
				const excerpt = await this.loadAnnotation(`${ANNOTATION_FOLDER}/${id}.md`, id);
				if (excerpt?.excerpt && excerpt.sourcePath === selection.sourcePath && excerpt.selectedText === selection.selectedText
					&& excerpt.sourceAnchor?.start === selection.sourceStart && excerpt.sourceAnchor.end === selection.sourceEnd
					&& objectDigest(excerpt.excerpt) === objectDigest(canonical.receipt)) matches.push(excerpt);
			}
		}
		if (!(sourceFile instanceof TFile) || isClipperPath(selection.sourcePath)) return matches;
		const annotationPath = await this.resolveAnnotationPath(sourceFile);
		const annotationFile = this.app.vault.getAbstractFileByPath(annotationPath);
		if (!(annotationFile instanceof TFile)) return matches;
		const current = this.relocateSelection(source, selection);
		const parsed = readAnnotationRecords(await this.app.vault.read(annotationFile), annotationPath);
		for (const record of parsed.records) {
			if (record.sourcePath !== sourceFile.path || record.selectedText !== selection.selectedText) continue;
			if (record.excerpt && !excerptMatches(record, source)) continue;
			if (record.sourceAnchor) {
				if (findSourceAnchorOffset(source, record.selectedText, record.sourceAnchor) !== current.start) continue;
			} else if (record.bilingual || countOccurrences(source, record.selectedText).length !== 1 || record.section !== selection.section) continue;
			matches.push(record);
		}
		return matches;
	}

	async updateAnnotation(record: AnnotationRecord, draft: AnnotationDraft, selection?: AnnotationSelection): Promise<AnnotationRecord> {
		const latest = await this.loadAnnotation(record.annotationPath, record.id);
		if (!latest || objectDigest(latest) !== objectDigest(record)) throw new Error("批注已被修改，请重新打开后核对");
		if (latest.pdfExcerpt && (draft.aiText !== undefined || draft.color !== undefined || draft.excerptListed !== undefined)) throw new Error("PDF 摘录可修改个人备注");
		let base = latest;
		const takeProof = Boolean(draft.aiProvider && draft.aiText?.trim() && !latest.bilingual && selection?.bilingual);
		if (takeProof || (draft.excerptListed && !latest.excerpt && !latest.pdfExcerpt)) {
			if (!selection || selection.sourcePath !== latest.sourcePath || selection.selectedText !== latest.selectedText || !latest.sourceAnchor) throw new Error("请重新划选原文后收录摘录");
			const source = this.app.vault.getAbstractFileByPath(latest.sourcePath);
			const content = await this.sourceText(latest.sourcePath);
			if (findSourceAnchorOffset(content, latest.selectedText, latest.sourceAnchor) !== selection.sourceStart) throw new Error("原文选区已变化，请重新划选");
			await this.verifySelection(selection);
			const { receipt } = prepareExcerpt(selection, content);
			const sourceAnchor = { start: selection.sourceStart, end: selection.sourceEnd, prefix: selection.prefix, suffix: selection.suffix };
			if (latest.bilingual && (sourceAnchor.start !== latest.sourceAnchor.start || sourceAnchor.end !== latest.sourceAnchor.end)) throw new Error("双语批注来源已变化，请保留原记录");
			if (latest.bilingual) await verifyBilingual(this.app, latest);
			if (this.app.vault.getAbstractFileByPath(latest.sourcePath) !== source || await this.sourceText(latest.sourcePath) !== content) throw new Error("摘录来源在保存前已变化，请重新选择");
			base = { ...latest, sourceAnchor, excerpt: receipt, ...(takeProof ? { bilingual: selection.bilingual, excerptListed: latest.excerptListed ?? listedExcerpt(latest) } : {}) };
		}
		if (draft.aiProvider && draft.aiText?.trim()) {
			this.requireExplanationProof(base);
			await verifyBilingual(this.app, base);
		}
		const updated = this.applyDraft(base, draft, new Date().toISOString());
		if (objectDigest({ ...updated, updatedAt: latest.updatedAt }) === objectDigest(latest)) return latest;
		await this.patchAnnotation(latest, updated);
		return updated;
	}

	private applyDraft(record: AnnotationRecord, draft: AnnotationDraft, now: string): AnnotationRecord {
		const manualText = draft.manualText === undefined ? record.manualText : sanitizeEmbeddedText(draft.manualText);
		const aiText = draft.aiText === undefined ? record.aiText : sanitizeEmbeddedText(draft.aiText);
		if (manualText.length > 10000 || aiText.length > 24000) throw new Error("批注文字过长，请缩短后保存");
		const changedContent = manualText !== record.manualText || aiText !== record.aiText;
		const reopen = changedContent && listedExcerpt(record) && record.archiveStatus === "completed" && !record.archiveRunId && !record.archiveTargets.length && !record.archiveError;
		return {
			...record, manualText, aiText,
			...(draft.paperTraces !== undefined ? { paperTraces: draft.paperTraces } : {}),
			...(draft.color !== undefined ? { color: annotationColor(draft.color) } : {}),
			...(draft.excerptListed !== undefined && record.excerpt ? { excerptListed: draft.excerptListed } : {}),
			...(draft.aiText !== undefined ? { aiEdited: aiText && (draft.aiEdited ?? !draft.aiProvider) ? true : undefined } : {}),
			...(draft.aiProvider !== undefined ? { aiProvider: draft.aiProvider, aiModel: draft.aiModel || "", aiCli: normalizeCliReceipt(draft.aiCli) } : {}),
			...(reopen ? { archiveStatus: "none" } : {}),
			updatedAt: now,
		};
	}

	async updateArchiveState(record: AnnotationRecord, updates: ArchiveUpdate): Promise<AnnotationRecord> {
		const vault = this.app.vault, { annotationPath, id } = record;
		const file = vault.getAbstractFileByPath(annotationPath);
		const conflict = "批注归档冲突：记录或文件已被删除或移动";
		if (!(file instanceof TFile)) throw new Error(conflict);
		if (updates.archiveTargets) updates = { ...updates, archiveTargets: updates.archiveTargets.map(normalizeArchiveTarget).filter(Boolean) };
		let updated!: AnnotationRecord;
		try {
			await vault.process(file, content => {
				const block = this.findRecordBlock(content, id);
				if (!block || vault.getAbstractFileByPath(annotationPath) !== file) throw new Error(conflict);
				const [latest] = readAnnotationRecords(block, annotationPath).records;
				if (!latest) throw new Error("批注记录格式已损坏，未写入归档状态");
				updated = { ...latest, ...updates };
				const patched = block.replace(/<!-- agent-dashboard:annotation-meta (\{[^\r\n]*\}) -->/,
					(_line, json: string) => META_PREFIX + patchArchiveMetadata(json, updates) + " -->");
				return content.replace(block, () => patchArchiveDisplay(patched, latest, updates));
			});
		} catch (error) {
			if (vault.getAbstractFileByPath(annotationPath) !== file) throw new Error(conflict);
			throw error;
		}
		return updated;
	}

	async loadAnnotation(
		annotationPath: string,
		annotationId: string,
	): Promise<AnnotationRecord | null> {
		const normalizedPath = normalizePath(
			annotationPath.endsWith(".md") ? annotationPath : `${annotationPath}.md`,
		);
		const file = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (!(file instanceof TFile)) return null;
		const content = await this.app.vault.read(file);
		const block = this.findRecordBlock(content, annotationId);
		if (!block) return null;
		const meta = parseMeta(block);
		if (!meta?.id) return null;
		return {
			...meta,
			annotationPath: normalizedPath,
			manualText: readMarkedSection(block, MANUAL_START, MANUAL_END),
			aiText: readMarkedSection(block, AI_START, AI_END),
		};
	}

	async openContextQuote(source: Pick<AnnotationSelection, "sourcePath" | "selectedText" | "bilingual">, paragraph: number, quote: string): Promise<void> {
		const proof = source.bilingual;
		const doc = await verifyBilingual(this.app, { ...source, sourceAnchor: proof && { ...proof.selection, prefix: "", suffix: "" } });
		const path = doc?.files.en.path || source.sourcePath;
		const text = doc?.files.en.text ?? await this.sourceText(path);
		await this.plugin.openReadingEvidence(path, undefined, undefined, quoteOffset(text, paragraph, quote));
	}

	async attachForReading(source: AnnotationSelection | AnnotationRecord, question: string, explanation: string, signal: AbortSignal, note = "", profileId?: string) {
		this.requireExplanationProof(source);
		const proof = source.bilingual;
		const anchor = "sourceStart" in source ? { start: source.sourceStart, end: source.sourceEnd, prefix: source.prefix, suffix: source.suffix } : source.sourceAnchor;
		const doc = await verifyBilingual(this.app, { ...source, sourceAnchor: anchor }, signal);
		if (proof && !proof.english) throw new Error("请先核对对应英文段落，再从这条批注开始带读");
		const original = doc?.files.en.text ?? await this.sourceText(source.sourcePath);
		const selectionText = proof?.english?.text ?? source.selectedText;
		const offset = proof?.english?.start ?? (anchor ? findSourceAnchorOffset(original, source.selectedText, anchor) : undefined);
		if (offset === null) throw new Error("无法定位批注选句，请回到原文重新划选");
		const revision = "sourceStart" in source ? source.sourceRevision : source.excerpt;
		if (!doc && revision && revision.digest !== excerptRevision(original).digest) throw new Error("批注来源版本已变化，请重新核对");
		const asked = question.trim() || [...explanation.matchAll(/^\*\*提问\*\* (.+)$/gm)].pop()?.[1] || "";
		const start = offset ?? original.indexOf(selectionText);
		if (start < 0 || original.slice(start, start + selectionText.length) !== selectionText || (offset === undefined && original.indexOf(selectionText, start + 1) >= 0))
			throw new Error("无法唯一定位批注选句，请回到原文重新划选");
		const current = parseBilingualMarkdown(original).blocks.find(b => b.start <= start && start < b.end);
		if (!current) throw new Error("批注选句不在论文正文中");
		const quotes = annotationEvidence(explanation, original, original.slice(current.start, current.end));
		const zh = doc && proof && doc.pairs.find(pair => pair[proof.language].id === proof.block.id)?.["zh-CN"];
		const chinese = proof?.language === "zh-CN" || Boolean(zh);
		const path = chinese ? doc!.files["zh-CN"].path : source.sourcePath;
		const at = proof?.language === "zh-CN" ? proof.selection.start : zh?.start ?? start;
		const digest = excerptRevision(chinese ? doc!.files["zh-CN"].text : original).digest;
		const paperPath = doc?.files.en.path || source.sourcePath;
		const origin = { ...(proof ? { selection: { lang: proof.language, ...proof.selection, digest: doc!.files[proof.language].revision.digest } } : {}), id: "id" in source ? source.id : objectDigest([source.sourcePath, start, source.selectedText]),
			path, at, digest, chinese, englishStart: start, englishDigest: excerptRevision(original).digest,
			selected: source.selectedText, question: asked, note, quotes };
		return this.plugin.getReadingWorkspace().attachAnnotation(paperPath, origin, signal, profileId);
	}

	async guideFromAnnotation(source: AnnotationSelection | AnnotationRecord, question: string, explanation: string, signal: AbortSignal, note = "", profileId?: string) {
		const target = await this.attachForReading(source, question, explanation, signal, note, profileId);
		await this.plugin.openLearningRecord(target.sessionId, target.nodeId);
	}

	async returnToAnnotation(origin: import("../reading/types").AnnotationOrigin) {
		if (excerptRevision(await this.sourceText(origin.path)).digest !== origin.digest) throw new Error("原段所在文件已变化，请重新核对位置");
		await this.plugin.openReadingEvidence(origin.path, undefined, undefined, origin.at);
	}

	explanationProfiles() { return this.plugin.getVerifiedProviderProfiles(); }

	defaultExplanationBackend() { return this.plugin.settings.annotationBackendId || "auto"; }
	defaultExplanationProfileId() {
		const backend = this.defaultExplanationBackend();
		return this.plugin.paperProfileId(backend,true);
	}

	async generateExplanation(
		selection: ExplanationSelection,
		registerCancel: (cancel: () => void) => void,
		request: { profileId?: string; question?: string; depth?: "brief" | "context"; gpt?: GptChoices } = {},
	): Promise<AnnotationExplanation> {
		this.requireExplanationProof(selection);
		const proof = selection.bilingual;
		const verified = await verifyBilingual(this.app, { ...selection, sourceAnchor: proof ? { ...proof.selection, prefix: "", suffix: "" } : undefined });
		if (proof && !proof.english) throw new Error(proof.files ? "手动配对尚未确认对应英文段落；可保存个人批注与摘录，AI 对照解释需先核对配对记录" : "对应英文段落未确认或超过请求上限；请核对配对后重试");
		// Nearby translated paragraphs have no English receipt in this request.
		// Use the verified current block for both new and reopened annotations.
		if (proof && proof.block.end - proof.block.start > 16000) throw new Error("双语当前段落超过请求上限，请选择较短段落");
		const id = this.plugin.paperProfileId(request.profileId, true);
		const profile = this.plugin.getProviderProfile(id);
		if (!profile?.lastTest?.ok) throw new Error("请选择已通过连接测试的批注 API");
		const model = request.gpt?.model || profile.model;
		const guided = profile.type === "openai" && supportsGptAnnotations(model);
		if (request.gpt?.model && !guided) throw new Error("请选择有效的 OpenAI GPT 配置");
		const gpt = guided ? gptAnnotationRequest(model, request.depth, request.gpt) : undefined;
		const expanded = request.depth === "context";
		const paperPath = verified?.files.en.path || selection.sourcePath;
		const original = verified?.files.en.text ?? await this.sourceText(paperPath);
		const selected = proof?.english?.text ?? selection.selectedText;
		const offset = proof?.english?.start ?? selection.sourceStart ?? original.indexOf(selected);
		if (offset < 0 || original.slice(offset, offset + selected.length) !== selected ||
			(!proof && selection.sourceStart === undefined && original.indexOf(selected, offset + 1) >= 0)) throw new Error("选区原文已变化或无法唯一定位，请重新划选");
		const blocks = parseBilingualMarkdown(original).blocks;
		const index = blocks.findIndex(b => b.start <= offset && offset < b.end);
		if (index < 0) throw new Error("无法找到选区所在正文段落");
		const block = blocks[index];
		const controller = new AbortController();
		const timeoutSeconds = !guided && this.plugin.settings.annotationWebSearchEnabled
			? Math.max(15, Math.min(45, this.plugin.settings.annotationWebSearchTimeoutSeconds || 30)) : profile.timeoutSeconds;
		this.explanations.add(controller);
		const deadline = expanded ? Math.min(300, timeoutSeconds * 5) : timeoutSeconds;
		const timeout = setTimeout(() => controller.abort(new Error("批注解释已超时")), deadline * 1000);
		registerCancel(() => controller.abort(new Error("批注解释已取消")));
		const kind = /^papers\/[^/]+--jats--[^/]+\/article\.md$/.test(paperPath) ? "structured" : "article";
		const doc: import("../reading/document").ReadingDocument = expanded
			? await this.plugin.getReadingWorkspace().loader.open(kind,paperPath).catch(error => { clearTimeout(timeout); this.explanations.delete(controller); throw error; })
			: { source:{kind:"article",path:paperPath,title:selection.section,fingerprint:excerptRevision(original).digest},
				evidence:[],catalog:"",image:async()=>null,destroy:async()=>{},verify:async()=>{
					if (await this.sourceText(paperPath) !== original) throw new Error("原文已变化，请重新核对选区");
				} };
		try {
			const localStart = Math.max(block.start, offset - 500);
			const first: ReadingEvidence = { id: "annotation-" + index, kind: "paper", path: doc.source.path, start: localStart, end: Math.min(block.end,localStart+5000),
				label: selection.section, text: original.slice(localStart, Math.min(block.end,localStart+5000)) };
			const question = request.question?.trim() || (expanded ? "选句在本文论证中起什么作用？" : "如何理解选句？");
			const selectionInfo = { selected: selection.selectedText, selectionLabel:quoteLabel(selection), question, section: selection.section,
				...(verified && proof ? { language: proof.language, pairedByStructure: true, currentParagraph: verified.files[proof.language].text.slice(Math.max(proof.block.start,proof.selection.start-500),Math.min(proof.block.end,proof.selection.end+500)) } : {}) };
			const backend = this.plugin.createPaperBackend(id, {model, gpt: guided ? gptAnnotationRequest(model,request.depth,{...request.gpt,search:false}) : undefined});
			const {evidence,images,trace} = await investigatePaper({document:doc,question, context:JSON.stringify(selectionInfo), initial:[first],
				backend, signal:controller.signal, brief:!expanded, profileId:id });
			if (expanded && trace.stop !== "材料足够") return {text:"本文证据不足。"+trace.stop+"。",provider:profile.name,model,trace};
			const sentences = new Map<string,string>(), refs = new Map<string,string>();
			for (const item of evidence) {
				if (item.asset) continue;
				for (const [i,b] of blocks.entries()) {
					if (item.start === undefined || b.end <= item.start || b.start >= item.start+item.text.length) continue;
					const text = original.slice(b.start,b.end);
					let cursor = 0;
					for (const [ref,sentence] of contextSentences(["[段 "+(i+1)+"] "+text])) {
						const at = text.indexOf(sentence,cursor);
						if (at < 0) continue;
						cursor = at + sentence.length;
						if (b.start + at < item.start || b.start + cursor > item.start + item.text.length) continue;
						sentences.set(ref,sentence); refs.set(ref,item.id);
					}
				}
			}
			const system = "你是论文阅读批注助手。中译选句用于定位，不可当作作者英文原句。模型一般知识与论文判断分开。只解释提供的材料；手动双栏未确认时只解释实际英文。图像观察只允许用于本轮实际传入的图。区分作者结果和解释性推断。"
				+ (expanded ? "用三至五句回答，每项判断就近引用所给[段 N 句 M]。引用图像可另标[图像ID]。保留限定与分母。"
					: "直接用两三句话解释选句，不分栏复述译文对照、英文依据或一般知识／解释性推断。不要延伸到其他段落。");
			const web = !guided && this.plugin.settings.annotationWebSearchEnabled ? this.plugin.resolveWebSearchBackend(profile) : undefined;
			const answer = await generateDirectExplanation({ profile:{...profile,model}, provider:this.plugin.createLLMProvider({...profile,model}), gptAnnotation:gpt,
				backend:web,system,user:JSON.stringify({ ...selectionInfo, materials:evidence.map(e=>({id:e.id,text:e.text})),images:images.map(i=>i.evidenceId),
					...(expanded ? {sentences:Object.fromEntries(sentences)} : {}) }),images,
				query:question+" "+selection.selectedText.slice(0,200), maxTokens:this.plugin.settings.annotationMaxTokens,
				timeoutMs:timeoutSeconds*1000,registerCancel:cancel=>{ if(controller.signal.aborted) cancel(); else controller.signal.addEventListener("abort",cancel,{once:true}); } });
			controller.signal.throwIfAborted(); await doc.verify();
			if (verified) await verifyBilingual(this.app,{...selection,sourceAnchor:proof && {...proof.selection,prefix:"",suffix:""}},controller.signal);
			if (!expanded) trace.steps[0].delivery = "received";
			if (expanded) {
				const imageRefs = [...answer.text.matchAll(/\[((?:figure-|page-|jats-)[\w-]+)\]/g)].map(match=>match[1]);
				if (imageRefs.some(id => !images.some(image=>image.evidenceId===id))) throw new Error("解释引用了本轮未传入的图像，请在本轮重试");
				answer.text = attachContextQuotes(answer.text,sentences);
				trace.citations = [...new Set([...imageRefs, ...[...answer.text.matchAll(/\[段 [^\]]+\]/g)].map(m=>refs.get(m[0])!).filter(Boolean)])];
			}
			return {...answer,trace};
		} catch (error) {
			controller.signal.throwIfAborted();
			throw error;
		} finally { clearTimeout(timeout); this.explanations.delete(controller); await doc.destroy(); }

	}

	async getRecordExplanationContext(
		record: AnnotationRecord,
	): Promise<ExplanationSelection> {
		this.requireExplanationProof(record);
		await verifyBilingual(this.app, record);
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		let context = record.selectedText;
		let sourceStart: number | undefined;
		if (isClipperPath(record.sourcePath) || (file instanceof TFile && file.extension === "md")) {
			const content = await this.sourceText(record.sourcePath);
			const offset = record.sourceAnchor
				? findSourceAnchorOffset(content, record.selectedText, record.sourceAnchor) ?? -1
				: countOccurrences(content, record.selectedText)[0] ?? -1;
			if (offset >= 0) {
				sourceStart = offset;
				context = content.slice(
					Math.max(0, offset - Math.floor(CONTEXT_LIMIT / 2)),
					Math.min(content.length, offset + record.selectedText.length + Math.floor(CONTEXT_LIMIT / 2)),
				).trim();
			}
		}
		return {
			selectedText: record.selectedText,
			section: record.section,
			sourceStart,
			context,
			sourcePath: record.sourcePath,
			...(record.bilingual ? { bilingual: structuredClone(record.bilingual) } : {}),
		};
	}

	async openAnnotationDocument(record: AnnotationRecord, newLeaf = false): Promise<void> {
		const link = `${record.annotationPath.replace(/\.md$/i, "")}#^${record.id}`;
		await this.app.workspace.openLinkText(link, record.sourcePath, newLeaf);
	}

	async openArchiveTarget(record: AnnotationRecord, target: string): Promise<void> {
		const normalized = normalizeArchiveTarget(target);
		if (!normalized) {
			new Notice("该批注尚未关联正式知识节点");
			return;
		}
		await this.app.workspace.openLinkText(normalized, record.sourcePath, true);
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const parts = normalizePath(folderPath).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try { await this.app.vault.createFolder(current); }
				catch (error) { if (!this.app.vault.getAbstractFileByPath(current)) throw error; }
			}
		}
	}

	private async resolveAnnotationPath(sourceFile: TFile): Promise<string> {
		const safeBase = sourceFile.basename
			.replace(/[\\/:*?"<>|#[\]^]/g, "-")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 90) || "note";
		const candidate = normalizePath(`${ANNOTATION_FOLDER}/${safeBase}.md`);
		const existing = this.app.vault.getAbstractFileByPath(candidate);
		if (!(existing instanceof TFile)) return candidate;
		const content = await this.app.vault.read(existing);
		if (content.includes(`source: ${yamlString(sourceFile.path.replace(/\.md$/i, ""))}`)) {
			return candidate;
		}
		const suffix = this.hashPath(sourceFile.path);
		return normalizePath(`${ANNOTATION_FOLDER}/${safeBase}-${suffix}.md`);
	}

	private createAnnotationId(): string {
		const random = typeof crypto.randomUUID === "function"
			? crypto.randomUUID().split("-").join("").slice(0, 10)
			: Math.random().toString(36).slice(2, 12);
		return `ann-${random}`;
	}

	private hashPath(value: string): string {
		let hash = 2166136261;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(36).slice(0, 7);
	}

	private relocateSelection(
		content: string,
		selection: AnnotationSelection,
	): { start: number; end: number } {
		if (
			content.slice(selection.sourceStart, selection.sourceEnd) === selection.selectedText
			&& content.slice(Math.max(0, selection.sourceStart - selection.prefix.length), selection.sourceStart) === selection.prefix
			&& content.slice(selection.sourceEnd, selection.sourceEnd + selection.suffix.length) === selection.suffix
		) {
			return { start: selection.sourceStart, end: selection.sourceEnd };
		}
		const offsets = countOccurrences(content, selection.selectedText);
		const ranked = offsets
			.map((offset) => ({
				offset,
				score: commonSuffixLength(
					content.slice(Math.max(0, offset - selection.prefix.length), offset),
					selection.prefix,
				) + commonPrefixLength(
					content.slice(
						offset + selection.selectedText.length,
						offset + selection.selectedText.length + selection.suffix.length,
					),
					selection.suffix,
				),
			}))
			.sort((left, right) => right.score - left.score);
		if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) {
			throw new Error("原文在批注期间发生变化，无法唯一定位选区");
		}
		const start = ranked[0].offset;
		const end = start + selection.selectedText.length;
		if (!markdownNeedsDetached(selection.selectedText) && isInsideProtectedMarkdown(content, start, end)) {
			throw new Error("选区已位于链接或代码中，未重复写入批注链接");
		}
		return { start, end };
	}

	private renderRecord(record: AnnotationRecord): string {
		const meta: AnnotationMeta = {
			id: record.id,
			...(record.color ? { color: record.color } : {}),
			sourcePath: record.sourcePath,
			selectedText: record.selectedText,
			section: record.section,
			sourceAnchor: record.sourceAnchor,
			...(record.excerpt ? { excerpt: record.excerpt } : {}),
			...(record.excerptListed !== undefined ? { excerptListed: record.excerptListed } : {}),
			...(record.aiEdited ? { aiEdited: true } : {}),
			...(record.pdfExcerpt ? { pdfExcerpt: record.pdfExcerpt } : {}),
			...(record.bilingual ? { bilingual: record.bilingual } : {}),
			aiProvider: record.aiProvider,
			aiModel: record.aiModel,
			...(record.paperTraces ? {paperTraces: record.paperTraces} : {}),
			...(record.aiCli ? { aiCli: normalizeCliReceipt(record.aiCli) } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			archiveStatus: record.archiveStatus,
			archiveTargets: record.archiveTargets,
			archiveRunId: record.archiveRunId,
			archiveError: record.archiveError,
		};
		const displayText = record.pdfExcerpt ? record.selectedText : annotationDisplayText(record.selectedText);
		const title = record.pdfExcerpt ? `PDF 第 ${record.pdfExcerpt.page} 页摘录` : displayText.slice(0, 90).replace(/[#\r\n\[\]<>]/g, "");
		const targets = archiveTargetLinks(record.archiveTargets);
		const statusLabel = archiveStatusLabels[record.archiveStatus];
		// Source context can contain HTML comments or annotation marker text.
		// JSON escapes preserve the exact anchor without terminating this comment.
		const serializedMeta = JSON.stringify(meta).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
		const escaped = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		const contextHtml = escaped(record.pdfExcerpt?.context || record.excerpt?.context || "");
		return [
			`${BLOCK_START}${record.id} -->`,
			`## ${title || "批注"}`,
			`${META_PREFIX}${serializedMeta} -->`,
			"",
			record.pdfExcerpt ? `原文：\n\n<pre>${escaped(record.selectedText)}</pre>\n` : markdownNeedsDetached(record.selectedText) ? `${quoteLabel(record)}：\n\n<pre>${escaped(displayText)}</pre>\n` : `- ${quoteLabel(record)}：${record.selectedText}`,
			`- 来源：${sourceReference(record.sourcePath)}`,
			record.section ? `- 章节：${record.section}` : "",
			...(record.color ? [`- 颜色标注：${ANNOTATION_COLORS[record.color]}（个人阅读标记）`] : []),
			`- 创建：${record.createdAt}`,
			`- 更新：${record.updatedAt}`,
			...(record.bilingual ? ["", "### 双语来源记录", bilingualDescription(record.bilingual), ...(record.bilingual.english ? ["英文对应段落（结构对应，语义待核对）：", `<pre>${escaped(record.bilingual.english.text)}</pre>`] : ["英文对应段落未确认。"])] : []),
			...(record.excerpt ? ["", (record.bilingual?.language === "zh-CN" || isTranslationPath(record.sourcePath)) ? "### 保存时的译文上下文" : "### 保存时的原文上下文", "仅记录当前 Markdown 文本版本，原文包与科学证据需另行核验。", `文本版本：\`${record.excerpt.digest}\``, "", `<pre>${contextHtml}</pre>`] : []),
			...(record.pdfExcerpt ? ["", "### 保存时的原文上下文", "记录 PDF 文件版本与页内文字层；保留换行，科学结论需另行审阅。", `PDF 第 ${record.pdfExcerpt.page} / ${record.pdfExcerpt.pageCount} 页（文件页码）`, `文件版本：\`${record.pdfExcerpt.digest}\``, "", `<pre>${contextHtml}</pre>`] : []),
			"",
			"### 手动批注",
			MANUAL_START,
			record.manualText || "",
			MANUAL_END,
			"",
			record.aiEdited ? "### AI 解释（已人工修改）" : "### AI 解释",
			AI_START,
			record.aiText || "",
			AI_END,
			"",
			"### 归档",
			`- 状态：${statusLabel}`,
			`- 知识节点：${targets}`,
			record.archiveError ? `- 说明：${record.archiveError}` : "",
			"",
			`^${record.id}`,
			`${BLOCK_END}${record.id} -->`,
		].join("\n");
	}

	private renderNewDocument(record: AnnotationRecord): string {
		const sourceTarget = record.sourcePath.replace(/\.md$/i, "");
		return [
			"---",
			"type: annotations",
			`source: ${yamlString(sourceTarget)}`,
			`created: ${yamlString(record.createdAt)}`,
			`updated: ${yamlString(record.updatedAt)}`,
			"tags:",
			"  - annotation",
			"---",
			"",
			`# ${this.sourceTitle(record.sourcePath)}批注`,
			"",
			`来源：${sourceReference(record.sourcePath)}`,
			"",
			this.renderRecord(record),
			"",
		].join("\n");
	}

	private sourceTitle(sourcePath: string): string {
		const name = sourcePath.split("/").pop()?.replace(/\.md$/i, "") || "文档";
		return `${name} `;
	}

	private findRecordBlock(content: string, annotationId: string): string {
		const start = `${BLOCK_START}${annotationId} -->`;
		const end = `${BLOCK_END}${annotationId} -->`;
		const startIndex = content.indexOf(start);
		if (startIndex === -1) return "";
		const endIndex = content.indexOf(end, startIndex + start.length);
		if (endIndex === -1) return "";
		return content.slice(startIndex, endIndex + end.length);
	}

	private async patchAnnotation(previous: AnnotationRecord, updated: AnnotationRecord): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(previous.annotationPath);
		if (!(file instanceof TFile)) throw new Error("批注记录不存在");
		let intended: string | undefined;
		try {
			await this.app.vault.process(file, content => {
				const latest = readAnnotationRecords(content, previous.annotationPath).records.find(r => r.id === previous.id);
				if (file.path !== previous.annotationPath || this.app.vault.getAbstractFileByPath(file.path) !== file
					|| !latest || objectDigest(latest) !== objectDigest(previous)) throw new Error("批注保存前已被修改，请重新打开后核对");
				const oldBlock = this.findRecordBlock(content, previous.id);
				const eol = oldBlock.includes("\r\n") ? "\r\n" : "\n";
				const generated = this.renderRecord(updated).replace(/\n/g, eol);
				const metadata = (block: string): Record<string, unknown> => JSON.parse(block.slice(block.indexOf(META_PREFIX) + META_PREFIX.length).split(eol)[0].replace(/ -->$/, ""));
				let block = oldBlock.replace(/<!-- agent-dashboard:annotation-meta [^\r\n]+ -->/, () => {
					const meta = { ...metadata(oldBlock), ...metadata(generated) };
					if (!updated.color) delete meta.color;
					if (!updated.aiCli) delete meta.aiCli;
					if (!updated.aiEdited) delete meta.aiEdited;
					return META_PREFIX + JSON.stringify(meta).replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + " -->";
				});
				const replaceSection = (from: string, to: string, text: string) => {
					const start = block.indexOf(from) + from.length, end = block.indexOf(to, start);
					if (start < from.length || end < start || block.indexOf(from, start) >= 0 || block.indexOf(to, end + to.length) >= 0) throw new Error("批注分区已损坏，未写入");
					block = block.slice(0, start) + eol + text.replace(/\r?\n/g, eol) + eol + block.slice(end);
				};
				if (updated.manualText !== previous.manualText) replaceSection(MANUAL_START, MANUAL_END, updated.manualText);
				if (updated.aiText !== previous.aiText) replaceSection(AI_START, AI_END, updated.aiText);
				block = block.replace(/^### AI 解释(?:（已人工修改）)?(?=\r?$)/m, updated.aiEdited ? "### AI 解释（已人工修改）" : "### AI 解释");
				if (updated.color !== previous.color) {
					block = block.replace(/^- 颜色标注：[^\r\n]*（个人阅读标记）\r?\n/m, "");
					if (updated.color) block = block.replace(/^- 创建：/m, `- 颜色标注：${ANNOTATION_COLORS[updated.color]}（个人阅读标记）${eol}- 创建：`);
				}
				if (!previous.bilingual && updated.bilingual) {
					const start = generated.indexOf("### 双语来源记录");
					const end = generated.search(/^### 保存时的(?:原文|译文)上下文/m);
					const proof = generated.slice(start, end);
					block = block.replace(/^### (?:保存时的(?:原文|译文)上下文|手动批注)/m, match => proof + match);
				}
				if (!previous.excerpt && updated.excerpt) {
					const context = generated.slice(generated.search(/^### 保存时的(?:原文|译文)上下文/m), generated.indexOf("### 手动批注"));
					block = block.replace(/^### 手动批注/m, () => context + "### 手动批注");
				}
				if (previous.archiveStatus !== updated.archiveStatus) block = block.replace(/^(### 归档\r?\n)- 状态：[^\r\n]*/m, "$1- 状态：待整理");
				block = block.replace(/^- 更新：[^\r\n]*/m, "- 更新：" + updated.updatedAt);
				const start = content.indexOf(oldBlock);
				intended = content.slice(0, start) + block + content.slice(start + oldBlock.length);
				intended = intended.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/, (_match, header: string, body: string, footer: string) => header + body.replace(/^updated: [^\r\n]*/m, "updated: " + yamlString(updated.updatedAt)) + footer);
				return intended;
			});
		} catch (error) {
			if (intended !== undefined && file.path === previous.annotationPath && this.app.vault.getAbstractFileByPath(file.path) === file && await this.app.vault.read(file) === intended) return;
			throw error;
		}
	}

	private async writeRecord(record: AnnotationRecord): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(record.annotationPath);
		if (!(file instanceof TFile)) {
			await this.app.vault.create(record.annotationPath, this.renderNewDocument(record));
			return;
		}
		await this.app.vault.process(file, (content) => {
			const oldBlock = this.findRecordBlock(content, record.id);
			const nextBlock = this.renderRecord(record);
			let updated = oldBlock
				? content.replace(oldBlock, nextBlock)
				: `${content.trimEnd()}\n\n${nextBlock}\n`;
			updated = updated.replace(
				/^updated:\s*.*$/m,
				`updated: ${yamlString(record.updatedAt)}`,
			);
			return updated;
		});
	}
}
