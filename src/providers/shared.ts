export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

export interface ProviderErrorDetails {
	status?: number;
	endpoint?: string;
}

export class ProviderConnectionError extends Error {
	readonly type: string;
	readonly status: number;
	readonly endpoint: string;

	constructor(type: string, message: string, details: ProviderErrorDetails = {}) {
		super(message);
		this.name = "ProviderConnectionError";
		this.type = type;
		this.status = Number(details.status || 0);
		this.endpoint = String(details.endpoint || "");
	}
}

export function buildProviderUrl(baseUrl: unknown, route: unknown): string {
	const base = String(baseUrl || "").trim().replace(/\/+$/g, "");
	const pathValue = String(route || "").trim().replace(/^\/+/g, "");
	if (!base) throw new ProviderConnectionError("configuration", "未配置 endpoint");
	if (base.toLowerCase().endsWith("/v1") && pathValue.toLowerCase().startsWith("v1/")) {
		return `${base}/${pathValue.slice(3)}`;
	}
	return `${base}/${pathValue}`;
}

export function providerErrorMessage(payload: unknown, fallback = ""): string {
	const source = asRecord(payload);
	const error = asRecord(source.error);
	const candidates = [
		error.message,
		error.detail,
		source.message,
		source.detail,
	];
	return String(candidates.find((value) => typeof value === "string" && value.trim()) || fallback);
}

export function extractOpenAIText(payload: unknown): string {
	const source = asRecord(payload);
	if (typeof source.output_text === "string") return source.output_text;
	const output = Array.isArray(source.output) ? source.output : [];
	const responseText = output
		.flatMap((item) => {
			const content = asRecord(item).content;
			return Array.isArray(content) ? content : [];
		})
		.map((item) => {
			const content = asRecord(item);
			return content.text || content.content || "";
		})
		.filter(Boolean)
		.join("\n");
	if (responseText) return responseText;
	const choices = Array.isArray(source.choices) ? source.choices : [];
	const firstChoice = asRecord(choices[0]);
	const message = asRecord(firstChoice.message);
	return String(message.content || firstChoice.text || "");
}

export function parseProviderJson(value: unknown): UnknownRecord | null {
	try {
		const parsed: unknown = JSON.parse(String(value || ""));
		return parsed !== null && typeof parsed === "object"
			? parsed as UnknownRecord
			: null;
	} catch {
		return null;
	}
}

export function emitProviderDelta(onDelta: unknown, value: unknown): string {
	const delta = String(value || "");
	if (delta && typeof onDelta === "function") onDelta(delta);
	return delta;
}

export interface ProviderModel {
	id: string;
	name: string;
	ownedBy: string;
}

export function normalizeProviderModelList(payload: unknown): ProviderModel[] {
	const source = asRecord(payload);
	const values = Array.isArray(source.data)
		? source.data
		: Array.isArray(source.models)
			? source.models
			: [];
	return values
		.map((model): ProviderModel | null => {
			const record = asRecord(model);
			const id = String(record.id || record.name || record.model || "").trim();
			if (!id) return null;
			return {
				id,
				name: String(record.name || record.id || id),
				ownedBy: String(record.owned_by || record.provider || ""),
			};
		})
		.filter((model): model is ProviderModel => model !== null)
		.sort((a, b) => a.id.localeCompare(b.id));
}
