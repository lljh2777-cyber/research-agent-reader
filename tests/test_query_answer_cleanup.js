"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");
const { loadReading } = require("./reading-test-helpers");
const bundle = require("esbuild").buildSync({
	entryPoints: [path.resolve(__dirname, "../src/plugin.ts")], bundle: true, format: "cjs",
	platform: "node", external: ["obsidian", "electron"], loader: { ".md": "text" }, write: false,
}).outputFiles[0].text;

let moduleDirectory, entry;
before(async () => {
	moduleDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reader-query-renderer-")));
	entry = path.join(moduleDirectory, "main.cjs");
	await fs.writeFile(entry, bundle);
});

function session(id, ids = []) {
	return { id, title: id, messages: ids.map(id => ({ id, role: "assistant", status: "done", content: "answer" })) };
}

async function fixture(t, stored) {
	const vault = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reader-query-cleanup-")));
	const root = path.join(vault, "plugin");
	await fs.mkdir(root);
	const dataFile = path.join(root, "data.json");
	if (stored !== undefined) await fs.writeFile(dataFile, typeof stored === "string" ? stored : JSON.stringify(stored));
	const notices = [], order = [];
	const noop = () => {};
	class FileSystemAdapter { getBasePath() { return vault; } }
	const obsidian = {
		FileSystemAdapter, ItemView: class {}, Modal: class {}, Plugin: class {}, PluginSettingTab: class {}, Component: class {},
		Notice: class { constructor(text) { notices.push(text); } },
	};
	const installed = new Module(entry, module);
	installed.require = name => name === "obsidian" ? obsidian : name === "electron" ? {} : require(name);
	installed.load(entry);
	const host = new installed.exports.default();
	Object.assign(host, {
		manifest: { dir: "plugin" }, app: {
			vault: { adapter: new FileSystemAdapter(), on: noop },
			workspace: { getActiveFile: () => null, on: noop, onLayoutReady: noop },
		},
		addChild: x => x, registerObsidianProtocolHandler: noop, registerView: name => order.push(name),
		addCommand: noop, registerEvent: noop, registerDomEvent: noop, registerMarkdownPostProcessor: noop,
		addRibbonIcon: noop, addStatusBarItem: () => ({ setText: noop }), addSettingTab: () => order.push("settings-tab"),
		getAcquisitionService: () => ({ ready: noop }), getJatsWikiService: () => ({ ready: noop }),
	});
	const originalDocument = globalThis.document;
	globalThis.document = {};
	t.after(() => { globalThis.document = originalDocument; });
	const answers = path.join(root, "task-output", "query-answers");
	const dir = id => path.join(answers, id);
	async function write(id, name = "message-one.md") {
		await fs.mkdir(dir(id), { recursive: true });
		const target = path.join(dir(id), name);
		await fs.writeFile(target, name);
		return target;
	}
	return { host, order, root, answers, dataFile, dir, write, notices };
}

const twoSessions = { settings: {}, querySessions: [session("query-a", ["message-one"]), session("query-b", ["message-one"])], activeQuerySessionId: "query-a" };
const absent = file => assert.rejects(() => fs.lstat(file), { code: "ENOENT" });

test("write, startup cleanup and manual deletion use the vault plugin root while the module directory stays intact", async t => {
	const f = await fixture(t, twoSessions);
	const moduleAnswers = path.join(moduleDirectory, "task-output", "query-answers");
	for (const id of ["query-a", "query-orphan"]) {
		await f.write(id);
		const dir = path.join(moduleAnswers, id);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "message-one.md"), id);
	}
	const inventory = async () => (await fs.readdir(moduleDirectory, { recursive: true })).sort();
	const beforeFiles = await inventory();
	await f.host.onload();
	await f.host.saveFullAnswer("query-b", "message-reply", "full answer");
	await f.host.deleteActiveQuerySession();
	const answer = path.join(f.dir("query-b"), "message-reply.md");
	assert.deepEqual({
		answerFiles: (await fs.readdir(f.answers, { recursive: true })).sort(),
		moduleFiles: await inventory(),
	}, {
		answerFiles: ["query-b", path.join("query-b", "message-reply.md")],
		moduleFiles: beforeFiles,
	});
	assert.equal(await fs.readFile(answer, "utf8"), "full answer");
	for (const id of ["query-a", "query-orphan"]) {
		assert.equal(await fs.readFile(path.join(moduleAnswers, id, "message-one.md"), "utf8"), id);
	}
	assert.deepEqual(f.notices, []);
});

