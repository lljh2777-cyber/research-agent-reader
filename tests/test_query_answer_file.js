"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const esbuild = require("esbuild");

const bundle = esbuild.buildSync({
	entryPoints: [path.join(__dirname, "../src/runtime/task-output-persistence.ts")],
	bundle: true, platform: "node", format: "cjs", write: false,
}).outputFiles[0].text;

const sessionId = "query-123-abc";
const messageId = "message-456-xyz";

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reader-query-answer-"));
	const entry = path.join(directory, "main.cjs");
	const plugin = new Module(entry, module);
	plugin.filename = entry;
	plugin._compile(bundle, entry);
	const { resolveTaskRunOutputLocation, writeQueryAnswerFile } = plugin.exports;
	const root = resolveTaskRunOutputLocation("", "run-1").rootPath;
	const file = path.join(root, "task-output", "query-answers", sessionId, messageId + ".md");
	return { root, file, writeQueryAnswerFile };
}

test("writes exact Markdown in the plugin output directory and replaces one message", async () => {
	const { root, file, writeQueryAnswerFile } = await fixture();
	for (const text of ["# 回答\r\n\r\n📖 $&  \r\n", "第二版\n"]) {
		await writeQueryAnswerFile(root, sessionId, messageId, text);
		const saved = await fs.readFile(file, "utf8");
		assert.equal(saved, text);
		assert.equal(saved.length, text.length);
		assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
	}
});

test("rejects invalid session and message IDs before creating anything", async () => {
	const { root, writeQueryAnswerFile } = await fixture();
	for (const [prefix, reason] of [["query-", /会话 ID/], ["message-", /消息 ID/]]) {
		const invalid = ["", "abc", "con", prefix, ...["a/b", "a\\b", ".", "..", "A", "a".repeat(65)].map(s => prefix + s)];
		for (const id of invalid) {
			const session = prefix === "query-" ? id : sessionId;
			const message = prefix === "message-" ? id : messageId;
			await assert.rejects(() => writeQueryAnswerFile(root, session, message, "text"), reason);
		}
	}
	assert.deepEqual(await fs.readdir(root), []);
});

for (const segments of [["task-output"], ["task-output", "query-answers"], ["task-output", "query-answers", sessionId]]) {
	test("rejects a linked directory at " + segments.join("/"), async t => {
		const { root, writeQueryAnswerFile } = await fixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "reader-query-link-"));
		const link = path.join(root, ...segments);
		await fs.mkdir(path.dirname(link), { recursive: true });
		try {
			await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) throw error;
			return t.skip("directory links unavailable: " + error.code);
		}
		await assert.rejects(() => writeQueryAnswerFile(root, sessionId, messageId, "text"), /符号链接|junction/);
		assert.deepEqual(await fs.readdir(outside), []);
	});
}

test("a failed rename preserves the original and removes the staged file", async t => {
	const { root, file, writeQueryAnswerFile } = await fixture();
	await writeQueryAnswerFile(root, sessionId, messageId, "original");
	const failure = new Error("rename failed");
	const rename = t.mock.method(fs, "rename", async (staged, target) => {
		assert.equal(target, file);
		assert.equal(path.dirname(staged), path.dirname(file));
		assert.equal(await fs.readFile(staged, "utf8"), "replacement");
		throw failure;
	});
	await assert.rejects(() => writeQueryAnswerFile(root, sessionId, messageId, "replacement"), error => error === failure);
	assert.equal(rename.mock.callCount(), 1);
	assert.equal(await fs.readFile(file, "utf8"), "original");
	assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test("retains the first 120000 UTF-16 units of a 130000-unit answer", async () => {
	const { root, file, writeQueryAnswerFile } = await fixture();
	const text = "📖".repeat(60000) + "尾".repeat(10000);
	assert.equal(text.length, 130000);
	await writeQueryAnswerFile(root, sessionId, messageId, text);
	const saved = await fs.readFile(file, "utf8");
	assert.equal(saved.length, 120000);
	assert.equal(saved, text.slice(0, 120000));
});
