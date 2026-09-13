"use strict";
// Pure memory cases. Source compilation reads repository files; the projection has no IO.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadReading } = require("./reading-test-helpers");
const denied = () => { throw new Error("Library projection must not allocate IDs or perform IO"); };
const { projectLibrary, librarySourceCapabilities, libraryReadingProgress } = loadReading("library/projection.ts", {
	"node:crypto": { ...crypto, randomUUID: denied },
	"node:fs": new Proxy({}, { get: () => denied }),
	"node:fs/promises": new Proxy({}, { get: () => denied }),
});
const HASH = "a".repeat(64), OTHER_HASH = "b".repeat(64);
const pid = n => "p-" + n.toString(16).padStart(8, "0") + "-0000-0000-0000-000000000000";
const base = (kind, id, identifiers = {}) => ({ kind, id, title: "Same title", identifiers });
const source = (id, identifiers = {}, format = "pdf", extra = {}) => ({ ...base("source", id, identifiers), source: {
	format, path: "papers/" + id + (format === "pdf" ? "/source.pdf" : "/article.md"),
	saved: true, verification: { state: "verified", fingerprint: HASH }, ...extra,
} });
const note = (id, identifiers = {}, extra = {}) => ({ ...base("note", id, identifiers), contentHash: HASH, ...extra });
const record = (n, identifiers = {}, extra = {}) => ({ ...base("record", pid(n), identifiers), paperId: pid(n), ...extra });
const node = (id, status = "done", learningState) => ({ id, status, learningState, title: id, content: "Answer", error: "", question: "", parentId: null, branchId: null, createdAt: "2026-09-10T00:00:00.000Z", evidence: [] });
const session = (id, identifiers = {}, extra = {}) => ({ ...base("session", id, identifiers), session: {
	version: 1, id, title: "Same title", source: { kind: "pdf", path: "papers/original.pdf", fingerprint: HASH, title: "Same title" },
	createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z", nodes: [], branches: [], mainIds: [], outline: [], mainSummary: "", completed: false,
	backend: "direct", model: "fixture", purpose: "reading", ui: { mode: "split", split: 0.5, selectedId: "", zoom: 1, scrollX: 0, scrollY: 0, collapsed: [], drafts: {}, windows: [] }, ...extra,
} });
const find = (projection, id) => projection.papers.find(p => p.objects.some(o => o.id === id));
const codes = (projection, paper) => projection.diagnostics.filter(d => paper.diagnosticIds.includes(d.id)).map(d => d.code);
const freeze = object => { if (object && typeof object === "object") { Object.freeze(object); for (const value of Object.values(object)) freeze(value); } return object; };
let checks = 0;
function check(name, work) { work(); checks++; console.log("PASS library: " + name); }

check("same exact paper retains PDF, JATS, legacy conversion, session and note as separate objects", () => {
	const items = [
		{ ...source("pdf", { doi: "10.1234/a" }), paperId: pid(1), citekey: "author2026" },
		{ ...source("jats", { doi: "10.1234/a", pmid: "123" }, "jats", { sourceVersionId: "PMC123.1", projectionId: "projection-one" }), paperId: pid(1) },
		source("mineru", { doi: "10.1234/a" }, "mineru"), note("wiki/sources/paper.md", { pmid: "123" }),
		session("reading-one", { doi: "10.1234/a" }),
	];
	const result = projectLibrary(items), paper = result.papers[0];
	assert.equal(result.papers.length, 1); assert.equal(paper.paperId, pid(1)); assert.equal(paper.citekey, "author2026");
	assert.equal(paper.objects.length, 5); assert.equal(paper.association, "identified");
	assert.deepEqual(paper.identifiers, { doi: "10.1234/a", pmid: "123" });
	const jats = paper.objects.find(o => o.id === "jats");
	assert.equal(jats.source.projectionId, "projection-one"); assert.equal(jats.capabilities.pageNavigation.available, false);
	assert.equal(jats.capabilities.structuredNavigation.available, true); assert.equal(result.diagnostics.length, 0);
});

check("same titles and missing identifiers never allocate paperId or merge unrelated objects", () => {
	const result = projectLibrary([source("a", { doi: "10.1234/a" }), source("b", { doi: "10.1234/b" }), source("old-a"), source("old-b")]);
	assert.equal(result.papers.length, 4);
	assert.ok(result.papers.every(p => p.paperId === undefined));
	assert.equal(find(result, "old-a").association, "unidentified");
	const metadata = projectLibrary([record(2, { pmid: "123" })]).papers[0];
	assert.equal(metadata.paperId, pid(2)); assert.equal(metadata.objects.length, 1);
	assert.equal(metadata.objects[0].source, undefined);
});

