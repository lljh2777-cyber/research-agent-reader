import { derivePassiveMineruMarkdown, validateModelNoteBodyMarkdown } from "../security/safe-markdown";
/** Render model text without automatic embeds, executable code blocks or raw HTML. */
export function safeLearningMarkdown(text: string, imageMessage = "未加载图像"): string {
	const passive = derivePassiveMineruMarkdown(text).replace(/!\[([^\]\n]*)\]\([^\n]*?\)/g, (_, alt: string) => "（图像：" + alt.replace(/[\[\]<>]/g, "") + "；" + imageMessage + "）");
	if (validateModelNoteBodyMarkdown(passive).length) throw new Error("回答包含无法安全显示的 Markdown"); return passive;
}
