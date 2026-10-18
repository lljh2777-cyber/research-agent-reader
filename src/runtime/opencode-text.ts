import type { CliTextAdapter, CliTextResult } from "./cli-text";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function isolatedConfigDirectory(): string {
	const directory = path.join(os.tmpdir(), `research-reader-opencode-${process.pid}`);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("OpenCode 配置缓存目录不受支持");
	return directory;
}

/** Shared by text generation and model-only discovery; discovery supplies no model. */
export function openCodeIsolatedEnvironment(extra: Record<string, unknown> = {}): NodeJS.ProcessEnv {
	return {
		XDG_CONFIG_HOME: isolatedConfigDirectory(), OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: "", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", permission: { "*": "ask" }, mcp: {}, plugin: [], instructions: [], ...extra }),
		OPENCODE_PERMISSION: '{"*":"ask"}', OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PRUNE: "true",
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
		OPENCODE_AUTO_SHARE: "false",
	};
}

export const OPENCODE_ANNOTATION_MODELS = [
	{ id: "opencode/step-5-preview-free", label: "Step-5-Preview" },
	{ id: "opencode/mimo-v2.6-flash-free", label: "mimo-v2.6-flash" },
] as const;

export function parseOpenCodeText(stdout: string, requestedModel: string): CliTextResult {
	const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
	if (events.some(event => event.type === "error" || event.type === "tool_use" || (event.part as Record<string, unknown> | undefined)?.type === "tool")) throw new Error("OpenCode 返回错误或尝试调用工具；解释未保存");
	const completed = events.filter(event => event.type === "step_finish");
	const part = completed[0]?.part as Record<string, unknown> | undefined;
	if (completed.length !== 1 || part?.reason !== "stop") throw new Error("OpenCode 未返回唯一完整解释（可能截断）；未保存");
	const sessions = new Set(events.map(event => event.sessionID).filter(value => typeof value === "string"));
	if (sessions.size > 1) throw new Error("OpenCode 返回多个会话；解释未保存");
	const models = new Set<string>();
	for (const event of events) {
		for (const record of [event, event.part as Record<string, unknown> | undefined]) {
			if (!record) continue;
			if (typeof record.model === "string") models.add(record.model);
			const identity = record.model && typeof record.model === "object" ? record.model as Record<string, unknown> : record;
			if (typeof identity.providerID === "string" && typeof identity.modelID === "string") models.add(`${identity.providerID}/${identity.modelID}`);
		}
	}
	if ([...models].some(model => model !== requestedModel)) throw new Error("OpenCode 返回的模型与所选模型不一致；解释未保存");
	const text = events.filter(event => event.type === "text").map(event => (event.part as Record<string, unknown> | undefined)?.text).filter(value => typeof value === "string").join("\n\n").trim();
	const tokens = part.tokens as Record<string, unknown> | undefined, cache = tokens?.cache as Record<string, unknown> | undefined;
	const usage: Record<string, number> = {};
	for (const [key, value] of Object.entries({ input_tokens: tokens?.input, output_tokens: tokens?.output, cache_read_input_tokens: cache?.read, cache_creation_input_tokens: cache?.write })) {
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
	}
	// run --format json emits parts, without the assistant's model metadata.
	// Record the explicit request without claiming an observed model identity.
	return { text, requestedModel, ...(models.size ? { reportedModel: [...models][0] } : {}), ...(Object.keys(usage).length ? { usage } : {}),
		...(typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0 ? { costUsd: part.cost } : {}) };
}

export const openCodeTextAdapter: CliTextAdapter = {
	label: "OpenCode", npmPackage: "opencode-ai", binName: "opencode",
	invocation: (model, system, user) => {
		if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error("OpenCode 模型必须填写 provider/model 的准确 ID");
		return {
			args: ["run", "--pure", "--format", "json", "--model", model, "--agent", "research-annotation", "--title", "Research Reader annotation", "--", user || ""],
			env: () => openCodeIsolatedEnvironment({
				// Keep the CLI's SDK bootstrap cache through requests/reloads.
				// The process working directory and conversation remain fresh.
				// Zen's free tier rejects requests when core tools are removed.
				// run without --auto rejects every permission request itself.
				model, agent: { "research-annotation": { mode: "primary", description: "Explain supplied text", prompt: system, model, permission: { "*": "ask" }, steps: 2 } },
			}),
		};
	},
	// Bun.stdin.text() can wait on an inherited Windows pipe even after EOF.
	// The complete query is positional; give the CLI a real null-device input.
	input: () => null,
	parse: parseOpenCodeText,
};
