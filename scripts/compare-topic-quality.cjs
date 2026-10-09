"use strict";
// Compare two verified first-run artifacts. No model calls, grading, edits or retries.
const path = require('node:path'), { isDeepStrictEqual: same } = require('node:util');
const io = require('./reading-quality-io.cjs'), { inspect } = require('./report-topic-quality.cjs');
const check = (ok, message) => { if (!ok) throw Error(message); };
const fence = text => { const marker = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return marker + 'text\n' + text + '\n' + marker; };
function comparison(before, after) {
 check(same(before.inputs.samples, after.inputs.samples) && same({ ...before.spec, id: after.spec.id }, after.spec), 'Questions, routes or review criteria changed');
 check(before.inputs.promptVersion === 'topic-teaching-v1' && after.inputs.promptVersion === 'topic-teaching-v2', 'Expected v1 followed by v2');
 check(same(before.manifest.profile, after.manifest.profile) && before.manifest.mode === after.manifest.mode, 'Provider configuration or execution mode changed');
 const ids = before.inputs.samples.flatMap(s => s.steps.map(q => q.id));
 for (const run of [before, after]) check(same(run.records.map(r => r.id), ids) && same(run.answers.map(a => a.id), ids) && run.records.every(r => r.state === 'answered'), 'Both runs need all nine verified first answers');
 const totals = run => Object.fromEntries(['input','output','total'].map(key => [key, run.records.every(r => r.usage[key] !== null) ? run.records.reduce((sum, r) => sum + r.usage[key], 0) : null]));
 const observations = ids.map((id, i) => ({ id, beforeCharacters: before.answers[i].content.length, afterCharacters: after.answers[i].content.length, beforeUsage: before.records[i].usage, afterUsage: after.records[i].usage }));
 const summary = { version: 1, mode: before.manifest.mode, beforePlanHash: before.manifest.planHash, afterPlanHash: after.manifest.planHash, configuredModel: before.manifest.profile.model,
  questions: ids.length, beforeUsage: totals(before), afterUsage: totals(after), observations, independentReview: 'pending', teachingPassRate: null };
 const lines = ['# 主题教学规则 v1 / v2 首次回答对照', '',
  '同题、同路线、同配置模型的两次顺序运行；没有固定随机种子，上游模型身份与稳定性未独立核实。后续题分别沿用各自版本的祖先回答，因此不是相同上下文的逐字重放。', '',
  '本表只展示首次回答、字数和接口报告用量，不自动评判教学质量，不据此推断统计显著性或其他主题表现。正文与推理用量细项可能重叠，不能相加；费用未知。独立审阅仍待完成。', '',
  `v1 计划：${summary.beforePlanHash}`, `v2 计划：${summary.afterPlanHash}`, '',
  '| 题目 | v1 正文字符 | v2 正文字符 | v1 输出 token | v2 输出 token |', '|---|---:|---:|---:|---:|',
  ...observations.map(o => `| ${o.id} | ${o.beforeCharacters} | ${o.afterCharacters} | ${o.beforeUsage.output ?? '未知'} | ${o.afterUsage.output ?? '未知'} |`), ''];
 for (const [i,id] of ids.entries()) {
  const a = before.answers[i], b = after.answers[i]; check(a.question === b.question, 'Actual question changed');
  const step = before.spec.samples.flatMap(s => s.steps).find(s => s.id === id);
  lines.push('## ' + id, '', fence(a.question), '', '### v1 首次回答', '', fence(a.title + '\n\n' + a.content), '',
   '### v2 首次回答', '', fence(b.title + '\n\n' + b.content), '', '### 原冻结判断要点', '', ...step.expectedPoints.map(p => '- 待检查：' + p), ...step.mustNotClaim.map(p => '- 失败反例：' + p), '',
   '独立审阅者／日期：待填写。改善、残留或新引入问题：待裁定。依据：待填写。', '');
 }
 return { summary, text: lines.join('\n') };
}
async function compare(firstDirectory, firstPlan, firstHash, secondDirectory, secondPlan, secondHash, output) {
 const first = await inspect(firstDirectory, firstPlan, firstHash), second = await inspect(secondDirectory, secondPlan, secondHash);
 const result = comparison(first, second), target = io.privateTarget(output, [firstDirectory, firstPlan, secondDirectory, secondPlan]);
 io.save(path.dirname(target), path.basename(target), result.text, true);
 return { ...result.summary, output: target };
}
module.exports = { comparison, compare };
if (require.main === module) compare(...process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(String(e)); process.exitCode = 1; });
