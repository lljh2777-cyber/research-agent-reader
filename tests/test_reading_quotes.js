"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadReading, memoryStorage } = require("./reading-test-helpers");
const { createReadingSession, addReadingBranch, addReadingNode } = loadReading("reading/session.ts");
const { ReadingRepository } = loadReading("reading/store.ts");
const { ReadingEngine } = loadReading("reading/engine.ts");
const { openCodeProject } = loadReading("code-reading/source.ts");
const { readingExportContent, readingNodeContentHash } = loadReading("reading/export.ts");

const passage = "original passage";
const missingText = "STALE_QUOTE_ONLY";
const paper = { kind: "pdf", title: "Paper", path: "unavailable.pdf", fingerprint: "a".repeat(64) };

async function fixture(change, source = paper, status = "done") {
	const session = createReadingSession(source);
	const origin = addReadingNode(session, null);
	origin.status = "done";
	origin.content = passage;
	const branch = addReadingBranch(session, origin.id);
	const quote = { nodeId: origin.id, text: passage, start: 0, end: passage.length };
	const child = addReadingNode(session, branch.id, "Why?", quote);
	child.status = status;
	child.content = "Saved answer";
	change?.(quote, child, origin);
	const storage = memoryStorage(), repo = new ReadingRepository(storage);
	const original = JSON.stringify(session);
	storage.files.set(session.id, original);
	await repo.load();
	assert.deepEqual(repo.errors, []);
	const loaded = repo.get(session.id);
	return { storage, repo, original, session: loaded, child: loaded.nodes[1], quote };
}
function missing(quote) { quote.nodeId = "missing"; quote.text = missingText; }

test("stale quote stays inspectable but is absent from the export and its node hash", async () => {
	const { session, child, quote } = await fixture(missing);
	const snapshot = structuredClone(session);
	assert.deepEqual(child.quote, quote);
	const text = readingExportContent(snapshot, "node", child.id);
	assert.ok(!text.includes(missingText), "export contains the stale quote");
	assert.equal(readingNodeContentHash(snapshot.nodes[1]), readingNodeContentHash({ ...child, quote: undefined }));
});

test("creation and loading use the same bounds and content rules", async () => {
	for (const change of [missing, q => { q.start = -passage.length; }, q => { q.end++; },
		q => { q.start = 0.5; }, q => { q.text = "changed"; }, (_q, _n, source) => { source.status = "failed"; }]) {
		const { session, child, quote } = await fixture(change);
		assert.ok(child.quoteIssue, "loaded quote has no invalidity reason: " + JSON.stringify(quote));
		assert.throws(() => addReadingNode(session, child.branchId, "Next", quote), /失效/);
	}
	const { session, child, quote } = await fixture();
	assert.equal(child.quoteIssue, undefined);
	assert.match(readingExportContent(session, "node", child.id), /引用：original passage/);
	assert.deepEqual(addReadingNode(session, child.branchId, "Next", quote).quote, quote);
});

test("the reason is derived on reload, survives snapshots and never enters saved JSON", async () => {
	const { repo, storage, original, session, child, quote } = await fixture(missing);
	assert.equal(storage.files.get(session.id), original);
	assert.ok(structuredClone(session).nodes[1].quoteIssue);
	await repo.transact(session.id, draft => { draft.title = "Renamed"; });
	const saved = JSON.parse(storage.files.get(session.id)).nodes[1];
	assert.deepEqual(saved.quote, quote);
	assert.equal(Object.hasOwn(saved, "quoteIssue"), false);
	const reloaded = new ReadingRepository(storage);
	await reloaded.load();
	assert.ok(reloaded.get(session.id).nodes[1].quoteIssue);
	await reloaded.transact(session.id, draft => {
		draft.nodes[1].quote = { nodeId: draft.nodes[0].id, start: 0, end: passage.length, text: passage };
	});
	assert.equal(reloaded.get(session.id).nodes[1].quoteIssue, undefined);
	assert.match(readingExportContent(reloaded.get(session.id), "node", child.id), /引用：original passage/);
	const recovered = await fixture(missing, paper, "pending");
	const afterInterrupt = JSON.parse(recovered.storage.files.get(recovered.session.id)).nodes[1];
	assert.equal(afterInterrupt.status, "interrupted");
	assert.deepEqual(afterInterrupt.quote, recovered.quote);
	assert.equal(Object.hasOwn(afterInterrupt, "quoteIssue"), false);
	const copyStorage = memoryStorage();
	const copied = new ReadingRepository(copyStorage);
	await copied.add(session);
	assert.ok(copied.get(session.id).nodes[1].quoteIssue);
	assert.equal(Object.hasOwn(JSON.parse(copyStorage.files.get(session.id)).nodes[1], "quoteIssue"), false);
});

