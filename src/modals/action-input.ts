import { App, Modal } from "obsidian";

import type {
	DashboardAction,
	DashboardActionOptions,
} from "../actions";
import {
	getCliBackendLabel,
	MODEL_OPTIONS,
	REASONING_OPTIONS,
	type CliBackendId,
} from "../config";
import {
	getClaudeDefaultModelLabel,
	type ClaudeConfigSource,
	describeCliExecutable,
	getCodexDefaultModelLabel,
	type CodexConfigSource,
	getOpenCodeDefaultModelLabel,
	type OpenCodeConfigSource,
} from "../runtime/settings";
import type {
	CliModelDiscoveryResult,
	CodexExecutionConfig,
	ExecutionOverrides,
	ServiceTier,
} from "../types/contracts";

export type { ExecutionOverrides } from "../types/contracts";

export type ActionRunnerKind = "light-agent" | "cli-agent";

export interface ActionInputResult {
	input: string;
	overrides: ExecutionOverrides | Record<string, never>;
	options: DashboardActionOptions;
	runner: ActionRunnerKind;
}

interface ActionInputHost {
	settings: {
		codexConfigSource: CodexConfigSource;
		codexModel: string;
		claudeConfigSource: ClaudeConfigSource;
		claudeModel: string;
		openCodeConfigSource: OpenCodeConfigSource;
		openCodeModel: string;
		mineruExecutable: string;
		mineruDefaultModel: "vlm" | "pipeline" | "auto" | "html";
		mineruDefaultLanguage: string;
		mineruDefaultOcr: boolean;
		mineruDefaultFormula: boolean;
		mineruDefaultTable: boolean;
		mineruDefaultTimeoutSeconds: number;
		mineruDefaultIncludeSourcePdf: boolean;
		mineruDefaultArticleWikiSource: "auto" | "pdf" | "article";
		mineruConfirmRemoteUpload: boolean;
		actionExecutionDefaults: Record<string, {
			backend: CliBackendId;
			model: string;
			reasoningEffort: string;
			serviceTier: "default" | "fast";
			runner?: "auto" | "light" | "cli";
		}>;
	};
	lightPaperIngestAvailable(): { ready: boolean; reason: string };
	lightAgentMineruReady(): boolean;
	getActiveDirectProviderSummary(): { name: string; model: string } | null;
	resolveActionExecutionConfig(
		action: DashboardAction,
		overrides?: Partial<ExecutionOverrides>,
	): CodexExecutionConfig;
	resolveCliActionExecutionConfig(
		action: DashboardAction,
		backendId: CliBackendId,
		overrides?: Partial<ExecutionOverrides>,
	): CodexExecutionConfig;
	isCliBackendAvailable(backendId: CliBackendId): boolean;
	getCliModelDiscovery(backendId: CliBackendId): CliModelDiscoveryResult | null;
	discoverCliModels(
		backendId: CliBackendId,
		force?: boolean,
	): Promise<CliModelDiscoveryResult>;
	getModelLabel(model: string): string;
	getReasoningLabel(reasoningEffort: string): string;
	supportsFast(model: string): boolean;
}

interface ActionInputOptions {
	initialInput?: string;
}

export class ActionInputModal extends Modal {
	private readonly plugin: ActionInputHost;
	private readonly action: DashboardAction;
	private readonly onSubmit: (result: ActionInputResult) => void;
	private readonly initialInput: string;
	private runner: ActionRunnerKind = "cli-agent";
	private paperIngestMarkdownOption: HTMLInputElement | null = null;
	private paperIngestSync: (() => void) | null = null;