check("conflicting aliases reject the whole transitive bridge without rewriting identities", () => {
	const items = [source("a", { doi: "10.1234/a" }), source("b", { doi: "10.1234/a", pmid: "123" }),
		source("c", { pmid: "123", pmcid: "PMC123" }), source("d", { pmcid: "PMC123", doi: "10.1234/b" })];
	const result = projectLibrary(items);
	assert.equal(result.papers.length, 4); assert.ok(result.papers.every(p => p.association === "conflict" && p.objects.length === 1));
	assert.ok(result.papers.every(p => codes(result, p).includes("identifier_conflict")));
	assert.deepEqual(find(result, "a").identifiers, items[0].identifiers);
	assert.deepEqual(result, projectLibrary([...items].reverse()));
});

check("undefined optional aliases cannot erase known values or hide conflicts", () => {
	const result = projectLibrary([source("a", { doi: "10.1234/a", pmid: "123" }), source("b", { doi: "10.1234/a", pmid: undefined }), source("c", { doi: "10.1234/a", pmid: "456" })]);
	assert.equal(result.papers.length, 3); assert.ok(result.papers.every(p => p.association === "conflict"));
	const valid = projectLibrary([source("a", { doi: "10.1234/a", pmid: "123" }), source("b", { doi: "10.1234/a", pmid: undefined })]);
	assert.equal(valid.papers[0].identifiers.pmid, "123");
});

check("existing paperId links missing aliases but cannot override contradictory identifiers", () => {
	const a = { ...source("a", { doi: "10.1234/a" }), paperId: pid(1) };
	assert.equal(projectLibrary([a, { ...source("old"), paperId: pid(1) }]).papers.length, 1);
	const wrong = projectLibrary([a, { ...source("wrong", { doi: "10.1234/b" }), paperId: pid(1) }]);
	assert.equal(wrong.papers.length, 2); assert.ok(wrong.papers.every(p => codes(wrong, p).includes("identifier_conflict")));
	const multiple = projectLibrary([a, { ...source("another", { doi: "10.1234/a" }), paperId: pid(2) }]);
	assert.ok(multiple.papers.every(p => codes(multiple, p).includes("paper_id_conflict")));
	assert.deepEqual(new Set(multiple.papers.map(p => p.paperId)), new Set([pid(1), pid(2)]));
});

check("citekey is not identity; collisions and conflicting keys remain visible", () => {
	const items = [{ ...source("a", { doi: "10.1234/a" }), citekey: "keyA" }, { ...source("b", { doi: "10.1234/a" }), citekey: "keyB" }];
	const result = projectLibrary(items); assert.equal(result.papers.length, 2);
	assert.ok(result.papers.every(p => codes(result, p).includes("citekey_conflict")));
	const collision = projectLibrary([items[0], { ...source("c", { doi: "10.1234/c" }), citekey: "keyA" }, source("unaffected", { doi: "10.1234/d" })]);
	assert.ok(codes(collision, find(collision, "a")).includes("citekey_collision"));
	assert.equal(find(collision, "unaffected").association, "identified");
	assert.ok(collision.diagnostics.some(d => d.objects.some(o => o.id === "a") && d.objects.some(o => o.id === "c")));
});

check("source capabilities preserve format differences and block unavailable originals", () => {
	for (const state of ["unverified", "missing", "invalid"]) {
		const result = projectLibrary([source(state, { doi: "10.1234/a" }, "jats", { verification: { state, reason: "Needs source check" } })]);
		const item = result.papers[0].objects[0];
		assert.ok(Object.values(item.capabilities).every(c => !c.available && c.reason)); assert.equal(item.source.saved, true);
		assert.ok(codes(result, result.papers[0]).includes("source_unavailable"));
	}
	const md = librarySourceCapabilities(source("md", {}, "markdown").source);
	assert.equal(md.openOriginal.available, true); assert.equal(md.interactiveReading.available, false); assert.equal(md.pageNavigation.available, false);
	for (const format of ["pdf", "mineru"]) assert.equal(librarySourceCapabilities(source(format, {}, format).source).pageNavigation.available, true);
	assert.equal(Object.hasOwn(md, "visualInspected"), false);
	assert.throws(() => librarySourceCapabilities(source("bad", {}, "unknown").source), /格式/);
	assert.throws(() => librarySourceCapabilities(source("bad", {}, "pdf", { verification: { state: "verified", fingerprint: "" } }).source), /指纹/);
});

