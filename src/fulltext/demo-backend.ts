import type { AcquisitionBackend } from "./service";
import type { AcquisitionRequest, AcquisitionCandidate } from "./contracts";

function pause(signal: AbortSignal, ms: number): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new Error("cancelled")); return; }
		const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("cancelled")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}
/** Never performs network I/O or creates a document. Exposed only by the development command. */
export class DemoAcquisitionBackend implements AcquisitionBackend {
	readonly mode = "demo" as const;
	async resolve(_request: AcquisitionRequest, signal: AbortSignal): Promise<void> { await pause(signal, 400); }
	async discover(request: AcquisitionRequest, signal: AbortSignal): Promise<AcquisitionCandidate[]> {
		await pause(signal, 400);
		if (request.scenario === "failure") throw new Error("simulated failure");
		if (request.scenario === "no_match") return [];
		return (request.scenario === "selection" ? ["one", "two"] : ["one"]).map(key => ({ id: "c-" + key, title: "全文获取流程示例（虚构） · " + key, providerId: "demo", version: "version_of_record" }));
	}
	async download(_candidate: AcquisitionCandidate, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<void> {
		for (let step = 1; step <= 10; step++) { await pause(signal, 200); progress(step * 1024, 10240); }
	}
	async verify(request: AcquisitionRequest, signal: AbortSignal): Promise<"valid" | "conflict"> { await pause(signal, 400); return request.scenario === "conflict" ? "conflict" : "valid"; }
}
