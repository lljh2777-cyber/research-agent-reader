const assert = require("node:assert/strict");
const path = require("node:path");
const { loadReading } = require("./reading-test-helpers");
const { openCodeProject, codeFingerprint, validateCodeSnapshot, CODE_LIMITS } = loadReading("code-reading/source.ts");
const base = path.resolve("synthetic-code-project");
const files = new Map(); const links = new Set(); const reads = [];
const put = (relative, text) => files.set(path.join(base, relative), typeof text === "string" ? Buffer.from(text) : text);
const io = {
	async stat(p) { if (links.has(p)) return { link: true, file: true, size: 0 }; if (files.has(p)) return { file: true, size: files.get(p).length }; if (p === base || [...files.keys(), ...links].some(f => f.startsWith(p + path.sep))) return { directory: true }; throw new Error("missing: " + p); },
	async realpath(p) { return p; },
	async list(p) { return [...new Set([...files.keys(), ...links].filter(f => f.startsWith(p + path.sep)).map(f => path.relative(p, f).split(path.sep)[0]))]; },
	async read(p) { reads.push(p); return files.get(p); },
};
(async () => {
	put("main.py", "# 中文\r\nfrom lib import work\r\nwork()\r\n"); put("lib.R", "work <- function(x) {\n  x + 1\n}\n"); put("README.md", "# Example\n");
	put(".env", "secret"); put(".venv/secret.py", "ignored"); put("data.csv", "ignored"); links.add(path.join(base, "linked.py"));
	const initialBytes = [...files].map(([p, b]) => [p, b.toString("hex")]);
	const doc = await openCodeProject(base, io);
	assert.deepEqual(doc.source.code.files.map(f => f.path), ["README.md", "lib.R", "main.py"]);
	assert.equal(doc.skipped, 4); assert(reads.every(p => !p.includes(".env") && !p.includes(".venv") && !p.endsWith(".csv")));
	const excerpt = doc.readRange("main.py", 2, 3); assert.equal(excerpt.text, "from lib import work\r\nwork()\r\n"); assert.equal(excerpt.startLine, 2);
	assert.equal(excerpt.start, "# 中文\r\n".length); assert(doc.catalog.includes(excerpt.path));
	assert.throws(() => doc.readRange("../secret.py", 1, 2)); assert.throws(() => doc.readRange("main.py", 0, 1)); assert.throws(() => doc.readRange("main.py", 1, 4));
	await doc.verify(); assert.deepEqual([...files].map(([p, b]) => [p, b.toString("hex")]), initialBytes);
	put("data.csv", "different ignored contents"); await doc.verify();
	put("main.py", "# 中文\r\nfrom lib import work\r\nnoop()\r\n"); await assert.rejects(doc.verify(), /源码已变化/);
	assert.equal(doc.readRange("main.py", 3, 3).text, "work()\r\n", "old evidence stays at its source version");
	const changed = await openCodeProject(base, io); assert.notEqual(changed.source.fingerprint, doc.source.fingerprint);
	put("new.py", "value = 2\n"); await assert.rejects(changed.verify(), /源码已变化/);
	const single = await openCodeProject(path.join(base, "lib.R"), io); assert.equal(single.source.code.scope, "file"); assert.equal(single.source.code.files.length, 1);
	assert.equal(codeFingerprint(single.source.code), single.source.fingerprint);
	assert.throws(() => validateCodeSnapshot({ ...single.source.code, files: [{ ...single.source.code.files[0], path: "../bad.R" }] }));
	await assert.rejects(openCodeProject(path.join(base, "linked.py"), io), /链接/);
	await assert.rejects(openCodeProject(path.join(base, "README.md"), io), /单文件/);
	put("long.py", Array.from({ length: 170 }, (_, i) => "line_" + i + " = " + i).join("\n"));
	const long = await openCodeProject(path.join(base, "long.py"), io); assert.equal(long.evidence.length, 3); assert.equal(long.evidence.at(-1).startLine, 161);
	assert.equal(long.evidence.map(e => e.text).join(""), files.get(path.join(base, "long.py")).toString());
	put("bad.py", Buffer.from([0xff, 0xfe])); await assert.rejects(openCodeProject(path.join(base, "bad.py"), io), /UTF-8/);
	put("bad.py", "a\0b"); await assert.rejects(openCodeProject(path.join(base, "bad.py"), io), /二进制/);
	put("bad.py", "a".repeat(CODE_LIMITS.fileBytes + 1)); await assert.rejects(openCodeProject(path.join(base, "bad.py"), io), /512 KiB/);
	put("bad.py", "a".repeat(CODE_LIMITS.blockChars + 1)); await assert.rejects(openCodeProject(path.join(base, "bad.py"), io), /过长单行/);
	put("empty.py", ""); await assert.rejects(openCodeProject(path.join(base, "empty.py"), io), /没有可读取/);
	const controller = new AbortController(); controller.abort(); await assert.rejects(openCodeProject(base, io, controller.signal));
	put("bad.py", "valid = True\n");
	await assert.rejects(openCodeProject(base, { ...io, realpath: async p => p.endsWith("main.py") ? path.resolve("outside.py") : p }), /路径已变化|超出/);
	console.log("CODE_READING_SOURCE_OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
