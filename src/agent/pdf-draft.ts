import { readAuthorizedPdfText, type AuthorizedPdfSnapshot } from "./pdf-identity";
import type { AgentTool } from "./types";

export const pdfDraftKey = (snapshot: AuthorizedPdfSnapshot): string => "pdf-sha256:" + snapshot.sha256;
export function createBoundPdfReadTool(snapshot: AuthorizedPdfSnapshot, confirmedTitle: string, read = readAuthorizedPdfText): AgentTool {
	return {
		name: "pdf_read", description: "读取已由用户确认的固定 PDF 快照。overview 阅读前 3 页摘要级文字，page 按页码补读；不读取图像，不等同全文深读。必须先成功读取 overview。",
		parameters: { mode: "overview（默认）或 page", page: "mode=page 时的页码，从 1 开始" }, required: [],
		async execute(args, context) {
			const mode = String(args.mode || "overview"); if (!["overview", "page"].includes(mode)) throw new Error("mode 只能为 overview 或 page");
			const page = mode === "page" ? Number(args.page) : undefined;
			if (mode === "page" && (!Number.isInteger(page) || page! < 1)) throw new Error("请提供有效页码");
			const text = await read(snapshot, context.signal, page); context.signal.throwIfAborted();
			return { output: text, summary: `PDF ${mode}，${text.length} 字符`, receiptData: { paths: [pdfDraftKey(snapshot)], titles: [confirmedTitle], queryTerms: [mode] } };
		},
	};
}
