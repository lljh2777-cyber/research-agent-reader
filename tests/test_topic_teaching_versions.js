"use strict";
// Memory only. Simulated legacy journal, no models, filesystem writes or cleanup.
const assert = require('node:assert/strict');
const { loadReading } = require('./reading-test-helpers');
const { TopicStudyService } = loadReading('topic-learning/study-service.ts');
const { TopicStudyStore } = loadReading('topic-learning/study-store.ts');
const { TopicSessionStore } = loadReading('topic-learning/store.ts');
const { TopicLearningService } = loadReading('topic-learning/service.ts');
const { nextTopicNode, studyContext, validateStudyCommit } = loadReading('topic-learning/study.ts');
const { topicTeachingRequest } = loadReading('topic-learning/teaching.ts');
const { topicTeachingRules } = loadReading('topic-learning/teaching-rules.ts');
const { TopicStudyExports } = loadReading('topic-learning/export.ts');
const { sha } = require('../scripts/topic-quality-baseline.cjs');
const frozen = require('./fixtures/topic-quality/t1-v1-observation.json');
function memory() {
 const files = new Map(), dirs = new Set();
 return { files, async read(p) { return files.get(p) || null; }, async mkdir(p) { dirs.add(p); },
  async create(p, b) { assert(!files.has(p)); files.set(p, Buffer.from(b)); },
  async list(p) { return [...dirs, ...files.keys()].filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map(k => ({ name: k.slice(p.length + 1), directory: dirs.has(k) })); } };
}
(async () => {
 const io = memory(), topics = new TopicLearningService(new TopicSessionStore(io)), store = new TopicStudyStore(io), service = new TopicStudyService(store, topics);
 const sample = require('./fixtures/topic-quality/t1-v1.json').samples[0];
 const c = await topics.create(sample.intent), p = await topics.editPlan(c.session.id, c.digest, sample.plan), confirmed = await topics.confirmPlan(c.session.id, p.digest);
 const id = c.session.id, route = await service.start(id, confirmed.digest), before = await service.get(id, route), spec = nextTopicNode(before);
 const request = { type: 'request', node: spec, provider: 'Simulated', model: 'legacy-test', promptVersion: 'topic-teaching-v1', contextIds: studyContext(before, spec.parentId).ids, omitted: 0 };
 const committed = await store.append(id, route, before.head, request);
 assert.equal(validateStudyCommit(committed, committed.id).digest, committed.digest);
 assert.equal(validateStudyCommit(committed, committed.id).event.promptVersion, 'topic-teaching-v1');
 for (const version of ['topic-teaching-v3', '__proto__', '', null]) {
  assert.throws(() => validateStudyCommit({ ...committed, event: { ...request, promptVersion: version } }, committed.id));
  assert.throws(() => topicTeachingRules(version));
 }
 const legacyRequest = topicTeachingRequest(before, spec, new AbortController().signal, 'topic-teaching-v1');
 assert.equal(sha(legacyRequest.system), frozen.instructionHash);
 const modernRequest = topicTeachingRequest(before, spec, new AbortController().signal);
 assert.equal(modernRequest.prompt, legacyRequest.prompt); assert.equal(modernRequest.maxTokens, legacyRequest.maxTokens); assert.deepEqual(modernRequest.schema, legacyRequest.schema);
 const response = JSON.stringify({ title: '旧版模拟回答', content: '旧版正文原样保留。' });
 await store.append(id, route, committed.digest, { type: 'result', requestId: committed.id, status: 'done', title: '旧版模拟回答', content: '旧版正文原样保留。', response, error: '', usage: { input: 12, output: 5 } });
 const old = await service.get(id, route), exports = new TopicStudyExports(service, io);
 const review = await exports.review(id, route, old.head, 'session', ''); assert(!review.text.includes('教学规则'));
 await exports.save(review); const snapshot = new Map([...io.files].map(([p,b]) => [p, b.toString()]));
 const restored = new TopicStudyService(new TopicStudyStore(io), topics);
 assert.equal((await restored.get(id, route)).nodes[0].attempts[0].promptVersion, 'topic-teaching-v1');
 assert.equal((await exports.review(id, route, old.head, 'session', '')).existing, 'same');
 let calls = 0;
 await restored.generate(id, route, old.head, { kind: 'ask', parentId: old.nodes[0].id, question: '继续解释？', newBranch: true }, () => ({ name: 'Simulated', model: 'new-test', images: false,
  async complete(r) { calls++; assert.equal(r.system, modernRequest.system); assert.equal(JSON.parse(r.prompt).context[0].answer, '旧版正文原样保留。'); return JSON.stringify({ title: '新版模拟', content: '新版正文。' }); } }));
 const mixed = await restored.get(id, route);
 assert.deepEqual(mixed.nodes.map(n => n.attempts[0].promptVersion), ['topic-teaching-v1', 'topic-teaching-v2']); assert.equal(calls, 1);
 assert.deepEqual(mixed.nodes[0], old.nodes[0]);
 for (const [p, bytes] of snapshot) assert.equal(io.files.get(p).toString(), bytes);
 const mixedReview = await exports.review(id, route, mixed.head, 'session', ''); assert(mixedReview.text.includes('教学规则 topic-teaching-v2')); assert.equal(io.files.get(review.path).toString(), review.text);
 // A failed v1 attempt receives a new v2 receipt only on explicit retry.
 const parent = mixed.nodes.at(-1), { topicQuestion } = loadReading('topic-learning/study.ts');
 const failedSpec = topicQuestion(mixed, parent.id, '失败后重试？', false), context = studyContext(mixed, parent.id);
 const failedRequest = await store.append(id, route, mixed.head, { ...request, node: failedSpec, contextIds: context.ids });
 await store.append(id, route, failedRequest.digest, { type: 'result', requestId: failedRequest.id, status: 'failed', title: '', content: '', error: '模拟失败', response: 'invalid', usage: {} });
 const failed = await restored.get(id, route);
 await restored.generate(id, route, failed.head, { kind: 'retry', nodeId: failedSpec.id }, () => ({ name: 'Simulated', model: 'new-test', images: false, complete: async () => response }));
 const retried = (await restored.get(id, route)).nodes.at(-1); assert.deepEqual(retried.attempts.map(a => a.promptVersion), ['topic-teaching-v1', 'topic-teaching-v2']); assert.equal(retried.attempts[0].result.response, 'invalid');
 await restored.dispose(); await service.dispose();
 console.log('TOPIC_TEACHING_VERSIONS_OK: legacy digest and export preservation, mixed-rule restore, source-free identical payload and explicit versioned retries');
})().catch(e => { console.error(e); process.exitCode = 1; });
