"use strict";

// Read-only R4 preflight. No production repository constructors (some initialize/write on read).
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { classify, describe, JOURNALS } = require("./storage-inventory-rules.cjs");
const DEFAULT_LIMITS = { entries: 20000, depth: 16, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, references: 20000 };
const within = (root, file) => { const r = path.relative(root, file); return r === "" || r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); };
const sameStat = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(k => a[k] === b[k]);
const portable = p => typeof p === "string" && p.length > 0 && p.length <= 600 && !p.includes("\\") && p.split("/").every(s => s && s !== "." && s !== ".." && !/[<>:"|?*\x00-\x1f\x7f]/.test(s) && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
class InventoryError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new InventoryError(code); };
const errorCode = e => e instanceof InventoryError ? e.code : ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(e.code) ? e.code : "IO_ERROR";

// Check every ancestor, including configured roots, without following links/junctions.
async function inspectAbsolute(absolute) {
	if (!path.isAbsolute(absolute)) fail("ABSOLUTE_ROOT_REQUIRED");
	let cursor = path.parse(absolute).root, stat = await fs.lstat(cursor);
	for (const part of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
		if (!stat.isDirectory() || stat.isSymbolicLink()) fail("LINK_OR_SPECIAL_PATH");
		cursor = path.join(cursor, part); stat = await fs.lstat(cursor);
		if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail("LINK_OR_SPECIAL_PATH");
	}
	// Windows may supply an 8.3 TEMP/user path. Accept aliases only to the same inspected node.
	const canonical = await fs.lstat(await fs.realpath(absolute));
	if (stat.dev !== canonical.dev || stat.ino !== canonical.ino) fail("RESOLVED_PATH_CHANGED");
	return stat;
}
async function inventory(options) {
	const { vault, pluginDir, fingerprint = false, target = "_research" } = options;
	if (!path.isAbsolute(vault || "") || !portable(pluginDir) || !portable(target)) fail("INVALID_ROOT_OPTIONS");
	await inspectAbsolute(path.resolve(vault));
	const vaultRoot = await fs.realpath(path.resolve(vault)), pluginRoot = path.join(vaultRoot, pluginDir), targetRoot = path.join(vaultRoot, target);
	if (within(pluginRoot, targetRoot) || within(targetRoot, pluginRoot)) fail("OVERLAPPING_TARGET");
	for (const root of [vaultRoot, pluginRoot]) if (!(await inspectAbsolute(root)).isDirectory()) fail("DIRECTORY_REQUIRED");
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	for (const n of Object.values(limits)) if (!Number.isSafeInteger(n) || n <= 0) fail("INVALID_LIMITS");
	const report = { format: "rar-storage-inventory-v1", mode: "read-only-design-preview", vault: vaultRoot, pluginDir, proposedRoot: target,
		startedAt: new Date().toISOString(), fingerprint, limits, scope: "plugin-tree-and-explicit-references", contentValidation: "not-performed", referenceClosure: "partial", migrationExecutable: false,
		entries: [], directories: [], references: [], issues: [], summary: {} };
	const issue = (code, relative = "", scope = "plugin") => report.issues.push({ code, scope, path: relative });
	const seen = new Map(), directories = [], fileStats = [], queue = [], entriesByPath = new Map();
	let visited = 0, bytesRead = 0;
	async function readStable(relative, before) {
		if (before.size > limits.fileBytes || bytesRead + before.size > limits.totalBytes) fail("READ_BUDGET_EXCEEDED");
		const absolute = path.join(pluginRoot, relative);
		if (!sameStat(before, await inspectAbsolute(absolute))) fail("SOURCE_CHANGED");
		const handle = await fs.open(absolute, "r");
		try {
			if (!sameStat(before, await handle.stat())) fail("SOURCE_CHANGED");
			const bytes = Buffer.alloc(before.size + 1); let offset = 0;
			while (offset < bytes.length) { const r = await handle.read(bytes, offset, bytes.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
			bytesRead += offset;
			if (offset !== before.size || !sameStat(before, await handle.stat()) || !sameStat(before, await inspectAbsolute(absolute))) fail("SOURCE_CHANGED");
			return bytes.subarray(0, offset);
		} finally { await handle.close(); }
	}
	async function walk(relative = "", depth = 0) {
		if (depth > limits.depth) fail("DEPTH_LIMIT");
		const absolute = relative ? path.join(pluginRoot, relative) : pluginRoot;
		const before = await inspectAbsolute(absolute); directories.push({ relative, before });
		if (relative) report.directories.push({ path: relative, ...classify(relative) });
		const dir = await fs.opendir(absolute), names = [];
		try { for (;;) { const item = await dir.read(); if (!item) break; if (++visited > limits.entries) fail("ENTRY_LIMIT"); names.push(item.name); } } finally { await dir.close(); }
		for (const name of names.sort()) {
			const rel = relative ? relative + "/" + name : name;
			if (!portable(rel)) { issue("NONPORTABLE_PATH", rel); continue; }
			const key = rel.normalize("NFC").toLowerCase();
			if (seen.has(key)) issue("CASE_OR_UNICODE_COLLISION", rel); else seen.set(key, rel);
			let stat;
			try { stat = await inspectAbsolute(path.join(pluginRoot, rel)); } catch (e) { issue(errorCode(e), rel); continue; }
			if (stat.isDirectory()) { await walk(rel, depth + 1); continue; }
			const entry = { path: rel, ...classify(rel), size: stat.size, mtimeMs: stat.mtimeMs, facts: {}, validation: "not-validated", proposedPath: null };
			report.entries.push(entry); entriesByPath.set(rel, entry);
			fileStats.push({ relative: rel, before: stat });
			if (entry.category === "durable") entry.proposedPath = target + "/" + rel;
			if (entry.category === "unknown") issue("UNKNOWN_FILE", rel);
			if (rel.endsWith(".pending")) issue("PENDING_WRITE", rel);
			const json = rel === "manifest.json" || rel.endsWith(".json") && ["durable", "mixed-private"].includes(entry.category);
			const marker = entry.category === "durable" && /\.(ready|complete)$/.test(rel);
			if (entry.category === "durable" && !json && !marker && !rel.endsWith(".pending")) issue("UNKNOWN_DURABLE_FORMAT", rel);
			try {
				if (json || marker || fingerprint && entry.category === "durable") {
					const bytes = await readStable(rel, stat);
					if (fingerprint && entry.category === "durable") entry.sha256 = createHash("sha256").update(bytes).digest("hex");
					if (marker) { const value = bytes.toString("utf8"); if (!/^[a-f0-9]{64}$/.test(value)) issue("INVALID_COMMIT_MARKER", rel); else entry.markerDigest = value; }
					if (json) {
						let value;
						try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("INVALID_JSON_OR_UTF8"); }
						const description = describe(entry.group, value, rel); entry.facts = description.facts;
						if (description.invalid) issue("INVALID_RECORD_SHAPE", rel);
						for (const ref of description.refs) { if (queue.length >= limits.references) fail("REFERENCE_LIMIT"); queue.push({ from: rel, ...ref }); }
					}
				}
			} catch (e) { issue(errorCode(e), rel); }
		}
	}
	try { await walk(); } catch (e) { issue(errorCode(e)); }
	if (!entriesByPath.has("manifest.json")) issue("PLUGIN_MANIFEST_MISSING", "manifest.json");
	const sessionLocations = new Map();
	for (const entry of report.entries) if (["reading-sessions", "code-reading-sessions", "reading-test-sessions"].includes(entry.group) && entry.facts.id) {
		const previous = sessionLocations.get(entry.facts.id);
		if (previous) issue("DUPLICATE_SESSION_ID", entry.path); else sessionLocations.set(entry.facts.id, entry.path);
	}
	// Structural marker pairing only. Digest equality is not production schema/history validation.
	for (const entry of report.entries) {
		if (JOURNALS.has(entry.group) && entry.path.endsWith(".json")) {
			const marker = entriesByPath.get(entry.path.slice(0, -5) + ".ready");
			if (!marker) issue("MISSING_COMMIT_MARKER", entry.path);
			else if (marker.markerDigest !== entry.facts.recordDigest) issue("COMMIT_DIGEST_MISMATCH", entry.path);
		}
		if (entry.category === "durable" && /\.(ready|complete)$/.test(entry.path)) {
			const partner = entry.path.replace(/\.(ready|complete)$/, ".json");
			if (!entriesByPath.has(partner)) issue("ORPHAN_COMMIT_MARKER", entry.path);
		}
		if (entry.group === "knowledge-pages" && entry.path.endsWith(".json") && !entriesByPath.has(entry.path.slice(0, -5) + ".complete")) issue("UNFINISHED_PAGE_PLAN", entry.path);
	}
	// Check explicit paths and IDs only; never follow arbitrary URLs, machine paths or document prose.
	const referenceCache = new Map();
	async function existence(scope, relative) {
		const key = scope + ":" + relative;
		if (referenceCache.has(key)) return referenceCache.get(key);
		let status;
		try { const stat = await inspectAbsolute(path.join(scope === "vault" ? vaultRoot : pluginRoot, relative)); status = stat.isDirectory() ? "directory" : "file"; }
		catch (e) { status = e.code === "ENOENT" ? "missing" : errorCode(e); }
		referenceCache.set(key, status); return status;
	}
	for (const ref of queue) {
		const result = { ...ref, status: "unresolved" };
		if (ref.scope === "embedded-demo") result.status = "embedded-source";
		else if (ref.scope === "session") {
			if (!/^r-[a-f0-9-]{36}$/.test(ref.target)) result.status = "invalid-id";
			else {
				const candidates = ["reading-sessions", "code-reading-sessions", "reading-test-sessions"].map(root => `${root}/${ref.target}.json`);
				result.matches = candidates.filter(p => entriesByPath.has(p));
				result.status = result.matches.length === 1 ? "file" : result.matches.length ? "ambiguous" : "missing";
			}
		} else if (ref.scope === "vault" && (path.isAbsolute(ref.target) || path.win32.isAbsolute(ref.target))) {
			if (path.isAbsolute(ref.target) && within(vaultRoot, path.resolve(ref.target))) {
				result.target = path.relative(vaultRoot, ref.target).split(path.sep).join("/");
				result.status = portable(result.target) ? await existence("vault", result.target) : "invalid-path";
			} else result.status = "external-not-inspected";
		} else if (!portable(ref.target)) result.status = "invalid-path";
		else result.status = await existence(ref.scope, ref.target);
		if (ref.planned && result.status === "missing") result.status = "planned-not-created";
		if (result.status === "directory" && ref.scope !== "plugin-directory") result.status = "unexpected-directory";
		if (result.status === "file" && ref.scope === "plugin-directory") result.status = "unexpected-file";
		if (!["file", "directory", "planned-not-created", "embedded-source"].includes(result.status)) issue("REFERENCE_" + result.status.toUpperCase().replaceAll("-", "_"), ref.from);
		report.references.push(result);
	}
	// Detect a changing directory/file listing without reading/hash-scanning the whole Vault again.
	for (const { relative, before } of [...directories, ...fileStats]) {
		try { if (!sameStat(before, await inspectAbsolute(path.join(pluginRoot, relative)))) issue(before.isDirectory() ? "DIRECTORY_CHANGED" : "SOURCE_CHANGED", relative); }
		catch (e) { issue(errorCode(e), relative); }
	}
	// Target is inspected only; it is never created, copied into, switched to or cleaned up.
	let targetStatus = "absent";
	try { targetStatus = (await inspectAbsolute(targetRoot)).isDirectory() ? "occupied-directory" : "occupied-file"; issue("TARGET_OCCUPIED", target, "vault"); }
	catch (e) { if (e.code !== "ENOENT") { targetStatus = errorCode(e); issue("TARGET_UNSAFE", target, "vault"); } }
	const categories = {};
	const issuesByPath = new Map();
	for (const i of report.issues) if (i.scope === "plugin") {
		if (!issuesByPath.has(i.path)) issuesByPath.set(i.path, new Set());
		issuesByPath.get(i.path).add(i.code);
	}
	for (const e of report.entries) {
		const c = categories[e.category] ||= { files: 0, bytes: 0 }; c.files++; c.bytes += e.size;
		e.issueCodes = [...(issuesByPath.get(e.path) || [])];
	}
	report.summary = { files: report.entries.length, visitedEntries: visited, bytesRead, categories, references: report.references.length,
		issues: report.issues.length, targetStatus, candidateFiles: report.entries.filter(e => e.category === "durable").length,
		candidateBytes: categories.durable?.bytes || 0, hashedFiles: report.entries.filter(e => e.sha256).length };
	report.finishedAt = new Date().toISOString();
	report.nextGate = "production-schema-and-reference-closure-validation-on-retained-copy";
	return report;
}

async function writeReport(report, output) {
	if (!path.isAbsolute(output || "")) fail("ABSOLUTE_OUTPUT_REQUIRED");
	const requested = path.resolve(output), repo = await fs.realpath(path.resolve(__dirname, ".."));
	// Check lexical containment first, then canonical containment to handle Windows short aliases.
	if (within(report.vault, requested) || within(repo, requested)) fail("OUTPUT_MUST_BE_OUTSIDE_VAULT_AND_REPOSITORY");
	await inspectAbsolute(path.dirname(requested));
	const resolved = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
	if (within(report.vault, resolved) || within(repo, resolved)) fail("OUTPUT_MUST_BE_OUTSIDE_VAULT_AND_REPOSITORY");
	await fs.writeFile(resolved, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function main(args) {
	if (args.length === 1 && args[0] === "--help") {
		console.log("node scripts/storage-inventory.cjs --vault <absolute-root> --plugin-dir <actual-vault-relative-plugin-directory> --output <new-json-outside-vault-and-repo> [--target _research] [--fingerprint]\nRead-only design preview; never copies or switches storage. Reports are private. Existing output files are never overwritten."); return;
	}
	const options = {}, keys = { "--vault": "vault", "--plugin-dir": "pluginDir", "--target": "target", "--output": "output", "--fingerprint": "fingerprint" };
	for (let i = 0; i < args.length; i++) {
		const key = Object.hasOwn(keys, args[i]) ? keys[args[i]] : null; if (!key || options[key] !== undefined) fail("INVALID_ARGUMENTS");
		if (key === "fingerprint") options[key] = true;
		else { if (!args[i + 1] || args[i + 1].startsWith("--")) fail("MISSING_ARGUMENT"); options[key] = args[++i]; }
	}
	if (!options.output) fail("OUTPUT_REQUIRED");
	const report = await inventory(options); await writeReport(report, options.output);
	console.log(JSON.stringify({ mode: report.mode, ...report.summary, output: options.output, migrationExecutable: false }));
	if (report.issues.length) process.exitCode = 2;
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error("STORAGE_INVENTORY_ERROR: " + errorCode(e)); process.exitCode = 1; });
module.exports = { inventory, writeReport, portable, inspectAbsolute };
