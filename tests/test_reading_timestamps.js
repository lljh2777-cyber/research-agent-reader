"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { ReadingRepository, FileReadingStorage, RoutedReadingStorage } = loadReading("reading/store.ts");
const { createReadingSession, addReadingNode } = loadReading("reading/session.ts");
const { recentReading, latestReading, matchingReading } = loadReading("reading/catalog.ts");

const source = { kind: "pdf", path: "paper.pdf", title: "Paper", fingerprint: "a".repeat(64) };
const jan = "2021-01-01T00:00:00.000Z", feb = "2021-02-01T00:00:00.000Z";
const mar = "2021-03-01T00:00:00.000Z", apr = "2021-04-01T00:00:00.000Z";
const timestamps = session => [session.createdAt, session.updatedAt, session.lastOpenedAt];
function legacy(createdAt, updatedAt, lastOpenedAt, nodeDates = []) {
	const session = { ...createReadingSession(source), createdAt, updatedAt, lastOpenedAt };
	for (const date of nodeDates) {
		const node = addReadingNode(session, null);
		node.createdAt = date;
		node.status = "done";
	}
	return session;
}

test("recent, latest and matching lists stay usable with mixed v1 histories", async () => {
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const oldest = legacy(jan, jan, jan), middle = legacy(jan, feb), newest = legacy(mar, mar, mar);
	const fromNodes = legacy(undefined, undefined, undefined, [apr]);
	for (const s of [fromNodes, middle, newest, oldest]) storage.files.set(s.id, JSON.stringify(s));
	await repo.load();
	assert.deepEqual(recentReading(repo.sessions.values()).map(s => s.id), [fromNodes.id, newest.id, middle.id, oldest.id]);
	assert.equal(latestReading(repo.sessions.values(), "paper").id, fromNodes.id);
	assert.equal(matchingReading(repo.sessions.values(), source).id, fromNodes.id);
	assert.equal(repo.get(middle.id).lastOpenedAt, feb);
});

test("v1 time repair uses original fields and chronological node extrema", async () => {
	const janInOffset = "2021-01-01T01:30:00+02:00";
	const cases = [
		[legacy(jan, feb, undefined, [apr]), [jan, feb, feb]],
		[legacy(feb, undefined, mar, [apr]), [feb, mar, mar]],
		[legacy(feb, undefined, undefined, [apr]), [feb, feb, feb]],
		[legacy(undefined, mar, feb, [apr]), [feb, mar, feb]],
		[legacy(undefined, mar, undefined, [jan]), [jan, mar, mar]],
		[legacy(undefined, undefined, feb, [apr]), [feb, feb, feb]],
		[legacy("not a date", {}, NaN, [mar, "invalid", jan, feb]), [jan, mar, mar]],
		[legacy(null, "0", [], [jan]), [jan, jan, jan]],
		[legacy(undefined, undefined, undefined, [apr, jan, mar]), [jan, apr, apr]],
		[legacy(undefined, jan, undefined, [janInOffset]), [janInOffset, jan, jan]],
		[legacy(jan, feb, mar, [apr]), [jan, feb, mar]],
	];
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	for (const [s] of cases) storage.files.set(s.id, JSON.stringify(s));
	await repo.load();
	assert.deepEqual(repo.errors, []);
	for (const [s, expected] of cases) assert.deepEqual(timestamps(repo.get(s.id)), expected);
});

test("invalid v1 time values without node dates always recover from file mtime", async () => {
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const s = legacy("2021-02-30", { toString: "not a timestamp" }, NaN);
	const original = JSON.stringify(s);
	storage.files.set(s.id, original);
	await repo.load();
	const fileTime = (await storage.readFile(s.id)).mtime.toISOString();
	assert.deepEqual(repo.errors, []);
	assert.deepEqual(timestamps(repo.get(s.id)), [fileTime, fileTime, fileTime]);
	assert.equal(storage.files.get(s.id), original);
});

test("a real v1 file with no usable dates gets its own mtime without changing its bytes", async () => {
	const root = path.join(__dirname, "fixtures"), disk = new FileReadingStorage(root);
	const id = "r-00000000-0000-4000-8000-000000000001";
	const filename = path.join(root, "reading-sessions", id + ".json");
	const before = await fs.readFile(filename), mtime = (await fs.lstat(filename)).mtime.toISOString();
	const repo = new ReadingRepository(new RoutedReadingStorage(disk, memoryStorage()));
	await repo.load();
	assert.deepEqual(repo.errors, []);
	assert.deepEqual(await fs.readFile(filename), before);
	assert.equal((await fs.lstat(filename)).mtime.toISOString(), mtime);
	assert.deepEqual(timestamps(repo.get(id)), [mtime, mtime, mtime]);
});

test("interruption recovery preserves legacy bytes until a normal save", async () => {
	const s = legacy(jan, feb);
	addReadingNode(s, null);
	const original = JSON.stringify(s, null, 2) + "\n";
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	storage.files.set(s.id, original);
	await repo.load();
	assert.equal(repo.get(s.id).nodes[0].status, "interrupted");
	assert.equal(storage.files.get(s.id), original);
	await repo.transact(s.id, draft => { draft.title = "Saved"; });
	const saved = JSON.parse(storage.files.get(s.id));
	assert.equal(saved.lastOpenedAt, feb);
	assert.equal(saved.nodes[0].status, "interrupted");
	assert.equal(saved.title, "Saved");
});

test("invalid JSON with a literal NaN stays isolated and byte-identical", async () => {
	const s = legacy(jan, feb, mar);
	const original = JSON.stringify(s).replace(JSON.stringify(mar), "NaN");
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	storage.files.set(s.id, original);
	await repo.load();
	assert.equal(repo.sessions.has(s.id), false);
	assert.ok(repo.errors.some(reason => reason.includes(s.id)));
	assert.equal(storage.files.get(s.id), original);
});
