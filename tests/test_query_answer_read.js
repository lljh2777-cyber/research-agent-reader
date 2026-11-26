"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { before, describe, test } = require("node:test");
const { build } = require("esbuild");

async function loadBundle(modulePath) {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "reader-answer-module-"));
	const entry = path.join(dir, "main.cjs");
	await build({ entryPoints: [path.join(__dirname, "../src", modulePath)], outfile: entry, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
	return { dir, exports: require(entry) };
}

const session = "query-a", message = "message-b";
const relative = path.join("task-output", "query-answers", session, message + ".md");

async function fixture() {
	const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "reader-answer-root-")));
	const file = path.join(root, relative);
	await fsp.mkdir(path.dirname(file), { recursive: true });
	return { root, file };
}

describe("readQueryAnswerFile", () => {
	let read, moduleDir;
	before(async () => {
		const bundle = await loadBundle("runtime/task-output-persistence.ts");
		read = bundle.exports.readQueryAnswerFile;
		moduleDir = bundle.dir;
	});

	test("reads exact UTF-8 including BOM and CRLF only under the supplied root", async t => {
		const { root, file } = await fixture();
		const text = "\uFEFF第一行\r\n📖 $&\r\n";
		await fsp.writeFile(file, text);
		const decoy = path.join(moduleDir, relative);
		await fsp.mkdir(path.dirname(decoy), { recursive: true });
		await fsp.writeFile(decoy, "wrong answer");
		const spies = [
			...["lstat", "stat", "realpath", "open", "readFile", "readdir", "access"].map(name => t.mock.method(fsp, name)),
			...["lstatSync", "statSync", "realpathSync", "openSync", "readFileSync", "existsSync"].map(name => t.mock.method(fs, name)),
			t.mock.method(fs.realpathSync, "native"),
		];
		assert.equal(await read(root, session, message), text);
		for (const spy of spies) {
			for (const call of spy.mock.calls) {
				const location = call.arguments[0];
				if (typeof location !== "string") continue;
				assert.ok(location !== moduleDir && !location.startsWith(moduleDir + path.sep), "accessed module directory: " + location);
			}
		}
	});

	test("missing session and missing target return null without creating them", async () => {
		const { root, file } = await fixture();
		assert.equal(await read(root, "query-missing", message), null);
		assert.equal(await read(root, session, message), null);
		assert.deepEqual(await fsp.readdir(path.dirname(file)), []);
		assert.deepEqual(await fsp.readdir(path.dirname(path.dirname(file))), [session]);
	});

	test("rejects invalid IDs and invalid roots", async () => {
		const { root, file } = await fixture();
		await fsp.writeFile(file, "ordinary file");
		await assert.rejects(() => read(root, "../bad", message), /会话 ID/);
		await assert.rejects(() => read(root, session, "../bad"), /消息 ID/);
		for (const value of ["relative", path.join(root, "absent"), file]) {
			await assert.rejects(() => read(value, session, message), /插件目录/);
		}
	});

	test("rejects a regular file in place of the session and a directory in place of the answer", async () => {
		const { root, file } = await fixture();
		await fsp.writeFile(path.join(path.dirname(path.dirname(file)), "query-file"), "wrong type");
		await assert.rejects(() => read(root, "query-file", message), /目录|ENOTDIR/);
		await fsp.mkdir(file);
		await assert.rejects(() => read(root, session, message), /普通文件/);
	});

	for (const segment of ["task-output", "query-answers", session, message + ".md"]) {
		test("rejects a linked path component: " + segment, async t => {
			const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reader-answer-link-"));
			const components = relative.split(path.sep);
			const at = components.indexOf(segment);
			const link = path.join(root, ...components.slice(0, at + 1));
			const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "reader-answer-outside-"));
			const targetFile = path.join(outside, ...components.slice(at + 1));
			const last = at === components.length - 1;
			const target = last ? path.join(outside, "answer.md") : outside;
			await fsp.mkdir(path.dirname(link), { recursive: true });
			if (!last) await fsp.mkdir(path.dirname(targetFile), { recursive: true });
			await fsp.writeFile(last ? target : targetFile, "external");
			try {
				await fsp.symlink(target, link, last ? "file" : process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				if (!["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
				return t.skip("link unavailable: " + error.code);
			}
			await assert.rejects(() => read(root, session, message), /链接|junction|可信/);
		});
	}

	test("accepts a linked plugin root but rejects a junction named as the answer file", async t => {
		const { root, file } = await fixture();
		const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "reader-answer-root-link-"));
		const linkedRoot = path.join(parent, "plugin");
		const dirType = process.platform === "win32" ? "junction" : "dir";
		try {
			await fsp.symlink(root, linkedRoot, dirType);
		} catch (error) {
			if (!["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
			return t.skip("directory links unavailable: " + error.code);
		}
		await fsp.writeFile(file, "answer through the root link");
		assert.equal(await read(linkedRoot, session, message), "answer through the root link");
		const outside = path.join(parent, "outside");
		await fsp.mkdir(outside);
		await fsp.symlink(outside, path.join(path.dirname(file), "message-link.md"), dirType);
		await assert.rejects(() => read(linkedRoot, session, "message-link"), /链接|junction/);
	});

	test("rejects invalid UTF-8, oversized data and propagates IO errors", async t => {
		const { root, file } = await fixture();
		await fsp.writeFile(file, Buffer.from([0xc3, 0x28]));
		await assert.rejects(() => read(root, session, message), /UTF-?8|utf-?8/i);
		await fsp.writeFile(file, Buffer.alloc(120000 * 4 + 1));
		await assert.rejects(() => read(root, session, message), /上限|过大/);
		await fsp.writeFile(file, "hello");
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
		t.mock.method(fsp, "open", async () => { throw failure; });
		await assert.rejects(() => read(root, session, message), error => error === failure);
	});
});

describe("chooseAnswerText", () => {
	let choose;
	before(async () => { choose = (await loadBundle("query/answer-text.ts")).exports.chooseAnswerText; });

	test("complete memory and legacy messages never touch the file", async () => {
		let reads = 0;
		for (const contentLength of [undefined, 6, 4]) {
			const result = await choose({ content: "memory", contentLength }, async () => { reads++; return "unused"; });
			assert.deepEqual(result, { text: "memory", complete: true, originalLength: contentLength ?? 6, keptLength: 6 });
		}
		assert.equal(reads, 0);
	});

	for (const [name, length, originalLength, complete] of [
		["complete UTF-16 answer", 6, 6, true],
		["longer partial file", 6, 8, false],
		["120000 of 130000", 120000, 130000, false],
		["120000 of 120000", 120000, 120000, true],
	]) {
		test(name, async () => {
			const text = "📖".repeat(length / 2);
			let reads = 0;
			const result = await choose({ content: "📖", contentLength: originalLength }, async () => { reads++; return text; });
			assert.equal(reads, 1);
			assert.equal(result.text, text);
			assert.equal(result.complete, complete);
			assert.equal(result.originalLength, originalLength);
			assert.equal(result.keptLength, length);
			if (complete) assert.equal(result.problem, undefined);
			else assert.match(result.problem, /截短|部分/);
		});
	}

	for (const [name, value, reason] of [
		["missing", null, /不存在|缺失/],
		["unreadable", new Error("disk offline"), /disk offline/],
		["too long", "123456789", /超过|大于/],
		["same as preview", "abcd", /未超过|不长于|不超过/],
		["shorter than preview", "", /未超过|不长于|不超过/],
	]) {
		test(name + " keeps the memory snapshot with a reason", async () => {
			const snapshot = { content: "1234", contentLength: 8 };
			const result = await choose(snapshot, async () => {
				snapshot.content = "changed";
				snapshot.contentLength = 100;
				if (value instanceof Error) throw value;
				return value;
			});
			assert.equal(result.text, "1234");
			assert.equal(result.originalLength, 8);
			assert.equal(result.keptLength, 4);
			assert.equal(result.complete, false);
			assert.match(result.problem, reason);
		});
	}
});
