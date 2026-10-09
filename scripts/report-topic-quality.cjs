"use strict";
// Read-only verification/replay; writes only a new, explicit review file. No model calls.
const fs = require('node:fs'), path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const io = require('./reading-quality-io.cjs'), runner = require('./topic-quality-runner.cjs');
const json = (root, file) => JSON.parse(io.readFile(root, file));
const check = (ok, message) => { if (!ok) throw Error(message); };
const fence = text => { const tick = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return tick + 'text\n' + text + '\n' + tick; };
async function inspect(directory, planDirectory, planHash) {
 const loaded = runner.loadPlan(planDirectory, planHash, false), { runtime, inputs, plan, spec } = loaded;
 const manifest = json(directory, 'manifest.json');
 check(manifest.planHash === planHash && manifest.protocol === plan.protocol && ['live', 'simulated'].includes(manifest.mode), 'Run manifest mismatch');
 check(manifest.questionIds === undefined && plan.suiteRegistryHash === undefined || same(manifest.questionIds, inputs.samples.flatMap(s => s.steps.map(q => q.id))), 'Run question inventory mismatch');
 const services = runner.createServices(runtime, new runtime.FileSourceStorage(path.join(directory, 'state')));
 const records = [], answers = [], lines = ['# 主题教学首次回答审阅包', '', '以下是模型首次输出和暂定参考要点；HTTP 成功、JSON 合法与教学质量分别记录。独立审阅尚未完成，不提供教学通过率。', '',
  `运行模式：${manifest.mode}；配置模型：${manifest.profile.model}；插件：${manifest.pluginVersion}。`, `计划摘要：${planHash}`, '', '## 逐题记录', ''];
 try {
  for (const sample of inputs.samples) {
   let history = null, storedRoute = null;
   if (fs.existsSync(path.join(directory, sample.id + '.json'))) {
    const route = json(directory, sample.id + '.json'); storedRoute = route;
    const revision = await services.topics.get(route.topicId, route.revision);
    check(same(revision.session.intent, sample.intent) && same(revision.session.plan, sample.plan), 'Stored route differs from frozen inputs');
    history = await services.service.store.read(route.topicId, route.route);
    check(!history.errors.length && !!history.study, 'Study journal failed integrity checks');
   }
   const mapped = new Map();
   for (const step of sample.steps) {
    lines.push('### ' + step.id, '');
    if (!fs.existsSync(path.join(directory, step.id, 'started.json'))) { lines.push('本题未开始。', ''); continue; }
    const started = json(directory, step.id + '/started.json');
    check(same(started.step, step) && started.sampleId === sample.id && started.topicId === storedRoute?.topicId && started.route === storedRoute?.route && started.mode === manifest.mode, 'Step differs from frozen input');
    if (!fs.existsSync(path.join(directory, step.id, 'result.json'))) { lines.push('本题未完整落档；若已有 request.json，则服务端结果未知。禁止自动重投。', ''); continue; }
    check(!!history, 'Missing study history');
    const record = json(directory, step.id + '/result.json');
    const beforeIndex = history.commits.findIndex(c => c.digest === started.beforeHead);
    const before = runtime.projectStudy(history.commits.slice(0, beforeIndex + 1));
    const requestCommit = history.commits[beforeIndex + 1];
    check(requestCommit?.event.type === 'request' && requestCommit.id === record.requestId, 'Request journal mismatch');
    const resultCommit = history.commits[beforeIndex + 2];
    check(resultCommit?.event.type === 'result' && resultCommit.digest === record.head && resultCommit.event.requestId === record.requestId, 'Result journal mismatch');
    const node = history.study.nodes.find(n => n.id === record.nodeId);
    check(node && node.attempts.length === 1 && !node.understanding && node.attempts[0].requestId === record.requestId, 'First attempt or user mark changed');
    const planned = step.action === 'next' ? runtime.nextTopicNode(before) : runtime.topicQuestion(before, mapped.get(step.parent), step.question, step.newBranch);
    if (step.action === 'ask') {
     const parent = before.nodes.find(n => n.id === mapped.get(step.parent));
     check(step.newBranch || !parent.branchId ? !before.graph.branches.some(b => b.id === node.branchId) : node.branchId === parent.branchId, 'Branch continuation changed');
    }
    check(requestCommit.event.promptVersion === inputs.promptVersion, 'Recorded teaching rules differ from frozen inputs');
    const expected = runner.requestData(runtime.topicTeachingRequest(before, planned, new AbortController().signal, requestCommit.event.promptVersion));
    check(same(runner.requestData(runtime.topicTeachingRequest(before, requestCommit.event.node, new AbortController().signal, requestCommit.event.promptVersion)), expected), 'Wrong step or ancestry in actual journal');
    mapped.set(step.id, node.id);
    let receipt = null;
    for (const [file, hash] of [['teaching-request.json', record.backendHash], ['request.json', record.requestHash], ['response.txt', record.responseHash]]) {
     if (!hash) continue;
     check(io.sha(io.readFile(directory, step.id + '/' + file)) === hash, 'Retained request or response changed: ' + step.id);
    }
    if (record.backendHash) check(same(json(directory, step.id + '/teaching-request.json'), expected), 'Teaching request differs from replay');
    if (record.requestHash) check(same(json(directory, step.id + '/request.json'), { url: manifest.profile.baseUrl + '/chat/completions', method: 'POST', body: runner.wireBody(expected, manifest.profile) }), 'Wire request differs from replay');
    if (record.responseHash) {
     const meta = json(directory, step.id + '/response-meta.json');
     check(meta.sha256 === record.responseHash, 'Response metadata changed');
     let raw = null; try { raw = json(directory, step.id + '/response.txt'); } catch { /* Invalid response remains a failure. */ }
     receipt = { status: meta.status, raw };
    }
    if (record.state === 'answered') {
     check(record.dispatched && record.responseReceived && record.backendHash && record.requestHash && record.responseHash, 'Answered without transport receipts');
     check(runner.responseState(receipt, node, false) === 'answered' && node.attempts[0].result.response === receipt.raw.choices[0].message.content, 'First response and stored answer disagree');
     check(same(runtime.parseTopicTeaching(receipt.raw.choices[0].message.content), { title: node.title, content: node.content }), 'Stored teaching content changed');
    }
    check(same(record.contextIds, node.attempts[0].contextIds) && same(record.usage, runner.usage(receipt?.raw?.usage)), 'Context or usage mismatch');
    check(record.mode === manifest.mode && record.independentReview === 'pending' && record.id === step.id && record.sampleId === sample.id, 'Record identity or review status changed');
    records.push(record);
    answers.push({ id: step.id, question: JSON.parse(expected.prompt).question, title: node.title, content: node.content });
    const rubric = spec.samples.find(s => s.id === sample.id).steps.find(q => q.id === step.id);
    lines.push(`工程状态：${record.state}；祖先：${record.contextIds.join(', ') || '无'}；响应模型：${record.reportedModel || '未报告'}。`, '', '实际问题：', '', fence(JSON.parse(expected.prompt).question), '',
     '首次回答（保持原样）：', '', fence(node.status === 'done' ? node.title + '\n\n' + node.content : node.attempts[0].result?.response || '未收到有效正文'), '',
     '接口原始用量（字段可能重叠，不相加推理与正文细项；费用未知）：', '', fence(JSON.stringify(receipt?.raw?.usage ?? null, null, 2)), '',
     ...rubric.expectedPoints.map(v => '- 待检查：' + v), ...rubric.mustNotClaim.map(v => '- 失败反例：' + v), '',
     '独立审阅者／日期：待填写。事实、适用条件、教学适配、来源诚实、主支线连续性：待分别裁定。依据与需修正之处：待填写。', '');
   }
   if (history) {
    const startedCount = sample.steps.filter(q => fs.existsSync(path.join(directory, q.id, 'started.json'))).length;
    check(history.study.nodes.length <= startedCount && history.commits.every(c => c.event.type !== 'understanding'), 'Unexpected unrecorded model call or user mark');
   }
  }
  if (fs.existsSync(path.join(directory, 'summary.json'))) {
   const summary = json(directory, 'summary.json');
   const ids = inputs.samples.flatMap(s => s.steps.map(q => q.id));
   check(same(summary.records, records) && summary.planHash === planHash && summary.independentReview === 'pending' && summary.recorded === records.length &&
    summary.answered === records.filter(r => r.state === 'answered').length && same(summary.remaining, ids.slice(records.length)), 'Run summary differs from retained records');
  }
  lines.push('## 复核参考', '', ...spec.references.map(ref => `- [${ref.id}](${ref.url})：${ref.supports}`), '', '这些文档用于复核，没有提供给被测模型。开发者自查不能替代独立教学审阅。', '');
  return { manifest, records, answers, inputs, spec, text: lines.join('\n') };
 } finally { await services.service.dispose(); services.topics.dispose(); }
}
async function report(directory, planDirectory, planHash, output) {
 const inspected = await inspect(directory, planDirectory, planHash);
 const target = io.privateTarget(output, [directory, planDirectory]);
 io.save(path.dirname(target), path.basename(target), inspected.text, true);
 return { output: target, records: inspected.records.length, independentReview: 'pending' };
}
module.exports = { inspect, report };
if (require.main === module) report(...process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(String(e)); process.exitCode = 1; });
