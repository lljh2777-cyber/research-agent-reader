"use strict";
// All journals in memory. No model/network calls, filesystem writes or deletion.
const assert = require("node:assert/strict"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers"), f = require("./source-intake-fixtures.cjs"), base = require("./fulltext-pmc-fixtures.cjs");
const { LocalPdfIntakeService } = loadReading("papers/local-pdf-intake.ts"), { SourceCatalog } = loadReading("papers/catalog.ts");
const { loadPdfSource } = loadReading("sources/pdf-package.ts");
const signal = () => new AbortController().signal, deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const check = async (name, fn) => { await fn(); console.log("PASS local intake: " + name); };
const file = path.resolve("fixtures", "selected.pdf"), services = [];
function setup(prior) {
	const storage = prior?.storage || f.storage(), journal = prior?.journal || f.storage(), index = prior?.index || f.index();
	const deps = { deviceId: f.sha("local-ui-device"), catalog: new SourceCatalog(storage), journal, index, resolver: { async resolve() { return structuredClone(base.identity); } },
		read: async () => Buffer.from(base.bytes), pdfLoader: base.pdfLoader(), render: async () => f.raster(), link: async () => {} };
	const service = new LocalPdfIntakeService(deps); services.push(service); return { storage, journal, index, deps, service };
}
const prepare = x => x.service.prepare(file, base.ids.doi, "unknown", signal());
const shown = async x => { const plan = await prepare(x), display = await x.service.present(plan.requestId); return { plan, display }; };
const save = async x => { const { plan, display } = await shown(x); return x.service.save(plan.requestId, display.digest); };
(async () => { try {
	await check("selection and decoded page preview remain read-only; cancellation and forged confirmations cannot create history", async () => {
		const x = setup(), { plan, display } = await shown(x); assert.equal(plan.snapshot.version, "unknown");
		assert.deepEqual(await x.service.history(), []); assert.equal(x.journal.files.size + x.storage.files.size, 0);
		await assert.rejects(x.service.save(plan.requestId, "wrong"), /页面/); assert.equal(x.journal.files.size, 0);
		x.service.cancel(plan.requestId); await assert.rejects(x.service.save(plan.requestId, display.digest)); assert.equal(x.journal.files.size + x.storage.files.size, 0);
	});
	await check("save creates a device-local operation and portable package; replay needs no network and never creates duplicate PDFs", async () => {
		const x = setup(), saved = await save(x); assert.equal(saved.phase, "saved", saved.error);
		const history = await x.service.history(); assert.equal(history.length, 1); assert.equal(history[0].state, "saved");
		const pkg = await loadPdfSource(x.storage, saved.packageKey); assert.equal(pkg.snapshot.origin.fileName, "selected.pdf");
		assert.ok(!JSON.stringify(pkg.snapshot).includes(file)); assert.equal(JSON.parse(x.journal.files.get(`local-pdf-intake/${history[0].id}.json`)).path, file);
		const before = new Map(x.storage.files), y = setup(x); y.deps.resolver.resolve = async () => { throw new Error("must not query during resume"); };
		const resumed = await y.service.resume(history[0].id, signal()); assert.equal(resumed.snapshot.id, history[0].id); assert.equal(resumed.existing, true);
		assert.equal((await y.service.save(resumed.requestId, "")).phase, "saved"); assert.deepEqual(x.storage.files, before); assert.equal(x.index.writes, 1);
	});
	await check("partial publication survives service restart with the exact snapshot and confirmed image", async () => {
		const x = setup(); x.storage.before = async name => { if (name.endsWith("_source/validation.json")) throw new Error("disk interruption"); };
		const interrupted = await save(x); assert.equal(interrupted.phase, "failed"); const record = (await x.service.history())[0]; assert.equal(record.state, "pending");
		x.storage.before = undefined; const y = setup(x), plan = await y.service.resume(record.id, signal()); assert.equal(plan.recovering, true); assert.equal(plan.requestId, interrupted.requestId);
		const display = await y.service.present(plan.requestId); assert.equal((await y.service.save(plan.requestId, display.digest)).phase, "saved");
		assert.equal(x.storage.writes.filter(p => p.endsWith("source.pdf")).length, 1); assert.equal((await y.service.history())[0].state, "saved");
	});
	await check("registration and completion-receipt failures can be resumed without replacing package bytes or user index text", async () => {
		for (const receipt of [false, true]) {
			const x = setup(); if (receipt) x.journal.before = async name => { if (name.endsWith(".saved.json")) throw new Error("receipt unavailable"); }; else x.index.fail = true;
			const result = await Promise.allSettled([save(x)]); assert.equal(result[0].status, receipt ? "rejected" : "fulfilled");
			if (!receipt) assert.equal(result[0].value.phase, "registration_pending");
			const old = new Map(x.storage.files); assert.equal((await x.service.history())[0].state, "pending");
			x.journal.before = undefined; x.index.fail = false; x.index.text += "\nUser note\n";
			const y = setup(x), plan = await y.service.resume((await y.service.history())[0].id, signal()); assert.equal(plan.existing, true);
			assert.equal((await y.service.save(plan.requestId, "")).phase, "saved"); assert.deepEqual(x.storage.files, old); assert.match(x.index.text, /User note/);
		}
	});
	await check("moved files require explicit same-byte reselection; a changed or missing original never replaces the snapshot", async () => {
		const x = setup(); await save(x); const id = (await x.service.history())[0].id, before = new Map(x.journal.files), y = setup(x), moved = path.resolve("moved", "renamed.pdf");
		y.deps.read = async selected => { if (selected === file) throw new Error("missing original"); return selected === moved ? Buffer.from(base.bytes) : Buffer.from("changed"); };
		await assert.rejects(y.service.resume(id, signal()), /missing/);
		await assert.rejects(y.service.resume(id, signal(), path.resolve("wrong.pdf")), /变化/);
		const plan = await y.service.resume(id, signal(), moved); assert.equal(plan.snapshot.origin.fileName, "selected.pdf");
		assert.equal((await y.service.save(plan.requestId, "")).phase, "saved"); assert.deepEqual(x.journal.files, before);
	});
	await check("damaged records, other devices and mismatched completion receipts are visible without takeover", async () => {
		const x = setup(); await save(x); const id = (await x.service.history())[0].id, name = `local-pdf-intake/${id}.json`, original = x.journal.files.get(name);
		for (const bytes of [Buffer.from("{"), Buffer.from(JSON.stringify({ ...JSON.parse(original), deviceId: f.sha("other-device") }))]) {
			x.journal.files.set(name, bytes); const y = setup(x); assert.equal((await y.service.history())[0].state, "unavailable"); await assert.rejects(y.service.resume(id, signal()));
		}
		x.journal.files.set(name, original); const receipt = `local-pdf-intake/${id}.saved.json`, completed = JSON.parse(x.journal.files.get(receipt));
		x.journal.files.set(receipt, Buffer.from(JSON.stringify({ ...completed, operationDigest: f.sha("forged") })));
		assert.equal((await x.service.history())[0].state, "unavailable");
	});
	await check("late lookup cancellation, unload and mismatched identifiers cannot publish", async () => {
		const x = setup(), gate = deferred(), c = new AbortController(); x.deps.resolver.resolve = () => gate.promise;
		const pending = x.service.prepare(file, base.ids.doi, "unknown", c.signal); c.abort(); gate.resolve(base.identity); await assert.rejects(pending); assert.equal(x.journal.files.size, 0);
		const y = setup(); y.deps.resolver.resolve = async () => ({ ...base.identity, identifiers: { doi: "10.1234/other" } }); await assert.rejects(prepare(y), /不一致/);
		await y.service.dispose(); await assert.rejects(prepare(y), /关闭/);
	});
	await check("duplicate saves are rejected; closing during final commit still leaves a reusable completed record", async () => {
		const x = setup(), gate = deferred(), entered = deferred(), { plan, display } = await shown(x);
		x.storage.before = async name => { if (name.endsWith("manifest.json")) { entered.resolve(); await gate.promise; } };
		const pending = x.service.save(plan.requestId, display.digest); await entered.promise;
		await assert.rejects(x.service.save(plan.requestId, display.digest), /正在保存/); x.service.cancel(plan.requestId); gate.resolve(); assert.equal((await pending).phase, "saved");
		const resumed = await x.service.resume(plan.jobId, signal()); assert.equal(resumed.existing, true); assert.equal((await x.service.save(resumed.requestId, "")).phase, "saved");
	});
	console.log("LOCAL_PDF_INTAKE_OK (8 groups; memory journals, simulated resolver/parser/raster)");
} finally { await Promise.all(services.map(s => s.dispose())); } })().catch(error => { console.error(error); process.exitCode = 1; });
