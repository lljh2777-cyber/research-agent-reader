"use strict";
// Private retained-copy rehearsal. The source has no write API; no migration router or deletion exists.
const fs = require("node:fs/promises"), path = require("node:path"), { createHash } = require("node:crypto"), { execFileSync } = require("node:child_process");
const { inventory, inspectAbsolute, portable } = require("./storage-inventory.cjs");
const { CANDIDATES } = require("./storage-inventory-rules.cjs");
const load = require("./load-storage-validator.cjs");
const LIMIT = 128 * 1024 * 1024, FILE_LIMIT = 64 * 1024 * 1024, MAX_FILES = 20000, ANSWERS = "wiki/qa/answer-excerpts";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, p) => { const r = path.relative(root, p); return !r || r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); };
const equalStat = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => a[k] === b[k]);
const fail = code => { const e = new Error(code); e.rehearsalCode = code; throw e; };
const code = error => error.rehearsalCode || error.code || "REHEARSAL_FAILED";

async function readBundle(root) {
	if (!(await inspectAbsolute(root)).isDirectory()) fail("INVALID_BUNDLE_ROOT");
	const { FileSourceStorage, validateStorageSnapshot } = load(), io = new FileSourceStorage(root);
	const manifestBytes = await io.read("manifest.json", 8 * 1024 * 1024); if (!manifestBytes) fail("MANIFEST_MISSING");
	let manifest; try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); } catch { fail("MANIFEST_INVALID"); }
	if (manifest?.version !== 1 || manifest.kind !== "rar-storage-read-rehearsal" || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) fail("MANIFEST_INVALID");
	const files = new Map(), inbound = new Map(), seen = new Set(), declared = new Set(); let bytes = 0;
	for (const e of manifest.files) {
		if (!e || !portable(e.path) || !["records", "vault-context"].includes(e.area) || !Number.isSafeInteger(e.size) || e.size < 0 || e.size > FILE_LIMIT || !/^[a-f0-9]{64}$/.test(e.sha256)) fail("MANIFEST_ENTRY_INVALID");
		if (e.area === "records" ? !CANDIDATES.has(e.path.split("/")[0]) : !e.path.startsWith(ANSWERS + "/") || e.path.slice(ANSWERS.length + 1).includes("/") || !e.path.endsWith(".md")) fail("MANIFEST_SCOPE_INVALID");
		const key = (e.area + "/" + e.path).normalize("NFC").toLowerCase(); if (seen.has(key)) fail("MANIFEST_DUPLICATE"); seen.add(key);
		declared.add(e.area + "/" + e.path);
		if ((bytes += e.size) > LIMIT) fail("BUNDLE_BUDGET");
		let data; try { data = await io.read(e.area + "/" + e.path, e.size + 1); } catch { fail("BUNDLE_CONTENT_UNAVAILABLE"); }
		if (!data || data.length !== e.size || digest(data) !== e.sha256) fail("BUNDLE_CONTENT_CHANGED");
		(e.area === "records" ? files : inbound).set(e.path, data);
	}
	// Every payload in the owned copy must be declared; no silently ignored extra record/version.
	let visited = 0;
	async function checkTree(relative) {
		for (const e of await io.list(relative)) {
			if (++visited > MAX_FILES * 3) fail("BUNDLE_ENTRY_LIMIT");
			const p = relative + "/" + e.name;
			if (e.directory) await checkTree(p);
			else if (!declared.has(p)) fail("BUNDLE_UNLISTED_FILE");
		}
	}
	for (const area of ["records", "vault-context"]) await checkTree(area);
	return { integrity: true, files: files.size, inbound: inbound.size, bytes, audit: await validateStorageSnapshot(files, inbound) };
}

