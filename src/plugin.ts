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
	normalizeStoredTaskRuns,
	sanitizeSettingsForStorage,
} from "./runtime/persistence";
import { ProcessExecutionService } from "./runtime/process-execution";
import { VaultLintService } from "./services/vault-lint";
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
} from "./query/direct-query-service";
import type {
	CliModelDiscoveryResult,
	CodePracticeRequest,
	CodePracticeResult,
	CodexExecutionConfig,
	DashboardProcessHooks,
	DashboardProcessResult,
	ExecutionConfig,
	ExecutionOverrides,
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
	});
	private annotationService?: AnnotationService;
	private annotationPopover: AnnotationPopover | null = null;
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
		void this.flushScheduledSettingsSave();
		this.processExecution.shutdown();
	}

	getDashboardAction(actionId: string): DashboardAction | null {
		return ACTION_BY_ID.get(actionId) || null;
	}

	private async openSelectionAnnotation(): Promise<void> {
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
		const root = path.resolve(this.settings.projectRoot);
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
		const storedSettings = stored.settings && typeof stored.settings === "object" ? stored.settings : stored;
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
		if (!this.settings.projectRoot) {
			this.settings.projectRoot = this.inferProjectRoot();
		}
		let changed = false;
		const normalizedReaderFolders = normalizeReaderMarkdownFolders(
			storedSettings.readerMarkdownFolders ?? DEFAULT_SETTINGS.readerMarkdownFolders,
		);
		if (
			JSON.stringify(storedSettings.readerMarkdownFolders ?? DEFAULT_SETTINGS.readerMarkdownFolders)
			!== JSON.stringify(normalizedReaderFolders)
		) changed = true;
		this.settings.readerMarkdownFolders = normalizedReaderFolders;
		for (const run of this.taskRuns) {
			if (!run.outputPath && String(run.output || "").length > 12000) {
				try {
					run.outputPath = await this.persistTaskRunOutput(run);
					changed = true;
				} catch (error) {
					console.warn("Could not migrate Dashboard run output", error);
				}
			}
		}
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
			cwd: this.settings.projectRoot && fs.existsSync(this.settings.projectRoot)
				? this.settings.projectRoot
				: process.cwd(),
		});
		this.obsidianCliProbeState = { status: "done", result };
		return result;
	}

	async clearCompletedTaskHistory(): Promise<number> {
		const before = this.taskRuns.length;
		this.taskRuns = this.taskRuns.filter((run) => run.status === "running" || run.status === "queued");
		await this.saveSettings();
		return before - this.taskRuns.length;
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
			`项目根目录: ${this.settings.projectRoot && fs.existsSync(this.settings.projectRoot) ? "可用" : "不可用"}`,
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
				vaultSources: normalizeQueryVaultSources(message.vaultSources),
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

	inferProjectRoot(): string {
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
			const absolutePath = path.join(
				this.settings.projectRoot,
				...String(run.outputPath).split("/"),
			);
			try {
				const payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
				if (typeof payload.output === "string") return payload.output;
			} catch (error) {
				console.warn("Could not read persisted Dashboard run output", error);
			}
		}
		return String(run?.output || "");
	}

	async persistTaskRunOutput(run: TaskRun): Promise<string> {
		const output = String(run?.output || "");
		if (!output) return "";
		const relativePath = `tool-library/output/dashboard-runs/${run.id}.json`;
		const absolutePath = path.join(
			this.settings.projectRoot,
			...relativePath.split("/"),
		);
		const temporaryPath = `${absolutePath}.tmp`;
		await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
		await fs.promises.writeFile(
			temporaryPath,
			JSON.stringify({
				schema_version: 1,
				run_id: run.id,
				action_id: run.actionId,
				status: run.status,
				exit_code: run.exitCode,
				started_at: run.startedAt,
				finished_at: run.finishedAt,
				output,
			}, null, 2),
			"utf8",
		);
		await fs.promises.rename(temporaryPath, absolutePath);
		return relativePath;
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
		this.taskRuns = [run, ...this.taskRuns].slice(
			0,
			this.settings.taskHistoryLimit || DEFAULT_SETTINGS.taskHistoryLimit,
		);
		await this.saveSettings();
		return run;
	}

	async finishTaskRun(
		runId: string,
		updates: TaskRunUpdate,
	): Promise<TaskRun | null> {
		const index = this.taskRuns.findIndex((run) => run.id === runId);
		if (index === -1) return null;
		this.taskRuns[index] = {
			...this.taskRuns[index],
			...updates,
			finishedAt: new Date().toISOString(),
		};
		if (this.taskRuns[index].output && this.taskRuns[index].actionId !== "vault-lint") {
			this.taskRuns[index].outputPath = await this.persistTaskRunOutput(this.taskRuns[index]);
		}
		await this.saveSettings();
		return this.taskRuns[index];
	}

	getOkfExportStatus(): OkfExportStatus {
		const projectRoot = this.settings.projectRoot;
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
		const projectRoot = this.settings.projectRoot;
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
		const configuredRoot = String(this.settings.projectRoot || "").trim();
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
		return this.directQueryService.runRetrievalPreflight(runId, question, expandedTerms);
	}

	readVaultEvidencePacket(trace: RetrievalTrace): VaultEvidencePacket[] {
		return this.directQueryService.readEvidencePacket(trace);
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

	readVaultImageData(attachment: VaultImageAttachment): {
		attachment: VaultImageAttachment;
		content: {
			type: "image_url";
			image_url: { url: string };
		};
	} {
		const normalized = normalizeVaultImageAttachment(attachment);
		if (!normalized) {
			throw new ProviderConnectionError(
				"attachment",
				"仅支持 Vault 内的 PNG、JPEG 和 WebP 图片",
			);
		}
		const projectRoot = path.resolve(this.settings.projectRoot);
		const vaultRoot = path.resolve(projectRoot, "knowledge-base");
		if (!fs.existsSync(vaultRoot)) {
			throw new ProviderConnectionError("attachment", `Vault 根目录不存在：${vaultRoot}`);
		}
		if (normalized.path.split("/").includes("..")) {
			throw new ProviderConnectionError("attachment", "图片路径超出当前 Vault");
		}
		const absolutePath = path.resolve(vaultRoot, ...normalized.path.split("/"));
		if (!fs.existsSync(absolutePath)) {
			throw new ProviderConnectionError("attachment", `图片不存在：${normalized.path}`);
		}
		const vaultRealPath = fs.realpathSync(vaultRoot);
		const imageRealPath = fs.realpathSync(absolutePath);
		const normalizedVault = vaultRealPath.toLowerCase();
		const normalizedImage = imageRealPath.toLowerCase();
		if (
			normalizedImage !== normalizedVault
			&& !normalizedImage.startsWith(`${normalizedVault}${path.sep}`)
		) {
			throw new ProviderConnectionError("attachment", "图片路径超出当前 Vault");
		}
		const stat = fs.statSync(imageRealPath);
		if (!stat.isFile()) {
			throw new ProviderConnectionError("attachment", "图片路径不是文件");
		}
		if (stat.size > MAX_VAULT_IMAGE_BYTES) {
			throw new ProviderConnectionError(
				"attachment",
				`图片超过 ${(MAX_VAULT_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MiB 上限`,
			);
		}
		const extension = path.extname(imageRealPath).toLowerCase();
		const mimeType = VAULT_IMAGE_MIME_TYPES[extension];
		if (!mimeType) {
			throw new ProviderConnectionError("attachment", "图片格式不受支持");
		}
		return {
			attachment: {
				...normalized,
				size: stat.size,
				mimeType,
			},
			content: {
				type: "image_url",
				image_url: {
					url: `data:${mimeType};base64,${fs.readFileSync(imageRealPath).toString("base64")}`,
				},
			},
		};
	}

	buildDirectQueryMessages(
		question: string,
		priorMessages: QueryMessage[],
		evidence: VaultEvidencePacket[],
		attachments: VaultImageAttachment[] = [],
	): ChatMessage[] {
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
