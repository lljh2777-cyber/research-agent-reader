"use strict";
const fs = require("node:fs"), path = require("node:path"), io = require("./reading-quality-io.cjs");
const { loadPlan } = require("./reading-quality-runner.cjs");
const fence = value => { const marks = "`".repeat(Math.max(3, ...(String(value).match(/`+/g) || []).map(s => s.length + 1))); return marks + "text\n" + value + "\n" + marks; };
function report(directory, output, planDirectory) {
	const manifest = JSON.parse(io.readFile(directory, "manifest.json"));
	if (manifest.protocol !== "rar-quality-run-1" || !Array.isArray(manifest.questionIds) || manifest.questionIds.length > 18 || manifest.questionIds.some(id => !/^[A-Z][0-9]{2}$/.test(id))) throw new Error("Unsupported run manifest");
	const plan = loadPlan(planDirectory, manifest.planHash);
	if (new Set(manifest.questionIds).size !== manifest.questionIds.length || manifest.questionIds.some(id => !plan.inputs.some(q => q.id === id))) throw new Error("Run questions differ from frozen plan");
	const target = io.privateTarget(output, [directory, planDirectory, plan.sourceRoot]), records = [], assets = [];
	const assetName = path.basename(target) + "-assets", assetDirectory = path.join(path.dirname(target), assetName);
	if (fs.existsSync(target) || fs.existsSync(assetDirectory)) throw new Error("Report output already exists");
	const lines = ["# 固定文献问题：模型答题复核包", "", `模型：${manifest.profile.model}；插件：${manifest.pluginVersion}；运行协议：${manifest.protocol}。`, "", `计划摘要：${manifest.planHash}`, "", "本包记录执行结果；科学正确性与参考要点仍待独立人工复核。图片提交记录只证明传输过程，不能证明模型实际看懂图像。", ""];
	for (const id of manifest.questionIds) {
		lines.push("## " + id, "");
		if (!fs.existsSync(path.join(directory, id, "result.json"))) {
			lines.push(fs.existsSync(path.join(directory, id, "started.json")) ? "运行中断或未完成；实际服务端结果未知，不自动重试。" : "本题未开始。", ""); continue;
		}
		const record = JSON.parse(io.readFile(directory, id + "/result.json")), input = JSON.parse(io.readFile(directory, id + "/input.json"));
		if (record.id !== id || record.inputHash !== input.inputHash || JSON.stringify(input) !== JSON.stringify(plan.inputs.find(q => q.id === id))) throw new Error("Recorded input differs from frozen plan: " + id);
		for (const [name, hash] of [["request.json", record.requestHash], ["response.txt", record.responseHash]]) if (hash && io.sha(io.readFile(directory, id + "/" + name, 32 * 1024 * 1024)) !== hash) throw new Error("Run artifact changed: " + id + "/" + name);
		records.push(record);
		lines.push(input.prompt, "", `执行状态：${record.state}；接口报告 token：输入 ${record.usage.input ?? "未知"}，输出 ${record.usage.output ?? "未知"}；费用：未报告。`, "", "原始回答：", "", fence(record.answer || "（未取得回答）"), "");
		if (record.responseHash) {
			let raw; try { raw = JSON.parse(io.readFile(directory, id + "/response.txt", 5 * 1024 * 1024)); } catch { /* A malformed response remains inspectable as a failed run. */ }
			const detail = raw?.usage?.completion_tokens_details, count = n => Number.isSafeInteger(n) && n >= 0 ? n : "未知";
			lines.push(`接口原始明细：text_tokens=${count(detail?.text_tokens)}，reasoning_tokens=${count(detail?.reasoning_tokens)}。字段含义未独立核实，不推算正文／推理的互斥用量。请求 max_tokens 为 ${manifest.profile.maxTokens}；具体限额及计费语义未独立核实。`, "");
			if ([detail?.text_tokens, detail?.reasoning_tokens, raw?.usage?.completion_tokens].every(n => Number.isSafeInteger(n) && n >= 0) && detail.text_tokens + detail.reasoning_tokens !== raw.usage.completion_tokens) lines.push("用量口径异常：本题两个明细字段之和不等于 completion_tokens，不能相加作为实际输出或计费用量。", "");
		}
		lines.push("图像传输：" + (record.visuals.map(v => `${v.id} ${v.transport}（${v.width}×${v.height}）`).join("；") || "本题无图像"), "");
		if (record.requestHash) {
			const wire = JSON.parse(io.readFile(directory, id + "/request.json", 32 * 1024 * 1024));
			const images = wire.body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === "image_url") : []);
			if (images.length !== record.visuals.length) throw new Error("Visual receipt count changed: " + id);
			images.forEach((image, index) => {
				const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(image.image_url.url), visual = record.visuals[index];
				if (!match) throw new Error("Invalid recorded image");
				const bytes = Buffer.from(match[2], "base64");
				if (bytes.length !== visual.bytes || io.sha(bytes) !== visual.sha256 || !/^[A-Z][0-9]{2}-V[0-9]+$/.test(visual.id)) throw new Error("Recorded visual changed");
				const name = visual.id + "-" + visual.sha256 + (match[1] === "png" ? ".png" : ".jpg"); assets.push({ name, bytes });
				lines.push(`实际请求中的 ${visual.id}：`, "", `![${visual.id}](<${assetName}/${name}>)`, "");
			});
		}
		if (record.citations) lines.push(`引用格式：匹配 ${record.citations.cited.length} 个本题证据 ID；未知 ID：${record.citations.unknown.join("、") || "无"}。这不是科学支持程度评分。`, "");
		for (const evidence of input.evidence) lines.push("原文依据 " + evidence.id, "", fence(evidence.text), "");
		lines.push("人工复核：待填写。分别检查原文支持、数字单位、条件与否定、图表解释、结论越界及未回答问题；记录复核者、日期和裁定依据。", "");
	}
	if (assets.length) { fs.mkdirSync(assetDirectory); for (const asset of assets) io.save(assetDirectory, asset.name, asset.bytes, true); }
	io.save(path.dirname(target), path.basename(target), lines.join("\n"), true);
	return { output: target, records: records.length, selected: manifest.questionIds.length, independentReview: "pending" };
}
module.exports = { report };
if (require.main === module) { try { const [directory, output, planDirectory] = process.argv.slice(2); if (!directory || !output || !planDirectory) throw new Error("Usage: node scripts/report-reading-quality.cjs <run-directory> <new-report.md> <frozen-plan-directory>"); console.log(JSON.stringify(report(directory, output, planDirectory))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
