export class SourceError extends Error {
	constructor(readonly code: string, message: string, readonly outcome: "failed" | "no_match" | "conflict" = "failed") { super(message); this.name = "SourceError"; }
}
export function sourceFailure(error: unknown): SourceError { return error instanceof SourceError ? error : new SourceError("source_error", "来源请求或文件处理未完成，请检查网络与存储后重试"); }
