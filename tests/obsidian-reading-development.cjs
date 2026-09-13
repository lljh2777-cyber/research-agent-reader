// Explicit real-model smoke test. Reading sessions and generated suggestions stay in memory.
// Bundle with esbuild (Markdown text loader, Obsidian stub) outside the repository before native eval.
// Writes one new private JSON report outside the vault/repository; never applies Wiki changes or deletes files.
const { ReadingRepository } = require("../src/reading/store.ts");
const { addReadingNode } = require("../src/reading/session.ts");
const { ReadingEngine } = require("../src/reading/engine.ts");
const { parseCurationResult } = require("../src/curation/policy.ts");
const curationSkill = require("../skills/knowledge-curation/SKILL.md");
module.exports = async function readingDevelopmentScenario(app, sessionIds, reportPath, repositoryRoot, stages = { reading: true, curation: true }) {
	if (!stages.reading && !stages.curation) throw new Error("Select at least one validation stage");
	const fs = require("node:fs/promises"); const path = require("node:path"); const assert = require("node:assert/strict");
	for (const root of [app.vault.adapter.getBasePath(), repositoryRoot]) {
		const relative = path.relative(root, path.resolve(reportPath)); if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Report must be outside vault and repository");
	}
	const memoryStorage = () => { const files = new Map(); return { list: async () => [...files.keys()], read: async id => files.get(id), write: async (id, text) => { files.set(id, text); } }; };
	const p = app.plugins.plugins["research-agent-reader"]; const live = p.getReadingWorkspace(); await live.ready();
	const hash = text => require("node:crypto").createHash("sha256").update(text).digest("hex");
	const wikiHashes = async () => Object.fromEntries(await Promise.all(app.vault.getMarkdownFiles().filter(f => f.path.startsWith("wiki/")).map(async f => [f.path, hash(await app.vault.cachedRead(f))])));
	const before = await wikiHashes(); const records = [];
	for (const sessionId of sessionIds) {
		const original = structuredClone(live.repository.get(sessionId)); const backend = p.createReadingBackend(original, false);
		const session = structuredClone(original); session.teachingStyle = "methods"; const node = addReadingNode(session, null);
		const repo = new ReadingRepository(memoryStorage()); await repo.add(session);
		const workspace = { repository: repo, document: async () => live.document(sessionId) };
		const engine = new ReadingEngine(workspace, () => backend);
		const record = { backend: backend.name, model: backend.model, source: original.source.kind };
		record.reading = { status: "skipped" }; record.curation = { status: "skipped" };
		if (stages.reading) try {
			await engine.generate(session.id, node.id); const completed = repo.get(session.id); const answer = completed.nodes.find(n => n.id === node.id);
			assert.deepEqual(completed.outline, original.outline); assert.equal(answer.status, "done"); assert.ok(answer.usage.some(e => e.stage === "answer" && e.state === "done"));
			record.reading = { status: "passed", unchangedOutline: true, title: answer.title, evidenceCount: answer.evidence.length, usage: answer.usage, content: answer.content };
		} catch (error) { record.reading = { status: "failed", error: String(error), usage: repo.get(session.id).nodes.find(n => n.id === node.id).usage }; }
		if (stages.curation) try {
			const context = await p.getCurationService().prepare(sessionId, [original.mainIds[0]], "wiki/sources/blampey_novae_2025.md");
			assert.ok(!context.warnings.some(w => w.includes("排除路径、指纹或位置不符")), "ranked passages must match raw source ranges");
			const signal = new AbortController().signal; const images = []; const document = await live.document(sessionId);
			for (const ref of context.evidence.filter(e => e.visual)) {
				const evidence = document.evidence.find(e => "V:" + e.id === ref.id); assert.ok(evidence && backend.images);
				const image = await document.image(evidence, signal); assert.ok(image); images.push({ ...image, evidenceId: ref.id });
			}
			let usage; const text = await backend.complete({ system: curationSkill, prompt: context.prompt, images, signal, maxTokens: 4500, onUsage: value => { usage = value; } });
			const suggestions = parseCurationResult(text, context);
			assert.ok(suggestions.length); assert.ok(suggestions.some(s => s.citations.some(c => c.quoteId)), "model uses exact quote IDs");
			assert.ok(suggestions.every(s => !s.warnings.some(w => /引用编号与原文位置不一致|引用无法在本轮证据中定位/.test(w))), "all cited spans resolve");
			record.curation = { status: "passed", selection: context.selection, warnings: context.warnings, usage, suggestions };
		} catch (error) { record.curation = { status: "failed", error: String(error) }; }
		assert.deepEqual(live.repository.get(sessionId), original, "live reading session unchanged"); records.push(record);
		globalThis.__readingDevelopmentProgress = records.map(r => ({ backend: r.backend, reading: r.reading.status, curation: r.curation.status }));
	}
	assert.deepEqual(await wikiHashes(), before, "Wiki contents unchanged");
	const result = { status: records.every(r => r.reading.status !== "failed" && r.curation.status !== "failed") ? "passed" : "failed", stages, records, wikiUnchanged: true, limits: "Two-session integration smoke test; does not establish scientific or retrieval accuracy." };
	await fs.writeFile(reportPath, JSON.stringify(result, null, 2), { flag: "wx", encoding: "utf8" });
	return { status: result.status, records: records.map(r => ({ backend: r.backend, source: r.source, reading: r.reading.status, curation: r.curation.status, readingError: r.reading.error, curationError: r.curation.error })), reportPath };
};
