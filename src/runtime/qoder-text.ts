import type { CliTextAdapter } from "./cli-text";
import { parsePrintResult } from "./codebuddy-text";

export const QODER_ANNOTATION_MODEL = "Qwen3.8-Flash";
export const qoderTextAdapter: CliTextAdapter = {
	label: "Qoder CLI CN", npmPackage: "@qodercn-ai/qoderclicn", binName: "qoderclicn",
	invocation: (model, system, user) => ({
		args: ["-p", "--model", model, "--output-format", "stream-json", "--tools", "", "--permission-mode", "dont_ask", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--max-model-request-retries", "0", "--max-output-tokens", "2048", "--thinking", "disabled", "--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true, permissions: { deny: ["*"] } }), "--agents", JSON.stringify({ "research-annotation": { description: "Explain supplied text", prompt: system, tools: [], model } }), "--agent", "research-annotation", "--system-prompt", system, "--", user || ""],
	}),
	input: () => "",
	// Qoder reports provider accounting keys (e.g. qfmodel) in modelUsage.
	// The init and assistant records report the selected, verifiable model.
	parse: (stdout, model) => parsePrintResult(stdout, model, false),
};
