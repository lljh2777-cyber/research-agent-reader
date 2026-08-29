import {
	PROVIDER_TYPES,
	PROVIDER_TYPE_BY_ID,
	type ProviderTypeDefinition,
	type ProviderTypeId,
} from "../config";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function providerMetadata(type: unknown): ProviderTypeDefinition {
	return PROVIDER_TYPE_BY_ID.get(String(type || "openai") as ProviderTypeId) || PROVIDER_TYPES[0];
}

export function modelHasKnownVisionSupport(model: unknown): boolean {
	return /^(qwen3\.[567]-(plus|flash)|qwen3-vl|qwen-vl|qvq)/i.test(
		String(model || "").trim(),
	);
}

export function profileSupportsQueryImage(profile: unknown): boolean {
	const source = asRecord(profile);
	return source.type === "openai-compatible"
		&& asRecord(source.capabilities).vision === true;
}

export type ProfileWebSearchMode = "auto" | "off" | "native" | "tavily";

export type NativeWebSearchProtocol = "qwen" | "openrouter" | "zhipu" | "deepseek";

const WEB_SEARCH_MODES: ReadonlySet<string> = new Set([
	"auto",
	"off",
	"native",
	"tavily",
]);

/** Detects server-side web search support from the configured base URL. */
export function detectNativeWebSearchProtocol(
	baseUrl: unknown,
): NativeWebSearchProtocol | null {
	const base = String(baseUrl || "").toLowerCase();
	if (!base) return null;
	if (base.includes("openrouter")) return "openrouter";
	if (/dashscope|aliyuncs|tongyi|qwen/.test(base)) return "qwen";
	if (/bigmodel|zhipu|chatglm/.test(base)) return "zhipu";
	if (base.includes("deepseek")) return "deepseek";
	return null;
}

export interface ProviderProfile {
	id: string;
	name: string;
	type: ProviderTypeId;
	baseUrl: string;
	model: string;
	secretId: string;
	timeoutSeconds: number;
	webSearch: ProfileWebSearchMode;
	capabilities: {
		streaming: boolean;
		pdf: boolean;
		vision: boolean;
		visionConfigured: boolean;
	};
	lastTest: {
		ok: boolean;
		type: string;
		model: string;
		modelExists: boolean | null;
		endpoint: string;
		message: string;
		responseTimeMs: number;
		streamingVerified: boolean;
		testedAt: string;
	} | null;
	createdAt: string;
	updatedAt: string;
}

export function makeProviderProfile(type: unknown = "openai"): ProviderProfile {
	const metadata = providerMetadata(type);
	const now = new Date().toISOString();
	return {
		id: `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		name: metadata.label,
		type: metadata.id,
		baseUrl: metadata.defaultBaseUrl,
		model: metadata.defaultModel,
		secretId: "",
		timeoutSeconds: 20,
		webSearch: "auto",
		capabilities: { ...metadata.capabilities, visionConfigured: false },
		lastTest: null,
		createdAt: now,
		updatedAt: now,
	};
}

export function normalizeProviderProfile(profile: unknown): ProviderProfile {
	const source = asRecord(profile);
	const capabilities = asRecord(source.capabilities);
	const rawLastTest = asRecord(source.lastTest);
	const metadata = providerMetadata(source.type);
	const fallback = makeProviderProfile(metadata.id);
	const model = String(source.model || metadata.defaultModel).trim().slice(0, 160);
	const visionConfigured = capabilities.visionConfigured === true;
	const timeout = Number.parseInt(String(source.timeoutSeconds || ""), 10);
	const lastTest = source.lastTest && typeof source.lastTest === "object"
		? {
			ok: rawLastTest.ok === true,
			type: String(rawLastTest.type || ""),
			model: String(rawLastTest.model || ""),
			modelExists: rawLastTest.modelExists === true
				? true
				: rawLastTest.modelExists === false
					? false
					: null,
			endpoint: String(rawLastTest.endpoint || "").slice(0, 500),
			message: String(rawLastTest.message || "").slice(0, 500),
			responseTimeMs: Number(rawLastTest.responseTimeMs || 0),
			streamingVerified: rawLastTest.streamingVerified === true,
			testedAt: String(rawLastTest.testedAt || ""),
		}
		: null;
	return {
		id: String(source.id || fallback.id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100),
		name: String(source.name || metadata.label).trim().slice(0, 80),
		type: metadata.id,
		baseUrl: String(source.baseUrl || metadata.defaultBaseUrl).trim().slice(0, 500),
		model,
		secretId: String(source.secretId || "").trim().slice(0, 160),
		timeoutSeconds: Number.isFinite(timeout) ? Math.max(3, Math.min(120, timeout)) : 20,
		webSearch: WEB_SEARCH_MODES.has(String(source.webSearch || ""))
			? (String(source.webSearch) as ProfileWebSearchMode)
			: "auto",
		capabilities: {
			streaming: typeof capabilities.streaming === "boolean"
				? capabilities.streaming
				: metadata.capabilities.streaming,
			pdf: typeof capabilities.pdf === "boolean"
				? capabilities.pdf
				: metadata.capabilities.pdf,
			vision: visionConfigured
				? capabilities.vision === true
				: capabilities.vision === true
					|| metadata.capabilities.vision
					|| modelHasKnownVisionSupport(model),
			visionConfigured,
		},
		lastTest,
		createdAt: String(source.createdAt || fallback.createdAt),
		updatedAt: String(source.updatedAt || fallback.updatedAt),
	};
}
