"use strict";
// Acquisition fixture setup and every subsequent operation stay in memory; no cleanup.
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers"), f = require("./jats-fixtures.cjs");
const { readPaperLibrary } = loadReading("library/reader.ts");
const { readAnnotationRecords } = loadReading("annotations/annotation-service.ts");
const { createReadingSession } = loadReading("reading/session.ts");
const { structuredFingerprint } = loadReading("reading/structured-source.ts");
const { loadJatsSource } = loadReading("sources/jats-package.ts");
const { JatsIntakeService } = loadReading("jats/intake.ts"), { SourceCatalog } = loadReading("papers/catalog.ts");
const root = path.resolve("memory-library"), options = { vaultRoot: root, parseYaml: JSON.parse };
const deny = async () => { throw new Error("Read adapter attempted a write"); };
const readonly = storage => ({ read: storage.read.bind(storage), list: storage.list.bind(storage), mkdir: deny, create: deny });
const snapshot = storage => JSON.stringify([...storage.files].map(([name, bytes]) => [name, f.sha(bytes)]).sort());
const put = (storage, name, value) => { const parts = name.split("/"); for (let i = 1; i < parts.length; i++) storage.dirs.add(parts.slice(0, i).join("/")); storage.files.set(name, Buffer.from(typeof value === "string" ? value : JSON.stringify(value))); };
const frontmatter = (value, body = "Text") => "---\n" + JSON.stringify(value) + "\n---\n" + body;
const find = (result, id) => result.papers.find(paper => paper.objects.some(object => object.id === id));
let checks = 0;
async function check(name, work) { await work(); checks++; console.log("PASS library reader: " + name); }

