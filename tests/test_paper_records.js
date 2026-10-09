"use strict";
// All records, failures and races in this file are in memory. No cleanup or external services.
const assert = require("node:assert/strict"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { loadReading } = require("./reading-test-helpers"), f = require("./jats-fixtures.cjs");
const { JournalPaperRecordStore, readPaperRecordIdentities, validatePaperRecord } = loadReading("library/record-store.ts");
const { PaperRecordService } = loadReading("library/record-service.ts");
const { readPaperLibrary } = loadReading("library/reader.ts");
const { JatsIntakeService } = loadReading("jats/intake.ts"), { SourceCatalog } = loadReading("papers/catalog.ts");
const { objectDigest } = loadReading("papers/identity.ts");
const pid = "p-00000001-0000-0000-0000-000000000000", otherPid = "p-00000002-0000-0000-0000-000000000000";
const record = (extra = {}) => ({ kind: "record", id: pid, paperId: pid, title: "Example paper", identifiers: { doi: "10.1234/a" }, readingState: "reading", ...extra });
const snapshot = storage => JSON.stringify([...storage.files].map(([name, bytes]) => [name, f.sha(bytes)]).sort());
const put = (storage, name, text) => { const parts = name.split("/"); for (let i = 1; i < parts.length; i++) storage.dirs.add(parts.slice(0, i).join("/")); storage.files.set(name, Buffer.from(typeof text === "string" ? text : JSON.stringify(text))); };
const noteText = (doi, body = "Body") => "---\n" + JSON.stringify({ title: "Note", doi }) + "\n---\n" + body;
async function setup() {
	const vault = f.storage(), plugin = f.storage(), journal = f.storage(), acquired = await f.fixture().acquire();
	const intake = new JatsIntakeService({ deviceId: f.sha("device"), catalog: new SourceCatalog(vault), journal, index: f.index(), read: async () => acquired, link: async () => {} });
	const plan = await intake.prepare(acquired.snapshot.jobId); await intake.save(plan.requestId, plan.evidenceDigest, false); await intake.dispose();
	const manifest = JSON.parse(vault.files.get(`papers/${plan.packageKey}/_source/manifest.json`));
	const note = "wiki/sources/example.md"; put(vault, note, noteText(manifest.identity.identifiers.doi));
	const scan = () => readPaperLibrary(vault, plugin, { vaultRoot: path.resolve("memory-library"), parseYaml: JSON.parse });
	const store = () => new JournalPaperRecordStore(plugin), service = () => new PaperRecordService(store(), scan);
	return { vault, plugin, note, manifest, scan, store, service, id: manifest.paperId };
}
async function race(storage, store, base, heads) {
	let arrived = 0, release; const gate = new Promise(resolve => { release = resolve; });
	storage.before = async name => { if (name.endsWith(".json")) { if (++arrived === 2) release(); await gate; } };
	const results = await Promise.allSettled([store.append({ ...base, readingState: "completed" }, heads), store.append({ ...base, readingState: "revisit" }, heads)]);
	storage.before = undefined; return results;
}
let checks = 0;
async function check(name, work) { await work(); checks++; console.log("PASS paper records: " + name); }
(async () => {
	await check("empty reads neither create directories nor allocate persistent identities", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage), dirs = [...storage.dirs];
		assert.deepEqual((await store.read(pid)).heads, []); assert.deepEqual(await readPaperRecordIdentities(storage), []);
		assert.deepEqual([...storage.dirs], dirs); assert.equal(storage.writes.length, 0);
	});
	await check("strict records reject new schemas, unsafe paths and noncanonical identifiers before writes", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage);
		for (const item of [record({ id: otherPid }), record({ readingState: "model_understood" }), record({ identifiers: { doi: "https://doi.org/10.1234/a" } }), record({ primaryNoteId: "../elsewhere.md" }), record({ model: "unwanted" })]) await assert.rejects(store.append(item, []));
		assert.equal(storage.writes.length, 0); assert.deepEqual([...storage.dirs], [""]);
		assert.deepEqual(validatePaperRecord(record()), record());
	});
	await check("first explicit save reuses the managed paperId, persists only decisions and reloads into the library", async () => {
		const x = await setup(), before = snapshot(x.vault), context = await x.service().prepare(x.id);
		const saved = await x.service().save({ paperId: x.id, contextHash: context.contextHash, readingState: "completed", primaryNoteId: x.note });
		assert.equal(saved.record.paperId, x.id); assert.equal(snapshot(x.vault), before);
		const after = await x.scan(), row = after.papers.find(p => p.paperId === x.id);
		assert.equal(row.readingState, "completed"); assert.equal(row.primaryNoteId, x.note);
		assert.equal(row.objects.find(o => o.kind === "note").noteReview.state, "unreviewed");
		assert.equal((await x.store().read(x.id)).current.digest, saved.digest); assert.ok(x.plugin.writes.every(name => name.startsWith("paper-records/")));
	});
	await check("unknown or conflicting identity cannot acquire a record just by passing a UUID", async () => {
		const x = await setup(); await assert.rejects(x.service().prepare(otherPid), /唯一/);
		put(x.vault, "wiki/sources/conflict.md", noteText(x.manifest.identity.identifiers.doi).replace('"doi":', '"pmid":"999999999","doi":'));
		await assert.rejects(x.service().prepare(x.id), /唯一/); assert.equal(x.plugin.writes.length, 0);
	});
	await check("stale state and stale note content reject edits, while refresh and explicit clear succeed", async () => {
		const x = await setup(), context = await x.service().prepare(x.id);
		put(x.vault, x.note, noteText(x.manifest.identity.identifiers.doi, "User edit"));
		await assert.rejects(x.service().save({ paperId: x.id, contextHash: context.contextHash, primaryNoteId: x.note }), /编辑后变化/);
		const fresh = await x.service().prepare(x.id); await x.service().save({ paperId: x.id, contextHash: fresh.contextHash, primaryNoteId: x.note });
		await assert.rejects(x.service().save({ paperId: x.id, contextHash: fresh.contextHash, readingState: "completed" }), /编辑后变化/);
		const clear = await x.service().prepare(x.id); await x.service().save({ paperId: x.id, contextHash: clear.contextHash, primaryNoteId: null });
		assert.equal((await x.store().read(x.id)).current.record.primaryNoteId, undefined);
	});
	await check("a different paper's note is not a primary-note choice and titles do not grant identity", async () => {
		const x = await setup(); put(x.vault, "wiki/sources/other.md", noteText("10.1234/other"));
		const context = await x.service().prepare(x.id);
		await assert.rejects(x.service().save({ paperId: x.id, contextHash: context.contextHash, primaryNoteId: "wiki/sources/other.md" }), /属于其他文献/);
		assert.equal(x.plugin.writes.length, 0);
	});
	await check("reapplying the current decision is idempotent; record identity cannot be rewritten by state saves", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage), first = await store.append(record(), []), before = snapshot(storage);
		assert.equal((await store.append(record(), [first.digest])).digest, first.digest); assert.equal(snapshot(storage), before);
		await assert.rejects(store.append(record({ identifiers: { doi: "10.1234/other" } }), [first.digest]), /身份快照/);
		await assert.rejects(store.append(record({ readingState: "completed" }), []), /状态已变化/);
	});
	await check("unfinished writes remain visible and retries recover without deletion or promoting uncommitted data", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage), first = await store.append(record(), []);
		storage.after = async name => { if (name.endsWith(".json")) { storage.files.set(name, Buffer.from("{torn")); throw new Error("disk full"); } };
		await assert.rejects(store.append(record({ readingState: "completed" }), [first.digest]), /disk full/); storage.after = undefined;
		const damaged = snapshot(storage), state = await store.read(pid); assert.equal(state.current.digest, first.digest); assert.equal(state.pending.length, 1); assert.equal(state.errors.length, 0);
		const recovered = await store.append(record({ readingState: "completed" }), [first.digest]); assert.equal(recovered.record.readingState, "completed");
		assert.equal((await store.read(pid)).pending.length, 1); assert.notEqual(snapshot(storage), damaged);
	});
	await check("committed corruption blocks writes and remains a visible read issue without falling back to older state", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage), first = await store.append(record(), []);
		await store.append(record({ readingState: "completed" }), [first.digest]);
		const latest = (await store.read(pid)).current; storage.files.set(`paper-records/${pid}/${latest.revisionId}.ready`, Buffer.from("0".repeat(64)));
		const before = snapshot(storage), state = await store.read(pid); assert.ok(state.errors.length); assert.equal(state.current, undefined);
		await assert.rejects(store.append(record(), state.heads), /损坏/); assert.equal(snapshot(storage), before);
		const scanned = await readPaperLibrary(f.storage(), storage, { vaultRoot: path.resolve("memory-library"), parseYaml: JSON.parse });
		assert.ok(scanned.readIssues.some(issue => issue.area === "records")); assert.equal(scanned.recordStates[0].blocked, true);
	});
	await check("two writers retain both heads and explicit conflict selection creates a merge revision", async () => {
		const x = await setup(), context = await x.service().prepare(x.id);
		const first = await x.service().save({ paperId: x.id, contextHash: context.contextHash, readingState: "reading" });
		const outcomes = await race(x.plugin, x.store(), first.record, [first.digest]); assert.ok(outcomes.some(item => item.status === "rejected"));
		const state = await x.store().read(x.id); assert.equal(state.heads.length, 2); assert.equal(state.current, undefined);
		const scan = await x.scan(); assert.ok(scan.diagnostics.some(d => d.code === "record_conflict"));
		const conflict = await x.service().prepare(x.id);
		await assert.rejects(x.service().save({ paperId: x.id, contextHash: conflict.contextHash, readingState: "reading" }), /显式选择/);
		const chosen = conflict.decisions.find(r => r.record.readingState === "revisit");
		const resolved = await x.service().save({ paperId: x.id, contextHash: conflict.contextHash, chosenHead: chosen.digest });
		assert.equal(resolved.record.readingState, "revisit"); assert.deepEqual(resolved.parents, state.heads); assert.equal((await x.store().read(x.id)).revisions.length, 4);
	});
	await check("concurrent first saves of a metadata-only record also remain resolvable", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage); await race(storage, store, record(), []);
		const scan = () => readPaperLibrary(f.storage(), storage, { vaultRoot: path.resolve("memory-library"), parseYaml: JSON.parse });
		const service = new PaperRecordService(store, scan), context = await service.prepare(pid); assert.equal(context.heads.length, 2);
		await service.save({ paperId: pid, contextHash: context.contextHash, chosenHead: context.heads[0] });
		assert.equal((await store.read(pid)).heads.length, 1);
	});
	await check("malformed parent chains cannot activate a forged current state", async () => {
		const storage = f.storage(), payload = { schemaVersion: 1, revisionId: "v-" + randomUUID(), parents: ["a".repeat(64)], savedAt: new Date().toISOString(), record: record() };
		const revision = { ...payload, digest: objectDigest(payload) }, root = `paper-records/${pid}/${payload.revisionId}`;
		put(storage, root + ".json", revision); put(storage, root + ".ready", revision.digest);
		const state = await new JournalPaperRecordStore(storage).read(pid); assert.ok(state.errors.some(e => /前置/.test(e))); assert.equal(state.current, undefined);
	});
	await check("intake reuses a record identity without packages and rejects ID, alias and citekey conflicts", async () => {
		const storage = f.storage(), store = new JournalPaperRecordStore(storage); await store.append(record({ citekey: "known_key" }), []);
		const catalog = new SourceCatalog(f.storage(), undefined, () => readPaperRecordIdentities(storage));
		const identity = { title: "New title", authors: [], year: "2026", identifiers: { doi: "10.1234/a" }, publicationTypes: [], evidence: [], warnings: [] };
		const before = snapshot(storage), plan = await catalog.associate(identity); assert.equal(plan.paperId, pid); assert.equal(plan.citekey, "known_key"); assert.equal(snapshot(storage), before);
		await store.append(record({ paperId: otherPid, id: otherPid, citekey: "other_key" }), []);
		await assert.rejects(catalog.associate(identity), /多个论文/);
		const conflicting = new SourceCatalog(f.storage(), undefined, async () => [{ paperId: pid, identifiers: { doi: "10.1234/a", pmid: "1" } }]);
		await assert.rejects(conflicting.associate({ ...identity, identifiers: { doi: "10.1234/a", pmid: "2" } }), /精确标识冲突/);
		const bridge = new SourceCatalog(f.storage(), async () => [{ path: "wiki/sources/bridge.md", kind: "wiki", title: "Bridge", identifiers: { doi: "10.1234/a", pmid: "12" } }], async () => [{ paperId: pid, citekey: "known_key", identifiers: { pmid: "12" } }]);
		assert.equal((await bridge.associate(identity)).paperId, pid, "a PMID-only persisted record is reached through a DOI-bearing note");
		const collision = new SourceCatalog(f.storage(), async () => [{ path: "wiki/sources/current.md", kind: "wiki", title: "Current", citekey: "known_key", identifiers: identity.identifiers }], async () => [{ paperId: pid, citekey: "known_key", identifiers: { doi: "10.1234/elsewhere" } }]);
		await assert.rejects(collision.associate(identity), /citekey/);
	});
	console.log(`PAPER_RECORDS_OK (${checks} memory scenarios; no models, external services or original-file writes)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
