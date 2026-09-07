import { createHash } from "node:crypto";
import type { ProviderProfile } from "./profile";

export function structuredProfileKey(profile: Pick<ProviderProfile, "type" | "baseUrl" | "model" | "secretId">): string {
	return createHash("sha256").update(JSON.stringify(["reading-schema-v1", profile.type, profile.baseUrl, profile.model, profile.secretId])).digest("hex");
}
export function supportsReadingSchema(profile: ProviderProfile): boolean {
	return ["openai", "openai-compatible", "lm-studio"].includes(profile.type) && profile.structuredOutput?.verified === true && profile.structuredOutput.key === structuredProfileKey(profile);
}