(async () => {
	const fixture = f.fixture(), acquired = await fixture.acquire(), vault = f.storage(), journal = f.storage(), plugin = f.storage();
	const intake = new JatsIntakeService({ deviceId: f.sha("device"), catalog: new SourceCatalog(vault), journal, index: f.index(), read: async () => acquired, link: async () => {} });
	const plan = await intake.prepare(acquired.snapshot.jobId); await intake.save(plan.requestId, plan.evidenceDigest, false); await intake.dispose();
	const loaded = await loadJatsSource(vault, plan.packageKey), m = loaded.manifest, articlePath = "papers/" + m.packageKey + "/article.md";
	const structured = { version: 1, format: "jats", manifest: m };
	const session = createReadingSession({ kind: "structured", path: articlePath, title: m.identity.title, fingerprint: structuredFingerprint(structured), structured });
	put(plugin, "reading-sessions/" + session.id + ".json", session);
	put(vault, "wiki/sources/paper.md", frontmatter({ title: m.identity.title, doi: "https://doi.org/" + m.identity.identifiers.doi }));
	const v = readonly(vault), p = readonly(plugin);
	await check("real package validation, frozen JATS session and Wiki normalize into one paper without writes", async () => {
		const beforeVault = snapshot(vault), beforePlugin = snapshot(plugin), calls = fixture.calls.length;
		const result = await readPaperLibrary(v, p, options);
		assert.equal(result.complete, true, JSON.stringify(result.readIssues)); assert.equal(result.papers.length, 1);
		const paper = result.papers[0]; assert.equal(paper.paperId, m.paperId); assert.equal(paper.objects.length, 3);
		assert.equal(paper.objects.find(o => o.kind === "source").source.verification.state, "verified");
		assert.equal(paper.objects.find(o => o.kind === "session").binding.state, "matched");
		assert.equal(paper.objects.find(o => o.kind === "source").capabilities.pageNavigation.available, false);
		assert.equal(snapshot(vault), beforeVault); assert.equal(snapshot(plugin), beforePlugin); assert.equal(fixture.calls.length, calls);
		const again = await readPaperLibrary(v, p, options); assert.deepEqual(result.papers, again.papers); assert.deepEqual(result.diagnostics, again.diagnostics);
	});
	await check("broken managed package is visible and cannot fall through to legacy Markdown", async () => {
		put(vault, "papers/broken/_source/manifest.json", "{}"); put(vault, "papers/broken/article.md", "Looks like an article");
		const result = await readPaperLibrary(v, p, options), broken = find(result, "papers/broken");
		assert.equal(broken.objects[0].source.format, "unknown"); assert.equal(broken.objects[0].capabilities.openOriginal.available, false);
		assert.equal(result.papers.flatMap(p => p.objects).filter(o => o.id.startsWith("papers/broken")).length, 1);
		assert.ok(find(result, session.id)); assert.equal(result.complete, false); assert.ok(result.readIssues.some(i => i.path === "papers/broken"));
	});
	await check("modified JATS cannot rebind the old session and its frozen identity remains available", async () => {
		const original = vault.files.get(articlePath); put(vault, articlePath, "Changed source");
		const result = await readPaperLibrary(v, p, options), paper = find(result, session.id);
		assert.equal(paper.objects.find(o => o.kind === "session").binding.state, "unresolved");
		assert.equal(paper.objects.find(o => o.kind === "source").source.verification.state, "invalid");
		assert.equal(paper.identifiers.doi, m.identity.identifiers.doi); vault.files.set(articlePath, original);
	});
	await check("legacy conversion verifies the original reading fingerprint and associates without inventing paperId", async () => {
		const st = f.storage(), ps = f.storage(), article = "# Old source\nBody", manifest = '{"version":1}', name = "papers/old/article.md";
		put(st, name, article); put(st, "papers/old/_extraction/manifest.json", manifest);
		const old = createReadingSession({ kind: "article", path: name, title: "Old source", fingerprint: f.sha(article + manifest) }); put(ps, "reading-sessions/" + old.id + ".json", old);
		const pending = await readPaperLibrary(readonly(st), readonly(ps), options); assert.equal(find(pending, old.id).objects.length, 1); assert.equal(pending.complete, false);
		let verified = 0; const result = await readPaperLibrary(readonly(st), readonly(ps), { ...options, verifyMineru: async name => { assert.equal(name, "papers/old/article.md"); verified++; } });
		assert.equal(verified, 1); assert.equal(result.papers.length, 1); assert.equal(result.papers[0].paperId, undefined);
		assert.equal(result.papers[0].objects.find(o => o.kind === "session").binding.state, "matched");
		put(st, name, article + " changed"); const changed = await readPaperLibrary(readonly(st), readonly(ps), { ...options, verifyMineru: async () => {} });
		assert.equal(find(changed, old.id).objects[0].binding.state, "changed"); assert.equal(changed.papers.length, 2);
	});
	await check("unsupported legacy annotations keep roles and source hints but do not borrow current paper identity", async () => {
		const st = f.storage(), ps = f.storage(), source = "Clippings/raw.md"; put(st, source, frontmatter({ doi: "10.1234/a" }));
		const meta = { id: "ann-1", sourcePath: source, selectedText: "Text", section: "Methods", sourceAnchor: { start: 0, end: 4, prefix: "", suffix: "" } };
		put(st, "wiki/annotations/a.md", "<!-- agent-dashboard:annotation-start ann-1 -->\n<!-- agent-dashboard:annotation-meta " + JSON.stringify(meta) + " -->\n<!-- agent-dashboard:manual-start -->My note<!-- agent-dashboard:manual-end -->\n<!-- agent-dashboard:ai-start -->AI explanation<!-- agent-dashboard:ai-end -->\n<!-- agent-dashboard:annotation-end ann-1 -->");
		put(st, "wiki/annotations/broken.md", "<!-- agent-dashboard:annotation-start broken -->Unfinished");
		const result = await readPaperLibrary(readonly(st), readonly(ps), options), annotation = find(result, "wiki/annotations/a.md#ann-1").objects[0];
		assert.deepEqual(annotation.identifiers, {}); assert.equal(annotation.binding.sourceId, source); assert.equal(annotation.binding.state, "changed");
		assert.deepEqual(annotation.roles, ["original_quote", "personal_note", "ai_explanation"]); assert.ok(result.readIssues.some(i => i.path.endsWith("broken.md")));
	});
	await check("duplicate annotation IDs and unclosed content sections cannot select arbitrary surviving text", async () => {
		const block = (id, note = "Note") => `<!-- agent-dashboard:annotation-start ${id} -->\n<!-- agent-dashboard:annotation-meta ${JSON.stringify({ id, sourcePath: "Clippings/a.md", selectedText: "Quote" })} -->\n<!-- agent-dashboard:manual-start -->${note}<!-- agent-dashboard:manual-end -->\n<!-- agent-dashboard:annotation-end ${id} -->`;
		const parsed = readAnnotationRecords(block("a") + block("b") + block("a", "Different"), "wiki/annotations/a.md");
		assert.deepEqual(parsed.records.map(r => r.id), ["b"]); assert.equal(parsed.errors.length, 1);
		const broken = readAnnotationRecords(block("a").replace("<!-- agent-dashboard:manual-end -->", ""), "wiki/annotations/a.md");
		assert.equal(broken.records.length, 0); assert.match(broken.errors[0], /未闭合/);
	});
	await check("storage scope prevents legacy test or misplaced code records from entering formal papers", async () => {
		const st = f.storage(), ps = f.storage();
		const old = createReadingSession({ kind: "pdf", path: "missing.pdf", title: "Old fixture", fingerprint: f.sha("test") }); delete old.purpose;
		put(ps, "reading-test-sessions/" + old.id + ".json", old);
		const misplaced = createReadingSession({ ...old.source }); put(ps, "code-reading-sessions/" + misplaced.id + ".json", misplaced);
		const before = snapshot(ps), result = await readPaperLibrary(readonly(st), readonly(ps), options);
		assert.equal(result.papers.length, 0); assert.deepEqual(result.excluded, [{ kind: "session", id: old.id }]);
		assert.equal(result.readIssues.length, 2); assert.ok(result.readIssues.some(issue => /代码目录/.test(issue.message))); assert.equal(snapshot(ps), before);
	});
	await check("bad note metadata and broken session files do not hide valid records", async () => {
		const st = f.storage(), ps = f.storage(); put(st, "wiki/sources/good.md", frontmatter({ doi: "10.1234/good" }));
		put(st, "wiki/sources/bad.md", "---\n{broken}\n---\nKeep user text"); put(ps, "reading-sessions/broken.json", "{broken}");
		const before = snapshot(st), result = await readPaperLibrary(readonly(st), readonly(ps), options);
		assert.ok(find(result, "wiki/sources/good.md")); assert.deepEqual(find(result, "wiki/sources/bad.md").identifiers, {});
		assert.equal(result.readIssues.length, 2); assert.equal(snapshot(st), before);
	});
	await check("external PDF paths and traversal paths are not read merely by opening the library", async () => {
		const st = f.storage(), ps = f.storage(), names = [];
		for (const name of [path.resolve(root, "../outside.pdf"), "../outside.pdf"]) {
			const old = createReadingSession({ kind: "pdf", path: name, title: "Same title", fingerprint: f.sha("outside") }); put(ps, "reading-sessions/" + old.id + ".json", old);
		}
		const result = await readPaperLibrary({ ...readonly(st), read: async (name, max) => { names.push(name); return st.read(name, max); } }, readonly(ps), options);
		assert.equal(result.papers.length, 2); assert.ok(result.papers.every(p => p.objects[0].binding.state === "unresolved")); assert.ok(names.every(name => !name.includes("outside")));
	});
	await check("reading validation operates on memory copies and never performs startup recovery", async () => {
		const st = f.storage(), ps = f.storage(), old = createReadingSession({ kind: "pdf", path: "missing.pdf", title: "Running", fingerprint: f.sha("running") });
		old.nodes = [{ id: "node", status: "running", title: "Generating", question: "", content: "", error: "", createdAt: old.createdAt, parentId: null, branchId: null, evidence: [] }]; old.mainIds = ["node"];
		put(ps, "reading-sessions/" + old.id + ".json", old); const before = snapshot(ps);
		const result = await readPaperLibrary(readonly(st), readonly(ps), options); assert.equal(snapshot(ps), before);
		assert.equal(result.papers[0].objects[0].reading.explanation.generated, 0); assert.equal(JSON.parse(ps.files.values().next().value).nodes[0].status, "running");
	});
	await check("cancellation and byte budgets fail visibly without mutating any storage", async () => {
		const controller = new AbortController(); controller.abort(); await assert.rejects(readPaperLibrary(v, p, { ...options, signal: controller.signal }), /abort/i);
		const before = snapshot(vault); await assert.rejects(readPaperLibrary(v, p, { ...options, maxBytes: 1 }), /预算/);
		assert.equal(snapshot(vault), before);
	});
	console.log(`LIBRARY_READER_OK (${checks} memory scenarios; real validators, simulated legacy callback, no external services)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
