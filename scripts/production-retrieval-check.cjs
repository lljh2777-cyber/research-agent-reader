/* Explicit, read-only production retrieval evaluation inside Obsidian.
 * Uses the configured service and frozen private questions. No credentials in output.
 * Output must be outside the vault and repository. No cleanup or note writes. */
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { metrics } = require("./retrieval-benchmark.cjs");
const hash = value => createHash("sha256").update(value).digest("hex");
const within = (root, file) => { const rel = path.relative(root, file); return !rel || !rel.startsWith("..") && !path.isAbsolute(rel); };
module.exports = async function productionCheck(app, frozenDirectory, outputDirectory) {
	const plugin = app.plugins.plugins["research-agent-reader"]; if (plugin.settings.knowledgeRetrievalMode !== "hybrid") throw new Error("Hybrid retrieval must be selected before evaluation");
	const root = await fs.realpath(app.vault.adapter.getBasePath()); const repo = await fs.realpath(path.resolve(__dirname, ".."));
	await fs.mkdir(outputDirectory, { recursive: true }); const out = await fs.realpath(outputDirectory);
	if (within(root, out) || within(repo, out) || within(await fs.realpath(frozenDirectory), out)) throw new Error("Use a new private directory outside the vault, repository and frozen baseline");
	const corpus = JSON.parse(await fs.readFile(path.join(frozenDirectory, "corpus.json"), "utf8"));
	const questions = JSON.parse(await fs.readFile(path.join(frozenDirectory, "questions.json"), "utf8"));
	const protocol = JSON.parse(await fs.readFile(path.join(frozenDirectory, "protocol.json"), "utf8"));
	if (hash(JSON.stringify(questions)) !== protocol.questionHash) throw new Error("Frozen questions changed");
	const verify = async () => { for (const doc of corpus.docs) { const file = app.vault.getFileByPath(doc.path); if (!file || hash(await app.vault.cachedRead(file)) !== doc.hash) throw new Error("Frozen source changed: " + doc.path); } };
	await verify(); const service = plugin.getKnowledgeService(); const status = await service.inspect();
	if (status.documents !== corpus.docs.length || status.done !== status.total || status.changed) throw new Error("Current corpus/index differs from frozen sources; create a separately labelled evaluation");
	const identity = { questionHash: protocol.questionHash, corpusHash: protocol.corpusHash, pluginVersion: plugin.manifest.version,
		bundleHash: hash(await fs.readFile(path.join(root, plugin.manifest.dir, "main.js"))), labelSource: protocol.labelSource, started: new Date().toISOString(), questions: questions.length };
	await fs.writeFile(path.join(out, "protocol.json"), JSON.stringify(identity, null, 2), { flag: "wx" });
	const results = [];
	for (const question of questions) {
		const started = Date.now(); const result = await service.search(question.query, { identityQuery: question.query, limit: 5 });
		results.push({ id: question.id, query: question.query, noAnswer: question.noAnswer, elapsedMs: Date.now() - started, ...result });
		await fs.writeFile(path.join(out, "progress.json"), JSON.stringify({ done: results.length, total: questions.length }));
		await fs.writeFile(path.join(out, question.id + ".json"), JSON.stringify(results.at(-1), null, 2), { flag: "wx" });
	}
	await verify();
	const rankings = Object.fromEntries(results.map(result => [result.id, [...new Set(result.hits.map(hit => hit.path))].map(path => ({ path }))]));
	const measured = { all: metrics(questions, rankings, 5), heldout: metrics(questions.filter(q => q.split === "heldout"), rankings, 5),
		strictQuoteHits: questions.filter(q => !q.noAnswer && q.evidence.some(e => results.find(r => r.id === q.id).hits.some(h => h.path === e.path && h.text.includes(e.quote)))).length,
		fallbackQuestions: results.filter(r => r.mode !== "hybrid").map(r => r.id), sourceIntegrity: "unchanged", noAnswerCases: questions.filter(q => q.noAnswer).length };
	await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ identity, measured, results }, null, 2), { flag: "wx" });
	const lines = ["# 生产检索复验", "", "使用原有冻结语料与 40 题；未重新标注，不生成答案。严格片段命中使用生产片段的正文匹配，和旧切分方案存在差异。", "",
		"```json", JSON.stringify(measured, null, 2), "```", "", "| 问题 | 参考页命中 | 限定范围 | 第一命中 |", "|---|---|---|---|"];
	for (const q of questions) { const r = results.find(r => r.id === q.id); lines.push(`| ${q.id} | ${q.noAnswer ? "资料不足题" : q.evidence.some(e => r.hits.some(h => h.path === e.path)) ? "是" : "否"} | ${r.scope?.join("、") || "全库"} | ${r.hits[0]?.path || "无"} |`); }
	lines.push("", "文件命中和高相关分均不代表证据充分、科学结论正确或允许入库。参考标签由代理编写；真实问答及整理建议需分别验收。");
	await fs.writeFile(path.join(out, "report.md"), lines.join("\n"), { flag: "wx" }); return measured;
};
