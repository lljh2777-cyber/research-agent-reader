"use strict";

// Explicit ownership map from the production stores. Unknown files are never caches.
const CANDIDATES = new Set(["paper-records", "reading-sessions", "code-reading-sessions", "reading-assistant-runs", "knowledge-reviews", "knowledge-drafts", "knowledge-pages", "topic-learning-sessions", "topic-learning-dialogues"]);
const DEFERRED = new Set(["fulltext", "jats", "source-intake", "local-pdf-intake", "jats-intake", "jats-wiki", "ingest-records", "task-output", "reading-runs", "reading-test-sessions"]);
const CACHES = new Set(["retrieval-index", "learning-index"]);
const JOURNALS = new Set(["paper-records", "topic-learning-sessions", "topic-learning-dialogues", "knowledge-drafts"]);
const SAFE_ID = /^[a-z]-[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const array = value => Array.isArray(value) ? value : [];

function classify(relative) {
	const group = relative.split("/")[0];
	if (relative === "data.json") return { group, category: "mixed-private", action: "keep-local-split-design-required" };
	if (["main.js", "manifest.json", "styles.css"].includes(relative)) return { group: "plugin-code", category: "installed-code", action: "reinstall" };
	if (CANDIDATES.has(group)) return { group, category: "durable", action: "candidate-copy-after-validation" };
	if (DEFERRED.has(group)) return { group, category: "durable-deferred", action: "keep-current-location" };
	if (CACHES.has(group) && (relative === group || /^(retrieval-index|learning-index)\/bge-v1\.bin(?:\.pending)?$/.test(relative))) return { group, category: "rebuildable-cache", action: "rebuild-later" };
	return { group, category: "unknown", action: "hold-for-review" };
}

// Only known structural fields are read. Never recursively harvest prose, prompts or credentials.
function describe(group, value, relative) {
	const facts = {}, refs = [];
	const ref = (field, target, scope = "vault", planned = false) => {
		if (typeof target === "string" && target) refs.push({ field, target, scope, planned });
	};
	const session = (field, id) => { if (id) ref(field, id, "session"); };
	const source = (field, v) => {
		ref(field + ".path", v?.path);
		for (const [i, e] of array(v?.evidence).entries()) ref(`${field}.evidence[${i}].path`, e?.path);
	};
	const draft = d => {
		if (SAFE_ID.test(d?.id)) facts.draftId = d.id;
		ref("draft.material.path", d?.material?.path);
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) return { facts, refs, invalid: true };
	if (group === "plugin-code") {
		if (typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version)) facts.installedVersion = value.version;
		facts.expectedPluginId = value.id === "research-agent-reader";
		return { facts, refs, invalid: !facts.expectedPluginId || !facts.installedVersion };
	}
	for (const key of ["id", "revisionId", "paperId"]) if (typeof value[key] === "string" && SAFE_ID.test(value[key])) facts[key] = value[key];
	for (const key of ["version", "schemaVersion"]) if (Number.isSafeInteger(value[key])) facts[key] = value[key];
	if (HASH.test(value.digest)) facts.recordDigest = value.digest;
	if (typeof value.deviceId === "string") facts.hasDeviceOwner = true;
	if (group === "data.json") {
		// data.json has settings AND potentially unique question/task histories. No body or secret values leave this function.
		facts.taskRuns = array(value.taskRuns).length;
		facts.querySessions = array(value.querySessions).length;
		facts.settingsPresent = !!value.settings && typeof value.settings === "object";
		facts.toolkitConfigured = !!value.settings?.toolkitRoot;
		facts.readerMarkdownFolders = array(value.settings?.readerMarkdownFolders).filter(p => typeof p === "string" && p.length < 600 && !/[\x00-\x1f]/.test(p));
		facts.queryNotesFolder = typeof value.settings?.queryNotesFolder === "string" && /^wiki\/[\w/-]+$/.test(value.settings.queryNotesFolder) ? value.settings.queryNotesFolder : null;
		facts.unknownTopLevelFields = Object.keys(value).filter(k => !["settings", "taskRuns", "querySessions", "activeQuerySessionId", "latestLintReport"].includes(k)).length;
	} else if (["reading-sessions", "code-reading-sessions", "reading-test-sessions"].includes(group)) {
		if (value.demo === true || value.purpose === "demo") facts.purpose = "demo";
		else if (value.purpose === "test") facts.purpose = "test";
		else facts.purpose = "reading-or-legacy";
		if (facts.purpose === "demo" && value.source?.path === "demo://reading") ref("source.path", "demo://reading", "embedded-demo");
		else source("source", value.source);
		for (const [i, e] of array(value.evidence).entries()) ref(`evidence[${i}].path`, e?.path);
		facts.nodes = array(value.nodes).length;
	} else if (group === "reading-assistant-runs") {
		session("sessionId", value.sessionId);
	} else if (group === "paper-records") {
		if (SAFE_ID.test(value.record?.paperId)) facts.paperId = value.record.paperId;
		ref("record.primaryNoteId", value.record?.primaryNoteId);
	} else if (group === "knowledge-reviews") {
		if (relative.includes("/reviews/")) {
			const c = value.context;
			session("context.sessionId", c?.sessionId); source("context.source", c?.source);
			ref("context.target.path", c?.target?.path);
			ref("context.answerExcerpt.snapshot.path", c?.answerExcerpt?.snapshot?.path);
			ref("context.excerpt.snapshot.annotationPath", c?.excerpt?.snapshot?.record?.annotationPath);
			for (const [i, e] of array(c?.evidence).entries()) ref(`context.evidence[${i}].path`, e?.path);
		} else {
			if (value.reviewId) ref("reviewId", `knowledge-reviews/reviews/${value.reviewId}.json`, "plugin");
			if (value.undoOf) ref("undoOf", `knowledge-reviews/revisions/${value.undoOf}.json`, "plugin");
			for (const [i, w] of array(value.writes).entries()) ref(`writes[${i}].path`, w?.path, "vault", w?.before === null);
		}
	} else if (group === "knowledge-drafts") draft(value.draft);
	else if (group === "knowledge-pages") {
		draft(value.draft?.draft);
		if (SAFE_ID.test(value.draft?.draft?.id) && HASH.test(value.draft?.digest)) ref("draft.revision", `knowledge-drafts/${value.draft.draft.id}/${value.draft.digest}.json`, "plugin");
		for (const [i, w] of array(value.writes).entries()) ref(`writes[${i}].path`, w?.path, "vault", w?.before === null);
	} else if (group === "topic-learning-sessions") {
		if (SAFE_ID.test(value.session?.id)) facts.topicId = value.session.id;
	} else if (group === "topic-learning-dialogues") {
		const id = relative.split("/")[1];
		if (SAFE_ID.test(id)) ref("topicId", `topic-learning-sessions/${id}`, "plugin-directory");
	}
	return { facts, refs, invalid: false };
}
module.exports = { classify, describe, JOURNALS, CANDIDATES };