check("matched source bindings require an existing verified source, the correct type and the fixed fingerprint", () => {
	const original = source("original", { doi: "10.1234/a" });
	const reading = { ...session("reader"), binding: { state: "matched", sourceId: original.id, fingerprint: HASH, reason: "Verified" } };
	const result = projectLibrary([original, reading]);
	assert.equal(result.papers.length, 1); assert.equal(result.papers[0].objects.length, 2);
	assert.equal(result.papers[0].paperId, undefined);
	assert.deepEqual(result, projectLibrary([reading, original]));
	assert.throws(() => projectLibrary([reading]), /绑定不一致/);
	assert.throws(() => projectLibrary([original, { ...reading, binding: { ...reading.binding, fingerprint: OTHER_HASH } }]), /绑定不一致/);
	assert.throws(() => projectLibrary([source(original.id, {}, "jats"), reading]), /绑定不一致/);
	assert.throws(() => projectLibrary([source(original.id, {}, "pdf", { verification: { state: "unverified", reason: "Pending" } }), reading]), /绑定不一致/);
	assert.throws(() => projectLibrary([source(original.id, {}, "pdf", { verification: { state: "verified", fingerprint: OTHER_HASH } }), reading]), /绑定不一致/);
	const conflict = projectLibrary([original, { ...reading, identifiers: { doi: "10.1234/b" } }]);
	assert.ok(conflict.papers.every(paper => paper.association === "conflict"));
});

check("generated explanations do not imply reading completion, resolved questions or reviewed notes", () => {
	const reading = session("done", { doi: "10.1234/a" }, { nodes: [node("one"), node("two")], mainIds: ["one", "two"], outline: ["one", "two"], completed: true });
	const result = projectLibrary([reading, note("wiki/sources/a.md", { doi: "10.1234/a" })]), paper = result.papers[0];
	assert.equal(paper.readingState, "unmarked");
	const progress = paper.objects.find(o => o.kind === "session").reading;
	assert.deepEqual(progress.explanation, { generated: 2, planned: 2, mainCompleted: true }); assert.equal(progress.questionCount, null);
	assert.equal(paper.objects.find(o => o.kind === "note").noteReview.state, "unreviewed");
	const marked = projectLibrary([reading, record(1, { doi: "10.1234/a" }, { readingState: "revisit" })]);
	assert.equal(marked.papers[0].readingState, "revisit");
});

check("learning counts reuse explicit node states, ignore unfinished answers and disclose scope", () => {
	const reading = session("progress", {}, { nodes: [node("one", "done", "understood"), node("two", "done", "question"), node("three", "failed", "question"), node("branch", "done", "revisit"), node("unmarked")], mainIds: ["one", "two", "three"], outline: ["one", "two", "three"] });
	const progress = libraryReadingProgress(reading.session);
	assert.deepEqual(progress.learning, { unmarked: 1, understood: 1, revisit: 1, question: 1 });
	assert.equal(progress.questionCount, 1); assert.equal(progress.questionScope, "marked_completed_nodes"); assert.equal(progress.explanation.generated, 2);
	assert.equal(libraryReadingProgress(session("old").session).explanation.planned, null);
});

check("note review pins actual content; main-note selection never attaches another paper", () => {
	const reviewed = note("wiki/sources/a.md", { doi: "10.1234/a" }, { review: { reviewedHash: HASH, reviewedAt: "2026-09-10T00:00:00Z" } });
	const decision = record(1, { doi: "10.1234/a" }, { primaryNoteId: reviewed.id });
	const valid = projectLibrary([decision, reviewed]); assert.equal(valid.papers[0].primaryNoteId, reviewed.id);
	assert.equal(valid.papers[0].objects.find(o => o.kind === "note").noteReview.state, "reviewed");
	const changed = projectLibrary([{ ...reviewed, contentHash: OTHER_HASH }]); assert.equal(changed.papers[0].objects[0].noteReview.state, "stale");
	const wrong = projectLibrary([decision, { ...reviewed, identifiers: { doi: "10.1234/b" } }]);
	assert.equal(find(wrong, decision.id).primaryNoteId, undefined); assert.ok(codes(wrong, find(wrong, decision.id)).includes("primary_note_missing"));
});

