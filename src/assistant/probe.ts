import { randomUUID } from "node:crypto";
import { ASSISTANT_SCHEMA, parseAssistantStep } from "./capabilities";
import { structuredProfileKey } from "../providers/structured";
import type { ProviderProfile } from "../providers/profile";
import type { LLMProvider } from "../providers/adapters";
import { readingUsage } from "../reading/backend";

/** The expected answer exists only in the schema, not in the natural-language prompt. */
export async function probeReadingSchema(provider: LLMProvider, profile: ProviderProfile): Promise<NonNullable<ProviderProfile["structuredOutput"]>> {
	const record = { verified: false, key: structuredProfileKey(profile), testedAt: new Date().toISOString(), message: "" };
	if (!["openai", "openai-compatible", "lm-studio"].includes(profile.type)) return { ...record, message: "此接口尚未接入原生 Schema，继续使用本地结构校验。" };
	const expected = "schema-" + randomUUID(); const schema = structuredClone(ASSISTANT_SCHEMA);
	const final = schema.properties.step.anyOf.find(s => s.properties.tool.enum[0] === "final")!;
	(final.properties.arguments.properties as Record<string, unknown>).answer = { type: "string", enum: [expected] };
	try {
		const result = await provider.complete({ model: profile.model, maxTokens: 250, disableReasoning: true, messages: [{ role: "system", content: "This is a JSON capability test. Return the final step with answer=plain and citations=[]. If a response schema is provided, obey that schema instead. Do not call tools." }, { role: "user", content: "Run the format test." }], responseSchema: { name: "reading_capability_probe", schema } }, { timeoutMs: 30000 });
		const usage = readingUsage(result.raw?.usage); const step = parseAssistantStep(result.text);
		const verified = step.tool === "final" && step.arguments.answer === expected && Array.isArray(step.arguments.citations) && step.arguments.citations.length === 0;
		return { ...record, ...usage, verified, message: verified ? "原生 Schema 探测通过；仍逐轮执行本地校验。" : "接口未遵守本次 Schema，继续使用本地结构校验。" };
	} catch (error) { return { ...record, message: "Schema 探测未通过，继续使用本地校验：" + String(error).slice(0, 430) }; }
}
