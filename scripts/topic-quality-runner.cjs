"use strict";
// Explicit local benchmark. Never mutates plugin configuration or resumes a paid request.
const fs = require('node:fs'), path = require('node:path');
const io = require('./reading-quality-io.cjs');
const suites = require('./topic-quality-suites.cjs');
const { isDeepStrictEqual: same } = require('node:util');
const active = new Map(), PROTOCOL = 'topic-quality-run-1';
const fail = message => { throw Error(message); };
const json = (root, file) => JSON.parse(io.readFile(root, file));
function loadPlan(directory, expectedHash, checkSource = true) {
 const { planHash, ...plan } = json(directory, 'plan.json');
 const inputs = json(directory, 'inputs.json'), spec = json(directory, 'specification.json');
 const suite = Object.hasOwn(suites, spec.id) ? suites[spec.id] : null;
 const samples = spec.samples?.map(s => ({ id: s.id, intent: s.intent, plan: s.plan,
  steps: s.steps.map(q => q.action === 'next' ? { id: q.id, action: q.action } : { id: q.id, action: q.action, parent: q.parent, question: q.question, newBranch: q.newBranch }) }));
 const ids = samples?.flatMap(s => s.steps.map(q => q.id));
 if (!suite || !Array.isArray(samples) || samples.length !== suite.samples || !ids || ids.length !== suite.questions ||
  new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Z]\d{2}$/.test(id)) ||
  samples.some(s => typeof s.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(s.id)) || new Set(samples.map(s => s.id)).size !== samples.length ||
  !same(inputs.samples, samples) || inputs.promptVersion !== suite.prompt) fail('Invalid frozen question inventory');
 if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || planHash !== expectedHash || io.sha(JSON.stringify(plan)) !== planHash || plan.protocol !== PROTOCOL ||
  io.sha(JSON.stringify(inputs)) !== plan.inputHash || io.sha(JSON.stringify(spec)) !== plan.baselineHash ||
  io.sha(io.readFile(directory, 'runtime.cjs')) !== plan.runtimeHash ||
  plan.questionCount !== suite.questions || plan.sampleCount !== suite.samples ||
  plan.baselineId !== undefined && plan.baselineId !== spec.id) fail('Frozen plan or runtime changed');
 if (checkSource) {
  if (io.sha(fs.readFileSync(__filename)) !== plan.runnerHash) fail('Runner changed; prepare a new plan');
  if (plan.suiteRegistryHash !== undefined && io.sha(fs.readFileSync(path.join(__dirname, 'topic-quality-suites.cjs'))) !== plan.suiteRegistryHash) fail('Suite registry changed; prepare a new plan');
  for (const source of plan.sources) if (io.sha(io.readFile(io.ROOT, source.file)) !== source.sha256) fail('Teaching source changed; prepare a new baseline');
 }
 // Prepared runtime is local executable code, just like the runner; hash binds it to the explicit plan.
 const runtime = require(path.join(fs.realpathSync(directory), 'runtime.cjs'));
 if (runtime.STUDY_PROMPT_VERSION !== inputs.promptVersion || io.sha(runtime.TOPIC_TEACHING_RULES) !== plan.instructionHash || inputs.system !== runtime.TOPIC_TEACHING_RULES) fail('Teaching instruction mismatch');
 return { plan: { ...plan, planHash }, inputs, spec, runtime };
}
function profileInfo(profile, runtime) {
 const url = new URL(profile.baseUrl);
 if (profile.type !== 'openai-compatible' || !profile.model?.trim() || url.username || url.password || url.search || url.hash ||
  !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('Use a verified OpenAI-compatible HTTPS or loopback profile');
 return { id: profile.id, name: profile.name, type: profile.type, model: profile.model, baseUrl: url.href.replace(/\/$/, ''),
  structuredOutput: runtime.supportsReadingSchema(profile), maxTokens: 5000, timeoutMs: 120000, streaming: false, automaticRetries: 0, webSearch: false };
}
function requestData(request) {
 // Only the exact production teaching shape is permitted; optional tools/flags cannot be hidden by projection.
 if (Object.keys(request).some(k => !['system', 'prompt', 'schema', 'images', 'signal', 'maxTokens', 'onUsage'].includes(k)) || request.images.length) fail('Unexpected teaching request capability');
 return { system: request.system, prompt: request.prompt, schema: request.schema, images: request.images, maxTokens: request.maxTokens };
}
function wireBody(request, profile) {
 return { model: profile.model, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }], max_tokens: request.maxTokens, stream: false,
  ...(profile.structuredOutput ? { response_format: { type: 'json_schema', json_schema: { name: 'reading_result', schema: request.schema, strict: true } } } : {}) };
}
function usage(raw) {
 const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
 return { input: count(raw?.prompt_tokens), output: count(raw?.completion_tokens), total: count(raw?.total_tokens), cachedInput: count(raw?.prompt_tokens_details?.cached_tokens), monetaryCost: null };
}
function responseState(receipt, node, cancelled) {
 if (cancelled || node?.status === 'cancelled') return 'cancelled';
 if (!receipt) return 'failed';
 if (receipt.status < 200 || receipt.status >= 300) return 'http_error';
 const choice = receipt.raw?.choices?.[0];
 if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) return 'refused';
 if (choice?.finish_reason === 'length') return 'truncated';
 if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) return 'empty_answer';
 if (choice.finish_reason !== 'stop') return 'unexpected_finish';
 return node?.status === 'done' ? 'answered' : 'invalid_answer';
}
function diskStore(directory) {
 const save = (file, value, raw = false) => {
  const bytes = raw ? value : JSON.stringify(value, null, 2) + '\n';
  const handle = fs.openSync(path.join(directory, file), 'wx', 0o600);
  try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  return io.sha(bytes);
 };
 return {
  save,
  begin(id, value) { fs.mkdirSync(path.join(directory, id)); return save(id + '/started.json', value); },
  finish(value) { return save('summary.json', value); }
 };
}
function createServices(runtime, storage) {
 const topics = new runtime.TopicLearningService(new runtime.TopicSessionStore(storage));
 const service = new runtime.TopicStudyService(new runtime.TopicStudyStore(storage), topics);
 return { topics, service };
}
// Clone the host, never replace the live plugin's transport or settings.
function obsidianBackend(plugin, selected, hooks) {
 const host = Object.create(plugin), snapshot = structuredClone(selected);
 host.getProviderProfile = id => id === snapshot.id ? snapshot : null;
 host.getVerifiedProviderProfiles = () => [snapshot];
 host.providerHttpStream = () => fail('Streaming is disabled for this benchmark');
 host.providerHttpRequest = async options => {
  try {
   hooks.signal.throwIfAborted();
   hooks.onRequest({ url: options.url, method: options.method, body: options.body, timeoutMs: options.timeoutMs });
   const response = await plugin.providerHttpRequest(options);
   hooks.onResponse(response);
   return response;
  } catch { throw Error('Benchmark transport failed; inspect retained receipts. No automatic retry.'); }
 };
 const backend = host.createTopicBackend(snapshot.id);
 return { name: backend.name, model: backend.model, images: backend.images, async complete(request) {
  try { return await backend.complete(request); }
  catch { throw Error('Benchmark backend failed; inspect retained receipts. No automatic retry.'); }
 } };
}
async function run({ loaded, profile, storage, store, makeBackend, signal, mode = 'simulated' }) {
 const { runtime, inputs, plan } = loaded, { topics, service } = createServices(runtime, storage);
 const records = [], ids = inputs.samples.flatMap(s => s.steps.map(q => q.id));
 let stopped = false;
 try {
  for (const sample of inputs.samples) {
   if (stopped || signal.aborted) break;
   const created = await topics.create(sample.intent), topicId = created.session.id;
   const edited = await topics.editPlan(topicId, created.digest, sample.plan), confirmed = await topics.confirmPlan(topicId, edited.digest);
   const route = await service.start(topicId, confirmed.digest), nodes = new Map();
   store.save(sample.id + '.json', { topicId, route, revision: confirmed.digest });
   for (const step of sample.steps) {
    if (stopped || signal.aborted) break;
    const before = await service.get(topicId, route);
    const action = step.action === 'next' ? { kind: 'next' } : { kind: 'ask', parentId: nodes.get(step.parent), question: step.question, newBranch: step.newBranch };
    const spec = action.kind === 'next' ? runtime.nextTopicNode(before) : runtime.topicQuestion(before, action.parentId, action.question, action.newBranch);
    const expected = requestData(runtime.topicTeachingRequest(before, spec, signal));
    const startedAt = new Date().toISOString(), start = Date.now();
    store.begin(step.id, { sampleId: sample.id, step, topicId, route, beforeHead: before.head, startedAt, mode });
    let requestHash = null, backendHash = null, responseHash = null, receipt = null, dispatched = false, closed = false, violated = false;
    const reject = message => { violated = true; fail(message); };
    const hooks = {
     signal,
     onRequest(wire) {
      if (closed || dispatched || !backendHash || hooks.signal.aborted || wire.url !== profile.baseUrl + '/chat/completions' || wire.method !== 'POST' || wire.timeoutMs !== profile.timeoutMs || !same(wire.body, wireBody(expected, profile))) reject('Actual request differs or attempted an additional dispatch');
      try { requestHash = store.save(step.id + '/request.json', { url: wire.url, method: wire.method, body: wire.body }); }
      catch { reject('Request receipt could not be saved'); }
      dispatched = true; // Receipt is synced before the transport is invoked; a crash here still means outcome unknown.
     },
     onResponse(response) {
      if (closed || !dispatched || receipt || hooks.signal.aborted || !Number.isInteger(response.status) || typeof response.text !== 'string' || Buffer.byteLength(response.text) > 5 * 1024 * 1024) reject('Unexpected response lifecycle');
      try { responseHash = store.save(step.id + '/response.txt', response.text, true); store.save(step.id + '/response-meta.json', { status: response.status, sha256: responseHash }); }
      catch { reject('Response receipt could not be saved'); }
      let raw = null; try { raw = JSON.parse(response.text); } catch { /* Retain invalid raw bytes. */ }
      receipt = { status: response.status, raw };
     }
    };
    try {
     await service.generate(topicId, route, before.head, action, () => {
      const backend = makeBackend(hooks);
      if (backend.model !== profile.model || backend.name !== profile.name) reject('Backend profile changed');
      return { name: backend.name, model: backend.model, images: backend.images, async complete(request) {
       if (closed || backendHash || !same(requestData(request), expected)) reject('Production teaching request changed');
       backendHash = store.save(step.id + '/teaching-request.json', expected);
       // Bind cancellation to the production service timeout as well as the outer benchmark.
       hooks.signal = request.signal;
       try { return await backend.complete(request); }
       catch { throw Error('Benchmark request failed; retained first attempt is final for this run.'); }
      } };
     }, signal);
    } finally { closed = true; }
    const after = await service.get(topicId, route), node = after.nodes.at(-1);
    if (!node || after.nodes.length !== before.nodes.length + 1 || node.attempts.length !== 1) fail('Missing unique first teaching attempt');
    nodes.set(step.id, node.id);
    const state = violated ? 'protocol_failure' : responseState(receipt, node, signal.aborted);
    const record = { id: step.id, sampleId: sample.id, state, mode, nodeId: node.id, requestId: node.attempts[0].requestId, head: after.head,
     contextIds: node.attempts[0].contextIds, backendHash, requestHash, responseHash, dispatched, responseReceived: !!receipt,
     reportedModel: typeof receipt?.raw?.model === 'string' ? receipt.raw.model : null, finishReason: receipt?.raw?.choices?.[0]?.finish_reason ?? null,
     usage: usage(receipt?.raw?.usage), elapsedMs: Date.now() - start, independentReview: 'pending' };
    store.save(step.id + '/result.json', record); records.push(record);
    stopped = state !== 'answered';
   }
  }
  const summary = { protocol: PROTOCOL, planHash: plan.planHash, mode, profile, state: signal.aborted ? 'cancelled' : stopped ? 'stopped_after_failure' : 'completed',
   recorded: records.length, answered: records.filter(r => r.state === 'answered').length, remaining: ids.slice(records.length), records, independentReview: 'pending' };
  store.finish(summary); return summary;
 } finally { await service.dispose(); topics.dispose(); }
}
function startInObsidian(app, options) {
 if (active.size) fail('A teaching benchmark is already active');
 const { planDirectory, planHash, outputDirectory, profileId } = options, loaded = loadPlan(planDirectory, planHash);
 const plugin = app.plugins.plugins['research-agent-reader'], selected = plugin?.getVerifiedProviderProfiles().find(p => p.id === profileId);
 if (!selected) fail('Select an already verified model profile');
 const profile = profileInfo(selected, loaded.runtime), vault = app.vault.adapter.getBasePath();
 const deployed = path.join(vault, plugin.manifest.dir || '.obsidian/plugins/research-agent-reader', 'main.js');
 if (plugin.manifest.version !== loaded.plan.pluginVersion || io.sha(fs.readFileSync(deployed)) !== loaded.plan.pluginHash) fail('Deployed plugin differs from prepared runtime baseline');
 const directory = io.privateTarget(outputDirectory, [planDirectory, vault]); fs.mkdirSync(directory);
 const store = diskStore(directory);
 store.save('manifest.json', { protocol: PROTOCOL, mode: 'live', planHash, profile, pluginVersion: plugin.manifest.version, pluginHash: loaded.plan.pluginHash,
  runnerHash: loaded.plan.runnerHash, questionIds: loaded.inputs.samples.flatMap(s => s.steps.map(q => q.id)), startedAt: new Date().toISOString(), independentReview: 'pending' });
 const state = path.join(directory, 'state'); fs.mkdirSync(state);
 const controller = new AbortController(); active.set(directory, controller);
 run({ loaded, profile, storage: new loaded.runtime.FileSourceStorage(state), store, makeBackend: hooks => obsidianBackend(plugin, selected, hooks), signal: controller.signal, mode: 'live' })
  .catch(() => { try { store.save('interrupted.json', { state: 'storage_or_preflight_failure', automaticRetry: false, independentReview: 'pending' }); } catch { /* Retain earlier artifacts. */ } })
  .finally(() => active.delete(directory));
 return { started: true, directory, model: profile.model, maximumCalls: loaded.plan.questionCount };
}
function cancel(directory) { const c = active.get(path.resolve(directory)); if (!c) return false; c.abort(); return true; }
function status(directory) {
 const running = active.has(path.resolve(directory));
 // Pre-T1.3D runs have no questionIds and used the original nine-question suite.
 const manifest = json(directory, 'manifest.json');
 const ids = manifest.questionIds === undefined ? ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'N01', 'N02', 'N03'] : manifest.questionIds;
 if (!Array.isArray(ids) || !ids.length || ids.length > 40 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Z]\d{2}$/.test(id))) fail('Invalid question inventory');
 const questions = ids.map(id => ({ id,
  state: fs.existsSync(path.join(directory, id, 'result.json')) ? json(directory, id + '/result.json').state : fs.existsSync(path.join(directory, id, 'started.json')) ? running ? 'running' : 'incomplete_outcome_unknown' : 'not_started' }));
 return { running, questions, hasSummary: fs.existsSync(path.join(directory, 'summary.json')) };
}
module.exports = { loadPlan, profileInfo, requestData, wireBody, usage, responseState, diskStore, createServices, obsidianBackend, run, startInObsidian, cancel, status };
