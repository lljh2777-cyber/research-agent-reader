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
const transfer=baseline.frozenBaseline('topic-t1-transfer-v1');
assert.equal(transfer.result.inputs.system,v2.result.inputs.system);assert.equal(transfer.result.observation.questionCount,8);
assert.equal(transfer.result.observation.instructionHash,v2.result.observation.instructionHash);
assert(!JSON.stringify(transfer.result.inputs).includes('expectedPoints'));assert(!JSON.stringify(transfer.result.inputs).includes('psu-association'));
const oldQuestions=new Set(spec.samples.flatMap(s=>[...s.plan.modules.map(m=>m.question),...s.steps.map(q=>q.question).filter(Boolean)]));
for(const sample of transfer.spec.samples)for(const question of [...sample.plan.modules.map(m=>m.question),...sample.steps.map(q=>q.question).filter(Boolean)])assert(!oldQuestions.has(question));
for(const change of [s=>s.samples[0].id='../escape',s=>s.samples[0].steps[0].id='../M01',s=>s.samples[0].steps.pop(),s=>s.samples[1].steps[0].id='S01']){
 const invalid=structuredClone(transfer.spec);change(invalid);assert.throws(()=>baseline.prepare(invalid));
}
console.log('TOPIC_QUALITY_BASELINE_OK: v1/v2 hashes preserved; two new topics and eight new questions use unchanged v2 rules; rubric and input isolation');
