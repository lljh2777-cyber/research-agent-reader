"use strict";
// Memory-only regression: no model/network requests, files or cleanup.
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers"), f = require("./source-intake-fixtures.cjs");
const { identity } = require("./fulltext-pmc-fixtures.cjs");
const { MetadataIntakeService } = loadReading("library/metadata-intake.ts");
const { JournalPaperRecordStore, readPaperRecordIdentities, validatePaperRecord } = loadReading("library/record-store.ts");
const { SourceCatalog } = loadReading("papers/catalog.ts");
const { PaperRecordService } = loadReading("library/record-service.ts");
const { readPaperLibrary } = loadReading("library/reader.ts");
const { MetadataIntakeModal } = loadReading("views/metadata-intake.ts", { obsidian: { Modal: class {} } });
const { PaperLibraryView } = loadReading("views/paper-library.ts", { obsidian: { ItemView: class {} } });
const signal = () => new AbortController().signal;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const check = async (name, run) => { await run(); console.log("PASS " + name); };
function setup() {
	const plugin = f.storage(), vault = f.storage(), store = new JournalPaperRecordStore(plugin);
	let resolved = structuredClone(identity), legacy = [];
	const resolver = { calls: [], async resolve(input) { this.calls.push(input); return structuredClone(resolved); } };
	const catalog = new SourceCatalog(vault, async () => legacy, () => readPaperRecordIdentities(plugin));
	const service = new MetadataIntakeService(resolver, catalog, store);
	return { plugin, vault, store, resolver, catalog, service, setIdentity: value => resolved = value, setLegacy: value => legacy = value,
		scan: () => readPaperLibrary(vault, plugin, { vaultRoot: path.resolve("metadata-memory"), parseYaml: JSON.parse }) };
}
function modal(service) {
	const view = Object.create(MetadataIntakeModal.prototype);
	Object.assign(view, { service, generation: 0, closed: false, saving: false,
		input: { value: identity.identifiers.doi }, query: {}, cancel: {},
		status: { textContent: "", setText(s) { this.textContent = s; } }, result: { empty() {} }, renderPreview() { this.renders = (this.renders || 0) + 1; } });
	return view;
}
(async () => {
	await check("preview is read-only; confirmed bibliography persists and remains visible across fresh services", async () => {
		const x = setup(), preview = await x.service.prepare(identity.identifiers.doi.toUpperCase(), signal());
		assert.equal(x.plugin.files.size, 0); assert.equal(x.vault.files.size, 0); assert.equal(preview.existing, false);
		assert.deepEqual(x.resolver.calls, [{ kind: "doi", value: identity.identifiers.doi }]);
		const saved = await x.service.save(preview, signal()); assert.equal(saved.reused, false);
		assert.equal(x.plugin.files.size, 2); assert.equal(x.vault.files.size, 0);
		assert.ok([...x.plugin.files.keys()].every(p => p.startsWith("paper-records/")));
		const state = await new JournalPaperRecordStore(x.plugin).read(saved.paperId);
		assert.deepEqual(state.current.record.bibliography, identity); assert.equal(state.current.record.readingState, "unmarked");
		const scan = await x.scan(); assert.equal(scan.papers.length, 1); assert.equal(scan.papers[0].objects.length, 1);
		assert.deepEqual(scan.papers[0].objects[0].bibliography, identity);
		const edits = new PaperRecordService(x.store, x.scan), context = await edits.prepare(saved.paperId);
		await edits.save({ paperId: saved.paperId, contextHash: context.contextHash, readingState: "revisit" });
		assert.deepEqual((await x.store.read(saved.paperId)).current.record.bibliography, identity);
		const restarted = new MetadataIntakeService(x.resolver, x.catalog, new JournalPaperRecordStore(x.plugin));
		const again = await restarted.prepare(identity.identifiers.pmcid, signal()), before = x.plugin.files.size;
		assert.equal(again.existing, true); assert.deepEqual(await restarted.save(again, signal()), { paperId: saved.paperId, reused: true });
		assert.equal(x.plugin.files.size, before); assert.equal((await x.store.read(saved.paperId)).current.record.readingState, "revisit");
	});
	await check("duplicate clicks and separate previews coalesce through fresh exact-ID lookup", async () => {
		const x = setup(), [a, b] = await Promise.all([x.service.prepare(identity.identifiers.doi, signal()), x.service.prepare("PMID:123", signal())]);
		const saved = await Promise.all([x.service.save(a, signal()), x.service.save(a, signal()), x.service.save(b, signal())]);
		assert.equal(new Set(saved.map(s => s.paperId)).size, 1); assert.equal(saved.filter(s => !s.reused).length, 1); assert.equal(x.plugin.files.size, 2);
	});
	await check("committed metadata is immutable; older records and human decisions are reused unchanged", async () => {
		const x = setup(), preview = await x.service.prepare(identity.identifiers.doi, signal());
		preview.identity.title = "caller mutation"; preview.identity.identifiers.doi = "10.1234/forged";
		const saved = await x.service.save(preview, signal()), original = (await x.store.read(saved.paperId)).current;
		assert.equal(original.record.title, identity.title);
		assert.throws(() => validatePaperRecord({ ...original.record, bibliography: { ...identity, title: "different" } }), /不一致/);
		await assert.rejects(x.store.append({ ...original.record, bibliography: { ...identity, year: "2020" } }, [original.digest]), /身份快照/);
		const y = setup(), old = { kind: "record", id: saved.paperId, paperId: saved.paperId, title: "Older metadata", identifiers: identity.identifiers, readingState: "completed", primaryNoteId: "wiki/sources/old.md" };
		await y.store.append(old, []); const bytes = new Map(y.plugin.files);
		await y.service.save(await y.service.prepare("PMID:123", signal()), signal());
		assert.deepEqual((await y.store.read(saved.paperId)).current.record, old); assert.deepEqual(y.plugin.files, bytes);
	});
	await check("independent first writers preserve conflicting IDs and expose the conflict", async () => {
		const x = setup(), gate = deferred(); let entered = 0;
		const store = { read: id => x.store.read(id), async append(record, heads) { if (++entered === 2) gate.resolve(); await gate.promise; return x.store.append(record, heads); } };
		const a = new MetadataIntakeService(x.resolver, x.catalog, store), b = new MetadataIntakeService(x.resolver, x.catalog, store);
		const pa = await a.prepare("PMID:123", signal()), pb = await b.prepare("PMID:123", signal());
		const results = await Promise.allSettled([a.save(pa, signal()), b.save(pb, signal())]);
		assert.ok(results.some(r => r.status === "rejected")); assert.equal(x.plugin.files.size, 4);
		await assert.rejects(x.service.prepare("PMID:123", signal()), /多个论文/);
		assert.ok((await x.scan()).diagnostics.some(d => d.code === "paper_id_conflict"));
	});
	await check("lookup failures, mismatch, malformed provenance and forged preview cannot save", async () => {
		const x = setup();
		await assert.rejects(x.service.prepare("https://untrusted.example/paper", signal())); assert.equal(x.resolver.calls.length, 0);
		for (const value of [undefined, { ...identity, evidence: [] }, { ...identity, identifiers: { doi: "10.1234/different" } }]) {
			x.setIdentity(value); await assert.rejects(x.service.prepare(identity.identifiers.doi, signal()));
		}
		await assert.rejects(x.service.save({ identity }, signal()), /失效/); assert.equal(x.plugin.files.size, 0);
	});
	await check("conflict arriving after preview blocks writes; legacy IDs anchor without title matching", async () => {
		const x = setup(), preview = await x.service.prepare(identity.identifiers.doi, signal());
		x.setLegacy([{ path: "wiki/sources/conflict.md", kind: "wiki", title: identity.title, identifiers: { doi: identity.identifiers.doi, pmid: "456" } }]);
		await assert.rejects(x.service.save(preview, signal()), /标识冲突/); assert.equal(x.plugin.files.size, 0);
		x.setLegacy([{ path: "wiki/sources/old.md", kind: "wiki", title: "Old title", citekey: "old_key", identifiers: identity.identifiers }]);
		const saved = await x.service.save(await x.service.prepare("PMID:123", signal()), signal());
		assert.equal((await x.store.read(saved.paperId)).current.record.citekey, "old_key");
	});
	await check("marker failure retains pending attempt; retry and ambiguous committed result do not duplicate", async () => {
		for (const committed of [false, true]) {
			const x = setup(), preview = await x.service.prepare("PMID:123", signal());
			const hook = committed ? "after" : "before";
			x.plugin[hook] = async name => { if (name.endsWith(".ready")) { x.plugin[hook] = undefined; throw new Error("write interrupted"); } };
			await assert.rejects(x.service.save(preview, signal()), /interrupted/);
			const before = new Map(x.plugin.files), saved = await x.service.save(preview, signal()), state = await x.store.read(saved.paperId);
			assert.equal(state.revisions.length, 1); assert.equal(state.pending.length, committed ? 0 : 1); assert.equal(saved.reused, committed);
			for (const [name, bytes] of before) assert.deepEqual(x.plugin.files.get(name), bytes);
		}
	});
	await check("aborted and disposed operations cannot publish; late query results stay hidden", async () => {
		const x = setup(), c = new AbortController(); c.abort(); await assert.rejects(x.service.prepare("PMID:123", c.signal)); assert.equal(x.resolver.calls.length, 0);
		const preview = await x.service.prepare("PMID:123", signal()); await assert.rejects(x.service.save(preview, c.signal));
		await x.service.dispose(); await assert.rejects(x.service.save(preview, signal()), /关闭/); assert.equal(x.plugin.files.size, 0);
		for (const mode of ["cancel", "edit", "close"]) {
			const gate = deferred(), view = modal({ prepare: () => gate.promise }); const pending = view.lookup();
			if (mode === "close") view.closed = true;
			view.invalidate(); if (mode === "edit") view.input.value = "PMID:456";
			gate.resolve(preview); await pending; assert.equal(view.preview, undefined); assert.equal(view.renders, undefined);
		}
		const view = modal({ prepare: async () => { throw new Error("offline"); } }); await view.lookup();
		assert.match(view.status.textContent, /offline/); assert.equal(view.query.disabled, false);
	});
	await check("library reveal selects the saved ID and never silently substitutes another paper", async () => {
		const view = Object.create(PaperLibraryView.prototype);
		Object.assign(view, { closed: false, readingEditor: {}, primaryEditor: {}, renderShell() {}, saveView() {}, browser: { state: { phase: "ready", result: { papers: [{ paperId: "p-exact", key: "exact", identifiers: identity.identifiers }] } }, async refresh() {} } });
		await view.revealPaper("p-exact"); assert.equal(view.selectedKey, "exact"); assert.equal(view.filter, "all"); assert.equal(view.query, identity.identifiers.doi);
		await assert.rejects(view.revealPaper("p-missing"), /唯一定位/); assert.equal(view.selectedKey, "exact");
		view.browser.state.phase = "failed"; await assert.rejects(view.revealPaper("p-exact"), /刷新/);
	});
	console.log("METADATA_INTAKE_OK (9 groups; no model/network/filesystem writes)");
})().catch(error => { console.error(error); process.exitCode = 1; });
