import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import type {
	ArticleWikiSource,
	MineruModel,
	ReasoningEffort,
} from "../actions";
import type { CliBackendId } from "../config";
import type { ProviderProfile } from "../providers/profile";

export type ClaudeConfigSource = "official" | "cc-switch";
export type CodexConfigSource = "official" | "cc-switch";
export type OpenCodeConfigSource = "official" | "cc-switch";
export type CliExecutableKind = "codex" | "claude" | "opencode" | "mineru" | "obsidian";
export type CliExecutableDetectionSource =
	| "environment"
	| "common"
	| "path"
	| "manual"
	| "missing";

export interface CliExecutableDetection {
	executable: string;
	source: CliExecutableDetectionSource;
	sourceLabel: string;
	found: boolean;
}

export type MineruServiceMode = "official" | "private";
export type MineruReaderDefaultMode = "pdf" | "visuals";
export type MineruReaderRenderQuality = "standard" | "high";

export type ActionRunnerPreference = "auto" | "light" | "cli";

export interface ActionExecutionDefault {
	backend: CliBackendId;
	model: string;
	reasoningEffort: ReasoningEffort | "";
	serviceTier: "default" | "fast";
	/** Only meaningful for paper-ingest: which runner the modal opens with. */
	runner: ActionRunnerPreference;
}

export const CONFIGURABLE_ACTION_IDS = [
	"paper-ingest",
	"pdf-xray",
	"code-analysis",
	"vault-retrieval",
	"synthesis",
	"vault-lint-fix",
] as const;

export const STAGE_WRITE_BACKEND_ACTION_IDS = new Set<string>([
	"code-analysis",
	"synthesis",
]);

export const MINERU_LANGUAGE_IDS = [
	"en",
	"ch",
	"ch_server",
	"japan",
	"korean",
	"latin",
	"arabic",
	"cyrillic",
	"devanagari",
] as const;

export const DEFAULT_ACTION_EXECUTION_DEFAULTS: Record<string, ActionExecutionDefault> = {
	"paper-ingest": { backend: "codex-cli", model: "", reasoningEffort: "high", serviceTier: "default", runner: "auto" },
	"pdf-xray": { backend: "codex-cli", model: "", reasoningEffort: "high", serviceTier: "default", runner: "auto" },
	"code-analysis": { backend: "codex-cli", model: "", reasoningEffort: "medium", serviceTier: "default", runner: "auto" },
	"vault-retrieval": { backend: "codex-cli", model: "", reasoningEffort: "medium", serviceTier: "default", runner: "auto" },
	"synthesis": { backend: "codex-cli", model: "", reasoningEffort: "high", serviceTier: "default", runner: "auto" },
	"vault-lint-fix": { backend: "codex-cli", model: "", reasoningEffort: "high", serviceTier: "default", runner: "auto" },
};

function normalizeActionExecutionDefault(
	value: unknown,
	fallback: ActionExecutionDefault,
): ActionExecutionDefault {
	const source = value !== null && typeof value === "object"
		? value as Record<string, unknown>
		: {};
	const backend = source.backend === "claude-code" || source.backend === "opencode"
		? source.backend
		: "codex-cli";
	const reasoning = String(source.reasoningEffort || "");
	const runnerRaw = String(source.runner || "auto");
	return {
		backend,
		runner: runnerRaw === "light" || runnerRaw === "cli" ? runnerRaw : "auto",
		model: String(source.model || "").trim().slice(0, 200),
		reasoningEffort: ["low", "medium", "high", "xhigh"].includes(reasoning)
			? reasoning as ReasoningEffort
			: fallback.reasoningEffort,
		serviceTier: source.serviceTier === "fast" ? "fast" : "default",
	};
}

export function normalizeActionExecutionDefaults(
	value: unknown,
): Record<string, ActionExecutionDefault> {
	const source = value !== null && typeof value === "object"
		? value as Record<string, unknown>
		: {};
	return Object.fromEntries(CONFIGURABLE_ACTION_IDS.map((actionId) => {
		const fallback = DEFAULT_ACTION_EXECUTION_DEFAULTS[actionId];
		const normalized = normalizeActionExecutionDefault(source[actionId], fallback);
		if (!STAGE_WRITE_BACKEND_ACTION_IDS.has(actionId)) normalized.backend = "codex-cli";
		return [actionId, normalized];
	}));
}

