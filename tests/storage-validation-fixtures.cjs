"use strict";
// Production-generated records in memory. No external model/network calls.
const { randomUUID } = require("node:crypto"), { loadReading } = require("./reading-test-helpers");
const { readingFixture, topicFixture, mocks } = require("./answer-excerpt-fixtures.cjs");
const { KnowledgeDraftStore } = loadReading("curation/draft-store.ts", mocks);
const { newKnowledgeDraft, readDraftMaterial } = loadReading("curation/draft.ts", mocks);
const { KnowledgePages } = loadReading("curation/page.ts", mocks);
const { JournalPaperRecordStore } = loadReading("library/record-store.ts");
const { prepareAnswerExcerpt } = loadReading("learning/answer-excerpts.ts", mocks);
exports.fixture = async () => {
	const f = readingFixture(), store = f.storage, vault = new Map();
	let answer = (await f.service.save(prepareAnswerExcerpt(f.answer(), 0, 5, "PRIVATE_MEMO"))).file;
	answer = await f.service.saveHumanRevision(answer, "PRIVATE_REVISION_ONE");
	answer = await f.service.saveHumanRevision(answer, "PRIVATE_REVISION_TWO");
	f.files.get(answer.path).file.extension = "md";
	const inbound = new Map([[answer.path, Buffer.from(f.files.get(answer.path).text)]]);
	const material = await readDraftMaterial(f.app, { kind: "answer", path: answer.path, roles: ["human", "note"] });
	const drafts = new KnowledgeDraftStore(store), d = { ...newKnowledgeDraft(material), title: "Fixture concept", body: "PRIVATE_DRAFT" }, revision = await drafts.save(d, null);
	const dirs = new Set(), pageFiles = { read: async p => vault.get(p) ?? null, list: async () => [...vault.keys()], directory: async p => dirs.has(p), mkdir: async p => dirs.add(p), write: async w => vault.set(w.path, w.after) };
	const pages = new KnowledgePages(drafts, store, pageFiles), page = await pages.preview(d.id, revision.digest, "fixture-concept"); await pages.apply(page);
	const pid = "p-" + randomUUID(), record = { kind: "record", id: pid, paperId: pid, title: "Fixture paper", identifiers: {}, readingState: "reading", primaryNoteId: "wiki/sources/fixture.md" };
	const paper = await new JournalPaperRecordStore(store).append(record, []);
	const assistant = { version: 1, id: "a-" + randomUUID(), sessionId: f.session.id, nodeId: f.node.id, profileId: "mock", model: "mock", question: "PRIVATE_QUESTION", created: new Date().toISOString(), state: "done", answer: "PRIVATE_ANSWER", error: "", steps: [], sources: [], actions: [], calls: [], citations: [] };
	store.files.set(`reading-assistant-runs/${assistant.id}.json`, Buffer.from(JSON.stringify(assistant)));
	const topic = await topicFixture(); for (const [p, bytes] of topic.storage.files) store.files.set(p, bytes);
	const excerpt = await require("./excerpt-fixtures.cjs").fixture(), prepared = await excerpt.preview(true); await excerpt.writer.apply(prepared.plan); await excerpt.writer.applyUndo(await excerpt.writer.previewUndo(prepared.plan.id));
	for (const [key, record] of excerpt.records) { const [kind, id] = key.split(":"); store.files.set(`knowledge-reviews/${kind}/${id}.json`, Buffer.from(JSON.stringify(record))); }
	for (const [p, value] of excerpt.files) if (typeof value.text === "string") vault.set(p, value.text);
	vault.set(f.session.source.path, "Software fixture; source content integrity is outside this test."); vault.set("wiki/sources/fixture.md", "# Fixture");
	return { files: new Map(store.files), inbound, vault, session: f.session, node: f.node, assistant, paper, draft: revision, page, topic, prepared };
};
