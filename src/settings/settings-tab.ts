import * as fs from "node:fs";
import * as path from "node:path";

import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	setIcon,
} from "obsidian";

import { ACTIONS, type DashboardAction } from "../actions";
import {
	getCliBackendLabel,
	MAX_QUERY_IMAGE_ATTACHMENTS,
	MODEL_OPTIONS,
	PROVIDER_TYPES,
	PROVIDER_TYPE_BY_ID,
	REASONING_OPTIONS,
	type CliBackendId,
	type ProviderTypeId,
} from "../config";
import {
	detectNativeWebSearchProtocol,
	makeProviderProfile,
	modelHasKnownVisionSupport,
	type ProfileWebSearchMode,
	type ProviderProfile,
} from "../providers/profile";
import type { ProviderModel } from "../providers/shared";
import {
	CONFIGURABLE_ACTION_IDS,
	DEFAULT_ACTION_EXECUTION_DEFAULTS,
	DEFAULT_SETTINGS,
	MINERU_LANGUAGE_IDS,
	STAGE_WRITE_BACKEND_ACTION_IDS,
	describeCliExecutable,
	detectCliExecutable,
	getClaudeConfigSourceLabel,
	getClaudeDefaultModelLabel,
	getCodexConfigSourceLabel,
	getOpenCodeConfigSourceLabel,
	getOpenCodeDefaultModelLabel,
	normalizeReaderMarkdownFolders,
	type ActionExecutionDefault,
	type CliExecutableKind,
} from "../runtime/settings";
import type {
	ObsidianCliConnectionResult,
	ObsidianCliProbeState,
} from "../runtime/obsidian-cli";
import type {
	PluginHost,
	ProviderConnectionTestResult,
	ProviderRuntimeEntry,
} from "../types/contracts";

interface SettingsPluginHost extends PluginHost {
	providerRuntimeState: Map<string, ProviderRuntimeEntry>;
	obsidianCliProbeState: ObsidianCliProbeState;
	providerEditorProfileId: string;
	saveSettings(): Promise<void>;
	checkRuntime(): { ready: boolean; message: string };
	listProviderModels(profileId: string): Promise<ProviderModel[]>;
	testProviderConnection(profileId: string): Promise<ProviderConnectionTestResult>;
	probeMineruCliConnection(): Promise<ProviderConnectionTestResult>;
	probeObsidianCliConnection(): Promise<ObsidianCliConnectionResult>;
	invalidateCliModelDiscovery(backendId: CliBackendId): void;
	getProviderErrorLabel(type: string): string;
	lightAgentMineruReady(): boolean;
	getProviderProfile(profileId: string): ProviderProfile | null;
	directApiBoundaryLabel(profileId: string): string;
	supportsFast(model: string): boolean;
	clearCompletedTaskHistory(): Promise<number>;
	setTaskHistoryLimit(value: number): Promise<void>;
	resetQueryHistory(): Promise<void>;
	buildDiagnosticsSummary(): string;
}

type SettingsPage =
	| "home"
	| "runtime"
	| "obsidian-cli"
	| "mineru"
	| "reader"
	| "tasks"
	| "data"
	| "codex"
	| "claude"
	| "opencode"
	| "annotations"
	| "direct-api";

export class AgentDashboardSettingTab extends PluginSettingTab {
	declare plugin: Plugin & SettingsPluginHost;
	private activePage: SettingsPage = "home";

	constructor(app: App, plugin: Plugin & SettingsPluginHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const previousPage = this.activePage;
		const previousScrollTop = containerEl.scrollTop;
		containerEl.empty();
		containerEl.addClass("agent-dashboard-settings");
		switch (this.activePage) {
			case "runtime":
				this.renderRuntimeSettings(containerEl);
				break;
			case "obsidian-cli":
				this.renderObsidianCliSettings(containerEl);
				break;
			case "mineru":
				this.renderMineruSettings(containerEl);
				break;
			case "reader":
				this.renderReaderSettings(containerEl);
				break;
			case "tasks":
				this.renderTaskDefaultsSettings(containerEl);
				break;
			case "data":
				this.renderDataSettings(containerEl);
				break;
			case "codex":
				this.renderCodexSettings(containerEl);
				break;
			case "claude":
				this.renderClaudeSettings(containerEl);
				break;
			case "opencode":
				this.renderOpenCodeSettings(containerEl);
				break;
			case "annotations":
				this.renderAnnotationSettings(containerEl);
				break;
			case "direct-api":
				this.renderDirectApiSettings(containerEl);
				break;
			default:
				this.renderSettingsHome(containerEl);
		}
		// Re-rendering replaces the DOM and resets the scroll position; keep
		// it stable when staying on the same settings page.
		if (this.activePage === previousPage) {
			containerEl.scrollTop = previousScrollTop;
		} else {
			containerEl.scrollTop = 0;
		}
	}

	private renderSettingsHome(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"Research Agent Reader",
			"核心阅读开箱即用；AI 助手只需配置一个供应商；其余扩展全部可选。进入模块后再修改详细设置。",
		);

		const coreNavigation = this.createSettingsHomeSection(containerEl, "阅读 · 开箱即用");
		this.createSettingsNavigationItem(coreNavigation, {
			page: "reader",
			icon: "book-open-text",
			title: "文献阅读器",
			description: "默认接管目录、图文双栏、跟随阅读、版面框、缩放与栏宽。",
			status: `${this.plugin.settings.readerMarkdownFolders.length} 个目录`,
			badge: { text: "核心", tone: "ok" },
		});
		this.createSettingsNavigationItem(coreNavigation, {
			page: "data",
			icon: "database-zap",
			title: "数据与诊断",
			description: "历史保留、知识库维护范围、脱敏诊断和清理操作。",
			status: `任务 ${this.plugin.settings.taskHistoryLimit} · 对话 ${this.plugin.settings.querySessionLimit}`,
			badge: { text: "内置", tone: "ok" },
		});

		const aiNavigation = this.createSettingsHomeSection(containerEl, "AI 助手");
		const profiles = this.plugin.settings.providerProfiles;
		const activeProfile = profiles.find(
			(profile) => profile.id === this.plugin.settings.activeProviderId,
		);
		this.createSettingsNavigationItem(aiNavigation, {
			page: "direct-api",
			icon: "plug-zap",
			title: "Direct API 知识助手",
			description: "知识问答、联网搜索与轻量 Agent 的供应商、凭据、模型能力和连接测试。",
			status: activeProfile
				? `${activeProfile.name} · 已启用`
				: profiles.length
					? `${profiles.length} 个配置`
					: "未配置",
			badge: activeProfile
				? { text: "已配置", tone: "ok" }
				: { text: "未配置", tone: "warn" },
		});
		const annotationBackendId = this.plugin.settings.annotationBackendId || "auto";
		const annotationProfile = this.plugin.settings.providerProfiles.find(
			(profile) => profile.id === annotationBackendId,
		);
		const annotationStatus = annotationBackendId === "auto"
			? "自动选择"
			: annotationBackendId === "codex-cli"
				? `Codex · ${this.plugin.settings.annotationCodexModel || "默认模型"}`
				: annotationBackendId === "claude-code"
					? `Claude · ${this.plugin.settings.annotationClaudeModel || getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)}`
					: annotationBackendId === "opencode"
						? `OpenCode · ${this.plugin.settings.annotationOpenCodeModel || getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)}`
					: annotationProfile
						? `${annotationProfile.name} · ${annotationProfile.model}`
						: "自动选择";
		this.createSettingsNavigationItem(aiNavigation, {
			page: "annotations",
			icon: "message-square-text",
			title: "批注 AI",
			description: "选择批注解释后端、模型、推理强度、速度和输出长度。",
			status: annotationStatus,
			badge: annotationBackendId === "auto"
				? { text: "可选后端", tone: "muted" }
				: { text: "已配置", tone: "ok" },
		});
		this.createSettingsNavigationItem(aiNavigation, {
			page: "tasks",
			icon: "sliders-horizontal",
			title: "任务默认策略",
			description: "按操作设置默认后端、模型、推理强度、速度和查询模式。",
			status: `${CONFIGURABLE_ACTION_IDS.length} 项策略`,
			badge: { text: "可选", tone: "muted" },
		});