check("acquisition completion and annotation roles stay independent of saved sources and knowledge review", () => {
	const result = projectLibrary([{ ...base("acquisition", "job", { doi: "10.1234/a" }), phase: "acquired" },
		{ ...base("annotation", "quote", { doi: "10.1234/a" }), roles: ["original_quote", "ai_explanation", "personal_note", "external_material", "synthesis"] }, base("annotation", "legacy", { doi: "10.1234/a" })]);
	const paper = result.papers[0]; assert.equal(paper.objects.some(o => o.source), false); assert.equal(paper.readingState, "unmarked");
	assert.equal(paper.objects.find(o => o.id === "job").acquisitionPhase, "acquired"); assert.equal(paper.objects.find(o => o.id === "quote").roles.length, 5);
	assert.equal(paper.objects.find(o => o.id === "legacy").roles, undefined);
});

check("demo, test and code sessions are excluded; archived paper history remains inspectable", () => {
	const items = [session("real", { doi: "10.1234/a" }), session("archive", { doi: "10.1234/a" }, { archived: true }), session("demo", {}, { purpose: "demo" }), session("test", {}, { purpose: "test" }),
		session("code", {}, { source: { kind: "code", path: "project.py", fingerprint: HASH, title: "code" } })];
	const result = projectLibrary(items); assert.equal(result.papers.length, 1); assert.equal(result.papers[0].objects.length, 2);
	assert.deepEqual(result.excluded.map(r => r.id), ["code", "demo", "test"]);
	assert.equal(result.papers[0].objects.find(o => o.id === "archive").reading.archived, true);
});

check("projection is deterministic, detached, read-only and never creates durable identities", () => {
	const input = freeze([source("source", { doi: "10.1234/a" }), session("session", { doi: "10.1234/a" }), record(1, { doi: "10.1234/a" })]);
	const before = JSON.stringify(input), result = projectLibrary(input);
	assert.deepEqual(result, projectLibrary([...input].reverse())); assert.deepEqual(result, projectLibrary(input));
	const key = result.papers[0].key, renamed = structuredClone(input); renamed[0].title = "New title";
	assert.equal(projectLibrary(renamed).papers[0].key, key);
	result.papers[0].identifiers.doi = "10.1234/changed";
	result.papers[0].objects.find(o => o.source).source.verification.fingerprint = OTHER_HASH;
	result.papers[0].objects.find(o => o.reading).reading.source.path = "changed";
	assert.equal(JSON.stringify(input), before);
});

check("adapter contract rejects duplicate references, noncanonical IDs and broken identity bindings", () => {
	const item = source("one"); assert.throws(() => projectLibrary([item, item]), /重复/);
	assert.throws(() => projectLibrary([source("bad", { doi: "https://doi.org/10.1234/a" })]), /规范化/);
	assert.throws(() => projectLibrary([{ ...item, paperId: "invented-id" }]), /paperId/);
	assert.throws(() => projectLibrary([{ ...record(1), id: "separate-record-id" }]), /paperId/);
	assert.throws(() => projectLibrary([record(1, {}, { readingState: "automatically_understood" })]), /人工阅读状态/);
	assert.throws(() => projectLibrary([note("a", {}, { contentHash: "", review: { reviewedHash: "", reviewedAt: "unknown" } })]), /审阅记录/);
	assert.throws(() => projectLibrary([{ ...session("a"), id: "b" }]), /会话引用/);
	assert.throws(() => projectLibrary(new Array(10001).fill(item)), /10000/);
	assert.deepEqual(projectLibrary([]), { papers: [], diagnostics: [], excluded: [] });
});

check("large conflicting components share diagnostics instead of copying every object into every row", () => {
	const items = Array.from({ length: 2000 }, (_, i) => ({ ...source("source-" + i, { doi: "10.1234/shared" }), paperId: pid(i + 1) }));
	const result = projectLibrary(items);
	assert.equal(result.papers.length, 2000); assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0].objects.length, 2000); assert.ok(result.papers.every(p => p.diagnosticIds.length === 1));
});

console.log(`LIBRARY_PROJECTION_OK (${checks} memory scenarios; no persistent writes, providers or identity allocation)`);
