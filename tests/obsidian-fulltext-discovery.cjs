"use strict";
// Explicit live metadata check. Uses the existing contact configuration without logging it.
// No task, artifact, model or Wiki writes, and downloading document content is disabled.
module.exports = async function(app) {
	const assert = require("node:assert/strict"), { setTimeout, clearTimeout } = require("node:timers");
	const plugin = app.plugins.plugins["research-agent-reader"], original = plugin.getAcquisitionService().backend;
	let metadataCalls = 0; const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45000);
	const transport = { metadata: async (...args) => { metadataCalls++; return original.transport.metadata(...args); }, download: async () => { throw Error("Discovery check cannot download papers"); } };
	const backend = new original.constructor(transport, original.files, undefined, () => ({ enabled: plugin.settings.fulltextUnpaywallEnabled, email: plugin.settings.fulltextUnpaywallEmail }), original.jats.storage);
	const checks = [];
	try {
		const request = { input: { kind: "pmcid", value: "PMC10009416" }, goal: "jats", includeFigures: true, versionPolicy: "record_only" };
		const identity = await backend.resolve(request, controller.signal); assert.equal(identity.identifiers.doi, "10.1002/npr2.12307"); assert.equal(identity.identifiers.pmid, "36537061");
		checks.push("Europe PMC/Crossref map exact public identifiers");
		const candidates = await backend.discover(request, controller.signal, identity); assert.ok(candidates.length && candidates.every(c => c.jats && c.version === "version_of_record"));
		checks.push("current PMC manifests provide same-version XML/media candidates");
		const pdfs = await backend.discover({ ...request, goal: "pdf" }, controller.signal, identity); assert.ok(pdfs.some(c => c.pmc)); checks.push("current PMC manifests provide a PDF candidate");
		const oa = { input: { kind: "doi", value: "10.21105/joss.01143" }, goal: "pdf", versionPolicy: "record_only", useUnpaywall: true };
		const oaIdentity = await backend.resolve(oa, controller.signal), locations = await backend.discoverFallback(oa, controller.signal, oaIdentity);
		assert.ok(locations.some(c => c.oa)); checks.push("configured Unpaywall returns public PDF locations");
		return { ok: true, checkedAt: new Date().toISOString(), checks, metadataCalls, documentDownloads: 0, realModelCalls: 0, writes: 0,
			pmcVersions: candidates.map(c => c.jats.sourceVersionId), oaOrigins: [...new Set(locations.map(c => c.oa.origin))] };
	} catch (error) { return { ok: false, checks, metadataCalls, error: error instanceof Error ? error.message.slice(0, 500) : "Live discovery failed", documentDownloads: 0, realModelCalls: 0, writes: 0 }; }
	finally { clearTimeout(timer); }
};
