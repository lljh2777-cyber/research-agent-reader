"use strict";
// Only isolated fixtures are written; retained after the test. No cleanup or external services.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { createHash } = require("node:crypto");
const { loadReading } = require("./reading-test-helpers"), f = require("./source-intake-fixtures.cjs");
const { readPaperLibrary } = loadReading("library/reader.ts"), { readLibraryAnnotations } = loadReading("library/annotation-reader.ts");
const { FileSourceStorage } = loadReading("sources/storage.ts");
class TFile { constructor(name, size) { this.path = name; this.stat = { size }; } }
const { libraryMineruVerifier } = loadReading("library/mineru-verifier.ts", { obsidian: { TFile, normalizePath: text => text.replace(/\\/g, "/") } });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const annotationId = "annotation-00000001-0000-0000-0000-000000000000", annotationPath = "wiki/annotations/" + annotationId + ".md";
const meta = () => ({ annotation_schema: 2, id: annotationId, source: { vaultId: "former-vault", noteId: "wiki/sources/a.md", path: "wiki/sources/a.md", revision: "a".repeat(64) },
	anchor: { schemaVersion: 1, quote: { exact: "Quote", prefix: "", suffix: "" }, position: { start: 0, end: 5 }, heading: { text: "Results" } } });
const annotation = (record = meta()) => "---\n" + JSON.stringify(record) + "\n---\n# Annotation\n<!-- annotation:manual:start -->My note<!-- annotation:manual:end -->\n<!-- annotation:ai:start -->AI text<!-- annotation:ai:end -->";
const put = (storage, name, text) => { const parts = name.split("/"); for (let i = 1; i < parts.length; i++) storage.dirs.add(parts.slice(0, i).join("/")); storage.files.set(name, Buffer.from(text)); };
let checks = 0;
async function check(name, work) { await work(); checks++; console.log("PASS library compatibility: " + name); }
(async () => {
	await check("schema-2 annotations retain roles and opaque provenance without borrowing a Wiki's identity", async () => {
		const parsed = readLibraryAnnotations(annotation(), annotationPath, JSON.parse); assert.equal(parsed.errors.length, 0); assert.equal(parsed.records.length, 1);
		assert.deepEqual(parsed.records[0].roles, ["original_quote", "personal_note", "ai_explanation"]); assert.equal(parsed.records[0].provenance.vaultId, "former-vault");
		const storage = f.storage(); put(storage, annotationPath, annotation()); put(storage, "wiki/sources/a.md", '---\n{"doi":"10.1234/a"}\n---\nQuote');
		const before = [...storage.files].map(([name, bytes]) => [name, sha(bytes)]), result = await readPaperLibrary(storage, f.storage(), { vaultRoot: path.resolve("memory-vault"), parseYaml: JSON.parse });
		const item = result.papers.flatMap(paper => paper.objects).find(object => object.kind === "annotation");
		assert.deepEqual(item.identifiers, {}); assert.equal(item.binding.state, "unresolved"); assert.equal(item.binding.fingerprint, undefined);
		assert.equal(item.annotationProvenance.sourceRevision, "a".repeat(64)); assert.equal(result.papers.length, 2);
		assert.deepEqual([...storage.files].map(([name, bytes]) => [name, sha(bytes)]), before);
		const foreign = meta(); foreign.source.path = foreign.source.noteId = "Clippings/copied.md";
		put(storage, annotationPath, annotation(foreign)); put(storage, foreign.source.path, "Different text in the current Vault");
		const copied = await readPaperLibrary(storage, f.storage(), { vaultRoot: path.resolve("memory-vault"), parseYaml: JSON.parse });
		const foreignAnnotation = copied.papers.flatMap(p => p.objects).find(o => o.kind === "annotation");
		assert.equal(foreignAnnotation.binding.state, "unresolved"); assert.equal(foreignAnnotation.binding.sourceId, undefined);
	});
	await check("unsupported, mismatched, mixed and incomplete annotation formats fail visibly", async () => {
		const wrong = meta(); wrong.source.noteId = "other.md";
		for (const content of [annotation({ ...meta(), annotation_schema: 3 }), annotation(wrong), annotation().replace("<!-- annotation:ai:end -->", ""), annotation() + "<!-- agent-dashboard:annotation-start x -->", annotation().replace("<!-- annotation:manual:end -->", "<!-- annotation:manual:start -->")]) {
			const result = readLibraryAnnotations(content, annotationPath, JSON.parse); assert.equal(result.records.length, 0); assert.ok(result.errors.length);
		}
		assert.ok(readLibraryAnnotations(annotation(), "wiki/annotations/wrong.md", JSON.parse).errors.length);
		const overlap = annotation().replace("<!-- annotation:manual:end -->", "").replace("AI text", "AI text<!-- annotation:manual:end -->");
		assert.match(readLibraryAnnotations(overlap, annotationPath, JSON.parse).errors[0], /交叠/);
	});
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rar-library-mineru-")), pluginRoot = path.join(root, "plugin-fixture"); fs.mkdirSync(pluginRoot);
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), originals = new Map();
	for (const key of ["one", "two"]) {
		const packagePath = "papers/" + key, article = Buffer.from("# Demo Paper\n\n![Figure 1](images/figure.png)\n\nFigure 1. Fixture visual.\n"), mineru = Buffer.from(JSON.stringify([{ type: "title", text: "Demo Paper", page_idx: 0 }, { type: "image", img_path: "images/figure.png", img_caption: ["Figure 1. Fixture visual."], page_idx: 0 }]));
		const outputs = new Map([["article.md", article], ["mineru-result.json", mineru], ["images/figure.png", png]]);
		const manifest = { schema_version: 1, source: { path: "external.pdf", sha256: "a".repeat(64), size: 1 }, outputs: [...outputs].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) })), derived_contracts: [] };
		outputs.set("_extraction/manifest.json", Buffer.from(JSON.stringify(manifest))); outputs.set("_extraction/validation.json", Buffer.from('{"status":"passed"}'));
		for (const [name, bytes] of outputs) { const relative = packagePath + "/" + name, absolute = path.join(root, relative); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, bytes, { flag: "wx" }); originals.set(relative, sha(bytes)); }
	}
	const app = { vault: { adapter: { getBasePath: () => root, exists: async name => fs.existsSync(path.join(root, name)) }, getAbstractFileByPath(name) { const absolute = path.join(root, name); if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null; return new TFile(name, fs.statSync(absolute).size); } } };
	const vault = new FileSourceStorage(root), plugin = new FileSourceStorage(pluginRoot), options = { vaultRoot: root, parseYaml: JSON.parse };
	const selected = "papers/one/article.md";
	await check("selected legacy package uses the real full validator and meters image assets; other packages stay unverified", async () => {
		const baseline = await readPaperLibrary(vault, plugin, options), names = [];
		const scanned = await readPaperLibrary({ read: async (name, max) => { names.push(name); return vault.read(name, max); }, list: name => vault.list(name) }, plugin, { ...options, verifyMineruPath: selected, verifyMineru: libraryMineruVerifier(app) });
		const sources = scanned.papers.flatMap(p => p.objects).filter(o => o.kind === "source");
		assert.equal(sources.find(o => o.id === selected).source.verification.state, "verified", JSON.stringify(scanned.readIssues));
		assert.equal(sources.find(o => o.id.includes("/two/")).source.verification.state, "unverified");
		assert.ok(names.includes("papers/one/images/figure.png")); assert.ok(!names.includes("papers/two/images/figure.png")); assert.ok(scanned.stats.bytesRead > baseline.stats.bytesRead);
		for (const [name, hash] of originals) assert.equal(sha(fs.readFileSync(path.join(root, name))), hash);
	});
	await check("full verification shares cancellation and byte budgets, including asset reads", async () => {
		let bytesBeforeAsset, total = 0;
		const traced = storage => ({ list: name => storage.list(name), read: async (name, max) => {
			const bytes = await storage.read(name, max);
			if (name.endsWith("figure.png") && bytesBeforeAsset === undefined) bytesBeforeAsset = total;
			total += bytes?.length || 0; return bytes;
		} });
		await readPaperLibrary(traced(vault), traced(plugin), { ...options, verifyMineruPath: selected, verifyMineru: libraryMineruVerifier(app) });
		assert.ok(Number.isInteger(bytesBeforeAsset)); let budgetSawAsset = false;
		const bounded = { list: name => vault.list(name), read: async (name, max) => { if (name.endsWith("figure.png")) budgetSawAsset = true; return vault.read(name, max); } };
		await assert.rejects(readPaperLibrary(bounded, plugin, { ...options, maxBytes: bytesBeforeAsset + png.length - 1, verifyMineruPath: selected, verifyMineru: libraryMineruVerifier(app) }), /预算/);
		assert.equal(budgetSawAsset, true);
		const controller = new AbortController(); let sawAsset = false;
		const io = { list: name => vault.list(name), read: async (name, max) => { if (name.endsWith("figure.png")) { sawAsset = true; controller.abort(); } return vault.read(name, max); } };
		await assert.rejects(readPaperLibrary(io, plugin, { ...options, signal: controller.signal, verifyMineruPath: selected, verifyMineru: libraryMineruVerifier(app, controller.signal) }), /abort/i);
		assert.equal(sawAsset, true);
	});
	await check("changed image bytes cannot yield a verified package or silently use ordinary Markdown", async () => {
		const corrupt = { list: name => vault.list(name), read: async (name, max) => { const bytes = await vault.read(name, max); if (bytes && name.endsWith("figure.png")) bytes[bytes.length - 1] ^= 1; return bytes; } };
		const result = await readPaperLibrary(corrupt, plugin, { ...options, verifyMineruPath: selected, verifyMineru: libraryMineruVerifier(app) });
		const source = result.papers.flatMap(p => p.objects).find(o => o.id === selected);
		assert.equal(source.source.format, "mineru"); assert.equal(source.source.verification.state, "invalid"); assert.equal(source.capabilities.openOriginal.available, false);
		await assert.rejects(readPaperLibrary(vault, plugin, { ...options, verifyMineruPath: "../outside.md", verifyMineru: libraryMineruVerifier(app) }), /有效/);
		const missing = await readPaperLibrary(vault, plugin, { ...options, verifyMineruPath: "papers/missing/article.md", verifyMineru: libraryMineruVerifier(app) });
		assert.ok(missing.readIssues.some(i => i.path === "papers/missing/article.md"));
	});
	console.log(`LIBRARY_COMPATIBILITY_OK (${checks} scenarios; real full loader, retained isolated fixtures, no external services)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
