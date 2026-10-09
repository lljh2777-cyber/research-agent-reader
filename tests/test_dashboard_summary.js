"use strict";
// Memory-only saved metadata; no recovery, file creation or cleanup.
const assert = require("node:assert/strict"), { loadReading } = require("./reading-test-helpers");
const { readDashboardCuration } = loadReading("services/dashboard-curation.ts");
const { DashboardView } = loadReading("views/dashboard.ts", { obsidian: { ItemView: class {}, Modal: class {} } });
const id = n => "c-" + String(n).padStart(8, "0") + "-0000-0000-0000-000000000000";
const review = (n, state = "ready", decisions = ["pending"]) => ({ version: 1, id: id(n), updated: "2026-09-11T00:00:00Z", state, context: { target: { path: "wiki/sources/a.md" } }, suggestions: decisions.map(decision => ({ decision })) });
const revision = (n, state = "applied", extra = {}) => ({ version: 1, id: id(n), updated: `2026-09-11T00:00:${String(n).padStart(2, "0")}Z`, state, writes: [{ role: "target", path: "wiki/concepts/a.md" }], ...extra });
const fixture = (reviews = [], revisions = []) => {
	const files = new Map(); for (const [kind, rows] of [["reviews", reviews], ["revisions", revisions]]) for (const row of rows) files.set(`knowledge-reviews/${kind}/${row.id}.json`, JSON.stringify(row));
	return { files, reads: [], async list(prefix) { return [...files.keys()].filter(p => p.startsWith(prefix + "/")).map(p => ({ name: p.split("/").at(-1), directory: false })); }, async read(p, limit) { this.reads.push(p); const bytes = Buffer.from(files.get(p)); assert.ok(bytes.length <= limit); return bytes; } };
};
(async () => {
	const empty = fixture(); assert.deepEqual(await readDashboardCuration(empty), { pending: 0, revisit: 0, generating: 0, unfinished: 0, recent: [], issues: [] }); assert.equal(empty.reads.length, 0);
	const io = fixture([review(1), review(2, "ready", ["ignored", "applied"]), review(3, "failed"), review(4, "interrupted"), review(5, "stale"), review(6, "generating")], [revision(1), revision(2, "recovery"), revision(3, "applied", { undoOf: id(1) }), revision(4, "applied", { needsReview: "changed" })]);
	const before = JSON.stringify([...io.files]), result = await readDashboardCuration(io);
	assert.equal(result.pending, 1); assert.equal(result.revisit, 3); assert.equal(result.generating, 1); assert.equal(result.unfinished, 2);
	assert.deepEqual(result.recent.map(r => r.id), [id(4), id(3), id(2)]); assert.match(result.recent[0].label, /需复查/); assert.match(result.recent[1].label, /撤销/); assert.match(result.recent[2].label, /恢复/); assert.equal(JSON.stringify([...io.files]), before, "no interrupted-generation recovery or other mutations");
	const broken = fixture([review(1, "unknown"), review(2, "ready", ["invented"])]); broken.files.set(`knowledge-reviews/reviews/${id(3)}.json`, "{broken"); broken.files.set(`knowledge-reviews/reviews/${id(4)}.json.pending`, "partial");
	const invalid = await readDashboardCuration(broken); assert.equal(invalid.pending, 0); assert.equal(invalid.issues.length, 4); assert.equal(broken.reads.length, 3);
	const mismatch = fixture([review(1)]); mismatch.files.set(`knowledge-reviews/reviews/${id(1)}.json`, JSON.stringify(review(2))); assert.match((await readDashboardCuration(mismatch)).issues[0], /身份/);
	const unavailable = await readDashboardCuration({ list: async () => { throw new Error("unreadable"); }, read: () => assert.fail("read after failed list") }); assert.equal(unavailable.issues.length, 2);
	const oversized = fixture(Array.from({ length: 257 }, (_, i) => review(i + 1))); const limited = await readDashboardCuration(oversized); assert.equal(oversized.reads.length, 256); assert.equal(limited.pending, 256); assert.match(limited.issues[0], /读取上限/);
	const unsafe = fixture([], [revision(1, "applied", { writes: [{ role: "target", path: "../outside.md" }] })]); assert.equal((await readDashboardCuration(unsafe)).recent.length, 0);
	// The dashboard's existing sequence/closed guards also own late summary reads.
	for (const mode of ["stale", "closed", "error"]) {
		let release; const pending = new Promise(r => release = r), view = Object.create(DashboardView.prototype); let renders = 0;
		view.loadSequence = 0; view.closed = false; view.dataService = { load: async () => ({ ready: true }) }; view.plugin = { readDashboardCuration: () => mode === "error" ? Promise.reject(new Error("summary failed")) : pending };
		view.renderDashboard = () => renders++; view.renderError = () => assert.fail("summary error must not blank dashboard");
		const run = view.loadAndRender(); if (mode === "stale") view.loadSequence++; if (mode === "closed") view.closed = true; release(result); await run;
		if (mode === "error") { assert.equal(renders, 1); assert.match(view.curationSummary.issues[0], /summary failed/); } else assert.equal(renders, 0);
	}
	console.log("DASHBOARD_SUMMARY_OK: read-only counts, recent states, invalid/partial records, bounded reads, identity/path checks, stale/closed callbacks and isolated failure");
})().catch(error => { console.error(error); process.exitCode = 1; });
