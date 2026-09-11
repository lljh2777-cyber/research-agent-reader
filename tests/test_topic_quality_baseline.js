"use strict";
// Read-only fixture checks. No models or cleanup.
const assert=require('node:assert/strict'),baseline=require('../scripts/topic-quality-baseline.cjs'),spec=require('./fixtures/topic-quality/t1-v1.json'),frozen=require('./fixtures/topic-quality/t1-v1-observation.json');
const before=JSON.stringify(spec),result=baseline.prepare(spec);assert.equal(JSON.stringify(spec),before);assert.deepEqual(result.observation,frozen);assert.equal(result.observation.questionCount,9);assert.equal(result.observation.modelAnswerStatus,'not_run');
assert.equal(result.observation.independentReviewStatus,'pending');assert(!JSON.stringify(result.inputs).includes('expectedPoints'));assert(!JSON.stringify(result.inputs).includes('mustNotClaim'));assert(!JSON.stringify(result.inputs).includes('sklearn-leakage'));assert.match(result.review,/待独立审阅/);
const bad=structuredClone(spec);bad.samples[0].steps[1].parent='M06';assert.throws(()=>baseline.prepare(bad));
const changed=structuredClone(spec);changed.samples[0].steps[1].expectedPoints.push('不得用事后修改消除失败');assert.notEqual(baseline.prepare(changed).observation.baselineHash,frozen.baselineHash);
console.log('TOPIC_QUALITY_BASELINE_OK: 2 source-free goals, 9 ordered questions, frozen references separated from inputs, no automatic quality verdict');
