import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
	DirectQueryRunToken,
	ProviderRuntimeEntry,
} from "../types/contracts";

export class DashboardLifecycleState {
	readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
	readonly activeProcessStops = new Map<string, string>();
	readonly directQueryRuns = new Map<string, DirectQueryRunToken>();
	readonly providerRuntimeState = new Map<string, ProviderRuntimeEntry>();
	providerEditorProfileId = "";

	clearTransientState(): void {
		this.activeProcesses.clear();
		this.activeProcessStops.clear();
		this.directQueryRuns.clear();
	}
}
