import { contentHash } from "../retrieval/chunks";
import { curationNodeOutcomes } from "../reading/outcomes";
import type { ReadingSession } from "../reading/types";
import type { CurationReview, CurationRevision } from "../curation/types";
import type { AssistantAction, AssistantExecution } from "./types";

export const safeAssistantExportPath = (path: string): boolean => /^wiki\/qa\/[^\\\r\n]+\.md$/.test(path) && !path.split("/").some(p => p === ".." || p === "." || !p);

/** Read exact business receipts. Similar content or temporal proximity never proves a handoff succeeded. */
export async function resolveAssistantAction(session: ReadingSession, action: AssistantAction, deps: {
	review(id: string): CurationReview | undefined; revisions(): Iterable<CurationRevision>; readExport(path: string): Promise<string>;
}): Promise<AssistantExecution | undefined> {
	const e = action.execution; if (!e) return undefined;
	const result = (state: AssistantExecution["state"], detail: string, path?: string): AssistantExecution => ({ ...e, state, detail, ...(path ? { path } : {}) });
	if (action.kind === "advance" && e.nodeId) {
		const node = session.nodes.find(n => n.id === e.nodeId && n.branchId === null && n.parentId === action.nodeIds[0]);
		if (!node) return result("needs-review", "关联的主线节点已缺失或关系发生变化，请查看阅读记录");
		if (node.status === "done") return result("succeeded", "主线讲解已完成：" + node.title);
		if (node.status === "failed" || node.status === "interrupted") return result(node.status, node.error || "讲解未完成，可到该节点重试");
		return result("running", "正在生成关联的主线节点");
	}
	if (action.kind === "curation" && e.reviewId) {
		const review = deps.review(e.reviewId);
		if (!review || review.context.sessionId !== session.id) return result("needs-review", "关联的整理记录已缺失或不属于本会话");
		const outcomes = curationNodeOutcomes(session.id, review.context.nodeIds[0], [review], deps.revisions());
		const labels = outcomes.map(o => o.label);
		const applied = review.suggestions.filter(s => s.decision === "applied").length;
		const pending = review.suggestions.filter(s => s.decision === "pending").length;
		if (labels.some(s => ["需复查", "待恢复", "已撤销"].includes(s))) return result("needs-review", labels.join("；") + "，请查看修订记录", review.context.target.path);
		if (review.state === "generating") return result("running", "正在生成整理建议", review.context.target.path);
		if (review.state === "failed" || review.state === "interrupted") return result(review.state, review.error || "整理未完成，请重试", review.context.target.path);
		if (labels.includes("已采纳")) return result(pending ? "waiting" : "succeeded", `已采纳 ${applied} 项；${pending} 项待审阅`, review.context.target.path);
		if (!pending && !applied) return result("succeeded", review.suggestions.length ? "本批建议已处理，全部忽略；未修改笔记" : "本批没有可应用的修改；未写入笔记", review.context.target.path);
		return result("waiting", review.suggestions.length ? `建议已生成，${pending} 项待审阅；尚无生效的笔记修订` : "建议已生成，没有可应用的修改；尚未写入笔记", review.context.target.path);
	}
	if (action.kind === "export" && e.path && e.hash) {
		if (!safeAssistantExportPath(e.path)) return result("needs-review", "导出记录路径不在学习笔记目录");
		let raw: string; try { raw = await deps.readExport(e.path); } catch { return result(e.state === "running" ? "interrupted" : "needs-review", "未能读取关联的导出文件，请检查是否已保存或被移动"); }
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] || "";
		let owner: unknown; try { owner = JSON.parse(/^reading_session: (.+)$/m.exec(frontmatter)?.[1] || "null"); } catch { /* An edited header needs review. */ }
		if (owner !== session.id || contentHash(raw) !== e.hash) return result("needs-review", "导出文件已变化，请核对当前内容；保留手工编辑");
		return result(e.warning ? "needs-review" : "succeeded", e.warning || (e.reused ? "已复用已有学习笔记" : "学习笔记已保存"));
	}
	return e;
}