for (const kind of ["missing", "file", "linked directory"]) {
	test("query answer write, list and delete reject a root (" + kind + ")", async t => {
		const { writeQueryAnswerFile, listQueryAnswerFiles, deleteQueryAnswerFiles } = loadReading("runtime/task-output-persistence.ts");
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reader-query-invalid-root-")));
		const root = path.join(parent, "plugin");
		if (kind === "file") await fs.writeFile(root, "keep");
		if (kind === "linked directory") {
			const outside = path.join(parent, "outside");
			const session = path.join(outside, "task-output", "query-answers", "query-a");
			await fs.mkdir(session, { recursive: true });
			await fs.writeFile(path.join(session, "message-one.md"), "keep");
			try {
				await fs.symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) return t.skip(error.code);
				throw error;
			}
		}
		const inventory = async () => (await fs.readdir(parent, { recursive: true })).sort();
		const beforeFiles = await inventory();
		await assert.rejects(() => writeQueryAnswerFile(root, "query-a", "message-new", "new"), /插件.*目录/);
		await assert.rejects(() => listQueryAnswerFiles(root), /插件.*目录/);
		await assert.rejects(() => deleteQueryAnswerFiles(root, "query-a", ["message-one"], true), /插件.*目录/);
		assert.deepEqual(await inventory(), beforeFiles);
		if (kind === "file") assert.equal(await fs.readFile(root, "utf8"), "keep");
		if (kind === "linked directory") {
			assert.equal(await fs.readFile(path.join(parent, "outside", "task-output", "query-answers", "query-a", "message-one.md"), "utf8"), "keep");
		}
	});
}

test("delete waits for a successful settings write before unlinking the selected session", async t => {
	const f = await fixture(t, twoSessions);
	await f.host.loadSettings();
	const a = await f.write("query-a"), b = await f.write("query-b");
	const unlink = fs.unlink.bind(fs);
	t.mock.method(fs, "unlink", async file => {
		if (file === a) {
			assert.deepEqual(JSON.parse(await fs.readFile(f.dataFile, "utf8")).querySessions.map(s => s.id), ["query-b"]);
			f.order.push("unlink");
		}
		return unlink(file);
	});
	await f.host.deleteActiveQuerySession();
	assert.deepEqual(f.order, ["unlink"]);
	await absent(f.dir("query-a"));
	assert.equal(await fs.readFile(b, "utf8"), "message-one.md");
});

test("failed settings save keeps the session answer file", async t => {
	const f = await fixture(t, twoSessions);
	await f.host.loadSettings();
	const a = await f.write("query-a");
	t.mock.method(f.host, "saveSettings", async () => { throw new Error("history read-only"); });
	await assert.rejects(() => f.host.deleteActiveQuerySession(), /history read-only/);
	assert.equal(await fs.readFile(a, "utf8"), "message-one.md");
});

test("clearing the only session removes its answer directory but keeps its ID", async t => {
	const f = await fixture(t, { ...twoSessions, querySessions: twoSessions.querySessions.slice(0, 1) });
	await f.host.loadSettings();
	await f.write("query-a");
	await f.host.clearActiveQuerySession();
	assert.deepEqual(f.host.querySessions.map(s => [s.id, s.messages.length]), [["query-a", 0]]);
	await absent(f.dir("query-a"));
});

test("reset removes the old sessions' answer directories only", async t => {
	const f = await fixture(t, twoSessions);
	await f.host.loadSettings();
	await f.write("query-a");
	await f.write("query-b");
	const other = await f.write("query-unrelated");
	await f.host.resetQueryHistory();
	await absent(f.dir("query-a"));
	await absent(f.dir("query-b"));
	assert.equal(await fs.readFile(other, "utf8"), "message-one.md");
	assert.equal(f.host.querySessions.length, 1);
});

test("directory removal failure warns once and leaves chat deletion committed", async t => {
	const f = await fixture(t, twoSessions);
	await f.host.loadSettings();
	await f.write("query-a");
	t.mock.method(fs, "rmdir", async () => { throw new Error("directory busy"); });
	await assert.doesNotReject(f.host.deleteActiveQuerySession());
	assert.deepEqual(JSON.parse(await fs.readFile(f.dataFile, "utf8")).querySessions.map(s => s.id), ["query-b"]);
	assert.equal(f.notices.length, 1);
	assert.match(f.notices[0], /directory busy/);
});

