"use strict";
// Isolated filesystem fixture is retained. No cleanup, overwrite or deletion of user files.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { loadReading } = require("./reading-test-helpers");
const { FileSourceStorage } = loadReading("sources/storage.ts");
const { JournalPaperRecordStore } = loadReading("library/record-store.ts");
const pid = "p-00000001-0000-0000-0000-000000000000";
(async () => {
	if (process.argv[2] === "reload-probe") {
		const state = await new JournalPaperRecordStore(new FileSourceStorage(process.argv[3])).read(pid);
		assert.equal(state.errors.length, 0); assert.equal(state.heads.length, 1); assert.ok(state.current);
		console.log("RECORD_RESTART_OK " + state.current.digest); return;
	}
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rar-paper-records-")), io = new FileSourceStorage(root), store = new JournalPaperRecordStore(io);
	assert.deepEqual((await store.read(pid)).heads, []); assert.deepEqual(await fs.readdir(root), [], "read cannot mkdir");
	const record = { kind: "record", id: pid, paperId: pid, title: "Isolated fixture", identifiers: { doi: "10.1234/fixture" }, readingState: "reading" };
	const first = await store.append(record, []), file = path.join(root, "paper-records", pid, first.revisionId + ".json"), before = await fs.readFile(file);
	const fresh = new JournalPaperRecordStore(new FileSourceStorage(root)); assert.equal((await fresh.read(pid)).current.digest, first.digest);
	const results = await Promise.allSettled([fresh.append({ ...record, readingState: "completed" }, [first.digest]), new JournalPaperRecordStore(new FileSourceStorage(root)).append({ ...record, readingState: "revisit" }, [first.digest])]);
	const state = await fresh.read(pid); assert.equal(state.errors.length, 0); assert.ok(state.heads.length === 1 || state.heads.length === 2);
	assert.ok(results.some(result => result.status === "rejected"), "race must reject a stale or conflicting save");
	if (state.heads.length > 1) {
		const chosen = state.revisions.find(revision => revision.digest === state.heads[0]); await fresh.append(chosen.record, state.heads);
	}
	assert.equal((await fresh.read(pid)).heads.length, 1); assert.deepEqual(await fs.readFile(file), before, "older revision must remain byte-identical");
	await assert.rejects(fresh.read("../outside"), /paperId/);
	await assert.rejects(io.create(`paper-records/${pid}/${first.revisionId}.json`, Buffer.from("replacement")), /EEXIST/);
	const restarted = require("node:child_process").execFileSync(process.execPath, [__filename, "reload-probe", root], { encoding: "utf8" });
	assert.ok(restarted.includes("RECORD_RESTART_OK " + (await fresh.read(pid)).current.digest));
	console.log("PAPER_RECORD_STORAGE_OK: real exclusive publication, separate-process reload, racing writers, original revision preservation; fixture retained");
})().catch(error => { console.error(error); process.exitCode = 1; });
