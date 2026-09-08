const string = { type: "string" };
const strings = { type: "array", items: string };
/** The executable registry, model catalog and output schema share these definitions. */
export const ASSISTANT_CAPABILITIES = [
	{ name: "reading_context", label: "读取阅读进度", description: "列出当前论文的节点与个人理解状态。state 为 all/understood/revisit/question/unmarked；offset 从 0 开始分页，每次 12 项。", properties: { state: { type: "string", enum: ["all", "understood", "revisit", "question", "unmarked"] }, offset: { type: "integer" } } },
	{ name: "read_node", label: "读取学习节点", description: "读取当前会话中的一个已完成节点及其原文引用编号。回答是学习记录，不是事实证据。", properties: { nodeId: string } },
	{ name: "search_knowledge", label: "检索正式知识", description: "查询正式知识库。返回候选编号、路径和短预览，必须调用 read_evidence 读取后才可引用。", properties: { query: string } },
	{ name: "search_learning", label: "查找历史学习", description: "寻找与指定节点相关的其他会话和导出学习记录。结果不能作为论文事实依据。", properties: { nodeId: string } },
	{ name: "read_evidence", label: "核对原文依据", description: "读取 read_node 或 search_knowledge 实际返回的编号，最多三个。首版助手读取文字，图像需在原文窗对照，不得宣称图表核验。", properties: { ids: strings } },
	{ name: "outcomes", label: "查看整理记录", description: "读取指定节点的已导出、待审阅、已采纳或复查状态。", properties: { nodeId: string } },
	{ name: "prepare_action", label: "准备后续操作", description: "准备 curation/export/advance 操作卡，不写入笔记也不自动生成。nodeIds 最多三个；curation 的 target 使用 search_knowledge 返回的候选 id（K: 开头），也接受完整 path；export 的 scope 为 node/branch/session，其余用 node；无 target 时填空字符串。用户点击卡片衔接现有操作。", properties: { kind: { type: "string", enum: ["curation", "export", "advance"] }, nodeIds: strings, target: string, scope: { type: "string", enum: ["node", "branch", "session"] } } },
	{ name: "final", label: "完成回答", description: "返回简体中文回答与引用编号。只能引用 read_evidence 已读取的依据；学习记录不能充当论文证据。操作卡仅已准备，不能声称已写入或已继续讲解。", properties: { answer: string, citations: strings } },
] as const;
export type AssistantToolName = typeof ASSISTANT_CAPABILITIES[number]["name"];
export const ASSISTANT_SCHEMA = {
	type: "object", additionalProperties: false, required: ["step"], properties: { step: { anyOf: ASSISTANT_CAPABILITIES.map(c => ({
		type: "object", additionalProperties: false, required: ["tool", "arguments"], properties: { tool: { type: "string", enum: [c.name] }, arguments: { type: "object", additionalProperties: false, properties: c.properties, required: Object.keys(c.properties) } },
	})) } },
};
export function parseAssistantStep(text: string): { tool: AssistantToolName; arguments: Record<string, unknown> } {
	let value;
	try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new Error("助手返回了无效 JSON，未执行该轮操作，可重试"); }
	const step = value?.step; const capability = ASSISTANT_CAPABILITIES.find(c => c.name === step?.tool);
	if (!capability || !step.arguments || typeof step.arguments !== "object" || Array.isArray(step.arguments) || Object.keys(value).some(k => k !== "step") || Object.keys(step).some(k => !["tool", "arguments"].includes(k))) throw new Error("助手返回了未知操作或无效结构");
	const properties = capability.properties as Record<string, { type: string }>;
	if (Object.keys(step.arguments).some(k => !Object.prototype.hasOwnProperty.call(properties, k))) throw new Error("助手操作包含未授权参数");
	for (const [key, rule] of Object.entries(properties)) {
		const v = step.arguments[key];
		if (rule.type === "string" ? typeof v !== "string" || v.length > (key === "answer" ? 12000 : 1000) : rule.type === "integer" ? !Number.isInteger(v) || v < 0 || v > 10000 : !Array.isArray(v) || v.length > 20 || v.some(i => typeof i !== "string" || i.length > 300)) throw new Error("助手参数无效：" + key);
	}
	return step;
}
