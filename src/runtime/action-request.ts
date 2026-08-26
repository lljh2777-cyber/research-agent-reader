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

const ROOT_ISOLATION_INSTRUCTION = [
	"链接边界：papers/、wiki/、Clippings/ 是相互隔离的主目录；",
	"不得在任意两个主目录之间创建 Obsidian wikilink、Markdown link 或 embed。",
	"如需记录另一主目录中的路径，请使用不带链接的行内代码。",
].join("");

function withRootIsolationInstruction(action: DashboardAction, request: string): string {
	const trimmed = request.trim();
	if (!action.writes || action.localView) return trimmed;
	return [trimmed, ROOT_ISOLATION_INSTRUCTION].filter(Boolean).join("\n\n");
}

export function serializeActionRequest(
	action: DashboardAction,
	request: string,
	options: DashboardActionOptions,
	mineruExecutable = "",
	mineruBaseUrl = "",
): string {
	const guardedRequest = withRootIsolationInstruction(action, request);
	if (action.id !== "paper-ingest" && action.id !== "pdf-xray") {
		return guardedRequest;
	}
	const payload: StructuredActionRequest = {
		kind: "dashboard-action-request",
		version: 1,
		action: action.id,
		request: guardedRequest,
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
