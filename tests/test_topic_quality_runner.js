"use strict";
// Real temporary journals + simulated providers. All fixtures retained; no deletion or real credentials.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loadReading } = require('./reading-test-helpers');
const { OpenAICompatibleProvider } = loadReading('providers/adapters.ts');
const { DirectReadingBackend } = loadReading('reading/backend.ts');
const io = require('../scripts/reading-quality-io.cjs');
const runner = require('../scripts/topic-quality-runner.cjs'), reporter = require('../scripts/report-topic-quality.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-topic-quality-'));
const prepared = require('../scripts/prepare-topic-quality-run.cjs').prepareRun(path.join(root, 'plan'));
const loaded = runner.loadPlan(prepared.directory, prepared.planHash);
const selected = { id: 'test', name: 'Simulated', type: 'openai-compatible', model: 'test-model', baseUrl: 'http://127.0.0.1:8787/v1', secretId: 'synthetic-secret-id', lastTest: { ok: true }, capabilities: {} };
const profile = runner.profileInfo(selected, loaded.runtime);
let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log('PASS ' + name); }
function fixture(name, runLoaded = loaded) {
 const directory = path.join(root, name); fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, 'state'));
 const store = runner.diskStore(directory);
 store.save('manifest.json', { protocol: runLoaded.plan.protocol, planHash: runLoaded.plan.planHash, profile, mode: 'simulated', pluginVersion: runLoaded.plan.pluginVersion,
  questionIds: runLoaded.inputs.samples.flatMap(s => s.steps.map(q => q.id)) });
 return { directory, store, loaded: runLoaded, storage: new runLoaded.runtime.FileSourceStorage(path.join(directory, 'state')), controller: new AbortController() };
}
function raw(answer = JSON.stringify({ title: '工程模拟', content: '模拟回答，仅用于工程测试。\n```\n# 无需执行\n```' }), finish = 'stop') {
 return { model: 'test-model', choices: [{ message: { content: answer }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { text_tokens: 20, reasoning_tokens: 5 } } };
}
function plugin(transport) {
 return { app: { secretStorage: { getSecret: () => 'synthetic-key-never-record' } }, providerHttpRequest: transport,
  createLLMProvider(p) { return new OpenAICompatibleProvider(this, { ...p, timeoutSeconds: 120 }); },
  createTopicBackend(id) { const p = this.getProviderProfile(id); return new DirectReadingBackend(this.createLLMProvider(p), p.name, p.model, false, loaded.runtime.supportsReadingSchema(p)); }
 };
}
async function execute(f, behavior = {}, source = selected) {
 let calls = 0;
 const p = plugin(async options => {
  calls++;
  assert.equal(options.headers.Authorization, 'Bearer synthetic-key-never-record');
  if (behavior.transport) return behavior.transport(options, calls);
  const body = raw(behavior.answer, behavior.finish);
  return { status: behavior.status || 200, text: JSON.stringify(body), json: body };
 });
 const summary = await runner.run({ loaded: f.loaded, profile: runner.profileInfo(source, f.loaded.runtime), storage: f.storage, store: f.store, signal: f.controller.signal, mode: 'simulated',
  makeBackend: hooks => behavior.backend ? behavior.backend(hooks, p) : runner.obsidianBackend(p, source, hooks) });
 return { summary, calls, p };
}
(async () => {
 await test('freeze, source hashes and credential-free profile', () => {
  assert.equal(loaded.inputs.samples.flatMap(s => s.steps).length, 9);
  assert(!JSON.stringify(profile).includes('secret'));
  assert.throws(() => runner.loadPlan(prepared.directory, '0'.repeat(64)));
  for (const baseUrl of ['http://example.com/v1', 'https://key@example.com/v1', 'https://example.com/v1?token=x']) assert.throws(() => runner.profileInfo({ ...selected, baseUrl }, loaded.runtime));
  assert.throws(() => runner.requestData({ images: [], webSearch: 'auto' }));
 });
 let complete;
 await test('actual topic service and adapter: nine sequential first answers with sibling isolation', async () => {
  complete = fixture('complete'); const { summary, calls } = await execute(complete);
  assert.equal(calls, 9); assert.equal(summary.answered, 9); assert.equal(summary.independentReview, 'pending');
  const context = id => JSON.parse(JSON.parse(fs.readFileSync(path.join(complete.directory, id, 'teaching-request.json'))).prompt).context;
  assert.equal(context('M01').length, 0); assert.equal(context('M03').length, 2);
  assert.equal(context('M04').length, 1); assert.equal(context('M05').length, 1); assert.equal(context('M06').length, 1);
  assert.equal(context('N01').length, 0); assert.equal(context('N03').length, 2);
  const request = fs.readFileSync(path.join(complete.directory, 'M03/request.json'), 'utf8');
  assert(!/expectedPoints|mustNotClaim|synthetic-key|Authorization|synthetic-secret-id/.test(request));
  assert.equal(context('M03')[1].answer, '模拟回答，仅用于工程测试。\n```\n# 无需执行\n```');
 });
 await test('read-only replay and review binds first response, actual context, raw usage and summary', async () => {
  const before = fs.statSync(path.join(complete.directory, 'summary.json')).mtimeMs;
  const inspected = await reporter.inspect(complete.directory, prepared.directory, prepared.planHash);
  assert.equal(inspected.records.length, 9); assert.match(inspected.text, /````text/); assert.match(inspected.text, /费用未知/);
  const output = path.join(root, 'review.md'); await reporter.report(complete.directory, prepared.directory, prepared.planHash, output);
  await assert.rejects(reporter.report(complete.directory, prepared.directory, prepared.planHash, output));
  const restored = require('node:child_process').execFileSync(process.execPath, ['-e', 'require(process.argv[1]).inspect(process.argv[2],process.argv[3],process.argv[4]).then(r=>console.log(r.records.length)).catch(()=>process.exit(1))',
   path.resolve(__dirname, '../scripts/report-topic-quality.cjs'), complete.directory, prepared.directory, prepared.planHash], { encoding: 'utf8', windowsHide: true });
  assert.equal(restored.trim(), '9');
  assert.equal(fs.statSync(path.join(complete.directory, 'summary.json')).mtimeMs, before);
  assert.equal(runner.status(complete.directory).running, false);
 });
 await test('verified JSON schema is preserved by production adapter', async () => {
  const p = structuredClone(selected); p.structuredOutput = { verified: true, key: loadReading('providers/structured.ts').structuredProfileKey(p) };
  const f = fixture('schema'), result = await execute(f, {}, p);
  assert.equal(result.calls, 9);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'M01/request.json'))).body.response_format.json_schema.strict, true);
 });
 await test('invalid JSON, empty, refusal, truncated and non-success HTTP all stop the batch', async () => {
  for (const [name, behavior, state] of [ ['invalid', { answer: '{broken' }, 'invalid_answer'], ['empty', { answer: '' }, 'empty_answer'],
   ['refusal', { finish: 'content_filter' }, 'refused'], ['length', { finish: 'length' }, 'truncated'], ['http', { status: 429 }, 'http_error'] ]) {
   const f = fixture(name), { calls, summary } = await execute(f, behavior);
   assert.equal(calls, 1); assert.equal(summary.records[0].state, state); assert.equal(summary.remaining.length, 8);
   assert(fs.existsSync(path.join(f.directory, 'M01/response.txt')));
  }
 });
 await test('changed prompt and extra dispatch are blocked before transport', async () => {
  for (const type of ['changed', 'repeat']) {
   const f = fixture(type); const { calls, summary } = await execute(f, { backend: (hooks, p) => {
    const backend = runner.obsidianBackend(p, selected, hooks);
    return { ...backend, async complete(req) {
     if (type === 'changed') return backend.complete({ ...req, prompt: 'changed prompt' });
     await backend.complete(req); return backend.complete(req);
    } };
   } });
   assert.equal(calls, type === 'changed' ? 0 : 1); assert.equal(summary.records[0].state, 'protocol_failure');
  }
 });
 await test('request, response and result write failures never trigger a second paid call', async () => {
  for (const stage of ['request.json', 'response.txt', 'result.json']) {
   const f = fixture('write-' + stage), save = f.store.save; let calls = 0;
   f.store.save = (file, ...args) => { if (file.endsWith('/' + stage)) throw Error('disk full'); return save(file, ...args); };
   const task = execute(f, { transport: async () => { calls++; const body = raw(); return { status: 200, text: JSON.stringify(body), json: body }; } });
   if (stage === 'result.json') await assert.rejects(task); else assert.equal((await task).summary.answered, 0);
   assert.equal(calls, stage === 'request.json' ? 0 : 1);
   if (stage === 'result.json') assert.equal(runner.status(f.directory).questions[0].state, 'incomplete_outcome_unknown');
  }
 });
 await test('cancellation is forwarded and provider error secrets are excluded', async () => {
  const f = fixture('cancel'); let cancelled = 0;
  const { calls, summary } = await execute(f, { transport: options => new Promise((resolve, reject) => {
   options.registerCancel(() => { cancelled++; reject(Error('Authorization: synthetic-key-never-record')); }); f.controller.abort();
  }) });
  assert.equal(calls, 1); assert.equal(cancelled, 1); assert.equal(summary.records[0].state, 'cancelled');
  const route = JSON.parse(fs.readFileSync(path.join(f.directory, 'ml-beginner.json')));
  const s = runner.createServices(loaded.runtime, f.storage); const study = await s.service.get(route.topicId, route.route);
  assert(!JSON.stringify(study).includes('synthetic-key')); await s.service.dispose();
  const fresh = fixture('aborted'); fresh.controller.abort(); assert.equal((await execute(fresh)).calls, 0);
 });
 await test('late uncooperative transport cannot append a response after cancellation', async () => {
  const f = fixture('late'); let finish;
  const result = await execute(f, { transport: () => { const promise = new Promise(resolve => { finish = resolve; }); f.controller.abort(); return promise; } });
  assert.equal(result.summary.records[0].state, 'cancelled');
  const body = raw(); finish({ status: 200, text: JSON.stringify(body), json: body });
  await new Promise(resolve => setImmediate(resolve));
  assert(!fs.existsSync(path.join(f.directory, 'M01/response.txt'))); assert.equal(result.calls, 1);
 });
 await test('tampered raw response fails replay without creating a review file', async () => {
  fs.appendFileSync(path.join(complete.directory, 'M01/response.txt'), 'changed');
  const output = path.join(root, 'tampered-review.md');
  await assert.rejects(reporter.report(complete.directory, prepared.directory, prepared.planHash, output), /changed/);
  assert(!fs.existsSync(output));
 });
 await test('existing run targets and vault/repository output paths cannot be reused', () => {
  assert.throws(() => fs.mkdirSync(complete.directory));
  assert.throws(() => io.privateTarget(path.join(io.ROOT, 'forbidden')));
  assert.throws(() => io.privateTarget(path.join(prepared.directory, 'forbidden'), [prepared.directory]));
 });
 await test('new eight-question suite uses frozen inventory, actual services and isolated main contexts', async () => {
  const preparedNew = require('../scripts/prepare-topic-quality-run.cjs').prepareRun(path.join(root, 'transfer-plan'), 'topic-t1-transfer-v1');
  const transferred = runner.loadPlan(preparedNew.directory, preparedNew.planHash);
  assert.equal(transferred.plan.questionCount, 8); assert.equal(transferred.runtime.TOPIC_TEACHING_RULES, loaded.runtime.TOPIC_TEACHING_RULES);
  const f = fixture('transfer', transferred), ids = ['S01', 'S02', 'S03', 'S04', 'P01', 'P02', 'P03', 'P04'];
  assert.deepEqual(runner.status(f.directory).questions.map(q => q.id), ids);
  assert(runner.status(f.directory).questions.every(q => q.state === 'not_started'));
  const { summary, calls } = await execute(f); assert.equal(calls, 8); assert.equal(summary.answered, 8);
  const reviewed = await reporter.inspect(f.directory, preparedNew.directory, preparedNew.planHash);
  assert.deepEqual(reviewed.records.map(r => r.id), ids);
  for (const id of ['S03', 'S04', 'P03', 'P04']) {
   const wire = fs.readFileSync(path.join(f.directory, id, 'teaching-request.json'), 'utf8');
   assert.equal(JSON.parse(JSON.parse(wire).prompt).context.length, 1);
   assert(!/expectedPoints|mustNotClaim|psu-association|independentReview/.test(wire));
  }
  assert(runner.status(f.directory).questions.every(q => q.state === 'answered'));
  const restored = require('node:child_process').execFileSync(process.execPath, ['-e', 'require(process.argv[1]).inspect(process.argv[2],process.argv[3],process.argv[4]).then(r=>console.log(r.records.length)).catch(()=>process.exit(1))',
   path.resolve(__dirname, '../scripts/report-topic-quality.cjs'), f.directory, preparedNew.directory, preparedNew.planHash], { encoding: 'utf8', windowsHide: true });
  assert.equal(restored.trim(), '8');
  const file = path.join(f.directory, 'manifest.json'), bytes = fs.readFileSync(file), manifest = JSON.parse(bytes);
  delete manifest.questionIds; fs.writeFileSync(file, JSON.stringify(manifest));
  await assert.rejects(reporter.inspect(f.directory, preparedNew.directory, preparedNew.planHash), /inventory/);
  fs.writeFileSync(file, bytes);
 });
 await test('legacy inventory fallback and malformed inventories fail without reading question paths', async () => {
  const f = fixture('legacy-status'), file = path.join(f.directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  delete manifest.questionIds; fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(runner.status(f.directory).questions.length, 9);
  for (const questionIds of [null, [], ['../M01'], ['M01','M01'], ['S01']]) {
   fs.writeFileSync(file, JSON.stringify({ ...manifest, questionIds }));
   if (questionIds?.length !== 1 || questionIds[0] !== 'S01') assert.throws(() => runner.status(f.directory));
   else await assert.rejects(reporter.inspect(f.directory, prepared.directory, prepared.planHash), /inventory/);
  }
  assert.throws(() => require('../scripts/prepare-topic-quality-run.cjs').prepareRun(path.join(root, 'wrong-rules'), 'topic-t1-v1'), /current production/);
  assert(!fs.existsSync(path.join(root, 'wrong-rules')));
 });
 console.log(`TOPIC_QUALITY_RUNNER_OK: ${tests} groups; retained ${root}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
