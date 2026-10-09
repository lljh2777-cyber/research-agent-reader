"use strict";
// Pure memory fixtures; no files, network, live providers or deletion.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { TopicSessionStore } = loadReading("topic-learning/store.ts");
const { TopicLearningService } = loadReading("topic-learning/service.ts");
const { TopicWorkspaceController, restoreTopicDraft } = loadReading("topic-learning/workspace.ts");
const intent = { topic: "机器学习", goal: "理解训练与评估", background: "零基础" };
const plan = { version: 1, modules: [
  { id: "unit-a", title: "预测与目标", question: "预测什么？", objective: "能区分输入和目标", prerequisites: [] },
  { id: "unit-b", title: "训练与评估", question: "为什么划分数据？", objective: "能解释独立测试集", prerequisites: ["unit-a"] },
] };
function io() {
  const files = new Map(), dirs = new Set(), writes = [];
  return { files, writes, async read(p) { return files.get(p) || null; }, async mkdir(p) { dirs.add(p); }, async create(p, bytes) { assert(!files.has(p)); writes.push(p); files.set(p, Buffer.from(bytes)); },
    async list(p) { return [...dirs, ...files.keys()].filter(k => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map(k => ({ name: k.slice(p.length + 1), directory: dirs.has(k) })); } };
}
function fixture() { const storage = io(), service = new TopicLearningService(new TopicSessionStore(storage)); let updates = 0; const c = new TopicWorkspaceController(service, () => updates++); return { storage, service, c, updates: () => updates }; }
const backend = complete => ({ name: "Mock", model: "route-model", images: false, complete: complete || (async () => JSON.stringify(plan)) });
const deferred = () => { let resolve; return { promise: new Promise(r => resolve = r), resolve }; };
async function initial(f) { f.c.draft.intent = structuredClone(intent); await f.c.saveIntent(); assert(f.c.current); return f.c.current; }
(async () => {
  // Startup is read-only; invalid/partial editor drafts are bounded and restorable.
  {
    const f = fixture(); await f.c.refresh(); assert.equal(f.storage.writes.length, 0); assert.equal(f.c.total, 0);
    const restored = restoreTopicDraft({ id: "../outside", base: "invalid", intent: { topic: "x".repeat(500) }, plan: { modules: [null, {}] } });
    assert.equal(restored.id, ""); assert.equal(restored.intent.topic.length, 160); assert.equal(restored.plan.modules.length, 2);
    const before = await initial(f); f.c.addModule(); const draft = structuredClone(f.c.draft);
    const c2 = new TopicWorkspaceController(f.service, () => {}); c2.setDraft(draft); await c2.refresh();
    assert.equal(c2.current.digest, before.digest); assert(c2.dirty); assert.deepEqual(c2.draft, draft);
    await c2.savePlan(); assert.match(c2.message, /2–12/); assert.deepEqual(c2.draft, draft);
  }
  // Manual editor IDs and prerequisites survive edits, confirmation, explicit copy and re-read.
  {
    const f = fixture(); await initial(f); f.c.draft.plan = structuredClone(plan);
    f.c.moveModule("unit-b", -1); assert.equal(f.c.draft.plan.modules[0].id, "unit-a"); assert.match(f.c.message, /先修/);
    await f.c.savePlan(); assert(!f.c.dirty); await f.c.confirm(); assert(f.c.current.session.confirmation);
    const saved = f.c.current; f.c.draft.plan.modules[1].objective = "能识别数据泄漏"; await f.c.savePlan(); assert(!f.c.current.session.confirmation);
    const snapshot = [...f.storage.files].map(([k, v]) => [k, v.toString()]);
    await f.c.copyRevision(saved.digest); assert.notEqual(f.c.draft.id, saved.session.id); assert(!f.c.current.session.confirmation); assert.deepEqual(f.c.current.session.plan, plan);
    for (const [k, v] of snapshot) assert.equal(f.storage.files.get(k).toString(), v);
    f.c.removeModule("unit-a"); assert.deepEqual(f.c.draft.plan.modules[0].prerequisites, []);
    const dirty = structuredClone(f.c.draft); await f.c.select(saved.session.id); assert.deepEqual(f.c.draft, dirty); assert.match(f.c.message, /先保存/);
    await f.c.select(saved.session.id, true); assert.equal(f.c.draft.id, saved.session.id);
  }
  // Stale drafts never overwrite an external change; copying the local goal preserves its unsaved route.
  {
    const f = fixture(), r = await initial(f); f.c.draft.plan = structuredClone(plan);
    await f.service.editIntent(r.session.id, r.digest, { ...intent, goal: "其他窗口的新目标" }); await f.c.refresh(); assert(f.c.stale);
    await f.c.savePlan(); assert.match(f.c.message, /已变化/); assert.deepEqual(f.c.draft.plan, plan);
    await f.c.copyDraft(); assert.notEqual(f.c.draft.id, r.session.id); assert(f.c.dirty); assert.deepEqual(f.c.draft.intent, intent); assert.deepEqual(f.c.draft.plan, plan);
    assert.equal((await f.service.get(r.session.id)).session.intent.goal, "其他窗口的新目标");
  }
  // One explicit request; no backend construction on dirty/confirmed forms. Unknown usage stays unknown.
  {
    const f = fixture(); await initial(f); let calls = 0;
    f.c.draft.intent.goal = "unsaved"; await f.c.generate(() => { calls++; return backend(); }); assert.equal(calls, 0);
    await f.c.select(f.c.draft.id, true);
    await f.c.generate(() => backend(async req => { calls++; assert(!req.webSearch); assert.deepEqual(req.images, []); req.onUsage({ input: 72, output: 19, cachedInput: 0 }); return JSON.stringify(plan); }));
    assert.equal(calls, 1); assert.equal(f.c.usage.input, 72); assert.equal(f.c.usage.state, "returned"); assert(!f.c.current.session.confirmation);
    await f.c.generate(() => backend()); assert.equal(f.c.usage.input, undefined); assert.equal(f.c.usage.output, undefined);
    await f.c.confirm(); await f.c.generate(() => { calls++; return backend(); }); assert.equal(calls, 1);
  }
  // Cancellation and disposal revoke late writes/callbacks, even with an uncooperative backend.
  for (const close of [false, true]) {
    const f = fixture(), r = await initial(f), gate = deferred(), entered = deferred(); let calls = 0, callback;
    const run = f.c.generate(() => backend(async req => { calls++; callback = req.onUsage; entered.resolve(); return gate.promise; }));
    await entered.promise; await f.c.generate(() => { throw new Error("duplicate factory"); }); assert.equal(calls, 1);
    if (close) f.c.dispose(); else f.c.cancel(); const updates = f.updates(); await run;
    callback({ input: 999 }); gate.resolve(JSON.stringify(plan)); await new Promise(r => setImmediate(r));
    assert.equal((await f.service.get(r.session.id)).digest, r.digest); assert.notEqual(f.c.usage.input, 999);
    if (close) assert.equal(f.updates(), updates); else { assert.equal(f.c.usage.state, "cancelled"); await f.c.generate(() => backend()); assert.equal(f.c.usage.state, "returned"); }
  }
  // Failed model/save leaves the editable buffer intact and requires an explicit retry.
  {
    const f = fixture(); await initial(f); const saved = f.c.current.digest;
    await f.c.generate(() => backend(async () => "bad json")); assert.equal(f.c.current.digest, saved); assert.equal(f.c.usage.state, "failed");
    f.c.draft.plan = structuredClone(plan); const create = f.storage.create; f.storage.create = async () => { throw new Error("disk full"); };
    await f.c.savePlan(); assert.match(f.c.message, /disk full/); assert.deepEqual(f.c.draft.plan, plan);
    f.storage.create = create; await f.c.savePlan(); assert(!f.c.dirty);
  }
  // Multi-head histories can be inspected and explicitly copied without choosing or mutating a winner.
  {
    const f = fixture(), r = await initial(f), create = f.storage.create, barrier = deferred(); let bodies = 0;
    f.storage.create = async (p, bytes) => { await create(p, bytes); if (p.endsWith(".json")) { if (++bodies === 2) barrier.resolve(); await barrier.promise; } };
    await Promise.allSettled([f.service.editIntent(r.session.id, r.digest, { ...intent, goal: "branch A" }), f.service.editIntent(r.session.id, r.digest, { ...intent, goal: "branch B" })]);
    f.storage.create = create; await f.c.select(r.session.id, true); assert(f.c.stale); assert(!f.c.dirty); assert.equal(f.c.history.revisions.length, 3);
    const candidate = f.c.history.revisions.find(r => r.session.intent.goal === "branch B"), snapshot = [...f.storage.files].map(([k, v]) => [k, v.toString()]);
    await f.c.copyRevision(candidate.digest); assert.equal(f.c.current.session.intent.goal, "branch B"); assert.notEqual(f.c.draft.id, r.session.id);
    for (const [k, v] of snapshot) assert.equal(f.storage.files.get(k).toString(), v);
    await assert.rejects(f.service.copyRevision(r.session.id, "a".repeat(64)), /无法核验/);
  }
  console.log("TOPIC_WORKSPACE_OK: drafts, exact history, manual route, usage, cancellation, close, failed writes and explicit conflict copies");
})().catch(error => { console.error(error); process.exitCode = 1; });
