"use strict";
// Read-only fixture checks. No models or cleanup.
const assert=require('node:assert/strict'),baseline=require('../scripts/topic-quality-baseline.cjs'),spec=require('./fixtures/topic-quality/t1-v1.json'),frozen=require('./fixtures/topic-quality/t1-v1-observation.json');
const before=JSON.stringify(spec),result=baseline.prepare(spec);assert.equal(JSON.stringify(spec),before);assert.deepEqual(result.observation,frozen);assert.equal(result.observation.questionCount,9);assert.equal(result.observation.modelAnswerStatus,'not_run');
assert.equal(result.observation.independentReviewStatus,'pending');assert(!JSON.stringify(result.inputs).includes('expectedPoints'));assert(!JSON.stringify(result.inputs).includes('mustNotClaim'));assert(!JSON.stringify(result.inputs).includes('sklearn-leakage'));assert.match(result.review,/待独立审阅/);
const bad=structuredClone(spec);bad.samples[0].steps[1].parent='M06';assert.throws(()=>baseline.prepare(bad));
const changed=structuredClone(spec);changed.samples[0].steps[1].expectedPoints.push('不得用事后修改消除失败');assert.notEqual(baseline.prepare(changed).observation.baselineHash,frozen.baselineHash);
const v2=baseline.frozenBaseline('topic-t1-v2'),v1=baseline.frozenBaseline('topic-t1-v1');
assert.equal(baseline.activeBaselineId,'topic-t1-v2');
assert.deepEqual(v2.spec,{...spec,id:'topic-t1-v2'});assert.deepEqual(v2.result.inputs.samples,v1.result.inputs.samples);
assert.notEqual(v2.result.inputs.system,v1.result.inputs.system);assert.equal(v2.result.inputs.promptVersion,'topic-teaching-v2');
assert.equal(v2.result.observation.independentReviewStatus,'pending');
assert(!/expectedPoints|mustNotClaim|M0[1-6]|N0[1-3]|backward\(|归一化|测试集|梯度截断/.test(v2.result.inputs.system));
assert.throws(()=>baseline.frozenBaseline('unknown'));
console.log('TOPIC_QUALITY_BASELINE_OK: v1 hashes preserved; v2 changes general rules only, with identical 2 goals, 9 questions and provisional rubrics');
