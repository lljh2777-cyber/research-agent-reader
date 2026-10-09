/** Shared by intake and reading: equivalent argument ordering must not bypass retry limits. */
export function toolRequestKey(tool: string, args: Record<string, unknown>): string {
	const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
		: value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
	return JSON.stringify([tool, canonical(args)]);
}

export class ToolFailureGuard {
	private failures = new Map<string, number>();
	failed(tool: string, args: Record<string, unknown>): boolean {
		const key = toolRequestKey(tool, args), count = (this.failures.get(key) || 0) + 1;
		this.failures.set(key, count); return count >= 2;
	}
	succeeded(tool: string, args: Record<string, unknown>): void { this.failures.delete(toolRequestKey(tool, args)); }
}

export class ToolFeedbackError extends Error {
	constructor(readonly code: string, message: string, readonly recovery: Record<string, unknown>) { super(message); }
}

export function toolFeedback(error: unknown): { code: string; message: string; recovery?: Record<string, unknown> } {
	return { code: error instanceof ToolFeedbackError ? error.code : "tool_failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
		...(error instanceof ToolFeedbackError ? { recovery: error.recovery } : {}) };
}
