"use strict";
// Review regressions use production code and memory fixtures. No file cleanup or model/network calls.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const f = require("./jats-fixtures.cjs"), wiki = require("./jats-wiki-fixtures.cjs");
const { projectJats, graphicReferences } = loadReading("jats/projection.ts");
const { boundJatsWikiReader } = loadReading("jats/wiki-evidence.ts");
const { JatsIntakeService } = loadReading("jats/intake.ts");
const { loadJatsSource, verifyLoadedJatsSource, decodeJatsManifest } = loadReading("sources/jats-package.ts");
const { decodeJatsBundle } = loadReading("jats/contracts.ts");
const { openStructuredDocument } = loadReading("reading/structured-document.ts");
const { verifyJatsWikiSource } = loadReading("jats/wiki-source-guard.ts", { obsidian: wiki.obsidian });
const failures = [], checks = [];
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({ name, error: String(error) }); } }
(async () => {
	await check("root floats-group retains main figures and source links", () => {
		const x = f.fixture(), text = x.xml.toString(), figure = text.match(/<fig id="f1">[\s\S]*?<\/fig>/)[0];
		const xml = Buffer.from(text.replace(figure, "").replace("</article>", `<floats-group>${figure}</floats-group></article>`));
		assert.deepEqual(graphicReferences(xml), ["fig1.png"]);
		const projection = projectJats(xml, x.identity, [{ ref: "fig1.png", path: "images/" + "a".repeat(64) + ".png" }]);
		assert.ok(projection.blocks.some(b => b.xmlId === "f1" && b.xmlPath.includes("/floats-group[")));
		assert.ok(projection.references.every(r => projection.blocks.some(b => b.id === r.target)));
	});
	await check("display formula nested in a paragraph appears once", () => {
		const x = f.fixture(), xml = Buffer.from(x.xml.toString().replace("Input &amp; output", "Input <disp-formula><tex-math>y^7</tex-math></disp-formula> output"));
		assert.equal(projectJats(xml, x.identity, []).markdown.split("$y^7$").length - 1, 1);
	});
	await check("floating figures survive acquisition, publication and reading as one version", async () => {
		const x = f.fixture(), figure = x.xml.toString().match(/<fig id="f1">[\s\S]*?<\/fig>/)[0];
		const xml = Buffer.from(x.xml.toString().replace(figure, "").replace("</article>", `<floats-group>${figure}</floats-group></article>`));
		x.metadata.xml_url = x.metadata.xml_url.replace(/md5=[a-f0-9]+/, "md5=" + require("node:crypto").createHash("md5").update(xml).digest("hex"));
		const download = x.transport.download; x.transport.download = async (url, signal, sink, progress, policy) => {
			if (!url.endsWith(".xml")) return download(url, signal, sink, progress, policy);
			signal.throwIfAborted(); policy.budget.received += xml.length; await sink.write(xml); progress(xml.length);
		};
		const acquired = await x.acquire(), catalog = new wiki.SourceCatalog(f.storage());
		assert.equal(acquired.snapshot.artifact.converter, "rar-jats-2"); assert.equal(acquired.snapshot.validation.assetCheck, "complete");
		assert.ok(x.calls.some(url => url.endsWith("fig1.png")));
		const intake = new JatsIntakeService({ deviceId: f.sha("device"), catalog, journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
		try {
			const plan = await intake.prepare(acquired.snapshot.jobId); assert.equal((await intake.save(plan.requestId, plan.evidenceDigest, true)).phase, "saved");
			const doc = await openStructuredDocument(process.cwd(), `papers/${plan.packageKey}/article.md`, catalog.storage);
			const visual = doc.evidence.find(e => e.asset); assert.ok(visual.structured.xmlPath.includes("/floats-group["));
			const referring = doc.evidence.find(e => e.structured.xmlPath.includes("/body[") && e.relatedIds.includes(visual.id)); assert.ok(referring);
			await doc.verify(); await doc.destroy();
		} finally { await intake.dispose(); }
	});
	await check("Wiki identity digest cannot hide conflicting DOI or PMID", async () => {
		const x = await wiki.fixture(); try {
			const draft = await x.generate(), preview = await x.service.preview(draft.request.id);
			for (const edited of [preview.content.replace(x.context.source.manifest.identity.identifiers.doi, "10.9999/different"), preview.content.replace("---\n", '---\npmid: "999999"\n')]) {
				x.notes.set(preview.notePath, edited); await assert.rejects(x.service.inspect(x.key), /身份/);
			}
		} finally { await x.service.dispose(); }
	});
	await check("standalone Wiki registration also rejects conflicting identifiers", async () => {
		const x = await wiki.fixture(); try {
			const draft = await x.generate(), preview = await x.service.preview(draft.request.id);
			await verifyJatsWikiSource(x.source, preview.notePath, preview.content);
			await assert.rejects(verifyJatsWikiSource(x.source, preview.notePath, preview.content.replace(x.context.source.manifest.identity.identifiers.doi, "10.9999/different")), /身份|凭据/);
		} finally { await x.service.dispose(); }
	});
	await check("overview budgets include JSON escaping and allow follow-up block reads", async () => {
		const x = await wiki.fixture(); try {
			const xml = Buffer.from(x.acquired.content.get("article.xml").toString().replace(/<abstract>[\s\S]*?<\/abstract>/, "<abstract>" + `<p>${"*".repeat(4000)}</p>`.repeat(4) + "</abstract>"));
			const source = { ...x.context.source, projection: projectJats(xml, x.context.source.manifest.identity, []) };
			const reader = boundJatsWikiReader(source, async () => {}), signal = new AbortController().signal;
			const result = await reader.tool.execute({ mode: "overview" }, { signal }); assert.ok(result.output.length <= 23500);
			assert.ok(reader.overview() && reader.evidence().length > 0);
			const omitted = source.projection.blocks.filter(b => b.xmlPath.includes("/abstract[") && b.kind === "paragraph").at(-1);
			assert.ok(!reader.evidence().some(e => e.blockId === omitted.id));
			await reader.tool.execute({ mode: "block", blockId: omitted.id }, { signal });
			assert.ok(reader.evidence().some(e => e.blockId === omitted.id));
		} finally { await x.service.dispose(); }
	});
	await check("legacy converter keeps the exact historical projection and package", async () => {
		const x = f.fixture(), image = { ref: "fig1.png", path: "images/" + "a".repeat(64) + ".png" };
		// Frozen from the 0.51.0 projector, before these fixes.
		assert.equal(projectJats(x.xml, x.identity, [image], "rar-jats-1").projectionId, "041be7444b804d6ec5488e74c8b68d8ec07724cad1659e9f3027113407e92025");
		const fresh = await x.acquire(), snapshot = structuredClone(fresh.snapshot); delete snapshot.artifact.converter;
		assert.ok(!Object.hasOwn(decodeJatsBundle(snapshot.artifact), "converter"));
		snapshot.validation = x.provider.project(x.xml, x.identity, snapshot.artifact, fresh.content).validation;
		const acquired = { snapshot, ...await x.provider.read(snapshot) }, catalog = new wiki.SourceCatalog(f.storage());
		const intake = new JatsIntakeService({ deviceId: f.sha("device"), catalog, journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
		try {
			const plan = await intake.prepare(snapshot.jobId); assert.equal((await intake.save(plan.requestId, plan.evidenceDigest, true)).phase, "saved");
			const saved = await loadJatsSource(catalog.storage, plan.packageKey); assert.equal(saved.manifest.converter, "rar-jats-1");
			assert.equal(saved.projection.projectionId, acquired.projection.projectionId);
			const doc = await openStructuredDocument(process.cwd(), `papers/${plan.packageKey}/article.md`, catalog.storage); await doc.verify(); await doc.destroy();
			assert.throws(() => decodeJatsManifest({ ...saved.manifest, converter: "unknown" }));
			assert.throws(() => decodeJatsBundle({ ...snapshot.artifact, converter: "unknown" }));
		} finally { await intake.dispose(); }
	});
	await check("faster repeated verification still checks every file and unexpected resources", async () => {
		const x = await wiki.fixture(); try {
			const m = x.context.source.manifest; await verifyLoadedJatsSource(x.source, m);
			for (const file of m.files) {
				const path = `papers/${x.key}/${file.path}`, bytes = x.source.files.get(path); x.source.files.set(path, Buffer.from("changed"));
				await assert.rejects(verifyLoadedJatsSource(x.source, m), /修改|缺失|超限/); x.source.files.set(path, bytes);
			}
			x.source.files.set(`papers/${x.key}/images/unregistered.png`, Buffer.from("unexpected"));
			await assert.rejects(verifyLoadedJatsSource(x.source, m), /未登记/);
		} finally { await x.service.dispose(); }
	});
	await check("legacy Wiki exact PMID or PMCID is usable without a DOI", async () => {
		const x = await wiki.fixture(); try {
			const m = x.context.source.manifest, path = `wiki/sources/${m.citekey}.md`;
			for (const [key, value] of [["pmid", "PMID: " + m.identity.identifiers.pmid], ["pmcid", "PMCID: " + m.identity.identifiers.pmcid]]) {
				x.notes.set(path, `---\ntitle: ${JSON.stringify(m.identity.title)}\n${key}: ${JSON.stringify(value)}\n---\nLegacy note.`);
				assert.equal((await x.service.inspect(x.key)).existing.path, path);
			}
		} finally { await x.service.dispose(); }
	});
	if (failures.length) { console.error(JSON.stringify({ checks, failures }, null, 2)); process.exitCode = 1; }
	else console.log("FULLTEXT_REVIEW_OK: " + checks.join("; "));
})().catch(error => { console.error(error); process.exitCode = 1; });