		const optionalNavigation = this.createSettingsHomeSection(containerEl, "可选扩展 · 高级");
		const toolkitRoot = String(this.plugin.settings.toolkitRoot || "").trim();
		const toolkitAvailable = toolkitRoot !== "" && fs.existsSync(toolkitRoot);
		this.createSettingsNavigationItem(optionalNavigation, {
			page: "runtime",
			icon: "terminal",
			title: "工具链与运行环境",
			description: "可选工具链目录、Agent/Python/R 可执行文件、任务超时和环境检查。",
			status: toolkitAvailable
				? "工具链可用"
				: toolkitRoot
					? "目录不可用"
					: "本地执行",
			badge: toolkitAvailable
				? { text: "已配置", tone: "ok" }
				: { text: "可选", tone: "muted" },
		});
		const reasoningLabel = REASONING_OPTIONS.find(
			(option) => option.id === this.plugin.settings.codexReasoningEffort,
		)?.label || this.plugin.settings.codexReasoningEffort;
		const codexSourceLabel = getCodexConfigSourceLabel(
			this.plugin.settings.codexConfigSource,
		);
		const codexAvailable = this.plugin.isCliBackendAvailable("codex-cli");
		this.createSettingsNavigationItem(optionalNavigation, {
			page: "codex",
			icon: "bot",
			title: "Codex CLI",
			description: "选择官方 OpenAI 配置或 CC Switch 当前配置。",
			status: this.plugin.settings.codexConfigSource === "official"
				? `${codexSourceLabel} · ${this.plugin.settings.codexModel} · ${reasoningLabel}`
				: `${codexSourceLabel} · 当前配置`,
			badge: codexAvailable
				? { text: "可用", tone: "ok" }
				: { text: "未检测到", tone: "warn" },
		});
		const claudeReasoningLabel = REASONING_OPTIONS.find(
			(option) => option.id === this.plugin.settings.claudeReasoningEffort,
		)?.label || this.plugin.settings.claudeReasoningEffort;
		const claudeSourceLabel = getClaudeConfigSourceLabel(
			this.plugin.settings.claudeConfigSource,
		);
		const claudeAvailable = this.plugin.isCliBackendAvailable("claude-code");
		this.createSettingsNavigationItem(optionalNavigation, {
			page: "claude",
			icon: "sparkles",
			title: "Claude Code",
			description: "选择官方配置或 CC Switch，并管理模型覆盖和连接测试。",
			status: `${claudeSourceLabel} · ${this.plugin.settings.claudeModel || "默认模型"} · ${claudeReasoningLabel}`,
			badge: claudeAvailable
				? { text: "可用", tone: "ok" }
				: { text: "未检测到", tone: "warn" },
		});
		const openCodeReasoningLabel = REASONING_OPTIONS.find(
			(option) => option.id === this.plugin.settings.openCodeReasoningEffort,
		)?.label || this.plugin.settings.openCodeReasoningEffort;
		const openCodeSourceLabel = getOpenCodeConfigSourceLabel(
			this.plugin.settings.openCodeConfigSource,
		);
		const openCodeAvailable = this.plugin.isCliBackendAvailable("opencode");
		this.createSettingsNavigationItem(optionalNavigation, {
			page: "opencode",
			icon: "braces",
			title: "OpenCode",
			description: "选择官方 OpenCode Zen 或 CC Switch，并自动识别当前可用模型。",
			status: `${openCodeSourceLabel} · ${this.plugin.settings.openCodeModel || "默认模型"} · ${openCodeReasoningLabel}`,
			badge: openCodeAvailable
				? { text: "可用", tone: "ok" }
				: { text: "未检测到", tone: "warn" },
		});
		this.createSettingsNavigationItem(optionalNavigation, {
			page: "mineru",
			icon: "file-scan",
			title: "MinerU 文献解析",
			description: "CLI、服务地址、认证状态提示和文献入库默认参数。",
			status: this.plugin.settings.mineruServiceMode === "private"
				? "私有服务"
				: `官方服务 · ${this.plugin.settings.mineruDefaultModel.toUpperCase()}`,
			badge: { text: "可选", tone: "muted" },
		});
		const obsidianCliDetection = describeCliExecutable(
			"obsidian",
			this.plugin.settings.obsidianCliExecutable,
		);
		this.createSettingsNavigationItem(optionalNavigation, {
			page: "obsidian-cli",
			icon: "square-terminal",
			title: "Obsidian CLI",
			description: "可选的外部自动化桥梁、连接诊断与开发回归入口。",
			status: obsidianCliDetection.found
				? obsidianCliDetection.sourceLabel
				: "可选外部工具",
			badge: obsidianCliDetection.found
				? { text: "可用", tone: "ok" }
				: { text: "未检测到", tone: "muted" },
		});
	}

	/**
	 * Live readiness checklist for the runtime page: each line shows what a
	 * component unlocks and whether it is currently satisfied, so "为什么不
	 * 满足" never requires reading the source.
	 */
	private renderToolkitReadiness(containerEl: HTMLElement): void {
		const lines: Array<[string, boolean, string]> = [
			[
				"轻量入库 · PDF 转换（MinerU CLI）",
				this.plugin.lightAgentMineruReady(),
				"npm 全局安装 mineru-open-api 并在下方 MinerU 可执行文件中配置；无需 Python 或工具包目录",
			],
			[
				"CLI 完整登记与高级操作（工具包目录）",
				Boolean(this.plugin.settings.toolkitRoot.trim())
					&& fs.existsSync(this.plugin.settings.toolkitRoot)
					&& fs.existsSync(path.join(this.plugin.settings.toolkitRoot, "tool-library", "scripts", "run_vault_action.py")),
				"填写包含 AGENTS.md、tool-library/ 的项目根目录",
			],
			[
				"工具包脚本运行时（Python）",
				Boolean(this.plugin.settings.pythonExecutable.trim())
					&& fs.existsSync(this.plugin.settings.pythonExecutable),
				"运行工具包内的 Python 脚本（统一 runner、MinerU 辅助、代码练习）",
			],
			[
				"Agent 任务（Codex CLI）",
				this.plugin.isCliBackendAvailable("codex-cli"),
				"完整入库登记、PDF 深读、综合分析等 Agent 化操作",
			],
		];
		new Setting(containerEl)
			.setName("组件就绪状态")
			.setDesc(lines.map(([label, ready, hint]) =>
				`${ready ? "✓" : "✗"} ${label} — ${ready ? "可用" : hint}`).join("\n"));
	}

	private renderRuntimeSettings(containerEl: HTMLElement): void {		this.createSettingsPageHeader(
			containerEl,
			"工具链与运行环境",
			"管理可选工具链目录、本地任务的项目路径、运行时和超时限制。",
			true,
		);
		new Setting(containerEl)
			.setName("内置核心功能")
			.setDesc("阅读器、本地批注和只读知识库体检直接使用当前 Vault，不需要项目目录、Python 或 Agent CLI。");
		new Setting(containerEl)
			.setName("可选工具包项目目录")
			.setDesc("仅供文献入库、AI 深读、代码分析、综合分析、修复和 OKF 导出使用；应包含 AGENTS.md、.codex/ 和 tool-library/。留空不会影响核心阅读功能。")
			.addText((text) =>
				text
					.setPlaceholder(process.platform === "win32" ? "D:\\Research\\workspace" : "/Users/name/research-workspace")
					.setValue(this.plugin.settings.toolkitRoot)
					.onChange(async (value) => {
						this.plugin.settings.toolkitRoot = value.trim();
						await this.plugin.saveSettings();
					})
			);
		this.renderToolkitReadiness(containerEl);
		this.renderCliExecutableSetting(containerEl, {
			kind: "codex",
			name: "Codex 可执行文件",
			description: "用于文献、代码、检索和综合任务；有效的手动路径不会在启动时被覆盖。",
			placeholder: "codex.exe",
			getValue: () => this.plugin.settings.codexExecutable,
			setValue: (value) => {
				this.plugin.settings.codexExecutable = value;
				this.plugin.invalidateCliModelDiscovery("codex-cli");
			},
		});
		this.renderCliExecutableSetting(containerEl, {
			kind: "claude",
			name: "Claude Code 可执行文件",
			description: "用于知识库检索、批注解释和受审计的阶段所有权写入。",
			placeholder: "claude.exe",
			getValue: () => this.plugin.settings.claudeExecutable,
			setValue: (value) => {
				this.plugin.settings.claudeExecutable = value;
				this.plugin.invalidateCliModelDiscovery("claude-code");
			},
		});
		this.renderCliExecutableSetting(containerEl, {
			kind: "opencode",
			name: "OpenCode 可执行文件",
			description: "用于检索、批注解释，以及代码分析和综合分析的阶段所有权写入。",
			placeholder: "opencode.exe",
			getValue: () => this.plugin.settings.openCodeExecutable,
			setValue: (value) => {
				this.plugin.settings.openCodeExecutable = value;
				this.plugin.invalidateCliModelDiscovery("opencode");
			},
		});
		new Setting(containerEl)
			.setName("Python 可执行文件")
			.setDesc("仅用于可选工具包 runner 和 Python 代码练习；内置知识库体检不需要 Python。")
			.addText((text) =>
				text
					.setPlaceholder(process.platform === "win32" ? "C:\\Python312\\python.exe" : "/usr/bin/python3")
					.setValue(this.plugin.settings.pythonExecutable)
					.onChange(async (value) => {
						this.plugin.settings.pythonExecutable = value.trim();
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Rscript 可执行文件")
			.setDesc("用于无状态 R 代码练习；不会自动安装 R 或 R 包。")
			.addText((text) =>
				text
					.setPlaceholder(process.platform === "win32" ? "C:\\Program Files\\R\\R-x.y.z\\bin\\Rscript.exe" : "/usr/local/bin/Rscript")
					.setValue(this.plugin.settings.rscriptExecutable)
					.onChange(async (value) => {
						this.plugin.settings.rscriptExecutable = value.trim();
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("代码练习超时（秒）")
			.setDesc("每次 Python/R 练习的最长运行时间，范围 1-120 秒。")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.codePracticeTimeoutSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.codePracticeTimeoutSeconds = Math.max(1, Math.min(120, parsed));
							await this.plugin.saveSettings();
						}
					})
			);
		new Setting(containerEl)
			.setName("任务超时（分钟）")
			.setDesc("单个本地脚本或 Codex 任务的最长运行时间，范围 1-240 分钟。")
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.taskTimeoutMinutes))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.taskTimeoutMinutes = Math.max(1, Math.min(240, parsed));
							await this.plugin.saveSettings();
						}
					})
			);
		new Setting(containerEl)
			.setName("可选工具包运行环境")
			.setDesc("检查工具包目录、Agent CLI、Python 和 runner；检查失败不会禁用内置核心功能。")
			.addButton((button) =>
				button.setButtonText("检查").onClick(() => {
					const result = this.plugin.checkRuntime();
					new Notice(result.message, 8000);
				})
			);
	}

	private renderCliExecutableSetting(
		containerEl: HTMLElement,
		options: {
			kind: CliExecutableKind;
			name: string;
			description: string;
			placeholder: string;
			getValue: () => string;
			setValue: (value: string) => void;
		},
	): void {
		const setting = new Setting(containerEl).setName(options.name);
		const refreshDescription = (): void => {
			const detection = describeCliExecutable(
				options.kind,
				options.getValue(),
			);
			setting.setDesc(
				`${options.description} 自动检测来源：${detection.sourceLabel}。`,
			);
		};
		setting.addText((text) =>
			text
				.setPlaceholder(options.placeholder)
				.setValue(options.getValue())
				.onChange(async (value) => {
					options.setValue(value.trim());
					refreshDescription();
					await this.plugin.saveSettings();
				})
		);
		setting.addButton((button) =>
			button
				.setButtonText("重新检测")
				.setTooltip(`重新检测 ${options.name}`)
				.onClick(async () => {
					const detected = detectCliExecutable(
						options.kind,
						options.getValue(),
					);
					if (!detected.found) {
						new Notice(
							`未检测到 ${options.name}；已保留当前手动路径。`,
							6000,
						);
						refreshDescription();
						return;
					}
					options.setValue(detected.executable);
					await this.plugin.saveSettings();
					new Notice(
						`${options.name}：${detected.sourceLabel}`,
						5000,
					);
					this.display();
				})
		);
		refreshDescription();
	}

	private renderObsidianCliSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"Obsidian CLI",
			"连接运行中的 Obsidian，用于外部自动化、开发诊断和真实界面回归。Dashboard 核心功能不依赖此能力。",
			true,
		);
		this.createProviderSectionHeader(
			containerEl,
			"连接设置",
			"请先在 Obsidian 设置 → 常规中启用“命令行接口”。插件不会修改 PATH，也不会通过 CLI 绕过 Vault 与 Workspace API。",
		);
		this.renderCliExecutableSetting(containerEl, {
			kind: "obsidian",
			name: "Obsidian CLI 可执行文件",
			description: "Windows 优先检测当前 Obsidian.exe 同目录的 Obsidian.com，也支持环境变量、PATH 和手动路径。",
			placeholder: process.platform === "win32" ? "Obsidian.com" : "obsidian",
			getValue: () => this.plugin.settings.obsidianCliExecutable,
			setValue: (value) => {
				this.plugin.settings.obsidianCliExecutable = value;
				this.plugin.obsidianCliProbeState = { status: "idle" };
			},
		});
		new Setting(containerEl)
			.setName("当前 Vault")
			.setDesc(`连接测试固定核对当前 Vault“${this.app.vault.getName()}”及插件“${this.plugin.manifest.id}”；不读取正文，也不写入文件。`);

		const state = this.plugin.obsidianCliProbeState;
		new Setting(containerEl)
			.setName("最小连接测试")
			.setDesc("依次执行 version、vaults verbose 和当前 Vault 的 plugin 状态查询；均为只读命令。")
			.addButton((button) => {
				const testing = state.status === "testing";
				button
					.setButtonText(testing ? "测试中…" : "测试连接")
					.setCta()
					.setDisabled(testing)
					.onClick(async () => {
						this.plugin.obsidianCliProbeState = { status: "testing" };
						this.display();
						await this.plugin.probeObsidianCliConnection();
						this.display();
					});
			});
		if (state.result) this.renderObsidianCliConnectionResult(containerEl, state.result);

		this.createProviderSectionHeader(
			containerEl,
			"安全边界",
			"插件内读写、导航和检索继续使用 Obsidian Plugin API；CLI 仅作为可选桥梁。",
		);
		new Setting(containerEl)
			.setName("生产功能")
			.setDesc("不开放任意 eval，不自动执行重载、重启、恢复、删除、插件禁用或其他破坏性命令。");
	}

	private renderObsidianCliConnectionResult(
		parent: HTMLElement,
		result: ObsidianCliConnectionResult,
	): void {
		const panel = parent.createDiv({
			cls: `agent-dashboard-provider-result ${result.ok ? "is-success" : "is-error"}`,
		});
		const heading = panel.createDiv({ cls: "agent-dashboard-provider-result-heading" });
		setIcon(heading.createSpan(), result.ok ? "circle-check" : "circle-alert");
		heading.createEl("strong", { text: result.ok ? "CLI 连接成功" : "CLI 连接失败" });
		const grid = panel.createDiv({ cls: "agent-dashboard-provider-result-grid" });
		const addRow = (label: string, value: unknown): void => {
			const row = grid.createDiv();
			row.createSpan({ text: label });
			row.createEl("strong", { text: String(value || "—") });
		};
		addRow("应用版本", result.appVersion);
		addRow("安装器版本", result.installerVersion || "未返回");
		addRow("Vault", result.vaultFound ? `${result.vaultName} · 已识别` : `${result.vaultName} · 未识别`);
		if (result.vaultPath) addRow("Vault 路径", result.vaultPath);
		addRow(
			"插件",
			result.pluginVersion
				? `${result.pluginName || result.pluginId} ${result.pluginVersion} · ${result.pluginEnabled ? "已启用" : "未启用"}`
				: `${result.pluginId} · 状态未知`,
		);
		addRow("只读命令", `${result.commands.filter((command) => command.ok).length}/${result.commands.length} 通过`);
		addRow(result.ok ? "状态" : "详情", result.message);
		addRow("耗时", `${result.durationMs} ms`);
	}

	private renderMineruSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"MinerU 文献解析",
			"管理 MinerU CLI、服务地址和新建文献入库任务的默认解析参数。每次入库仍可临时覆盖。",
			true,
		);
		this.createProviderSectionHeader(
			containerEl,
			"连接与认证",
			"MinerU Token 可保存在 Obsidian SecretStorage，也可继续使用 mineru-open-api CLI 配置或 MINERU_TOKEN 环境变量。插件配置只保存凭据名称。",
		);
		this.renderCliExecutableSetting(containerEl, {
			kind: "mineru",
			name: "MinerU 可执行文件",
			description: "用于文献入库的 precision extract；固定生成 Markdown 与 JSON。只接受可核验为 mineru-open-api 包的 npm shim 或其声明入口，不直接执行任意原生文件。",
			placeholder: "mineru-open-api.cmd",
			getValue: () => this.plugin.settings.mineruExecutable,
			setValue: (value) => {
				this.plugin.settings.mineruExecutable = value;
				this.plugin.providerRuntimeState.delete("mineru");
			},
		});
		const mineruSecretSetting = new Setting(containerEl)
			.setName("MinerU API Token")
			.setDesc("用于 precision extract。选择或创建 Obsidian SecretStorage 凭据；真实 Token 不写入 data.json。");
		if (this.app.secretStorage && typeof SecretComponent === "function") {
			mineruSecretSetting.addComponent((element) =>
				new SecretComponent(this.app, element)
					.setValue(this.plugin.settings.mineruSecretId)
					.onChange(async (value) => {
						this.plugin.settings.mineruSecretId = String(value || "").trim().slice(0, 160);
						this.plugin.providerRuntimeState.delete("mineru");
						await this.plugin.saveSettings();
						this.display();
					})
			);
		} else {
			mineruSecretSetting.setDesc("当前 Obsidian 版本不支持 SecretStorage；请升级 Obsidian，或继续使用 mineru-open-api auth / MINERU_TOKEN。插件不会把 Token 明文写入 data.json。");
		}
		new Setting(containerEl)
			.setName("服务类型")
			.setDesc("官方服务不传入自定义 Base URL；私有部署使用下方地址。")
			.addDropdown((dropdown) => dropdown
				.addOption("official", "MinerU 官方服务")
				.addOption("private", "私有部署")
				.setValue(this.plugin.settings.mineruServiceMode)
				.onChange(async (value) => {
					this.plugin.settings.mineruServiceMode = value === "private" ? "private" : "official";
					if (value !== "private") this.plugin.settings.mineruBaseUrl = "";
					this.plugin.providerRuntimeState.delete("mineru");
					await this.plugin.saveSettings();
					this.display();
				}));
		if (this.plugin.settings.mineruServiceMode === "private") {
			new Setting(containerEl)
				.setName("MinerU 私有服务地址")
				.setDesc("必须使用 http:// 或 https://；保存时自动移除末尾斜杠。")
				.addText((text) => text
					.setPlaceholder("https://mineru.example.com")
					.setValue(this.plugin.settings.mineruBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.mineruBaseUrl = value.trim().replace(/\/+$/g, "").slice(0, 500);
						this.plugin.providerRuntimeState.delete("mineru");
						await this.plugin.saveSettings();
					}));
		}
		const selectedSecretId = String(this.plugin.settings.mineruSecretId || "").trim();
		const selectedSecretReady = Boolean(
			selectedSecretId
			&& this.app.secretStorage?.getSecret?.(selectedSecretId),
		);
		const tokenDetected = Boolean(String(process.env.MINERU_TOKEN || "").trim());
		new Setting(containerEl)
			.setName("认证来源")
			.setDesc(selectedSecretReady
				? `Obsidian SecretStorage：${selectedSecretId}。运行时通过 MINERU_TOKEN 传给 CLI，真实 Token 不进入插件配置或诊断信息。`
				: selectedSecretId
					? `SecretStorage 中未找到“${selectedSecretId}”；请重新选择或创建凭据。若 CLI 已通过 auth 登录，仍可使用其配置。`
					: tokenDetected
						? "已检测到 MINERU_TOKEN 环境变量。真实 Token 不会写入插件配置或诊断信息。"
						: "未选择 SecretStorage 凭据，也未检测到 MINERU_TOKEN；如已使用 mineru-open-api auth 登录，认证仍可能保存在 CLI 配置中。插件不会读取或复制 CLI 凭据。"
			);
		const mineruResult = this.plugin.providerRuntimeState.get("mineru") || null;
		new Setting(containerEl)
			.setName("CLI 可用性检查")
			.setDesc("执行本地 version 检查，不上传 PDF，也不声称验证远程认证。")
			.addButton((button) => {
				const testing = mineruResult?.status === "testing";
				button
					.setButtonText(testing ? "检查中…" : "检查 CLI")
					.setDisabled(testing)
					.onClick(async () => {
						this.plugin.providerRuntimeState.set("mineru", { status: "testing" });
						this.display();
						const result = await this.plugin.probeMineruCliConnection();
						this.plugin.providerRuntimeState.set("mineru", { status: "done", result });
						this.display();
					});
			});
		if (mineruResult?.result) {
			new Setting(containerEl)
				.setName(mineruResult.result.ok ? "CLI 检查通过" : "CLI 检查失败")
				.setDesc(mineruResult.result.message || mineruResult.result.responsePreview || "无详细信息");
		}

		this.createProviderSectionHeader(
			containerEl,
			"文献入库默认值",
			"这些值只作为新任务的起点；任务弹窗中的选择优先。",
		);
		new Setting(containerEl)
			.setName("解析模型")
			.setDesc("VLM 适合复杂版面；Pipeline 更保守；Auto 由服务端选择。")
			.addDropdown((dropdown) => dropdown
				.addOption("vlm", "VLM · 推荐")
				.addOption("pipeline", "Pipeline · 保守")
				.addOption("auto", "Auto · 服务端选择")
				.setValue(this.plugin.settings.mineruDefaultModel)
				.onChange(async (value) => {
					this.plugin.settings.mineruDefaultModel = value === "pipeline" || value === "auto"
						? value
						: "vlm";
					await this.plugin.saveSettings();
				}));
		const languageLabels: Record<string, string> = {
			en: "English",
			ch: "中文 + English",
			ch_server: "中文 / 繁体 / 日文",
			japan: "日本語",
			korean: "한국어",
			latin: "Latin 语系",
			arabic: "Arabic 语系",
			cyrillic: "Cyrillic 语系",
			devanagari: "Devanagari 语系",
		};
		new Setting(containerEl)
			.setName("文档语言")
			.setDesc("作为新任务默认值；英文论文建议选择 English。")
			.addDropdown((dropdown) => {
				MINERU_LANGUAGE_IDS.forEach((id) => dropdown.addOption(id, languageLabels[id] || id));
				dropdown.setValue(this.plugin.settings.mineruDefaultLanguage).onChange(async (value) => {
					this.plugin.settings.mineruDefaultLanguage = MINERU_LANGUAGE_IDS.includes(
						value as typeof MINERU_LANGUAGE_IDS[number],
					) ? value : "en";
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("默认附带原 PDF")
			.setDesc("支持双栏阅读、版面框定位和完整图重建，但会增加 Vault 占用。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.mineruDefaultIncludeSourcePdf)
				.onChange(async (value) => {
					this.plugin.settings.mineruDefaultIncludeSourcePdf = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("扫描件 OCR")
			.setDesc("仅扫描版或无文本层 PDF 建议默认开启。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.mineruDefaultOcr)
				.onChange(async (value) => {
					this.plugin.settings.mineruDefaultOcr = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("识别公式与表格")
			.setDesc("两个开关独立保存；默认均开启。")
			.addToggle((toggle) => toggle
				.setTooltip("公式识别")
				.setValue(this.plugin.settings.mineruDefaultFormula)
				.onChange(async (value) => {
					this.plugin.settings.mineruDefaultFormula = value;
					await this.plugin.saveSettings();
				}))
			.addToggle((toggle) => toggle
				.setTooltip("表格识别")
				.setValue(this.plugin.settings.mineruDefaultTable)
				.onChange(async (value) => {
					this.plugin.settings.mineruDefaultTable = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("提取超时（秒）")
			.setDesc("范围 60–1800 秒。")
			.addText((text) => text
				.setValue(String(this.plugin.settings.mineruDefaultTimeoutSeconds))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					this.plugin.settings.mineruDefaultTimeoutSeconds = Math.max(60, Math.min(1800, parsed));
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("初步文章 Wiki 来源")
			.setDesc("Auto 优先使用本次验证通过的 article.md，否则使用原 PDF。")
			.addDropdown((dropdown) => dropdown
				.addOption("auto", "Auto · 推荐")
				.addOption("article", "验证后的 article.md")
				.addOption("pdf", "原始 PDF")
				.setValue(this.plugin.settings.mineruDefaultArticleWikiSource)
				.onChange(async (value) => {
					this.plugin.settings.mineruDefaultArticleWikiSource = value === "article" || value === "pdf"
						? value
						: "auto";
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("每次确认远程上传")
			.setDesc("开启后，文献入库弹窗必须再次确认 PDF 将发送至配置的 MinerU 服务。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.mineruConfirmRemoteUpload)
				.onChange(async (value) => {
					this.plugin.settings.mineruConfirmRemoteUpload = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderReaderSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"文献阅读器",
			"指定默认接管的 Markdown 目录，并设置新打开阅读器的初始双栏状态。MinerU 包继续使用结构化图文与原 PDF；普通 Markdown 使用紧邻图片的图注。",
			true,
		);
		new Setting(containerEl)
			.setName("默认阅读目录")
			.setDesc("每行一个 Vault 相对目录。打开这些目录下的 Markdown 时，当前标签页会自动切换到文献阅读器；留空可关闭自动接管。")
			.addTextArea((textArea) => {
				textArea.inputEl.addClass("agent-dashboard-reader-folders-input");
				textArea
					.setPlaceholder("papers\nClippings")
					.setValue(this.plugin.settings.readerMarkdownFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.readerMarkdownFolders = normalizeReaderMarkdownFolders(value);
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("默认右栏模式")
			.setDesc("选择打开文章时优先显示原始 PDF 或图片与图注。")
			.addDropdown((dropdown) => dropdown
				.addOption("pdf", "原始 PDF")
				.addOption("visuals", "图片与图注")
				.setValue(this.plugin.settings.mineruReaderDefaultMode)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderDefaultMode = value === "visuals" ? "visuals" : "pdf";
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("原始 PDF 跟随正文页")
			.setDesc("新阅读器默认根据左侧正文最上方内容同步到对应 PDF 页。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.mineruReaderFollowPdfReading)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderFollowPdfReading = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("图片与图注跟随正文图")
			.setDesc("新阅读器默认根据正文图锚点切换右侧图片。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.mineruReaderFollowVisualReading)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderFollowVisualReading = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("默认显示版面框")
			.setDesc("在原始 PDF 上显示 MinerU 文本、图像和图注定位框。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.mineruReaderShowLayoutBoxes)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderShowLayoutBoxes = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("默认 PDF 缩放")
			.setDesc("40%–400%；100% 表示适合宽度基准。")
			.addSlider((slider) => slider
				.setLimits(0.4, 2, 0.1)
				.setDynamicTooltip()
				.setValue(this.plugin.settings.mineruReaderPdfZoom)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderPdfZoom = Math.max(0.4, Math.min(4, value));
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("Markdown 栏宽度")
			.setDesc("双栏中左侧 Markdown 的初始比例，范围 42%–78%。")
			.addSlider((slider) => slider
				.setLimits(0.42, 0.78, 0.02)
				.setDynamicTooltip()
				.setValue(this.plugin.settings.mineruReaderSplitRatio)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderSplitRatio = Math.max(0.42, Math.min(0.78, value));
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("PDF 渲染质量")
			.setDesc("高清模式提高 Canvas 像素密度，文字和图表更清晰，但占用更多显存。")
			.addDropdown((dropdown) => dropdown
				.addOption("standard", "标准")
				.addOption("high", "高清")
				.setValue(this.plugin.settings.mineruReaderRenderQuality)
				.onChange(async (value) => {
					this.plugin.settings.mineruReaderRenderQuality = value === "high" ? "high" : "standard";
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("图像重建策略")
			.setDesc("当前保持代码规则的保守策略：只自动采用具有版面证据且通过契约验证的重建结果。原始正则和坐标阈值不开放，避免降低泛化能力。")
	}

	private getActionDefault(actionId: string): ActionExecutionDefault {
		return this.plugin.settings.actionExecutionDefaults[actionId]
			|| { ...DEFAULT_ACTION_EXECUTION_DEFAULTS[actionId] };
	}

	/**
	 * Models the current backend actually recognizes: the built-in catalog
	 * and/or CLI discovery, plus any custom model configured for that
	 * backend. Used instead of a free-text override field.
	 */
	private actionModelChoices(backend: CliBackendId): Array<{ id: string; label: string }> {
		const discovered = (this.plugin.getCliModelDiscovery(backend)?.models || [])
			.map((model) => ({ id: model.id, label: model.label }));
		const configuredModel = backend === "claude-code"
			? this.plugin.settings.claudeModel
			: backend === "opencode"
				? this.plugin.settings.openCodeModel
				: this.plugin.settings.codexModel;
		const base = backend === "codex-cli" && this.plugin.settings.codexConfigSource !== "cc-switch"
			? MODEL_OPTIONS.map((option) => ({ id: option.id, label: option.label }))
			: discovered;
		const seen = new Set<string>();
		const choices: Array<{ id: string; label: string }> = [];
		for (const choice of base) {
			if (!choice.id || seen.has(choice.id)) continue;
			seen.add(choice.id);
			choices.push(choice);
		}
		if (configuredModel && !seen.has(configuredModel)) {
			choices.push({ id: configuredModel, label: configuredModel });
		}
		return choices;
	}

	private renderTaskDefaultsSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"任务默认策略",
			"为常用 AI 操作设置默认值。运行弹窗中的临时选择仍具有最高优先级。",
			true,
		);
		const actions = CONFIGURABLE_ACTION_IDS
			.map((id) => ACTIONS.find((action) => action.id === id))
			.filter((action): action is DashboardAction => Boolean(action));
		actions.forEach((action) => {
			const value = this.getActionDefault(action.id);
			const isPaperIngest = action.id === "paper-ingest";
			this.createProviderSectionHeader(
				containerEl,
				action.label,
				isPaperIngest
					? "两种运行方式：轻量 Agent · Direct API（无需编码 Agent，轮数与 Token 上限在 Direct API 页配置）和 Codex CLI · 完整入库（登记 papers.csv/references.bib/索引）。下面的模型/推理/速度默认值作用于 Codex CLI 方式。"
					: STAGE_WRITE_BACKEND_ACTION_IDS.has(action.id)
						? "可选择受阶段写入边界约束的 Agent；运行前仍可修改。"
						: "该操作固定使用 Codex CLI 权限边界；可覆盖模型、推理和速度。",
			);
			if (isPaperIngest) {
				new Setting(containerEl)
					.setName("默认运行方式")
					.setDesc("任务弹窗将按此预选运行方式；弹窗内仍可临时切换。「自动」在有已通过连接测试的 Direct API 配置时优先轻量 Agent。")
					.addDropdown((dropdown) => dropdown
						.addOption("auto", "自动（优先轻量 Agent）")
						.addOption("light", "轻量 Agent · Direct API")
						.addOption("cli", "Codex CLI · 完整入库")
						.setValue(value.runner)
						.onChange(async (runner) => {
							value.runner = runner === "light" || runner === "cli" ? runner : "auto";
							await this.plugin.saveSettings();
						}));
			}
			if (STAGE_WRITE_BACKEND_ACTION_IDS.has(action.id)) {
				new Setting(containerEl)
					.setName("默认执行后端")
					.setDesc("未配置的后端仍会显示，但不能在任务弹窗中启动。")
					.addDropdown((dropdown) => dropdown
						.addOption("codex-cli", "Codex CLI")
						.addOption("claude-code", this.plugin.isCliBackendAvailable("claude-code") ? "Claude Code" : "Claude Code · 未配置")
						.addOption("opencode", this.plugin.isCliBackendAvailable("opencode") ? "OpenCode" : "OpenCode · 未配置")
						.setValue(value.backend)
						.onChange(async (backend) => {
							value.backend = backend === "claude-code" || backend === "opencode" ? backend : "codex-cli";
							value.model = "";
							value.serviceTier = "default";
							await this.plugin.saveSettings();
							this.display();
						}));
			}
			const modelChoices = this.actionModelChoices(value.backend);
			const knownModel = value.model && modelChoices.some((choice) => choice.id === value.model);
			new Setting(containerEl)
				.setName("模型覆盖")
				.setDesc("从当前后端识别到的模型中选择；留空使用动作推荐模型或后端全局默认模型。")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "使用推荐默认");
					modelChoices.forEach((choice) => dropdown.addOption(choice.id, choice.label));
					if (value.model && !knownModel) {
						dropdown.addOption(value.model, `${value.model}（自定义）`);
					}
					dropdown.setValue(value.model).onChange(async (model) => {
						value.model = model.trim().slice(0, 200);
						await this.plugin.saveSettings();
					});
				});
			new Setting(containerEl)
				.setName("默认推理强度")
				.setDesc("任务弹窗选择优先；这里控制无临时覆盖时的默认值。")
				.addDropdown((dropdown) => {
					REASONING_OPTIONS.forEach((option) => dropdown.addOption(option.id, option.label));
					dropdown.setValue(value.reasoningEffort || action.reasoningEffort || "medium")
						.onChange(async (reasoning) => {
							value.reasoningEffort = reasoning as ActionExecutionDefault["reasoningEffort"];
							await this.plugin.saveSettings();
						});
				});
			if (value.backend === "codex-cli") {
				new Setting(containerEl)
					.setName("默认速度")
					.setDesc("Fast 仅在当前模型支持时生效，否则自动回退标准速度。")
					.addDropdown((dropdown) => dropdown
						.addOption("default", "标准")
						.addOption("fast", "Fast")
						.setValue(value.serviceTier)
						.onChange(async (tier) => {
							value.serviceTier = tier === "fast" ? "fast" : "default";
							await this.plugin.saveSettings();
						}));
			}
			new Setting(containerEl)
				.setName("恢复该操作默认值")
				.addButton((button) => button.setButtonText("恢复").onClick(async () => {
					this.plugin.settings.actionExecutionDefaults[action.id] = {
						...DEFAULT_ACTION_EXECUTION_DEFAULTS[action.id],
					};
					await this.plugin.saveSettings();
					this.display();
				}));
		});

		this.createProviderSectionHeader(
			containerEl,
			"查询侧边栏",
			"只影响新建对话；已有对话继续保留自己的检索模式和后端。",
		);
		new Setting(containerEl)
			.setName("新对话默认检索模式")
			.setDesc("联网模式仅适用于 Agent；Direct API 会自动限制为知识库。")
			.addDropdown((dropdown) => dropdown
				.addOption("web", "联网检索")
				.addOption("vault", "仅知识库")
				.setValue(this.plugin.settings.queryDefaultRetrievalMode)
				.onChange(async (mode) => {
					this.plugin.settings.queryDefaultRetrievalMode = mode === "vault" ? "vault" : "web";
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("新对话默认后端")
			.setDesc("可选择 Agent 或已通过连接测试的 Direct API。")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("codex-cli", "Agent · Codex CLI")
					.addOption("claude-code", "Agent · Claude Code")
					.addOption("opencode", "Agent · OpenCode");
				this.plugin.settings.providerProfiles
					.filter((profile) => profile.lastTest?.ok)
					.forEach((profile) => dropdown.addOption(profile.id, `Direct API · ${profile.name}`));
				dropdown.setValue(this.plugin.settings.queryDefaultBackendId).onChange(async (backendId) => {
					this.plugin.settings.queryDefaultBackendId = backendId;
					await this.plugin.saveSettings();
				});
			});
	}

	private renderDataSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"数据与诊断",
			"管理本地历史保留、请求超时和脱敏诊断；不会修改论文原文包。",
			true,
		);
		new Setting(containerEl)
			.setName("Direct API 超时（秒）")
			.setDesc("连接测试和普通请求的基础超时，范围 3–120 秒。")
			.addText((text) => text
				.setValue(String(this.plugin.settings.providerTimeoutSeconds))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					this.plugin.settings.providerTimeoutSeconds = Math.max(3, Math.min(120, parsed));
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("任务历史保留数量")
			.setDesc("选择 5–100 条；缩减数量会安全回收超出的已结束任务输出，正在运行的任务会保留。")
			.addDropdown((dropdown) => {
				const current = this.plugin.settings.taskHistoryLimit;
				const options = [...new Set([5, 10, 20, 30, 50, 100, current])]
					.sort((left, right) => left - right);
				for (const option of options) dropdown.addOption(String(option), `${option} 条`);
				dropdown.setValue(String(current)).onChange(async (value) => {
					try {
						await this.plugin.setTaskHistoryLimit(Number.parseInt(value, 10));
					} catch (error) {
						dropdown.setValue(String(this.plugin.settings.taskHistoryLimit));
						new Notice(error instanceof Error ? error.message : String(error));
					}
				});
			});
		new Setting(containerEl)
			.setName("查询会话保留数量")
			.setDesc("范围 1–30。")
			.addText((text) => text
				.setValue(String(this.plugin.settings.querySessionLimit))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					this.plugin.settings.querySessionLimit = Math.max(1, Math.min(30, parsed));
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName("每个会话保留消息数")
			.setDesc("范围 10–100；限制本地持久化体积，不改变当前回答上下文裁剪规则。")
			.addText((text) => text
				.setValue(String(this.plugin.settings.queryMessageLimit))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (!Number.isFinite(parsed)) return;
					this.plugin.settings.queryMessageLimit = Math.max(10, Math.min(100, parsed));
					await this.plugin.saveSettings();
				}));

		this.createProviderSectionHeader(
			containerEl,
			"问答笔记",
			"回答可一键落为 Markdown 笔记（frontmatter + 来源回链）；目录在全 Vault 内解析。",
		);
		new Setting(containerEl)
			.setName("笔记目录")
			.setDesc("Vault 相对目录，默认 wiki/qa。留空时回退到默认值，路径不会超出当前 Vault。")
			.addText((text) =>
				text
					.setPlaceholder("wiki/qa")
					.setValue(this.plugin.settings.queryNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.queryNotesFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		this.createProviderSectionHeader(
			containerEl,
			"知识库维护范围",
			"核心范围由项目契约固定，避免用户设置造成原文包污染或跨目录链接冲突。",
		);
		new Setting(containerEl)
			.setName("体检范围")
			.setDesc("内置只读体检检查 wiki/ 与 Vault 顶层 Markdown。papers/、Clippings/ 不参与断链、孤立页、属性和内容检查，仅检查跨根链接边界；papers/、wiki/、Clippings/ 三个主目录之间禁止创建 Obsidian 或 Markdown 链接。核心规则不可关闭。");

		this.createProviderSectionHeader(
			containerEl,
			"清理与诊断",
			"诊断内容不包含 API Key、MinerU Token、对话正文或论文内容。",
		);
		new Setting(containerEl)
			.setName("清理本地历史")
			.setDesc("任务清理只移除已结束记录及其已登记输出；早期版本遗留且未被历史引用的 Toolkit 输出不会自动删除。查询清理会新建一个空白对话。")
			.addButton((button) => button.setButtonText("清理已完成任务").onClick(async () => {
				try {
					const count = await this.plugin.clearCompletedTaskHistory();
					new Notice(`已清理 ${count} 条已完成任务记录及其输出文件。`);
				} catch (error) {
					new Notice(error instanceof Error ? error.message : String(error));
				}
			}))
			.addButton((button) => button.setButtonText("重置查询历史").setWarning().onClick(async () => {
				if (!window.confirm("重置全部查询历史？此操作不会删除知识库文件。")) return;
				await this.plugin.resetQueryHistory();
				new Notice("查询历史已重置。");
			}));
		new Setting(containerEl)
			.setName("脱敏诊断")
			.setDesc("复制插件版本、运行环境、CLI 检测来源和功能范围，不复制密钥或正文。")
			.addButton((button) => button.setButtonText("复制诊断信息").onClick(async () => {
				await navigator.clipboard.writeText(this.plugin.buildDiagnosticsSummary());
				new Notice("脱敏诊断已复制到剪贴板。");
			}));
	}

	private renderCodexSettings(containerEl: HTMLElement): void {
		const configSource = this.plugin.settings.codexConfigSource;
		const sourceLabel = getCodexConfigSourceLabel(configSource);
		this.createSettingsPageHeader(
			containerEl,
			"Codex CLI",
			"选择官方 OpenAI Codex 或 CC Switch 当前配置；两种模式共用相同的项目权限边界。",
			true,
		);
		new Setting(containerEl)
			.setName("配置来源")
			.setDesc(
				configSource === "cc-switch"
					? "沿用 CC Switch 写入 ~/.codex/config.toml 的 provider、endpoint、模型和认证配置。"
					: "显式使用 OpenAI provider，并使用 Dashboard 的官方 Codex 模型策略。",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("official", "官方 Codex CLI")
					.addOption("cc-switch", "CC Switch")
					.setValue(configSource)
					.onChange(async (value) => {
						this.plugin.settings.codexConfigSource = value === "cc-switch"
							? "cc-switch"
							: "official";
						this.plugin.invalidateCliModelDiscovery("codex-cli");
						this.plugin.providerRuntimeState.delete("codex-cli");
						await this.plugin.saveSettings();
						this.display();
					})
			);
		if (configSource === "cc-switch") {
			this.createProviderSectionHeader(
				containerEl,
				"CC Switch 配置",
				"插件不改写 config.toml，只读取当前激活的 provider 和模型；切换供应商后重新测试连接即可。",
			);
			new Setting(containerEl)
				.setName("模型与供应商")
				.setDesc("由 CC Switch 当前激活配置管理。Dashboard 不保存第三方 endpoint 或 API Key。");
		} else {
			this.createProviderSectionHeader(
				containerEl,
				"官方 Codex 配置",
				"每次调用显式覆盖 model_provider=openai；按钮级默认、全局回退和运行前临时覆盖只使用官方账号可用模型。",
			);
			new Setting(containerEl)
				.setName("全局默认模型")
				.setDesc("没有按钮级模型配置的 Dashboard AI 任务使用该模型。")
				.addText((text) =>
					text
						.setPlaceholder("输入当前 Codex 账号可用的模型 ID")
						.setValue(this.plugin.settings.codexModel)
						.onChange(async (value) => {
							this.plugin.settings.codexModel = value.trim() || DEFAULT_SETTINGS.codexModel;
							this.plugin.invalidateCliModelDiscovery("codex-cli");
							await this.plugin.saveSettings();
						})
				);
			new Setting(containerEl)
				.setName("全局默认推理强度")
				.setDesc("仅在按钮没有指定推理强度时使用；按钮默认值和本次运行覆盖优先。")
				.addDropdown((dropdown) => {
					REASONING_OPTIONS.forEach((option) => dropdown.addOption(option.id, option.label));
					dropdown
						.setValue(this.plugin.settings.codexReasoningEffort)
						.onChange(async (value) => {
							this.plugin.settings.codexReasoningEffort = value;
							await this.plugin.saveSettings();
						});
				});
		}
		this.createProviderSectionHeader(
			containerEl,
			"模型调用",
			`${sourceLabel}。写入型 Dashboard 任务仍由项目沙箱和 skill 阶段边界约束。`,
		);
		const codexResult = this.plugin.providerRuntimeState.get("codex-cli") || null;
		new Setting(containerEl)
			.setName(sourceLabel)
			.setDesc(
				configSource === "official"
					? "验证 Codex CLI 和官方 OpenAI 配置；不发送 Vault 内容。"
					: "验证 Codex CLI 和 CC Switch 当前配置；不发送 Vault 内容。",
			)
			.addButton((button) => {
				const testing = codexResult?.status === "testing";
				button
					.setButtonText(testing ? "测试中…" : "测试连接")
					.setDisabled(testing)
					.onClick(async () => {
						this.plugin.providerRuntimeState.set("codex-cli", { status: "testing" });
						this.display();
						const result = await this.plugin.testProviderConnection("codex-cli");
						this.plugin.providerRuntimeState.set("codex-cli", { status: "done", result });
						this.display();
					});
			});
		if (codexResult?.result) this.renderConnectionResult(containerEl, codexResult.result);
	}

	private renderClaudeSettings(containerEl: HTMLElement): void {
		const configSource = this.plugin.settings.claudeConfigSource;
		const sourceLabel = getClaudeConfigSourceLabel(configSource);
		const defaultModelLabel = getClaudeDefaultModelLabel(configSource);
		this.createSettingsPageHeader(
			containerEl,
			"Claude Code",
			"选择 Claude Code 的配置来源。官方配置与 CC Switch 共用权限边界，但分别加载独立的模型和 endpoint 设置。",
			true,
		);
		new Setting(containerEl)
			.setName("配置来源")
			.setDesc(
				configSource === "cc-switch"
					? "加载用户级 Claude 设置，跟随 CC Switch 写入的模型和兼容 endpoint。"
					: "忽略用户级 Claude 设置中的代理模型映射，使用官方 Claude Code 认证、模型和服务。",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("official", "官方 Claude Code")
					.addOption("cc-switch", "CC Switch")
					.setValue(configSource)
					.onChange(async (value) => {
						this.plugin.settings.claudeConfigSource = value === "cc-switch"
							? "cc-switch"
							: "official";
						this.plugin.invalidateCliModelDiscovery("claude-code");
						this.plugin.providerRuntimeState.delete("claude-code");
						await this.plugin.saveSettings();
						this.display();
					})
			);
		this.createProviderSectionHeader(
			containerEl,
			`${sourceLabel} 配置`,
			configSource === "cc-switch"
				? "CC Switch 模式加载 user、project 和 local 设置；空模型值跟随 CC Switch 当前选择。"
				: "官方模式只加载 project 和 local 设置，避免用户级兼容 endpoint 覆盖官方服务；空模型值使用 Claude CLI 默认模型。",
		);
		new Setting(containerEl)
			.setName("模型覆盖")
			.setDesc(`留空时使用${defaultModelLabel}；填写后仅覆盖 Dashboard 发起的 Claude Code 任务。`)
			.addText((text) =>
				text
					.setPlaceholder(`留空使用${defaultModelLabel}`)
					.setValue(this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						this.plugin.settings.claudeModel = value.trim();
						this.plugin.invalidateCliModelDiscovery("claude-code");
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("默认推理强度")
			.setDesc("用于 Claude Code 的检索、批注解释、代码分析和综合分析。")
			.addDropdown((dropdown) => {
				REASONING_OPTIONS.forEach((option) => dropdown.addOption(option.id, option.label));
				dropdown
					.setValue(this.plugin.settings.claudeReasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.claudeReasoningEffort = value;
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("查询图片")
			.setDesc(
				`知识库查询可发送最多 ${MAX_QUERY_IMAGE_ATTACHMENTS} 张 Vault 图片。插件只传递经过校验的本地路径，Claude Code 使用只读 Read 工具打开图片；实际视觉能力取决于当前模型。`,
			);
		this.createProviderSectionHeader(
			containerEl,
			"只读执行边界",
			"连接测试不发送 Vault 内容。检索只开放 Read、Glob 和 Grep；批注解释不开放任何工具。",
		);
		const resultState = this.plugin.providerRuntimeState.get("claude-code") || null;
		new Setting(containerEl)
			.setName(sourceLabel)
			.setDesc(
				configSource === "cc-switch"
					? "验证 CLI、CC Switch 当前模型、JSONL 输出和兼容 endpoint。"
					: "验证 CLI、官方认证、当前模型和 JSONL 输出。",
			)
			.addButton((button) => {
				const testing = resultState?.status === "testing";
				button
					.setButtonText(testing ? "测试中…" : "测试连接")
					.setDisabled(testing)
					.onClick(async () => {
						this.plugin.providerRuntimeState.set("claude-code", { status: "testing" });
						this.display();
						const result = await this.plugin.testProviderConnection("claude-code");
						this.plugin.providerRuntimeState.set("claude-code", { status: "done", result });
						this.display();
					});
			});
		if (resultState?.result) {
			this.renderConnectionResult(containerEl, resultState.result);
		}
	}

	private renderOpenCodeSettings(containerEl: HTMLElement): void {
		const configSource = this.plugin.settings.openCodeConfigSource;
		const sourceLabel = getOpenCodeConfigSourceLabel(configSource);
		const defaultModelLabel = getOpenCodeDefaultModelLabel(configSource);
		this.createSettingsPageHeader(
			containerEl,
			"OpenCode",
			"选择官方 OpenCode Zen 或 CC Switch 当前配置。两种来源共用 Dashboard 的只读和阶段所有权写入边界。",
			true,
		);
		new Setting(containerEl)
			.setName("配置来源")
			.setDesc(
				configSource === "cc-switch"
					? "沿用 CC Switch 管理的 OpenCode provider、endpoint、模型和认证配置。"
					: "显式使用 OpenCode Zen 模型；凭据仍由 OpenCode auth 管理，插件不保存 API Key。",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("official", "官方 OpenCode Zen")
					.addOption("cc-switch", "CC Switch")
					.setValue(configSource)
					.onChange(async (value) => {
						this.plugin.settings.openCodeConfigSource = value === "cc-switch"
							? "cc-switch"
							: "official";
						if (value === "cc-switch") {
							this.plugin.settings.openCodeModel = "";
						} else if (!this.plugin.settings.openCodeModel) {
							this.plugin.settings.openCodeModel = DEFAULT_SETTINGS.openCodeModel;
						}
						this.plugin.invalidateCliModelDiscovery("opencode");
						this.plugin.providerRuntimeState.delete("opencode");
						await this.plugin.saveSettings();
						this.display();
					})
			);
		this.createProviderSectionHeader(
			containerEl,
			`${sourceLabel} 配置`,
			configSource === "cc-switch"
				? "空模型值跟随 CC Switch 当前选择；也可为 Dashboard 任务设置临时模型覆盖。"
				: "官方模式默认使用 OpenCode Zen 免费模型。免费可用性和限额以 OpenCode 当前账号与模型目录为准。",
		);
		const discovery = this.plugin.getCliModelDiscovery("opencode");
		const models = discovery?.models || [];
		new Setting(containerEl)
			.setName(configSource === "official" ? "默认模型" : "模型覆盖")
			.setDesc(
				discovery
					? `模型来源：${discovery.source}${discovery.complete ? "" : "（回退列表）"}`
					: `留空时使用${defaultModelLabel}；点击右侧按钮可读取 OpenCode 模型目录。`,
			)
			.addDropdown((dropdown) => {
				dropdown.addOption(
					"",
					configSource === "cc-switch"
						? `使用后端默认 · ${discovery?.effectiveModel || "CC Switch 当前模型"}`
						: `使用官方默认 · ${discovery?.effectiveModel || DEFAULT_SETTINGS.openCodeModel}`,
				);
				models.forEach((model) => {
					dropdown.addOption(
						model.id,
						model.description ? `${model.label} · ${model.description}` : model.label,
					);
				});
				const selected = this.plugin.settings.openCodeModel;
				if (selected && !models.some((model) => model.id === selected)) {
					dropdown.addOption(selected, `${selected} · 已保存`);
				}
				dropdown
					.setValue(selected)
					.onChange(async (value) => {
						this.plugin.settings.openCodeModel = value;
						await this.plugin.saveSettings();
					});
			})
			.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip("重新识别 OpenCode 模型")
					.onClick(async () => {
						await this.plugin.discoverCliModels("opencode", true);
						this.display();
					})
			);
		new Setting(containerEl)
			.setName("默认推理强度")
			.setDesc("映射到 OpenCode 的 provider-specific variant；模型不支持时可能由 provider 忽略或报错。")
			.addDropdown((dropdown) => {
				REASONING_OPTIONS.forEach((option) => dropdown.addOption(option.id, option.label));
				dropdown
					.setValue(this.plugin.settings.openCodeReasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.openCodeReasoningEffort = value;
						await this.plugin.saveSettings();
					});
			});
		this.createProviderSectionHeader(
			containerEl,
			"执行边界",
			"检索只允许读取 Vault；联网模式才开放 websearch/webfetch。代码分析和综合分析可写入阶段目录，并由宿主审计、验证和失败回滚。",
		);
		const resultState = this.plugin.providerRuntimeState.get("opencode") || null;
		new Setting(containerEl)
			.setName(sourceLabel)
			.setDesc(
				"通过统一 Python runner 执行不含 Vault 内容的最小 JSONL 请求，验证 CLI、认证、模型和输出协议。",
			)
			.addButton((button) => {
				const testing = resultState?.status === "testing";
				button
					.setButtonText(testing ? "测试中…" : "测试连接")
					.setDisabled(testing)
					.onClick(async () => {
						this.plugin.providerRuntimeState.set("opencode", { status: "testing" });
						this.display();
						const result = await this.plugin.testProviderConnection("opencode");
						this.plugin.providerRuntimeState.set("opencode", { status: "done", result });
						this.display();
					});
			});
		if (resultState?.result) this.renderConnectionResult(containerEl, resultState.result);
		if (!discovery) {
			void this.plugin.discoverCliModels("opencode")
				.then(() => {
					if (this.activePage === "opencode") this.display();
				})
				.catch(() => undefined);
		}
	}

	private renderAnnotationSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"批注 AI",
			"普通解释可自由选择 Agent 或 Direct API；启用浅层联网后仅使用 Agent，始终不写入文件。",
			true,
		);
		new Setting(containerEl)
			.setName("划选批注入口")
			.setDesc("默认入口：在任意 Markdown 视图（阅读器、阅读模式、实时预览）划选文字，点击选区旁的浮动「批注」圆标即可弹出批注方式选择。也可以为「批注所选文字」命令绑定自定义快捷键（如 Shift+S），划选后按键弹出同样的选择。")
			.addButton((button) => button
				.setButtonText("打开快捷键设置")
				.onClick(() => {
					const settingRoot = (this.app as unknown as {
						setting?: {
							open?: () => void;
							openTabById?: (id: string) => void;
						};
					}).setting;
					try {
						settingRoot?.open?.();
						settingRoot?.openTabById?.("hotkeys");
						new Notice("在快捷键列表中搜索「批注所选文字」进行绑定");
					} catch {
						new Notice("请手动前往 设置 → 快捷键，搜索「批注所选文字」绑定");
					}
				}));
		const verifiedProfiles = this.plugin.settings.providerProfiles.filter(
			(profile) => profile.lastTest?.ok,
		);
		const backendId = this.plugin.settings.annotationBackendId || "auto";
		new Setting(containerEl)
			.setName("执行后端")
			.setDesc(
				this.plugin.settings.annotationWebSearchEnabled
					? "联网解释仅使用 Agent；自动模式使用 Codex CLI。"
					: "普通解释可自由选择 Agent 或已验证的 Direct API；自动模式优先使用默认 Direct API。",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("auto", "自动选择")
					.addOption("codex-cli", "Agent · Codex CLI")
					.addOption("claude-code", "Agent · Claude Code")
					.addOption("opencode", "Agent · OpenCode");
				verifiedProfiles.forEach((profile) => {
					dropdown.addOption(profile.id, `Direct API · ${profile.name}`);
					const option = dropdown.selectEl.options[
						dropdown.selectEl.options.length - 1
					];
					if (option) option.disabled = this.plugin.settings.annotationWebSearchEnabled;
				});
				dropdown
					.setValue(backendId)
					.onChange(async (value) => {
						this.plugin.settings.annotationBackendId = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});
		this.renderAnnotationWebSearchSettings(containerEl, backendId);

		if (backendId === "auto") {
			const activeProfile = verifiedProfiles.find(
				(profile) => profile.id === this.plugin.settings.activeProviderId,
			);
			new Setting(containerEl)
				.setName("自动选择顺序")
				.setDesc(
					this.plugin.settings.annotationWebSearchEnabled
						? "联网解释固定使用 Codex CLI；关闭联网后恢复 Direct API 优先。"
					: activeProfile
						? `使用 Direct API“${activeProfile.name}”（${activeProfile.model}）；若以后停用该配置，则使用下方 Codex 回退参数。`
						: "当前没有启用且已验证的 Direct API，将直接使用下方 Codex 回退参数。",
				);
			this.renderAnnotationCliSettings(containerEl, "codex-cli", true);
			this.renderAnnotationTokenSetting(
				containerEl,
				Boolean(activeProfile) && !this.plugin.settings.annotationWebSearchEnabled,
			);
			return;
		}

		if (backendId === "codex-cli" || backendId === "claude-code" || backendId === "opencode") {
			this.renderAnnotationCliSettings(containerEl, backendId);
			return;
		}

		const profile = verifiedProfiles.find((item) => item.id === backendId);
		if (!profile) {
			new Setting(containerEl)
				.setName("配置不可用")
				.setDesc("所选 Direct API 未通过连接测试，保存后会自动回退到“自动选择”。");
			return;
		}
		this.createProviderSectionHeader(
			containerEl,
			"Direct API 参数",
			"批注解释使用该配置保存的模型和 endpoint；如需更换供应商模型，请进入 Direct API 页面修改配置。",
		);
		new Setting(containerEl)
			.setName("模型")
			.setDesc(`${profile.name} · ${profile.model || "未选择模型"}`)
			.addButton((button) =>
				button
					.setButtonText("编辑配置")
					.onClick(() => {
						this.plugin.providerEditorProfileId = profile.id;
						this.activePage = "direct-api";
						this.display();
					})
			);
		this.renderAnnotationTokenSetting(containerEl, true);
	}

	private renderAnnotationWebSearchSettings(
		containerEl: HTMLElement,
		backendId: string,
	): void {
		new Setting(containerEl)
			.setName("浅层联网解释")
			.setDesc(
				"关闭时可使用 Direct API 或 Agent。启用后仅使用 Agent，最多围绕 2 个检索问题、采用不超过 3 个权威来源，不追踪二级链接。",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.annotationWebSearchEnabled)
					.onChange(async (value) => {
						this.plugin.settings.annotationWebSearchEnabled = value;
						const directBackendSelected = value
							&& !["auto", "codex-cli", "claude-code", "opencode"].includes(backendId);
						if (directBackendSelected) {
							const profile = this.plugin.getProviderProfile(backendId);
							const nativeCapable = Boolean(
								profile
								&& (profile.webSearch || "auto") !== "off"
								&& detectNativeWebSearchProtocol(profile.baseUrl),
							);
							if (!nativeCapable) {
								this.plugin.settings.annotationBackendId = "codex-cli";
								new Notice("该 Direct API 供应商不支持原生联网，批注后端已切换为 Codex CLI");
							}
						}
						await this.plugin.saveSettings();
						this.display();
					})
			);
		if (!this.plugin.settings.annotationWebSearchEnabled) return;

		const timeoutSetting = new Setting(containerEl)
			.setName("联网时间上限")
			.setDesc(
				`仅限制单次批注解释的联网与生成总时间。当前：${this.plugin.settings.annotationWebSearchTimeoutSeconds} 秒。`,
			)
			.addSlider((slider) =>
				slider
					.setLimits(15, 45, 5)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.annotationWebSearchTimeoutSeconds)
					.onChange(async (value) => {
						this.plugin.settings.annotationWebSearchTimeoutSeconds = value;
						timeoutSetting.setDesc(`仅限制单次批注解释的联网与生成总时间。当前：${value} 秒。`);
						await this.plugin.saveSettings();
					})
			);
		timeoutSetting.settingEl.addClass("agent-dashboard-provider-setting-emphasis");

		new Setting(containerEl)
			.setName("搜索深度")
			.setDesc("固定为浅层：Agent 仅临时开放联网工具，并受上述总时间限制。")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("shallow", "浅层（固定）")
					.setValue("shallow")
					.setDisabled(true)
			);
	}

	private renderAnnotationCliSettings(
		containerEl: HTMLElement,
		backendId: CliBackendId,
		isFallback = false,
	): void {
		const isClaude = backendId === "claude-code";
		const isOpenCode = backendId === "opencode";
		const usesCodexSwitch = backendId === "codex-cli"
			&& this.plugin.settings.codexConfigSource === "cc-switch";
		const title = isFallback
			? "Codex 回退参数"
			: `${getCliBackendLabel(backendId)} 参数`;
		this.createProviderSectionHeader(
			containerEl,
			title,
			isClaude
				? `模型留空时使用${getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)}；Claude Code 批注不开放任何工具。`
				: isOpenCode
					? `模型留空时使用${getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)}；OpenCode 批注使用 no-tools 权限配置。`
				: usesCodexSwitch
					? "模型留空时沿用 CC Switch 当前 Codex 配置；快速模式仅在显式模型支持时生效。"
					: "模型留空时使用批注动作默认模型；快速模式仅对支持该服务档位的模型生效。",
		);
		const discovery = this.plugin.getCliModelDiscovery(backendId);
		const selectedModel = isClaude
			? this.plugin.settings.annotationClaudeModel
			: isOpenCode
				? this.plugin.settings.annotationOpenCodeModel
				: this.plugin.settings.annotationCodexModel;
		const models = discovery?.models || (
			isClaude || isOpenCode
				? []
				: MODEL_OPTIONS.map((option) => ({
					id: option.id,
					label: option.label,
					description: option.description,
					supportsFast: option.supportsFast,
				}))
		);
		new Setting(containerEl)
			.setName("模型")
			.setDesc(
				discovery
					? `模型来源：${discovery.source}${discovery.complete ? "" : "（候选列表可能不完整）"}`
					: "正在识别当前后端模型；也可先使用后端默认值。",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption(
					"",
					isClaude
						? `使用后端默认 · ${discovery?.effectiveModel || getClaudeDefaultModelLabel(this.plugin.settings.claudeConfigSource)}`
						: isOpenCode
							? `使用后端默认 · ${discovery?.effectiveModel || getOpenCodeDefaultModelLabel(this.plugin.settings.openCodeConfigSource)}`
						: usesCodexSwitch
							? `使用后端默认 · ${discovery?.effectiveModel || "CC Switch 当前模型"}`
							: "使用批注默认模型",
				);
				models.forEach((model) => {
					dropdown.addOption(
						model.id,
						model.description
							? `${model.label} · ${model.description}`
							: model.label,
					);
				});
				if (selectedModel && !models.some((model) => model.id === selectedModel)) {
					dropdown.addOption(selectedModel, `${selectedModel} · 已保存的自定义模型`);
				}
				dropdown
					.setValue(selectedModel)
					.onChange(async (value) => {
						if (isClaude) {
							this.plugin.settings.annotationClaudeModel = value;
						} else if (isOpenCode) {
							this.plugin.settings.annotationOpenCodeModel = value;
						} else {
							this.plugin.settings.annotationCodexModel = value;
							if (
								this.plugin.settings.annotationCodexServiceTier === "fast"
								&& !this.plugin.supportsFast(value || this.plugin.settings.codexModel)
							) {
								this.plugin.settings.annotationCodexServiceTier = "default";
							}
						}
						await this.plugin.saveSettings();
						this.display();
					});
			})
			.addExtraButton((button) =>
				button
					.setIcon("refresh-cw")
					.setTooltip("重新识别模型")
					.onClick(async () => {
						await this.plugin.discoverCliModels(backendId, true);
						this.display();
					})
			);

		const reasoningValue = isClaude
			? this.plugin.settings.annotationClaudeReasoningEffort
			: isOpenCode
				? this.plugin.settings.annotationOpenCodeReasoningEffort
				: this.plugin.settings.annotationCodexReasoningEffort;
		new Setting(containerEl)
			.setName("推理强度")
			.setDesc("仅影响批注解释，不改变查询、深读或综合分析任务。")
			.addDropdown((dropdown) => {
				REASONING_OPTIONS.forEach((option) => dropdown.addOption(option.id, option.label));
				dropdown
					.setValue(reasoningValue)
					.onChange(async (value) => {
						if (isClaude) {
							this.plugin.settings.annotationClaudeReasoningEffort = value;
						} else if (isOpenCode) {
							this.plugin.settings.annotationOpenCodeReasoningEffort = value;
						} else {
							this.plugin.settings.annotationCodexReasoningEffort = value;
						}
						await this.plugin.saveSettings();
					});
			});

		if (!isClaude && !isOpenCode) {
			const effectiveModel = selectedModel || this.plugin.settings.codexModel;
			const fastSupported = this.plugin.supportsFast(effectiveModel);
			new Setting(containerEl)
				.setName("速度")
				.setDesc(
					fastSupported
						? "标准为默认速度；快速模式可能增加用量。"
						: "当前模型未声明支持快速服务档位。",
				)
				.addDropdown((dropdown) => {
					dropdown
						.addOption("default", "标准")
						.addOption("fast", "快速")
						.setValue(
							fastSupported
								? this.plugin.settings.annotationCodexServiceTier
								: "default",
						)
						.setDisabled(!fastSupported)
						.onChange(async (value) => {
							this.plugin.settings.annotationCodexServiceTier = value === "fast"
								? "fast"
								: "default";
							await this.plugin.saveSettings();
						});
				});
		}

		if (!discovery) {
			void this.plugin.discoverCliModels(backendId)
				.then(() => {
					if (this.activePage === "annotations") this.display();
				})
				.catch(() => undefined);
		}
	}

	private renderAnnotationTokenSetting(
		containerEl: HTMLElement,
		enabled: boolean,
	): void {
		new Setting(containerEl)
			.setName("最大输出 Token")
			.setDesc(
				enabled
					? "仅用于 Direct API 批注解释，范围 128-4096。CLI 后端不支持此处限制。"
					: "当前自动模式没有启用 Direct API；该参数会保留，待 Direct API 可用时生效。",
			)
			.addText((text) =>
				text
					.setPlaceholder("900")
					.setValue(String(this.plugin.settings.annotationMaxTokens))
					.setDisabled(!enabled)
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed)) return;
						this.plugin.settings.annotationMaxTokens = Math.max(
							128,
							Math.min(4096, parsed),
						);
						await this.plugin.saveSettings();
					})
			);
	}

	private renderDirectApiSettings(containerEl: HTMLElement): void {
		this.createSettingsPageHeader(
			containerEl,
			"Direct API 知识助手",
			"管理知识库问答、联网搜索与轻量 Agent 使用的模型服务。知识库模式只发送插件筛选出的 Vault 上下文；联网和工具调用仅在用户显式选择对应功能时启用。模型不能直接写 Vault，文件变更始终由插件校验并提交。",
			true,
		);
		this.createProviderSectionHeader(
			containerEl,
			"Direct API 配置",
			"先选择已有配置或新建配置，再按页面顺序填写供应商、凭据、endpoint 和模型。",
		);
		const profiles = this.plugin.settings.providerProfiles;
		const selectedProfile = this.getEditorProviderProfile();
		const profileSetting = new Setting(containerEl)
			.setName("配置")
			.setDesc(profiles.length ? "切换当前编辑的供应商配置。" : "尚未创建 Direct API 配置。");
		profileSetting.addDropdown((dropdown) => {
			if (!profiles.length) dropdown.addOption("", "尚未创建");
			profiles.forEach((profile) => {
				const suffix = profile.lastTest?.ok ? " · 已验证" : "";
				dropdown.addOption(profile.id, `${profile.name}${suffix}`);
			});
			dropdown
				.setValue(selectedProfile?.id || "")
				.onChange((value) => {
					this.plugin.providerEditorProfileId = value;
					this.display();
				});
		});
		profileSetting.addButton((button) =>
			button
				.setButtonText("新增配置")
				.onClick(async () => {
					const profile = makeProviderProfile("openai");
					this.plugin.settings.providerProfiles.push(profile);
					this.plugin.providerEditorProfileId = profile.id;
					await this.plugin.saveSettings();
					this.display();
				})
		);
		if (selectedProfile) {
			profileSetting.addButton((button) =>
				button
					.setButtonText("移除当前")
					.setWarning()
					.onClick(async () => {
						if (!window.confirm(`移除 Direct API 配置“${selectedProfile.name}”？SecretStorage 中的凭据不会删除。`)) return;
						this.plugin.settings.providerProfiles = profiles.filter(
							(profile) => profile.id !== selectedProfile.id,
						);
						if (this.plugin.settings.activeProviderId === selectedProfile.id) {
							this.plugin.settings.activeProviderId = "";
						}
						this.plugin.providerRuntimeState.delete(selectedProfile.id);
						this.plugin.providerEditorProfileId = this.plugin.settings.providerProfiles[0]?.id || "";
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}
		profileSetting.settingEl.addClass("agent-dashboard-provider-manager");

		if (!this.app.secretStorage || typeof SecretComponent !== "function") {
			const warning = containerEl.createDiv({ cls: "agent-dashboard-provider-warning" });
			warning.createEl("strong", { text: "SecretStorage 不可用" });
			warning.createEl("span", {
				text: "请升级 Obsidian。插件不会回退到 data.json 明文保存 API Key。",
			});
		}

		this.createProviderSectionHeader(
			containerEl,
			"联网搜索（Tavily 兜底）",
			"仅 Direct API 的联网问答使用：供应商不支持原生联网时，插件侧调用 Tavily 检索并让模型引用 [n] 来源。API Key 保存在 Obsidian SecretStorage，不写入 data.json。",
		);
		if (this.app.secretStorage && typeof SecretComponent === "function") {
			const tavilySetting = new Setting(containerEl)
				.setName("Tavily API Key")
				.setDesc("在 https://tavily.com 免费注册获取；未配置时，不支持原生联网的供应商无法使用联网模式。");
			tavilySetting.addComponent((element) =>
				new SecretComponent(this.app, element)
					.setValue(this.plugin.settings.webSearchTavilySecretId)
					.onChange(async (value) => {
						this.plugin.settings.webSearchTavilySecretId = String(value || "").trim().slice(0, 160);
						await this.plugin.saveSettings();
					})
			);
		}
		new Setting(containerEl)
			.setName("每个搜索词的结果数")
			.setDesc("联网问答每个搜索词最多取用的结果数（1-8），多结果自动去重并截断。")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.webSearchMaxResults || 5))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed)) return;
						this.plugin.settings.webSearchMaxResults = Math.max(1, Math.min(8, parsed));
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("搜索超时（秒）")
			.setDesc("单次 Tavily 请求的超时上限（5-60 秒）。")
			.addText((text) =>
				text
					.setPlaceholder("20")
					.setValue(String(this.plugin.settings.webSearchTimeoutSeconds || 20))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed)) return;
						this.plugin.settings.webSearchTimeoutSeconds = Math.max(5, Math.min(60, parsed));
						await this.plugin.saveSettings();
					})
			);

		this.createProviderSectionHeader(
			containerEl,
			"轻量 Agent（文献入库）",
			"文献入库的「轻量 Agent」运行方式在插件内执行有界工具循环：只读检索、白名单元数据接口、MinerU 提取与限定目录写入，无需 Codex CLI。",
		);
		new Setting(containerEl)
			.setName("最大工具循环轮数")
			.setDesc("轻量 Agent 单阶段任务的模型轮数上限（3-20）。达到上限即停止并报告当前进度。")
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.lightAgentMaxSteps || 10))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed)) return;
						this.plugin.settings.lightAgentMaxSteps = Math.max(3, Math.min(20, parsed));
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("单轮输出 Token 上限")
			.setDesc("轻量 Agent 每轮模型输出的最大 Token 数（512-8192）。过低会导致协议 JSON 被截断。")
			.addText((text) =>
				text
					.setPlaceholder("4096")
					.setValue(String(this.plugin.settings.lightAgentMaxOutputTokens || 4096))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (!Number.isFinite(parsed)) return;
						this.plugin.settings.lightAgentMaxOutputTokens = Math.max(512, Math.min(8192, parsed));
						await this.plugin.saveSettings();
					})
			);

		if (!selectedProfile) {
			const empty = containerEl.createDiv({ cls: "agent-dashboard-provider-empty" });
			const icon = empty.createSpan();
			setIcon(icon, "plug-zap");
			const copy = empty.createDiv();
			copy.createEl("strong", { text: "从新增配置开始" });
			copy.createEl("span", {
				text: "创建后依次填写供应商、SecretStorage 凭据和 endpoint，再获取模型并测试连接。",
			});
			return;
		}
		this.renderProviderProfile(containerEl, selectedProfile);
	}

	private createSettingsPageHeader(
		containerEl: HTMLElement,
		title: string,
		description: string,
		showBack = false,
	): void {
		const header = containerEl.createDiv({ cls: "agent-dashboard-settings-page-header" });
		if (showBack) {
			const backButton = header.createEl("button", {
				cls: "agent-dashboard-settings-back",
				attr: {
					type: "button",
					"aria-label": "返回设置首页",
				},
			});
			const icon = backButton.createSpan();
			setIcon(icon, "arrow-left");
			backButton.createSpan({ text: "设置" });
			backButton.addEventListener("click", () => {
				this.activePage = "home";
				this.display();
			});
		}
		header.createEl("h2", { text: title });
		header.createEl("p", { text: description });
	}

	private createSettingsHomeSection(containerEl: HTMLElement, title: string): HTMLElement {
		containerEl.createEl("h3", {
			cls: "agent-dashboard-settings-section-title",
			text: title,
		});
		return containerEl.createDiv({ cls: "agent-dashboard-settings-navigation" });
	}

	private createSettingsNavigationItem(
		containerEl: HTMLElement,
		options: {
			page: Exclude<SettingsPage, "home">;
			icon: string;
			title: string;
			description: string;
			status: string;
			badge?: { text: string; tone: "ok" | "muted" | "warn" };
		},
	): void {
		const button = containerEl.createEl("button", {
			cls: "agent-dashboard-settings-navigation-item",
			attr: {
				type: "button",
				"aria-label": `打开${options.title}设置`,
			},
		});
		const icon = button.createSpan({ cls: "agent-dashboard-settings-navigation-icon" });
		setIcon(icon, options.icon);
		const copy = button.createDiv({ cls: "agent-dashboard-settings-navigation-copy" });
		copy.createEl("strong", { text: options.title });
		copy.createSpan({ text: options.description });
		const trailing = button.createDiv({ cls: "agent-dashboard-settings-navigation-trailing" });
		trailing.createSpan({ text: options.status });
		if (options.badge) {
			trailing.createSpan({
				cls: `agent-dashboard-settings-navigation-badge is-${options.badge.tone}`,
				text: options.badge.text,
			});
		}
		const chevron = trailing.createSpan({ cls: "agent-dashboard-settings-navigation-chevron" });
		setIcon(chevron, "chevron-right");
		button.addEventListener("click", () => {
			this.activePage = options.page;
			this.display();
		});
	}

	getEditorProviderProfile(): ProviderProfile | null {
		const profiles = this.plugin.settings.providerProfiles;
		if (!profiles.length) {
			this.plugin.providerEditorProfileId = "";
			return null;
		}
		const preferredId = this.plugin.providerEditorProfileId
			|| this.plugin.settings.activeProviderId
			|| profiles[0].id;
		const profile = profiles.find((item) => item.id === preferredId) || profiles[0];
		this.plugin.providerEditorProfileId = profile.id;
		return profile;
	}

	createProviderSectionHeader(
		containerEl: HTMLElement,
		title: string,
		description = "",
		status = "",
	): HTMLElement {
		const header = containerEl.createDiv({ cls: "agent-dashboard-settings-section" });
		const heading = header.createDiv({ cls: "agent-dashboard-settings-section-heading" });
		heading.createEl("h3", { text: title });
		if (status) heading.createSpan({ cls: "agent-dashboard-provider-badge is-ready", text: status });
		if (description) header.createEl("p", { text: description });
		return header;
	}

	renderProviderProfile(containerEl: HTMLElement, profile: ProviderProfile): void {
		const metadata = PROVIDER_TYPE_BY_ID.get(profile.type) || PROVIDER_TYPES[0];
		const verificationStatus = profile.lastTest?.ok
			? this.plugin.settings.activeProviderId === profile.id
				? "已验证 · 默认"
				: "已验证"
			: "";
		this.createProviderSectionHeader(
			containerEl,
			"LLM 配置",
			"凭据通过 Obsidian SecretStorage 管理；插件配置只保存凭据名称。",
			verificationStatus,
		);
		const section = containerEl.createDiv({
			cls: "agent-dashboard-provider-form",
			attr: { "data-provider-id": profile.id },
		});

		new Setting(section)
			.setName("配置名称")
			.setDesc("用于区分多个供应商或不同账户。")
			.addText((text) => {
				const commitName = async () => {
					const normalizedName = text.getValue().trim().slice(0, 80) || metadata.label;
					profile.name = normalizedName;
					profile.updatedAt = new Date().toISOString();
					if (text.getValue() !== normalizedName) text.setValue(normalizedName);
					await this.plugin.saveSettings();
				};
				text
					.setPlaceholder(metadata.label)
					.setValue(profile.name)
					.onChange((value) => {
						profile.name = value.slice(0, 80);
					});
				text.inputEl.addEventListener("blur", () => {
					void commitName();
				});
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || event.isComposing) return;
					event.preventDefault();
					text.inputEl.blur();
				});
			});
		new Setting(section)
			.setName("LLM Provider")
			.setDesc("选择预定义供应商或 OpenAI 兼容服务。")
			.addDropdown((dropdown) => {
				PROVIDER_TYPES.forEach((provider) => dropdown.addOption(provider.id, provider.label));
				dropdown.setValue(profile.type).onChange(async (value) => {
					const previous = PROVIDER_TYPE_BY_ID.get(profile.type) || metadata;
					const next = PROVIDER_TYPE_BY_ID.get(value as ProviderTypeId) || PROVIDER_TYPES[0];
					if (!profile.baseUrl || profile.baseUrl === previous.defaultBaseUrl) {
						profile.baseUrl = next.defaultBaseUrl;
					}
					if (!profile.model || profile.model === previous.defaultModel) {
						profile.model = next.defaultModel;
					}
					profile.type = next.id;
					profile.capabilities = { ...next.capabilities, visionConfigured: false };
					profile.name = profile.name === previous.label ? next.label : profile.name;
					this.invalidateProviderProfile(profile);
					await this.plugin.saveSettings();
					this.display();
				});
			});
		const secretSetting = new Setting(section)
			.setName("API Key / 凭据")
			.setDesc(
				metadata.requiresSecret
					? "必需。选择或创建 SecretStorage 凭据；真实 Key 不写入 data.json。"
					: "可选。本地服务通常不需要；远程兼容端点可选择 SecretStorage 凭据。",
			);
		if (this.app.secretStorage && typeof SecretComponent === "function") {
			secretSetting.addComponent((element) =>
				new SecretComponent(this.app, element)
					.setValue(profile.secretId)
					.onChange(async (value) => {
						profile.secretId = String(value || "").trim().slice(0, 160);
						this.invalidateProviderProfile(profile);
						await this.plugin.saveSettings();
					})
			);
		}
		new Setting(section)
			.setName("联网搜索")
			.setDesc("问答视图「联网搜索」模式的取网方式：自动优先供应商原生联网（OpenRouter、通义千问、智谱、DeepSeek Responses），否则回退 Tavily；关闭后该供应商仅可知识库问答。")
			.addDropdown((dropdown) => {
				const modes: Array<[ProfileWebSearchMode, string]> = [
					["auto", "自动（原生优先，Tavily 兜底）"],
					["native", "仅供应商原生"],
					["tavily", "仅 Tavily"],
					["off", "关闭"],
				];
				for (const [value, label] of modes) dropdown.addOption(value, label);
				dropdown.setValue(profile.webSearch || "auto");
				dropdown.onChange(async (value) => {
					profile.webSearch = (["auto", "off", "native", "tavily"].includes(value)
						? value
						: "auto") as ProfileWebSearchMode;
					profile.updatedAt = new Date().toISOString();
					await this.plugin.saveSettings();
				});
			});
		new Setting(section)
			.setName("API Base URL")
			.setDesc(`服务根地址。${metadata.defaultBaseUrl ? `默认：${metadata.defaultBaseUrl}` : ""}`)
			.addText((text) =>
				text
					.setPlaceholder(metadata.defaultBaseUrl)
					.setValue(profile.baseUrl)
					.onChange(async (value) => {
						profile.baseUrl = value.trim().replace(/\/+$/g, "").slice(0, 500);
						this.invalidateProviderProfile(profile);
						await this.plugin.saveSettings();
					})
			);
		const timeoutSetting = new Setting(section)
			.setName("请求超时")
			.setDesc(`模型发现和连接测试的单次请求上限。当前：${profile.timeoutSeconds} 秒。`)
			.addSlider((slider) =>
				slider
					.setLimits(3, 120, 1)
					.setValue(profile.timeoutSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						profile.timeoutSeconds = value;
						this.invalidateProviderProfile(profile);
						timeoutSetting.setDesc(`模型发现和连接测试的单次请求上限。当前：${value} 秒。`);
						await this.plugin.saveSettings();
					})
			);
		timeoutSetting.settingEl.addClass("agent-dashboard-provider-setting-emphasis");

		this.createProviderSectionHeader(
			containerEl,
			"模型选择",
			"先从 Provider API 获取模型列表，再选择模型并执行最小连接测试。",
		);
		const modelForm = containerEl.createDiv({ cls: "agent-dashboard-provider-form" });
		const modelState = this.plugin.providerRuntimeState.get(profile.id);
		const discoveredModels = Array.isArray(modelState?.models) ? modelState.models : [];
		const runtime = this.plugin.providerRuntimeState.get(profile.id) || {};
		const discoverySetting = new Setting(modelForm)
			.setName("获取可用模型")
			.setDesc("从当前 endpoint 获取最新模型列表，不发送 Vault 内容。");
		discoverySetting.addButton((button) => {
			const loading = runtime.status === "models";
			button
				.setButtonText(loading ? "获取中…" : "获取模型列表")
				.setCta()
				.setDisabled(loading || runtime.status === "testing")
				.onClick(async () => {
					this.plugin.providerRuntimeState.set(profile.id, { ...runtime, status: "models" });
					this.display();
					try {
						const models = await this.plugin.listProviderModels(profile.id);
						this.plugin.providerRuntimeState.set(profile.id, { status: "idle", models });
						new Notice(`已获取 ${models.length} 个模型`, 5000);
					} catch (error) {
						const normalized = this.plugin.normalizeProviderError(error);
						this.plugin.providerRuntimeState.set(profile.id, {
							status: "idle",
							models: [],
							result: {
								ok: false,
								type: normalized.type,
								message: normalized.message,
								status: normalized.status,
								endpoint: normalized.endpoint || profile.baseUrl,
								model: profile.model,
								responseTimeMs: 0,
								testedAt: new Date().toISOString(),
							},
						});
					}
					this.display();
				});
		});
		discoverySetting.settingEl.addClass("agent-dashboard-provider-setting-emphasis");
		const modelSetting = new Setting(modelForm)
			.setName("选择模型")
			.setDesc(discoveredModels.length ? `从 ${discoveredModels.length} 个可用模型中选择，也可手动填写模型 ID。` : "尚未获取模型列表，可先手动填写模型 ID。")
			.addText((text) =>
				text
					.setPlaceholder(metadata.defaultModel || "模型 ID")
					.setValue(profile.model)
					.onChange(async (value) => {
						profile.model = value.trim().slice(0, 160);
						if (profile.capabilities.visionConfigured !== true) {
							profile.capabilities.vision = modelHasKnownVisionSupport(profile.model);
						}
						this.invalidateProviderProfile(profile);
						await this.plugin.saveSettings();
					})
			);
		if (discoveredModels.length) {
			modelSetting.addDropdown((dropdown) => {
				dropdown.addOption("", "选择已发现模型");
				discoveredModels.forEach((model) => dropdown.addOption(model.id, model.name || model.id));
				dropdown.setValue(discoveredModels.some((model) => model.id === profile.model) ? profile.model : "");
				dropdown.onChange(async (value) => {
					if (!value) return;
					profile.model = value;
					if (profile.capabilities.visionConfigured !== true) {
						profile.capabilities.vision = modelHasKnownVisionSupport(profile.model);
					}
					this.invalidateProviderProfile(profile);
					await this.plugin.saveSettings();
					this.display();
				});
			});
		}

		new Setting(modelForm)
			.setName("模型能力")
			.setDesc(
				`流式输出：${profile.capabilities.streaming ? "支持" : "不支持"}；PDF：${profile.capabilities.pdf ? "支持" : "不支持"}；视觉：${profile.capabilities.vision ? "支持" : "不支持"}。联网与轻量 Agent 工具按具体功能单独授权；任何 Vault 写入都由插件侧安全边界执行。`,
			);
		new Setting(modelForm)
			.setName("视觉输入")
			.setDesc(
				profile.type === "openai-compatible"
							? `允许查询侧边栏发送最多 ${MAX_QUERY_IMAGE_ATTACHMENTS} 张 Vault 图片，并从问题中的 Obsidian/Wiki 笔记链接发现嵌入图片。`
							: "视觉输入目前仅由 OpenAI 兼容适配器处理。",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(profile.capabilities.vision === true)
					.setDisabled(profile.type !== "openai-compatible")
					.onChange(async (value) => {
						profile.capabilities.vision = value;
						profile.capabilities.visionConfigured = true;
						profile.updatedAt = new Date().toISOString();
						await this.plugin.saveSettings();
						this.display();
					})
			);
		const controls = new Setting(modelForm)
			.setName("测试连接")
			.setDesc("验证 endpoint、凭据、模型和流式协议；成功后自动设为默认 Direct API 配置。");
		controls.addButton((button) => {
			const loading = runtime.status === "testing";
			button
				.setButtonText(loading ? "测试中…" : "测试连接")
				.setCta()
				.setDisabled(loading || runtime.status === "models")
				.onClick(async () => {
					this.plugin.providerRuntimeState.set(profile.id, {
						...runtime,
						status: "testing",
					});
					this.display();
					const result = await this.plugin.testProviderConnection(profile.id);
					const current = this.plugin.providerRuntimeState.get(profile.id) || {};
					this.plugin.providerRuntimeState.set(profile.id, {
						...current,
						status: "idle",
						result,
					});
					this.display();
				});
		});
		controls.settingEl.addClass("agent-dashboard-provider-test-setting");
		const result = runtime.result || (profile.lastTest
			? {
				ok: profile.lastTest.ok,
				type: profile.lastTest.type,
				model: profile.lastTest.model,
				modelExists: profile.lastTest.modelExists,
				endpoint: profile.lastTest.endpoint || profile.baseUrl,
				message: profile.lastTest.message,
				responseTimeMs: profile.lastTest.responseTimeMs,
				streaming: {
					supported: profile.capabilities.streaming,
					verified: profile.lastTest.streamingVerified,
				},
				pdf: { supported: profile.capabilities.pdf, verified: false },
				testedAt: profile.lastTest.testedAt,
			}
			: null);
		if (result) {
			this.renderConnectionResult(
				containerEl,
				result,
				this.plugin.directApiBoundaryLabel(profile.id),
			);
		}
	}

	invalidateProviderProfile(profile: ProviderProfile): void {
		profile.lastTest = null;
		profile.updatedAt = new Date().toISOString();
		if (this.plugin.settings.activeProviderId === profile.id) {
			this.plugin.settings.activeProviderId = "";
		}
	}

	renderConnectionResult(
		parent: HTMLElement,
		result: ProviderConnectionTestResult,
		boundary?: string,
	): void {
		const panel = parent.createDiv({
			cls: `agent-dashboard-provider-result ${result.ok ? "is-success" : "is-error"}`,
		});
		const heading = panel.createDiv({ cls: "agent-dashboard-provider-result-heading" });
		const icon = heading.createSpan();
		setIcon(icon, result.ok ? "circle-check" : "circle-alert");
		heading.createEl("strong", { text: result.ok ? "连接成功" : "连接失败" });
		const grid = panel.createDiv({ cls: "agent-dashboard-provider-result-grid" });
		const addRow = (label: string, value: unknown) => {
			const row = grid.createDiv();
			row.createSpan({ text: label });
			row.createEl("strong", { text: String(value || "—") });
		};
		if (result.endpoint) addRow("Endpoint", result.endpoint);
		addRow("模型", result.model || "—");
		if (result.ok) {
			addRow(
				"模型状态",
				result.modelExists === true
					? "存在，已验证"
					: result.modelExists === false
						? "列表中不存在"
						: "未验证，由实际任务确认",
			);
			const streaming = result.streaming?.supported
				? result.streaming.verified
					? "支持，已验证"
					: `支持，未验证${result.streaming?.error ? `：${result.streaming.error}` : ""}`
				: "不支持";
			addRow("流式输出", streaming);
			addRow("PDF", result.pdf?.supported ? "支持，未上传文件验证" : "不支持");
			const isAgent = ["codex-cli", "claude-code", "opencode"].includes(
				String(result.provider || ""),
			);
			if (isAgent && result.webSearch?.supported) {
				addRow(
					"联网搜索",
					result.webSearch.verified
						? "支持，已验证"
						: `按任务开放${result.webSearch.note ? `：${result.webSearch.note}` : ""}`,
				);
			}
			if (!isAgent) {
				addRow("能力边界", boundary || "仅知识库上下文，不联网、不写入");
			}
			addRow("响应时间", `${result.responseTimeMs} ms`);
			if (result.responsePreview) addRow("最小响应", result.responsePreview);
		} else {
			addRow("错误类型", this.plugin.getProviderErrorLabel(result.type));
			if (result.status) addRow("HTTP 状态", result.status);
			addRow("详情", result.message || "未知错误");
			addRow("耗时", `${result.responseTimeMs || 0} ms`);
		}
	}
}
