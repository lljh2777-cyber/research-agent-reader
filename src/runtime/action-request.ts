import type {
	DashboardAction,
	DashboardActionOptions,
} from "../actions";

interface StructuredActionRequest {
	kind: "dashboard-action-request";
	version: 1;
	action: string;
	request: string;
	options: DashboardActionOptions;
	toolConfig?: {
		mineruExecutable?: string;
		mineruBaseUrl?: string;
	};
}

export function serializeActionRequest(
	action: DashboardAction,
	request: string,
	options: DashboardActionOptions,
	mineruExecutable = "",
	mineruBaseUrl = "",
): string {
	if (action.id !== "paper-ingest" && action.id !== "pdf-xray") {
		return request;
	}
	const payload: StructuredActionRequest = {
		kind: "dashboard-action-request",
		version: 1,
		action: action.id,
		request,
		options,
	};
	if (action.id === "paper-ingest") {
		payload.toolConfig = {
			mineruExecutable: mineruExecutable.trim(),
			mineruBaseUrl: mineruBaseUrl.trim(),
		};
	}
	return JSON.stringify(payload);
}
