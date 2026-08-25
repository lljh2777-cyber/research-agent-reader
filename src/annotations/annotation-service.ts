import {
	App,
	Notice,
	TFile,
	normalizePath,
	type MarkdownPostProcessorContext,
} from "obsidian";

import type AgentDashboardPlugin from "../plugin";
import { getCliBackendLabel, type CliBackendId } from "../config";
import {
	getClaudeDefaultModelLabel,
	getOpenCodeDefaultModelLabel,
} from "../runtime/settings";
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

interface AnnotationMeta {
	id: string;
	sourcePath: string;
	selectedText: string;
	section: string;
	aiProvider: string;
	aiModel: string;
	createdAt: string;
	updatedAt: string;
	archiveStatus: AnnotationRecord["archiveStatus"];
	archiveTargets: string[];
	archiveRunId: string;
	archiveError: string;
}

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

function normalizeArchiveTarget(value: unknown): string {
	return String(value || "")
		.trim()
		.replace(/^\[\[/, "")
		.replace(/\]\]$/, "")
		.split("|", 1)[0]
		.replace(/\.md$/i, "")
		.replace(/^\/+/, "");
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
		const status = String(value.archiveStatus || "none");
		return {
			id: String(value.id || ""),
			sourcePath: String(value.sourcePath || ""),
			selectedText: String(value.selectedText || ""),
			section: String(value.section || ""),
			aiProvider: String(value.aiProvider || ""),
			aiModel: String(value.aiModel || ""),
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

export class AnnotationService {
	constructor(
		private readonly app: App,
		private readonly plugin: AgentDashboardPlugin,
	) {}

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

	async captureSelection(): Promise<AnnotationSelection> {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
			throw new Error("请先在阅读视图中选择需要批注的文字");
		}
		const range = selection.getRangeAt(0);
		const selectedText = selection.toString().trim();
		if (!selectedText) throw new Error("选区中没有可批注的文字");
		if (selectedText.length > MAX_SELECTION_LENGTH) {
			throw new Error(`第一版单次最多批注 ${MAX_SELECTION_LENGTH} 个字符`);
		}
		if (/[\r\n|\[\]]/.test(selectedText) || selectedText.includes("-->")) {
			throw new Error("第一版只支持同一段落内、不含链接控制字符的纯文本选区");
		}
		const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
			? range.commonAncestorContainer as HTMLElement
			: range.commonAncestorContainer.parentElement;
		if (!element || !element.closest(".markdown-reading-view, .markdown-preview-view")) {
			throw new Error("第一版只支持 Markdown 阅读视图中的文字选区");
		}
		const block = element.closest<HTMLElement>("p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6");
		if (!block || !block.contains(range.startContainer) || !block.contains(range.endContainer)) {
			throw new Error("第一版只支持同一段落或标题内的选区");
		}
		const sectionElement = element.closest<HTMLElement>("[data-agent-annotation-source]");
		const sourcePath = String(sectionElement?.dataset.agentAnnotationSource || "");
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile) || file.extension !== "md") {
			throw new Error("无法确定选区对应的 Markdown 文件");
		}
		const content = await this.app.vault.read(file);
		const lineStart = Number.parseInt(
			String(sectionElement?.dataset.agentAnnotationLineStart || "0"),
			10,
		);
		const lineEnd = Number.parseInt(
			String(sectionElement?.dataset.agentAnnotationLineEnd || ""),
			10,
		);
		const segmentStart = lineOffset(content, Number.isFinite(lineStart) ? lineStart : 0);
		const segmentEnd = Number.isFinite(lineEnd)
			? lineOffset(content, lineEnd + 1)
			: content.length;
		const segment = content.slice(segmentStart, segmentEnd);
		let offsets = countOccurrences(segment, selectedText).map((offset) => offset + segmentStart);
		if (!offsets.length) offsets = countOccurrences(content, selectedText);
		if (!offsets.length) {
			throw new Error("选中文字包含 Markdown 渲染差异，第一版无法安全写回原文");
		}

		const blockRange = document.createRange();
		blockRange.selectNodeContents(block);
		blockRange.setEnd(range.startContainer, range.startOffset);
		const visiblePrefix = blockRange.toString().replace(/\s+/g, " ").slice(-80);
		blockRange.selectNodeContents(block);
		blockRange.setStart(range.endContainer, range.endOffset);
		const visibleSuffix = blockRange.toString().replace(/\s+/g, " ").slice(0, 80);
		const ranked = offsets
			.map((offset) => ({
				offset,
				score: commonSuffixLength(
					content.slice(Math.max(0, offset - 80), offset).replace(/\s+/g, " "),
					visiblePrefix,
				) + commonPrefixLength(
					content.slice(offset + selectedText.length, offset + selectedText.length + 80).replace(/\s+/g, " "),
					visibleSuffix,
				),
			}))
			.sort((left, right) => right.score - left.score);
		if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
			throw new Error("原文中存在多个相同选区，暂时无法唯一定位，请扩大选区后重试");
		}
		const sourceStart = ranked[0].offset;
		const sourceEnd = sourceStart + selectedText.length;
		if (isInsideProtectedMarkdown(content, sourceStart, sourceEnd)) {
			throw new Error("选区位于已有链接或行内代码中，第一版不会改写这类 Markdown");
		}
		const contextStart = Math.max(0, sourceStart - Math.floor(CONTEXT_LIMIT / 2));
		const contextEnd = Math.min(content.length, sourceEnd + Math.floor(CONTEXT_LIMIT / 2));
		return {
			sourcePath,
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

	async createAnnotation(
		selection: AnnotationSelection,
		draft: AnnotationDraft,
	): Promise<AnnotationRecord> {
		const sourceFile = this.app.vault.getAbstractFileByPath(selection.sourcePath);
		if (!(sourceFile instanceof TFile)) throw new Error("原始 Markdown 文件不存在");
		await this.ensureFolder(ANNOTATION_FOLDER);
		const annotationPath = await this.resolveAnnotationPath(sourceFile);
		const now = new Date().toISOString();
		const record: AnnotationRecord = {
			id: this.createAnnotationId(),
			annotationPath,
			sourcePath: selection.sourcePath,
			selectedText: selection.selectedText,
			section: selection.section,
			manualText: sanitizeEmbeddedText(draft.manualText),
			aiText: sanitizeEmbeddedText(draft.aiText),
			aiProvider: String(draft.aiProvider || ""),
			aiModel: String(draft.aiModel || ""),
			createdAt: now,
			updatedAt: now,
			archiveStatus: "none",
			archiveTargets: [],
			archiveRunId: "",
			archiveError: "",
		};
		await this.writeRecord(record);
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

	async updateAnnotation(
		record: AnnotationRecord,
		draft: AnnotationDraft,
	): Promise<AnnotationRecord> {
		const latest = await this.loadAnnotation(record.annotationPath, record.id);
		if (!latest) throw new Error("批注记录不存在或已被修改");
		const updated: AnnotationRecord = {
			...latest,
			manualText: draft.manualText === undefined
				? latest.manualText
				: sanitizeEmbeddedText(draft.manualText),
			aiText: draft.aiText === undefined
				? latest.aiText
				: sanitizeEmbeddedText(draft.aiText),
			aiProvider: draft.aiProvider === undefined ? latest.aiProvider : String(draft.aiProvider || ""),
			aiModel: draft.aiModel === undefined ? latest.aiModel : String(draft.aiModel || ""),
			updatedAt: new Date().toISOString(),
		};
		await this.writeRecord(updated);
		return updated;
	}

	async updateArchiveState(
		record: AnnotationRecord,
		updates: Partial<
			Pick<
				AnnotationRecord,
				"archiveStatus" | "archiveTargets" | "archiveRunId" | "archiveError"
			>
		>,
	): Promise<AnnotationRecord> {
		const latest = await this.loadAnnotation(record.annotationPath, record.id);
		if (!latest) throw new Error("批注记录不存在");
		const updated = {
			...latest,
			...updates,
			archiveTargets: updates.archiveTargets
				? updates.archiveTargets.map(normalizeArchiveTarget).filter(Boolean)
				: latest.archiveTargets,
			updatedAt: new Date().toISOString(),
		};
		await this.writeRecord(updated);
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

	async generateExplanation(
		selection: Pick<AnnotationSelection, "selectedText" | "section" | "context" | "sourcePath">,
		registerCancel: (cancel: () => void) => void,
	): Promise<AnnotationExplanation> {
		const webSearchEnabled = this.plugin.settings.annotationWebSearchEnabled === true;
		const webSearchTimeoutSeconds = Math.max(
			15,
			Math.min(45, this.plugin.settings.annotationWebSearchTimeoutSeconds || 30),
		);
		const system = [
			"你是论文阅读批注助手。",
			"请用简体中文解释选中的词句在当前段落和文章语境中具体指什么。",
			"目标是帮助读者理解，不做跨文献综述，不创建知识节点，不修改文件。",
			webSearchEnabled
				? "允许进行浅层联网查证：最多围绕 2 个检索问题，最多采用 3 个权威来源，不追踪来源中的二级链接；优先回答当前语境，不扩展成专题调研。"
				: "不要联网搜索；仅根据提供的段落、文章语境和模型已有知识解释。",
			"直接给出清晰的初步解释，通常 2 至 4 个短段落；不要使用 Markdown 标题或列表，不要输出流程报告、证据分类或客套话。",
		].join("\n");
		const user = [
			`文档：${selection.sourcePath}`,
			selection.section ? `章节：${selection.section}` : "",
			`选中文字：${selection.selectedText}`,
			"",
			"上下文：",
			selection.context,
		].filter(Boolean).join("\n");
		const configuredBackend = this.plugin.settings.annotationBackendId || "auto";
		const selectedDirectProfile = configuredBackend === "auto"
			? this.plugin.getProviderProfile(this.plugin.settings.activeProviderId)
			: !["codex-cli", "claude-code", "opencode"].includes(configuredBackend)
				? this.plugin.getProviderProfile(configuredBackend)
				: null;
		const directProfile = webSearchEnabled ? null : selectedDirectProfile;
		if (directProfile?.lastTest?.ok) {
			const provider = this.plugin.createLLMProvider(directProfile);
			const result = await provider.complete(
				{
					model: directProfile.model,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					maxTokens: this.plugin.settings.annotationMaxTokens,
				},
				{
					registerCancel,
				},
			);
			const text = String(result.text || "").trim();
			if (!text) throw new Error("模型返回了空解释");
			return {
				text,
				provider: directProfile.name,
				model: directProfile.model,
			};
		}

		const action = this.plugin.getDashboardAction("annotation-explain");
		if (!action) throw new Error("批注解释操作未注册");
		const runId = `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		registerCancel(() => {
			this.plugin.requestVaultActionStop(runId);
		});
		const cliBackend: CliBackendId = configuredBackend === "claude-code"
			? "claude-code"
			: configuredBackend === "opencode"
				? "opencode"
				: "codex-cli";
		const annotationOverrides = cliBackend === "claude-code"
			? {
				model: this.plugin.settings.annotationClaudeModel,
				reasoningEffort: this.plugin.settings.annotationClaudeReasoningEffort,
				serviceTier: "default" as const,
			}
			: cliBackend === "opencode"
				? {
					model: this.plugin.settings.annotationOpenCodeModel,
					reasoningEffort: this.plugin.settings.annotationOpenCodeReasoningEffort,
					serviceTier: "default" as const,
				}
			: {
				model: this.plugin.settings.annotationCodexModel,
				reasoningEffort: this.plugin.settings.annotationCodexReasoningEffort,
				serviceTier: this.plugin.settings.annotationCodexServiceTier,
			};
		const executionConfig = this.plugin.resolveCliActionExecutionConfig(
			action,
			cliBackend,
			annotationOverrides,
		);
		executionConfig.retrievalMode = webSearchEnabled ? "web" : "vault";
		executionConfig.timeoutSeconds = webSearchEnabled
			? webSearchTimeoutSeconds
			: undefined;
		const result = await this.plugin.runVaultAction(
			runId,
			action,
			`${system}\n\n${user}`,
			executionConfig,
		);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `模型进程退出码：${result.exitCode}`);
		}
		const text = result.stdout.trim();
		if (!text) throw new Error("模型返回了空解释");
		return {
			text,
			provider: getCliBackendLabel(cliBackend),
			model: executionConfig.model || (
				cliBackend === "claude-code"
					? getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)
					: cliBackend === "opencode"
						? getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)
						: this.plugin.settings.codexModel
			),
		};
	}

	async getRecordExplanationContext(
		record: AnnotationRecord,
	): Promise<Pick<AnnotationSelection, "selectedText" | "section" | "context" | "sourcePath">> {
		const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
		let context = record.selectedText;
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			const offsets = countOccurrences(content, record.selectedText);
			const offset = offsets[0] ?? -1;
			if (offset >= 0) {
				context = content.slice(
					Math.max(0, offset - Math.floor(CONTEXT_LIMIT / 2)),
					Math.min(content.length, offset + record.selectedText.length + Math.floor(CONTEXT_LIMIT / 2)),
				).trim();
			}
		}
		return {
			selectedText: record.selectedText,
			section: record.section,
			context,
			sourcePath: record.sourcePath,
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
				await this.app.vault.createFolder(current);
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
		if (isInsideProtectedMarkdown(content, start, end)) {
			throw new Error("选区已位于链接或代码中，未重复写入批注链接");
		}
		return { start, end };
	}

	private renderRecord(record: AnnotationRecord): string {
		const meta: AnnotationMeta = {
			id: record.id,
			sourcePath: record.sourcePath,
			selectedText: record.selectedText,
			section: record.section,
			aiProvider: record.aiProvider,
			aiModel: record.aiModel,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			archiveStatus: record.archiveStatus,
			archiveTargets: record.archiveTargets,
			archiveRunId: record.archiveRunId,
			archiveError: record.archiveError,
		};
		const title = record.selectedText.replace(/\s+/g, " ").slice(0, 90).replace(/[#\r\n]/g, "");
		const sourceTarget = record.sourcePath.replace(/\.md$/i, "");
		const targets = record.archiveTargets.length
			? record.archiveTargets.map((target) => `[[${normalizeArchiveTarget(target)}]]`).join("、")
			: "无";
		const statusLabel = {
			none: "未归档",
			pending: "归档中",
			completed: "已归档",
			failed: "归档失败",
		}[record.archiveStatus];
		return [
			`${BLOCK_START}${record.id} -->`,
			`## ${title || "批注"}`,
			`${META_PREFIX}${JSON.stringify(meta)} -->`,
			"",
			`- 原文：${record.selectedText}`,
			`- 来源：[[${sourceTarget}]]`,
			record.section ? `- 章节：${record.section}` : "",
			`- 创建：${record.createdAt}`,
			`- 更新：${record.updatedAt}`,
			"",
			"### 手动批注",
			MANUAL_START,
			record.manualText || "",
			MANUAL_END,
			"",
			"### AI 解释",
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
			`来源：[[${sourceTarget}]]`,
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
