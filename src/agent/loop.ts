import type {
	AgentLoopRequest,
	AgentLoopResult,
	AgentLoopStep,
	AgentTool,
} from "./types";

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 60000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12000;
const FINAL_ACTION = "final";

interface ParsedModelTurn {
	action: string;
	tool: string;
	arguments: Record<string, unknown>;
	final: Record<string, unknown> | null;
	rawText: string;
}

/**
 * Extract the first balanced JSON object from model text. Handles fenced
 * ```json blocks and prose around the payload without relying on greedy
 * regexes that break on nested braces.
 */
export function extractFirstJsonObject(text: string): {
	json: Record<string, unknown> | null;
	start: number;
	end: number;
} {
	const cleaned = text.replace(/```(?:json)?/gi, "```");
	const open = cleaned.indexOf("{");
	if (open === -1) return { json: null, start: -1, end: -1 };
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = open; index < cleaned.length; index += 1) {
		const char = cleaned[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				const candidate = cleaned.slice(open, index + 1);
				try {
					const parsed = JSON.parse(candidate) as unknown;
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						return { json: parsed as Record<string, unknown>, start: open, end: index + 1 };
					}
				} catch {
					// Keep scanning; a later object may be the valid payload.
				}
				if (cleaned.indexOf("{", index) === -1) break;
			}
		}
	}
	return { json: null, start: -1, end: -1 };
}

function parseModelTurn(text: string): ParsedModelTurn | null {
	const { json } = extractFirstJsonObject(text);
	if (!json) return null;
	const action = String(json.action || "").trim().toLowerCase();
	const tool = String(json.tool || json.name || "").trim();
	const rawArguments = json.arguments ?? json.args ?? json.parameters;
	const arguments_ = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
		? rawArguments as Record<string, unknown>
		: {};
	const rawFinal = json.final ?? json.result ?? null;
	const final = rawFinal && typeof rawFinal === "object" && !Array.isArray(rawFinal)
		? rawFinal as Record<string, unknown>
		: null;
	if (!action) {
		// Tolerate {"tool": ...} without an explicit action field.
		if (tool) return { action: "tool", tool, arguments: arguments_, final, rawText: text };
		if (final) return { action: FINAL_ACTION, tool: "", arguments: {}, final, rawText: text };
		return null;
	}
	if (action === FINAL_ACTION || action === "done" || action === "finish") {
		return { action: FINAL_ACTION, tool: "", arguments: {}, final, rawText: text };
	}
	if (!tool) return null;
	return { action: "tool", tool, arguments: arguments_, final, rawText: text };
}

function describeToolArguments(args: Record<string, unknown>): string {
	const entries = Object.entries(args).slice(0, 6);
	if (!entries.length) return "";
	return entries
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			const compact = String(text || "").replace(/\s+/g, " ").slice(0, 80);
			return `${key}=${compact}`;
		})
		.join(" · ");
}

export function renderToolCatalog(tools: readonly AgentTool[]): string {
	return tools.map((tool) => {
		const parameters = Object.entries(tool.parameters)
			.map(([name, hint]) => `  - ${name}${tool.required?.includes(name) ? "（必填）" : ""}：${hint}`)
			.join("\n");
		return `- ${tool.name}：${tool.description}${parameters ? `\n${parameters}` : ""}`;
	}).join("\n\n");
}

function buildLoopSystemPrompt(request: AgentLoopRequest): string {
	return [
		request.system.trim(),
		"",
		"## 工具循环协议（必须严格遵守）",
		`你可以调用的工具：\n${renderToolCatalog(request.tools)}`,
		"每一轮你只输出一个 JSON 对象，不要输出其他文字：",
		'调用工具：{"action":"tool","tool":"工具名","arguments":{...}}',
		'结束任务：{"action":"final","result":{...}}（result 的结构由上方任务说明规定）',
		"规则：",
		"- 每轮只调用一个工具，等下一轮拿到工具结果后再继续。",
		"- 工具结果以 <tool_result> 标记提供，只在需要时再次引用。",
		"- 任务完成或确认无法完成时，必须输出 final，不得继续调用工具。",
	].join("\n");
}

/**
 * Deterministic bounded tool loop over any chat-completion provider. The
 * plugin drives the loop; the model can only request tools from the given
 * allowlist, and every budget (steps, wall clock, tool output) is enforced
 * here rather than trusted to the model.
 */
