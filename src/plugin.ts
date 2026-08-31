import {
	FileSystemAdapter,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	normalizePath,
	type WorkspaceLeaf,
} from "obsidian";

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { ACTION_BY_ID, type DashboardAction } from "./actions";
import {
	DEFAULT_SETTINGS,
	describeCliExecutable,
	findPreferredClaudeExecutable,
	findPreferredCodexExecutable,
	findPreferredMineruExecutable,
	findPreferredObsidianCliExecutable,
	findPreferredOpenCodeExecutable,
	getClaudeDefaultModelLabel,
	getCodexDefaultModelLabel,
	getOpenCodeDefaultModelLabel,
	inferLegacyClaudeConfigSource,
	isManagedCodexExecutable,
	migrateLegacySettingsKeys,
	normalizeActionExecutionDefaults,
	normalizeReaderMarkdownFolders,
} from "./runtime/settings";
import type { DashboardSettings } from "./runtime/settings";
import {
	ObsidianCliService,
	type ObsidianCliConnectionResult,
	type ObsidianCliProbeState,
} from "./runtime/obsidian-cli";
import { DashboardLifecycleState } from "./runtime/lifecycle-state";
import {
	DashboardPersistence,
	hasPlaintextCredentialFields,
	normalizeTaskRunArtifacts,
	normalizeStoredTaskRuns,
	sanitizeSettingsForStorage,
} from "./runtime/persistence";
import {
	cleanupTaskRunStorage,
	deleteTaskRunOutput as deletePersistedTaskRunOutput,
	readTaskRunCompletion,
	readTaskRunOutput,
	writeTaskRunOutput,
} from "./runtime/task-output-persistence";
import { ProcessExecutionService } from "./runtime/process-execution";
import { AgentLoopService, type AgentLoopRunOutcome } from "./agent/agent-loop-service";
import type { PaperIngestFlowOptions } from "./agent/paper-ingest-flow";
import { VaultLintService } from "./services/vault-lint";
import { makeVaultSourcePathResolver, readVaultEvidencePackets } from "./services/vault-evidence";
import { saveQueryAnswerNote } from "./services/query-note";
import { searchTavily, type WebSearchHttpDeps } from "./services/web-search";
import { AgentDashboardSettingTab } from "./settings/settings-tab";
import { CodePracticeView } from "./views/code-practice";
import { DashboardView } from "./views/dashboard";
import { MineruReaderView } from "./views/mineru-reader";
import { QueryWikiView } from "./views/query-wiki";
import { AnnotationPopover } from "./annotations/annotation-popover";
import { AnnotationService } from "./annotations/annotation-service";
import type { AnnotationRecord, AnnotationSelection } from "./annotations/types";
import {
	CODE_PRACTICE_VIEW_TYPE,
	MAX_QUERY_IMAGE_ATTACHMENTS,
	MAX_QUERY_IMAGE_TOTAL_BYTES,
	MAX_VAULT_IMAGE_BYTES,
	MINERU_READER_VIEW_TYPE,
	MODEL_OPTIONS,
	QUERY_WIKI_VIEW_TYPE,
	REASONING_OPTIONS,
	VAULT_IMAGE_MIME_TYPES,
	VIEW_TYPE,
	getCliBackendLabel,
	isCliBackendId,
	type ChatMessage,
	type CliBackendId,
} from "./config";
import {
	normalizeQueryCitationValidation,
	normalizeQueryRetrievalPath,
	normalizeQueryVaultSources,
	normalizeQueryWebSources,
	normalizeVaultImageAttachment,
	normalizeVaultImageAttachments,
	type VaultImageAttachment,
} from "./query/normalization";
import {
	AnthropicProvider,
	CodexCliProvider,
	LMStudioProvider,
	OllamaProvider,
	OpenAICompatibleProvider,
	OpenAIProvider,
	type LLMProvider,
} from "./providers/adapters";
import {
	detectNativeWebSearchProtocol,
	normalizeProviderProfile,
} from "./providers/profile";
import {
	ProviderConnectionError,
} from "./providers/shared";
import type { ProviderModel } from "./providers/shared";
import type { ProviderProfile } from "./providers/profile";
import {
	ProviderHttpTransport,
	normalizeProviderError as normalizeHttpProviderError,
} from "./providers/http-transport";
import {
	DirectQueryService,
	type RetrievalTrace,
	type VaultEvidencePacket,
	type VaultImageData,
	type WebSearchBackendResolution,
} from "./query/direct-query-service";
import { LexicalVaultRetriever } from "./query/lexical-retrieval";
import type {
	CliModelDiscoveryResult,
	CodePracticeRequest,
	CodePracticeResult,
	CodexExecutionConfig,
	DashboardProcessHooks,
	DashboardProcessResult,
	ExecutionConfig,
	ExecutionOverrides,
	DashboardProcessEvent,
	LintReport,
	LintStatus,
	NormalizedProviderError,
	OkfExportStatus,
	ProviderConnectionTestResult,
	ProviderHttpRequestOptions,
	ProviderHttpResponse,
	ProviderHttpStreamOptions,
	ProviderHttpStreamResponse,
	ProviderRuntimeEntry,
	PracticeNotePayload,
	QueryMessage,
	QueryMessageStatus,
	QueryRetrievalMode,
	QuerySession,
	TaskRun,
	TaskRunUpdate,
} from "./types/contracts";











type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function normalizeQueryMessageStatus(value: unknown): QueryMessageStatus {
	const status = String(value || "");
	return status === "pending"
		|| status === "stopping"
		|| status === "done"
		|| status === "failed"
		|| status === "interrupted"
		? status
		: "done";
}

interface QuestionImageResolution {
	attachments: VaultImageAttachment[];
	notePaths: string[];
	discoveredCount: number;
	totalBytes: number;
}

interface VaultImageReference {
	title: string;
	path: string;
	count: number;
}

export default class AgentDashboardPlugin extends Plugin {
	settings: DashboardSettings = { ...DEFAULT_SETTINGS };
	taskRuns: TaskRun[] = [];
	querySessions: QuerySession[] = [];
	activeQuerySessionId = "";
	latestLintReport: LintReport | null = null;
	lastContextFile: TFile | null = null;

	private readonly lifecycleState = new DashboardLifecycleState();
	private readonly processExecution = new ProcessExecutionService(this.lifecycleState);
	private readonly obsidianCliService = new ObsidianCliService();
	private readonly providerTransport = new ProviderHttpTransport();
	private readonly directQueryService = new DirectQueryService({
		state: this.lifecycleState,
		processExecution: this.processExecution,
		getSettings: () => this.settings,
		getProviderProfile: (profileId) => this.getProviderProfile(profileId),
		createProvider: (profile) => this.createLLMProvider(profile),
		normalizeProviderError: (error) => this.normalizeProviderError(error),
		runRetrievalPreflight: (runId, question, expandedTerms) => {
			return this.runVaultRetrievalPreflight(runId, question, expandedTerms);
		},
		readEvidencePacket: (trace) => this.readVaultEvidencePacket(trace),
		readVaultImageData: (attachment) => this.readVaultImageData(attachment),
		resolveWebSearchBackend: (profile) => this.resolveWebSearchBackend(profile),
	});
	private readonly agentLoopService = new AgentLoopService({
		app: this.app,
		getSettings: () => this.settings,
		getProvider: (profileId) => {
			const profile = this.getProviderProfile(profileId);
			if (!profile || profile.lastTest?.ok !== true) return null;
			return {
				provider: this.createLLMProvider(profile),
				profileName: profile.name,
				model: profile.model,
			};
		},
		providerHttpRequest: (options) => this.providerHttpRequest(options),
		getTavilySecret: () => this.getTavilySecretValue(),
		getLexicalRetriever: () => this.getLexicalRetriever(),
		getVaultRoot: () => this.getActiveVaultRoot(),
		runMineruCommand: (request) => this.runMineruProcess(request),
	});
	private readonly lightAgentResults = new Map<string, AgentLoopRunOutcome>();
	private annotationService?: AnnotationService;
	private lexicalRetriever: LexicalVaultRetriever | null = null;
	private annotationPopover: AnnotationPopover | null = null;
	private annotationChip: HTMLElement | null = null;
	private persistence?: DashboardPersistence;
	private readonly cliModelDiscoveryCache = new Map<
		CliBackendId,
		{ expiresAt: number; signature: string; result: CliModelDiscoveryResult }
	>();
	private readonly cliModelDiscoveryInFlight = new Map<
		CliBackendId,
		Promise<CliModelDiscoveryResult>
	>();
	private mineruReaderActivationQueue: Promise<void> = Promise.resolve();
	private readonly readerAutoOpenBypass = new Set<string>();
	private readonly finishingTaskRunIds = new Set<string>();
	private taskRunMutationQueue: Promise<void> = Promise.resolve();
	obsidianCliProbeState: ObsidianCliProbeState = { status: "idle" };

	get providerRuntimeState(): Map<string, ProviderRuntimeEntry> {
		return this.lifecycleState.providerRuntimeState;
	}

	get providerEditorProfileId(): string {
		return this.lifecycleState.providerEditorProfileId;
	}

	set providerEditorProfileId(value: string) {
		this.lifecycleState.providerEditorProfileId = value;
	}

	private getPersistence(): DashboardPersistence {
		if (this.persistence) return this.persistence;
		this.persistence = new DashboardPersistence({
			load: () => this.loadData(),
			save: (data) => this.saveData(data),
			getState: () => ({
				settings: this.settings,
				taskRuns: this.taskRuns,
				querySessions: this.querySessions,
				activeQuerySessionId: this.activeQuerySessionId,
				latestLintReport: this.latestLintReport,
			}),
		});
		return this.persistence;
	}

	private withTaskRunMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.taskRunMutationQueue.then(operation, operation);
		this.taskRunMutationQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async persistTaskRunRetention(
		candidates: TaskRun[],
		limit: number,
	): Promise<void> {
		const kept = candidates.slice(0, limit);
		const overflow = candidates.slice(limit);
		const evictable = overflow.filter((oldRun) => (
			oldRun.status !== "running"
			&& oldRun.status !== "queued"
			&& !oldRun.cleanupPending
		));
		const protectedOverflow = overflow.filter((oldRun) => !evictable.includes(oldRun));
		if (!evictable.length) {
			this.taskRuns = [...kept, ...protectedOverflow];
			await this.saveSettings();
			return;
		}

		// Phase 1: keep every to-be-deleted run discoverable with a durable
		// cleanup marker. A crash before/during unlink can resume safely on load.
		const evictableIds = new Set(evictable.map((run) => run.id));
		this.taskRuns = candidates.map((run) => (
			evictableIds.has(run.id) ? { ...run, cleanupPending: true } : run
		));
		await this.saveSettings();

		const cleanupFailures: TaskRun[] = [];
		for (const oldRun of evictable) {
			try {
				await this.deleteTaskRunOutput(oldRun.id, oldRun.outputPath);
			} catch (error) {
				cleanupFailures.push({ ...oldRun, cleanupPending: true });
				console.warn(`Could not reclaim Dashboard task output for ${oldRun.id}`, error);
			}
		}
		const protectedIds = new Set([...kept, ...protectedOverflow].map((run) => run.id));
		const failedById = new Map(cleanupFailures.map((item) => [item.id, item]));
		this.taskRuns = candidates
			.filter((item) => protectedIds.has(item.id) || failedById.has(item.id))
			.map((item) => failedById.get(item.id) || item);
		try {
			await this.saveSettings();
		} catch (error) {
			// Disk still has phase-1 markers, so startup can converge even though
			// this final reference-removal save failed.
			console.warn("Could not finalize Dashboard task-output cleanup markers", error);
		}
	}

