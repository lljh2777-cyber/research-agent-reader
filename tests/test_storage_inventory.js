"use strict";
// Isolated retained fixtures only. No model calls, dependencies, or file cleanup.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict"), { execFileSync, spawnSync } = require("node:child_process");
const { inventory, writeReport, portable } = require("../scripts/storage-inventory.cjs");
const { describe, classify } = require("../scripts/storage-inventory-rules.cjs");
const R = "r-11111111-1111-1111-1111-111111111111", A = "a-22222222-2222-2222-2222-222222222222";
const D = "d-33333333-3333-3333-3333-333333333333", V = "v-44444444-4444-4444-4444-444444444444", P = "p-55555555-5555-5555-5555-555555555555";
const hash = "a".repeat(64), pluginDir = ".custom/plugins/research-agent-reader";
const json = value => JSON.stringify(value);
let root, count = 0;
async function fixture(name) {
	const vault = path.join(root, name), plugin = path.join(vault, pluginDir); await fs.mkdir(plugin, { recursive: true });
	const put = async (relative, text = "", pluginFile = true) => { const file = path.join(pluginFile ? plugin : vault, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, { flag: "wx" }); return file; };
	await put("manifest.json", json({ id: "research-agent-reader", version: "0.81.1" }));
	return { vault, plugin, put, scan: options => inventory({ vault, pluginDir, ...options }) };
}
async function snapshot(directory) {
	const out = {};
	async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name), s = await fs.lstat(file); out[path.relative(directory, file)] = { mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size, text: e.isFile() ? (await fs.readFile(file)).toString("base64") : "directory" }; if (e.isDirectory()) await walk(file); } }
	await walk(directory); return out;
}
async function test(name, run) { await run(); count++; console.log("PASS storage inventory: " + name); }
(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "rar-r4-inventory-"));
	await test("classifies true durable records, mixed settings, caches and unknowns conservatively", async () => {
		assert.equal(classify("data.json").category, "mixed-private");
		assert.equal(classify("fulltext/production/x.pdf").category, "durable-deferred");
		assert.equal(classify("reading-runs/a/response.txt").category, "durable-deferred");
		assert.equal(classify("retrieval-index/bge-v1.bin").category, "rebuildable-cache");
		assert.equal(classify("retrieval-index/personal-note.md").category, "unknown");
		assert.equal(classify("unrecognized/backups.json").category, "unknown");
		assert.equal(classify("knowledge-pages/x.json").category, "durable");
	});
	await test("bounded read-only inventory uses actual plugin directory and hashes candidates only", async () => {
		const f = await fixture("main");
		await f.put("data.json", json({ settings: { secret: "PRIVATE_TOKEN", toolkitRoot: "PRIVATE_TOOLKIT", readerMarkdownFolders: ["papers"], queryNotesFolder: "wiki/qa" }, querySessions: [{ text: "PRIVATE_QUESTION" }], taskRuns: [{ output: "PRIVATE_OUTPUT" }] }));
		await f.put(`reading-sessions/${R}.json`, json({ version: 1, id: R, source: { path: "papers/demo/article.md" }, nodes: [{ content: "PRIVATE_ANSWER" }] }));
		await f.put(`reading-assistant-runs/${A}.json`, json({ version: 1, id: A, sessionId: R }));
		await f.put(`paper-records/${P}/${V}.json`, json({ schemaVersion: 1, revisionId: V, record: { paperId: P, primaryNoteId: "wiki/sources/demo.md" }, digest: hash }));
		await f.put(`paper-records/${P}/${V}.ready`, hash);
		await f.put("retrieval-index/bge-v1.bin", "cache"); await f.put("fulltext/production/a.pdf", "unique pdf");
		await f.put("papers/demo/article.md", "source", false); await f.put("wiki/sources/demo.md", "note", false);
		const before = await snapshot(f.vault), report = await f.scan({ fingerprint: true });
		assert.deepEqual(report.issues, []); assert.equal(report.summary.candidateFiles, 4); assert.equal(report.summary.hashedFiles, 4);
		assert.equal(report.summary.categories["mixed-private"].files, 1); assert.equal(report.entries.find(e => e.path === "data.json").facts.querySessions, 1);
		assert.equal(report.entries.find(e => e.path === "manifest.json").facts.installedVersion, "0.81.1");
		assert.ok(report.entries.filter(e => e.sha256).every(e => e.category === "durable"));
		assert.ok(report.references.every(r => r.status === "file")); assert.equal(report.migrationExecutable, false); assert.equal(report.contentValidation, "not-performed");
		assert.doesNotMatch(json(report), /PRIVATE_TOKEN|PRIVATE_TOOLKIT|PRIVATE_QUESTION|PRIVATE_OUTPUT|PRIVATE_ANSWER/);
		assert.deepEqual(await snapshot(f.vault), before); await assert.rejects(fs.stat(path.join(f.vault, "_research")), { code: "ENOENT" });
		const output = path.join(root, "main-report.json"); await writeReport(report, output); await assert.rejects(writeReport(report, output), { code: "EEXIST" });
		await assert.rejects(writeReport(report, path.join(f.vault, "report.json")), /OUTPUT_MUST_BE_OUTSIDE/);
		await assert.rejects(writeReport(report, path.resolve(__dirname, "../report.json")), /OUTPUT_MUST_BE_OUTSIDE/);
		// A fresh process can inspect persisted fixtures with exactly the same facts and no writes to source.
		const cliOut = path.join(root, "cli-report.json");
		const result = execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/storage-inventory.cjs"), "--vault", f.vault, "--plugin-dir", pluginDir, "--output", cliOut], { encoding: "utf8", windowsHide: true });
		assert.equal(JSON.parse(result).hashedFiles, 0); assert.deepEqual(await snapshot(f.vault), before);
	});
	await test("pending, missing markers, mismatched markers and incomplete pages are retained and visible", async () => {
		const f = await fixture("journals");
		await f.put(`knowledge-drafts/${D}/${hash}.json`, json({ version: 1, digest: hash, draft: { id: D } }));
		await f.put(`paper-records/${P}/${V}.json`, json({ digest: hash })); await f.put(`paper-records/${P}/${V}.ready`, "b".repeat(64));
		await f.put(`knowledge-pages/${D}.json`, json({ version: 1, draft: { digest: hash, draft: { id: D } }, writes: [{ path: "wiki/concepts/future.md", before: null }] }));
		await f.put(`reading-sessions/${R}.json.pending`, "partial"); await f.put("knowledge-pages/orphan.complete", hash);
		const report = await f.scan(), codes = report.issues.map(i => i.code);
		for (const code of ["MISSING_COMMIT_MARKER", "COMMIT_DIGEST_MISMATCH", "PENDING_WRITE", "UNFINISHED_PAGE_PLAN", "ORPHAN_COMMIT_MARKER"]) assert.ok(codes.includes(code), code);
		assert.ok(report.references.some(r => r.status === "planned-not-created")); assert.equal(report.summary.hashedFiles, 0);
	});
	await test("missing, ambiguous, external and traversal references never become approved paths", async () => {
		const f = await fixture("references");
		for (const dir of ["reading-sessions", "code-reading-sessions"]) await f.put(`${dir}/${R}.json`, json({ id: R, source: { path: dir === "reading-sessions" ? "../outside.md" : "C:\\external\\original.pdf" }, evidence: [{ path: "wiki/missing.md" }] }));
		await f.put(`reading-assistant-runs/${A}.json`, json({ id: A, sessionId: R }));
		const report = await f.scan(), statuses = report.references.map(r => r.status);
		for (const s of ["invalid-path", "external-not-inspected", "missing", "ambiguous"]) assert.ok(statuses.includes(s), s);
	});
	await test("malformed JSON and unknown files expose codes, never body text", async () => {
		const f = await fixture("invalid"); await f.put(`reading-sessions/${R}.json`, "PRIVATE_BROKEN_JSON"); await f.put("mystery/a.json", '{"apiKey":"PRIVATE_TOKEN"}');
		const report = await f.scan(); assert.ok(report.issues.some(i => i.code === "INVALID_JSON_OR_UTF8")); assert.ok(report.issues.some(i => i.code === "UNKNOWN_FILE")); assert.doesNotMatch(json(report), /PRIVATE_/);
		const out = path.join(root, "invalid-report.json"), result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/storage-inventory.cjs"), "--vault", f.vault, "--plugin-dir", pluginDir, "--output", out], { encoding: "utf8", windowsHide: true });
		assert.equal(result.status, 2); assert.ok(JSON.parse(await fs.readFile(out, "utf8")).issues.length);
	});
	await test("limits yield an incomplete report with a visible issue", async () => {
		const f = await fixture("limits"); await f.put(`reading-sessions/${R}.json`, json({ version: 1, data: "x".repeat(100) }));
		assert.ok((await f.scan({ limits: { fileBytes: 10 } })).issues.some(i => i.code === "READ_BUDGET_EXCEEDED"));
		assert.ok((await f.scan({ limits: { entries: 1 } })).issues.some(i => i.code === "ENTRY_LIMIT"));
		await assert.rejects(f.scan({ limits: { entries: -1 } }), /INVALID_LIMITS/);
	});
	await test("junctions in plugin tree, ancestors, target and references are not followed", async () => {
		const f = await fixture("links"), outside = path.join(root, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "hidden.json"), "PRIVATE_OUTSIDE");
		await fs.symlink(outside, path.join(f.plugin, "reading-sessions"), process.platform === "win32" ? "junction" : "dir");
		await fs.symlink(outside, path.join(f.vault, "_research"), process.platform === "win32" ? "junction" : "dir");
		await fs.symlink(outside, path.join(f.vault, "linked"), process.platform === "win32" ? "junction" : "dir");
		await f.put(`code-reading-sessions/${R}.json`, json({ source: { path: "linked/hidden.json" } }));
		const report = await f.scan(); assert.ok(report.issues.some(i => i.code === "LINK_OR_SPECIAL_PATH")); assert.ok(report.issues.some(i => i.code === "TARGET_UNSAFE")); assert.ok(report.references.some(r => r.status === "LINK_OR_SPECIAL_PATH")); assert.doesNotMatch(json(report), /PRIVATE_OUTSIDE/);
		await assert.rejects(inventory({ vault: f.vault, pluginDir: "linked" }), /LINK_OR_SPECIAL_PATH/);
		await assert.rejects(writeReport(report, path.join(f.vault, "linked/report.json")), /OUTPUT_MUST_BE_OUTSIDE|LINK_OR_SPECIAL_PATH/);
		const linkedOut = path.join(root, "linked-output"); await fs.symlink(outside, linkedOut, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(writeReport(report, path.join(linkedOut, "report.json")), /LINK_OR_SPECIAL_PATH/);
	});
	await test("occupied targets and invalid roots stop an actionable plan", async () => {
		const f = await fixture("target"); await f.put("_research/existing.json", "keep", false);
		const report = await f.scan(); assert.equal(report.summary.targetStatus, "occupied-directory"); assert.ok(report.issues.some(i => i.code === "TARGET_OCCUPIED"));
		await assert.rejects(f.scan({ target: ".custom" }), /OVERLAPPING_TARGET/);
		await assert.rejects(inventory({ vault: f.vault, pluginDir: "../escape" }), /INVALID_ROOT_OPTIONS/);
		const empty = path.join(root, "empty-vault"); await fs.mkdir(path.join(empty, pluginDir), { recursive: true });
		assert.ok((await inventory({ vault: empty, pluginDir })).issues.some(i => i.code === "PLUGIN_MANIFEST_MISSING"));
		for (const p of ["../x", "CON/a", "a/NUL.txt", "a\\b", "/abs", "a//b", "a:secret", "a. /b"]) assert.equal(portable(p), false, p);
	});
	await test("explicit draft and curation links are extracted without traversing saved prose", async () => {
		const d = describe("knowledge-drafts", { draft: { id: D, body: "PRIVATE", material: { path: "wiki/qa/answer-excerpts/a.md", raw: "PRIVATE" } }, digest: hash }, "");
		assert.equal(d.refs[0].target, "wiki/qa/answer-excerpts/a.md"); assert.doesNotMatch(json(d), /PRIVATE/);
		const r = describe("knowledge-reviews", { reviewId: A, undoOf: A, writes: [{ path: "wiki/log.md", before: "PRIVATE", after: "PRIVATE" }] }, "knowledge-reviews/revisions/x.json"); assert.equal(r.refs.length, 3); assert.doesNotMatch(json(r), /PRIVATE/);
	});
	await test("demo URI is virtual only in explicitly marked demo sessions", async () => {
		const f = await fixture("demo");
		await f.put(`reading-sessions/${R}.json`, json({ id: R, demo: true, source: { path: "demo://reading" } }));
		let report = await f.scan(); assert.deepEqual(report.issues, []); assert.equal(report.references[0].status, "embedded-source");
		await f.put(`code-reading-sessions/${A}.json`, json({ source: { path: "demo://reading" } }));
		report = await f.scan(); assert.ok(report.issues.some(i => i.code === "REFERENCE_INVALID_PATH"));
	});
	await test("source changes during read are reported instead of receiving a fingerprint", async () => {
		const f = await fixture("changing"), file = await f.put(`reading-sessions/${R}.json`, json({ version: 1, id: R }));
		const open = fs.open; let modified = false;
		fs.open = async (...args) => {
			const handle = await open(...args);
			if (String(args[0]).endsWith(R + ".json") && args[1] === "r") {
				const read = handle.read.bind(handle);
				handle.read = async (...readArgs) => { const result = await read(...readArgs); if (!modified) { modified = true; await fs.appendFile(file, "changed"); } return result; };
			}
			return handle;
		};
		let report; try { report = await f.scan({ fingerprint: true }); } finally { fs.open = open; }
		assert.ok(report.issues.some(i => i.code === "SOURCE_CHANGED")); assert.equal(report.summary.hashedFiles, 0);
	});
	console.log(`STORAGE_INVENTORY_OK (${count} groups; retained fixtures: ${root})`);
})().catch(error => { console.error(error); process.exitCode = 1; });