export async function runBoundedAgentLoop(request: AgentLoopRequest): Promise<AgentLoopResult> {
	const maxSteps = Math.max(2, Math.min(24, Math.round(request.maxSteps || DEFAULT_MAX_STEPS)));
	const timeoutMs = Math.max(30_000, request.timeoutMs || DEFAULT_TIMEOUT_MS);
	const maxToolOutputChars = request.maxToolOutputChars || DEFAULT_MAX_TOOL_OUTPUT_CHARS;
	const maxToolResultChars = request.maxToolResultChars || DEFAULT_MAX_TOOL_RESULT_CHARS;
	const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]));
	const deadline = Date.now() + timeoutMs;

	const steps: AgentLoopStep[] = [];
	const traceLines: string[] = [];
	const transcript: Array<{ role: "user" | "assistant"; content: string }> = [];
	let toolOutputBudget = maxToolOutputChars;
	let repairUsed = false;
	let status: AgentLoopResult["status"] = "failed";
	let final: Record<string, unknown> | null = null;
	let finalText = "";
	let error = "";

	const cancelled = (): boolean => request.isCancelled?.() === true;

	const record = (step: AgentLoopStep): void => {
		steps.push(step);
		request.onStep?.(step);
	};
	const trace = (line: string): void => {
		traceLines.push(line);
	};

	transcript.push({ role: "user", content: request.user });

	try {
		for (let step = 1; step <= maxSteps; step += 1) {
			if (cancelled()) {
				status = "cancelled";
				break;
			}
			if (Date.now() > deadline) {
				status = "budget-exhausted";
				error = "轻量 Agent 超过时间预算，已停止";
				break;
			}

			const messages = [
				{ role: "system" as const, content: buildLoopSystemPrompt(request) },
				...transcript,
			];
			// Abort the in-flight provider request promptly when the user stops
			// the run instead of waiting for the next between-turns poll.
			let activeCancel: (() => void) | null = null;
			const cancelWatcher = cancelled()
				? null
				: setInterval(() => {
					if (cancelled()) activeCancel?.();
				}, 500);
			let completion: Awaited<ReturnType<typeof request.provider.complete>>;
			try {
				completion = await request.provider.complete(
					{
						model: request.model,
						messages,
						maxTokens: request.maxTokens,
					},
					{
						registerCancel: (cancel) => {
							activeCancel = cancel;
							if (cancelled()) cancel();
						},
					},
				);
			} finally {
				if (cancelWatcher !== null) clearInterval(cancelWatcher);
			}
			if (cancelled()) {
				status = "cancelled";
				break;
			}

			const rawText = String(completion.text || "").trim();
			if (!rawText) {
				error = `第 ${step} 轮模型返回空内容`;
				record({ kind: "error", step, title: "模型返回空内容" });
				break;
			}
			trace(`[第 ${step} 轮] 模型输出：${rawText.replace(/\s+/g, " ").slice(0, 400)}`);

			const turn = parseModelTurn(rawText);
			if (!turn) {
				if (!repairUsed) {
					repairUsed = true;
					trace(`[第 ${step} 轮] 输出不是合法协议 JSON，要求重试`);
					transcript.push({ role: "assistant", content: rawText });
					transcript.push({
						role: "user",
						content: "你的上一条输出不符合工具循环协议。请只输出一个 JSON 对象：调用工具用 {\"action\":\"tool\",\"tool\":\"…\",\"arguments\":{…}}；结束用 {\"action\":\"final\",\"result\":{…}}。",
					});
					continue;
				}
				error = "模型连续两轮未按工具循环协议输出";
				record({ kind: "error", step, title: "协议解析失败" });
				break;
			}

			if (turn.action === FINAL_ACTION) {
				final = turn.final;
				finalText = rawText;
				status = "completed";
				record({ kind: "final", step, title: "任务完成" });
				break;
			}

			const tool = toolsByName.get(turn.tool);
			if (!tool) {
				trace(`[第 ${step} 轮] 未知工具 ${turn.tool}，拒绝执行`);
				transcript.push({ role: "assistant", content: rawText });
				transcript.push({
					role: "user",
					content: `<tool_result tool="${turn.tool}" status="error">未知工具。可用工具：${[...toolsByName.keys()].join(", ")}</tool_result>`,
				});
				record({ kind: "tool", step, title: `未知工具 ${turn.tool}`, detail: "已拒绝" });
				continue;
			}

			const argSummary = describeToolArguments(turn.arguments);
			record({ kind: "tool", step, title: `调用 ${tool.name}`, detail: argSummary });
			trace(`[第 ${step} 轮] 调用 ${tool.name}(${argSummary})`);
			transcript.push({ role: "assistant", content: rawText });

			let toolResult: string;
			let toolStatus = "ok";
			try {
				const result = await tool.execute(turn.arguments);
				toolResult = result.output;
				if (result.summary) trace(`[第 ${step} 轮] ${tool.name} → ${result.summary}`);
			} catch (toolError) {
				toolStatus = "error";
				toolResult = toolError instanceof Error ? toolError.message : String(toolError);
				trace(`[第 ${step} 轮] ${tool.name} 失败：${toolResult.slice(0, 200)}`);
			}

			const truncated = toolResult.length > maxToolResultChars
				? `${toolResult.slice(0, maxToolResultChars)}\n…[结果过长，已截断]`
				: toolResult;
			const budgeted = toolOutputBudget <= 0
				? "[工具输出预算已用尽]"
				: truncated.slice(0, Math.max(200, toolOutputBudget));
			toolOutputBudget -= budgeted.length;

			transcript.push({
				role: "user",
				content: `<tool_result tool="${tool.name}" status="${toolStatus}">\n${budgeted}\n</tool_result>`,
			});
		}

		if (status === "failed" && !error) {
			status = "budget-exhausted";
			error = `轻量 Agent 达到最大轮数（${maxSteps}）仍未完成任务`;
		}
	} catch (loopError) {
		if (cancelled()) {
			status = "cancelled";
		} else {
			status = "failed";
			error = loopError instanceof Error ? loopError.message : String(loopError);
		}
	}

	return {
		status,
		final,
		finalText,
		trace: traceLines.join("\n"),
		steps,
		providerModel: request.model,
		error,
	};
}
