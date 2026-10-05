"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const load = require("../scripts/load-storage-validator.cjs"), { validateStorageSnapshot, FileSourceStorage } = load();
const { fixture } = require("./storage-validation-fixtures.cjs"), { rehearse, readBundle } = require("../scripts/storage-rehearsal.cjs");
const { loadReading } = require("./reading-test-helpers"), { draftRevision } = loadReading("curation/draft-store.ts");
const bytes = v => Buffer.from(JSON.stringify(v)), read = (map, p) => JSON.parse(map.get(p).toString());
let count = 0;
async function test(name, run) { await run(); count++; console.log("PASS storage validation: " + name); }
(async () => {
	const f = await fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), "rar-r42-validation-")), source = path.join(root, "vault"), pluginDir = ".obsidian/plugins/research-agent-reader";
	const original = [...f.files].map(([p, b]) => [p, Buffer.from(b)]), clean = await validateStorageSnapshot(f.files, f.inbound);
	await test("all candidate families use production validators and leave source bytes unchanged", async () => {
		assert.deepEqual(clean.issues, []); assert.equal(clean.summary.invalid, 0);
		for (const kind of ["reading", "paper-history", "assistant", "curation-review", "curation-revision", "draft-history", "page-plan", "topic-history", "topic-dialogue", "answer-excerpt"]) assert.ok(clean.checks.some(c => c.kind === kind), kind);
		assert.deepEqual([...f.files], original); assert.doesNotMatch(JSON.stringify(clean), /PRIVATE_MEMO|PRIVATE_DRAFT|PRIVATE_QUESTION|PRIVATE_ANSWER|PRIVATE_REVISION/); assert.equal(clean.migrationExecutable, false);
	});
	await test("syntactically valid JSON with wrong version or filename identity fails", async () => {
		const map = new Map(f.files), p = `reading-sessions/${f.session.id}.json`, raw = read(map, p); raw.version = 99; map.set(p, bytes(raw));
		const audit = await validateStorageSnapshot(map, f.inbound); assert.ok(audit.checks.some(c => c.key === p && c.status === "invalid")); assert.ok(audit.issues.some(i => i.code === "RECORD_DEPENDENCY_UNAVAILABLE"));
		raw.version = 1; raw.id = "r-" + "f".repeat(36); map.set(p, bytes(raw)); assert.ok((await validateStorageSnapshot(map)).summary.invalid);
	});
	await test("equal saved marker and digest cannot hide tampered paper contents", async () => {
		const map = new Map(f.files), p = `paper-records/${f.paper.record.paperId}/${f.paper.revisionId}.json`, raw = read(map, p); raw.record.title = "tampered"; map.set(p, bytes(raw));
		assert.ok((await validateStorageSnapshot(map)).checks.some(c => c.kind === "paper-history" && c.status === "invalid"));
	});
	await test("missing parents and divergent draft heads fail production history checks", async () => {
		for (const parent of ["f".repeat(64), f.draft.digest]) {
			const map = new Map(f.files), extra = draftRevision({ ...f.draft.draft, body: "Alternate" }, parent), root = `knowledge-drafts/${extra.draft.id}/`;
			map.set(root + extra.digest + ".json", bytes(extra)); map.set(root + extra.digest + ".ready", Buffer.from(extra.digest));
			if (parent === f.draft.digest) { const sibling = draftRevision({ ...f.draft.draft, body: "Sibling" }, parent); map.set(root + sibling.digest + ".json", bytes(sibling)); map.set(root + sibling.digest + ".ready", Buffer.from(sibling.digest)); }
			assert.ok((await validateStorageSnapshot(map)).checks.some(c => c.kind === "draft-history" && c.status === "invalid"));
		}
	});
	await test("topic dialogues require the saved route revision, not just a directory", async () => {
		const map = new Map([...f.files].filter(([p]) => !p.startsWith("topic-learning-sessions/")));
		assert.ok((await validateStorageSnapshot(map)).checks.some(c => c.kind === "topic-dialogue" && c.status === "invalid"));
	});
	await test("curation undo/writes and completed page markers are verified", async () => {
		const map = new Map(f.files), p = `knowledge-reviews/revisions/${f.prepared.plan.id}.json`, r = read(map, p);
		r.writes[0].after += " forged"; r.writes[0].afterHash = require("node:crypto").createHash("sha256").update(r.writes[0].after).digest("hex"); map.set(p, bytes(r));
		map.set(`knowledge-pages/${f.draft.draft.id}.complete`, Buffer.from("f".repeat(64)));
		const audit = await validateStorageSnapshot(map); for (const kind of ["curation-revision", "page-plan"]) assert.ok(audit.checks.some(c => c.kind === kind && c.status === "invalid"));
	});
	await test("incoming answer excerpts and assistant actions require actual source nodes", async () => {
		const map = new Map(f.files), p = `reading-sessions/${f.session.id}.json`, s = read(map, p); s.nodes = []; s.mainIds = []; s.branches = []; map.set(p, bytes(s));
		const audit = await validateStorageSnapshot(map, f.inbound); assert.ok(audit.issues.some(i => i.key.startsWith("vault:") && i.code === "ANSWER_NODE_MISSING"));
		assert.ok(audit.issues.some(i => i.key.startsWith("reading-assistant-runs/") && i.code === "ANSWER_NODE_MISSING"));
	});
	await test("incomplete records remain visible, and unknown payloads are not ignored", async () => {
		const map = new Map([...f.files].filter(([p]) => !p.endsWith(".complete"))); map.set("reading-sessions/unknown.pending", Buffer.from("partial"));
		const audit = await validateStorageSnapshot(map); assert.ok(audit.issues.some(i => i.code === "UNFINISHED_PAGE_RETAINED")); assert.ok(audit.checks.some(c => c.kind === "unsupported"));
	});
	const put = async (p, b) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, b, { flag: "wx" }); };
	await put(path.join(source, pluginDir, "manifest.json"), bytes({ id: "research-agent-reader", version: "0.81.1" }));
	await put(path.join(source, pluginDir, "data.json"), bytes({ settings: { apiKey: "PRIVATE_TOKEN" }, querySessions: [{ body: "PRIVATE_QUESTION" }] }));
	for (const [p, b] of f.files) await put(path.join(source, pluginDir, p), b);
	for (const [p, b] of f.inbound) await put(path.join(source, p), b);
	for (const [p, text] of f.vault) await put(path.join(source, p), text);
	const saved = await Promise.all([...f.files.keys(), "data.json"].map(async p => { const full = path.join(source, pluginDir, p); return { p, raw: await fs.readFile(full), stat: await fs.stat(full) }; }));
	const out = path.join(root, "retained-copy");
	await test("new private copy restores in a fresh process with byte-preserved source and no settings", async () => {
		const result = await rehearse({ vault: source, pluginDir, outputDir: out }); assert.equal(result.copied, true); assert.equal(result.freshProcessReadEquivalent, true); assert.equal(result.validation.issues, 0); assert.equal(result.unmovedDependencyIssues, 0);
		assert.deepEqual((await readBundle(out)).audit, clean);
		for (const entry of saved) { const p = path.join(source, pluginDir, entry.p); assert.deepEqual(await fs.readFile(p), entry.raw); const stat = await fs.stat(p); assert.equal(stat.mtimeMs, entry.stat.mtimeMs); assert.equal(stat.ctimeMs, entry.stat.ctimeMs); }
		await assert.rejects(fs.stat(path.join(out, "records/data.json")), { code: "ENOENT" });
		await assert.rejects(rehearse({ vault: source, pluginDir, outputDir: out }), { code: "EEXIST" });
		await assert.rejects(rehearse({ vault: source, pluginDir, outputDir: path.join(source, "bad-output") }), /OUTSIDE_VAULT/);
	});
	await test("offline copy verification rejects corrupt bytes, undeclared files and manifest escapes", async () => {
		const mpath = path.join(out, "manifest.json"), original = await fs.readFile(mpath), manifest = JSON.parse(original);
		const first = manifest.files[0], p = path.join(out, first.area, first.path), content = await fs.readFile(p); await fs.appendFile(p, "corrupt");
		await assert.rejects(readBundle(out), /BUNDLE_CONTENT_CHANGED|BUNDLE_CONTENT_UNAVAILABLE/); await fs.writeFile(p, content);
		manifest.files[0].path = "../escape"; await fs.writeFile(mpath, bytes(manifest)); await assert.rejects(readBundle(out), /MANIFEST_ENTRY_INVALID/); await fs.writeFile(mpath, original);
		await put(path.join(out, "records/reading-sessions/unlisted.json"), "{}"); await assert.rejects(readBundle(out), /BUNDLE_UNLISTED_FILE/);
	});
	await test("copy interruption leaves partial evidence without a completed manifest or success result", async () => {
		const interrupted = path.join(root, "interrupted-copy"), create = FileSourceStorage.prototype.create; let attempts = 0;
		FileSourceStorage.prototype.create = async function (...args) { if (this.root.endsWith("interrupted-copy") && ++attempts === 2) { const e = Error("injected"); e.code = "ENOSPC"; throw e; } return create.apply(this, args); };
		try { await assert.rejects(rehearse({ vault: source, pluginDir, outputDir: interrupted }), { code: "ENOSPC" }); } finally { FileSourceStorage.prototype.create = create; }
		assert.ok((await fs.readdir(path.join(interrupted, "records"))).length); await assert.rejects(fs.stat(path.join(interrupted, "manifest.json")), { code: "ENOENT" }); await assert.rejects(fs.stat(path.join(interrupted, "result.json")), { code: "ENOENT" });
	});
	console.log(`STORAGE_VALIDATION_OK (${count} groups; retained fixture: ${root})`);
})().catch(e => { console.error(e); process.exitCode = 1; });