const MANAGED_CODEX_BIN_ROOT = process.env.LOCALAPPDATA
	? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
	: "";
const CLI_ENVIRONMENT_VARIABLES: Record<CliExecutableKind, string> = {
	codex: "CODEX_CLI_PATH",
	claude: "CLAUDE_CODE_PATH",
	opencode: "OPENCODE_PATH",
	mineru: "MINERU_CLI_PATH",
	obsidian: "OBSIDIAN_CLI_PATH",
};
const CLI_COMMAND_NAMES: Record<CliExecutableKind, string> = {
	codex: "codex",
	claude: "claude",
	opencode: "opencode",
	mineru: "mineru-open-api",
	obsidian: "obsidian",
};

export interface DashboardSettings {
	toolkitRoot: string;
	readerMarkdownFolders: string[];
	obsidianCliExecutable: string;
	codexExecutable: string;
	codexConfigSource: CodexConfigSource;
	codexModel: string;
	codexReasoningEffort: string;
	claudeExecutable: string;
	claudeConfigSource: ClaudeConfigSource;
	claudeModel: string;
	claudeReasoningEffort: string;
	openCodeExecutable: string;
	openCodeConfigSource: OpenCodeConfigSource;
	openCodeModel: string;
	openCodeReasoningEffort: string;
	annotationBackendId: string;
	annotationCodexModel: string;
	annotationCodexReasoningEffort: string;
	annotationCodexServiceTier: "default" | "fast";
	annotationClaudeModel: string;
	annotationClaudeReasoningEffort: string;
	annotationOpenCodeModel: string;
	annotationOpenCodeReasoningEffort: string;
	annotationMaxTokens: number;
	annotationWebSearchEnabled: boolean;
	annotationWebSearchTimeoutSeconds: number;
	mineruExecutable: string;
	mineruSecretId: string;
	mineruServiceMode: MineruServiceMode;
	mineruBaseUrl: string;
	mineruDefaultModel: MineruModel;
	mineruDefaultLanguage: string;
	mineruDefaultOcr: boolean;
	mineruDefaultFormula: boolean;
	mineruDefaultTable: boolean;
	mineruDefaultTimeoutSeconds: number;
	mineruDefaultIncludeSourcePdf: boolean;
	mineruDefaultArticleWikiSource: ArticleWikiSource;
	mineruConfirmRemoteUpload: boolean;
	mineruReaderDefaultMode: MineruReaderDefaultMode;
	mineruReaderFollowPdfReading: boolean;
	mineruReaderFollowVisualReading: boolean;
	mineruReaderShowLayoutBoxes: boolean;
	mineruReaderPdfZoom: number;
	mineruReaderSplitRatio: number;
	mineruReaderRenderQuality: MineruReaderRenderQuality;
	pythonExecutable: string;
	rscriptExecutable: string;
	codePracticeTimeoutSeconds: number;
	taskTimeoutMinutes: number;
	actionExecutionDefaults: Record<string, ActionExecutionDefault>;
	queryDefaultBackendId: string;
	queryDefaultRetrievalMode: "vault" | "web";
	activeProviderId: string;
	providerProfiles: ProviderProfile[];
	providerTimeoutSeconds: number;
	taskHistoryLimit: number;
	querySessionLimit: number;
	queryMessageLimit: number;
	queryNotesFolder: string;
	webSearchTavilySecretId: string;
	webSearchMaxResults: number;
	webSearchTimeoutSeconds: number;
	lightAgentMaxSteps: number;
	lightAgentMaxOutputTokens: number;
}

export function normalizeReaderMarkdownFolders(value: unknown): string[] {
	const values = Array.isArray(value)
		? value
		: String(value || "").split(/[\r\n,;]+/);
	const seen = new Set<string>();
	const folders: string[] = [];
	for (const item of values) {
		const folder = String(item || "")
			.trim()
			.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "")
			.replace(/\/{2,}/g, "/");
		if (
			!folder
			|| folder === "."
			|| folder.split("/").some((segment) => segment === "." || segment === "..")
			|| /^[A-Za-z]:/.test(folder)
		) continue;
		const key = folder.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		folders.push(folder);
	}
	return folders;
}

