/* Optional live smoke test: explicitly invokes the configured models on tiny committed fixtures.
 * Keeps labelled test sessions. Never executes source code or reads a user's code project.
 * Not part of automatic/offline test runners. */
module.exports = async function codeReadingLive(app, onlyBackend) {
	const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto");
	const plugin = app.plugins.plugins["research-agent-reader"], service = plugin.getReadingWorkspace(); await service.ready();
	const report = window.__codeReadingLive = { state: "running", results: [] };
	const profile = plugin.getVerifiedProviderProfiles()[0];
	const cases = [...(profile ? [[profile.id, "main.py", profile.model]] : []), ["codex-cli", "analysis.R", plugin.settings.codexModel]].filter(([backend]) => !onlyBackend || (onlyBackend === "direct" ? backend !== "codex-cli" : backend === onlyBackend));
	const Engine = plugin.getReadingEngine().constructor;
	const engine = new Engine({ repository: service.repository, document: id => service.document(id) }, session => plugin.createReadingBackend(session));
	try {
		for (const [backend, file, model] of cases) {
			const filename = path.resolve(__dirname, "fixtures/code-reading", file);
			const hash = () => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex"); const before = hash();
			const doc = await service.loader.open("code", filename), stamp = new Date().toISOString(), id = "r-" + crypto.randomUUID(), nodeId = "r-" + crypto.randomUUID();
			const session = { version: 1, id, title: "代码后端实测 · " + model, source: doc.source, createdAt: stamp, updatedAt: stamp,
				nodes: [{ id: nodeId, parentId: null, branchId: null, question: "", title: "准备讲解", content: "", status: "pending", error: "", createdAt: stamp, evidence: [] }], branches: [], mainIds: [nodeId], outline: [], mainSummary: "", completed: false, backend, model, purpose: "test", ui: { mode: "split", split: .5, selectedId: nodeId, zoom: 1, scrollX: 0, scrollY: 0, collapsed: [], drafts: {}, windows: [] } };
			service.documents.set(id, doc); await service.repository.add(session); report.current = model;
			try {
				await engine.generate(id, nodeId); const result = service.repository.get(id), node = result.nodes[0];
				if (node.status !== "done" || !result.modulePlan?.modules.length || !node.evidence.length || before !== hash()) throw new Error("Live result or source integrity check failed");
				report.results.push({ model, session: id, status: "passed", units: result.outline.length, title: node.title, evidence: node.evidence.length,
					usage: node.usage?.map(u => ({ stage: u.stage, state: u.state, input: u.input, output: u.output })) });
			} catch (error) { report.results.push({ model, session: id, status: "failed", error: String(error) }); }
		}
		report.state = report.results.every(r => r.status === "passed") ? "passed" : "failed"; return report;
	} finally { await service.repository.flush(); }
};
module.exports.retry = async function retryCodeReadingLive(app, sessionId) {
	const plugin = app.plugins.plugins["research-agent-reader"], service = plugin.getReadingWorkspace(); await service.ready();
	const session = service.repository.get(sessionId), node = session.nodes[0];
	if (session.purpose !== "test" || !session.title.startsWith("代码后端实测 · ") || node?.status !== "failed") throw new Error("Only a failed live-test session can be retried here");
	const Engine = plugin.getReadingEngine().constructor, engine = new Engine({ repository: service.repository, document: id => service.document(id) }, s => plugin.createReadingBackend(s));
	try { await engine.generate(sessionId, node.id); return { status: "passed", model: session.model, session: sessionId, title: service.repository.get(sessionId).nodes[0].title }; }
	catch (error) { return { status: "failed", model: session.model, session: sessionId, error: String(error) }; }
};
