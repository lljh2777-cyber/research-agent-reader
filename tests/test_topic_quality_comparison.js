"use strict";
// Synthetic comparison validation only; no files, model calls or deletion.
const assert = require('node:assert/strict'), baseline = require('../scripts/topic-quality-baseline.cjs');
const { comparison } = require('../scripts/compare-topic-quality.cjs');
function fixture(id) {
 const { spec, result } = baseline.frozenBaseline(id), steps = spec.samples.flatMap(s => s.steps);
 return { spec, inputs: result.inputs, manifest: { mode: 'simulated', profile: { model: 'synthetic' }, planHash: 'test-' + id },
  records: steps.map(s => ({ id: s.id, state: 'answered', usage: { input: 1, output: null, total: null } })),
  answers: steps.map(s => ({ id: s.id, question: s.question || s.id, title: '模拟标题', content: '```\n<script>untrusted</script>\n```' })) };
}
const first = fixture('topic-t1-v1'), second = fixture('topic-t1-v2'), result = comparison(first, second);
assert.equal(result.summary.questions, 9); assert.equal(result.summary.beforeUsage.total, null); assert.equal(result.summary.independentReview, 'pending'); assert.equal(result.summary.teachingPassRate, null);
assert.match(result.text, /````text/); assert.match(result.text, /不是相同上下文/);
for (const change of [r=>r.inputs.samples[0].steps[0].id='M99', r=>r.spec.samples[0].steps[0].expectedPoints.push('new rubric'), r=>r.manifest.profile.model='different',
 r=>r.manifest.mode='live', r=>r.records.pop(), r=>r.records[0].state='failed', r=>r.answers[0].question='different', r=>r.inputs.promptVersion='topic-teaching-v1']) {
 const changed = structuredClone(second); change(changed); assert.throws(()=>comparison(first, changed));
}
console.log('TOPIC_COMPARISON_OK: fixed questions/rubrics/profile, complete first answers, unknown usage, safe quoted content and no automatic teaching verdict');
