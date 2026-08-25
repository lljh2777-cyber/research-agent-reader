import type { DashboardSettings } from "./settings";
import type {
	ExecutionConfig,
	QuerySession,
	TaskRun,
	TaskRunStatus,
} from "../types/contracts";
import { normalizeProviderProfile } from "../providers/profile";
import { isCliBackendId } from "../config";

type UnknownRecord = Record<string, unknown>;

export interface DashboardPersistenceState {
	settings: DashboardSettings;
	taskRuns: TaskRun[];
	querySessions: QuerySession[];
	activeQuerySessionId: string;
}

export interface DashboardStoredData extends UnknownRecord {
	settings?: UnknownRecord;
	taskRuns?: unknown[];
	querySessions?: unknown[];
	activeQuerySessionId?: string;
}

interface SaveWaiter {
	resolve: () => void;
	reject: (error: unknown) => void;
}

interface DashboardPersistenceOptions {
	load: () => Promise<unknown>;
	save: (data: unknown) => Promise<void>;
	getState: () => DashboardPersistenceState;
}

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function normalizeTaskStatus(value: unknown): TaskRunStatus {
	const status = String(value || "");
	return status === "queued"
		|| status === "running"
		|| status === "done"
		|| status === "failed"
		|| status === "interrupted"
		? status
		: "interrupted";
}

function normalizeExecutionConfig(value: unknown): ExecutionConfig | null {
	const source = asRecord(value);
	const model = String(source.model || "").trim();
	const backend = source.backend === "direct-api"
		? "direct-api"
		: isCliBackendId(source.backend)
			? source.backend
			: "codex-cli";
	if (!model && backend !== "claude-code" && backend !== "opencode") return null;
	const serviceTier = source.serviceTier === "fast"
		? "fast"
		: source.serviceTier === "default"
			? "default"
			: null;
	return {
		backend,
		providerId: String(source.providerId || ""),
		providerName: String(source.providerName || ""),
		model,
		reasoningEffort: source.reasoningEffort === null
			? null
			: String(source.reasoningEffort || ""),
		serviceTier,
		modelSource: String(source.modelSource || ""),
		reasoningSource: String(source.reasoningSource || ""),
	};
}

export function normalizeStoredTaskRuns(value: unknown, limit = 30): TaskRun[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, Math.max(5, Math.min(100, limit))).map((item) => {
		const source = asRecord(item);
		return {
			id: String(source.id || ""),
			actionId: String(source.actionId || ""),
			label: String(source.label || ""),
			agent: String(source.agent || ""),
			summary: String(source.summary || "").slice(0, 4000),
			executionConfig: normalizeExecutionConfig(source.executionConfig),
			status: normalizeTaskStatus(source.status),
			startedAt: String(source.startedAt || ""),
			finishedAt: String(source.finishedAt || ""),
			exitCode: typeof source.exitCode === "number" ? source.exitCode : null,
			output: String(source.output || "").slice(0, 12000),
			outputPath: String(source.outputPath || "") || undefined,
			error: String(source.error || "").slice(0, 4000),
		};
	});
}

export function hasPlaintextCredentialFields(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, child]) => {
		if (
			/(api.?key|access.?token|oauth.?token|github.?token|secret.?value|password)/i.test(key)
			&& key !== "secretId"
		) {
			return Boolean(child);
		}
		return child && typeof child === "object" && hasPlaintextCredentialFields(child);
	});
}

export function sanitizeSettingsForStorage(settings: DashboardSettings): DashboardSettings {
	const sanitized = { ...settings } as DashboardSettings & UnknownRecord;
	Object.keys(sanitized).forEach((key) => {
		if (
			/(api.?key|access.?token|oauth.?token|github.?token|secret.?value|password)/i.test(key)
			&& key !== "secretId"
		) {
			delete sanitized[key];
		}
	});
	sanitized.providerProfiles = Array.isArray(settings.providerProfiles)
		? settings.providerProfiles.slice(0, 20).map((profile) => normalizeProviderProfile(profile))
		: [];
	sanitized.activeProviderId = sanitized.providerProfiles.some(
		(profile) => profile.id === settings.activeProviderId && profile.lastTest?.ok,
	)
		? settings.activeProviderId
		: "";
	return sanitized;
}

export function createPersistenceSnapshot(state: DashboardPersistenceState): DashboardStoredData {
	const taskHistoryLimit = Math.max(5, Math.min(100, state.settings.taskHistoryLimit || 30));
	const querySessionLimit = Math.max(1, Math.min(30, state.settings.querySessionLimit || 8));
	const queryMessageLimit = Math.max(10, Math.min(100, state.settings.queryMessageLimit || 30));
	return JSON.parse(JSON.stringify({
		settings: sanitizeSettingsForStorage(state.settings),
		taskRuns: state.taskRuns.slice(0, taskHistoryLimit).map((run) => ({
			...run,
			output: String(run.output || "").slice(0, 12000),
			error: String(run.error || "").slice(0, 4000),
		})),
		querySessions: state.querySessions.slice(0, querySessionLimit).map((session) => ({
			...session,
			messages: session.messages.slice(-queryMessageLimit).map((message) => ({
				...message,
				content: String(message.content || "").slice(0, 8000),
				error: String(message.error || "").slice(0, 4000),
			})),
		})),
		activeQuerySessionId: state.activeQuerySessionId,
	})) as DashboardStoredData;
}

export class DashboardPersistence {
	private saveQueue: Promise<void> = Promise.resolve();
	private saveTimer: number | null = null;
	private readonly saveWaiters: SaveWaiter[] = [];

	constructor(private readonly options: DashboardPersistenceOptions) {}

	async load(): Promise<DashboardStoredData> {
		const loaded = await this.options.load();
		return loaded && typeof loaded === "object"
			? loaded as DashboardStoredData
			: {};
	}

	async save(): Promise<void> {
		const snapshot = createPersistenceSnapshot(this.options.getState());
		this.saveQueue = this.saveQueue
			.catch((error: unknown) => {
				console.error("Previous Dashboard settings save failed", error);
			})
			.then(() => this.options.save(snapshot));
		await this.saveQueue;
	}

	schedule(delayMs = 400): Promise<void> {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		return new Promise((resolve, reject) => {
			this.saveWaiters.push({ resolve, reject });
			this.saveTimer = window.setTimeout(() => {
				void this.flush();
			}, delayMs);
		});
	}

	async flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		const waiters = this.saveWaiters.splice(0);
		if (!waiters.length) return;
		try {
			await this.save();
			waiters.forEach(({ resolve }) => resolve());
		} catch (error) {
			waiters.forEach(({ reject }) => reject(error));
		}
	}
}
