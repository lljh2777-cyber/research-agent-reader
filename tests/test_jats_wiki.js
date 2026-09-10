"use strict";
// Real draft tools/receipts, note rendering and registration; memory IO only.
const assert = require("node:assert/strict"), { loadReading } = require("./reading-test-helpers"), f = require("./jats-wiki-fixtures.cjs");
const { boundJatsWikiReader, validateJatsWikiDraft } = loadReading("jats/wiki-evidence.ts", { obsidian: f.obsidian });
const { verifyJatsWikiSource } = loadReading("jats/wiki-source-guard.ts", { obsidian: f.obsidian });
const { planIngestRegistration, IngestRegistrationWriter } = loadReading("agent/ingest-registration.ts", { obsidian: f.obsidian });
(async () => {
	const x = await f.fixture(), source = x.context.source, signal = new AbortController().signal;
	assert.equal(x.journal.writes.length, 0); assert.equal(x.writes.length, 0);
	const reader = boundJatsWikiReader(source, async () => {});
	await assert.rejects(reader.tool.execute({ mode: "block", blockId: source.projection.blocks[0].id }, { signal }), /overview/);
	await assert.rejects(reader.tool.execute({ mode: "overview", path: "other.md" }, { signal }), /参数/);
	const overview = await reader.tool.execute({ mode: "overview" }, { signal }); assert.ok(JSON.parse(overview.output).evidence[0].text.includes("synthetic"));
	await assert.rejects(reader.tool.execute({ mode: "block", blockId: "forged" }, { signal }), /无效/);
	const originalRun = x.deps.run; let calls = 0; x.deps.run = async request => { calls++; return originalRun(request); };
	const [r, duplicate] = await Promise.all([x.generate(), x.generate()]); assert.equal(r.phase, "draft", r.error); assert.equal(r.request.id, duplicate.request.id); assert.equal(calls, 1); assert.equal(x.writes.length, 0);
	assert.equal(x.service.taskRuns()[0].actionId, "jats-wiki"); assert.ok(x.service.taskRuns()[0].output.includes("草稿"));
	const preview = await x.service.preview(r.request.id); assert.ok(preview.content.includes('depth: "abstract-level"')); assert.ok(preview.content.includes('source_kind: "jats"')); assert.ok(preview.content.includes("source_evidence:")); assert.ok(!preview.content.includes("source_pdf_sha256:"));
	assert.ok(!preview.content.includes("[[papers/")); assert.ok(!preview.content.includes("x-ray"));
	const snapshot = new f.JatsWikiService(x.deps); await snapshot.ready(); assert.equal(snapshot.list()[0].phase, "draft"); assert.equal((await snapshot.preview(r.request.id)).content, preview.content);
	await assert.rejects(snapshot.save(r.request.id, "forged"), /版本/); assert.equal(x.writes.length, 0);
	const saved = await snapshot.save(r.request.id, r.draft.digest); assert.equal(saved.phase, "saved"); assert.equal(x.writes.length, 1);
	await verifyJatsWikiSource(x.source, saved.notePath, x.notes.get(saved.notePath));
	await assert.rejects(verifyJatsWikiSource(x.source, saved.notePath, x.notes.get(saved.notePath).replace('source_kind: "jats"', 'source_kind: "article"')), /类型/);
	await snapshot.save(r.request.id, r.draft.digest); assert.equal(x.writes.length, 1);
	await assert.rejects(x.generate(), /已存在/); assert.equal(calls, 1);
	// Existing standalone/full registration keeps one canonical bibliography row and separate package location.
	const files = Object.fromEntries(x.notes); files["papers/index.md"] = x.context.warnings.join("\n"); let fail = "wiki/log.md", plans = [], registrationWrites = 0;
	const plan = planIngestRegistration(saved.notePath, files, true, "jats-reg", new Date().toISOString(), "memory");
	assert.ok(plan.writes.find(w => w.path.endsWith("papers.csv")).after.includes(`papers/${x.key}/article.md`));
	const writer = new IngestRegistrationWriter({ read: async p => files[p] ?? null, save: async p => plans.push(structuredClone(p)), verify: async () => verifyJatsWikiSource(x.source, saved.notePath, files[saved.notePath]), write: async (p, before, after) => { if (p === fail) throw Error("disk full"); assert.equal(files[p] ?? null, before); files[p] = after; registrationWrites++; } });
	await assert.rejects(writer.apply(plan), /disk full/); assert.equal(plans.at(-1).state, "recovery"); fail = ""; await writer.apply(plans.at(-1)); const written = registrationWrites; await writer.apply(plans.at(-1)); assert.equal(registrationWrites, written);
	assert.equal(planIngestRegistration(saved.notePath, files, true, "jats-reg-2", new Date().toISOString(), "memory").writes.length, 0);
	const article = `papers/${x.key}/article.md`, original = x.source.files.get(article); x.source.files.set(article, Buffer.from("edited"));
	await assert.rejects(snapshot.preview(r.request.id), /修改|缺失/); await assert.rejects(writer.apply(plan), /修改|缺失/); x.source.files.set(article, original);
	const sourceNote = x.notes.get(saved.notePath); x.notes.set(saved.notePath, sourceNote + "\n用户手工补充。\n"); await snapshot.save(r.request.id, r.draft.digest); assert.equal(x.notes.get(saved.notePath), sourceNote + "\n用户手工补充。\n");
	await x.service.dispose(); await snapshot.dispose();
	// Every invalid draft keeps the source and produces no Wiki.
	for (const corrupt of [
		r => { r.final.status = "insufficient-evidence"; }, r => { r.toolCalls = []; }, r => { r.toolCalls[0].tool = "pdf_read"; }, r => { r.toolCalls[0].data.paths = ["other"]; },
		r => { r.final.title = "Another paper"; }, r => { r.final.title_zh = ""; }, r => { r.final.evidenceIds = ["forged"]; }, r => { r.final.conclusion = "没有引用的结论。"; },
		r => { r.final.motivation += " <script>bad</script>"; }, r => { r.final.conclusion += " ![image](images/fake.png)"; },
	]) { const y = await f.fixture(), run = y.deps.run; y.deps.run = async req => { const result = await run(req); corrupt(result); return result; }; const record = await y.generate(); assert.equal(record.phase, "failed"); assert.equal(y.writes.length, 0); await y.service.dispose(); }
	const zeroRead = await f.fixture(); zeroRead.deps.run = async () => ({ status: "completed", final: f.answer(source.manifest.identity.title, reader.evidence()[0].id), toolCalls: [{ ok: true, tool: "jats_read", data: overview.receiptData }] });
	assert.equal((await zeroRead.generate()).phase, "failed"); await zeroRead.service.dispose();
	// Source changes during a model response or between preview/save block the write.
	const changed = await f.fixture(), run = changed.deps.run; changed.deps.run = async req => { const result = await run(req); changed.source.files.set(`papers/${changed.key}/article.md`, Buffer.from("changed")); return result; };
	assert.equal((await changed.generate()).phase, "failed"); assert.equal(changed.writes.length, 0); await changed.service.dispose();
	const raced = await f.fixture(), rd = await raced.generate(), commit = raced.deps.commit;
	raced.deps.commit = async (...args) => { raced.notes.set(`wiki/sources/${raced.context.source.manifest.citekey}.md`, rd.draft.content + "\nUser edit"); return commit(...args); };
	await assert.rejects(raced.service.save(rd.request.id, rd.draft.digest), /出现|覆盖/); assert.equal(raced.writes.length, 0); await raced.service.dispose();
	const lateSource = await f.fixture(), ld = await lateSource.generate(), lateCommit = lateSource.deps.commit;
	lateSource.deps.commit = async (...args) => { lateSource.source.files.set(`papers/${lateSource.key}/article.md`, Buffer.from("late edit")); return lateCommit(...args); };
	await assert.rejects(lateSource.service.save(ld.request.id, ld.draft.digest), /修改|缺失/); assert.equal(lateSource.writes.length, 0); await lateSource.service.dispose();
	const tampered = await f.fixture(), td = await tampered.generate(), draftPath = [...tampered.journal.files.keys()].find(p => p.endsWith("/draft.json"));
	const tamperedRecord = JSON.parse(tampered.journal.files.get(draftPath).toString()); tamperedRecord.content += "changed"; tampered.journal.files.set(draftPath, Buffer.from(JSON.stringify(tamperedRecord)));
	const tamperReload = new f.JatsWikiService(tampered.deps); await tamperReload.ready(); assert.equal(tamperReload.list().length, 0); assert.equal(tamperReload.errors.length, 1); assert.equal(tampered.writes.length, 0); await tampered.service.dispose(); await tamperReload.dispose();
	// Production protocol loop owns successful receipts; the simulated provider receives the actual bounded tool output.
	const { runBoundedAgentLoop } = loadReading("agent/loop.ts"), protocol = await f.fixture(); let turns = 0;
	protocol.deps.run = request => runBoundedAgentLoop({ ...request, model: "synthetic", maxSteps: 3, maxToolResultChars: 24000, timeoutMs: 5000,
		provider: { complete: async req => { turns++; if (turns === 1) return { text: JSON.stringify({ action: "tool", tool: "jats_read", arguments: { mode: "overview" } }) };
			const text = req.messages.at(-1).content, payload = JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n")));
			assert.ok(payload.evidence[0].text.includes("synthetic")); return { text: JSON.stringify({ action: "final", result: f.answer(payload.title, payload.evidence[0].id) }) }; } } });
	const protocolDraft = await protocol.generate(); assert.equal(protocolDraft.phase, "draft", protocolDraft.error); assert.equal(turns, 2); assert.ok(protocolDraft.draft.receipts[0].evidencePreview.includes("synthetic")); await protocol.service.dispose();
	// A durable intent recovers a completed create after an interrupted saved receipt, without another model call.
	const recovery = await f.fixture(), draft = await recovery.generate(); recovery.journal.before = async p => { if (p.endsWith("/saved.json")) throw Error("receipt disk full"); };
	await assert.rejects(recovery.service.save(draft.request.id, draft.draft.digest), /disk full/); assert.equal(recovery.writes.length, 1); await recovery.service.dispose(); recovery.journal.before = undefined;
	const resumed = new f.JatsWikiService(recovery.deps); await resumed.ready(); assert.equal((await resumed.save(draft.request.id, draft.draft.digest)).phase, "saved"); assert.equal(recovery.writes.length, 1); await resumed.dispose();
	const edited = await f.fixture(), ed = await edited.generate(); edited.journal.before = async p => { if (p.endsWith("/saved.json")) throw Error("receipt disk full"); };
	await assert.rejects(edited.service.save(ed.request.id, ed.draft.digest)); edited.notes.set(edited.writes[0], edited.notes.get(edited.writes[0]) + "user edit"); edited.journal.before = undefined;
	await assert.rejects(edited.service.save(ed.request.id, ed.draft.digest), /编辑|覆盖/); assert.equal(edited.writes.length, 1); await edited.service.dispose();
	const stopped = await f.fixture(); stopped.deps.run = req => new Promise((resolve, reject) => { req.signal.addEventListener("abort", () => reject(Error("stopped")), { once: true }); });
	const pending = stopped.generate(); for (let i = 0; i < 100 && !stopped.service.list().length; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(stopped.service.stop(stopped.service.list()[0].request.id)); assert.equal((await pending).phase, "interrupted"); assert.equal(stopped.writes.length, 0); await stopped.service.dispose();
	console.log("JATS_WIKI_OK: bound reads and receipts, Chinese title, actual citations, private preview, create-only save, duplicate/race refusal, reload/recovery, changed source and edit preservation, cancellation and source-checked registry; memory-only");
})().catch(error => { console.error(error); process.exitCode = 1; });
