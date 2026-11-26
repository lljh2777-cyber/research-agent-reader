export interface AnswerText {
	text: string;
	complete: boolean;
	originalLength: number;
	keptLength: number;
	problem?: string;
}

export function queryAnswerErrorDetail(error: unknown): string {
	const detail = (error instanceof Error ? error.message : String(error)).trim().split(/[\r\n]/, 1)[0];
	if (/^(EACCES|EPERM)\b/.test(detail)) return `权限不足（${detail}）`;
	if (/^[A-Z][A-Z0-9_]+$/.test(detail)) return `系统错误（${detail}）`;
	return detail;
}

export async function chooseAnswerText(
	message: { content: string; contentLength?: number },
	readFile: () => Promise<string | null>,
): Promise<AnswerText> {
	const { content, contentLength = content.length } = message;
	const memory = { text: content, originalLength: contentLength, keptLength: content.length };
	if (content.length >= contentLength) return { ...memory, complete: true };

	let file: string | null;
	try {
		file = await readFile();
	} catch (error) {
		return { ...memory, complete: false, problem: `回答文件读取失败：${queryAnswerErrorDetail(error)}` };
	}

	if (file === null) return { ...memory, complete: false, problem: "回答文件不存在" };
	if (file.length > contentLength) return { ...memory, complete: false, problem: "回答文件长度超过记录的原文长度" };
	if (file.length <= content.length) return { ...memory, complete: false, problem: "回答文件长度未超过当前保留的正文长度" };

	const result = { text: file, originalLength: contentLength, keptLength: file.length };
	if (file.length === contentLength) return { ...result, complete: true };
	return { ...result, complete: false, problem: "回答文件只保留了部分原文" };
}