function joinFromEnvironment(
	base: string | undefined,
	...segments: string[]
): string {
	return base ? path.join(base, ...segments) : "";
}

function normalizeExecutablePath(value: unknown): string {
	const text = String(value || "").trim().replace(/^"(.*)"$/, "$1");
	if (!text) return "";
	try {
		return path.resolve(text);
	} catch {
		return text;
	}
}

function isExecutableFile(value: unknown): boolean {
	const executable = normalizeExecutablePath(value);
	if (!executable) return false;
	try {
		return fs.statSync(executable).isFile();
	} catch {
		return false;
	}
}

function uniqueExistingFiles(candidates: string[]): string[] {
	const seen = new Set<string>();
	return candidates
		.map(normalizeExecutablePath)
		.filter((candidate) => {
			if (!candidate || !isExecutableFile(candidate)) return false;
			const key = process.platform === "win32"
				? candidate.toLowerCase()
				: candidate;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

function managedCodexCandidates(): string[] {
	if (!MANAGED_CODEX_BIN_ROOT || !fs.existsSync(MANAGED_CODEX_BIN_ROOT)) {
		return [];
	}
	const candidates = [path.join(MANAGED_CODEX_BIN_ROOT, "codex.exe")];
	try {
		fs.readdirSync(MANAGED_CODEX_BIN_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.forEach((entry) => {
				candidates.push(
					path.join(MANAGED_CODEX_BIN_ROOT, entry.name, "codex.exe"),
				);
			});
	} catch (error) {
		console.warn("Research Agent Reader could not scan the managed Codex CLI directory", error);
	}
	return uniqueExistingFiles(candidates).sort((left, right) => {
		try {
			return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
		} catch {
			return 0;
		}
	});
}

function commonCliCandidates(kind: CliExecutableKind): string[] {
	const userProfile = process.env.USERPROFILE;
	const homeDirectory = process.env.HOME || userProfile;
	const appData = process.env.APPDATA;
	const localAppData = process.env.LOCALAPPDATA;
	if (kind === "obsidian") {
		if (process.platform === "win32") {
			return [
				path.join(path.dirname(process.execPath), "Obsidian.com"),
				joinFromEnvironment(localAppData, "Programs", "Obsidian", "Obsidian.com"),
				joinFromEnvironment(process.env.ProgramFiles, "Obsidian", "Obsidian.com"),
			];
		}
		if (process.platform === "darwin") {
			return [
				"/usr/local/bin/obsidian",
				"/Applications/Obsidian.app/Contents/MacOS/obsidian-cli",
			];
		}
		return [
			joinFromEnvironment(homeDirectory, ".local", "bin", "obsidian"),
			"/usr/local/bin/obsidian",
			"/usr/bin/obsidian",
		];
	}
	if (process.platform !== "win32") {
		const command = CLI_COMMAND_NAMES[kind];
		const candidates = [
			joinFromEnvironment(homeDirectory, ".local", "bin", command),
			joinFromEnvironment(homeDirectory, "bin", command),
			"/usr/local/bin/" + command,
			"/usr/bin/" + command,
		];
		if (process.platform === "darwin") {
			candidates.splice(2, 0, `/opt/homebrew/bin/${command}`);
		}
		if (kind === "opencode") {
			candidates.unshift(joinFromEnvironment(homeDirectory, ".opencode", "bin", "opencode"));
		}
		return candidates;
	}
	if (kind === "codex") {
		return [
			...managedCodexCandidates(),
			joinFromEnvironment(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
			joinFromEnvironment(userProfile, ".local", "bin", "codex.exe"),
			joinFromEnvironment(userProfile, "scoop", "shims", "codex.exe"),
			joinFromEnvironment(appData, "npm", "codex.cmd"),
			joinFromEnvironment(localAppData, "Microsoft", "WinGet", "Links", "codex.exe"),
		];
	}
	if (kind === "claude") {
		return [
			joinFromEnvironment(userProfile, ".local", "bin", "claude.exe"),
			joinFromEnvironment(userProfile, "scoop", "shims", "claude.exe"),
			joinFromEnvironment(appData, "npm", "claude.cmd"),
			joinFromEnvironment(localAppData, "AnthropicClaude", "claude.exe"),
			joinFromEnvironment(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
		];
	}
	if (kind === "mineru") {
		return [
			joinFromEnvironment(appData, "npm", "mineru-open-api.cmd"),
			joinFromEnvironment(userProfile, "scoop", "shims", "mineru-open-api.exe"),
			joinFromEnvironment(userProfile, ".local", "bin", "mineru-open-api.exe"),
			joinFromEnvironment(localAppData, "Microsoft", "WinGet", "Links", "mineru-open-api.exe"),
		];
	}
	return [
		joinFromEnvironment(userProfile, ".opencode", "bin", "opencode.exe"),
		joinFromEnvironment(userProfile, ".local", "bin", "opencode.exe"),
		joinFromEnvironment(userProfile, "scoop", "shims", "opencode.exe"),
		joinFromEnvironment(appData, "npm", "opencode.cmd"),
		joinFromEnvironment(localAppData, "Microsoft", "WinGet", "Links", "opencode.exe"),
	];
}

function findExecutableOnPath(command: string): string {
	const pathEntries = String(process.env.PATH || "")
		.split(path.delimiter)
		.map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
	const extensions = process.platform === "win32"
		? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
			.split(";")
			.map((extension) => extension.toLowerCase())
		: [""];
	for (const directory of pathEntries) {
		for (const extension of extensions) {
			const candidate = path.join(directory, `${command}${extension}`);
			if (isExecutableFile(candidate)) return normalizeExecutablePath(candidate);
		}
	}
	try {
		const locator = process.platform === "win32" ? "where.exe" : "which";
		const output = execFileSync(locator, [command], {
			encoding: "utf8",
			timeout: 3000,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output
			.split(/\r?\n/)
			.map((line) => normalizeExecutablePath(line))
			.find((candidate) => isExecutableFile(candidate)) || "";
	} catch {
		return "";
	}
}

function detectionResult(
	executable: string,
	source: CliExecutableDetectionSource,
	sourceLabel: string,
	found = true,
): CliExecutableDetection {
	return { executable, source, sourceLabel, found };
}

export function detectCliExecutable(
	kind: CliExecutableKind,
	manualPath = "",
): CliExecutableDetection {
	const environmentVariable = CLI_ENVIRONMENT_VARIABLES[kind];
	const environmentPath = normalizeExecutablePath(process.env[environmentVariable]);
	if (isExecutableFile(environmentPath)) {
		return detectionResult(
			environmentPath,
			"environment",
			`环境变量 ${environmentVariable}`,
		);
	}
	const commonPath = uniqueExistingFiles(commonCliCandidates(kind))[0] || "";
	if (commonPath) {
		return detectionResult(commonPath, "common", "常见安装目录");
	}
	const pathExecutable = findExecutableOnPath(CLI_COMMAND_NAMES[kind]);
	if (pathExecutable) {
		return detectionResult(pathExecutable, "path", "系统 PATH / where.exe");
	}
	const normalizedManualPath = normalizeExecutablePath(manualPath);
	if (isExecutableFile(normalizedManualPath)) {
		return detectionResult(normalizedManualPath, "manual", "手动路径");
	}
	return detectionResult(
		normalizedManualPath,
		"missing",
		normalizedManualPath ? "手动路径（文件不存在）" : "未检测到",
		false,
	);
}

export function describeCliExecutable(
	kind: CliExecutableKind,
	executable: string,
): CliExecutableDetection {
	const normalized = normalizeExecutablePath(executable);
	if (!normalized) {
		return detectionResult("", "missing", "未配置", false);
	}
	if (!isExecutableFile(normalized)) {
		return detectionResult(
			normalized,
			"missing",
			"手动路径（文件不存在）",
			false,
		);
	}
	const environmentVariable = CLI_ENVIRONMENT_VARIABLES[kind];
	if (
		normalizeExecutablePath(process.env[environmentVariable]).toLowerCase()
		=== normalized.toLowerCase()
	) {
		return detectionResult(
			normalized,
			"environment",
			`环境变量 ${environmentVariable}`,
		);
	}
	const commonPaths = uniqueExistingFiles(commonCliCandidates(kind))
		.map((candidate) => candidate.toLowerCase());
	if (commonPaths.includes(normalized.toLowerCase())) {
		return detectionResult(normalized, "common", "常见安装目录");
	}
	const pathExecutable = findExecutableOnPath(CLI_COMMAND_NAMES[kind]);
	if (
		pathExecutable
		&& pathExecutable.toLowerCase() === normalized.toLowerCase()
	) {
		return detectionResult(normalized, "path", "系统 PATH / where.exe");
	}
	return detectionResult(normalized, "manual", "手动路径");
}

export function findPreferredOpenCodeExecutable(): string {
	const detected = detectCliExecutable("opencode");
	return detected.found ? detected.executable : "";
}

export function findPreferredObsidianCliExecutable(): string {
	const detected = detectCliExecutable("obsidian");
	return detected.found ? detected.executable : "";
}

export function findPreferredMineruExecutable(): string {
	const detected = detectCliExecutable("mineru");
	return detected.found ? detected.executable : "";
}

export function findPreferredClaudeExecutable(): string {
	const detected = detectCliExecutable("claude");
	return detected.found ? detected.executable : "";
}

export function inferLegacyClaudeConfigSource(): ClaudeConfigSource {
	const settingsPath = path.join(
		process.env.USERPROFILE || process.env.HOME || "",
		".claude",
		"settings.json",
	);
	try {
		const source = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			env?: Record<string, unknown>;
		};
		const env = source.env && typeof source.env === "object" ? source.env : {};
		const customEndpoint = String(env.ANTHROPIC_BASE_URL || "").trim();
		const configuredModel = String(env.ANTHROPIC_MODEL || "").trim();
		return customEndpoint || configuredModel ? "cc-switch" : "official";
	} catch {
		return "official";
	}
}

export function getClaudeConfigSourceLabel(source: ClaudeConfigSource): string {
	return source === "cc-switch" ? "CC Switch" : "官方 Claude Code";
}

export function getClaudeDefaultModelLabel(source: ClaudeConfigSource): string {
	return source === "cc-switch" ? "CC Switch 当前模型" : "Claude CLI 默认模型";
}

export function getCodexConfigSourceLabel(source: CodexConfigSource): string {
	return source === "cc-switch" ? "CC Switch" : "官方 Codex CLI";
}

export function getCodexDefaultModelLabel(source: CodexConfigSource): string {
	return source === "cc-switch" ? "CC Switch 当前模型" : "Codex 官方默认模型";
}

export function getOpenCodeConfigSourceLabel(source: OpenCodeConfigSource): string {
	return source === "cc-switch" ? "CC Switch" : "官方 OpenCode Zen";
}

export function getOpenCodeDefaultModelLabel(source: OpenCodeConfigSource): string {
	return source === "cc-switch" ? "CC Switch 当前模型" : "OpenCode Zen 默认模型";
}

export function findPreferredCodexExecutable(): string {
	const detected = detectCliExecutable("codex");
	return detected.found ? detected.executable : "";
}

export function isManagedCodexExecutable(executable: unknown): boolean {
	if (!executable || !MANAGED_CODEX_BIN_ROOT) return false;
	const normalized = path.resolve(String(executable)).toLowerCase();
	const managedRoot = path.resolve(MANAGED_CODEX_BIN_ROOT).toLowerCase();
	const desktopInstall = normalizeExecutablePath(
		joinFromEnvironment(
			process.env.LOCALAPPDATA,
			"Programs",
			"OpenAI",
			"Codex",
			"bin",
			"codex.exe",
		),
	).toLowerCase();
	return normalized === managedRoot
		|| normalized.startsWith(`${managedRoot}${path.sep}`)
		|| Boolean(desktopInstall && normalized === desktopInstall);
}

export interface LegacySettingsKeyMigration {
	settings: Record<string, unknown>;
	changed: boolean;
}

/**
 * Older builds stored the optional toolkit workspace as `projectRoot`. That
 * directory is toolkit-only and must never be treated as the active Vault, so
 * the persisted key is renamed to `toolkitRoot` and its value carried over.
 */
export function migrateLegacySettingsKeys(
	storedSettings: Record<string, unknown>,
): LegacySettingsKeyMigration {
	const settings = { ...storedSettings };
	let changed = false;
	if (Object.prototype.hasOwnProperty.call(settings, "projectRoot")) {
		const legacyRoot = typeof settings.projectRoot === "string" ? settings.projectRoot : "";
		delete settings.projectRoot;
		const currentRoot = typeof settings.toolkitRoot === "string" ? settings.toolkitRoot.trim() : "";
		if (!currentRoot && legacyRoot.trim()) settings.toolkitRoot = legacyRoot;
		changed = true;
	}
	return { settings, changed };
}

export const DEFAULT_SETTINGS: DashboardSettings = {
	toolkitRoot: "",
	readerMarkdownFolders: ["papers", "Clippings"],
	obsidianCliExecutable: findPreferredObsidianCliExecutable(),
	codexExecutable: findPreferredCodexExecutable(),
	codexConfigSource: "official",
	codexModel: "gpt-5.6-terra",
	codexReasoningEffort: "medium",
	claudeExecutable: findPreferredClaudeExecutable(),
	claudeConfigSource: "official",
	claudeModel: "",
	claudeReasoningEffort: "medium",
	openCodeExecutable: findPreferredOpenCodeExecutable(),
	openCodeConfigSource: "official",
	openCodeModel: "opencode/mimo-v2.5-free",
	openCodeReasoningEffort: "medium",
	annotationBackendId: "auto",
	annotationCodexModel: "",
	annotationCodexReasoningEffort: "medium",
	annotationCodexServiceTier: "default",
	annotationClaudeModel: "",
	annotationClaudeReasoningEffort: "medium",
	annotationOpenCodeModel: "",
	annotationOpenCodeReasoningEffort: "medium",
	annotationMaxTokens: 900,
	annotationWebSearchEnabled: false,
	annotationWebSearchTimeoutSeconds: 30,
	mineruExecutable: findPreferredMineruExecutable(),
	mineruSecretId: "",
	mineruServiceMode: "official",
	mineruBaseUrl: "",
	mineruDefaultModel: "vlm",
	mineruDefaultLanguage: "en",
	mineruDefaultOcr: false,
	mineruDefaultFormula: true,
	mineruDefaultTable: true,
	mineruDefaultTimeoutSeconds: 600,
	mineruDefaultIncludeSourcePdf: true,
	mineruDefaultArticleWikiSource: "auto",
	mineruConfirmRemoteUpload: false,
	mineruReaderDefaultMode: "pdf",
	mineruReaderFollowPdfReading: true,
	mineruReaderFollowVisualReading: true,
	mineruReaderShowLayoutBoxes: true,
	mineruReaderPdfZoom: 1,
	mineruReaderSplitRatio: 0.64,
	mineruReaderRenderQuality: "standard",
	pythonExecutable: "",
	rscriptExecutable: "",
	codePracticeTimeoutSeconds: 30,
	taskTimeoutMinutes: 60,
	actionExecutionDefaults: normalizeActionExecutionDefaults(DEFAULT_ACTION_EXECUTION_DEFAULTS),
	queryDefaultBackendId: "codex-cli",
	queryDefaultRetrievalMode: "web",
	activeProviderId: "",
	providerProfiles: [],
	providerTimeoutSeconds: 20,
	taskHistoryLimit: 30,
	querySessionLimit: 8,
	queryMessageLimit: 30,
	queryNotesFolder: "wiki/qa",
	webSearchTavilySecretId: "",
	webSearchMaxResults: 5,
	webSearchTimeoutSeconds: 20,
	lightAgentMaxSteps: 10,
	lightAgentMaxOutputTokens: 4096,
};
