import type { CliTextAdapter, CliTextResult } from "./cli-text";

export const CODEBUDDY_ANNOTATION_MODEL = "step-5-preview";
// This CLI injects additional workflow tools even into an empty custom agent.
// Whole-tool denials also remove them from its advertised/request tool list.
const CODEBUDDY_DENIED_TOOLS = ["Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "ToolSearch", "WebSearch", "WebFetch", "Skill", "Task", "TaskOutput", "TaskStop", "TodoWrite", "SendUserMessage", "SendMessage", "EnterPlanMode", "ExitPlanMode", "TeamCreate", "TeamDelete", "NotebookEdit", "REPL", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "SkillManage", "AskUserQuestion", "AskUserForStructuredInput", "StructuredOutput", "DeferExecuteTool", "LSP", "ImageGen", "LibraryUpload", "VideoGen", "AudioTranscribe", "Artifact", "ArtifactControl", "EnterWorktree", "LeaveWorktree", "CronCreate", "CronDelete", "CronList", "WeChatReply", "WeComReply", "PushNotification", "ReportFindings", "ComputerUse", "ListMcpResources", "ReadMcpResource", "WaitForMcpServers", "Workflow", "Monitor", "A2AGetAgentCard", "A2ASendMessage", "A2AGetTask", "A2ACancelTask", "MessageColleague", "SpeakInChannel", "ChannelTasks", "CreateColleague", "CreateChannel", "ListColleagues"];

/** Claude-style NDJSON is parsed only after successful process-tree closure. */
export function parsePrintResult(stdout: string, requestedModel: string): CliTextResult {
	const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
	const results = events.filter(event => event.type === "result");
	if (results.length !== 1) throw new Error("CLI 未返回唯一的完成结果；解释未保存");
	const final = results[0];
	if (final.is_error || final.subtype !== "success") throw new Error(`CLI 未完成解释：${String(final.result || final.subtype || "未知错误").slice(0, 800)}`);
	const models = new Set<string>();
	for (const event of events) {
		const message = event.message as Record<string, unknown> | undefined;
		if (event.type === "system" && event.subtype === "init") {
			if (Array.isArray(event.tools) && event.tools.length) throw new Error(`CLI 未关闭全部工具（${event.tools.map(String).join(", ").slice(0, 500)}）；解释未保存`);
			if (typeof event.model === "string") models.add(event.model);
		}
		if (event.type === "assistant" && message) {
			if (message.stop_reason === "max_tokens" || message.stop_reason === "length") throw new Error("CLI 输出达到上限，解释不完整；未保存");
			if (typeof message.model === "string") models.add(message.model);
			if (Array.isArray(message.content) && message.content.some(block => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use")) throw new Error("CLI 尝试调用工具；解释未保存");
		}
	}
	if (final.modelUsage && typeof final.modelUsage === "object") for (const model of Object.keys(final.modelUsage)) models.add(model);
	if ([...models].some(model => model.toLowerCase() !== requestedModel.toLowerCase())) throw new Error(`CLI 返回的模型与所选 ${requestedModel} 不一致；解释未保存`);
	const rawUsage = final.usage && typeof final.usage === "object" ? final.usage as Record<string, unknown> : {};
	const usage: Record<string, number> = {};
	for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
		const value = rawUsage[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
	}
	return {
		text: typeof final.result === "string" ? final.result.trim() : "", requestedModel,
		...([...models].length ? { reportedModel: [...models][0] } : {}),
		...(Object.keys(usage).length ? { usage } : {}),
		...(typeof final.total_cost_usd === "number" && Number.isFinite(final.total_cost_usd) && final.total_cost_usd >= 0 ? { costUsd: final.total_cost_usd } : {}),
	};
}

export const codeBuddyTextAdapter: CliTextAdapter = {
	label: "CodeBuddy", npmPackage: "@tencent-ai/codebuddy-code", binName: "codebuddy",
	invocation: (model, system) => ({
		args: ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--max-turns", "1", "--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true, autoUpdates: false, permissions: { deny: ["*", ...CODEBUDDY_DENIED_TOOLS] } }), "--disallowedTools", CODEBUDDY_DENIED_TOOLS.join(","), "--agents", JSON.stringify({ "research-annotation": { description: "Explain supplied text", prompt: system, tools: [], model } }), "--agent", "research-annotation", "--system-prompt", system],
		env: { DISABLE_AUTOUPDATER: "1", CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1" },
	}),
	parse: parsePrintResult,
};
