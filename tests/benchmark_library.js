"use strict";
// Repeatable engineering baseline. All business fixtures stay in memory; no deletion, network or model.
const assert = require("node:assert/strict"), path = require("node:path"), os = require("node:os");
const { loadReading } = require("./reading-test-helpers"), f = require("./source-intake-fixtures.cjs"), j = require("./jats-fixtures.cjs");
const { readPaperLibrary } = loadReading("library/reader.ts"), { SourceCatalog } = loadReading("papers/catalog.ts");
const { SourceIntakeService } = loadReading("papers/source-intake.ts"), { JatsIntakeService } = loadReading("jats/intake.ts");
const { createReadingSession } = loadReading("reading/session.ts");
const count = Number(process.argv[2] || 500);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 1000, "count must be 1..1000");
const put = (storage, name, value) => { const parts = name.split("/"); for (let i = 1; i < parts.length; i++) storage.dirs.add(parts.slice(0, i).join("/")); storage.files.set(name, Buffer.from(value)); };
const digest = storage => f.sha(Buffer.from(JSON.stringify([...storage.files].map(([name, bytes]) => [name, f.sha(bytes)]).sort())));
// Directory lookups are indexed before timing, so fixture implementation does not add quadratic scans.
const readonly = storage => {
	const dirs = new Map();
	const add = (name, directory) => { const slash = name.lastIndexOf("/"), parent = slash < 0 ? "" : name.slice(0, slash); if (!dirs.has(parent)) dirs.set(parent, []); dirs.get(parent).push({ name: name.slice(slash + 1), directory }); };
	for (const dir of storage.dirs) if (dir) add(dir, true);
	for (const file of storage.files.keys()) add(file, false);
	return { read: (name, limit) => storage.read(name, limit), list: async name => dirs.get(name) || [] };
};
const memory = () => { const m = process.memoryUsage(); return { heapUsed: m.heapUsed, rss: m.rss, external: m.external }; };
(async () => {
	const vault = f.storage(), plugin = f.storage(), catalog = new SourceCatalog(vault), source = f.source(), fixture = j.fixture();
	const pdf = new SourceIntakeService({ deviceId: f.sha("benchmark"), catalog, journal: f.storage(), index: f.index(), readSource: async () => source, render: async () => f.raster(), link: async () => {} });
	try {
		const plan = await pdf.prepare(source.snapshot.jobId), shown = await pdf.present(plan.requestId), saved = await pdf.save(plan.requestId, shown.digest);
		assert.equal(saved.phase, "saved", saved.error);
	} finally { await pdf.dispose(); }
	const acquired = await fixture.acquire(), jats = new JatsIntakeService({ deviceId: f.sha("benchmark"), catalog, journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
	try { const plan = await jats.prepare(acquired.snapshot.jobId), saved = await jats.save(plan.requestId, plan.evidenceDigest, false); assert.equal(saved.phase, "saved", saved.error); }
	finally { await jats.dispose(); }
	put(vault, "papers/legacy/article.md", "# Unverified legacy fixture\n");
	put(vault, "papers/legacy/_extraction/manifest.json", "{}");
	for (let i = 0; i < count; i++) {
		const name = `Clippings/paper-${i}.md`, meta = { title: `Benchmark paper ${i}`, doi: `10.9876/benchmark-${i}` };
		const article = "---\n" + JSON.stringify(meta) + "\n---\n" + "Synthetic source paragraph. ".repeat(80);
		put(vault, name, article); put(vault, `wiki/sources/paper-${i}.md`, "---\n" + JSON.stringify(meta) + "\n---\nPersonal source note.");
		const session = createReadingSession({ kind: "pdf", path: `missing-history-${i}.pdf`, title: meta.title, fingerprint: f.sha(article) });
		put(plugin, `reading-sessions/${session.id}.json`, JSON.stringify(session));
		const id = `ann-${i}`, annotationMeta = { id, sourcePath: name, selectedText: "Synthetic source paragraph.", section: "Methods" };
		put(vault, `wiki/annotations/paper-${i}.md`, `<!-- agent-dashboard:annotation-start ${id} -->\n<!-- agent-dashboard:annotation-meta ${JSON.stringify(annotationMeta)} -->\n<!-- agent-dashboard:manual-start -->My note<!-- agent-dashboard:manual-end -->\n<!-- agent-dashboard:ai-start -->AI explanation<!-- agent-dashboard:ai-end -->\n<!-- agent-dashboard:annotation-end ${id} -->`);
	}
	const v = readonly(vault), p = readonly(plugin), options = { vaultRoot: path.resolve("benchmark-memory"), parseYaml: JSON.parse };
	const before = { vault: digest(vault), plugin: digest(plugin), providerCalls: fixture.calls.length };
	const scans = [], contents = result => ({ papers: result.papers, diagnostics: result.diagnostics, excluded: result.excluded, readIssues: result.readIssues });
	let reference, beforeEditHash;
	for (const mode of ["first-scan", "warm-1", "warm-2", "one-note-edited"]) {
		if (mode === "one-note-edited") put(vault, "wiki/sources/paper-0.md", vault.files.get("wiki/sources/paper-0.md").toString("utf8") + "\nAn intentional in-memory edit.");
		global.gc?.(); const startMemory = memory();
		const result = await readPaperLibrary(v, p, options), endMemory = memory();
		assert.equal(result.stats.objects, count * 4 + 3); assert.equal(result.readIssues.length, 1, JSON.stringify(result.readIssues));
		const sources = result.papers.flatMap(paper => paper.objects).filter(o => o.kind === "source");
		assert.ok(sources.some(o => o.source.format === "pdf" && o.source.verification.state === "verified"));
		assert.ok(sources.some(o => o.source.format === "jats" && o.source.verification.state === "verified"));
		const hash = result.papers.flatMap(paper => paper.objects).find(o => o.id === "wiki/sources/paper-0.md").contentHash;
		if (mode === "first-scan") { reference = contents(result); beforeEditHash = hash; }
		else if (mode !== "one-note-edited") assert.deepEqual(contents(result), reference);
		else assert.notEqual(hash, beforeEditHash);
		if (mode !== "one-note-edited") assert.equal(digest(vault), before.vault);
		assert.equal(digest(plugin), before.plugin); assert.equal(fixture.calls.length, before.providerCalls);
		scans.push({ mode, ...result.stats, rows: result.papers.length, memoryBefore: startMemory, memoryAfter: endMemory });
	}
	assert.ok(scans.every(s => s.filesRead === scans[0].filesRead), "Current implementation intentionally performs a full rescan after edits");
	console.log(JSON.stringify({ benchmark: "library-r0", count, node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, gcAvailable: !!global.gc,
		limits: "Synthetic small files; first scan excludes module/fixture setup; memory snapshots are not peaks; no disk or OS cold-cache measurement; edits currently require full rescans.", scans }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
