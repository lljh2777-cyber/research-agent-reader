import {
	App,
	ItemView,
	MarkdownRenderer,
	Notice,
	TFile,
	normalizePath,
	setIcon,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";

import { LEARNING_SESSION_VIEW_TYPE } from "../config";
import { ReaderDocumentLoader } from "../reader/document-loader";
import type { MineruReaderPackage } from "../mineru/types";
import type { QueryWikiCompletionHandler } from "./query-wiki";
import {
	LEARNING_MODULE_DEFINITIONS,
	applyLearningBranchAnswer,
	buildLearningModules,
	buildLearningQuestionPrompt,
	createLearningBranch,
	createLearningFollowUpBranch,
	createLearningSessionState,
	nextLearningModuleId,
	normalizeLearningSessionState,
	type LearningBranch,
	type LearningEvidenceRef,
	type LearningModule,
	type LearningSessionState,
} from "../learning/session-model";

interface LearningSessionHost {
	app: App;
	activateMineruReaderView(articlePath?: string): Promise<void>;
	activateQueryWikiView(
		initialQuestion?: string,
		completionHandler?: QueryWikiCompletionHandler,
	): Promise<void>;
}

function iconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	className = "",
): HTMLButtonElement {
	const button = parent.createEl("button", {
		cls: `learning-session-icon-button ${className}`.trim(),
		attr: { "aria-label": label, title: label },
	});
	button.type = "button";
	setIcon(button, icon);
	return button;
}

function moduleStatus(
	module: LearningModule,
	state: LearningSessionState,
): "done" | "current" | "upcoming" {
	if (state.completedModuleIds.includes(module.id)) return "done";
	return state.activeModuleId === module.id ? "current" : "upcoming";
}

function evidenceIcon(kind: LearningEvidenceRef["kind"]): string {
	if (kind === "figure") return "image";
	if (kind === "source") return "file-text";
	return "text-quote";
}

