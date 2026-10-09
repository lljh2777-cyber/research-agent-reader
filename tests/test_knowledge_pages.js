"use strict";
// Memory-only journal and target files. No deletion, network, or model calls.
const assert = require('node:assert/strict');
const { loadReading } = require('./reading-test-helpers');
const { storage } = require('./source-intake-fixtures.cjs');
const { mocks, fixture: excerptFixture } = require('./excerpt-fixtures.cjs');
const { KnowledgeDraftStore } = loadReading('curation/draft-store.ts', mocks);
const { newKnowledgeDraft, readDraftMaterial } = loadReading('curation/draft.ts', mocks);
const { KnowledgePages, pagePath, validatePagePlan, knowledgePageText } = loadReading('curation/page.ts', mocks);
const { maskLearningBlocks } = loadReading('learning/curated-block.ts');
const { chunkDocument } = loadReading('retrieval/chunks.ts');
const { readPendingCenter, pendingDestination } = loadReading('services/pending-center.ts', mocks);
async function fixture(options = {}) {
  const io = storage(), drafts = new KnowledgeDraftStore(io), files = new Map(), dirs = new Set(), writes = [];
  const d = { ...newKnowledgeDraft(), title: '概念测试', body: '个人理解：待核对。', ...options };
  const revision = await drafts.save(d, null);
  const api = {
    before: undefined, after: undefined,
    read: async p => files.has(p) ? files.get(p) : null,
    list: async () => [...files.keys()],
    directory: async p => { if (files.has(p)) throw Error('parent is file'); return dirs.has(p); },
    mkdir: async p => { if (files.has(p)) throw Error('parent is file'); dirs.add(p); },
    write: async (w, signal) => {
      await api.before?.(w); signal?.throwIfAborted();
      const current = files.has(w.path) ? files.get(w.path) : null;
      if (current === w.after) return;
      if (current !== w.before) throw Error('write conflict');
      files.set(w.path, w.after); writes.push(w.path); await api.after?.(w);
    }
  };
  const service = new KnowledgePages(drafts, io, api);
  const preview = filename => service.preview(d.id, revision.digest, filename || 'example.md');
  return { io, drafts, files, dirs, writes, d, revision, api, service, preview };
}
const empty = { entries: [], issues: [] };
const inputs = f => ({ library: async () => ({ papers: [], readIssues: [], complete: true }), acquisitions: { listJobs: async () => [], readJob: async () => null }, local: async () => [], excerpts: async () => empty, curation: async () => empty, tasks: () => [], drafts: s => f.service.summaries(s) });
let count = 0; async function test(name, run) { await run(); count++; console.log('PASS knowledge pages: ' + name); }
(async () => {
  await test('preview is read-only; explicit create adds one page and required index/log; repeated confirmation is idempotent', async () => {
    const f = await fixture(), before = f.io.writes.length, p = await f.preview();
    assert.equal(f.io.writes.length, before); assert.equal(f.files.size, 0); assert.equal(f.dirs.size, 0); assert.equal(p.writes.length, 3);
    assert.equal((await f.service.apply(p)).complete, true); assert.equal(f.files.size, 3); assert.equal(f.writes.length, 3);
    assert.match(f.files.get('研究主题索引.md'), /wiki\/concepts\/example/); assert.match(f.files.get('wiki/log.md'), /未作论文证据核验/);
    await f.service.apply(p); assert.equal(f.writes.length, 3); assert.equal((await f.drafts.read(f.d.id)).revisions.length, 1);
    await assert.rejects(f.preview('another'), /已有建页记录/);
  });
  await test('kind selects only existing concept/method/synthesis taxonomy; invalid paths and reserved names reject', async () => {
    for (const [kind, folder, index] of [['concept', 'concepts', '研究主题索引.md'], ['method', 'methods', '研究方法索引.md'], ['synthesis', 'synthesis', '研究主题索引.md']]) {
      const f = await fixture({ kind }), p = await f.preview(); assert.equal(p.path, `wiki/${folder}/example.md`); assert.equal(p.writes[1].path, index);
    }
    const f = await fixture(); for (const name of ['../x', '/tmp', 'x\\y', '.hidden', 'CON', 'nul.md', 'a#b', 'x|y', 'file.', 'a\nb', 'a'.repeat(101)]) assert.throws(() => pagePath(f.d, name));
    f.files.set('wiki', 'file'); await assert.rejects(f.preview(), /parent/);
  });
  await test('same path, Unicode/case title and basename collisions fail; duplicate scan reads actual content', async () => {
    for (const [path, text] of [['wiki/concepts/example.md', 'existing'], ['wiki/methods/other.md', '---\ntitle: 概念测试\n---\n'], ['wiki/synthesis/EXAMPLE.md', '# unrelated']]) {
      const f = await fixture(); f.files.set(path, text); await assert.rejects(f.preview(), /已有|同名/); assert.equal(f.writes.length, 0);
    }
    const f = await fixture({ title: 'ＡＢＣ' }); f.files.set('wiki/methods/other.md', '---\ntitle: abc\n---\n'); await assert.rejects(f.preview(), /同名/);
  });
  await test('stale draft, target, index and log each invalidate approval before any journal or page write', async () => {
    for (const change of ['draft', 'page', 'index', 'log']) {
      const f = await fixture(), p = await f.preview(), before = f.io.writes.length;
      if (change === 'draft') await f.drafts.save({ ...f.d, body: 'later edit' }, f.revision.digest);
      else f.files.set(p.writes.find(w => w.role === change).path, 'external');
      await assert.rejects(f.service.apply(p), /变化|已有|同名/); assert.equal(f.writes.length, 0); assert.equal(await f.service.record(f.d.id), null);
      if (change !== 'draft') assert.equal(f.io.writes.length, before);
    }
  });
  await test('partial failures at page/index/log resume the same approved files after process restart', async () => {
    for (const role of ['page', 'index', 'log']) {
      const f = await fixture(), p = await f.preview(); f.api.before = async w => { if (w.role === role) throw Error('disk failure'); };
      await assert.rejects(f.service.apply(p), /disk failure/); assert.equal((await f.service.record(f.d.id)).complete, false);
      f.api.before = undefined; const restarted = new KnowledgePages(new KnowledgeDraftStore(f.io), f.io, f.api), record = await restarted.record(f.d.id);
      await restarted.apply(record.plan); assert.equal(f.writes.length, 3); assert.equal(f.files.size, 3); assert.equal((await restarted.record(f.d.id)).complete, true);
    }
  });
  await test('late cancellation retains page and unfinished intent; explicit recovery uses frozen draft even if draft later edited', async () => {
    const f = await fixture(), p = await f.preview(), controller = new AbortController(); f.api.after = async w => { if (w.role === 'page') controller.abort(); };
    await assert.rejects(f.service.apply(p, controller.signal), /abort/i); assert.equal(f.writes.length, 1);
    await f.drafts.save({ ...f.d, body: 'new draft text' }, f.revision.digest); f.api.after = undefined;
    await f.service.apply((await f.service.record(f.d.id)).plan); assert.equal(f.files.get(p.path), p.writes[0].after); assert.equal(f.writes.length, 3);
  });
  await test('concurrent changes during partial writes stop without overwriting; later page edits survive completed retry', async () => {
    const f = await fixture(), p = await f.preview(); f.api.after = async w => { if (w.role === 'page') f.files.set(p.writes[1].path, 'human index'); };
    await assert.rejects(f.service.apply(p), /变化/); assert.equal(f.files.get(p.writes[1].path), 'human index'); assert.equal(f.writes.length, 1);
    const g = await fixture(), q = await g.preview(); await g.service.apply(q); g.files.set(q.path, 'human page'); await g.service.apply(q); assert.equal(g.files.get(q.path), 'human page');
  });
  await test('lost journal response and failed completion marker preserve exact intent and create no duplicate files', async () => {
    for (const phase of ['intent', 'marker']) {
      const f = await fixture(), p = await f.preview(); let once = true;
      if (phase === 'intent') f.io.after = async path => { if (once && path.startsWith('knowledge-pages/') && path.endsWith('.json')) { once = false; throw Error('lost response'); } };
      else f.io.before = async path => { if (path.endsWith('.complete')) throw Error('marker failed'); };
      if (phase === 'intent') await f.service.apply(p); else { await assert.rejects(f.service.apply(p), /marker failed/); f.io.before = undefined; await f.service.apply(p); }
      assert.equal(f.writes.length, 3); assert.equal((await f.service.record(f.d.id)).complete, true);
    }
  });
  await test('competing previews for one draft cannot publish different pages', async () => {
    const f = await fixture(), a = await f.preview('one'), b = await f.preview('two'), other = new KnowledgePages(f.drafts, f.io, f.api);
    const result = await Promise.allSettled([f.service.apply(a), other.apply(b)]); assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal([...f.files.keys()].filter(p => p.startsWith('wiki/concepts/')).length, 1);
  });
  await test('corrupt or forged journal cannot redirect writes or claim completion', async () => {
    const f = await fixture(), p = await f.preview();
    for (const mutate of [p => p.path = 'wiki/sources/x.md', p => p.writes[0].after += 'forged', p => p.writes[1].path = 'papers/index.md', p => p.directories.push('papers'), p => p.draft.version = 2]) {
      const bad = structuredClone(p); mutate(bad); assert.throws(() => validatePagePlan(bad));
    }
    f.io.files.set(`knowledge-pages/${f.d.id}.json`, Buffer.from('{')); await assert.rejects(f.service.record(f.d.id)); assert.equal((await f.service.summaries()).entries[0].issues.length, 1);
  });
  await test('literal user content and Markdown excerpts never execute links or enter knowledge chunks', async () => {
    const source = await excerptFixture(), material = await readDraftMaterial(source.app, { kind: 'excerpt', ref: source.record, includeNote: true });
    const f = await fixture({ body: 'SECRET_CLAIM\n```\n<script>run()</script>\n![[papers/raw]]', material }), text = knowledgePageText(f.revision), masked = maskLearningBlocks(text);
    assert.ok(text.includes('SECRET_CLAIM')); assert.ok(text.includes(source.record.selectedText)); assert.ok(text.includes(source.record.manualText)); assert.ok(!masked.includes('SECRET_CLAIM')); assert.ok(!masked.includes('Repeated'));
    const chunks = chunkDocument({ path: 'wiki/concepts/example.md', title: f.d.title, text, hash: 'test', aliases: [], origins: [], depth: 'unreviewed', basis: 'unverified' });
    assert.ok(chunks.every(c => !c.text.includes('SECRET_CLAIM') && !c.text.includes('Repeated')));
    const p = await f.preview(); await f.service.apply(p); assert.equal(f.files.get(p.path), text);
  });
  await test('pending navigation changes with intent and completion; missing published page remains visible for review', async () => {
    const f = await fixture(), signal = new AbortController().signal, before = await readPendingCenter(inputs(f), signal), p = await f.preview();
    f.api.before = async () => { throw Error('fail'); }; await assert.rejects(f.service.apply(p)); const pending = await readPendingCenter(inputs(f), signal);
    assert.match(pending.items[0].detail, /建页未完成/); assert.throws(() => pendingDestination(before.items[0], pending), /变化|刷新/);
    f.api.before = undefined; await f.service.apply(p); assert.equal((await readPendingCenter(inputs(f), signal)).items.length, 0);
    f.api.read = async path => path === p.path ? null : f.files.get(path) ?? null; const missing = await readPendingCenter(inputs(f), signal); assert.match(missing.items[0].detail, /缺失/);
  });
  await test('bounded title scan and oversized index fail before writes; pre-aborted operation leaves no intent', async () => {
    const f = await fixture(); f.api.list = async () => Array.from({ length: 5001 }, (_, i) => 'wiki/concepts/' + i + '.md'); await assert.rejects(f.preview(), /5,000/);
    const g = await fixture(); g.files.set('研究主题索引.md', 'x'.repeat(1024 * 1024 + 1)); await assert.rejects(g.preview(), /1 MiB/); assert.equal(g.writes.length, 0);
    const h = await fixture(), p = await h.preview(), c = new AbortController(); c.abort(); await assert.rejects(h.service.apply(p, c.signal), /abort/i); assert.equal(await h.service.record(h.d.id), null);
  });
  console.log(`KNOWLEDGE_PAGES_OK (${count} groups)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