for (const valid of [false, true]) test("evidence selection and answer generation receive " + (valid ? "the valid quote" : "no stale quote"), async () => {
	const bytes = Buffer.from("print(3)\n");
	const doc = await openCodeProject(path.resolve("demo.py"), { stat: async () => ({ file: true, size: bytes.length }),
		realpath: async p => p, list: async () => [], read: async () => bytes });
	const { repo, session, child } = await fixture(valid ? undefined : missing, doc.source, "failed");
	const prompts = [], evidenceId = doc.evidence[0].id;
	const backend = { name: "local test", model: "mock", images: false, complete: async request => {
		const input = JSON.parse(request.prompt);
		prompts.push(input);
		return JSON.stringify(input.action === "追问" ? { ids: [evidenceId], query: "print" }
			: { title: "Result", content: "答案。[" + evidenceId + "]", evidenceIds: [evidenceId] });
	} };
	const engine = new ReadingEngine({ repository: repo, document: async () => doc }, () => backend);
	await engine.generate(session.id, child.id);
	assert.deepEqual(prompts.map(p => p.action), ["追问", "回答支线追问"]);
	for (const prompt of prompts) {
		if (valid) assert.equal(prompt.quote, passage);
		else {
			assert.equal(Object.hasOwn(prompt, "quote"), false, prompt.action + " received the stale quote");
			assert.ok(!JSON.stringify(prompt).includes(missingText));
		}
	}
});

test("the answer view labels stale text and keeps valid text as a quotation", async t => {
	const elements = [];
	function element(tag) {
		const item = { tag, dataset: {}, children: [], appendChild(child) { this.children.push(child); }, setAttribute() {} };
		elements.push(item);
		return item;
	}
	const originalDocument = global.document;
	global.document = { createElement: element };
	t.after(() => { global.document = originalDocument; });
	class Base {}
	const obsidian = { ItemView: Base, Modal: Base, Component: Base, SuggestModal: Base, FuzzySuggestModal: Base, setIcon() {},
		MarkdownRenderer: { render: async () => {} } };
	const { ReadingWorkspaceView } = loadReading("views/reading-workspace.ts", { obsidian, electron: {} });
	for (const valid of [false, true]) {
		const { repo, session, child } = await fixture(valid ? undefined : missing);
		const view = Object.create(ReadingWorkspaceView.prototype);
		view.sessionId = session.id;
		view.service = { repository: repo };
		view.renderCitations = () => {};
		elements.length = 0;
		view.renderAnswer(element("div"), child);
		const warning = elements.find(e => e.tag === "summary" && e.textContent.includes("失效"));
		const quotedText = elements.find(e => e.tag === "blockquote" && e.textContent === (valid ? passage : missingText));
		assert.ok(quotedText);
		if (valid) assert.equal(warning, undefined);
		else {
			assert.ok(warning?.textContent.includes("来源节点不存在"));
			assert.ok(elements.some(e => e.tag === "details" && e.children.includes(warning) && e.children.includes(quotedText)));
		}
	}
});