	async onload(): Promise<void> {
		this.getPersistence();
		this.annotationService = new AnnotationService(this.app, this);
		this.lastContextFile = this.app.workspace.getActiveFile();
		await this.loadSettings();
		this.recoverInterruptedPracticeRuns();
		this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
		this.registerView(CODE_PRACTICE_VIEW_TYPE, (leaf) => new CodePracticeView(leaf, this));
		this.registerView(QUERY_WIKI_VIEW_TYPE, (leaf) => new QueryWikiView(leaf, this));
		this.registerView(MINERU_READER_VIEW_TYPE, (leaf) => new MineruReaderView(leaf, this));
		this.app.workspace.onLayoutReady(() => {
			this.consolidateMineruReaderLeaves();
			const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (markdownView?.file && this.isConfiguredReaderMarkdownFile(markdownView.file)) {
				void this.activateMineruReaderView(markdownView.file.path, markdownView.leaf);
			}
		});
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file?.extension === "md") this.lastContextFile = file;
			if (!this.isConfiguredReaderMarkdownFile(file)) return;
			const normalizedPath = normalizePath(file.path);
			if (this.readerAutoOpenBypass.delete(normalizedPath)) return;
			window.setTimeout(() => {
				let markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView?.file?.path !== file.path) markdownView = null;
				if (!markdownView) {
					this.app.workspace.iterateAllLeaves((leaf) => {
						if (
							!markdownView
							&& leaf.view instanceof MarkdownView
							&& leaf.view.file?.path === file.path
						) markdownView = leaf.view;
					});
				}
				if (markdownView) void this.activateMineruReaderView(file.path, markdownView.leaf);
			}, 50);
		}));
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!this.isReaderDocumentFile(file)) return;
			menu.addItem((item) => {
				item
					.setTitle("在文献阅读器中打开")
					.setIcon("book-open-text")
					.onClick(() => {
						void this.activateMineruReaderView(file.path);
					});
			});
		}));
		this.registerMarkdownPostProcessor((element, context) => {
			this.annotationService?.decorateMarkdownSection(element, context);
		});
		this.registerDomEvent(document, "click", (event) => {
			void this.handleAnnotationLinkClick(event);
		}, { capture: true });
		this.registerDomEvent(document, "mouseover", (event) => {
			const link = event.target instanceof Element
				? event.target.closest<HTMLAnchorElement>(
					'a.internal-link[data-href^="wiki/annotations/"][data-href*="#^ann-"]',
				)
				: null;
			if (link) event.stopPropagation();
		}, { capture: true });
		this.registerDomEvent(document, "mouseup", () => {
			window.setTimeout(() => this.showAnnotationChip(), 0);
		}, { capture: true });
		this.registerDomEvent(document, "scroll", () => this.hideAnnotationChip(), { capture: true });
		this.registerDomEvent(document, "mousedown", (event) => {
			const insideChip = event.target instanceof Node
				&& this.annotationChip?.contains(event.target) === true;
			if (!insideChip) this.hideAnnotationChip();
		}, { capture: true });
		this.addRibbonIcon("layout-dashboard", "打开研究知识库控制台", () => {
			this.activateDashboardView();
		});
		this.addStatusBarItem().setText("智能体控制台：本地");
		this.addCommand({
			id: "open-research-dashboard",
			name: "打开研究知识库控制台",
			callback: () => {
				this.activateDashboardView();
			},
		});
		this.addCommand({
			id: "open-code-practice",
			name: "打开代码练习",
			callback: () => {
				this.activateCodePracticeView();
			},
		});
		this.addCommand({
			id: "open-query-wiki",
			name: "打开知识库对话",
			callback: () => {
				this.activateQueryWikiView();
			},
		});
		this.addCommand({
			id: "open-mineru-reader",
			name: "打开文献阅读器",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile() || this.lastContextFile;
				if (!this.isReaderDocumentFile(file)) return false;
				if (!checking) void this.activateMineruReaderView(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "annotate-selected-text",
			name: "批注所选文字",
			checkCallback: (checking) => {
				if (!this.annotationService?.canCaptureSelection()) return false;
				if (!checking) void this.openSelectionAnnotation();
				return true;
			},
		});
		this.addSettingTab(new AgentDashboardSettingTab(this.app, this));
	}

	onunload(): void {
		this.annotationPopover?.close();
		this.hideAnnotationChip();
		void this.flushScheduledSettingsSave();
		this.agentLoopService.shutdown();
		this.processExecution.shutdown();
	}

	getDashboardAction(actionId: string): DashboardAction | null {
		return ACTION_BY_ID.get(actionId) || null;
	}

	async openSelectionAnnotation(): Promise<void> {
		if (!this.annotationService) return;
		try {
			const selection = await this.annotationService.captureSelection();
			this.openAnnotationPopover({
				anchorRect: selection.anchorRect,
				selection,
			});
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Floating 批注 chip for any text selection inside a Markdown view — the
	 * reader, reading mode, and Live Preview/source mode alike. Editor-mode
	 * selections have no native DOM selection, so their anchor rectangle comes
	 * from the editor coordinates.
	 */
	private showAnnotationChip(): void {
		this.hideAnnotationChip();
		if (!this.annotationService?.canCaptureSelection()) return;
		const selection = window.getSelection();
		let rect: DOMRect | null = null;
		if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
			const range = selection.getRangeAt(0);
			const anchorElement = range.startContainer instanceof Element
				? range.startContainer
				: range.startContainer.parentElement;
			if (!anchorElement?.closest(".markdown-source-view, .markdown-reading-view")) return;
			if (anchorElement.closest(".agent-annotation-popover, input, textarea, button, pre, code")) {
				return;
			}
			rect = range.getBoundingClientRect();
		} else {
			rect = this.editorSelectionRect();
		}
		if (!rect) return;
		const chip = document.body.createDiv({ cls: "agent-dashboard-mineru-annotate-chip" });
		const button = chip.createEl("button", {
			cls: "agent-dashboard-mineru-annotate-chip-button",
			text: "批注",
			attr: { type: "button", title: "批注所选文字" },
		});
		const left = Math.min(Math.max(8, rect.right + 8), Math.max(8, window.innerWidth - 72));
		const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 44));
		chip.style.left = `${left}px`;
		chip.style.top = `${top}px`;
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.hideAnnotationChip();
			void this.openSelectionAnnotation();
		});
		this.annotationChip = chip;
	}

	private editorSelectionRect(): DOMRect | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		const ranges = editor?.listSelections?.() ?? [];
		if (!editor || !ranges.length) return null;
		const range = ranges[0];
		const headOffset = editor.posToOffset(range.head);
		const anchorOffset = editor.posToOffset(range.anchor);
		// CM6 coordinates through the structurally typed underlying view.
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
			? cmView.coordsAtPos(Math.max(headOffset, anchorOffset))
			: null;
		if (!coords) return null;
		return new DOMRect(
			coords.left,
			coords.top,
			1,
			Math.max(1, coords.bottom - coords.top),
		);
	}

	private hideAnnotationChip(): void {
		this.annotationChip?.remove();
		this.annotationChip = null;
	}

	private openAnnotationPopover(options: {
		anchorRect: DOMRect;
		selection?: AnnotationSelection;
		record?: AnnotationRecord;
	}): void {
		if (!this.annotationService) return;
		this.annotationPopover?.close();
		const popover = new AnnotationPopover({
			app: this.app,
			service: this.annotationService,
			...options,
			onArchive: (record) => this.archiveAnnotation(record),
			onClose: () => {
				if (this.annotationPopover === popover) this.annotationPopover = null;
			},
		});
		this.annotationPopover = popover;
		popover.open();
	}

	private async handleAnnotationLinkClick(event: MouseEvent): Promise<void> {
		if (!this.annotationService || event.button !== 0) return;
		const target = event.target instanceof Element
			? event.target.closest<HTMLAnchorElement>("a.internal-link")
			: null;
		if (!target) return;
		const rawHref = String(target.dataset.href || target.getAttribute("href") || "");
		let href = rawHref;
		try {
			href = decodeURIComponent(rawHref);
		} catch {
			href = rawHref;
		}
		href = href.replace(/^app:\/\/obsidian\.md\//, "").replace(/^\/+/, "");
		const match = /^(wiki\/annotations\/[^#]+?)(?:\.md)?#\^(ann-[a-z0-9-]+)$/i.exec(href);
		if (!match) return;
		event.preventDefault();
		event.stopPropagation();
		const record = await this.annotationService.loadAnnotation(match[1], match[2]);
		if (!record) {
			new Notice("未找到对应的批注记录");
			return;
		}
		if (event.ctrlKey || event.metaKey) {
			if (!record.archiveTargets.length) {
				new Notice("该批注尚未关联正式知识节点");
				return;
			}
			if (record.archiveTargets.length === 1) {
				await this.annotationService.openArchiveTarget(record, record.archiveTargets[0]);
				return;
			}
			const menu = new Menu();
			record.archiveTargets.forEach((archiveTarget) => {
				menu.addItem((item) => {
					item
						.setTitle(archiveTarget.split("/").pop() || archiveTarget)
						.setIcon("file-text")
						.onClick(() => {
							void this.annotationService?.openArchiveTarget(record, archiveTarget);
						});
				});
			});
			menu.showAtMouseEvent(event);
			return;
		}
		if (event.shiftKey) {
			await this.annotationService.openAnnotationDocument(record);
			return;
		}
		this.openAnnotationPopover({
			anchorRect: target.getBoundingClientRect(),
			record,
		});
	}

	private async archiveAnnotation(record: AnnotationRecord): Promise<void> {
		if (!this.annotationService) return;
		const action = ACTION_BY_ID.get("synthesis");
		if (!action) {
			new Notice("综合分析操作未注册");
			return;
		}
		if (this.isActionRunning(action.id)) {
			await this.annotationService.updateArchiveState(record, {
				archiveStatus: "failed",
				archiveError: "综合分析正在运行，请稍后重试",
			});
			new Notice("综合分析正在运行，批注已保留但尚未归档");
			return;
		}
		const executionConfig = this.resolveActionExecutionConfig(action);
		const run = await this.startTaskRun(
			action,
			`归档批注：${record.selectedText.slice(0, 80)}`,
			executionConfig,
		);
		record = await this.annotationService.updateArchiveState(record, {
			archiveStatus: "pending",
			archiveRunId: run.id,
			archiveError: "",
		});
		new Notice("批注已保留，正在交给综合分析归档");
		const request = [
			"处理一条由 Research Agent Reader 批注功能提交的正式知识归档请求。",
			`批注文档：${record.annotationPath}#^${record.id}`,
			`来源文档：${record.sourcePath}`,
			record.section ? `所在章节：${record.section}` : "",
			`选中文字：${record.selectedText}`,
			"",
			"初步解释：",
			record.aiText,
			"",
			"请检查来源文档、现有 source note、method、concept、dataset、entity、代码笔记和索引。",
			"判断该内容适合归入哪类正式知识节点；优先更新已有规范节点，只有不存在合适节点时才创建新节点。",
			"区分来源文档证据、一般背景和未解决问题，并按 research-vault-synthesis 的规则更新拥有的索引与日志。",
			"不要修改批注文档，Dashboard 会在任务完成后写回关联。",
			"",
			"最终回答最后一行必须严格使用以下格式，列出本次创建或更新的知识节点路径（相对 Obsidian vault 根目录、不带 .md）：",
			'ANNOTATION_ARCHIVE_TARGETS: ["wiki/methods/example"]',
		].filter(Boolean).join("\n");
		try {
			const result = await this.runVaultAction(
				run.id,
				action,
				request,
				executionConfig,
			);
			const output = [
				result.stdout.trim(),
				result.stderr.trim() ? `运行日志\n${result.stderr.trim()}` : "",
			].filter(Boolean).join("\n\n").slice(0, 120000);
			const processSucceeded = result.exitCode === 0;
			const archiveTargets = processSucceeded
				? this.parseAnnotationArchiveTargets(result.stdout)
				: [];
			const integrationError = processSucceeded && !archiveTargets.length
				? "综合分析已完成，但没有返回可关联的知识节点路径"
				: "";
			const success = processSucceeded && !integrationError;
			await this.finishTaskRun(run.id, {
				status: success ? "done" : result.exitCode === 130 ? "interrupted" : "failed",
				exitCode: result.exitCode,
				output,
				error: success
					? ""
					: integrationError || `进程退出码：${result.exitCode}`,
			});
			if (!processSucceeded) {
				throw new Error(result.stderr.trim() || `综合分析退出码：${result.exitCode}`);
			}
			if (integrationError) throw new Error(integrationError);
			await this.annotationService.updateArchiveState(record, {
				archiveStatus: "completed",
				archiveTargets,
				archiveError: "",
			});
			new Notice(`批注归档完成，已关联 ${archiveTargets.length} 个知识节点`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const task = this.getTaskRun(run.id);
			if (task?.status === "running") {
				await this.finishTaskRun(run.id, {
					status: "failed",
					exitCode: null,
					output: "",
					error: message,
				});
			}
			await this.annotationService.updateArchiveState(record, {
				archiveStatus: "failed",
				archiveError: message.slice(0, 500),
			});
			new Notice(`批注已保留，但归档失败：${message}`);
		}
	}

	private parseAnnotationArchiveTargets(output: string): string[] {
		const match = /ANNOTATION_ARCHIVE_TARGETS:\s*(\[[^\r\n]*\])/i.exec(output);
		if (!match) return [];
		try {
			const values = JSON.parse(match[1]) as unknown;
			if (!Array.isArray(values)) return [];
			return [...new Set(values
				.map((value) => String(value || "")
					.trim()
					.replace(/^\[\[/, "")
					.replace(/\]\]$/, "")
					.split("|", 1)[0]
					.replace(/^knowledge-base\//, "")
					.replace(/\.md$/i, "")
					.replace(/^\/+/, ""))
				.filter((value) => /^wiki\/(methods|concepts|datasets|entities|projects|mocs|synthesis)\//.test(value))
			)];
		} catch {
			return [];
		}
	}

	createPracticeRunId(): string {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, "0");
		const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		return `${stamp}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
	}

	recoverInterruptedPracticeRuns(): void {
		this.processExecution.recoverInterruptedPracticeRuns(this.settings);
	}

	runCodePractice(request: CodePracticeRequest): Promise<CodePracticeResult> {
		return this.processExecution.runCodePractice(this.settings, request);
	}

	stopCodePractice(runId: string): boolean {
		return this.processExecution.stopCodePractice(runId);
	}

	readPracticeFigure(relativePath: string): string {
		const root = path.resolve(this.settings.toolkitRoot);
		const outputRoot = path.join(root, "tool-library", "output", "code-practice", "figures");
		const candidate = path.resolve(root, relativePath);
		const relative = path.relative(outputRoot, candidate);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(candidate)) return "";
		const stat = fs.statSync(candidate);
		if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return "";
		const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" }[path.extname(candidate).toLowerCase()];
		if (!mime) return "";
		return `data:${mime};base64,${fs.readFileSync(candidate).toString("base64")}`;
	}

	async savePracticeNote(payload: PracticeNotePayload): Promise<TFile> {
		const folder = normalizePath("wiki/code/practice");
		await this.ensureVaultFolder(folder);
		const cells = Array.isArray(payload.cells) ? payload.cells.filter((cell) => String(cell.code || "").trim() || cell.result) : [];
		if (!cells.length) throw new Error("没有可保存的练习单元格");
		const lastResult = [...cells].reverse().find((cell) => cell.result)?.result || null;
		const now = new Date();
		const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		const slugBase = payload.title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
		const fallback = `practice-${date.split("-").join("")}-${lastResult?.run_id.slice(-6) || Date.now()}`;
		let notePath = normalizePath(`${folder}/${slugBase || fallback}.md`);
		if (this.app.vault.getAbstractFileByPath(notePath)) {
			notePath = normalizePath(`${folder}/${slugBase || "practice"}-${lastResult?.run_id.slice(-6) || Date.now()}.md`);
		}
		if (this.app.vault.getAbstractFileByPath(notePath)) throw new Error(`目标笔记已存在：${notePath}`);

		const languageLabel = payload.language === "r" ? "R" : "Python";
		const relatedTarget = payload.relatedNotePath ? payload.relatedNotePath.replace(/\.md$/i, "") : "";
		const relatedLink = relatedTarget ? `[[${relatedTarget}]]` : "";
		const fence = (value: unknown) => String(value || "").includes("```") ? "````" : "```";
		const cellSections = cells.flatMap((cell, index) => {
			const result = cell.result;
			const codeFence = fence(cell.code);
			const outputFence = fence(result?.stdout);
			const errorFence = fence(result?.stderr);
			const lines = [
				`### 单元格 ${index + 1}`,
				"",
				`执行编号：${cell.executionCount ?? "未运行"}  `,
				`状态：${result?.status || "未运行"}`,
				"",
				`${codeFence}${payload.language === "r" ? "r" : "python"}`,
				String(cell.code || ""),
				codeFence,
			];
			if (!result) return [...lines, ""];
			lines.push(
				"",
				`运行编号：${result.run_id || "-"}  `,
				`耗时：${Number(result.duration_ms || 0) / 1000} 秒  `,
				`退出码：${result.exit_code ?? "-"}`,
				"",
				"#### 标准输出",
				"",
				`${outputFence}text`,
				result.stdout || "（无）",
				outputFence,
			);
			if (result.stderr) {
				const stderrTitle = ["failed", "timeout"].includes(result.status)
					? "错误与诊断（stderr）"
					: result.status === "stopped"
						? "运行消息（stderr）"
						: "消息与警告（stderr）";
				lines.push("", `#### ${stderrTitle}`, "", `${errorFence}text`, result.stderr, errorFence);
			}
			if (result.figures?.length) {
				lines.push("", "#### 生成图片", "", ...result.figures.map((value) => `- \`${value}\``));
			}
			return [...lines, ""];
		});
		const body = [
			"---",
			"type: code-practice",
			`title: ${JSON.stringify(payload.title)}`,
			`language: ${languageLabel}`,
			`related_note: ${JSON.stringify(relatedLink)}`,
			"execution_mode: stateless-replay",
			`cell_count: ${cells.length}`,
			`last_run_id: ${lastResult?.run_id || ""}`,
			`status: ${lastResult?.status || "not-run"}`,
			`created: ${date}`,
			`updated: ${date}`,
			"tags:",
			"  - code-practice",
			`  - ${languageLabel}`,
			"---",
			"",
			"## 目标",
			"",
			payload.goal || "记录并验证本次代码练习。",
			"",
			"## 单元格",
			"",
			...cellSections,
			"## 说明",
			"",
			payload.notes || "本页使用无状态累计重放：每次运行都会启动新进程，并在执行目标单元格前重放其前置单元格。",
			"",
			"## 关联",
			"",
			relatedLink ? `- 相关笔记：${relatedLink}` : "- 相关笔记：未关联",
			"",
		].join("\n");
		return this.app.vault.create(notePath, body);
	}

	async ensureVaultFolder(folderPath: string): Promise<void> {
		let current = "";
		for (const segment of normalizePath(folderPath).split("/")) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
		}
	}

	async loadSettings(): Promise<void> {
		const stored = await this.getPersistence().load();
		const rawStoredSettings = stored.settings && typeof stored.settings === "object" ? stored.settings : stored;
		const { settings: storedSettings, changed: migratedLegacyKeys } = migrateLegacySettingsKeys(
			asRecord(rawStoredSettings),
		);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings) as DashboardSettings;
		const normalizedProfiles = Array.isArray(storedSettings.providerProfiles)
			? storedSettings.providerProfiles.slice(0, 20).map((profile) => normalizeProviderProfile(profile))
			: [];
		this.settings.providerProfiles = normalizedProfiles;
		this.settings.activeProviderId = String(storedSettings.activeProviderId || "");
		const providerTimeout = Number.parseInt(String(storedSettings.providerTimeoutSeconds || ""), 10);
		this.settings.providerTimeoutSeconds = Number.isFinite(providerTimeout)
			? Math.max(3, Math.min(120, providerTimeout))
			: DEFAULT_SETTINGS.providerTimeoutSeconds;
		const taskHistoryLimit = Number.parseInt(String(storedSettings.taskHistoryLimit || ""), 10);
		this.settings.taskHistoryLimit = Number.isFinite(taskHistoryLimit)
			? Math.max(5, Math.min(100, taskHistoryLimit))
			: DEFAULT_SETTINGS.taskHistoryLimit;
		const querySessionLimit = Number.parseInt(String(storedSettings.querySessionLimit || ""), 10);
		this.settings.querySessionLimit = Number.isFinite(querySessionLimit)
			? Math.max(1, Math.min(30, querySessionLimit))
			: DEFAULT_SETTINGS.querySessionLimit;
		const queryMessageLimit = Number.parseInt(String(storedSettings.queryMessageLimit || ""), 10);
		this.settings.queryMessageLimit = Number.isFinite(queryMessageLimit)
			? Math.max(10, Math.min(100, queryMessageLimit))
			: DEFAULT_SETTINGS.queryMessageLimit;
		const storedTaskRunRecords = new Map<string, Record<string, unknown>>(
			(Array.isArray(stored.taskRuns) ? stored.taskRuns.slice(0, 300) : [])
				.map((item) => asRecord(item))
				.map((record) => [String(record.id || ""), record]),
		);
		this.taskRuns = normalizeStoredTaskRuns(stored.taskRuns, this.settings.taskHistoryLimit);
		this.querySessions = Array.isArray(stored.querySessions)
			? stored.querySessions
				.slice(0, this.settings.querySessionLimit)
				.map((session) => this.normalizeQuerySession(session))
			: [];
		this.activeQuerySessionId = typeof stored.activeQuerySessionId === "string"
			? stored.activeQuerySessionId
			: "";
		this.latestLintReport = this.normalizeLintReport(stored.latestLintReport);
		if (!this.settings.toolkitRoot) {
			this.settings.toolkitRoot = this.inferToolkitRoot();
		}
		let changed = migratedLegacyKeys;
		// Resume only explicitly journaled cleanup. A canonical sidecar without a
		// matching marker remains recovery data and is never swept merely because
		// data.json is temporarily incomplete or restored from an older copy.
		const retainedTaskRuns: TaskRun[] = [];
		for (const run of this.taskRuns) {
			if (!run.cleanupPending) {
				retainedTaskRuns.push(run);
				continue;
			}
			try {
				await this.deleteTaskRunOutput(run.id, run.outputPath);
				changed = true;
			} catch (error) {
				retainedTaskRuns.push(run);
				console.warn(`Could not resume Dashboard task-output cleanup for ${run.id}`, error);
			}
		}
		this.taskRuns = retainedTaskRuns;
		try {
			const cleanup = await cleanupTaskRunStorage(
				this.settings.toolkitRoot,
				new Set(this.taskRuns.map((run) => run.id)),
			);
			if (cleanup.failures.length) {
				console.warn("Could not reclaim some Dashboard task-output files", cleanup.failures);
			}
		} catch (error) {
			console.warn("Could not inspect Dashboard task-output storage", error);
		}
		// A terminal output sidecar is committed before data.json. Reconcile it
		// before the generic running→interrupted recovery so a failed final
		// settings save cannot erase a real completion or its artifacts.
		for (const run of this.taskRuns) {
			if (run.cleanupPending) continue;
			if (run.completionPending) {
				run.completionPending = undefined;
				changed = true;
			}
			const completion = readTaskRunCompletion(this.settings.toolkitRoot, run.id);
			const activeRun = run.status === "running" || run.status === "queued";
			if (
				!completion
				|| completion.actionId !== run.actionId
				|| completion.startedAt !== run.startedAt
				|| (!activeRun && (
					run.finishedAt !== completion.finishedAt
					|| run.status !== completion.status
					|| run.exitCode !== completion.exitCode
				))
			) continue;
			const recoveredArtifacts = normalizeTaskRunArtifacts(completion.artifacts);
			const recoveredOutput = completion.output.slice(0, 12000);
			const recoveredError = completion.error.slice(0, 4000);
			const recoveredSummary = completion.summary.slice(0, 4000);
			const differs = run.status !== completion.status
				|| run.exitCode !== completion.exitCode
				|| run.finishedAt !== completion.finishedAt
				|| run.output !== recoveredOutput
				|| run.outputPath !== completion.relativePath
				|| run.error !== recoveredError
				|| run.summary !== recoveredSummary
				|| JSON.stringify(run.artifacts) !== JSON.stringify(recoveredArtifacts);
			if (differs) {
				run.status = completion.status;
				run.exitCode = completion.exitCode;
				run.finishedAt = completion.finishedAt;
				run.output = recoveredOutput;
				run.outputPath = completion.relativePath;
				run.error = recoveredError;
				run.summary = recoveredSummary;
				run.artifacts = recoveredArtifacts;
				changed = true;
			}
		}
		const normalizedReaderFolders = normalizeReaderMarkdownFolders(
			storedSettings.readerMarkdownFolders ?? DEFAULT_SETTINGS.readerMarkdownFolders,
		);
		if (
			JSON.stringify(storedSettings.readerMarkdownFolders ?? DEFAULT_SETTINGS.readerMarkdownFolders)
			!== JSON.stringify(normalizedReaderFolders)
		) changed = true;
		this.settings.readerMarkdownFolders = normalizedReaderFolders;
		if (
			JSON.stringify(storedSettings.providerProfiles || []) !== JSON.stringify(normalizedProfiles)
			|| this.hasPlaintextCredentialFields(storedSettings)
		) {
			changed = true;
		}
		if (
			this.settings.activeProviderId
			&& !normalizedProfiles.some(
				(profile) => profile.id === this.settings.activeProviderId && profile.lastTest?.ok,
			)
		) {
			this.settings.activeProviderId = "";
			changed = true;
		}
		if (!this.querySessions.length) {
			const session = this.makeQuerySession();
			this.querySessions = [session];
			this.activeQuerySessionId = session.id;
			changed = true;
		}
		if (!this.querySessions.some((session) => session.id === this.activeQuerySessionId)) {
			this.activeQuerySessionId = this.querySessions[0].id;
			changed = true;
		}
		this.querySessions = this.querySessions.map((session) => {
			const queryBackendId = this.resolveQueryBackendId(session.queryBackendId);
			const retrievalMode = (
				queryBackendId === "codex-cli"
				|| queryBackendId === "claude-code"
				|| queryBackendId === "opencode"
			)
				? session.retrievalMode
				: "vault";
			if (queryBackendId !== session.queryBackendId || retrievalMode !== session.retrievalMode) {
				changed = true;
			}
			const messages: QueryMessage[] = session.messages.map((message) => {
				if (!["pending", "stopping"].includes(message.status)) return message;
				changed = true;
				return {
					...message,
					status: "interrupted" as const,
					progress: "",
					error: "Obsidian 或插件在回答完成前关闭，本轮查询已标记为中断。",
				};
			});
			return { ...session, queryBackendId, retrievalMode, messages };
		});
		const preferredCodexExecutable = findPreferredCodexExecutable();
		const preferredObsidianCliExecutable = findPreferredObsidianCliExecutable();
		const configuredObsidianCliExecutable = String(storedSettings.obsidianCliExecutable || "").trim();
		if (configuredObsidianCliExecutable) {
			this.settings.obsidianCliExecutable = configuredObsidianCliExecutable;
		} else if (preferredObsidianCliExecutable) {
			this.settings.obsidianCliExecutable = preferredObsidianCliExecutable;
			changed = true;
		}
		const configuredCodexExecutable = String(this.settings.codexExecutable || "").trim();
		if (
			!configuredCodexExecutable
			|| isManagedCodexExecutable(configuredCodexExecutable)
		) {
			if (
				preferredCodexExecutable
				&& configuredCodexExecutable !== preferredCodexExecutable
			) {
				this.settings.codexExecutable = preferredCodexExecutable;
				changed = true;
			}
		}
		if (!["official", "cc-switch"].includes(String(storedSettings.codexConfigSource || ""))) {
			this.settings.codexConfigSource = "official";
			changed = true;
		}
		const preferredClaudeExecutable = findPreferredClaudeExecutable();
		const configuredClaudeExecutable = String(this.settings.claudeExecutable || "").trim();
		if (!configuredClaudeExecutable && preferredClaudeExecutable) {
			this.settings.claudeExecutable = preferredClaudeExecutable;
			changed = true;
		}
		if (!["official", "cc-switch"].includes(String(storedSettings.claudeConfigSource || ""))) {
			this.settings.claudeConfigSource = inferLegacyClaudeConfigSource();
			changed = true;
		}
		const preferredOpenCodeExecutable = findPreferredOpenCodeExecutable();
		const configuredOpenCodeExecutable = String(this.settings.openCodeExecutable || "").trim();
		if (!configuredOpenCodeExecutable && preferredOpenCodeExecutable) {
			this.settings.openCodeExecutable = preferredOpenCodeExecutable;
			changed = true;
		}
		const preferredMineruExecutable = findPreferredMineruExecutable();
		const configuredMineruExecutable = String(this.settings.mineruExecutable || "").trim();
		if (!configuredMineruExecutable && preferredMineruExecutable) {
			this.settings.mineruExecutable = preferredMineruExecutable;
			changed = true;
		}
		this.settings.mineruServiceMode = storedSettings.mineruServiceMode === "private"
			|| (!storedSettings.mineruServiceMode && Boolean(String(storedSettings.mineruBaseUrl || "").trim()))
			? "private"
			: "official";
		if (this.settings.mineruServiceMode === "official" && this.settings.mineruBaseUrl) {
			this.settings.mineruBaseUrl = "";
			changed = true;
		}
		this.settings.mineruDefaultModel = storedSettings.mineruDefaultModel === "pipeline"
			|| storedSettings.mineruDefaultModel === "auto"
			? storedSettings.mineruDefaultModel
			: "vlm";
		const mineruLanguages = [
			"en", "ch", "ch_server", "japan", "korean", "latin", "arabic", "cyrillic", "devanagari",
		];
		this.settings.mineruDefaultLanguage = mineruLanguages.includes(
			String(storedSettings.mineruDefaultLanguage || ""),
		)
			? String(storedSettings.mineruDefaultLanguage)
			: DEFAULT_SETTINGS.mineruDefaultLanguage;
		this.settings.mineruDefaultOcr = storedSettings.mineruDefaultOcr === true;
		this.settings.mineruDefaultFormula = storedSettings.mineruDefaultFormula !== false;
		this.settings.mineruDefaultTable = storedSettings.mineruDefaultTable !== false;
		const mineruTimeout = Number.parseInt(String(storedSettings.mineruDefaultTimeoutSeconds || ""), 10);
		this.settings.mineruDefaultTimeoutSeconds = Number.isFinite(mineruTimeout)
			? Math.max(60, Math.min(1800, mineruTimeout))
			: DEFAULT_SETTINGS.mineruDefaultTimeoutSeconds;
		this.settings.mineruDefaultIncludeSourcePdf = storedSettings.mineruDefaultIncludeSourcePdf !== false;
		this.settings.mineruDefaultArticleWikiSource = storedSettings.mineruDefaultArticleWikiSource === "pdf"
			|| storedSettings.mineruDefaultArticleWikiSource === "article"
			? storedSettings.mineruDefaultArticleWikiSource
			: "auto";
		this.settings.mineruConfirmRemoteUpload = storedSettings.mineruConfirmRemoteUpload === true;
		this.settings.mineruReaderDefaultMode = storedSettings.mineruReaderDefaultMode === "visuals"
			? "visuals"
			: "pdf";
		this.settings.mineruReaderFollowPdfReading = storedSettings.mineruReaderFollowPdfReading !== false;
		this.settings.mineruReaderFollowVisualReading = storedSettings.mineruReaderFollowVisualReading !== false;
		this.settings.mineruReaderShowLayoutBoxes = storedSettings.mineruReaderShowLayoutBoxes !== false;
		const readerZoom = Number(storedSettings.mineruReaderPdfZoom);
		this.settings.mineruReaderPdfZoom = Number.isFinite(readerZoom)
			? Math.max(0.4, Math.min(4, readerZoom))
			: DEFAULT_SETTINGS.mineruReaderPdfZoom;
		const splitRatio = Number(storedSettings.mineruReaderSplitRatio);
		this.settings.mineruReaderSplitRatio = Number.isFinite(splitRatio)
			? Math.max(0.42, Math.min(0.78, splitRatio))
			: DEFAULT_SETTINGS.mineruReaderSplitRatio;
		this.settings.mineruReaderRenderQuality = storedSettings.mineruReaderRenderQuality === "high"
			? "high"
			: "standard";
		this.settings.actionExecutionDefaults = normalizeActionExecutionDefaults(
			storedSettings.actionExecutionDefaults,
		);
		this.settings.queryDefaultRetrievalMode = storedSettings.queryDefaultRetrievalMode === "vault"
			? "vault"
			: "web";
		this.settings.queryDefaultBackendId = String(
			storedSettings.queryDefaultBackendId || "codex-cli",
		).slice(0, 160);
		const normalizedQueryDefaultBackend = this.resolveQueryBackendId(
			this.settings.queryDefaultBackendId,
		);
		if (normalizedQueryDefaultBackend !== this.settings.queryDefaultBackendId) {
			this.settings.queryDefaultBackendId = normalizedQueryDefaultBackend;
			changed = true;
		}
		const legacySettings = this.settings as unknown as Record<string, unknown>;
		if ("paper2mdRoot" in legacySettings) {
			delete legacySettings.paper2mdRoot;
			changed = true;
		}
		if (!["official", "cc-switch"].includes(String(storedSettings.openCodeConfigSource || ""))) {
			this.settings.openCodeConfigSource = "official";
			changed = true;
		}
		if (!storedSettings.codexModel || storedSettings.codexModel === "gpt-5.5") {
			this.settings.codexModel = "gpt-5.6-terra";
			changed = true;
		}
		if (!REASONING_OPTIONS.some((option) => option.id === this.settings.codexReasoningEffort)) {
			this.settings.codexReasoningEffort = DEFAULT_SETTINGS.codexReasoningEffort;
			changed = true;
		}
		if (!REASONING_OPTIONS.some((option) => option.id === this.settings.claudeReasoningEffort)) {
			this.settings.claudeReasoningEffort = DEFAULT_SETTINGS.claudeReasoningEffort;
			changed = true;
		}
		if (!REASONING_OPTIONS.some((option) => option.id === this.settings.openCodeReasoningEffort)) {
			this.settings.openCodeReasoningEffort = DEFAULT_SETTINGS.openCodeReasoningEffort;
			changed = true;
		}
		const annotationBackendId = String(this.settings.annotationBackendId || "auto");
		if (
			!["auto", "codex-cli", "claude-code", "opencode"].includes(annotationBackendId)
			&& !normalizedProfiles.some(
				(profile) => profile.id === annotationBackendId && profile.lastTest?.ok,
			)
		) {
			this.settings.annotationBackendId = "auto";
			changed = true;
		}
		if (
			this.settings.annotationWebSearchEnabled === true
			&& !["auto", "codex-cli", "claude-code", "opencode"].includes(
				this.settings.annotationBackendId,
			)
		) {
			this.settings.annotationBackendId = "codex-cli";
			changed = true;
		}
		if (!REASONING_OPTIONS.some((option) => option.id === this.settings.annotationCodexReasoningEffort)) {
			this.settings.annotationCodexReasoningEffort = DEFAULT_SETTINGS.annotationCodexReasoningEffort;
			changed = true;
		}
		if (!REASONING_OPTIONS.some((option) => option.id === this.settings.annotationClaudeReasoningEffort)) {
			this.settings.annotationClaudeReasoningEffort = DEFAULT_SETTINGS.annotationClaudeReasoningEffort;
			changed = true;
		}
		if (!REASONING_OPTIONS.some((option) => option.id === this.settings.annotationOpenCodeReasoningEffort)) {
			this.settings.annotationOpenCodeReasoningEffort = DEFAULT_SETTINGS.annotationOpenCodeReasoningEffort;
			changed = true;
		}
		if (!["default", "fast"].includes(this.settings.annotationCodexServiceTier)) {
			this.settings.annotationCodexServiceTier = "default";
			changed = true;
		}
		const annotationMaxTokens = Number.parseInt(
			String(this.settings.annotationMaxTokens || ""),
			10,
		);
		this.settings.annotationMaxTokens = Number.isFinite(annotationMaxTokens)
			? Math.max(128, Math.min(4096, annotationMaxTokens))
			: DEFAULT_SETTINGS.annotationMaxTokens;
		this.taskRuns = this.taskRuns.map((run) => {
			if (
				run.actionId === "vault-lint"
				&& run.status === "failed"
				&& run.exitCode === 1
				&& String(run.output || "").includes("Vault lint: score")
			) {
				changed = true;
				return { ...run, status: "done", error: "" };
			}
			if (run.status !== "running" && run.status !== "queued") return run;
			changed = true;
			return {
				...run,
				status: "interrupted",
				finishedAt: new Date().toISOString(),
				error: "Obsidian 或插件在任务完成前关闭，运行状态已标记为中断。",
			};
		});
		// Migrate legacy inline outputs only after every TaskRun state migration.
		// Schema-v2 sidecars bind status/timestamps, so writing them earlier would
		// make a subsequently interrupted/normalized run unreadable on reload.
		for (const run of this.taskRuns) {
			if (run.cleanupPending) continue;
			const legacyFullOutput = String(storedTaskRunRecords.get(run.id)?.output || "");
			if (!run.outputPath && legacyFullOutput.length > 12000) {
				try {
					const outputPath = await this.persistTaskRunOutput({
						...run,
						output: legacyFullOutput,
					});
					if (!outputPath) throw new Error("插件本地任务输出目录不可用");
					run.outputPath = outputPath;
					changed = true;
				} catch (error) {
					console.warn("Could not migrate Dashboard run output", error);
					throw new Error(
						`无法安全迁移旧版完整任务输出（${run.id}）；为避免截断原 data.json，本次加载已停止。`,
					);
				}
			}
		}
		if (this.taskRuns.length > this.settings.taskHistoryLimit) {
			await this.persistTaskRunRetention(
				[...this.taskRuns],
				this.settings.taskHistoryLimit,
			);
		}
		if (changed || !stored.settings) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.getPersistence().save();
	}

	scheduleSettingsSave(delayMs = 400): Promise<void> {
		return this.getPersistence().schedule(delayMs);
	}

	async flushScheduledSettingsSave(): Promise<void> {
		await this.getPersistence().flush();
	}

	hasPlaintextCredentialFields(value: unknown): boolean {
		return hasPlaintextCredentialFields(value);
	}

	sanitizeSettingsForStorage(): DashboardSettings {
		return sanitizeSettingsForStorage(this.settings);
	}

	getProviderProfile(profileId: string): ProviderProfile | null {
		return this.settings.providerProfiles.find((profile) => profile.id === profileId) || null;
	}

	getVerifiedProviderProfiles(): ProviderProfile[] {
		return this.settings.providerProfiles.filter((profile) => {
			return profile.lastTest?.ok === true
				&& Boolean(profile.model)
				&& Boolean(profile.baseUrl);
		});
	}

	resolveQueryBackendId(backendId?: string): string {
		const normalized = String(backendId || "codex-cli");
		if (normalized === "codex-cli") return "codex-cli";
		if (normalized === "claude-code") {
			return this.isCliBackendAvailable("claude-code")
				? "claude-code"
				: "codex-cli";
		}
		if (normalized === "opencode") {
			return this.isCliBackendAvailable("opencode")
				? "opencode"
				: "codex-cli";
		}
		return this.getVerifiedProviderProfiles().some((profile) => profile.id === normalized)
			? normalized
			: "codex-cli";
	}

	isCliBackendAvailable(backendId: CliBackendId): boolean {
		const executable = backendId === "claude-code"
			? this.settings.claudeExecutable
			: backendId === "opencode"
				? this.settings.openCodeExecutable
				: this.settings.codexExecutable;
		return Boolean(executable && fs.existsSync(executable));
	}

	resolveDirectQueryExecutionConfig(profile: ProviderProfile): ExecutionConfig {
		return {
			backend: "direct-api",
			providerId: profile.id,
			providerName: profile.name,
			providerType: profile.type,
			model: profile.model,
			reasoningEffort: null,
			serviceTier: null,
		};
	}

	createLLMProvider(profileOrId: ProviderProfile | string): LLMProvider {
		if (profileOrId === "codex-cli") {
			return new CodexCliProvider(this, {
				id: "codex-cli",
				name: "Codex CLI",
				model: this.settings.codexModel,
				timeoutSeconds: Math.min(30, this.settings.providerTimeoutSeconds || 20),
			});
		}
		const profile = typeof profileOrId === "string"
			? this.getProviderProfile(profileOrId)
			: normalizeProviderProfile(profileOrId);
		if (!profile) throw new ProviderConnectionError("configuration", "供应商配置不存在");
		switch (profile.type) {
			case "openai":
				return new OpenAIProvider(this, profile);
			case "anthropic":
				return new AnthropicProvider(this, profile);
			case "openai-compatible":
				return new OpenAICompatibleProvider(this, profile);
			case "ollama":
				return new OllamaProvider(this, profile);
			case "lm-studio":
				return new LMStudioProvider(this, profile);
			default:
				throw new ProviderConnectionError("unsupported", `不支持的供应商类型：${profile.type}`);
		}
	}

	async listProviderModels(profileId: string): Promise<ProviderModel[]> {
		const provider = this.createLLMProvider(profileId);
		return provider.listModels();
	}

	getCliModelDiscovery(backendId: CliBackendId): CliModelDiscoveryResult | null {
		return this.cliModelDiscoveryCache.get(backendId)?.result || null;
	}

	async discoverCliModels(
		backendId: CliBackendId,
		force = false,
	): Promise<CliModelDiscoveryResult> {
		const executable = backendId === "claude-code"
			? this.settings.claudeExecutable
			: backendId === "opencode"
				? this.settings.openCodeExecutable
				: this.settings.codexExecutable;
		const configuredModel = backendId === "claude-code"
			? this.settings.claudeModel
			: backendId === "opencode"
				? this.settings.openCodeModel
				: this.settings.codexModel;
		const signature = `${executable}\u0000${configuredModel}`;
		const sourceSignature = backendId === "claude-code"
			? this.settings.claudeConfigSource
			: backendId === "opencode"
				? this.settings.openCodeConfigSource
				: this.settings.codexConfigSource;
		const signatureWithSource = `${signature}\u0000${sourceSignature}`;
		const cached = this.cliModelDiscoveryCache.get(backendId);
		if (
			!force
			&& cached
			&& cached.signature === signatureWithSource
			&& cached.expiresAt > Date.now()
		) {
			return cached.result;
		}
		const existing = this.cliModelDiscoveryInFlight.get(backendId);
		if (existing) return existing;
		const pending = this.processExecution.discoverCliModels(this.settings, backendId)
			.then((result) => {
				this.cliModelDiscoveryCache.set(backendId, {
					signature: signatureWithSource,
					expiresAt: Date.now() + (backendId === "claude-code" ? 5000 : 300000),
					result,
				});
				return result;
			})
			.finally(() => {
				this.cliModelDiscoveryInFlight.delete(backendId);
			});
		this.cliModelDiscoveryInFlight.set(backendId, pending);
		return pending;
	}

	invalidateCliModelDiscovery(backendId: CliBackendId): void {
		this.cliModelDiscoveryCache.delete(backendId);
	}

	async testProviderConnection(profileId: string): Promise<ProviderConnectionTestResult> {
		if (profileId === "claude-code") {
			const result = await this.processExecution.probeClaudeCode(this.settings);
			this.providerRuntimeState.set("claude-code", { status: "done", result });
			this.invalidateCliModelDiscovery("claude-code");
			return result;
		}
		if (profileId === "opencode") {
			const result = await this.processExecution.probeOpenCode(this.settings);
			this.providerRuntimeState.set("opencode", { status: "done", result });
			this.invalidateCliModelDiscovery("opencode");
			return result;
		}
		const provider = this.createLLMProvider(profileId);
		const result = await provider.testConnection();
		if (profileId !== "codex-cli") {
			const profile = this.getProviderProfile(profileId);
			if (profile) {
				profile.lastTest = {
					ok: result.ok === true,
					type: String(result.type || ""),
					model: String(result.model || profile.model),
					modelExists: result.modelExists === true
						? true
						: result.modelExists === false
							? false
							: null,
					endpoint: String(result.endpoint || profile.baseUrl).slice(0, 500),
					message: String(result.message || "").slice(0, 500),
					responseTimeMs: Number(result.responseTimeMs || 0),
					streamingVerified: result.streaming?.verified === true,
					testedAt: String(result.testedAt || new Date().toISOString()),
				};
				profile.updatedAt = new Date().toISOString();
				if (result.ok && !this.settings.activeProviderId) {
					this.settings.activeProviderId = profile.id;
				}
				if (!result.ok && this.settings.activeProviderId === profile.id) {
					this.settings.activeProviderId = "";
				}
				await this.saveSettings();
			}
		}
		return result;
	}

	async providerHttpRequest(
		options: ProviderHttpRequestOptions,
	): Promise<ProviderHttpResponse> {
		return this.providerTransport.request(options);
	}

	providerHttpStream(
		options: ProviderHttpStreamOptions,
	): Promise<ProviderHttpStreamResponse> {
		return this.providerTransport.stream(options);
	}

	normalizeProviderError(error: unknown): NormalizedProviderError {
		return normalizeHttpProviderError(error);
	}

	getProviderErrorLabel(type: string): string {
		const labels: Record<string, string> = {
			configuration: "配置不完整",
			"missing-secret": "缺少凭据",
			"secret-storage-unavailable": "SecretStorage 不可用",
			authentication: "认证失败",
			"model-not-found": "模型不存在",
			"endpoint-not-found": "Endpoint 不存在",
			"local-service-offline": "本地服务未启动",
			timeout: "请求超时",
			"connect-timeout": "连接超时",
			"read-timeout": "读取超时",
			"response-too-large": "响应体过大",
			"rate-limit": "请求限流",
			server: "供应商服务错误",
			dns: "域名解析失败",
			network: "网络错误",
			protocol: "响应格式错误",
			cancelled: "请求已停止",
			attachment: "图片附件无效",
			unsupported: "尚未支持",
			"http-unavailable": "HTTP API 不可用",
			unknown: "未知错误",
		};
		return labels[type] || type || "未知错误";
	}

	probeCodexCliConnection(): Promise<ProviderConnectionTestResult> {
		return this.processExecution.probeCodexCli(this.settings);
	}

	probeMineruCliConnection(): Promise<ProviderConnectionTestResult> {
		return this.processExecution.probeMineruCli(this.settings);
	}

	async probeObsidianCliConnection(): Promise<ObsidianCliConnectionResult> {
		const result = await this.obsidianCliService.probe({
			executable: this.settings.obsidianCliExecutable,
			vaultName: this.app.vault.getName(),
			pluginId: this.manifest.id,
			cwd: this.settings.toolkitRoot && fs.existsSync(this.settings.toolkitRoot)
				? this.settings.toolkitRoot
				: process.cwd(),
		});
		this.obsidianCliProbeState = { status: "done", result };
		return result;
	}

	async clearCompletedTaskHistory(): Promise<number> {
		return this.withTaskRunMutation(async () => {
			const originalRuns = [...this.taskRuns];
			const removable = originalRuns.filter((run) => (
				run.status !== "running"
				&& run.status !== "queued"
				&& !this.finishingTaskRunIds.has(run.id)
			));
			const removableIds = new Set(removable.map((run) => run.id));
			// Phase 1 marker: never remove the only discoverable reference before
			// its sidecar unlink has completed.
			this.taskRuns = originalRuns.map((run) => (
				removableIds.has(run.id) ? { ...run, cleanupPending: true } : run
			));
			try {
				await this.saveSettings();
			} catch (error) {
				this.taskRuns = originalRuns;
				throw error;
			}

			const cleanupFailures: TaskRun[] = [];
			let removed = 0;
			for (const run of removable) {
				try {
					await this.deleteTaskRunOutput(run.id, run.outputPath);
					removed += 1;
				} catch (error) {
					cleanupFailures.push({ ...run, cleanupPending: true });
					console.warn(`Could not delete Dashboard task output for ${run.id}`, error);
				}
			}
			const failedById = new Map(cleanupFailures.map((run) => [run.id, run]));
			this.taskRuns = originalRuns
				.filter((run) => !removableIds.has(run.id) || failedById.has(run.id))
				.map((run) => failedById.get(run.id) || run);
			let finalizeError: unknown = null;
			try {
				await this.saveSettings();
			} catch (error) {
				finalizeError = error;
			}
			if (cleanupFailures.length) {
				throw new Error(
					`已清理 ${removed} 条；另有 ${cleanupFailures.length} 条输出文件删除失败，记录已保留以便重试。`,
				);
			}
			if (finalizeError) {
				console.warn("Could not finalize cleared Dashboard task history", finalizeError);
				throw new Error("输出文件已清理，但历史收尾保存失败；下次启动会继续完成对账。");
			}
			return removed;
		});
	}

	async resetQueryHistory(): Promise<void> {
		const session = this.makeQuerySession();
		this.querySessions = [session];
		this.activeQuerySessionId = session.id;
		await this.saveSettings();
	}

	buildDiagnosticsSummary(): string {
		const describe = (label: string, kind: "codex" | "claude" | "opencode" | "mineru" | "obsidian", executable: string) => {
			const detection = describeCliExecutable(kind, executable);
			return `${label}: ${detection.found ? "可用" : "不可用"} · ${detection.sourceLabel}`;
		};
		return [
			`Research Agent Reader ${this.manifest.version}`,
			`平台: ${process.platform} ${process.arch}`,
			`工具包根目录: ${this.settings.toolkitRoot && fs.existsSync(this.settings.toolkitRoot) ? "可用" : "不可用"}`,
			describe("Codex CLI", "codex", this.settings.codexExecutable),
			describe("Claude Code", "claude", this.settings.claudeExecutable),
			describe("OpenCode", "opencode", this.settings.openCodeExecutable),
			describe("MinerU CLI", "mineru", this.settings.mineruExecutable),
			describe("Obsidian CLI", "obsidian", this.settings.obsidianCliExecutable),
			`MinerU 服务: ${this.settings.mineruServiceMode === "private" ? "私有部署" : "官方服务"}`,
			`Python: ${this.settings.pythonExecutable && fs.existsSync(this.settings.pythonExecutable) ? "可用" : "不可用"}`,
			`Rscript: ${this.settings.rscriptExecutable && fs.existsSync(this.settings.rscriptExecutable) ? "可用" : "不可用"}`,
			`Direct API 配置数: ${this.settings.providerProfiles.length}`,
			"体检范围: wiki/ 与 Vault 顶层 Markdown；排除 papers/、Clippings/（仅检查跨根链接边界）",
			"凭据、endpoint、正文和对话内容: 已排除",
		].join("\n");
	}

	makeQuerySession(title = "新对话"): QuerySession {
		const now = new Date().toISOString();
		const queryBackendId = this.resolveQueryBackendId(this.settings.queryDefaultBackendId);
		const directApi = !isCliBackendId(queryBackendId);
		const defaultRetrievalMode = this.settings.queryDefaultRetrievalMode === "vault"
			? "vault"
			: "web";
		return {
			id: `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			title,
			retrievalMode: directApi ? "vault" : defaultRetrievalMode,
			queryBackendId,
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
	}

	normalizeQuerySession(session: unknown): QuerySession {
		const source = asRecord(session);
		const fallback = this.makeQuerySession();
		const messages: QueryMessage[] = Array.isArray(source.messages)
			? source.messages.slice(-(this.settings.queryMessageLimit || DEFAULT_SETTINGS.queryMessageLimit)).map((value) => {
				const message = asRecord(value);
				return {
				id: String(message.id || this.createQueryMessageId()),
				role: message.role === "user" ? "user" : "assistant",
				content: String(message.content || "").slice(0, 20000),
				attachments: normalizeVaultImageAttachments(message.attachments),
				status: normalizeQueryMessageStatus(message.status),
				progress: String(message.progress || ""),
				createdAt: String(message.createdAt || new Date().toISOString()),
				runId: String(message.runId || ""),
				retrievalTrace: message.retrievalTrace && typeof message.retrievalTrace === "object"
					? message.retrievalTrace as Record<string, unknown>
					: null,
				vaultSources: normalizeQueryVaultSources(message.vaultSources, {
					resolveVaultPath: makeVaultSourcePathResolver(this.app),
				}),
				webSources: normalizeQueryWebSources(message.webSources),
				citationValidation: normalizeQueryCitationValidation(message.citationValidation),
				retrievalPath: normalizeQueryRetrievalPath(message.retrievalPath),
				retrievalMode: message.retrievalMode === "vault" ? "vault" : "web",
				queryBackendId: String(message.queryBackendId || "codex-cli").slice(0, 100),
				providerName: String(message.providerName || "").slice(0, 80),
				model: String(message.model || "").slice(0, 160),
				error: String(message.error || "").slice(0, 12000),
			};
			})
			: [];
		return {
			id: String(source.id || fallback.id),
			title: String(source.title || "新对话").slice(0, 80),
			retrievalMode: source.retrievalMode === "vault" ? "vault" : "web",
			queryBackendId: String(source.queryBackendId || "codex-cli").slice(0, 100),
			createdAt: String(source.createdAt || fallback.createdAt),
			updatedAt: String(source.updatedAt || fallback.updatedAt),
			messages,
		};
	}

	createQueryMessageId(): string {
		return `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	getQuerySessions(): QuerySession[] {
		return [...this.querySessions].sort((a, b) => {
			return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
		});
	}

	getActiveQuerySession(): QuerySession {
		const active = this.querySessions.find(
			(session) => session.id === this.activeQuerySessionId,
		) || this.querySessions[0];
		if (active) return active;
		const fallback = this.makeQuerySession();
		this.querySessions = [fallback];
		this.activeQuerySessionId = fallback.id;
		return fallback;
	}

	async createQuerySession(): Promise<QuerySession> {
		const activeSession = this.getActiveQuerySession();
		if (activeSession && activeSession.messages.length === 0) {
			return activeSession;
		}
		const session = this.makeQuerySession();
		this.querySessions = [session, ...this.querySessions].slice(
			0,
			this.settings.querySessionLimit || DEFAULT_SETTINGS.querySessionLimit,
		);
		this.activeQuerySessionId = session.id;
		await this.saveSettings();
		return session;
	}

	async setActiveQuerySession(sessionId: string): Promise<void> {
		if (!this.querySessions.some((session) => session.id === sessionId)) return;
		this.activeQuerySessionId = sessionId;
		await this.saveSettings();
	}

	async clearActiveQuerySession(): Promise<void> {
		const session = this.getActiveQuerySession();
		session.messages = [];
		session.title = "新对话";
		session.updatedAt = new Date().toISOString();
		await this.saveSettings();
	}

	async deleteActiveQuerySession(): Promise<QuerySession | null> {
		const session = this.getActiveQuerySession();
		if (!session) return null;
		if (this.querySessions.length <= 1) {
			await this.clearActiveQuerySession();
			return this.getActiveQuerySession();
		}
		this.querySessions = this.querySessions.filter((item) => item.id !== session.id);
		const nextSession = this.getQuerySessions()[0] || this.querySessions[0];
		this.activeQuerySessionId = nextSession.id;
		await this.saveSettings();
		return nextSession;
	}

	async setActiveQueryMode(mode: QueryRetrievalMode | string): Promise<void> {
		const session = this.getActiveQuerySession();
		session.retrievalMode = mode === "vault" ? "vault" : "web";
		session.updatedAt = new Date().toISOString();
		await this.saveSettings();
	}

	async setActiveQueryBackend(backendId: string): Promise<void> {
		const session = this.getActiveQuerySession();
		session.queryBackendId = this.resolveQueryBackendId(backendId);
		session.updatedAt = new Date().toISOString();
		await this.saveSettings();
	}

	async appendQueryMessages(
		sessionId: string,
		messages: QueryMessage[],
		firstQuestion = "",
	): Promise<void> {
		const session = this.querySessions.find((item) => item.id === sessionId);
		if (!session) throw new Error("查询会话不存在");
		session.messages = [...session.messages, ...messages].slice(
			-(this.settings.queryMessageLimit || DEFAULT_SETTINGS.queryMessageLimit),
		);
		if (session.title === "新对话" && firstQuestion) {
			session.title = firstQuestion.replace(/\s+/g, " ").slice(0, 36);
		}
		session.updatedAt = new Date().toISOString();
		await this.saveSettings();
	}

	async updateQueryMessage(
		sessionId: string,
		messageId: string,
		updates: Partial<QueryMessage>,
		saveMode: "immediate" | "debounced" = "immediate",
	): Promise<QueryMessage | null> {
		const session = this.querySessions.find((item) => item.id === sessionId);
		if (!session) return null;
		const index = session.messages.findIndex((message) => message.id === messageId);
		if (index === -1) return null;
		session.messages[index] = {
			...session.messages[index],
			...updates,
		};
		if (typeof session.messages[index].content === "string") {
			session.messages[index].content = session.messages[index].content.slice(0, 20000);
		}
		if (typeof session.messages[index].error === "string") {
			session.messages[index].error = session.messages[index].error.slice(0, 12000);
		}
		session.updatedAt = new Date().toISOString();
		if (saveMode === "debounced") {
			await this.scheduleSettingsSave();
		} else {
			await this.flushScheduledSettingsSave();
			await this.saveSettings();
		}
		return session.messages[index];
	}

	buildQueryActionInput(
		question: string,
		priorMessages: QueryMessage[],
		mode: QueryRetrievalMode = "web",
		attachments: VaultImageAttachment[] = [],
	): string {
		const completed = Array.isArray(priorMessages)
			? priorMessages.filter((message) => message.status === "done" && message.content)
			: [];
		const recent = completed.slice(-8).map((message) => ({
			role: message.role,
			content: String(message.content).slice(0, 3000),
		}));
		const olderUsers = completed
			.slice(0, Math.max(0, completed.length - 8))
			.filter((message) => message.role === "user")
			.slice(-6)
			.map((message) => String(message.content).replace(/\s+/g, " ").slice(0, 240));
		const firstQuestion = completed.find((message) => message.role === "user")?.content || "";
		const summaryParts = [];
		if (firstQuestion) summaryParts.push(`对话起点：${String(firstQuestion).replace(/\s+/g, " ").slice(0, 400)}`);
		if (olderUsers.length) summaryParts.push(`较早追问：${olderUsers.join("；")}`);
		return JSON.stringify({
			kind: "query-session",
			schema_version: 1,
			mode: mode === "vault" ? "vault" : "web",
			question,
			conversation_summary: summaryParts.join("\n"),
			recent_turns: recent,
			attachments: normalizeVaultImageAttachments(attachments),
		});
	}

	inferToolkitRoot(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return "";
		const vaultRoot = adapter.getBasePath();
		const parent = path.dirname(vaultRoot);
		const isToolkitRoot = (candidate: string): boolean => (
			fs.existsSync(path.join(candidate, "AGENTS.md"))
			&& fs.existsSync(path.join(candidate, "tool-library", "scripts", "run_vault_action.py"))
		);
		if (isToolkitRoot(parent)) return parent;
		if (isToolkitRoot(vaultRoot)) return vaultRoot;
		return "";
	}

	getTaskRuns(): TaskRun[] {
		return [...this.taskRuns].sort((a, b) => {
			return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
		});
	}

	getTaskRun(runId: string): TaskRun | null {
		return this.taskRuns.find((run) => run.id === runId) || null;
	}

	getRunningTaskRun(actionId: string): TaskRun | null {
		const actionIds = ["vault-lint", "vault-lint-fix"].includes(actionId)
			? new Set(["vault-lint", "vault-lint-fix"])
			: new Set([actionId]);
		return this.getTaskRuns().find((run) => (
			actionIds.has(run.actionId)
			&& (run.status === "running" || run.status === "queued")
		)) || null;
	}

	getTaskRunOutput(run: TaskRun): string {
		if (run?.outputPath) {
			const output = readTaskRunOutput(
				this.settings.toolkitRoot,
				run,
				String(run.outputPath),
			);
			if (output !== null) return output;
		}
		return String(run?.output || "");
	}

	async deleteTaskRunOutput(runId: string, storedRelativePath = ""): Promise<boolean> {
		return deletePersistedTaskRunOutput(this.settings.toolkitRoot, runId, storedRelativePath);
	}

	async persistTaskRunOutput(run: TaskRun): Promise<string> {
		return writeTaskRunOutput(this.settings.toolkitRoot, run);
	}

	isActionRunning(actionId: string): boolean {
		const actionIds = ["vault-lint", "vault-lint-fix"].includes(actionId)
			? new Set(["vault-lint", "vault-lint-fix"])
			: new Set([actionId]);
		return this.taskRuns.some((run) => actionIds.has(run.actionId) && (run.status === "running" || run.status === "queued"));
	}

	getModelLabel(model: string): string {
		for (const cached of this.cliModelDiscoveryCache.values()) {
			const discovered = cached.result.models.find((option) => option.id === model);
			if (discovered) return discovered.label;
		}
		return MODEL_OPTIONS.find((option) => option.id === model)?.label || model;
	}

	getReasoningLabel(reasoningEffort: string): string {
		return REASONING_OPTIONS.find((option) => option.id === reasoningEffort)?.label || reasoningEffort;
	}

	supportsFast(model: string): boolean {
		const discovered = this.cliModelDiscoveryCache
			.get("codex-cli")
			?.result.models.find((option) => option.id === model);
		if (discovered) return discovered.supportsFast;
		return MODEL_OPTIONS.find((option) => option.id === model)?.supportsFast === true;
	}

	resolveActionExecutionConfig(
		action: DashboardAction,
		overrides: ExecutionOverrides = {},
	): CodexExecutionConfig {
		const useOfficialConfig = this.settings.codexConfigSource === "official";
		const configuredDefault = this.settings.actionExecutionDefaults?.[action.id];
		const buttonModel = useOfficialConfig
			? configuredDefault?.model
				|| action.model
				|| this.settings.codexModel
				|| DEFAULT_SETTINGS.codexModel
			: "";
		const buttonReasoning = useOfficialConfig
			? configuredDefault?.reasoningEffort
				|| action.reasoningEffort
				|| this.settings.codexReasoningEffort
				|| DEFAULT_SETTINGS.codexReasoningEffort
			: "";
		const requestedModel = typeof overrides.model === "string" ? overrides.model.trim() : "";
		const requestedReasoning = typeof overrides.reasoningEffort === "string" ? overrides.reasoningEffort.trim() : "";
		const reasoningEffort = REASONING_OPTIONS.some((option) => option.id === requestedReasoning)
			? requestedReasoning
			: buttonReasoning;
		const effectiveModel = requestedModel || buttonModel;
		return {
			backend: "codex-cli",
			model: effectiveModel,
			reasoningEffort,
			serviceTier: (overrides.serviceTier || configuredDefault?.serviceTier) === "fast"
				&& this.supportsFast(effectiveModel)
				? "fast"
				: "default",
			modelSource: requestedModel
				? "本次覆盖"
				: useOfficialConfig
					? configuredDefault?.model
						? "任务设置"
						: action.model ? "按钮默认" : "全局默认"
					: getCodexDefaultModelLabel(this.settings.codexConfigSource),
			reasoningSource: requestedReasoning
				? "本次覆盖"
				: useOfficialConfig
					? configuredDefault?.reasoningEffort
						? "任务设置"
						: action.reasoningEffort ? "按钮默认" : "全局默认"
					: "Codex CLI 配置",
		};
	}

	resolveCliActionExecutionConfig(
		action: DashboardAction,
		backendId: CliBackendId,
		overrides: ExecutionOverrides = {},
	): CodexExecutionConfig {
		if (backendId === "codex-cli") {
			return this.resolveActionExecutionConfig(action, overrides);
		}
		const isOpenCode = backendId === "opencode";
		const configuredDefault = this.settings.actionExecutionDefaults?.[action.id];
		const configuredForBackend = configuredDefault?.backend === backendId
			? configuredDefault
			: null;
		const requestedModel = typeof overrides.model === "string"
			? overrides.model.trim()
			: "";
		const requestedReasoning = typeof overrides.reasoningEffort === "string"
			? overrides.reasoningEffort.trim()
			: "";
		const defaultReasoning = REASONING_OPTIONS.some(
			(option) => option.id === (
				isOpenCode
					? this.settings.openCodeReasoningEffort
					: this.settings.claudeReasoningEffort
			),
		)
			? (
				isOpenCode
					? this.settings.openCodeReasoningEffort
					: this.settings.claudeReasoningEffort
			)
			: isOpenCode
				? DEFAULT_SETTINGS.openCodeReasoningEffort
				: DEFAULT_SETTINGS.claudeReasoningEffort;
		const configuredModel = configuredForBackend?.model || (isOpenCode
			? this.settings.openCodeModel.trim()
			: this.settings.claudeModel.trim());
		const configSource = isOpenCode
			? this.settings.openCodeConfigSource
			: this.settings.claudeConfigSource;
		return {
			backend: backendId,
			model: requestedModel || configuredModel,
			reasoningEffort: REASONING_OPTIONS.some(
				(option) => option.id === requestedReasoning,
			)
				? requestedReasoning
				: configuredForBackend?.reasoningEffort || defaultReasoning,
			serviceTier: "default",
			modelSource: requestedModel
				? "本次覆盖"
				: configuredForBackend?.model
					? "任务设置"
				: configuredModel
					? `${getCliBackendLabel(backendId)} 默认`
					: isOpenCode
						? getOpenCodeDefaultModelLabel(configSource)
						: getClaudeDefaultModelLabel(configSource),
			reasoningSource: requestedReasoning
				? "本次覆盖"
				: configuredForBackend?.reasoningEffort
					? "任务设置"
					: `${getCliBackendLabel(backendId)} 默认`,
		};
	}

	async startTaskRun(
		action: DashboardAction,
		summary: string,
		executionConfig: ExecutionConfig | null = null,
	): Promise<TaskRun> {
		return this.withTaskRunMutation(async () => {
			const now = new Date().toISOString();
			const run: TaskRun = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				actionId: action.id,
				label: action.label,
				agent: action.agent,
				summary,
				executionConfig,
				status: "running",
				startedAt: now,
				finishedAt: "",
				exitCode: null,
				output: "",
				error: "",
			};
			const originalRuns = [...this.taskRuns];
			const limit = this.settings.taskHistoryLimit || DEFAULT_SETTINGS.taskHistoryLimit;
			const candidates = [run, ...originalRuns];
			// Commit the new history before reclaiming any old sidecar. A failed
			// start save restores the previous history and leaves every old output.
			try {
				await this.persistTaskRunRetention(candidates, limit);
			} catch (error) {
				this.taskRuns = originalRuns;
				throw error;
			}
			return run;
		});
	}

	async setTaskHistoryLimit(value: number): Promise<void> {
		return this.withTaskRunMutation(async () => {
			const nextLimit = Math.max(5, Math.min(100, Math.round(value) || 30));
			const previousLimit = this.settings.taskHistoryLimit;
			const previousRuns = [...this.taskRuns];
			this.settings.taskHistoryLimit = nextLimit;
			try {
				await this.persistTaskRunRetention(previousRuns, nextLimit);
			} catch (error) {
				this.settings.taskHistoryLimit = previousLimit;
				this.taskRuns = previousRuns;
				throw error;
			}
		});
	}

	async finishTaskRun(
		runId: string,
		updates: TaskRunUpdate,
	): Promise<TaskRun | null> {
		return this.withTaskRunMutation(async () => {
			const index = this.taskRuns.findIndex((run) => run.id === runId);
			if (index === -1) return null;
			const existingRun = this.taskRuns[index];
			if (["done", "failed", "interrupted"].includes(existingRun.status)) {
				return existingRun;
			}
			let completedRun: TaskRun = {
				...existingRun,
				...updates,
				finishedAt: new Date().toISOString(),
				completionPending: true,
			};
			// A newly supplied inline result supersedes any older external file.
			// Restore outputPath only after the new full-output write succeeds.
			if (updates.output !== undefined) completedRun.outputPath = undefined;
			this.taskRuns[index] = completedRun;
			this.finishingTaskRunIds.add(runId);
			try {
				const terminalStatus = ["done", "failed", "interrupted"].includes(completedRun.status);
				if (terminalStatus) {
					try {
						const outputPath = await this.persistTaskRunOutput(completedRun);
						if (outputPath) completedRun = { ...completedRun, outputPath };
					} catch (error) {
						// Keep the real in-memory outcome and bounded inline snapshot if the
						// completion journal cannot be written. data.json is still attempted.
						console.warn("Could not persist Dashboard completion journal; using inline snapshot", error);
					}
				}

				// Never write through a stale array index after an awaited sidecar
				// operation. Another task may have been prepended in the meantime.
				completedRun = { ...completedRun, completionPending: undefined };
				const liveIndex = this.taskRuns.findIndex((run) => (
					run.id === completedRun.id
						&& run.startedAt === completedRun.startedAt
						&& run.finishedAt === completedRun.finishedAt
				));
				if (liveIndex !== -1) this.taskRuns[liveIndex] = completedRun;
				const beforeRetention = [...this.taskRuns];
				try {
					await this.persistTaskRunRetention(
						beforeRetention,
						this.settings.taskHistoryLimit || DEFAULT_SETTINGS.taskHistoryLimit,
					);
				} catch (error) {
					// The sidecar is already durable. Restore the in-memory completion;
					// stale on-disk running state can recover from that journal next load.
					this.taskRuns = beforeRetention;
					console.warn("Could not persist completed Dashboard task history", error);
				}
				return this.taskRuns.find((run) => run.id === completedRun.id) || completedRun;
			} finally {
				this.finishingTaskRunIds.delete(runId);
			}
		});
	}

	getOkfExportStatus(): OkfExportStatus {
		const projectRoot = this.settings.toolkitRoot;
		const exporter = path.join(projectRoot, "tool-library", "scripts", "export_okf.py");
		const latestPath = path.join(projectRoot, "tool-library", "output", "okf", "latest.json");
		let latest = null;
		let error = "";
		if (fs.existsSync(latestPath)) {
			try {
				latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
			} catch (readError) {
				error = readError instanceof Error ? readError.message : String(readError);
			}
		}
		return {
			exporterAvailable: fs.existsSync(exporter),
			latest,
			error,
		};
	}

	getLintStatus(): LintStatus {
		if (this.latestLintReport) {
			return { latest: this.latestLintReport, error: "" };
		}
		const projectRoot = this.settings.toolkitRoot;
		const latestPath = path.join(projectRoot, "tool-library", "output", "lint", "latest.json");
		let latest = null;
		let error = "";
		if (fs.existsSync(latestPath)) {
			try {
				latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
			} catch (readError) {
				error = readError instanceof Error ? readError.message : String(readError);
			}
		}
		return { latest, error };
	}

	normalizeLintReport(value: unknown): LintReport | null {
		if (!value || typeof value !== "object") return null;
		const source = value as Record<string, unknown>;
		const generatedAt = String(source.generated_at || "").trim();
		if (!generatedAt || Number.isNaN(new Date(generatedAt).getTime())) return null;
		const summarySource = source.summary && typeof source.summary === "object"
			? source.summary as Record<string, unknown>
			: {};
		const numberValue = (key: string): number | undefined => {
			const parsed = Number(summarySource[key]);
			return Number.isFinite(parsed) ? parsed : undefined;
		};
		return {
			...source,
			generated_at: generatedAt,
			summary: {
				score: numberValue("score"),
				errors: numberValue("errors"),
				warnings: numberValue("warnings"),
				info: numberValue("info"),
			},
			findings: Array.isArray(source.findings)
				? source.findings.filter((finding) => finding && typeof finding === "object") as LintReport["findings"]
				: [],
		} as LintReport;
	}

	checkRuntime(
		action: DashboardAction | null = null,
		backendId: CliBackendId = "codex-cli",
	): { ready: boolean; message: string } {
		if (action?.id === "vault-lint") {
			return {
				ready: true,
				message: "内置知识库体检可用；不需要 Research Vault Toolkit、Python 或 Agent CLI。",
			};
		}
		const configuredRoot = String(this.settings.toolkitRoot || "").trim();
		const projectRoot = configuredRoot ? path.resolve(configuredRoot) : "";
		const withinRoot = (...segments: string[]): string => (
			projectRoot ? path.join(projectRoot, ...segments) : ""
		);
		const runner = withinRoot("tool-library", "scripts", "run_vault_action.py");
		const practiceRunner = withinRoot("tool-library", "scripts", "run_code_practice.py");
		const exporter = withinRoot("tool-library", "scripts", "export_okf.py");
		const lintScript = withinRoot("tool-library", "scripts", "lint_vault.py");
		const checks: Array<[string, boolean]> = [
			["工具包项目目录", Boolean(projectRoot) && fs.existsSync(projectRoot)],
			["AGENTS.md", Boolean(projectRoot) && fs.existsSync(withinRoot("AGENTS.md"))],
			["Dashboard runner", Boolean(runner) && fs.existsSync(runner)],
			["Python", Boolean(this.settings.pythonExecutable) && fs.existsSync(this.settings.pythonExecutable)],
		];
		if (!action) {
			checks.push(["Code practice runner", fs.existsSync(practiceRunner)]);
			checks.push(["Rscript", Boolean(this.settings.rscriptExecutable) && fs.existsSync(this.settings.rscriptExecutable)]);
			checks.push(["MinerU CLI", Boolean(this.settings.mineruExecutable) && fs.existsSync(this.settings.mineruExecutable)]);
		}
		if (!action || action.id === "okf-export") {
			checks.push(["OKF exporter", fs.existsSync(exporter)]);
		}
		if (
			!action
			|| ["vault-lint", "vault-lint-fix"].includes(action.id)
			|| (
				backendId !== "codex-cli"
				&& action.writes
				&& ["code-analysis", "synthesis"].includes(action.id)
			)
		) {
			checks.push(["Vault lint", fs.existsSync(lintScript)]);
		}
		if (!action || !["vault-lint", "okf-export"].includes(action.id)) {
			const executable = backendId === "claude-code"
				? this.settings.claudeExecutable
				: backendId === "opencode"
					? this.settings.openCodeExecutable
					: this.settings.codexExecutable;
			checks.push([getCliBackendLabel(backendId), fs.existsSync(executable)]);
		}
		const missing = checks.filter(([, ready]) => !ready).map(([label]) => label);
		const feature = action ? `“${action.label}”` : "可选 Research Vault Toolkit 工作流";
		return {
			ready: missing.length === 0,
			message: missing.length === 0
				? `${feature}运行环境检查通过。内置阅读器、批注和知识库体检始终独立可用。`
				: `${feature}尚未就绪：${missing.join("、")}。请在“设置 → Research Agent Reader → 运行环境”配置可选工具包；内置阅读器、批注和知识库体检不受影响。`,
		};
	}

	async runDirectVaultQuery(
		runId: string,
		providerId: string,
		question: string,
		priorMessages: QueryMessage[],
		mode: QueryRetrievalMode = "vault",
		hooks: DashboardProcessHooks = {},
		attachments: VaultImageAttachment[] = [],
	): Promise<DashboardProcessResult> {
		return this.directQueryService.run(
			runId,
			providerId,
			question,
			priorMessages,
			mode,
			hooks,
			attachments,
		);
	}

	buildDirectRetrievalResult(
		text: string,
		evidence: VaultEvidencePacket[],
		trace: RetrievalTrace,
		profile: ProviderProfile,
	): UnknownRecord {
		return this.directQueryService.buildRetrievalResult(
			text,
			evidence,
			trace,
			profile,
		);
	}

	async generateDirectQueryKeywords(
		provider: LLMProvider,
		profile: ProviderProfile,
		question: string,
	): Promise<string[]> {
		return this.directQueryService.generateKeywords(provider, profile, question);
	}

	async runVaultRetrievalPreflight(
		runId: string,
		question: string,
		expandedTerms: string[] = [],
	): Promise<Record<string, unknown>> {
		const toolkit = this.resolveToolkitRetrieval();
		if (toolkit.available) {
			try {
				return await this.directQueryService.runRetrievalPreflight(runId, question, expandedTerms);
			} catch (error) {
				const trace = await this.getLexicalRetriever().retrieve(question, expandedTerms);
				trace.retriever_fallback = {
					used: true,
					from: "toolkit",
					to: "in-plugin-lexical",
					reason: `工具链检索失败，已改用内置词法检索：${error instanceof Error ? error.message : String(error)}`,
				};
				return trace;
			}
		}
		const trace = await this.getLexicalRetriever().retrieve(question, expandedTerms);
		if (toolkit.configured) {
			trace.retriever = {
				selected: "in-plugin-lexical",
				reason: `工具链检索不可用：${toolkit.reason}`,
			};
		}
		return trace;
	}

	private resolveToolkitRetrieval(): { available: boolean; configured: boolean; reason: string } {
		const toolkitRoot = String(this.settings.toolkitRoot || "").trim();
		if (!toolkitRoot) return { available: false, configured: false, reason: "未配置工具包目录" };
		const script = path.join(toolkitRoot, "tool-library", "scripts", "retrieve_vault.py");
		if (!fs.existsSync(script)) {
			return { available: false, configured: true, reason: `检索脚本不存在：${script}` };
		}
		const python = String(this.settings.pythonExecutable || "").trim();
		if (!python || !fs.existsSync(python)) {
			return { available: false, configured: true, reason: "Python 不可用" };
		}
		return { available: true, configured: true, reason: "" };
	}

	private getLexicalRetriever(): LexicalVaultRetriever {
		if (!this.lexicalRetriever) this.lexicalRetriever = new LexicalVaultRetriever(this.app);
		return this.lexicalRetriever;
	}

	async readVaultEvidencePacket(trace: RetrievalTrace): Promise<VaultEvidencePacket[]> {
		return readVaultEvidencePackets(this.app, trace);
	}

	/** Saves one query answer as a Markdown note and returns its Vault path. */
	async saveQueryAnswerNote(sessionId: string, messageId: string): Promise<string> {
		const session = this.querySessions.find((item) => item.id === sessionId);
		const messageIndex = session?.messages.findIndex((item) => item.id === messageId) ?? -1;
		if (!session || messageIndex < 1) throw new Error("找不到要落笔记的回答");
		const message = session.messages[messageIndex];
		if (message.role !== "assistant" || !String(message.content || "").trim()) {
			throw new Error("该消息没有可保存的回答内容");
		}
		let question = "";
		for (let cursor = messageIndex - 1; cursor >= 0; cursor -= 1) {
			const prior = session.messages[cursor];
			if (prior.role === "user" && String(prior.content || "").trim()) {
				question = String(prior.content).trim();
				break;
			}
		}
		return saveQueryAnswerNote(this.app, {
			folder: this.settings.queryNotesFolder,
			question: question || session.title || "知识库问答",
			answer: String(message.content),
			sources: (message.vaultSources || []).map((source) => source.path),
			sessionTitle: session.title,
			createdAt: message.createdAt,
		});
	}

	/**
	 * Resolves how one Direct API profile reaches the web: provider-native
	 * server search, plugin-side Tavily searches, or nothing (with an
	 * actionable reason the query view can surface).
	 */
	private resolveWebSearchBackend(profile: ProviderProfile): WebSearchBackendResolution {
		const normalized = normalizeProviderProfile(profile);
		const mode = normalized.webSearch || "auto";
		if (mode === "off") {
			return { kind: "unavailable", reason: "该供应商未启用联网搜索（设置 → Direct API → 联网搜索）" };
		}
		const protocol = detectNativeWebSearchProtocol(normalized.baseUrl);
		if (mode === "native") {
			return protocol
				? { kind: "native", protocol }
				: { kind: "unavailable", reason: "未识别出该供应商的原生联网协议，请改用 Tavily" };
		}
		if (mode === "auto" && protocol) {
			return { kind: "native", protocol };
		}
		const secret = this.getTavilySecretValue();
		if (!secret) {
			return {
				kind: "unavailable",
				reason: mode === "tavily"
					? "未配置 Tavily API Key（设置 → Direct API → 联网搜索）"
					: "该供应商不支持原生联网，且未配置 Tavily API Key",
			};
		}
		const httpDeps: WebSearchHttpDeps = {
			httpRequest: async (options) => {
				const response = await this.providerHttpRequest(options);
				return { status: response.status, json: response.json };
			},
		};
		const maxResults = Math.max(1, Math.min(8, Math.round(this.settings.webSearchMaxResults) || 5));
		const timeoutMs = Math.max(
			5,
			Math.min(60, Math.round(this.settings.webSearchTimeoutSeconds) || 20),
		) * 1000;
		return {
			kind: "tavily",
			search: (queries) => searchTavily(httpDeps, secret, queries, { maxResults, timeoutMs }),
		};
	}

	/** Whether one Direct API profile can answer web-mode queries right now. */
	directProfileSupportsWebSearch(profileId: string): boolean {
		const profile = this.getProviderProfile(profileId);
		if (!profile) return false;
		return this.resolveWebSearchBackend(profile).kind !== "unavailable";
	}

	getTavilySecretValue(): string {
		const secretId = String(this.settings.webSearchTavilySecretId || "").trim();
		if (!secretId) return "";
		return String(this.app.secretStorage?.getSecret?.(secretId) || "").trim();
	}

	/** Whether the in-plugin light agent can run paper-ingest right now. */
	lightPaperIngestAvailable(): { ready: boolean; reason: string } {
		const profile = this.getProviderProfile(this.settings.activeProviderId);
		if (!profile || profile.lastTest?.ok !== true) {
			return { ready: false, reason: "需要一个已通过连接测试的 Direct API 配置（设置 → Direct API）" };
		}
		return { ready: true, reason: "" };
	}

	/**
	 * Whether the light agent could run MinerU right now: the native publish
	 * pipeline only needs the mineru-open-api CLI and a desktop vault root —
	 * no toolkit project and no Python.
	 */
	lightAgentMineruReady(): boolean {
		if (!describeCliExecutable("mineru", this.settings.mineruExecutable).found) return false;
		return Boolean(this.getActiveVaultRoot());
	}

	/** Absolute filesystem path of the active vault (desktop adapter only). */
	getActiveVaultRoot(): string {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string;
		};
		try {
			return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		} catch {
			return "";
		}
	}

	/**
	 * Runs 文献入库 through the in-plugin bounded agent loop (Direct API
	 * brain, allowlisted tools) instead of the Codex CLI toolkit pipeline.
	 */
	runLightPaperIngest(
		runId: string,
		options: PaperIngestFlowOptions,
		profileId: string,
		hooks: { onEvent?: (event: DashboardProcessEvent) => void } = {},
	): Promise<AgentLoopRunOutcome> {
		this.lightAgentResults.delete(runId);
		return this.agentLoopService.runPaperIngest(runId, options, profileId, hooks)
			.then((outcome) => {
				this.lightAgentResults.set(runId, outcome);
				return outcome;
			})
			.catch((error) => {
				this.lightAgentResults.delete(runId);
				throw error;
			});
	}

	getLightAgentRunResult(runId: string): AgentLoopRunOutcome | null {
		return this.lightAgentResults.get(runId) || null;
	}

	/** Persisted receipt paths for a light-agent run (survive reloads). */
	getTaskRunArtifacts(run: TaskRun): { articlePath?: string; wikiPath?: string } | null {
		if (run.actionId !== "paper-ingest" || !run.artifacts) return null;
		return run.artifacts;
	}

	getActiveDirectProviderSummary(): { name: string; model: string } | null {
		const profile = this.getProviderProfile(this.settings.activeProviderId);
		if (!profile) return null;
		return { name: profile.name, model: profile.model };
	}

	/** Opens a vault Markdown file in a new tab (used by result actions). */
	openVaultFile(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) {
			new Notice(`文件不存在：${path}`);
			return;
		}
		void this.app.workspace.getLeaf("tab").openFile(file);
	}

	/**
	 * Spawns the resolved MinerU CLI command with argument arrays (no
	 * shell), honors abort via the run-level signal, and caps captured
	 * output.
	 */
	private runMineruProcess(request: {
		command: string;
		baseArgs: string[];
		cliArgs: string[];
		cwd: string;
		timeoutMs: number;
		signal: AbortSignal;
	}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const MAX_HELPER_OUTPUT_CHARS = 1_000_000;
			let stdout = "";
			let stderr = "";
			let settled = false;
			const child = spawn(request.command, [...request.baseArgs, ...request.cliArgs], {
				cwd: request.cwd,
				shell: false,
				windowsHide: true,
				// Own process group on POSIX so the negative-pid kill in
				// killTree() reaches the MinerU CLI subprocess as well.
				detached: process.platform !== "win32",
				env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
			});
			const settle = (result: { exitCode: number; stdout: string; stderr: string } | Error) => {
				if (settled) return;
				settled = true;
				request.signal.removeEventListener("abort", onAbort);
				window.clearTimeout(timer);
				if (result instanceof Error) reject(result);
				else resolve(result);
			};
			const killTree = (): void => {
				try {
					if (!child.pid) {
						child.kill();
						return;
					}
					if (process.platform === "win32") {
						// child.kill() only terminates the direct Python process;
						// the MinerU CLI it waits on would survive as an orphan.
						// taskkill /T ends the whole process tree (array args, no shell).
						spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
							shell: false,
							windowsHide: true,
						});
					} else {
						// The helper is spawned detached on POSIX paths via negative
						// pid when possible; plain kill remains the fallback.
						try {
							process.kill(-child.pid);
						} catch {
							child.kill();
						}
					}
				} catch (killError) {
					console.warn("Could not kill MinerU helper process", killError);
					try {
						child.kill();
					} catch {
						// Nothing more we can do.
					}
				}
			};
			const onAbort = (): void => {
				killTree();
				settle({ exitCode: 130, stdout, stderr: `${stderr}\n已手动停止，MinerU 子进程已终止`.trim() });
			};
			const timer = window.setTimeout(() => {
				killTree();
				settle({ exitCode: 124, stdout, stderr: `${stderr}\nMinerU 提取超时`.trim() });
			}, request.timeoutMs);
			if (request.signal.aborted) {
				onAbort();
				return;
			}
			request.signal.addEventListener("abort", onAbort);
			child.stdout.on("data", (chunk: Buffer) => {
				if (stdout.length < MAX_HELPER_OUTPUT_CHARS) stdout += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < MAX_HELPER_OUTPUT_CHARS) stderr += chunk.toString("utf8");
			});
			child.once("error", (error: Error) => settle(error));
			child.once("close", (code: number | null) => {
				settle({ exitCode: code ?? 1, stdout, stderr });
			});
		});
	}

	/**
	 * Human-readable capability boundary for one Direct API profile, shown in
	 * the connection test result instead of the legacy "never web" wording.
	 */
	directApiBoundaryLabel(profileId: string): string {
		const profile = this.getProviderProfile(profileId);
		if (!profile) return "仅知识库上下文，不联网、不写入";
		const mode = normalizeProviderProfile(profile).webSearch || "auto";
		if (mode === "off") return "仅知识库上下文，不联网、不写入";
		const protocol = detectNativeWebSearchProtocol(profile.baseUrl);
		const protocolLabels: Record<string, string> = {
			openrouter: "OpenRouter",
			qwen: "通义千问",
			zhipu: "智谱",
			deepseek: "DeepSeek",
		};
		if (protocol) {
			return `知识库上下文 + 联网搜索（原生 · ${protocolLabels[protocol] || protocol}），不写入文件`;
		}
		const tavilyReady = Boolean(String(this.settings.webSearchTavilySecretId || "").trim());
		if (mode === "tavily" || (mode === "auto" && tavilyReady)) {
			return tavilyReady
				? "知识库上下文 + 联网搜索（Tavily），不写入文件"
				: "仅知识库上下文（未配置 Tavily），不联网、不写入";
		}
		if (mode === "native") {
			return "仅知识库上下文（未识别出原生联网协议），不联网、不写入";
		}
		return "仅知识库上下文，不联网、不写入";
	}

	resolveVaultLinkedFile(rawLink: unknown, sourcePath = ""): TFile | null {
		let link = String(rawLink || "").trim();
		if (!link) return null;
		link = link.split("|", 1)[0].split("#", 1)[0].trim();
		link = link.replace(/^<|>$/g, "").replace(/\\/g, "/").replace(/^\/+/, "");
		try {
			link = decodeURIComponent(link);
		} catch {
			// Keep the original value when malformed percent encoding is present.
		}
		link = normalizePath(link.replace(/^knowledge-base\//i, ""));
		if (!link) return null;
		const metadataCache = this.app?.metadataCache;
		if (typeof metadataCache?.getFirstLinkpathDest === "function") {
			const resolved = metadataCache.getFirstLinkpathDest(link, sourcePath || "");
			if (resolved instanceof TFile) return resolved;
		}
		const direct = this.app.vault.getAbstractFileByPath(link);
		if (direct instanceof TFile) return direct;
		if (sourcePath) {
			const relative = normalizePath(
				path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), link)),
			);
			const relativeFile = this.app.vault.getAbstractFileByPath(relative);
			if (relativeFile instanceof TFile) return relativeFile;
		}
		return null;
	}

	resolveVaultMarkdownFile(rawLink: unknown): TFile | null {
		let candidate = String(rawLink || "").trim();
		if (!candidate) return null;
		candidate = candidate.split("|", 1)[0].split("#", 1)[0].trim();
		candidate = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
		try {
			candidate = decodeURIComponent(candidate);
		} catch {
			// Keep the original value when malformed percent encoding is present.
		}
		candidate = normalizePath(candidate.replace(/^knowledge-base\//i, ""));
		const attempts = [candidate];
		if (!candidate.toLowerCase().endsWith(".md")) attempts.push(`${candidate}.md`);
		for (const attempt of attempts) {
			const file = this.resolveVaultLinkedFile(attempt);
			if (file?.path?.toLowerCase().endsWith(".md")) return file;
		}

		const normalizedCandidate = candidate.toLocaleLowerCase();
		const files = typeof this.app?.vault?.getMarkdownFiles === "function"
			? this.app.vault.getMarkdownFiles()
			: [];
		return files
			.filter((file) => {
				const pathWithoutExtension = file.path.replace(/\.md$/i, "").toLocaleLowerCase();
				const remainder = normalizedCandidate.slice(pathWithoutExtension.length);
				return normalizedCandidate === pathWithoutExtension
					|| (
						normalizedCandidate.startsWith(pathWithoutExtension)
						&& remainder.length > 0
						&& !/^[a-z0-9_./-]/i.test(remainder)
					);
			})
			.sort((a, b) => b.path.length - a.path.length)[0] || null;
	}

	extractQuestionNoteFiles(question: string): TFile[] {
		const text = String(question || "");
		const candidates: string[] = [];
		for (const match of text.matchAll(/obsidian:\/\/open\?[^\s<>"']+/gi)) {
			const rawUrl = match[0].replace(/[)\]}>，。；;!?]+$/u, "");
			try {
				const fileValue = new URL(rawUrl).searchParams.get("file");
				if (fileValue) candidates.push(fileValue);
			} catch {
				const fileMatch = rawUrl.match(/[?&]file=([^&]+)/i);
				if (fileMatch?.[1]) candidates.push(fileMatch[1]);
			}
		}
		for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
			const value = String(match[1] || "").split("|", 1)[0].split("#", 1)[0].trim();
			if (!VAULT_IMAGE_MIME_TYPES[path.posix.extname(value).toLowerCase()]) {
				candidates.push(value);
			}
		}
		const seen = new Set<string>();
		const files: TFile[] = [];
		for (const candidate of candidates) {
			const file = this.resolveVaultMarkdownFile(candidate);
			if (!file || seen.has(file.path.toLocaleLowerCase())) continue;
			seen.add(file.path.toLocaleLowerCase());
			files.push(file);
		}
		return files;
	}

	async getEmbeddedImageFiles(noteFile: TFile): Promise<TFile[]> {
		const metadataCache = this.app?.metadataCache;
		const cache = typeof metadataCache?.getFileCache === "function"
			? metadataCache.getFileCache(noteFile)
			: null;
		let links = Array.isArray(cache?.embeds)
			? cache.embeds.map((embed) => String(embed?.link || "")).filter(Boolean)
			: [];
		if (!links.length && typeof this.app?.vault?.cachedRead === "function") {
			const markdown = await this.app.vault.cachedRead(noteFile);
			links = [
				...[...String(markdown).matchAll(/!\[\[([^\]]+)\]\]/g)]
					.map((match) => String(match[1] || "")),
				...[...String(markdown).matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
					.map((match) => {
						const target = String(match[1] || "").trim();
						if (target.startsWith("<") && target.includes(">")) {
							return target.slice(1, target.indexOf(">"));
						}
						return target.split(/\s+["']/u, 1)[0];
					}),
			];
		}
		const seen = new Set<string>();
		const images: TFile[] = [];
		for (const link of links) {
			const file = this.resolveVaultLinkedFile(link, noteFile.path);
			if (!file || !VAULT_IMAGE_MIME_TYPES[path.posix.extname(file.path).toLowerCase()]) continue;
			const key = file.path.toLocaleLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			images.push(file);
		}
		return images;
	}

	async resolveQuestionImageAttachments(
		question: string,
		existingAttachments: VaultImageAttachment[] = [],
	): Promise<QuestionImageResolution> {
		const noteFiles = this.extractQuestionNoteFiles(question);
		const existing = normalizeVaultImageAttachments(existingAttachments);
		const seen = new Set(existing.map((attachment) => attachment.path.toLocaleLowerCase()));
		let totalBytes = existing.reduce((sum, attachment) => {
			const file = this.app.vault.getAbstractFileByPath(attachment.path);
			return sum + Number(file instanceof TFile ? file.stat.size : attachment.size || 0);
		}, 0);
		const attachments: VaultImageAttachment[] = [];
		let discoveredCount = 0;
		for (const noteFile of noteFiles) {
			const images = await this.getEmbeddedImageFiles(noteFile);
			for (const file of images) {
				const key = file.path.toLocaleLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				discoveredCount += 1;
				const size = Number(file.stat?.size || 0);
				if (size > MAX_VAULT_IMAGE_BYTES) continue;
				if (existing.length + attachments.length >= MAX_QUERY_IMAGE_ATTACHMENTS) continue;
				if (totalBytes + size > MAX_QUERY_IMAGE_TOTAL_BYTES) continue;
				const attachment = normalizeVaultImageAttachment({
					path: file.path,
					name: file.name,
					size,
					sourceNotePath: noteFile.path,
				});
				if (!attachment) continue;
				attachments.push(attachment);
				totalBytes += size;
			}
		}
		return {
			attachments,
			notePaths: noteFiles.map((file) => file.path),
			discoveredCount,
			totalBytes,
		};
	}

	buildVaultImageReferenceIndex(
		imageFiles: TFile[] = [],
	): Map<string, VaultImageReference[]> {
		const normalizeVaultPath = (value: unknown): string => normalizePath(
			String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, ""),
		);
		const imagePaths = new Set(
			imageFiles
				.map((file) => normalizeVaultPath(file?.path))
				.filter(Boolean),
		);
		const referenceMaps = new Map<string, Map<string, VaultImageReference>>(
			[...imagePaths].map((imagePath) => [
				imagePath,
				new Map<string, VaultImageReference>(),
			]),
		);
		const metadataCache = this.app?.metadataCache;
		const addReference = (
			imagePathValue: unknown,
			notePathValue: unknown,
			countValue: unknown = 1,
		): void => {
			const imagePath = normalizeVaultPath(imagePathValue);
			const notePath = normalizeVaultPath(notePathValue);
			if (!imagePaths.has(imagePath) || !notePath.toLowerCase().endsWith(".md")) return;
			const noteFile = this.app.vault.getAbstractFileByPath(notePath);
			const frontmatter = noteFile instanceof TFile
				? metadataCache.getFileCache(noteFile)?.frontmatter
				: null;
			const title = String(
				frontmatter?.title_zh
				|| frontmatter?.title
				|| (noteFile instanceof TFile ? noteFile.basename : "")
				|| path.posix.basename(notePath, ".md"),
			).trim();
			const count = Math.max(1, Number(countValue) || 1);
			const references = referenceMaps.get(imagePath);
			if (!references) return;
			const current = references.get(notePath);
			references.set(notePath, {
				path: notePath,
				title: title || path.posix.basename(notePath, ".md"),
				count: Math.max(current?.count || 0, count),
			});
		};

		for (const [notePath, targets] of Object.entries(metadataCache?.resolvedLinks || {})) {
			for (const [targetPath, count] of Object.entries(targets || {})) {
				addReference(targetPath, notePath, count);
			}
		}

		if (typeof this.app?.vault?.getMarkdownFiles === "function") {
			for (const noteFile of this.app.vault.getMarkdownFiles()) {
				const embeds = typeof metadataCache?.getFileCache === "function"
					? metadataCache.getFileCache(noteFile)?.embeds || []
					: [];
				const embedCounts = new Map<string, number>();
				for (const embed of embeds) {
					const targetFile = typeof metadataCache?.getFirstLinkpathDest === "function"
						? metadataCache.getFirstLinkpathDest(embed?.link || "", noteFile.path)
						: null;
					const targetPath = normalizeVaultPath(targetFile?.path);
					if (!imagePaths.has(targetPath)) continue;
					embedCounts.set(targetPath, (embedCounts.get(targetPath) || 0) + 1);
				}
				for (const [targetPath, count] of embedCounts) {
					addReference(targetPath, noteFile.path, count);
				}
			}
		}

		return new Map(
			[...referenceMaps].map(([imagePath, references]) => [
				imagePath,
				[...references.values()].sort((a, b) => {
					return a.title.localeCompare(b.title, "zh-CN") || a.path.localeCompare(b.path);
				}),
			]),
		);
	}

	async readVaultImageData(attachment: VaultImageAttachment): Promise<VaultImageData> {
		const normalized = normalizeVaultImageAttachment(attachment);
		if (!normalized) {
			throw new ProviderConnectionError(
				"attachment",
				"仅支持 Vault 内的 PNG、JPEG 和 WebP 图片",
			);
		}
		if (normalized.path.split("/").includes("..")) {
			throw new ProviderConnectionError("attachment", "图片路径超出当前 Vault");
		}
		const file = this.app?.vault?.getAbstractFileByPath?.(normalized.path);
		if (!(file instanceof TFile)) {
			throw new ProviderConnectionError(
				"attachment",
				`图片不存在于当前 Vault：${normalized.path}`,
			);
		}
		if (!normalized.mimeType) {
			throw new ProviderConnectionError("attachment", "图片格式不受支持");
		}
		const declaredSize = Number(file.stat?.size) || 0;
		if (declaredSize > MAX_VAULT_IMAGE_BYTES) {
			throw new ProviderConnectionError(
				"attachment",
				`图片超过 ${(MAX_VAULT_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MiB 上限`,
			);
		}
		const bytes = await this.app.vault.readBinary(file);
		// stat.size can be stale when the file changed on disk; enforce the
		// limit against the bytes actually read and report the actual size.
		const actualSize = Number(bytes?.byteLength) || 0;
		if (actualSize > MAX_VAULT_IMAGE_BYTES) {
			throw new ProviderConnectionError(
				"attachment",
				`图片超过 ${(MAX_VAULT_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MiB 上限`,
			);
		}
		return {
			attachment: { ...normalized, size: actualSize },
			content: {
				type: "image_url",
				image_url: {
					url: `data:${normalized.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
				},
			},
		};
	}

	async buildDirectQueryMessages(
		question: string,
		priorMessages: QueryMessage[],
		evidence: VaultEvidencePacket[],
		attachments: VaultImageAttachment[] = [],
	): Promise<ChatMessage[]> {
		return this.directQueryService.buildMessages(
			question,
			priorMessages,
			evidence,
			attachments,
		);
	}

	runVaultAction(
		runId: string,
		action: DashboardAction,
		input: string,
		executionConfig: ExecutionConfig | null = null,
		hooks: DashboardProcessHooks = {},
	): Promise<DashboardProcessResult> {
		const registered = ACTION_BY_ID.get(action.id);
		if (!registered || !registered.enabled) {
			return Promise.reject(new Error(`操作尚未启用：${action.label}`));
		}
		if (action.id === "vault-lint") {
			return new VaultLintService(this.app).run(hooks).then(({ report, result }) => {
				this.latestLintReport = report;
				return result;
			});
		}
		const effectiveConfig = executionConfig
			? {
				...executionConfig,
				reasoningEffort: executionConfig.reasoningEffort
					|| (
						executionConfig.backend === "claude-code"
							? this.settings.claudeReasoningEffort
							: executionConfig.backend === "opencode"
								? this.settings.openCodeReasoningEffort
								: this.settings.codexReasoningEffort
					),
				serviceTier: executionConfig.serviceTier || "default",
			} as CodexExecutionConfig
			: this.resolveActionExecutionConfig(action);
		const backendId: CliBackendId = effectiveConfig.backend === "claude-code"
			? "claude-code"
			: effectiveConfig.backend === "opencode"
				? "opencode"
				: "codex-cli";
		const stageWriteAllowed = backendId !== "codex-cli"
			&& ["code-analysis", "synthesis"].includes(action.id);
		if (action.writes && backendId !== "codex-cli" && !stageWriteAllowed) {
			return Promise.reject(
				new Error(`${getCliBackendLabel(backendId)} 当前仅开放“代码分析”和“综合分析”的阶段所有权写入`),
			);
		}
		const runtime = this.checkRuntime(action, backendId);
		if (!runtime.ready) {
			return Promise.reject(new Error(runtime.message));
		}
		return this.processExecution.runVaultAction({
			runId,
			action,
			input,
			executionConfig: effectiveConfig,
			settings: this.settings,
			hooks,
		});
	}

	stopVaultAction(runId: string): boolean {
		if (this.agentLoopService.stop(runId)) return true;
		return this.processExecution.stopVaultAction(runId);
	}

	/**
	 * Single stop entry for any task run: resolves ownership by asking each
	 * executor in turn instead of inferring from executionConfig.backend.
	 */
	stopTaskRun(runId: string): boolean {
		if (this.agentLoopService.stop(runId)) return true;
		if (this.directQueryService.stop(runId)) return true;
		return this.processExecution.stopVaultAction(runId);
	}

	requestVaultActionStop(runId: string): boolean {
		return this.processExecution.requestVaultActionStop(runId);
	}

	stopDirectVaultQuery(runId: string): boolean {
		return this.directQueryService.stop(runId);
	}

	isVaultActionProcessActive(runId: string): boolean {
		return this.processExecution.isVaultActionProcessActive(runId);
	}

	isQueryExecutionActive(runId: string, backendId = "codex-cli"): boolean {
		if (!isCliBackendId(backendId)) {
			return this.directQueryService.isActive(runId);
		}
		return this.isVaultActionProcessActive(runId);
	}

	async activateDashboardView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		const leaf = existing || this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
		if (!existing) {
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	async activateCodePracticeView(): Promise<void> {
		const contextFile = this.app.workspace.getActiveFile() || this.lastContextFile;
		const existing = this.app.workspace.getLeavesOfType(CODE_PRACTICE_VIEW_TYPE)[0];
		const leaf = existing || this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
		if (!existing) {
			await leaf.setViewState({ type: CODE_PRACTICE_VIEW_TYPE, active: true });
		}
		if (leaf.view instanceof CodePracticeView) leaf.view.setRelatedNote(contextFile);
		await this.app.workspace.revealLeaf(leaf);
	}

	async activateQueryWikiView(initialQuestion = ""): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(QUERY_WIKI_VIEW_TYPE)[0];
		const leaf = existing || this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
		if (!existing) {
			await leaf.setViewState({ type: QUERY_WIKI_VIEW_TYPE, active: true });
		}
		if (leaf.view instanceof QueryWikiView) {
			leaf.view.setInitialQuestion(initialQuestion);
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	isMineruArticleFile(file: unknown): file is TFile {
		return file instanceof TFile
			&& file.extension === "md"
			&& /^papers\/[^/]+\/article\.md$/i.test(normalizePath(file.path));
	}

	isConfiguredReaderMarkdownFile(file: unknown): file is TFile {
		if (!(file instanceof TFile) || file.extension !== "md") return false;
		const filePath = normalizePath(file.path).toLowerCase();
		return this.settings.readerMarkdownFolders.some((folder) => {
			const root = normalizePath(folder).replace(/\/$/, "").toLowerCase();
			return Boolean(root) && filePath.startsWith(`${root}/`);
		});
	}

	isReaderDocumentFile(file: unknown): file is TFile {
		return this.isMineruArticleFile(file) || this.isConfiguredReaderMarkdownFile(file);
	}

	async activateMineruReaderView(articlePath = "", preferredLeaf?: WorkspaceLeaf): Promise<void> {
		const contextFile = this.app.workspace.getActiveFile() || this.lastContextFile;
		const resolvedPath = normalizePath(
			articlePath || (this.isReaderDocumentFile(contextFile) ? contextFile.path : ""),
		);
		const activation = this.mineruReaderActivationQueue.then(
			() => this.activateMineruReaderViewOnce(resolvedPath, preferredLeaf),
		);
		this.mineruReaderActivationQueue = activation.catch(() => undefined);
		await activation;
	}

	private async activateMineruReaderViewOnce(
		resolvedPath: string,
		preferredLeaf?: WorkspaceLeaf,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(resolvedPath);
		if (!this.isReaderDocumentFile(file)) {
			new Notice("请先选择已配置目录中的 Markdown 文档");
			return;
		}
		if (preferredLeaf) {
			this.app.workspace.getLeavesOfType(MINERU_READER_VIEW_TYPE).forEach((leaf) => {
				if (leaf !== preferredLeaf) leaf.detach();
			});
			await preferredLeaf.setViewState({
				type: MINERU_READER_VIEW_TYPE,
				active: true,
				state: { articlePath: file.path },
			});
			await this.app.workspace.revealLeaf(preferredLeaf);
			return;
		}
		const existing = this.consolidateMineruReaderLeaves();
		const leaf = existing || this.app.workspace.getLeaf("tab");
		if (!existing) {
			await leaf.setViewState({
				type: MINERU_READER_VIEW_TYPE,
				active: true,
				state: { articlePath: file.path },
			});
		} else if (leaf.view instanceof MineruReaderView) {
			await leaf.view.setArticlePath(file.path);
		} else {
			await leaf.setViewState({
				type: MINERU_READER_VIEW_TYPE,
				active: true,
				state: { articlePath: file.path },
			});
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	async openReaderSourceMarkdown(articlePath: string): Promise<void> {
		const normalizedPath = normalizePath(articlePath);
		const file = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (!(file instanceof TFile)) return;
		this.readerAutoOpenBypass.add(normalizedPath);
		try {
			await this.app.workspace.getLeaf("tab").openFile(file);
		} finally {
			window.setTimeout(() => this.readerAutoOpenBypass.delete(normalizedPath), 1000);
		}
	}

	private consolidateMineruReaderLeaves(): WorkspaceLeaf | undefined {
		const leaves = this.app.workspace.getLeavesOfType(MINERU_READER_VIEW_TYPE);
		const activeLeaf = this.app.workspace.getActiveViewOfType(MineruReaderView)?.leaf;
		const primary = activeLeaf && leaves.includes(activeLeaf) ? activeLeaf : leaves[0];
		leaves.forEach((leaf) => {
			if (leaf !== primary) leaf.detach();
		});
		return primary;
	}

	getMineruArticlePath(run: TaskRun): string {
		if (run.actionId !== "paper-ingest") return "";
		const normalized = `${run.output}\n${run.summary}`.replace(/\\\\|\\/g, "/");
		const direct = /(?:^|[\s"'])(?:knowledge-base\/)?(papers\/[A-Za-z0-9._-]+\/article\.md)(?=$|[\s"'}\]])/im.exec(normalized)?.[1];
		if (direct && this.isMineruArticleFile(this.app.vault.getAbstractFileByPath(normalizePath(direct)))) {
			return normalizePath(direct);
		}
		const packageMatch = /(?:^|\/)(?:knowledge-base\/)?papers\/([A-Za-z0-9._-]+)(?=$|[\s"'}\]])/im.exec(normalized);
		if (!packageMatch) return "";
		const candidate = normalizePath(`papers/${packageMatch[1]}/article.md`);
		return this.isMineruArticleFile(this.app.vault.getAbstractFileByPath(candidate)) ? candidate : "";
	}
};
