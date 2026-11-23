const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadReading } = require("./reading-test-helpers");

async function run() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rar-settings-file-"));
	const { desktopSettingsFile, DashboardPersistence } = loadReading("runtime/persistence.ts");
	const file = desktopSettingsFile(dir);
	assert.equal(await file.load(), null);
	const before = { settings: { clipperDirectory: "saved", providerProfiles: [] } };
	await file.save(before);
	const interrupted = loadReading("runtime/persistence.ts", {
		"node:fs/promises": { ...fs, rename: async () => { throw Error("interrupted before replace"); } },
	}).desktopSettingsFile(dir);
	assert.deepEqual(await interrupted.load(), before);
	await assert.rejects(interrupted.save({ settings: {} }), /interrupted/);
	assert.deepEqual(await desktopSettingsFile(dir).load(), before);

	const filename = path.join(dir, "data.json");
	await fs.writeFile(filename, "{");
	await assert.rejects(file.load(), /已有设置/);
	await assert.rejects(file.save({ settings: {} }), /尚未读入/);
	assert.equal(await fs.readFile(filename, "utf8"), "{");

	let release;
	const writing = new Promise(resolve => { release = resolve; });
	const store = new DashboardPersistence({
		getState: () => ({ settings: before.settings, taskRuns: [], querySessions: [], latestLintReport: null }),
		save: () => writing,
	});
	const saving = store.save();
	let flushed = false;
	const closing = store.flush().then(() => { flushed = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(flushed, false);
	release();
	await Promise.all([saving, closing]);
	assert.equal(flushed, true);
	console.log("SETTINGS_FILE_RECOVERY_OK");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