for (const [name, stored] of [["missing data.json", undefined], ["invalid JSON", "{"], ["missing querySessions", { settings: {} }], ["empty querySessions", { settings: {}, querySessions: [] }]]) {
	test("startup preserves answer files with " + name, async t => {
		const f = await fixture(t, stored);
		const file = await f.write("query-old");
		const readdir = t.mock.method(fs, "readdir");
		if (name === "invalid JSON") await assert.rejects(() => f.host.onload(), /无法读取已有设置/);
		else await f.host.onload();
		assert.equal(await fs.readFile(file, "utf8"), "message-one.md");
		assert.ok(readdir.mock.calls.every(call => call.arguments[0] !== f.answers));
	});
}

test("startup uses raw and live ID pairs and finishes cleanup before registering the query view", async t => {
	const ids = Array.from({ length: 11 }, (_, i) => "message-" + i);
	const f = await fixture(t, {
		settings: { queryMessageLimit: 10, querySessionLimit: 1 },
		querySessions: [session("query-live", ids), session("query-trimmed", ["message-0"])],
	});
	const keep = [
		await f.write("query-live", "message-0.md"), await f.write("query-live", "message-10.md"),
		await f.write("query-trimmed", "message-0.md"), await f.write("query-memory", "message-memory.md"),
	];
	const orphan = await f.write("query-live", "message-memory.md");
	await f.write("query-orphan", "message-0.md");
	const load = f.host.loadSettings.bind(f.host);
	f.host.loadSettings = async () => {
		const raw = await load();
		f.host.querySessions.push(session("query-memory", ["message-memory"]));
		f.order.push("loaded");
		return raw;
	};
	const unlink = fs.unlink.bind(fs);
	t.mock.method(fs, "unlink", async file => {
		await unlink(file);
		if (file === orphan) f.order.push("orphan-removed");
	});
	await f.host.onload();
	assert.deepEqual(f.order.filter(value => ["loaded", "orphan-removed", "agent-dashboard-query-wiki", "settings-tab"].includes(value)),
		["loaded", "orphan-removed", "agent-dashboard-query-wiki", "settings-tab"]);
	assert.equal(f.host.querySessions[0].messages.length, 10);
	for (const file of keep) assert.equal(await fs.readFile(file, "utf8"), path.basename(file));
	await absent(orphan);
	await absent(f.dir("query-orphan"));
});

test("safe deletion preserves unknown files, temp files and subdirectories", async t => {
	const f = await fixture(t, twoSessions);
	await f.host.loadSettings();
	const managed = await f.write("query-a");
	const notes = await f.write("query-a", "notes.md");
	const temporary = await f.write("query-a", ".message-one.md.123.tmp");
	const subdir = path.join(f.dir("query-a"), "message-folder.md");
	await fs.mkdir(subdir);
	await f.host.deleteActiveQuerySession();
	await absent(managed);
	for (const file of [notes, temporary]) assert.equal(await fs.readFile(file, "utf8"), path.basename(file));
	assert.ok((await fs.lstat(subdir)).isDirectory());
	assert.deepEqual(f.notices, []);
});

test("startup and manual deletion leave a session junction and its target untouched", async t => {
	const f = await fixture(t, twoSessions);
	const external = path.join(f.root, "outside");
	await fs.mkdir(external);
	const file = path.join(external, "message-one.md");
	await fs.writeFile(file, "outside");
	const orphan = path.join(external, "message-orphan.md");
	await fs.writeFile(orphan, "outside orphan");
	await fs.mkdir(f.answers, { recursive: true });
	try {
		await fs.symlink(external, f.dir("query-a"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) return t.skip(error.code);
		throw error;
	}
	const readdir = t.mock.method(fs, "readdir");
	await f.host.onload();
	await f.host.deleteActiveQuerySession();
	assert.ok(readdir.mock.calls.every(call => call.arguments[0] !== f.dir("query-a") && call.arguments[0] !== external));
	assert.ok((await fs.lstat(f.dir("query-a"))).isSymbolicLink());
	assert.equal(await fs.readFile(file, "utf8"), "outside");
	assert.equal(await fs.readFile(orphan, "utf8"), "outside orphan");
});

test("startup cleanup failure warns and completes plugin loading", async t => {
	const f = await fixture(t, twoSessions);
	const orphan = await f.write("query-orphan");
	const unlink = fs.unlink.bind(fs);
	t.mock.method(fs, "unlink", async file => {
		if (file === orphan) throw new Error("answer read-only");
		return unlink(file);
	});
	await assert.doesNotReject(f.host.onload());
	assert.ok(f.order.includes("agent-dashboard-query-wiki"));
	assert.ok(f.order.includes("settings-tab"));
	assert.equal(f.notices.length, 1);
	assert.match(f.notices[0], /answer read-only/);
	assert.equal(await fs.readFile(orphan, "utf8"), "message-one.md");
});