async function rehearse(options) {
	if (!path.isAbsolute(options.outputDir || "")) fail("ABSOLUTE_NEW_OUTPUT_REQUIRED");
	const scanned = await inventory({ vault: options.vault, pluginDir: options.pluginDir, fingerprint: false });
	const vault = scanned.vault, plugin = path.join(vault, options.pluginDir), outputParent = path.dirname(path.resolve(options.outputDir));
	await inspectAbsolute(outputParent);
	const output = path.join(await fs.realpath(outputParent), path.basename(options.outputDir)), repo = await fs.realpath(path.resolve(__dirname, ".."));
	if (!portable(path.basename(output)) || inside(vault, output) || inside(repo, output)) fail("OUTPUT_MUST_BE_OUTSIDE_VAULT_AND_REPOSITORY");
	// Exclusive new directory; any interrupted output remains inspectable and is never overwritten.
	await fs.mkdir(output, { mode: 0o700 });
	const writeJson = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	await writeJson("inventory.json", scanned);
	if (scanned.issues.length) {
		const result = { copied: false, reason: "INVENTORY_REQUIRES_REVIEW", inventoryIssues: scanned.issues.length, migrationExecutable: false };
		await writeJson("result.json", result); return { output, ...result };
	}
	const { FileSourceStorage, validateStorageSnapshot } = load();
	const source = new FileSourceStorage(plugin), vaultIO = new FileSourceStorage(vault), files = new Map(), inbound = new Map(), observations = [];
	let total = 0;
	async function capture(io, root, p, limit, expected) {
		if (!portable(p) || observations.length >= MAX_FILES) fail("CAPTURE_PATH_OR_COUNT");
		const absolute = path.join(root, p), before = await inspectAbsolute(absolute);
		if (!before.isFile() || before.size > limit || expected && (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs)) fail("SOURCE_CHANGED_OR_TOO_LARGE");
		if ((total += before.size) > LIMIT) fail("CAPTURE_BUDGET");
		const bytes = await io.read(p, limit); if (!bytes || !equalStat(before, await inspectAbsolute(absolute))) fail("SOURCE_CHANGED");
		observations.push({ absolute, before }); return bytes;
	}
	const selected = scanned.entries.filter(e => e.category === "durable");
	for (const entry of selected) files.set(entry.path, await capture(source, plugin, entry.path, FILE_LIMIT, entry));
	async function answerNames() {
		const entries = await vaultIO.list(ANSWERS);
		if (entries.some(e => e.directory || !e.name.endsWith(".md") || !portable(e.name))) fail("ANSWER_EXCERPT_SCOPE_REQUIRES_REVIEW");
		return entries.map(e => e.name).sort();
	}
	const answers = await answerNames();
	for (const name of answers) { const p = ANSWERS + "/" + name; inbound.set(p, await capture(vaultIO, vault, p, 2 * 1024 * 1024)); }
	const beforeAudit = await validateStorageSnapshot(files, inbound);
	await writeJson("source-audit.json", beforeAudit);
	const external = [];
	for (const e of beforeAudit.edges.filter(e => ["vault", "external-code"].includes(e.kind))) {
		let p = e.target, status;
		if (e.kind === "external-code") status = "external-code-not-inspected";
		else if (path.isAbsolute(p) || path.win32.isAbsolute(p)) {
			if (path.isAbsolute(p) && inside(vault, path.resolve(p))) p = path.relative(vault, p).split(path.sep).join("/");
			else status = "external-not-inspected";
		}
		if (!status) {
			if (!portable(p)) status = "invalid-path";
			else try { status = (await inspectAbsolute(path.join(vault, p))).isFile() ? "file-present" : "unexpected-directory"; }
			catch (error) { status = error.code === "ENOENT" ? e.planned ? "planned-not-created" : "missing" : "unsafe-or-unreadable"; }
		}
		external.push({ ...e, status });
	}
	await writeJson("unmoved-dependencies.json", { observedAt: new Date().toISOString(), checks: external, evidenceContentVerified: false, copied: false });
	const destination = new FileSourceStorage(output), manifest = { version: 1, kind: "rar-storage-read-rehearsal", files: [] };
	const made = new Set();
	async function publish(area, p, bytes) {
		const parts = (area + "/" + p).split("/");
		for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join("/"); if (!made.has(dir)) { await destination.mkdir(dir, true); made.add(dir); } }
		await destination.create(area + "/" + p, bytes);
		const copied = await destination.read(area + "/" + p, bytes.length + 1); if (!copied || !Buffer.from(copied).equals(Buffer.from(bytes))) fail("COPY_MISMATCH");
		manifest.files.push({ area, path: p, size: bytes.length, sha256: digest(bytes) });
	}
	for (const [p, bytes] of files) await publish("records", p, bytes);
	for (const [p, bytes] of inbound) await publish("vault-context", p, bytes);
	// Verify source membership and attributes at the end; a changed source cannot produce a completion result.
	const end = await inventory({ vault, pluginDir: options.pluginDir, fingerprint: false });
	const projection = rows => rows.filter(e => e.category === "durable").map(e => [e.path, e.size, e.mtimeMs]);
	if (end.issues.length || JSON.stringify(projection(scanned.entries)) !== JSON.stringify(projection(end.entries)) || JSON.stringify(answers) !== JSON.stringify(await answerNames())) fail("SOURCE_SET_CHANGED");
	for (const o of observations) if (!equalStat(o.before, await inspectAbsolute(o.absolute))) fail("SOURCE_CHANGED");
	await writeJson("manifest.json", manifest);
	// Fresh process only receives the retained-copy path, never the original Vault root or data.json.
	const restored = JSON.parse(execFileSync(process.execPath, [__filename, "--verify", output], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
	await writeJson("restored-audit.json", restored);
	if (JSON.stringify(beforeAudit) !== JSON.stringify(restored.audit)) fail("RESTORED_AUDIT_DIFFERENT");
	const result = { version: 1, copied: true, candidateFiles: files.size, answerExcerptFiles: inbound.size, bytes: total, sourceStable: true, freshProcessReadEquivalent: true,
		validation: beforeAudit.summary, unmovedDependencyIssues: external.filter(e => !["file-present", "planned-not-created"].includes(e.status)).length,
		migrationExecutable: false, remainingBoundary: "deferred-transactions-data-json-source-packages-and-other-vault-backlinks-not-closed" };
	await writeJson("result.json", result); return { output, ...result };
}
async function main(args) {
	if (args.length === 2 && args[0] === "--verify") { console.log(JSON.stringify(await readBundle(path.resolve(args[1])))); return; }
	if (args.length === 1 && args[0] === "--help") { console.log("node scripts/storage-rehearsal.cjs --vault <absolute> --plugin-dir <relative> --output-dir <new-private-directory-outside-vault-and-repo>\nCreates retained copies only; never switches storage. --verify <copy> checks the copy without reading the source Vault."); return; }
	const keys = { "--vault": "vault", "--plugin-dir": "pluginDir", "--output-dir": "outputDir" }, options = {};
	for (let i = 0; i < args.length; i += 2) { if (!Object.hasOwn(keys, args[i]) || !args[i + 1] || options[keys[args[i]]]) fail("INVALID_ARGUMENTS"); options[keys[args[i]]] = args[i + 1]; }
	const result = await rehearse(options); console.log(JSON.stringify(result));
	if (!result.copied || result.validation.issues || result.unmovedDependencyIssues) process.exitCode = 2;
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error("STORAGE_REHEARSAL_ERROR: " + code(e)); process.exitCode = 1; });
module.exports = { rehearse, readBundle };
