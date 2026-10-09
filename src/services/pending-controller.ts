import type { PendingResult } from "./pending-center";
export class PendingController {
	state: { phase: "idle" | "loading" | "ready" | "failed" | "cancelled"; result?: PendingResult; error: string } = { phase: "idle", error: "" };
	private controller?: AbortController;
	private pending?: Promise<void>;
	private closed = false;
	get busy(): boolean { return Boolean(this.pending); }
	constructor(private read: (signal: AbortSignal) => Promise<PendingResult>, private changed: () => void) {}
	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve(); if (this.pending) return this.pending;
		const controller = this.controller = new AbortController(); this.state = { ...this.state, phase: "loading", error: "" };
		const run = Promise.resolve().then(async () => {
			try { controller.signal.throwIfAborted(); const result = await this.read(controller.signal); if (!this.closed && !controller.signal.aborted) this.state = { phase: "ready", result, error: "" }; }
			catch (error) { if (!this.closed && !controller.signal.aborted) this.state = { ...this.state, phase: "failed", error: error instanceof Error ? error.message : String(error) }; }
			finally { this.pending = undefined; this.controller = undefined; if (!this.closed) this.changed(); }
		});
		this.pending = run; this.changed(); return run;
	}
	cancel(): void { if (!this.closed && this.controller) { this.controller.abort(); this.state = { ...this.state, phase: "cancelled", error: "" }; this.changed(); } }
	dispose(): void { this.closed = true; this.controller?.abort(); }
}
