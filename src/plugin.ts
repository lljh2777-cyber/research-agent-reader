import {
	FileSystemAdapter,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	TFile,
	normalizePath,
	parseYaml,
	type WorkspaceLeaf,
} from "obsidian";

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { AcquisitionService } from "./fulltext/service";
import { readPaperLibrary } from "./library/reader";
import { libraryNavigation } from "./library/browser";
import type { LibraryObjectSummary } from "./library/types";
import { PaperLibraryView, PAPER_LIBRARY_VIEW_TYPE } from "./views/paper-library";
import { documentLearningEntry, type LearningEntry } from "./learning/entry";
import { TopicLearningService } from "./topic-learning/service";
import { TopicSessionStore } from "./topic-learning/store";
import { TopicLearningView, TOPIC_LEARNING_VIEW_TYPE } from "./views/topic-learning";
import { TopicStudyService } from "./topic-learning/study-service";
import { TopicStudyStore } from "./topic-learning/study-store";
import { TopicStudyExports, TOPIC_EXPORT_ROOT } from "./topic-learning/export";
import { TopicStudyView, TOPIC_STUDY_VIEW_TYPE } from "./views/topic-study";
import { libraryMineruVerifier } from "./library/mineru-verifier";
import { JournalPaperRecordStore, readPaperRecordIdentities } from "./library/record-store";
import { PaperRecordService, type PaperRecordEdit } from "./library/record-service";
import { AcquisitionRepository } from "./fulltext/repository";
import { FileAcquisitionStorage } from "./fulltext/file-storage";
import { DemoAcquisitionBackend } from "./fulltext/demo-backend";
import { FulltextAcquisitionModal } from "./fulltext/modal";
import { acquisitionTaskRun } from "./fulltext/task-run";
import { HttpsSourceTransport } from "./fulltext/transport";
import { PmcAcquisitionBackend } from "./fulltext/pmc-backend";
import { AcquiredPdfPreview } from "./fulltext/pdf-preview";
import { openAcquiredIntake } from "./fulltext/intake-modal";
import { TaskResultModal } from "./modals/task-result";
import { validateAcquiredIntake } from "./fulltext/intake-adapter";
import { decodeIntakeRef, type AcquisitionIntakeRef } from "./fulltext/contracts";
import { SourceIntakeService } from "./papers/source-intake";
import { createVaultCatalog, sourceIndexIO } from "./papers/vault-catalog";
import { FileSourceStorage } from "./sources/storage";
import { openSourceSave } from "./papers/source-save-modal";
import { JatsIntakeService } from "./jats/intake";
import { openJatsSave } from "./jats/modal";
import { JatsWikiService } from "./jats/wiki-service";
import { openJatsWiki } from "./jats/wiki-modal";
import { commitSourceNote } from "./agent/tools";
import { runBoundedAgentLoop } from "./agent/loop";
import { matchStructuredReference, validateStructuredReference, structuredLocationLabel } from "./reading/structured-reference";
import { renderAuthorizedPdfIdentityPage } from "./agent/pdf-identity";
import { catalogIntake, legacyCatalogAssociation } from "./papers/agent-intake";
import type { AcquisitionMode } from "./fulltext/contracts";
import { IngestRecords, validateIngestRequest } from "./agent/ingest-records";
import { openIngestContinuation } from "./views/ingest-continuation";
import { IngestRegistrationController } from "./views/ingest-registration";
import { ingestSteps, normalizeIngestProgress, type IngestProgress } from "./agent/ingest-progress";

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
import { reconcilePublishedVaultTree } from "./runtime/vault-tree-reconcile";
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
import { runMineruProcessCommand } from "./runtime/mineru-process";
import { AgentLoopService, type AgentLoopRunOutcome } from "./agent/agent-loop-service";
import { ReadingAssistantService } from "./assistant/service";
import { probeReadingSchema } from "./assistant/probe";
import { structuredProfileKey, supportsReadingSchema } from "./providers/structured";
import { FileAssistantStorage } from "./assistant/store";
import { ReadingAssistantModal } from "./views/reading-assistant";
import { ReadingExportModal } from "./views/reading-export";
import { readReadingOutcomes } from "./reading/outcomes";
import { resolveAssistantAction, safeAssistantExportPath } from "./assistant/action-results";
import type { AssistantExecution } from "./assistant/types";
import { inKnowledgeScope, contentHash as assistantHash } from "./retrieval/chunks";
import type { PaperIngestFlowOptions } from "./agent/paper-ingest-flow";
import { VaultLintService } from "./services/vault-lint";
import { makeVaultSourcePathResolver, readVaultEvidencePackets } from "./services/vault-evidence";
import { saveQueryAnswerNote } from "./services/query-note";
import { searchTavily, type WebSearchHttpDeps } from "./services/web-search";
import { AgentDashboardSettingTab } from "./settings/settings-tab";
import { requestHumanIdentityConfirmation } from "./modals/human-identity-confirmation";
import { CodePracticeView } from "./views/code-practice";
import { DashboardView } from "./views/dashboard";
import { MineruReaderView } from "./views/mineru-reader";
import { QueryWikiView } from "./views/query-wiki";
import { ReadingWorkspaceView } from "./views/reading-workspace";
import { ReadingWorkspaceService } from "./reading/workspace";
import { ReadingEngine } from "./reading/engine";
import { readingHash } from "./reading/document";
import { DirectReadingBackend, CodexReadingBackend } from "./reading/backend";
import { READING_VIEW_TYPE, type ReadingBackend, type ReadingSession } from "./reading/types";
import { readingEntryDomain } from "./reading/entry";
import { LearningLibrary } from "./curation/learning";
import { CurationService } from "./curation/service";
import { CurationWriter } from "./curation/writer";
import { FileCurationStore } from "./curation/store";
import type { CurationContext, CurationReview } from "./curation/types";
import { KnowledgeCurationModal, KnowledgeMaintenanceModal } from "./views/knowledge-curation";
import { serializeActionRequest } from "./runtime/action-request";
import type { DashboardActionOptions } from "./actions";
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
import { KnowledgeRetrievalService } from "./retrieval/service";
import { BgeModels } from "./retrieval/models";
import { FileVectorStorage } from "./retrieval/store";
import { readKnowledgeDocuments } from "./retrieval/vault";
import { knowledgeTrace } from "./retrieval/trace";
import type { SearchOptions } from "./retrieval/types";
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
		runRetrievalPreflight: (runId, question, expandedTerms, signal) => {
			return this.runVaultRetrievalPreflight(runId, question, expandedTerms, signal);
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
		confirmPaperIdentity: (request) => requestHumanIdentityConfirmation(this.app, request),
		prepareSourceIntake:(options,authorized,signal)=>catalogIntake(this.app,this.getSourceCatalog(),this.getAcquisitionService(),options,authorized,signal),
		legacySourceAssociation:identity=>legacyCatalogAssociation(this.getSourceCatalog(),identity),
	});
	private readonly lightAgentResults = new Map<string, AgentLoopRunOutcome>();
	private annotationService?: AnnotationService;
	private readingWorkspace?: ReadingWorkspaceService;
	private readingAssistant?: ReadingAssistantService;
	private assistantModal?: ReadingAssistantModal;
	private readingEngine?: ReadingEngine;
	private readingOpenings: Promise<void> = Promise.resolve();
	private libraryOpenings: Promise<void> = Promise.resolve();
	private topicOpenings: Promise<void> = Promise.resolve();
	private topicLearning?: TopicLearningService;
	private topicStudy?: TopicStudyService;
	private topicStudyOpenings: Promise<void> = Promise.resolve();
	private lexicalRetriever: LexicalVaultRetriever | null = null;
	private knowledgeService: KnowledgeRetrievalService | null = null;
	private knowledgeModels: BgeModels | null = null;
	private learningLibrary?: LearningLibrary;
	private curationService?: CurationService;
	private curationWriter?: CurationWriter;
	private curationModals = new Set<Modal>();
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
	private readonly taskRunListeners = new Set<(progressOnly?: boolean) => void>();
	private readonly acquisitionServices = new Map<AcquisitionMode, AcquisitionService>();
	private readonly acquisitionModals = new Set<FulltextAcquisitionModal>();
	private readonly fulltextPreviews = new Set<Modal>();
	private acquisitionClosing = false;
	private readonly acquisitionDialogs=new Set<Modal>();
	trackAcquisitionDialog(modal:Modal):boolean { if(this.acquisitionClosing)return false;this.acquisitionDialogs.add(modal);const close=modal.onClose.bind(modal);modal.onClose=()=>{this.acquisitionDialogs.delete(modal);close();};return true; }
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
			&& !oldRun.acquisitionSource
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
		this.registerView(READING_VIEW_TYPE, (leaf) => new ReadingWorkspaceView(leaf, this));
		this.registerView(PAPER_LIBRARY_VIEW_TYPE, (leaf) => new PaperLibraryView(leaf, this));
		this.registerView(TOPIC_LEARNING_VIEW_TYPE, (leaf) => new TopicLearningView(leaf, this));
		this.registerView(TOPIC_STUDY_VIEW_TYPE, (leaf) => new TopicStudyView(leaf, this));
		this.addCommand({ id: "open-topic-planning", name: "打开主题路线（预览）", callback: () => { void this.activateLearningSpace({ kind: "topic" }).catch(error => new Notice(String(error))); } });
		this.addCommand({ id: "open-paper-library", name: "打开文献库", callback: () => { void this.activatePaperLibrary().catch(error => new Notice(String(error))); } });
		this.addCommand({ id: "open-interactive-reading", name: "打开 PDF 交互深读", callback: () => { void this.activateReadingWorkspace(); } });
		this.addCommand({ id: "open-code-reading", name: "打开代码交互阅读", callback: () => { void this.activateReadingWorkspace({ domain: "code" }); } });
		this.addCommand({ id: "open-knowledge-maintenance", name: "打开知识库维护", callback: () => this.openKnowledgeMaintenance() });
		this.addCommand({ id: "open-fulltext-acquisition", name: "按标识获取论文全文", callback: () => this.openFulltextAcquisition() });
		this.addCommand({ id: "demo-fulltext-acquisition", name: "全文获取流程演示（开发）", callback: () => this.openFulltextAcquisition("demo") });
		void Promise.resolve().then(() => this.getAcquisitionService().ready()).catch(() => new Notice("全文获取记录读取失败，其他功能仍可使用"));
		void Promise.resolve().then(() => this.getJatsWikiService().ready()).catch(() => new Notice("JATS Wiki 草稿记录读取失败，原记录保留"));
		this.registerEvent(this.app.vault.on("modify", file => this.curationService?.noteChange(file.path)));
		this.registerEvent(this.app.vault.on("delete", file => this.curationService?.noteChange(file.path)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { this.curationService?.noteChange(oldPath); this.curationService?.noteChange(file.path); }));
		this.registerView(MINERU_READER_VIEW_TYPE, (leaf) => new MineruReaderView(leaf, this));
		this.app.workspace.onLayoutReady(() => {
			this.consolidateMineruReaderLeaves();
			void this.reconcileMissingPublishedPackages();
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

	async onunload(): Promise<void> {
		this.topicLearning?.dispose();
		await this.topicStudy?.dispose();
		this.acquisitionClosing = true; for (const modal of this.fulltextPreviews) modal.close();
		for(const modal of [...this.acquisitionDialogs])modal.close();
		await this.sourceIntakeService?.dispose();
		await this.jatsIntakeService?.dispose();
		await this.jatsWikiService?.dispose();
		for (const modal of [...this.acquisitionModals]) modal.close();
		await Promise.all([...this.acquisitionServices.values()].map(service => service.dispose()));
		for (const modal of [...this.curationModals]) modal.close();
		await this.readingAssistant?.dispose();
		await this.curationService?.dispose();
		this.learningLibrary?.dispose();
		this.knowledgeService?.dispose();
		await this.readingWorkspace?.dispose();
		this.annotationPopover?.close();
		this.hideAnnotationChip();
		await this.flushScheduledSettingsSave();
		await this.agentLoopService.shutdown().catch((error) => {
			console.error("Light-agent shutdown barrier failed", error);
		});
		this.processExecution.shutdown();
	}

	getDashboardAction(actionId: string): DashboardAction | null {
		return ACTION_BY_ID.get(actionId) || null;
	}

	async openSelectionAnnotation(): Promise<void> {
		if (!this.annotationService) return;
		try {
			const selection = await this.annotationService.captureSelection();
			const record = await this.annotationService.findAnnotationForSelection(selection);
			this.openAnnotationPopover({
				anchorRect: selection.anchorRect,
				...(record ? { record } : { selection }),
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
		this.settings.fulltextUnpaywallEnabled=storedSettings.fulltextUnpaywallEnabled===true;
		this.settings.fulltextUnpaywallEmail=typeof storedSettings.fulltextUnpaywallEmail==="string"?storedSettings.fulltextUnpaywallEmail.slice(0,254):"";
		this.settings.knowledgeRetrievalMode = storedSettings.knowledgeRetrievalMode === "hybrid" || storedSettings.knowledgeRetrievalMode === "rerank" ? storedSettings.knowledgeRetrievalMode : "lexical";
		this.settings.knowledgeSecretId = String(storedSettings.knowledgeSecretId || "siliconflow").trim().slice(0, 200);
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
			const recoveredProgress = completion.ingestProgress || run.ingestProgress;
			const differs = run.status !== completion.status
				|| run.exitCode !== completion.exitCode
				|| run.finishedAt !== completion.finishedAt
				|| run.output !== recoveredOutput
				|| run.outputPath !== completion.relativePath
				|| run.error !== recoveredError
				|| run.summary !== recoveredSummary
				|| JSON.stringify(run.artifacts) !== JSON.stringify(recoveredArtifacts)
				|| JSON.stringify(run.ingestProgress) !== JSON.stringify(recoveredProgress);
			if (differs) {
				run.status = completion.status;
				run.exitCode = completion.exitCode;
				run.finishedAt = completion.finishedAt;
				run.output = recoveredOutput;
				run.outputPath = completion.relativePath;
				run.error = recoveredError;
				run.summary = recoveredSummary;
				run.artifacts = recoveredArtifacts;
				run.ingestProgress = recoveredProgress;
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
		this.settings.mineruSecretId = String(storedSettings.mineruSecretId || "").trim().slice(0, 160);
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

	private getMineruToken(): string {
		const secretId = String(this.settings.mineruSecretId || "").trim();
		if (!secretId) return "";
		return String(this.app.secretStorage?.getSecret?.(secretId) || "").trim();
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
		const acquisitionRuns = this.acquisitionServices.get("production")?.list().map(acquisitionTaskRun) || [];
		return [...this.taskRuns, ...acquisitionRuns, ...(this.jatsWikiService?.taskRuns() || [])].sort((a, b) => {
			return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
		});
	}

	subscribeTaskRuns(listener: (progressOnly?: boolean) => void): () => void {
		this.taskRunListeners.add(listener);
		return () => { this.taskRunListeners.delete(listener); };
	}

	private notifyTaskRuns(progressOnly = false): void {
		for (const listener of [...this.taskRunListeners]) {
			try { listener(progressOnly); } catch (error) { console.warn("Could not refresh Dashboard tasks", error); }
		}
	}

	updateIngestProgress(runId: string, value: unknown): void {
		const run = this.getTaskRun(runId), progress = normalizeIngestProgress(value);
		if (!run || run.actionId !== "paper-ingest" || !["running", "queued"].includes(run.status) || !progress) return;
		const before = run.ingestProgress;
		if (before && JSON.stringify(before.steps) === JSON.stringify(progress.steps) && before.steps.indexOf(before.stage) > progress.steps.indexOf(progress.stage)) return;
		if (JSON.stringify(before) === JSON.stringify(progress)) return;
		run.ingestProgress = progress;
		this.notifyTaskRuns(true);
		// Persist stage transitions only; tool updates stay in memory until the
		// next stage/completion. No extra model requests or per-token disk writes.
		if (!before || before.stage !== progress.stage || before.waiting !== progress.waiting) {
			void this.withTaskRunMutation(() => this.saveSettings()).catch(error => console.warn("Could not save intake progress", error));
		}
	}

	getTaskRun(runId: string): TaskRun | null {
		const wiki = this.jatsWikiService?.taskRuns().find(r => r.id === runId); if (wiki) return wiki;
		const acquisition = this.acquisitionServices.get("production")?.get(runId);
		return acquisition ? acquisitionTaskRun(acquisition) : this.taskRuns.find((run) => run.id === runId) || null;
	}

	getAcquisitionService(mode: AcquisitionMode = "production"): AcquisitionService {
		let service = this.acquisitionServices.get(mode);
		if (!service) {
			const directory = this.readingPluginDirectory();
			const deviceId = createHash("sha256").update(hostname() + "\n" + path.resolve(directory).toLowerCase()).digest("hex");
			const storage = new FileAcquisitionStorage(directory, mode);
			service = new AcquisitionService(new AcquisitionRepository(storage, mode), deviceId, mode === "demo" ? new DemoAcquisitionBackend() : new PmcAcquisitionBackend(new HttpsSourceTransport(), storage,undefined,()=>({enabled:this.settings.fulltextUnpaywallEnabled,email:this.settings.fulltextUnpaywallEmail}),new FileSourceStorage(directory)));
			if (mode === "production") service.subscribe(progressOnly => { if (!progressOnly) this.notifyTaskRuns(); });
			this.acquisitionServices.set(mode, service);
		}
		return service;
	}

	openFulltextAcquisition(mode: AcquisitionMode = "production", jobId?: string): void {
		try {
			const modal = new FulltextAcquisitionModal(this.app, this.getAcquisitionService(mode), jobId, () => this.acquisitionModals.delete(modal), id => this.openAcquiredPdf(id), {open:id=>openAcquiredIntake(this,id),save:id=>openSourceSave(this,id),jats:id=>openJatsSave(this,id),runs:()=>this.getTaskRuns(),subscribe:listener=>this.subscribeTaskRuns(listener),openRun:run=>new TaskResultModal(this.app,this,run,null).open()});
			this.acquisitionModals.add(modal); modal.open();
		} catch { new Notice("全文获取需要可读写的桌面插件目录"); }
	}
	private sourceIntakeService?:SourceIntakeService;
	private jatsIntakeService?:JatsIntakeService;
	private jatsWikiService?: JatsWikiService;
	getJatsWikiService(): JatsWikiService {
		if (this.acquisitionClosing) throw new Error("插件已关闭");
		if (!this.jatsWikiService) {
			const storage = new FileSourceStorage(this.getActiveVaultRoot());
			this.jatsWikiService = new JatsWikiService({ catalog: this.getSourceCatalog(), journal: new FileSourceStorage(this.readingPluginDirectory()),
				readNote: async p => { const bytes = await storage.read(p, 4 * 1024 * 1024); return bytes ? Buffer.from(bytes).toString("utf8") : null; },
				commit: async (citekey, fields, content, created, verify) => {
					await commitSourceNote({ app: this.app }, citekey, fields, "", { created, expectedContent: content, beforeCreate: verify });
					const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { reconcileInternalFile?(path: string): void | Promise<void> };
					await adapter.reconcileInternalFile?.(`wiki/sources/${citekey}.md`);
				},
				run: async request => {
					const profile = this.getVerifiedProviderProfiles().find(p => p.id === request.profileId); if (!profile) throw new Error("请选择已通过连接测试的 Direct API 模型");
					const provider = this.createLLMProvider({ ...profile, timeoutSeconds: Math.max(60, Math.min(120, profile.timeoutSeconds)) });
					return runBoundedAgentLoop({ system: request.system, user: request.user, tools: request.tools, signal: request.signal, provider, model: profile.model,
						maxSteps: Math.max(3, Math.min(8, this.settings.lightAgentMaxSteps || 8)), maxTokens: Math.max(512, Math.min(8192, this.settings.lightAgentMaxOutputTokens || 4096)),
						timeoutMs: Math.max(60_000, Math.min(600_000, this.settings.taskTimeoutMinutes * 60_000 || 300_000)), providerTimeoutMs: 120_000, maxToolOutputChars: 60000, maxToolResultChars: 24000,
						onStep: step => request.progress(step.title + (step.detail ? " · " + step.detail : "")) });
				} });
			this.jatsWikiService.subscribe(() => this.notifyTaskRuns());
		}
		return this.jatsWikiService;
	}
	async openJatsWiki(key: string, requestId?: string): Promise<void> { await openJatsWiki(this, key, requestId); }
	async openJatsWikiTask(runId: string): Promise<void> {
		const service = this.getJatsWikiService(); await service.ready(); const record = service.get(runId);
		if (!record) throw new Error("JATS Wiki 草稿记录不存在"); await this.openJatsWiki(record.request.packageKey, runId);
	}
	getJatsIntakeService():JatsIntakeService {
		if(this.acquisitionClosing)throw new Error("插件已关闭");return this.jatsIntakeService ||= new JatsIntakeService({deviceId:this.getAcquisitionService().deviceId,catalog:this.getSourceCatalog(),journal:new FileSourceStorage(this.readingPluginDirectory()),index:sourceIndexIO(this.app,this.getActiveVaultRoot()),read:id=>this.getAcquisitionService().previewJats(id),link:async(id,key)=>{await this.getAcquisitionService().linkSourcePackage(id,key);const adapter=this.app.vault.adapter as typeof this.app.vault.adapter&{reconcileInternalFile?(path:string):void|Promise<void>};await adapter.reconcileInternalFile?.(`papers/${key}/article.md`);}});
	}
	getSourceCatalog() { return createVaultCatalog(this.app,this.getActiveVaultRoot(),()=>readPaperRecordIdentities(new FileSourceStorage(this.readingPluginDirectory()))); }
	getSourceIntakeService():SourceIntakeService {
		if(this.acquisitionClosing)throw new Error("插件已关闭");
		return this.sourceIntakeService ||= new SourceIntakeService({deviceId:this.getAcquisitionService().deviceId,catalog:this.getSourceCatalog(),journal:new FileSourceStorage(this.readingPluginDirectory()),index:sourceIndexIO(this.app,this.getActiveVaultRoot()),
			readSource:async id=>{const service=this.getAcquisitionService(),source=await service.intakeSource(id),preview=await service.preview(id);return {...source,bytes:preview.bytes};},
			render:(source,page,signal)=>renderAuthorizedPdfIdentityPage({path:source.path,directory:path.dirname(source.path),originalFileName:path.basename(source.path),size:source.snapshot.artifact.byteLength,sha256:source.snapshot.artifact.sha256,retainFiles:true},page,{signal,bytes:source.bytes}),
			link:async(id,key)=>{await this.getAcquisitionService().linkSourcePackage(id,key);const adapter=this.app.vault.adapter as typeof this.app.vault.adapter&{reconcileInternalFile?(path:string):void|Promise<void>};await adapter.reconcileInternalFile?.("papers/"+key+"/source.pdf");},
		});
	}

	async openAcquiredPdf(jobId: string): Promise<void> {
		const { snapshot, bytes } = await this.getAcquisitionService().preview(jobId);
		if (this.acquisitionClosing) return;
		const modal = new AcquiredPdfPreview(this.app, bytes, snapshot, () => this.fulltextPreviews.delete(modal));
		this.fulltextPreviews.add(modal); modal.open();
	}

	getRunningTaskRun(actionId: string): TaskRun | null {
		const actionIds = ["vault-lint", "vault-lint-fix"].includes(actionId)
			? new Set(["vault-lint", "vault-lint-fix"])
			: new Set([actionId]);
		return this.getTaskRuns().find((run) => (
			actionIds.has(run.actionId)
			&& (run.status === "running" || run.status === "queued")
			&& (run.actionId !== "fulltext-acquisition" || this.acquisitionServices.get("production")?.owned(this.acquisitionServices.get("production")!.get(run.id)!))
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
		return this.getRunningTaskRun(actionId) !== null;
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
		acquisitionSource?: AcquisitionIntakeRef,
	): Promise<TaskRun> {
		return this.withTaskRunMutation(async () => {
			if (acquisitionSource && action.id !== "paper-ingest") throw new Error("获取快照只能绑定文献入库任务");
			// Check inside the save queue: two open intake dialogs must not both start.
			if (action.id === "paper-ingest" && this.isActionRunning(action.id)) {
				throw new Error("文献入库正在运行，请在控制台查看或停止当前任务");
			}
			const now = new Date().toISOString();
			const run: TaskRun = {
				...(acquisitionSource?{acquisitionSource:decodeIntakeRef(acquisitionSource)}:{}),
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
				...(action.id === "paper-ingest" ? { ingestProgress: executionConfig?.backend === "direct-api"
					? { steps: ["prepare"], stage: "prepare", detail: "正在准备入库请求", waiting: false } as IngestProgress
					: { steps: ["cli"], stage: "cli", detail: "正在执行，等待 CLI 阶段回报", waiting: false } as IngestProgress } : {}),
			};
			const originalRuns = [...this.taskRuns];
			const limit = this.settings.taskHistoryLimit || DEFAULT_SETTINGS.taskHistoryLimit;
			const candidates = [run, ...originalRuns];
			// Commit the new history before reclaiming any old sidecar. A failed
			// start save restores the previous history and leaves every old output.
			try {
				await this.persistTaskRunRetention(candidates, acquisitionSource?Math.max(limit,candidates.length):limit);
			} catch (error) {
				this.taskRuns = originalRuns;
				throw error;
			}
			this.notifyTaskRuns();
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
						completedRun.acquisitionSource?Math.max(this.settings.taskHistoryLimit,beforeRetention.length):this.settings.taskHistoryLimit || DEFAULT_SETTINGS.taskHistoryLimit,
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
				this.notifyTaskRuns();
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
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (this.settings.knowledgeRetrievalMode !== "lexical") return knowledgeTrace(await this.searchKnowledge([question, ...expandedTerms].join(" "), { identityQuery: question, signal }));
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
	getKnowledgeService(): KnowledgeRetrievalService {
		if (!this.knowledgeService) {
			const adapter = this.app.vault.adapter; if (!(adapter instanceof FileSystemAdapter)) throw new Error("向量检索需要桌面文件系统");
			this.knowledgeModels = new BgeModels(() => String(this.app.secretStorage?.getSecret(this.settings.knowledgeSecretId) || "").trim());
			this.knowledgeService = new KnowledgeRetrievalService((signal) => readKnowledgeDocuments(this.app, signal), new FileVectorStorage(path.join(adapter.getBasePath(), this.manifest.dir || ".obsidian/plugins/research-agent-reader")), this.knowledgeModels, () => this.settings.knowledgeRetrievalMode);
		}
		return this.knowledgeService;
	}
	searchKnowledge(query: string, options: SearchOptions = {}) { return this.getKnowledgeService().search(query, options); }
	private readingPluginDirectory(): string {
		const adapter = this.app.vault.adapter; if (!(adapter instanceof FileSystemAdapter)) throw new Error("知识整理需要桌面文件系统");
		return path.join(adapter.getBasePath(), this.manifest.dir || ".obsidian/plugins/research-agent-reader");
	}
	/** Explicit read-only inspection; never initializes reading recovery or models. */
	inspectPaperLibrary(signal?: AbortSignal, verifyMineruPath?: string) {
		return readPaperLibrary(new FileSourceStorage(this.getActiveVaultRoot()), new FileSourceStorage(this.readingPluginDirectory()), {
			vaultRoot: this.getActiveVaultRoot(), parseYaml, signal,
			...(verifyMineruPath !== undefined ? { verifyMineruPath, verifyMineru: libraryMineruVerifier(this.app, signal) } : {}),
		});
	}
	activatePaperLibrary(): Promise<void> {
		const operation = this.libraryOpenings.then(async () => {
			const existing = this.app.workspace.getLeavesOfType(PAPER_LIBRARY_VIEW_TYPE)[0];
			if (existing) await existing.loadIfDeferred();
			const leaf = existing || this.app.workspace.getLeaf("tab");
			if (!existing) await leaf.setViewState({ type: PAPER_LIBRARY_VIEW_TYPE, active: true });
			await this.app.workspace.revealLeaf(leaf);
		}); this.libraryOpenings = operation.catch(() => undefined); return operation;
	}
	activateLearningSpace(entry: LearningEntry = { kind: "document" }): Promise<void> {
		if (entry.kind === "topic") {
			const operation = this.topicOpenings.then(async () => {
				const existing = this.app.workspace.getLeavesOfType(TOPIC_LEARNING_VIEW_TYPE)[0];
				if (existing) await existing.loadIfDeferred();
				const leaf = existing || this.app.workspace.getLeaf("tab");
				if (!existing) await leaf.setViewState({ type: TOPIC_LEARNING_VIEW_TYPE, active: true });
				await this.app.workspace.revealLeaf(leaf);
				if (entry.sessionId && leaf.view instanceof TopicLearningView) await leaf.view.selectSession(entry.sessionId);
			}); this.topicOpenings = operation.catch(() => undefined); return operation;
		}
		return this.activateReadingWorkspace(documentLearningEntry(entry));
	}
	getTopicLearning(): TopicLearningService { return this.topicLearning ||= new TopicLearningService(new TopicSessionStore(new FileSourceStorage(this.readingPluginDirectory()))); }
	getTopicStudy(): TopicStudyService { return this.topicStudy ||= new TopicStudyService(new TopicStudyStore(new FileSourceStorage(this.readingPluginDirectory())), this.getTopicLearning()); }
	getTopicExports(): TopicStudyExports { return new TopicStudyExports(this.getTopicStudy(), new FileSourceStorage(this.getActiveVaultRoot())); }
	async openTopicExport(exportPath: string): Promise<void> {
		if (!exportPath.startsWith(TOPIC_EXPORT_ROOT + "/") || !/^wiki\/qa\/topic-learning\/t-[a-f0-9-]+\/[a-f0-9-]+\.md$/.test(exportPath)) throw new Error("主题学习导出路径无效");
		const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { reconcileInternalFile?(path: string): void | Promise<void> };
		await adapter.reconcileInternalFile?.(exportPath); await this.app.workspace.openLinkText(exportPath, "", true);
	}
	activateTopicStudy(topicId: string, confirmedRevision?: string): Promise<void> {
		const operation = this.topicStudyOpenings.then(async () => {
			const route = confirmedRevision ? await this.getTopicStudy().start(topicId, confirmedRevision) : "";
			const existing = this.app.workspace.getLeavesOfType(TOPIC_STUDY_VIEW_TYPE)[0]; if (existing) await existing.loadIfDeferred();
			const leaf = existing || this.app.workspace.getLeaf("tab"); if (!existing) await leaf.setViewState({ type: TOPIC_STUDY_VIEW_TYPE, active: true });
			await this.app.workspace.revealLeaf(leaf); if (leaf.view instanceof TopicStudyView) await leaf.view.openStudy(topicId, route);
		}); this.topicStudyOpenings = operation.catch(() => undefined); return operation;
	}
	getTopicModels(): Array<{ id: string; name: string; model: string }> { return this.getVerifiedProviderProfiles().map(({ id, name, model }) => ({ id, name, model })); }
	createTopicBackend(profileId: string): ReadingBackend {
		const profile = this.getVerifiedProviderProfiles().find(p => p.id === profileId);
		if (!profile) throw new Error("请选择已通过连接测试的 Direct API 模型");
		return this.createReadingBackend({ backend: profile.id, model: profile.model }, false);
	}
	async openLibraryObject(item: LibraryObjectSummary, read: boolean, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const fresh = await this.inspectPaperLibrary(signal, item.source?.format === "mineru" ? item.source.path : undefined);
		const target = libraryNavigation(item, fresh, read); signal.throwIfAborted();
		if (target.kind === "session") {
			const service = this.getReadingWorkspace(); await service.ready(); signal.throwIfAborted();
			const source = service.repository.get(target.sessionId).source, expected = item.reading!.source;
			if (source.kind !== expected.kind || source.path !== expected.path || source.fingerprint !== expected.fingerprint) throw new Error("会话来源已变化，请刷新后重试");
			await this.activateLearningSpace({ kind: "document", reading: { sessionId: target.sessionId } }); return;
		}
		if (target.kind === "source" && target.read) {
			const kind = { pdf: "pdf", mineru: "article", jats: "structured", markdown: "article" }[target.format] as "pdf" | "article" | "structured";
			await this.activateLearningSpace({ kind: "document", reading: { source: { kind, path: target.path } } }); return;
		}
		if (target.kind === "source" && (target.format === "mineru" || target.format === "jats")) { await this.activateMineruReaderView(target.path); return; }
		const file = this.app.vault.getAbstractFileByPath(normalizePath(target.path));
		if (!(file instanceof TFile)) throw new Error("所选文件已不存在，请刷新文献库");
		signal.throwIfAborted(); await this.app.workspace.getLeaf("tab").openFile(file);
	}
	private paperRecords(): PaperRecordService {
		return new PaperRecordService(new JournalPaperRecordStore(new FileSourceStorage(this.readingPluginDirectory())), () => this.inspectPaperLibrary());
	}
	preparePaperRecord(paperId: string) { return this.paperRecords().prepare(paperId); }
	savePaperRecord(edit: PaperRecordEdit) { return this.paperRecords().save(edit); }
	getLearningLibrary(): LearningLibrary {
		if (!this.learningLibrary) { this.getKnowledgeService(); this.learningLibrary = new LearningLibrary(this.app, this.getReadingWorkspace(), new FileVectorStorage(this.readingPluginDirectory(), "learning-index"), this.knowledgeModels!, () => this.settings.knowledgeRetrievalMode); }
		return this.learningLibrary;
	}
	getCurationService(): CurationService {
		if (!this.curationService) this.curationService = new CurationService(this.app, this.getReadingWorkspace(), new FileCurationStore(this.readingPluginDirectory()), session => this.createReadingBackend(session, false), (query, options) => this.searchKnowledge(query, options));
		return this.curationService;
	}
	getCurationWriter(): CurationWriter { return this.curationWriter ||= new CurationWriter(this.getCurationService()); }
	getReadingAssistant(): ReadingAssistantService {
		return this.readingAssistant ||= new ReadingAssistantService({ workspace: this.getReadingWorkspace(),
			backend: (session, profileId) => {
				if (!this.getVerifiedProviderProfiles().some(p => p.id === profileId)) throw new Error("请选择已通过连接测试的 Direct API 模型");
				return this.createReadingBackend({ ...session, backend: profileId }, false);
			}, search: (query, options) => this.searchKnowledge(query, options),
			readFile: async filename => { if (!inKnowledgeScope(filename)) throw new Error("来源不在正式知识范围"); const file = this.app.vault.getAbstractFileByPath(filename); if (!(file instanceof TFile)) throw new Error("知识来源已缺失"); return this.app.vault.read(file); },
			learning: (session, nodeId, signal) => this.getLearningLibrary().find(session, [nodeId], signal),
			outcomes: session => readReadingOutcomes(this.app, session, this.getCurationService()),
			resolveAction: async (sessionId, action) => {
				const service = this.getCurationService(); await service.ready();
				return resolveAssistantAction(this.getReadingWorkspace().repository.get(sessionId), action, { review: id => service.reviews.get(id), revisions: () => service.revisions.values(), readExport: async path => {
					if (!safeAssistantExportPath(path)) throw new Error("导出路径无效"); const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error("导出文件缺失"); return this.app.vault.read(file);
				} });
			},
			subscribeActions: changed => { const reading = this.getReadingWorkspace().repository.subscribe(changed), curation = this.getCurationService().subscribe(changed); return () => { reading(); curation(); }; },
		}, new FileAssistantStorage(this.readingPluginDirectory()));
	}
	async testReadingSchema(profileId: string): Promise<void> {
		const profile = this.getVerifiedProviderProfiles().find(p => p.id === profileId); if (!profile) throw new Error("请选择已通过连接测试的 Direct API");
		const snapshot = structuredClone(profile); const result = await probeReadingSchema(this.createLLMProvider(snapshot), snapshot);
		const current = this.getProviderProfile(profileId); if (!current || structuredProfileKey(current) !== result.key) throw new Error("接口配置已变化，请重新测试");
		current.structuredOutput = result; await this.saveSettings(); new Notice(result.message, 8000);
	}
	openReadingAssistant(sessionId: string, nodeId: string): void {
		try {
			if (this.getReadingWorkspace().repository.get(sessionId).source.kind === "code") throw new Error("代码会话请使用主线和支线追问；阅读助手暂面向论文");
			const session = this.getReadingWorkspace().repository.get(sessionId); if (session.demo || !session.nodes.some(n => n.id === nodeId && n.status === "done")) throw new Error("请先选择一个已完成的正式阅读节点");
			this.assistantModal?.close(); this.assistantModal = this.showCurationModal(new ReadingAssistantModal(this.app, this, sessionId, nodeId));
			const modal = this.assistantModal, close = modal.onClose.bind(modal); modal.onClose = () => { close(); if (this.assistantModal === modal) this.assistantModal = undefined; };
		} catch (error) { new Notice(String(error)); }
	}
	async dispatchAssistantAction(runId: string, actionId: string): Promise<void> {
		await this.getReadingAssistant().dispatch(runId, actionId, async (action, sessionId) => {
			const service = this.getReadingAssistant(), executionId = action.execution!.id;
			const report = (patch: Partial<Omit<AssistantExecution, "id" | "updated">>) => service.recordExecution(runId, actionId, executionId, patch);
			const feedbackFailure = (error: unknown) => new Notice("业务结果请在原功能查看；助手状态保存失败：" + String(error), 8000);
			const failed = async (error: unknown) => { await report({ state: "failed", detail: String(error) }).catch(feedbackFailure); };
			if (action.kind === "curation") this.showCurationModal(new KnowledgeCurationModal(this.app, this, sessionId, action.nodeIds[0], undefined, { nodeIds: action.nodeIds, target: action.target }, {
				prepared: async review => { await report({ state: review.state === "generating" ? "running" : "waiting", reviewId: review.id, path: review.context.target.path, detail: "已关联整理批次，结果随原功能更新" }); }, failed,
			}));
			else if (action.kind === "export") this.showCurationModal(new ReadingExportModal(this.app, () => this.getReadingWorkspace().repository.get(sessionId), action.nodeIds[0], (query, options) => this.searchKnowledge(query, options), filename => this.openVaultFile(filename), () => this.openKnowledgeCuration(sessionId, action.nodeIds[0]), action.scope, {
				prepared: async receipt => { await report({ ...receipt, state: "running", detail: "正在保存学习笔记" }); },
				finished: async result => { await report({ state: result.warning ? "needs-review" : "succeeded", path: result.path, reused: !!result.reused, warning: result.warning?.slice(0, 1000), detail: result.warning || (result.reused ? "已复用已有学习笔记" : "学习笔记已保存") }).catch(feedbackFailure); }, failed,
			}));
			else {
				await this.openLearningRecord(sessionId, action.nodeIds[0]);
				void this.getReadingWorkspace().advance(sessionId, { expectedParentId: action.nodeIds[0], prepared: async nodeId => { await report({ state: "running", nodeId, detail: "正在生成主线讲解" }); } })
					.catch(async error => { await failed(error); new Notice("主线讲解未完成，请在节点中重试：" + String(error), 8000); })
					.finally(() => { void service.refreshActions().catch(feedbackFailure); });
			}
		});
	}
	async openAssistantActionResult(runId: string, actionId: string): Promise<void> {
		const service = this.getReadingAssistant(); await service.refreshActions(); const run = service.runs.get(runId), action = run?.actions.find(a => a.id === actionId), execution = action?.execution;
		if (!run || !action || !execution) throw new Error("尚无执行记录");
		if (action.kind === "advance") { await this.openLearningRecord(run.sessionId, execution.nodeId || action.nodeIds[0]); return; }
		if (action.kind === "curation" && execution.reviewId) {
			const review = this.getCurationService().reviews.get(execution.reviewId); if (!review || review.context.sessionId !== run.sessionId) throw new Error("整理记录缺失");
			this.showCurationModal(new KnowledgeCurationModal(this.app, this, run.sessionId, review.context.nodeIds[0], review, undefined, {
				prepared: record => service.recordExecution(runId, actionId, execution.id, { state: record.state === "generating" ? "running" : "waiting", reviewId: record.id, path: record.context.target.path, detail: "已关联整理批次，结果随原功能更新" }),
				failed: async error => { await service.recordExecution(runId, actionId, execution.id, { state: "failed", detail: String(error) }).catch(e => new Notice("助手执行状态保存失败：" + String(e))); },
			})); return;
		}
		if (action.kind === "export" && execution.path && safeAssistantExportPath(execution.path)) { await this.openVaultFile(execution.path); return; }
		throw new Error("尚未关联执行结果，请在原功能查看");
	}
	async openAssistantEvidence(runId: string, sourceId: string): Promise<void> {
		const run = this.getReadingAssistant().runs.get(runId), source = run?.sources.find(s => s.id === sourceId); if (!run || !source) throw new Error("助手引用不存在");
		if (source.structured) {
			if (!run.source) throw new Error("JATS 助手记录缺少固定来源"); validateStructuredReference(source, run.source);
			const modal = new Modal(this.app); modal.titleEl.setText(source.id + " · " + source.label); modal.modalEl.addClass("reading-modal");
			modal.contentEl.createEl("p", { cls: "reading-evidence-location", text: structuredLocationLabel(source) + " · " + run.source.structured!.manifest.sourceVersionId });
			modal.contentEl.createEl("p", { text: "以下是助手实际读取时的文字快照；图像未在本轮助手中核验。" });
			modal.contentEl.createEl("pre", { cls: "reading-evidence-text", text: source.text });
			const status = modal.contentEl.createEl("p", { text: "正在核对当前原文…" }), open = modal.contentEl.createEl("button", { text: "前往原文块" }); open.disabled = true;
			const verify = async () => { const doc = await this.getReadingWorkspace().document(run.sessionId); await doc.verify(); matchStructuredReference(source, doc.source, doc.evidence); };
			open.onclick = () => void verify().then(() => this.openReadingEvidence(source.path, undefined, source.structured!.blockId)).catch(e => { status.setText("当前原文无法核对，保留历史快照：" + String(e)); open.disabled = true; });
			this.showCurationModal(modal);
			try { await verify(); if (modal.modalEl.isConnected) { status.setText("当前原文与历史依据一致。"); open.disabled = false; } }
			catch (e) { if (modal.modalEl.isConnected) status.setText("当前原文无法核对，保留历史快照：" + String(e)); } return;
		}
		const doc = await this.getReadingWorkspace().document(run.sessionId); await doc.verify();
		if (source.kind === "knowledge" && assistantHash(await this.getReadingAssistant().deps.readFile(source.path)) !== source.hash) throw new Error("知识来源已变化，请重新读取");
		if (source.kind === "paper" && doc.source.fingerprint !== source.hash) throw new Error("原文已变化，请重新读取");
		const modal = new Modal(this.app); modal.titleEl.setText(source.id + " · " + source.label); modal.modalEl.addClass("reading-modal");
		modal.contentEl.createEl("p", { text: source.role + " · " + source.path + (source.page ? " · 第 " + source.page + " 页" : "") }); modal.contentEl.createEl("pre", { cls: "reading-evidence-text", text: source.text });
		const open = modal.contentEl.createEl("button", { text: source.kind === "knowledge" ? "打开来源笔记" : doc.source.kind === "pdf" ? "查看原文页图" : "前往原文" });
		open.disabled = source.kind === "paper" && doc.source.kind === "pdf";
		open.onclick = () => { if (source.kind === "knowledge") this.openVaultFile(source.path); else if (doc.source.kind === "article") void this.openReadingEvidence(source.path, source.page).catch(error => new Notice(String(error))); };
		this.showCurationModal(modal);
		if (source.kind === "paper") {
			const original = doc.evidence.find(e => e.page === source.page && e.start === source.start && e.text.startsWith(source.text));
			if (original) { const image = await doc.image(doc.source.kind === "pdf" && original.page ? { ...original, asset: "pdf-page" } : original); if (image && modal.modalEl.isConnected) { const img = modal.contentEl.createEl("img", { attr: { alt: source.label } }); img.src = image.dataUrl; img.style.maxWidth = "100%"; if (doc.source.kind === "pdf") { open.disabled = false; open.onclick = () => img.scrollIntoView({ block: "start" }); } } }
		}
	}
	showCurationModal<T extends Modal>(modal: T): T {
		this.curationModals.add(modal); const close = modal.onClose.bind(modal); modal.onClose = () => { close(); this.curationModals.delete(modal); }; modal.open(); return modal;
	}
	openKnowledgeMaintenance(): void { this.showCurationModal(new KnowledgeMaintenanceModal(this.app, this)); }
	openKnowledgeCuration(sessionId: string, nodeId: string, review?: CurationReview): void {
		if (this.getReadingWorkspace().repository.get(sessionId).source.kind === "code") { new Notice("代码学习可导出独立笔记并关联已有笔记，暂不自动整理正式代码页"); return; }
		try { const session = this.getReadingWorkspace().repository.get(sessionId); if (session.demo || !session.nodes.some(node => node.id === nodeId && node.status === "done")) throw new Error("请选择已完成的正式阅读节点"); this.showCurationModal(new KnowledgeCurationModal(this.app, this, sessionId, nodeId, review)); }
		catch (error) { new Notice(String(error)); }
	}
	async openLearningRecord(sessionId: string, nodeId: string): Promise<void> {
		await this.activateReadingWorkspace({ sessionId }); const view = this.app.workspace.getLeavesOfType(READING_VIEW_TYPE).map(leaf => leaf.view).find(v => v instanceof ReadingWorkspaceView && v.getState().sessionId === sessionId);
		if (view instanceof ReadingWorkspaceView) view.revealLearningNode(nodeId);
	}
	async openCurationEvidence(context: CurationContext, evidenceId: string): Promise<void> {
		const evidence = context.evidence.find(item => item.id === evidenceId); if (!evidence || evidence.kind !== "paper") throw new Error("本文依据不存在");
		const source = await this.getReadingWorkspace().document(context.sessionId); await source.verify(); if (source.source.fingerprint !== context.source.fingerprint) throw new Error("原文已变化，请重新读取依据");
		const original = context.source.kind === "structured" ? matchStructuredReference(evidence, context.source, source.evidence) : source.evidence.find(item => evidence.visual ? "V:" + item.id === evidence.id : !item.asset && item.start === evidence.start && item.page === evidence.page && item.text.startsWith(evidence.text));
		if (!original) throw new Error("原文中的引用位置已无法匹配");
		const modal = new Modal(this.app); modal.titleEl.setText(evidence.label); modal.modalEl.addClass("reading-modal"); modal.contentEl.createEl("p", { text: evidence.path + (evidence.page ? " · 第 " + evidence.page + " 页" : "") });
		modal.contentEl.createEl("pre", { text: evidence.text, cls: "reading-evidence-text" });
		if (evidence.structured) modal.contentEl.createEl("p", { cls: "reading-evidence-location", text: structuredLocationLabel(evidence) + " · " + context.source.structured!.manifest.sourceVersionId });
		if (["article", "structured"].includes(source.source.kind)) { const open = modal.contentEl.createEl("button", { text: "在阅读器打开原文" }); open.onclick = () => { void source.verify().then(() => this.openReadingEvidence(evidence.path, evidence.page, evidence.structured?.blockId)).catch(error => new Notice(String(error))); }; }
		this.showCurationModal(modal);
		const image = await source.image(source.source.kind === "pdf" && original.page ? { ...original, asset: "pdf-page" } : original);
		if (image && modal.modalEl.isConnected) { const img = modal.contentEl.createEl("img", { attr: { alt: evidence.label } }); img.src = image.dataUrl; img.style.maxWidth = "100%"; }
	}
	async testKnowledgeModels(): Promise<void> {
		this.getKnowledgeService(); await this.knowledgeModels!.embed(["知识库连接测试"]); await this.knowledgeModels!.rerank("测试", ["知识库连接测试"]);
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
	resolveWebSearchBackend(profile: ProviderProfile): WebSearchBackendResolution {
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
			search: (queries, options = {}) => searchTavily(httpDeps, secret, queries, {
				...options,
				maxResults: Math.min(maxResults, options.maxResults ?? maxResults),
				timeoutMs: Math.min(timeoutMs, options.timeoutMs ?? timeoutMs),
			}),
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
	private ingestRecords?: IngestRecords;
	private ingestRegistration?: IngestRegistrationController;
	async registerIngestNote(notePath: string, runId: string): Promise<void> { await (this.ingestRegistration ||= new IngestRegistrationController(this)).open(notePath, runId); }
	async getIngestRegistrationAvailability(notePath: string): Promise<{ eligible: boolean; reason: string }> { return (this.ingestRegistration ||= new IngestRegistrationController(this)).availability(notePath); }
	getIngestRecords(): IngestRecords { return this.ingestRecords ||= new IngestRecords(this.readingPluginDirectory()); }
	async readIngestPdf(run: TaskRun): Promise<void> {
		const request = validateIngestRequest(await this.getIngestRecords().read("request", run.id), run.id);
		if (request.options.acquisitionSource) await validateAcquiredIntake(this.getAcquisitionService(), request.options);
		await this.activateReadingWorkspace({ source: { kind: "pdf", path: request.options.sourcePdfPath }, backend: request.profileId });
	}
	async continuePaperIngest(run: TaskRun): Promise<void> { await openIngestContinuation(this, run); }
	async runLightPaperIngest(
		runId: string,
		options: PaperIngestFlowOptions,
		profileId: string,
		hooks: { onEvent?: (event: DashboardProcessEvent) => void } = {},
	): Promise<AgentLoopRunOutcome> {
		const steps = ingestSteps(options);
		const boundSource = this.taskRuns.find(run => run.id === runId)?.acquisitionSource;
		if (boundSource && (!options.acquisitionSource || JSON.stringify(decodeIntakeRef(boundSource)) !== JSON.stringify(decodeIntakeRef(options.acquisitionSource)))) throw new Error("入库请求与任务绑定的获取快照不一致");
		if(options.acquisitionSource){if(this.acquisitionClosing)throw new Error("插件已关闭，入库未启动");await validateAcquiredIntake(this.getAcquisitionService(),options);if(this.acquisitionClosing)throw new Error("插件已关闭，入库未启动");}
		this.updateIngestProgress(runId, { steps, stage: "prepare", detail: "正在准备授权 PDF 与入库参数", waiting: false });
		this.lightAgentResults.delete(runId);
		await this.getIngestRecords().write("request", runId, { version: 1, runId, profileId, options: structuredClone(options) });
		return this.agentLoopService.runPaperIngest(runId, options, profileId, {
			onEvent: event => {
				if (event.status === "running" || event.status === "waiting") this.updateIngestProgress(runId, event.payload?.ingestProgress);
				hooks.onEvent?.(event);
			},
		})
			.then(async (outcome) => {
				if (outcome.exitCode === 0) this.updateIngestProgress(runId, { steps, stage: "save", detail: "正在同步文件索引并保存任务结果", waiting: false });
				const articlePath = outcome.artifacts.articlePath;
				if (articlePath && outcome.filesWritten.includes(articlePath)) {
					await this.reconcilePublishedPackage(articlePath);
				}
				this.lightAgentResults.set(runId, outcome);
				return outcome;
			})
			.catch((error) => {
				this.lightAgentResults.delete(runId);
				throw error;
			});
	}

	private async reconcilePublishedPackage(articlePath: string, notifyOnFailure = true): Promise<boolean> {
		const normalizedArticle = normalizePath(articlePath);
		const packageRoot = normalizedArticle.replace(/\/article\.md$/i, "");
		try {
			const result = await reconcilePublishedVaultTree(
				this.app.vault.adapter as typeof this.app.vault.adapter & {
					reconcileInternalFile?(path: string): void | Promise<void>;
				},
				packageRoot,
				() => this.app.vault.getAbstractFileByPath(normalizedArticle) instanceof TFile,
			);
			if (!result.supported || !result.articleIndexed) {
				console.warn("Published MinerU package is waiting for Obsidian Vault reconciliation", {
					packageRoot,
					supported: result.supported,
					reconciledEntries: result.reconciledEntries,
				});
				if (notifyOnFailure) {
					new Notice("原文包已发布，但 Obsidian 文件目录尚未同步；请执行“重新加载应用”");
				}
			}
			return result.articleIndexed;
		} catch (error) {
			console.warn("Could not reconcile published MinerU package with the Obsidian Vault index", error);
			if (notifyOnFailure) {
				new Notice("原文包已发布，但 Obsidian 文件目录刷新失败；请执行“重新加载应用”");
			}
			return false;
		}
	}

	private async reconcileMissingPublishedPackages(): Promise<void> {
		try {
			if (!await this.app.vault.adapter.exists("papers", true)) return;
			const listed = await this.app.vault.adapter.list("papers");
			const packageRoots = listed.folders
				.map((folder) => normalizePath(folder))
				.filter((folder) => /^papers\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(folder))
				.slice(0, 4_096);
			for (const packageRoot of packageRoots) {
				const articlePath = `${packageRoot}/article.md`;
				if (this.app.vault.getAbstractFileByPath(articlePath) instanceof TFile) continue;
				if (!await this.app.vault.adapter.exists(articlePath, true)) continue;
				await this.reconcilePublishedPackage(articlePath, false);
			}
		} catch (error) {
			console.warn("Could not reconcile unindexed MinerU packages during startup", error);
		}
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
		return runMineruProcessCommand(request, this.getMineruToken());
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
			hooks: action.id === "paper-ingest" ? { ...hooks, onEvent: event => {
				if (event.type === "status" && event.status !== "done" && event.status !== "failed" && event.stage !== "stopped") {
					this.updateIngestProgress(runId, { steps: ["cli"], stage: "cli", detail: event.label || "正在执行，等待 CLI 阶段回报", waiting: event.status === "waiting" });
				}
				hooks.onEvent?.(event);
			} } : hooks,
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
		if (this.jatsWikiService?.stop(runId)) return true;
		if (this.acquisitionServices.get("production")?.get(runId)) return this.acquisitionServices.get("production")!.stop(runId);
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

	getReadingWorkspace(): ReadingWorkspaceService {
		if (!this.readingWorkspace) {
			const adapter = this.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) throw new Error("交互深读需要桌面文件系统");
			this.readingWorkspace = new ReadingWorkspaceService(this.app, adapter.getBasePath(), path.join(adapter.getBasePath(), this.manifest.dir || ".obsidian/plugins/research-agent-reader"));
			this.readingEngine = new ReadingEngine(this.readingWorkspace, session => this.createReadingBackend(session), async (query, context) => {
				const prefixes = ["sources", "concepts", "methods", "datasets", "synthesis", "mocs", "projects", "entities", "code", "r", "linux"].map((folder) => "wiki/" + folder);
				let paperPaths: string[] | undefined;
				if (context && /本文|这篇|本研究|作者/.test(context.question) && !/比较|对比|跨论文|相比/.test(context.question)) {
					const key = context.source.path.replace(/\\/g, "/").match(/papers\/([^/]+)\/article\.md$/)?.[1];
					paperPaths = (await readKnowledgeDocuments(this.app, context.signal)).filter((doc) => doc.path.startsWith("wiki/sources/") &&
						(key && doc.path === "wiki/sources/" + key + ".md" || doc.title.toLowerCase() === context.source.title.toLowerCase())).map((doc) => doc.path);
				}
				const trace = this.settings.knowledgeRetrievalMode === "lexical" ? await this.getLexicalRetriever().retrieve(query, [], { allowedPrefixes: prefixes })
					: knowledgeTrace(await this.searchKnowledge(query, { identityQuery: context?.question || query, paperPaths, signal: context?.signal, limit: 4 }));
				const evidence = await this.readVaultEvidencePacket(trace);
				return { evidence: evidence.filter((item) => prefixes.some((prefix) => item.path.startsWith(prefix + "/"))).slice(0, 4).map((item) => ({ id: "vault-" + readingHash(item.path).slice(0, 12), kind: "vault" as const,
					path: item.path, label: item.path.split("/").slice(-1)[0], text: item.content.slice(0, 6000), role: item.role, heading: item.heading, origins: item.origins, sourceHash: item.hash, start: item.start, end: item.end })),
					label: String(trace.retrieval_label || "关键词检索"), warnings: (trace as RetrievalTrace).knowledge?.warnings || [] };
			});
		}
		return this.readingWorkspace;
	}
	getReadingEngine(): ReadingEngine { this.getReadingWorkspace(); return this.readingEngine!; }
	createReadingBackend(session: Pick<ReadingSession, "backend" | "model">, streaming = true): ReadingBackend {
		if (session.backend === "codex-cli") return new CodexReadingBackend(this.settings.codexExecutable, session.model || this.settings.codexModel, this.readingPluginDirectory());
		const profile = this.getProviderProfile(session.backend); if (!profile || profile.lastTest?.ok !== true) throw new Error("请选择已通过连接测试的模型接口");
		return new DirectReadingBackend(this.createLLMProvider({ ...profile, timeoutSeconds: 120 }), profile.name, profile.model, streaming && profile.lastTest.streamingVerified === true, supportsReadingSchema(profile), () => this.resolveWebSearchBackend(profile));
	}
	activateReadingWorkspace(entry?: import("./reading/entry").ReadingEntry): Promise<void> {
		const operation = this.readingOpenings.then(async () => {
			const service = this.getReadingWorkspace(); await service.ready();
			if (entry?.sessionId) service.repository.get(entry.sessionId);
			const domain = readingEntryDomain(entry, service.repository.sessions.values());
			const leaves = this.app.workspace.getLeavesOfType(READING_VIEW_TYPE); for (const leaf of leaves) await leaf.loadIfDeferred();
			const existing = leaves.find(leaf => leaf.view instanceof ReadingWorkspaceView && leaf.view.getReadingDomain() === domain);
			const leaf = existing || this.app.workspace.getLeaf("tab");
			if (!existing || entry?.sessionId) await leaf.setViewState({ type: READING_VIEW_TYPE, state: { domain, ...(entry?.sessionId ? { sessionId: entry.sessionId } : {}) }, active: true });
			await this.app.workspace.revealLeaf(leaf);
			if (leaf.view instanceof ReadingWorkspaceView && entry?.source) leaf.view.openSource(entry);
		}); this.readingOpenings = operation.catch(() => undefined); return operation;
	}
	async runClassicReading(input: string, overrides: ExecutionOverrides, options: DashboardActionOptions, actionId: "pdf-xray" | "code-analysis" = "pdf-xray"): Promise<void> {
		const action = ACTION_BY_ID.get(actionId)!;
		const execution = this.resolveCliActionExecutionConfig(action, actionId === "code-analysis" && (overrides.backend === "claude-code" || overrides.backend === "opencode") ? overrides.backend : "codex-cli", overrides);
		const run = await this.startTaskRun(action, input.slice(0, 160), execution);
		try {
			const result = await this.runVaultAction(run.id, action, serializeActionRequest(action, input, options), execution);
			await this.finishTaskRun(run.id, { status: result.exitCode === 0 ? "done" : "failed", output: result.stdout, error: result.stderr, exitCode: result.exitCode });
			new Notice(action.label + (result.exitCode === 0 ? "已完成，可在控制台查看" : "失败，请查看控制台任务"));
		} catch (error) { await this.finishTaskRun(run.id, { status: "failed", error: String(error) }); throw error; }
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

	async openReadingEvidence(articlePath: string, page?: number, blockId?: string): Promise<void> {
		await this.activateMineruReaderView(articlePath);
		const view = this.app.workspace.getLeavesOfType(MINERU_READER_VIEW_TYPE)[0]?.view;
		if (view instanceof MineruReaderView && page) {
			view.revealReadingPage(page);
		}
		if (view instanceof MineruReaderView && blockId) view.revealReadingBlock(blockId);
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
			await this.app.workspace.revealLeaf(preferredLeaf);
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
		// Markdown rendering can wait for visibility, including in a newly created tab.
		await this.app.workspace.revealLeaf(leaf);
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
