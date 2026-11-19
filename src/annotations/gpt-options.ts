export const GPT_ANNOTATION_MODELS = ["gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol"] as const;
export interface GptChoices { model?: string; speed?: string; effort?: string; search?: boolean; }
export function supportsGptAnnotations(model: string): boolean {
	return GPT_ANNOTATION_MODELS.some(id => id === model);
}
export function gptOptions(model: string) {
	const sol = model.endsWith("-sol");
	return {
		speeds: sol ? ["default", "fast", "ultrafast"] : ["default", "fast"],
		efforts: [...(sol ? [] : ["none"]), "low", "medium", "high", "xhigh", "max"],
	};
}
export function gptAnnotationRequest(model: string, depth: string | undefined, choices?: GptChoices) {
	const { speeds, efforts } = gptOptions(model);
	const speed = choices?.speed || "default", effort = choices?.effort || (depth === "context" ? "high" : "medium");
	if (!supportsGptAnnotations(model) || !speeds.includes(speed) || !efforts.includes(effort)) throw new Error("当前 GPT 模型不支持所选挡位");
	return { service_tier: speed, reasoning: { effort }, ...(choices?.search ? { tools: [{ type: "web_search" as const }] } : {}) };
}