	constructor(
		app: App,
		plugin: ActionInputHost,
		action: DashboardAction,
		onSubmit: (result: ActionInputResult) => void,
		options: ActionInputOptions = {},
	) {
		super(app);
		this.plugin = plugin;
		this.action = action;
		this.onSubmit = onSubmit;
		this.initialInput = typeof options.initialInput === "string" ? options.initialInput : "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("agent-dashboard-modal");
		this.setTitle(this.action.label);
		contentEl.createEl("p", {
			cls: "agent-dashboard-modal-description",
			text: this.action.description,
		});
		if (this.action.writes) {
			contentEl.createEl("p", {
				cls: "agent-dashboard-modal-warning",
				text: "运行后，所选执行后端可在该 skill 拥有的范围内更新项目文件。提交此表单即确认本次写入授权。",
			});
		}
		let syncSubmitState = () => undefined;
		// Resolve the default runner before rendering options so the light
		// runner can deprioritize the MinerU output when its toolchain is
		// missing (without the toolkit, only the wiki note is possible).
		const runnerAvailable = this.action.id === "paper-ingest"
			? this.plugin.lightPaperIngestAvailable()
			: { ready: false, reason: "" };
		if (this.action.id === "paper-ingest") {
			// 任务默认策略中的「默认运行方式」决定弹窗预选；auto = 有可用
			// Direct API 时优先轻量 Agent。
			const preferredRunner = this.plugin.settings.actionExecutionDefaults["paper-ingest"]?.runner;
			if (preferredRunner === "light" && runnerAvailable.ready) {
				this.runner = "light-agent";
			} else if (preferredRunner === "cli") {
				this.runner = "cli-agent";
			} else {
				this.runner = runnerAvailable.ready ? "light-agent" : "cli-agent";
			}
		}
		const actionOptions = this.renderActionOptions(
			contentEl,
			() => syncSubmitState(),
		);
		let input: HTMLTextAreaElement | null = null;
		if (this.action.requiresInput) {
			input = contentEl.createEl("textarea", {
				cls: "agent-dashboard-modal-input",
				attr: {
					placeholder: this.action.placeholder,
					rows: "8",
					"aria-label": `${this.action.label}任务说明`,
				},
			});
			input.value = this.initialInput;
		}

		const runnerChoiceHost = contentEl.createDiv();
		const controlsHost = contentEl.createDiv();
		let activeControls: { getOverrides: () => ExecutionOverrides } | null = null;
		const renderControls = (): void => {
			controlsHost.empty();
			activeControls = null;
			if (!this.action.ai) return;
			if (this.action.id === "paper-ingest" && this.runner === "light-agent") {
				this.renderLightAgentControls(controlsHost);
				return;
			}
			activeControls = this.renderExecutionControls(controlsHost);
		};
		if (this.action.id === "paper-ingest") {
			this.renderRunnerChoice(runnerChoiceHost, runnerAvailable, () => {
				this.onPaperIngestRunnerSwitched();
				renderControls();
			});
		}
		renderControls();
		const footer = contentEl.createDiv({ cls: "agent-dashboard-modal-actions" });
		const cancel = footer.createEl("button", { text: "取消" });
		cancel.type = "button";
		const submit = footer.createEl("button", {
			cls: "mod-cta",
			text: "开始执行",
		});
		submit.type = "button";
		submit.disabled = this.action.requiresInput && !this.initialInput.trim();

		syncSubmitState = () => {
			const missingInput = this.action.requiresInput
				&& (!input || input.value.trim().length === 0);
			submit.disabled = missingInput || !actionOptions.isValid();
		};
		const submitAction = () => {
			const value = input ? input.value.trim() : "";
			if ((this.action.requiresInput && !value) || !actionOptions.isValid()) return;
			this.close();
			this.onSubmit({
				input: value,
				overrides: activeControls ? activeControls.getOverrides() : {},
				options: actionOptions.getOptions(),
				runner: this.runner,
			});
		};
		if (input) {
			input.addEventListener("input", syncSubmitState);
			input.addEventListener("keydown", (event) => {
				if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
					event.preventDefault();
					submitAction();
				}
			});
		}
		cancel.addEventListener("click", () => this.close());
		submit.addEventListener("click", submitAction);
		syncSubmitState();
		window.setTimeout(() => (input || submit).focus(), 0);
	}

	/**
	 * When the user switches runners, keep the MinerU output honest: the
	 * light agent without a complete toolchain cannot produce original
	 * Markdown, so the checkbox is cleared instead of failing after submit.
	 */
	private onPaperIngestRunnerSwitched(): void {
		if (this.action.id !== "paper-ingest") return;
		if (this.runner === "light-agent" && !this.paperIngestMarkdownOption) return;
		if (this.runner === "light-agent"
			&& this.paperIngestMarkdownOption
			&& !this.plugin.lightAgentMineruReady()) {
			this.paperIngestMarkdownOption.checked = false;
			this.paperIngestSync?.();
		}
	}

	/**
	 * Chooses between the in-plugin light agent (Direct API) and the Codex
	 * CLI toolkit pipeline for paper-ingest. Both produce the same outputs;
	 * they differ in requirements and write scope.
	 */	renderRunnerChoice(
		parent: HTMLElement,
		availability: { ready: boolean; reason: string },
		onChange: () => void,
	): void {
		const section = parent.createEl("section", {
			cls: "agent-dashboard-action-options",
			attr: { "aria-label": "运行方式" },
		});
		section.createEl("h3", { text: "运行方式" });
		const providerSummary = this.plugin.getActiveDirectProviderSummary();
		const lightLabel = availability.ready && providerSummary
			? `轻量 Agent · ${providerSummary.name}（${providerSummary.model}）`
			: "轻量 Agent · Direct API";
		const light = this.createRadioOption(section, "paper-ingest-runner", "light", lightLabel, this.runner === "light-agent");
		light.disabled = !availability.ready;
		const lightNote = section.createEl("p", {
			cls: "agent-dashboard-action-options-description",
			text: availability.ready
				? "在插件内运行有界工具循环：只读检索知识库、白名单元数据接口、MinerU 提取和限定目录写入；步数与时间预算受限，可随时停止。"
				: `轻量 Agent 不可用：${availability.reason}`,
		});
		lightNote.style.marginLeft = "24px";
		const cli = this.createRadioOption(section, "paper-ingest-runner", "cli", "Codex CLI · 完整入库", this.runner === "cli-agent");
		const cliNote = section.createEl("p", {
			cls: "agent-dashboard-action-options-description",
			text: "通过工具链里的编排管线运行：额外维护 papers.csv、references.bib、文献索引和 wiki/log。需要配置 Codex CLI 与工具链目录。",
		});
		cliNote.style.marginLeft = "24px";
		const sync = (): void => {
			this.runner = light.checked ? "light-agent" : "cli-agent";
		};
		light.addEventListener("change", () => {
			sync();
			onChange();
		});
		cli.addEventListener("change", () => {
			sync();
			onChange();
		});
		if (this.runner === "light-agent") light.checked = true;
		else cli.checked = true;
	}

	renderLightAgentControls(parent: HTMLElement): void {
		const section = parent.createEl("section", {
			cls: "agent-dashboard-run-config",
			attr: { "aria-label": "轻量 Agent 运行配置" },
		});
		const heading = section.createDiv({ cls: "agent-dashboard-run-config-heading" });
		heading.createSpan({ text: "运行配置" });
		const providerSummary = this.plugin.getActiveDirectProviderSummary();
		heading.createSpan({
			cls: "agent-dashboard-run-config-summary",
			text: providerSummary
				? `轻量 Agent · ${providerSummary.name} · ${providerSummary.model}`
				: "轻量 Agent · Direct API",
		});
		section.createDiv({
			cls: "agent-dashboard-run-config-note",
			text: "流程由插件分阶段强制：先身份核验与去重（只读 + 白名单元数据接口），再由插件用你确认的 PDF 运行 MinerU，最后模型仅返回笔记字段、由插件生成文件（仅 wiki/sources/，不覆盖已有笔记）。未配置 MinerU 时不会读取 PDF 正文。不更新 papers.csv 与 references.bib（完整登记请用 Codex CLI 方式）。",
		});
	}

	renderActionOptions(
		parent: HTMLElement,
		onChange: () => void,
	): {
		getOptions: () => DashboardActionOptions;
		isValid: () => boolean;
	} {
		if (this.action.id === "paper-ingest") {
			const section = parent.createEl("section", {
				cls: "agent-dashboard-action-options",
				attr: { "aria-label": "文献入库输出" },
			});
			section.createEl("h3", { text: "本次输出" });
			section.createEl("p", {
				cls: "agent-dashboard-action-options-description",
				text: "身份核验、去重和元数据准备始终执行；以下两个输出可以独立选择。",
			});
			const mineruAvailable = describeCliExecutable(
				"mineru",
				this.plugin.settings.mineruExecutable,
			).found;
			const lightMarkdownReady = this.runner === "light-agent"
				? this.plugin.lightAgentMineruReady()
				: true;
			const markdownOption = this.createCheckboxOption(
				section,
				"生成原文 Markdown",
				"使用 MinerU precision extract 生成 article.md、结构化 JSON、图片和可验证的提取记录。",
				lightMarkdownReady,
			);
			this.paperIngestMarkdownOption = markdownOption;
			const mineruWarning = !mineruAvailable || !lightMarkdownReady
				? section.createEl("p", {
					cls: "agent-dashboard-action-options-warning",
					text: !mineruAvailable
						? "未检测到 MinerU CLI。生成原文 Markdown 只需它：npm 全局安装 mineru-open-api 后，在设置 → 工具链与运行环境中配置（无需 Python 或工具包目录）。"
						: "轻量 Agent 生成原文 Markdown 需要：已配置 MinerU CLI（npm 全局安装 mineru-open-api，无需 Python 或工具包目录）；当前未配置，本次仅可创建文章 Wiki（内容来自元数据与用户说明，不读取 PDF 正文）。",
				})
				: null;

			const mineruPanel = section.createDiv({
				cls: "agent-dashboard-mineru-options",
				attr: { "aria-label": "MinerU 提取设置" },
			});
			const panelHeading = mineruPanel.createDiv({
				cls: "agent-dashboard-mineru-heading",
			});
			panelHeading.createEl("strong", { text: "MinerU 高精度提取" });
			panelHeading.createSpan({ text: "固定输出 Markdown + JSON；不使用会丢失图表的 flash-extract。" });

			const mineruGrid = mineruPanel.createDiv({
				cls: "agent-dashboard-mineru-grid",
			});
			const createSelectField = (
				parentEl: HTMLElement,
				title: string,
				description: string,
				options: Array<{ value: string; label: string }>,
				value: string,
			) => {
				const field = parentEl.createDiv({
					cls: "agent-dashboard-mineru-field",
				});
				const copy = field.createDiv();
				copy.createEl("strong", { text: title });
				copy.createSpan({ text: description });
				const select = field.createEl("select", {
					attr: { "aria-label": title },
				});
				options.forEach((option) => select.createEl("option", {
					text: option.label,
					attr: { value: option.value },
				}));
				select.value = value;
				return { field, select };
			};
			const createNumberField = (
				parentEl: HTMLElement,
				title: string,
				description: string,
				value: number,
				min: number,
				max: number,
				step: number,
			) => {
				const field = parentEl.createDiv({
					cls: "agent-dashboard-mineru-field",
				});
				const copy = field.createDiv();
				copy.createEl("strong", { text: title });
				copy.createSpan({ text: description });
				const input = field.createEl("input", {
					attr: {
						type: "number",
						min: String(min),
						max: String(max),
						step: String(step),
						value: String(value),
						"aria-label": title,
					},
				});
				return { field, input };
			};

			const model = createSelectField(
				mineruGrid,
				"解析模型",
				"VLM 对复杂版面和上标引用更准确；Pipeline 更保守。",
				[
					{ value: "vlm", label: "VLM · 推荐" },
					{ value: "pipeline", label: "Pipeline · 保守提取" },
					{ value: "auto", label: "Auto · 服务端选择" },
				],
				this.plugin.settings.mineruDefaultModel === "pipeline"
					|| this.plugin.settings.mineruDefaultModel === "auto"
					? this.plugin.settings.mineruDefaultModel
					: "vlm",
			);
			const language = createSelectField(
				mineruGrid,
				"文档语言",
				"影响文本识别；英文论文建议选择 English。",
				[
					{ value: "en", label: "English" },
					{ value: "ch", label: "中文 + English" },
					{ value: "ch_server", label: "中文 / 繁体 / 日文" },
					{ value: "japan", label: "日本語" },
					{ value: "korean", label: "한국어" },
					{ value: "latin", label: "Latin 语系" },
					{ value: "arabic", label: "Arabic 语系" },
					{ value: "cyrillic", label: "Cyrillic 语系" },
					{ value: "devanagari", label: "Devanagari 语系" },
				],
				this.plugin.settings.mineruDefaultLanguage || "en",
			);
			const includeSourcePdf = this.createCheckboxOption(
				mineruPanel,
				"在原文包中附带 PDF",
				"将原 PDF 复制到 _extraction/source.pdf，用于双栏阅读、版面框定位和完整图重建。",
				this.plugin.settings.mineruDefaultIncludeSourcePdf,
			);
			const ocr = this.createCheckboxOption(
				mineruPanel,
				"扫描件 OCR",
				"仅扫描版或无文本层 PDF 开启；普通数字 PDF 保持关闭。",
				this.plugin.settings.mineruDefaultOcr,
			);
			const formula = this.createCheckboxOption(
				mineruPanel,
				"识别公式",
				"保留数学公式识别。",
				this.plugin.settings.mineruDefaultFormula,
			);
			const table = this.createCheckboxOption(
				mineruPanel,
				"识别表格",
				"生成可搜索的 HTML 表格并保留表格裁图证据。",
				this.plugin.settings.mineruDefaultTable,
			);

			const advanced = mineruPanel.createEl("details", {
				cls: "agent-dashboard-mineru-advanced",
			});
			advanced.createEl("summary", { text: "页面范围与超时" });
			const advancedGrid = advanced.createDiv({
				cls: "agent-dashboard-mineru-grid",
			});
			const timeout = createNumberField(
				advancedGrid,
				"提取超时（秒）",
				"单篇请求上限，范围 60–1800 秒。",
				this.plugin.settings.mineruDefaultTimeoutSeconds,
				60,
				1800,
				30,
			);
			const pages = advancedGrid.createDiv({
				cls: "agent-dashboard-mineru-field",
			});
			const pagesCopy = pages.createDiv();
			pagesCopy.createEl("strong", { text: "页面范围" });
			pagesCopy.createSpan({ text: "从 1 开始，例如 1-10,15；留空提取全文。" });
			const pagesInput = pages.createEl("input", {
				attr: {
					type: "text",
					placeholder: "1-10,15",
					"aria-label": "MinerU 页面范围",
				},
			});
			mineruPanel.createEl("p", {
				cls: "agent-dashboard-action-options-description",
				text: "文档会上传到 MinerU 服务端处理。Token 由 MinerU CLI 管理，插件不保存密钥；批量模式和非 Markdown 输出不在单篇入库中开放。",
			});
			const uploadConfirmation = this.plugin.settings.mineruConfirmRemoteUpload
				? this.createCheckboxOption(
					mineruPanel,
					"确认远程处理",
					"我确认本次 PDF 将发送至配置的 MinerU 服务进行解析。",
					false,
				)
				: null;

			const wikiOption = this.createCheckboxOption(
				section,
				"创建初步文章 Wiki",
				"创建或更新 wiki/sources 下的 abstract-level 文章节点。",
				true,
			);
			const sourceField = section.createDiv({
				cls: "agent-dashboard-action-options-field",
			});
			const sourceCopy = sourceField.createDiv();
			sourceCopy.createEl("strong", { text: "文章 Wiki 内容来源" });
			sourceCopy.createEl("span", {
				text: "自动模式优先使用本次或已有的已验证 article.md，否则回退到原始 PDF。",
			});
			const sourceSelect = sourceField.createEl("select", {
				attr: { "aria-label": "文章 Wiki 内容来源" },
			});
			sourceSelect.createEl("option", { text: "自动选择", attr: { value: "auto" } });
			sourceSelect.createEl("option", { text: "原始 PDF", attr: { value: "pdf" } });
			sourceSelect.createEl("option", { text: "已有 article.md", attr: { value: "article" } });
			sourceSelect.value = this.plugin.settings.mineruDefaultArticleWikiSource;

			const normalizePages = (): string | null => {
				const text = pagesInput.value.trim().replace(/，/g, ",");
				if (!text) return "";
				const tokens = text.split(/[,\s]+/).filter(Boolean);
				for (const token of tokens) {
					const match = /^(\d+)(?:-(\d+))?$/.exec(token);
					if (!match) return null;
					const start = Number(match[1]);
					const end = Number(match[2] || match[1]);
					if (start < 1 || end < start) return null;
				}
				return tokens.join(",");
			};
			const isNumberInRange = (input: HTMLInputElement, min: number, max: number) => {
				return Number.isFinite(input.valueAsNumber)
					&& input.valueAsNumber >= min
					&& input.valueAsNumber <= max;
			};

			const sync = () => {
				const markdownEnabled = markdownOption.checked;
				mineruPanel.hidden = !markdownEnabled;
				if (mineruWarning) mineruWarning.hidden = !markdownEnabled;
				sourceSelect.disabled = !wikiOption.checked;
				section.toggleClass(
					"is-invalid",
					(!markdownOption.checked && !wikiOption.checked)
						|| (markdownOption.checked && !mineruAvailable),
				);
				onChange();
			};
			this.paperIngestSync = sync;
			markdownOption.addEventListener("change", sync);
			wikiOption.addEventListener("change", sync);
			sourceSelect.addEventListener("change", onChange);
			for (const control of [
				model.select,
				language.select,
				includeSourcePdf,
				ocr,
				formula,
				table,
				pagesInput,
				timeout.input,
				...(uploadConfirmation ? [uploadConfirmation] : []),
			]) {
				control.addEventListener("change", sync);
				control.addEventListener("input", sync);
			}
			sync();

			return {
				getOptions: () => ({
					createArticleMarkdown: markdownOption.checked,
					createArticleWiki: wikiOption.checked,
					articleWikiSource: sourceSelect.value === "pdf"
						? "pdf"
						: sourceSelect.value === "article"
							? "article"
							: this.plugin.settings.mineruDefaultArticleWikiSource,
					mineruModel: model.select.value === "pipeline"
						? "pipeline"
						: model.select.value === "auto"
							? "auto"
							: "vlm",
					mineruLanguage: language.select.value,
					mineruOcr: ocr.checked,
					mineruFormula: formula.checked,
					mineruTable: table.checked,
					mineruPages: normalizePages() || "",
					mineruTimeoutSeconds: timeout.input.valueAsNumber,
					mineruIncludeSourcePdf: includeSourcePdf.checked,
					mineruRemoteConfirmed: uploadConfirmation ? uploadConfirmation.checked : true,
				}),
				isValid: () => {
					if (!markdownOption.checked && !wikiOption.checked) return false;
					if (!markdownOption.checked) return true;
					const extractionReady = this.runner === "light-agent"
						? mineruAvailable && this.plugin.lightAgentMineruReady()
						: mineruAvailable;
					return extractionReady
						&& normalizePages() !== null
						&& isNumberInRange(timeout.input, 60, 1800)
						&& Number.isInteger(timeout.input.valueAsNumber)
						&& (!uploadConfirmation || uploadConfirmation.checked);
				},
			};
		}

		if (this.action.id === "pdf-xray") {
			const section = parent.createEl("section", {
				cls: "agent-dashboard-action-options",
				attr: { "aria-label": "PDF 深读来源" },
			});
			section.createEl("h3", { text: "深读来源" });
			section.createEl("p", {
				cls: "agent-dashboard-action-options-description",
				text: "运行时严格使用所选来源，不会在未说明的情况下切换。",
			});
			const group = section.createDiv({
				cls: "agent-dashboard-source-choice",
				attr: { role: "radiogroup", "aria-label": "PDF 深读来源" },
			});
			const groupName = `pdf-xray-source-${Date.now()}`;
			const pdf = this.createRadioOption(group, groupName, "pdf", "原始 PDF", true);
			const article = this.createRadioOption(group, groupName, "article", "已有 article.md", false);
			pdf.addEventListener("change", onChange);
			article.addEventListener("change", onChange);
			return {
				getOptions: () => ({ pdfXraySource: article.checked ? "article" : "pdf" }),
				isValid: () => pdf.checked || article.checked,
			};
		}

		return {
			getOptions: () => ({}),
			isValid: () => true,
		};
	}

	createCheckboxOption(
		parent: HTMLElement,
		title: string,
		description: string,
		checked: boolean,
	): HTMLInputElement {
		const label = parent.createEl("label", { cls: "agent-dashboard-checkbox-option" });
		const input = label.createEl("input", { attr: { type: "checkbox" } });
		input.checked = checked;
		const copy = label.createDiv();
		copy.createEl("strong", { text: title });
		copy.createEl("span", { text: description });
		return input;
	}

	createRadioOption(
		parent: HTMLElement,
		name: string,
		value: string,
		labelText: string,
		checked: boolean,
	): HTMLInputElement {
		const label = parent.createEl("label", { cls: "agent-dashboard-radio-option" });
		const input = label.createEl("input", {
			attr: { type: "radio", name, value },
		});
		input.checked = checked;
		label.createSpan({ text: labelText });
		return input;
	}

	renderExecutionControls(parent: HTMLElement): { getOverrides: () => ExecutionOverrides } {
		const supportsStageWriteBackends = ["code-analysis", "synthesis"].includes(
			this.action.id,
		);
		const configuredDefault = this.plugin.settings.actionExecutionDefaults[this.action.id];
		const configuredBackend = configuredDefault?.backend;
		let backendId: CliBackendId = supportsStageWriteBackends
			&& (configuredBackend === "claude-code" || configuredBackend === "opencode")
			&& this.plugin.isCliBackendAvailable(configuredBackend)
			? configuredBackend
			: "codex-cli";
		const resolveEffective = (overrides: ExecutionOverrides = {}) => {
			return this.plugin.resolveCliActionExecutionConfig(
				this.action,
				backendId,
				overrides,
			);
		};
		const section = parent.createEl("section", {
			cls: "agent-dashboard-run-config",
			attr: { "aria-label": "本次运行配置" },
		});
		const heading = section.createDiv({ cls: "agent-dashboard-run-config-heading" });
		heading.createSpan({ text: "运行配置" });
		const summary = heading.createSpan({ cls: "agent-dashboard-run-config-summary" });

		let backendSelect: HTMLSelectElement | null = null;
		if (supportsStageWriteBackends) {
			backendSelect = this.createSelectField(section, "执行后端", "运行执行后端");
			backendSelect.createEl("option", {
				text: "Codex CLI",
				attr: { value: "codex-cli" },
			});
			const claudeOption = backendSelect.createEl("option", {
				text: this.plugin.isCliBackendAvailable("claude-code")
					? "Claude Code · 阶段写入"
					: "Claude Code · 未配置",
				attr: { value: "claude-code" },
			});
			claudeOption.disabled = !this.plugin.isCliBackendAvailable("claude-code");
			const openCodeOption = backendSelect.createEl("option", {
				text: this.plugin.isCliBackendAvailable("opencode")
					? "OpenCode · 阶段写入"
					: "OpenCode · 未配置",
				attr: { value: "opencode" },
			});
			openCodeOption.disabled = !this.plugin.isCliBackendAvailable("opencode");
			backendSelect.value = backendId;
		}

		const modelSelect = this.createSelectField(section, "模型", "运行模型");
		const reasoningSelect = this.createSelectField(section, "推理强度", "运行推理强度");
		const reasoningDefaultOption = reasoningSelect.createEl("option", {
			text: "",
			attr: { value: "" },
		});
		REASONING_OPTIONS.forEach((option) => {
			reasoningSelect.createEl("option", { text: option.label, attr: { value: option.id } });
		});

		const speedField = section.createDiv({ cls: "agent-dashboard-run-config-field" });
		speedField.createSpan({ cls: "agent-dashboard-run-config-label", text: "速度" });
		const speedControl = speedField.createDiv({
			cls: "agent-dashboard-speed-control",
			attr: { role: "group", "aria-label": "运行速度" },
		});
		let serviceTier: ServiceTier = backendId === "codex-cli" && configuredDefault?.serviceTier === "fast"
			? "fast"
			: "default";
		const speedOptions: Array<[ServiceTier, string, string]> = [
			["default", "标准", "默认速度"],
			["fast", "快速", "约 1.5 倍速度，用量更多"],
		];
		const speedButtons = speedOptions.map(([value, label, title]) => {
			const button = speedControl.createEl("button", {
				cls: value === serviceTier ? "agent-dashboard-speed-option is-active" : "agent-dashboard-speed-option",
				text: label,
				attr: { type: "button", title, "aria-pressed": value === serviceTier ? "true" : "false" },
			});
			button.addEventListener("click", () => {
				if (button.disabled) return;
				serviceTier = value;
				syncSpeedControl();
				updateSummary();
			});
			button.dataset.value = value;
			return button;
		});
		const boundaryNotice = section.createDiv({
			cls: "agent-dashboard-run-config-note",
		});

		const getOverrides = (): ExecutionOverrides => ({
			backend: backendId,
			model: modelSelect.value,
			reasoningEffort: reasoningSelect.value,
			serviceTier: backendId === "codex-cli" ? serviceTier : "default",
		});
		const populateModelOptions = () => {
			const previous = modelSelect.value;
			modelSelect.empty();
			const actionDefault = resolveEffective();
			modelSelect.createEl("option", {
				text: backendId === "claude-code"
					? `使用 Claude 默认 · ${actionDefault.model || getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)}`
					: backendId === "opencode"
						? `使用 OpenCode 默认 · ${actionDefault.model || getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)}`
					: `使用 Codex 默认 · ${actionDefault.model
						? this.plugin.getModelLabel(actionDefault.model)
						: getCodexDefaultModelLabel(this.plugin.settings.codexConfigSource)}`,
				attr: { value: "" },
			});
			const options = backendId !== "codex-cli"
				? [
					...(this.plugin.getCliModelDiscovery(backendId)?.models || []),
					...((backendId === "claude-code"
						? this.plugin.settings.claudeModel
						: this.plugin.settings.openCodeModel)
						? [{
							id: backendId === "claude-code"
								? this.plugin.settings.claudeModel
								: this.plugin.settings.openCodeModel,
							label: backendId === "claude-code"
								? this.plugin.settings.claudeModel
								: this.plugin.settings.openCodeModel,
							supportsFast: false,
						}]
						: []),
				]
				: this.plugin.settings.codexConfigSource === "cc-switch"
					? this.plugin.getCliModelDiscovery("codex-cli")?.models || []
					: [
					...MODEL_OPTIONS,
					...(MODEL_OPTIONS.some(
						(option) => option.id === this.plugin.settings.codexModel,
					)
						? []
						: [{
							id: this.plugin.settings.codexModel,
							label: this.plugin.settings.codexModel,
							supportsFast: false,
						}]),
					];
			const seen = new Set<string>();
			options.forEach((option) => {
				if (!option.id || seen.has(option.id)) return;
				seen.add(option.id);
				const description = "description" in option
					? option.description
					: "";
				modelSelect.createEl("option", {
					text: description
						? `${option.label} · ${description}`
						: option.label,
					attr: { value: option.id },
				});
			});
			modelSelect.value = seen.has(previous) ? previous : "";
		};
		const syncReasoningDefault = () => {
			const actionDefault = resolveEffective();
			reasoningDefaultOption.setText(
				backendId !== "codex-cli"
					? `使用 ${getCliBackendLabel(backendId)} 默认 · ${this.plugin.getReasoningLabel(actionDefault.reasoningEffort)}`
					: actionDefault.reasoningEffort
						? `使用 Codex 默认 · ${this.plugin.getReasoningLabel(actionDefault.reasoningEffort)}`
						: "使用 CC Switch 当前推理强度",
			);
		};
		const syncSpeedControl = () => {
			speedField.style.display = backendId === "codex-cli" ? "" : "none";
			if (backendId !== "codex-cli") {
				serviceTier = "default";
				return;
			}
			const actionDefault = resolveEffective();
			const selectedModel = modelSelect.value || actionDefault.model;
			const supportsFast = this.plugin.supportsFast(selectedModel);
			const usesCodexSwitch = this.plugin.settings.codexConfigSource === "cc-switch";
			speedButtons[0].setText(usesCodexSwitch ? "当前配置" : "标准");
			speedButtons[0].setAttr(
				"title",
				usesCodexSwitch ? "沿用 CC Switch 当前 service tier" : "默认速度",
			);
			if (!supportsFast) serviceTier = "default";
			speedButtons.forEach((item) => {
				const isFast = item.dataset.value === "fast";
				const active = item.dataset.value === serviceTier;
				item.disabled = isFast && !supportsFast;
				item.toggleClass("is-active", active);
				item.setAttr("aria-pressed", active ? "true" : "false");
				if (isFast) {
					item.setAttr("title", supportsFast ? "约 1.5 倍速度，用量更多" : "当前模型不支持 Fast 速度");
				}
			});
		};
		const syncBoundaryNotice = () => {
			boundaryNotice.setText(
				backendId === "claude-code"
					? "Claude Code：仅允许当前阶段目录写入，Bash 已禁用；结束后生成变更清单并执行知识库体检，越界或失败时回滚。"
					: backendId === "opencode"
						? "OpenCode：仅允许当前阶段写入，Shell 与外部目录访问已禁用；结束后生成变更清单并执行知识库体检，越界或失败时回滚。"
					: "Codex CLI：按操作拥有的目录执行；运行前建立快照，停止、失败、越界或后置体检失败时自动回滚。",
			);
		};
		const updateSummary = () => {
			const effective = resolveEffective(getOverrides());
			const backendLabel = getCliBackendLabel(backendId);
			const modelLabel = effective.model
				? this.plugin.getModelLabel(effective.model)
				: backendId === "claude-code"
					? getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)
					: backendId === "opencode"
						? getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)
						: getCodexDefaultModelLabel(this.plugin.settings.codexConfigSource);
			const reasoningLabel = effective.reasoningEffort
				? this.plugin.getReasoningLabel(effective.reasoningEffort)
				: "CLI 默认推理";
			summary.setText(
				backendId !== "codex-cli"
					? `${backendLabel} · ${modelLabel} · ${reasoningLabel}`
					: `${backendLabel} · ${modelLabel} · ${reasoningLabel} · ${
						effective.serviceTier === "fast"
							? "快速"
							: this.plugin.settings.codexConfigSource === "cc-switch"
								? "当前速度配置"
								: "标准"
					}`,
			);
		};
		modelSelect.addEventListener("change", () => {
			syncSpeedControl();
			updateSummary();
		});
		reasoningSelect.addEventListener("change", updateSummary);
		backendSelect?.addEventListener("change", () => {
			backendId = backendSelect?.value === "claude-code"
				? "claude-code"
				: backendSelect?.value === "opencode"
					? "opencode"
					: "codex-cli";
			serviceTier = "default";
			modelSelect.value = "";
			reasoningSelect.value = "";
			populateModelOptions();
			syncReasoningDefault();
			syncSpeedControl();
			syncBoundaryNotice();
			updateSummary();
			void this.plugin.discoverCliModels(backendId).then(() => {
				if (backendSelect?.value !== backendId) return;
				populateModelOptions();
				syncSpeedControl();
				updateSummary();
			}).catch(() => undefined);
		});
		populateModelOptions();
		syncReasoningDefault();
		syncSpeedControl();
		syncBoundaryNotice();
		updateSummary();
		return { getOverrides };
	}

	createSelectField(parent: HTMLElement, label: string, ariaLabel: string): HTMLSelectElement {
		const field = parent.createDiv({ cls: "agent-dashboard-run-config-field" });
		field.createSpan({ cls: "agent-dashboard-run-config-label", text: label });
		return field.createEl("select", {
			cls: "agent-dashboard-run-config-select",
			attr: { "aria-label": ariaLabel },
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
