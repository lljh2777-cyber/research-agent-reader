import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type {
	ActivePracticeRun,
	DirectQueryRunToken,
	ProviderRuntimeEntry,
} from "../types/contracts";

export class DashboardLifecycleState {
	readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();
	readonly activeProcessStops = new Map<string, string>();
	readonly activePracticeRuns = new Map<string, ActivePracticeRun>();
	readonly directQueryRuns = new Map<string, DirectQueryRunToken>();
	readonly providerRuntimeState = new Map<string, ProviderRuntimeEntry>();
	providerEditorProfileId = "";

	clearTransientState(): void {
		this.activeProcesses.clear();
		this.activeProcessStops.clear();
		this.activePracticeRuns.clear();
		this.directQueryRuns.clear();
	}
}
