import type { ResolvedIdentity } from "../papers/identity";

export function renderBibliography(parent: HTMLElement, identity: ResolvedIdentity): void {
	parent.createEl("p", { text: `作者：${identity.authors.join("；") || "来源未提供"}` });
	parent.createEl("p", { text: `年份：${identity.year || "来源未提供"}` });
	if (identity.publicationTypes.length) parent.createEl("p", { text: "文献类型：" + identity.publicationTypes.join("；") });
	const provenance = parent.createEl("details"); provenance.createEl("summary", { text: "书目信息来源" });
	for (const evidence of identity.evidence) provenance.createEl("p", { text: `${evidence.provider === "crossref" ? "Crossref" : "Europe PMC"} · ${evidence.recordId} · 查询于 ${evidence.observedAt} · 字段：${evidence.fields.join("、")}` });
	for (const warning of identity.warnings) parent.createEl("p", { text: warning, cls: "rar-library-warning" });
}