function compactNodeText(value: string, limit = 190): string {
	const compact = value
		.replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[`*_~>#|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

export class LearningSessionView extends ItemView {
	private readonly plugin: LearningSessionHost;
	private readonly loader: ReaderDocumentLoader;
	private sessionState: LearningSessionState = createLearningSessionState();
	private readerPackage: MineruReaderPackage | null = null;
	private modules: LearningModule[] = [];
	private opened = false;
	private loadGeneration = 0;
	private selectedEvidenceId = "";
	private readonly verifiedResourceUrls = new Map<string, string>();

	constructor(leaf: WorkspaceLeaf, plugin: LearningSessionHost) {
		super(leaf);
		this.plugin = plugin;
		this.loader = new ReaderDocumentLoader(plugin.app);
		this.navigation = true;
	}

	getViewType(): string {
		return LEARNING_SESSION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.readerPackage?.title || "文献学习";
	}

	getIcon(): string {
		return "workflow";
	}

	getState(): Record<string, unknown> {
		return { ...this.sessionState };
	}

	async setState(state: unknown, _result: ViewStateResult): Promise<void> {
		const previousPath = this.sessionState.articlePath;
		this.sessionState = normalizeLearningSessionState(state);
		if (!this.opened) return;
		if (this.sessionState.articlePath && this.sessionState.articlePath !== previousPath) {
			await this.loadAndRender();
			return;
		}
		this.render();
	}

	async setArticlePath(articlePath: string): Promise<void> {
		const normalizedPath = normalizePath(articlePath.trim());
		if (normalizedPath === this.sessionState.articlePath && this.readerPackage) return;
		this.sessionState = createLearningSessionState(normalizedPath);
		this.selectedEvidenceId = "";
		if (this.opened) await this.loadAndRender();
		this.requestStateSave();
	}

	async onOpen(): Promise<void> {
		this.opened = true;
		if (!this.sessionState.articlePath) {
			this.renderNoDocument();
			return;
		}
		await this.loadAndRender();
	}

	async onClose(): Promise<void> {
		this.opened = false;
		this.loadGeneration += 1;
		this.readerPackage = null;
		this.modules = [];
		this.revokeVerifiedResourceUrls();
		this.contentEl.empty();
	}

	private async loadAndRender(): Promise<void> {
		const generation = ++this.loadGeneration;
		this.revokeVerifiedResourceUrls();
		this.renderLoading();
		try {
			const loaded = await this.loader.load(this.sessionState.articlePath);
			if (!this.opened || generation !== this.loadGeneration) return;
			this.readerPackage = loaded;
			this.modules = buildLearningModules(
				loaded.articleMarkdown,
				loaded.articlePath,
				loaded.visuals,
			);
			this.render();
		} catch (error) {
			if (!this.opened || generation !== this.loadGeneration) return;
			this.readerPackage = null;
			this.modules = [];
			this.renderError(error);
		}
	}

	private renderLoading(): void {
		this.contentEl.empty();
		this.contentEl.addClass("learning-session-view");
		const state = this.contentEl.createDiv({ cls: "learning-session-state" });
		const icon = state.createDiv({ cls: "learning-session-state-icon is-loading" });
		setIcon(icon, "loader-circle");
		state.createEl("strong", { text: "正在建立文献学习主线" });
		state.createEl("span", { text: "读取章节结构、图表线索与可核对的证据入口…" });
	}

	private renderNoDocument(): void {
		this.contentEl.empty();
		this.contentEl.addClass("learning-session-view");
		const state = this.contentEl.createDiv({ cls: "learning-session-state" });
		const icon = state.createDiv({ cls: "learning-session-state-icon" });
		setIcon(icon, "file-search");
		state.createEl("strong", { text: "先选择一篇文献" });
		state.createEl("span", { text: "在已配置的文献 Markdown 上打开右键菜单，选择“开始文献学习”。" });
	}

	private renderError(error: unknown): void {
		this.contentEl.empty();
		this.contentEl.addClass("learning-session-view");
		const state = this.contentEl.createDiv({ cls: "learning-session-state is-error" });
		const icon = state.createDiv({ cls: "learning-session-state-icon" });
		setIcon(icon, "circle-alert");
		state.createEl("strong", { text: "无法载入学习会话" });
		state.createEl("span", {
			text: error instanceof Error ? error.message : String(error),
		});
	}

	private render(): void {
		if (!this.readerPackage || !this.modules.length) {
			this.renderNoDocument();
			return;
		}
		this.contentEl.empty();
		this.contentEl.addClass("learning-session-view");
		const shell = this.contentEl.createDiv({ cls: "learning-session-shell" });
		this.renderHeader(shell);
		const workspace = shell.createDiv({ cls: "learning-session-workspace" });
		this.renderMap(workspace);
		this.renderInspector(workspace);
	}

	private renderHeader(shell: HTMLElement): void {
		const header = shell.createDiv({ cls: "learning-session-header" });
		const identity = header.createDiv({ cls: "learning-session-identity" });
		const documentIcon = identity.createDiv({ cls: "learning-session-document-icon" });
		setIcon(documentIcon, "file-text");
		const titleBlock = identity.createDiv({ cls: "learning-session-title-block" });
		const kicker = titleBlock.createDiv({ cls: "learning-session-kicker" });
		kicker.createSpan({ text: "交互式文献学习" });
		kicker.createSpan({
			cls: "learning-session-depth-badge",
			text: this.readerPackage?.sourceKind === "mineru" ? "原文结构已载入" : "Markdown 导读",
		});
		titleBlock.createEl("h1", { text: this.readerPackage?.title || "文献学习" });
		titleBlock.createEl("p", {
			text: this.readerPackage?.articlePath || this.sessionState.articlePath,
			attr: { title: this.readerPackage?.articlePath || this.sessionState.articlePath },
		});

		const controls = header.createDiv({ cls: "learning-session-header-controls" });
		const completed = this.sessionState.completedModuleIds.length;
		controls.createDiv({
			cls: "learning-session-progress-pill",
			text: `主线 ${Math.min(completed + 1, this.modules.length)} / ${this.modules.length}`,
		});
		const openReader = iconButton(controls, "book-open-text", "打开原文阅读器");
		openReader.addEventListener("click", () => {
			void this.plugin.activateMineruReaderView(this.sessionState.articlePath);
		});
		const openQuery = iconButton(controls, "messages-square", "打开知识库对话");
		openQuery.addEventListener("click", () => {
			void this.plugin.activateQueryWikiView();
		});
	}

	private renderMap(workspace: HTMLElement): void {
		const mapPane = workspace.createDiv({ cls: "learning-session-map-pane" });
		const mapHeader = mapPane.createDiv({ cls: "learning-session-pane-header" });
		const heading = mapHeader.createDiv();
		heading.createEl("strong", { text: "学习路径" });
		heading.createEl("span", { text: "沿纵向主干推进，向右展开问题、回答与证据" });
		const legend = mapHeader.createDiv({ cls: "learning-session-legend" });
		for (const [label, className] of [
			["主线", "is-main"],
			["问题", "is-question"],
			["AI 回答", "is-answer"],
			["证据", "is-evidence"],
		] as const) {
			const item = legend.createSpan({ text: label });
			item.addClass(className);
		}

		const scroller = mapPane.createDiv({ cls: "learning-session-map-scroll" });
		const track = scroller.createDiv({ cls: "learning-session-map-track" });
		const spine = track.createDiv({ cls: "learning-session-spine" });
		for (const module of this.modules) {
			this.renderSpineStage(spine, module);
		}
		this.renderMindMap(track, this.moduleForSelectedNode());
		window.setTimeout(() => {
			const target = track.querySelector<HTMLElement>(".learning-session-tree-node.is-selected")
				|| track.querySelector<HTMLElement>(".learning-session-main-node.is-selected")
				|| track.querySelector<HTMLElement>(".learning-session-main-node.is-current");
			const stage = target?.closest<HTMLElement>(".learning-session-spine-stage")
				|| track.querySelector<HTMLElement>(
					`.learning-session-spine-stage[data-module-id="${this.moduleForSelectedNode().id}"]`,
				);
			if (!stage) return;
			const targetTop = Math.max(
				0,
				stage.offsetTop - (scroller.clientHeight - stage.clientHeight) / 2,
			);
			scroller.scrollTop = scroller.scrollHeight > scroller.clientHeight
				? targetTop
				: 0;
			if (target?.closest(".learning-session-mind-map")) {
				const targetRect = target.getBoundingClientRect();
				const scrollerRect = scroller.getBoundingClientRect();
				const targetLeft = Math.max(
					0,
					scroller.scrollLeft + targetRect.left - scrollerRect.left - scroller.clientWidth * 0.58,
				);
				scroller.scrollLeft = targetLeft;
			}
		}, 60);
	}

	private moduleForSelectedNode(): LearningModule {
		const branch = this.sessionState.branches.find((candidate) => (
			candidate.id === this.sessionState.selectedNodeId
		));
		const selectedModuleId = branch?.parentId || this.sessionState.selectedNodeId;
		return this.modules.find((module) => module.id === selectedModuleId)
			|| this.modules.find((module) => module.id === this.sessionState.activeModuleId)
			|| this.modules[0];
	}

	private renderSpineStage(spine: HTMLElement, module: LearningModule): void {
		const stage = spine.createDiv({ cls: "learning-session-spine-stage" });
		stage.dataset.moduleId = module.id;
		const status = moduleStatus(module, this.sessionState);
		const mainNode = stage.createEl("button", {
			cls: `learning-session-main-node is-${status}`,
			attr: {
				"aria-label": `${module.label}：${module.kicker}`,
				...(status === "current" ? { "aria-current": "step" } : {}),
			},
		});
		mainNode.type = "button";
		if (this.moduleForSelectedNode().id === module.id) mainNode.addClass("is-selected");
		const step = mainNode.createSpan({ cls: "learning-session-node-step" });
		if (status === "done") {
			setIcon(step, "check");
		} else {
			step.setText(String(module.index + 1).padStart(2, "0"));
		}
		const copy = mainNode.createSpan({ cls: "learning-session-node-copy" });
		copy.createSpan({ cls: "learning-session-node-label", text: module.label });
		copy.createSpan({ cls: "learning-session-node-kicker", text: module.kicker });
		mainNode.addEventListener("click", () => {
			this.sessionState.selectedNodeId = module.id;
			this.selectedEvidenceId = "";
			this.requestStateSave();
			this.render();
		});
	}

	private renderMindMap(track: HTMLElement, module: LearningModule): void {
		const map = track.createDiv({ cls: "learning-session-mind-map" });
		map.dataset.moduleId = module.id;
		const mapTop = Math.max(4, module.index * 94 - 300);
		const branchDrop = Math.max(0, module.index * 94 + 42 - mapTop - 38);
		map.style.setProperty("--learning-map-top", `${mapTop}px`);
		map.style.setProperty("--learning-branch-drop", `${branchDrop}px`);
		const roots = this.sessionState.branches.filter((branch) => (
			branch.parentId === module.id && !branch.parentBranchId
		));
		const selectedBranch = this.sessionState.branches.find((branch) => (
			branch.id === this.sessionState.selectedNodeId
		));
		const selectedRoot = selectedBranch ? this.rootBranch(selectedBranch) : null;
		const orderedRoots = selectedRoot
			? [selectedRoot, ...roots.filter((branch) => branch.id !== selectedRoot.id)]
			: roots;
		if (!orderedRoots.length) {
			this.renderMindMapEmpty(map, module);
			return;
		}
		for (const branch of orderedRoots.slice(0, 3)) {
			this.renderBranchTree(map, module, branch);
		}
		if (orderedRoots.length > 3) {
			map.createDiv({
				cls: "learning-session-tree-overflow",
				text: `另有 ${orderedRoots.length - 3} 条问题分支，可在右侧选择查看。`,
			});
		}
	}

	private renderMindMapEmpty(map: HTMLElement, module: LearningModule): void {
		const empty = map.createDiv({ cls: "learning-session-tree-empty" });
		const icon = empty.createSpan();
		setIcon(icon, "git-branch");
		const copy = empty.createDiv();
		copy.createEl("strong", { text: `展开“${module.label}”` });
		copy.createEl("span", { text: "从右侧提出问题，AI 回答和可核对证据会在这里长成分支。" });
		const evidence = module.evidence.slice(0, 3);
		if (!evidence.length) return;
		const evidenceRail = map.createDiv({ cls: "learning-session-module-evidence-rail" });
		for (const item of evidence) this.renderTreeEvidence(evidenceRail, item, module.id);
	}

	private renderBranchTree(map: HTMLElement, module: LearningModule, branch: LearningBranch): void {
		const row = map.createDiv({ cls: "learning-session-tree-row" });
		const question = row.createEl("button", {
			cls: "learning-session-tree-node is-question",
			attr: { "aria-label": `你的问题：${branch.question}` },
		});
		question.type = "button";
		if (this.sessionState.selectedNodeId === branch.id) question.addClass("is-selected");
		const questionTitle = question.createSpan({ cls: "learning-session-tree-node-title" });
		setIcon(questionTitle.createSpan(), "message-circle-question");
		questionTitle.createSpan({ text: "你的问题" });
		question.createSpan({ cls: "learning-session-tree-node-copy", text: branch.question });
		question.addEventListener("click", () => this.selectBranch(branch));

		const answer = row.createEl("button", {
			cls: `learning-session-tree-node is-answer is-${branch.status}`,
			attr: { "aria-label": `AI 回答：${branch.answer || "尚未生成"}` },
		});
		answer.type = "button";
		if (this.sessionState.selectedNodeId === branch.id) answer.addClass("is-selected");
		const answerTitle = answer.createSpan({ cls: "learning-session-tree-node-title" });
		setIcon(answerTitle.createSpan(), branch.status === "answered" ? "sparkles" : "loader-circle");
		answerTitle.createSpan({ text: "AI 回答" });
		answer.createSpan({
			cls: "learning-session-tree-node-copy",
			text: branch.status === "answered"
				? compactNodeText(branch.answer)
				: branch.status === "sent"
					? "已带入知识库对话，发送后答案会自动回到这里。"
					: branch.status === "failed"
						? "上次回答失败，可在右侧重新尝试。"
						: "在右侧让 AI 基于原文和知识库回答。",
		});
		answer.addEventListener("click", () => this.selectBranch(branch));

		const followUps = this.sessionState.branches.filter((candidate) => (
			candidate.parentBranchId === branch.id
		));
		const followUpStack = row.createDiv({ cls: "learning-session-tree-followups" });
		for (const followUp of followUps.slice(-2)) {
			const node = followUpStack.createEl("button", {
				cls: "learning-session-tree-node is-follow-up",
				attr: { "aria-label": `继续追问：${followUp.question}` },
			});
			node.type = "button";
			if (this.sessionState.selectedNodeId === followUp.id) node.addClass("is-selected");
			const title = node.createSpan({ cls: "learning-session-tree-node-title" });
			setIcon(title.createSpan(), "corner-down-right");
			title.createSpan({ text: "继续追问" });
			node.createSpan({ cls: "learning-session-tree-node-copy", text: followUp.question });
			node.addEventListener("click", () => this.selectBranch(followUp));
		}
		if (!followUps.length) {
			followUpStack.createSpan({ cls: "learning-session-tree-hint", text: "回答后可继续追问" });
		}

		const evidenceStack = row.createDiv({ cls: "learning-session-tree-evidence" });
		const evidence = branch.answerEvidence.length
			? branch.answerEvidence
			: module.evidence.slice(0, 3);
		for (const item of evidence.slice(0, 4)) this.renderTreeEvidence(evidenceStack, item, branch.id);
	}

	private renderTreeEvidence(
		parent: HTMLElement,
		evidence: LearningEvidenceRef,
		selectedNodeId: string,
	): void {
		const evidenceLabel = evidence.kind === "source" ? "证据来源" : "原文证据";
		const button = parent.createEl("button", {
			cls: "learning-session-tree-node is-evidence",
			attr: { "aria-label": `${evidenceLabel}：${evidence.label}` },
		});
		button.type = "button";
		if (this.selectedEvidenceId === evidence.id) button.addClass("is-selected");
		const title = button.createSpan({ cls: "learning-session-tree-node-title" });
		setIcon(title.createSpan(), evidenceIcon(evidence.kind));
		title.createSpan({ text: evidenceLabel });
		button.createSpan({ cls: "learning-session-tree-node-copy", text: evidence.label });
		button.addEventListener("click", () => {
			this.sessionState.selectedNodeId = selectedNodeId;
			this.selectedEvidenceId = evidence.id;
			this.requestStateSave();
			this.render();
		});
	}

	private selectBranch(branch: LearningBranch): void {
		this.sessionState.selectedNodeId = branch.id;
		this.selectedEvidenceId = "";
		this.requestStateSave();
		this.render();
	}

	private rootBranch(branch: LearningBranch): LearningBranch {
		let current = branch;
		const visited = new Set<string>();
		while (current.parentBranchId && !visited.has(current.id)) {
			visited.add(current.id);
			const parent = this.sessionState.branches.find((candidate) => (
				candidate.id === current.parentBranchId
			));
			if (!parent) break;
			current = parent;
		}
		return current;
	}

	private renderInspector(workspace: HTMLElement): void {
		const inspector = workspace.createEl("aside", { cls: "learning-session-inspector" });
		const selectedBranch = this.sessionState.branches.find((branch) => (
			branch.id === this.sessionState.selectedNodeId
		));
		if (selectedBranch) {
			this.renderBranchInspector(inspector, selectedBranch);
		} else {
			const selectedModule = this.modules.find((module) => (
				module.id === this.sessionState.selectedNodeId
			)) || this.modules.find((module) => module.id === this.sessionState.activeModuleId) || this.modules[0];
			this.renderModuleInspector(inspector, selectedModule);
		}
	}

	private renderModuleInspector(inspector: HTMLElement, module: LearningModule): void {
		const header = inspector.createDiv({ cls: "learning-session-inspector-header" });
		header.createDiv({ cls: "learning-session-inspector-kicker", text: module.kicker });
		header.createEl("h2", { text: module.label });
		header.createEl("p", { text: module.guidance });

		const status = moduleStatus(module, this.sessionState);
		const statusRow = inspector.createDiv({ cls: "learning-session-inspector-status" });
		statusRow.createSpan({
			cls: `is-${status}`,
			text: status === "done" ? "已完成" : status === "current" ? "当前模块" : "待学习",
		});
		statusRow.createSpan({ text: `${module.evidence.length} 条证据线索` });

		if (module.sectionHeadings.length) {
			const section = inspector.createDiv({ cls: "learning-session-inspector-section" });
			section.createEl("h3", { text: "原文章节" });
			const chips = section.createDiv({ cls: "learning-session-section-chips" });
			for (const heading of module.sectionHeadings) chips.createSpan({ text: heading });
		}
		if (module.excerpt) {
			const section = inspector.createDiv({ cls: "learning-session-inspector-section" });
			section.createEl("h3", { text: "导读线索" });
			section.createEl("p", { cls: "learning-session-excerpt", text: module.excerpt });
		}

		const evidenceSection = inspector.createDiv({ cls: "learning-session-inspector-section" });
		evidenceSection.createEl("h3", { text: "证据入口" });
		if (module.id === "results") this.renderFigurePreview(evidenceSection);
		if (!module.evidence.length) {
			evidenceSection.createEl("p", {
				cls: "learning-session-empty-copy",
				text: "当前章节映射没有找到明确证据。可在知识库对话中让 AI 检索全文并补充。",
			});
		} else {
			const list = evidenceSection.createDiv({ cls: "learning-session-evidence-list" });
			for (const evidence of module.evidence) {
				const item = list.createEl("button", { cls: "learning-session-evidence-detail" });
				item.type = "button";
				if (this.selectedEvidenceId === evidence.id) item.addClass("is-selected");
				const icon = item.createSpan();
				setIcon(icon, evidenceIcon(evidence.kind));
				const copy = item.createSpan();
				copy.createSpan({ cls: "learning-session-evidence-label", text: evidence.label });
				copy.createSpan({ cls: "learning-session-evidence-copy", text: evidence.detail });
				item.addEventListener("click", () => {
					this.selectedEvidenceId = evidence.id;
					this.render();
				});
			}
		}
		this.renderQuestionComposer(inspector, module);
		this.renderModuleActions(inspector, module);
	}

	private renderFigurePreview(parent: HTMLElement): void {
		const visual = this.readerPackage?.visuals[0];
		if (!visual) return;
		const assetPath = visual.display.mode === "asset"
			? visual.display.assetPath
			: visual.memberAssetPaths[0] || "";
		const resourceUrl = this.resourceUrl(assetPath);
		if (!resourceUrl) return;
		const figure = parent.createEl("figure", { cls: "learning-session-figure-preview" });
		figure.createEl("img", {
			attr: {
				src: resourceUrl,
				alt: visual.label,
				loading: "eager",
			},
		});
		const caption = figure.createEl("figcaption");
		caption.createEl("strong", { text: visual.label });
		caption.createSpan({
			text: visual.caption
				? ` · ${visual.caption.slice(0, 180)}${visual.caption.length > 180 ? "…" : ""}`
				: ` · 第 ${visual.pageIdx + 1} 页`,
		});
	}

	private renderBranchInspector(inspector: HTMLElement, branch: LearningBranch): void {
		const module = this.modules.find((candidate) => candidate.id === branch.parentId) || this.modules[0];
		const header = inspector.createDiv({ cls: "learning-session-inspector-header is-question" });
		header.createDiv({
			cls: "learning-session-inspector-kicker",
			text: `${branch.parentBranchId ? "继续追问" : "问题分支"} · ${module.label}`,
		});
		header.createEl("h2", { text: "你的问题" });
		header.createEl("p", { cls: "learning-session-branch-question", text: branch.question });
		const meta = inspector.createDiv({ cls: "learning-session-branch-meta" });
		meta.createSpan({ text: branch.parentBranchId ? "追问节点" : "模块分支" });
		meta.createSpan({ text: this.branchStatusLabel(branch) });

		const context = inspector.createDiv({ cls: "learning-session-inspector-section" });
		context.createEl("h3", { text: "回答上下文" });
		context.createEl("p", { text: module.guidance });
		if (module.sectionHeadings.length) {
			context.createEl("p", {
				cls: "learning-session-context-note",
				text: `优先核对：${module.sectionHeadings.join("、")}`,
			});
		}
		if (module.id === "results") {
			const sourceSection = inspector.createDiv({ cls: "learning-session-inspector-section" });
			sourceSection.createEl("h3", { text: "来源定位" });
			this.renderFigurePreview(sourceSection);
		}
		if (branch.answer) {
			const answerSection = inspector.createDiv({ cls: "learning-session-inspector-section is-answer" });
			answerSection.createEl("h3", { text: "AI 回答" });
			const markdown = answerSection.createDiv({
				cls: "learning-session-answer-markdown markdown-rendered",
			});
			void MarkdownRenderer.render(
				this.app,
				branch.answer,
				markdown,
				this.sessionState.articlePath,
				this,
			);
		}
		if (branch.answerEvidence.length) {
			const evidenceSection = inspector.createDiv({ cls: "learning-session-inspector-section" });
			evidenceSection.createEl("h3", { text: "回答证据" });
			const list = evidenceSection.createDiv({ cls: "learning-session-evidence-list" });
			for (const evidence of branch.answerEvidence) {
				const item = list.createEl("button", { cls: "learning-session-evidence-detail" });
				item.type = "button";
				if (this.selectedEvidenceId === evidence.id) item.addClass("is-selected");
				const icon = item.createSpan();
				setIcon(icon, evidenceIcon(evidence.kind));
				const copy = item.createSpan();
				copy.createSpan({ cls: "learning-session-evidence-label", text: evidence.label });
				copy.createSpan({ cls: "learning-session-evidence-copy", text: evidence.detail });
				item.addEventListener("click", () => {
					this.selectedEvidenceId = evidence.id;
					this.render();
				});
			}
		}
		if (branch.status === "answered") this.renderFollowUpComposer(inspector, branch);

		const actions = inspector.createDiv({ cls: "learning-session-inspector-actions" });
		const ask = actions.createEl("button", {
			cls: "mod-cta learning-session-primary-button",
			text: branch.status === "answered"
				? "重新生成回答"
				: branch.status === "sent"
					? "重新发送并回流"
					: "让 AI 回答",
		});
		ask.type = "button";
		const askIcon = ask.createSpan({ cls: "learning-session-button-icon" });
		setIcon(askIcon, "messages-square");
		ask.prepend(askIcon);
		ask.addEventListener("click", () => this.openBranchInQuery(branch, module));
		const back = actions.createEl("button", { text: "返回主线模块" });
		back.type = "button";
		back.addEventListener("click", () => {
			this.sessionState.selectedNodeId = module.id;
			this.requestStateSave();
			this.render();
		});
	}

	private branchStatusLabel(branch: LearningBranch): string {
		if (branch.status === "answered") return "已生成回答";
		if (branch.status === "sent") return "等待知识库回答";
		if (branch.status === "failed") return "回答失败";
		return "等待回答";
	}

	private renderFollowUpComposer(inspector: HTMLElement, branch: LearningBranch): void {
		const composer = inspector.createDiv({ cls: "learning-session-question-composer is-follow-up" });
		const label = composer.createEl("label", { text: "继续追问" });
		const input = composer.createEl("textarea", {
			attr: {
				rows: "2",
				maxlength: "500",
				placeholder: "基于这段回答继续追问…",
				"aria-label": "基于当前回答继续追问",
			},
		});
		label.htmlFor = input.id = `learning-follow-up-${branch.id}`;
		const footer = composer.createDiv({ cls: "learning-session-composer-footer" });
		footer.createSpan({ text: "追问会成为当前回答的下一层分支。" });
		const add = footer.createEl("button", { text: "添加追问" });
		add.type = "button";
		add.addEventListener("click", () => {
			const followUp = createLearningFollowUpBranch(
				branch,
				input.value,
				this.sessionState.branches,
				`question-${Date.now()}-${this.sessionState.branches.length + 1}`,
			);
			if (!followUp) {
				new Notice("请先输入一个具体追问");
				input.focus();
				return;
			}
			this.sessionState.branches.push(followUp);
			this.sessionState.selectedNodeId = followUp.id;
			this.requestStateSave();
			this.render();
		});
		input.addEventListener("keydown", (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				add.click();
			}
		});
	}

	private renderQuestionComposer(inspector: HTMLElement, module: LearningModule): void {
		const composer = inspector.createDiv({ cls: "learning-session-question-composer" });
		const label = composer.createEl("label", { text: "在这里分叉" });
		const input = composer.createEl("textarea", {
			attr: {
				rows: "3",
				maxlength: "500",
				placeholder: `关于“${module.label}”有什么没懂？`,
				"aria-label": `向“${module.label}”添加问题分支`,
			},
		});
		label.htmlFor = input.id = `learning-question-${module.id}`;
		const footer = composer.createDiv({ cls: "learning-session-composer-footer" });
		footer.createSpan({ text: "问题会挂在当前模块，不会打断主线进度。" });
		const add = footer.createEl("button", { text: "添加问题" });
		add.type = "button";
		add.addEventListener("click", () => {
			const branch = createLearningBranch(
				module.id,
				input.value,
				this.sessionState.branches,
				`question-${Date.now()}-${this.sessionState.branches.length + 1}`,
			);
			if (!branch) {
				new Notice("请先输入一个具体问题");
				input.focus();
				return;
			}
			this.sessionState.branches.push(branch);
			this.sessionState.selectedNodeId = branch.id;
			this.requestStateSave();
			this.render();
		});
		input.addEventListener("keydown", (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				add.click();
			}
		});
	}

	private renderModuleActions(inspector: HTMLElement, module: LearningModule): void {
		const actions = inspector.createDiv({ cls: "learning-session-inspector-actions" });
		const explain = actions.createEl("button", { text: "让 AI 讲解此模块" });
		explain.type = "button";
		const explainIcon = explain.createSpan({ cls: "learning-session-button-icon" });
		setIcon(explainIcon, "sparkles");
		explain.prepend(explainIcon);
		explain.addEventListener("click", () => {
			const prompt = buildLearningQuestionPrompt(
				this.sessionState.articlePath,
				module,
				`请按“概念 → 原文证据 → 推理 → 局限”的顺序讲解“${module.label}”模块，并提出一个检查我是否理解的问题。`,
			);
			void this.plugin.activateQueryWikiView(prompt);
		});

		const continueButton = actions.createEl("button", {
			cls: "mod-cta learning-session-primary-button",
			text: module.id === LEARNING_MODULE_DEFINITIONS[LEARNING_MODULE_DEFINITIONS.length - 1].id
				? "完成主线"
				: "继续主线",
		});
		continueButton.type = "button";
		const continueIcon = continueButton.createSpan({ cls: "learning-session-button-icon" });
		setIcon(
			continueIcon,
			module.id === LEARNING_MODULE_DEFINITIONS[LEARNING_MODULE_DEFINITIONS.length - 1].id
				? "check"
				: "arrow-right",
		);
		continueButton.append(continueIcon);
		continueButton.addEventListener("click", () => this.advanceMainline(module));
	}

	private advanceMainline(module: LearningModule): void {
		if (!this.sessionState.completedModuleIds.includes(module.id)) {
			this.sessionState.completedModuleIds.push(module.id);
		}
		const nextId = nextLearningModuleId(module.id);
		this.sessionState.activeModuleId = nextId;
		this.sessionState.selectedNodeId = nextId;
		this.selectedEvidenceId = "";
		this.requestStateSave();
		this.render();
	}

	private openBranchInQuery(branch: LearningBranch, module: LearningModule): void {
		branch.status = "sent";
		this.requestStateSave();
		this.render();
		const parentBranch = branch.parentBranchId
			? this.sessionState.branches.find((candidate) => candidate.id === branch.parentBranchId)
			: null;
		const prompt = buildLearningQuestionPrompt(
			this.sessionState.articlePath,
			module,
			branch.question,
			parentBranch
				? { question: parentBranch.question, answer: parentBranch.answer }
				: undefined,
		);
		const completionHandler: QueryWikiCompletionHandler = (payload) => {
			const target = this.sessionState.branches.find((candidate) => candidate.id === branch.id);
			if (!target) return;
			if (payload.status === "done") {
				const evidence: LearningEvidenceRef[] = [
					...payload.vaultSources.map((source, index) => ({
						id: `${target.id}-vault-${index + 1}`,
						label: source.title || source.path,
						detail: source.path,
						kind: "source" as const,
					})),
					...payload.webSources.map((source, index) => ({
						id: `${target.id}-web-${index + 1}`,
						label: source.title || source.domain,
						detail: source.url,
						kind: "source" as const,
					})),
				];
				applyLearningBranchAnswer(target, payload.answer || "本轮查询未返回文本。", evidence);
			} else {
				target.status = "failed";
				target.answer = payload.error;
				target.answerEvidence = [];
			}
			this.sessionState.selectedNodeId = target.id;
			this.requestStateSave();
			if (this.opened) this.render();
		};
		void this.plugin.activateQueryWikiView(prompt, completionHandler);
	}

	private requestStateSave(): void {
		void this.app.workspace.requestSaveLayout();
	}

	private resourceUrl(assetPath: string): string {
		const readerPackage = this.readerPackage;
		if (!readerPackage || !assetPath) return "";
		if (/^https?:\/\//i.test(assetPath)) return assetPath;
		if (readerPackage.sourceKind === "mineru") {
			const normalized = assetPath.replace(/\\/g, "/").replace(/^\.\//, "");
			const blob = readerPackage.verifiedAssetBlobs.get(normalized);
			if (!blob) return "";
			const existing = this.verifiedResourceUrls.get(normalized);
			if (existing) return existing;
			const url = URL.createObjectURL(blob);
			this.verifiedResourceUrls.set(normalized, url);
			return url;
		}
		const file = this.app.metadataCache.getFirstLinkpathDest(assetPath, readerPackage.articlePath);
		return file instanceof TFile ? this.app.vault.getResourcePath(file) : "";
	}

	private revokeVerifiedResourceUrls(): void {
		for (const url of this.verifiedResourceUrls.values()) URL.revokeObjectURL(url);
		this.verifiedResourceUrls.clear();
	}
}
