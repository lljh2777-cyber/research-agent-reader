import { randomUUID } from "node:crypto";
import { learningAncestors } from "../learning/graph";
import { safeLearningMarkdown } from "../learning/presentation";
import type { SourceStorage } from "../sources/storage";
import { topicDigest } from "./contracts";
import { UNDERSTANDING_LABELS, type TopicStudy, type TopicStudyNode } from "./study";
import type { TopicStudyService } from "./study-service";
import { TOPIC_EXPORT_ROOT } from "./export-path";
export { TOPIC_EXPORT_ROOT } from "./export-path";

export type TopicExportScope = "node" | "branch" | "session";
export interface TopicExportReview { topicId: string; route: string; head: string; scope: TopicExportScope; nodeId: string; text: string; digest: string; path: string; existing: "none" | "same" | "changed"; count: number; omitted: number; }
const line = (text: string): string => safeLearningMarkdown(text).trim().replace(/\s+/g, " ");
export function topicExportNodes(study: TopicStudy, scope: TopicExportScope, nodeId: string): { nodes: TopicStudyNode[]; omitted: number } {
	if (!["node", "branch", "session"].includes(scope)) throw new Error("导出范围无效");
	const selected = study.nodes.find(n => n.id === nodeId);
	if (scope !== "session" && !selected) throw new Error("请先选择导出节点");
	const candidates = study.nodes.filter(n => scope === "session" || scope === "node" && n.id === nodeId || scope === "branch" && n.branchId === selected!.branchId);
	const nodes = candidates.filter(n => n.status === "done"); if (!nodes.length) throw new Error("所选范围没有已返回的讲解");
	return { nodes, omitted: candidates.length - nodes.length };
}
export function topicExportContent(study: TopicStudy, scope: TopicExportScope, nodeId: string): { text: string; count: number; omitted: number } {
	const { nodes, omitted } = topicExportNodes(study, scope, nodeId), body = ["# " + line(study.session.intent.topic) + " · 主题学习记录", "",
		"本文保存模型一般知识讲解与用户自评，未据此核验论文、代码或网页。用户标记已理解不代表事实正确、科学审阅通过或考试结果。", "",
		"学习目标：" + line(study.session.intent.goal), "", "已有基础：" + line(study.session.intent.background || "未填写"), "",
		`本次范围：${scope === "node" ? "选中节点" : scope === "branch" ? "当前主线／支线（不含其他分支）" : "完整学习记录"}；包含 ${nodes.length} 条已返回讲解，跳过 ${omitted} 条未完成节点。未发送的问题不在导出范围内。`, "",
		"## 固定学习路线", "", ...study.session.plan!.modules.map((m, i) => `${i + 1}. ${line(m.title)}：${line(m.objective)}`), ""];
	for (const n of nodes) {
		const trail = learningAncestors(study.nodes, n.id).map(parent => {
			if (!parent.branchId) return `主线第 ${study.graph.mainIds.indexOf(parent.id) + 1} 单元`;
			const index = study.graph.branches.findIndex(b => b.id === parent.branchId); return `支线 ${index + 1} 第 ${study.graph.branches[index].nodeIds.indexOf(parent.id) + 1} 轮`;
		}).join(" → "), mark = n.understanding;
		body.push("## " + line(n.title), "", "学习位置：" + trail, "", "本轮问题：" + line(n.question), "",
			"用户理解标记：" + UNDERSTANDING_LABELS[mark?.state || "unmarked"] + (mark ? "（用户手动标记，" + mark.date + "）" : ""), "",
			"### 模型一般知识讲解（未核验）", "", safeLearningMarkdown(n.content).trim(), "", "### 请求与用量记录", "");
		for (const attempt of n.attempts) {
			const u = attempt.result?.usage;
			const status = attempt.result ? { done: "已返回", failed: "失败", cancelled: "已取消" }[attempt.result.status] : "未完成";
			body.push(`- ${line(attempt.provider)} / ${line(attempt.model)}；${attempt.date}；${status}；输入 ${u?.input ?? "未报告"}，输出 ${u?.output ?? "未报告"}，缓存输入 ${u?.cachedInput ?? "未报告"} token；祖先 ${attempt.contextIds.length} 轮，省略 ${attempt.omitted} 轮。`);
		}
		body.push("", "未报告不等于零消耗；失败与取消尝试仍保留在学习历史中。", "");
	}
	const fields = { title: study.session.intent.topic + " · 主题学习记录", type: "topic-learning-record", knowledge_source: "model-knowledge", verification_status: "unverified", topic_session: study.session.id,
		topic_route_digest: study.routeDigest, topic_history_head: study.head, topic_export_scope: scope,
		topic_export_nodes: nodes.map(n => ({ id: n.id, parent: n.parentId, branch: n.branchId, answer: n.attempts.slice(-1)[0]!.requestId, understanding: n.understanding || null })) };
	const text = ["---", ...Object.entries(fields).map(([k, v]) => k + ": " + JSON.stringify(v)), "---", "", body.join("\n")].join("\n");
	if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("学习记录导出超过 16 MiB，请缩小范围");
	return { text, count: nodes.length, omitted };
}
/** Create-only exports. Re-check the exact history shown by the preview before saving. */
export class TopicStudyExports {
	constructor(readonly service: TopicStudyService, readonly storage: SourceStorage) {}
	async review(topicId: string, route: string, head: string, scope: TopicExportScope, nodeId: string): Promise<TopicExportReview> {
		const s = await this.service.get(topicId, route, head), { text, count, omitted } = topicExportContent(s, scope, nodeId), digest = topicDigest(text);
		const path = `${TOPIC_EXPORT_ROOT}/${topicId}/${digest}.md`, existing = await this.storage.read(path, 16 * 1024 * 1024);
		return { topicId, route, head, scope, nodeId, text, digest, path, existing: existing ? Buffer.from(existing).equals(Buffer.from(text)) ? "same" : "changed" : "none", count, omitted };
	}
	async save(review: TopicExportReview, copy = false, signal?: AbortSignal): Promise<{ path: string; reused: boolean }> {
		signal?.throwIfAborted();
		const current = await this.review(review.topicId, review.route, review.head, review.scope, review.nodeId);
		if (current.digest !== review.digest || current.text !== review.text || current.path !== review.path) throw new Error("导出预览已变化，请重新预览");
		if (!copy && current.existing === "changed") throw new Error("已有导出已被编辑或未完整保存；原文件保留，可明确另存副本");
		if (!copy && current.existing === "same") return { path: current.path, reused: true };
		for (const directory of ["wiki", "wiki/qa", TOPIC_EXPORT_ROOT, `${TOPIC_EXPORT_ROOT}/${current.topicId}`]) { signal?.throwIfAborted(); await this.storage.mkdir(directory); }
		const target = copy ? current.path.replace(/\.md$/, "-" + randomUUID() + ".md") : current.path;
		await this.service.get(current.topicId, current.route, current.head); signal?.throwIfAborted();
		try { await this.storage.create(target, Buffer.from(current.text)); }
		catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || copy) throw e; }
		const written = await this.storage.read(target, 16 * 1024 * 1024);
		if (!written || !Buffer.from(written).equals(Buffer.from(current.text))) throw new Error("导出写入后无法核验；已保留文件，请重新预览并检查");
		return { path: target, reused: false };
	}
}
