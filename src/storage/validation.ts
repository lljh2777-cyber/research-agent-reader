import type { SourceStorage } from "../sources/storage";
import { readPaperRecord } from "../library/record-store";
import { validateReadingSession } from "../reading/session";
import type { ReadingSession } from "../reading/types";
import { validateAssistantRun } from "../assistant/store";
import { validatedReview } from "../curation/service";
import { validateCurationRevision } from "../curation/writer";
import type { CurationReview, CurationRevision } from "../curation/types";
import { KnowledgeDraftStore } from "../curation/draft-store";
import { validatePagePlan } from "../curation/page";
import { TopicSessionStore, type TopicHistory } from "../topic-learning/store";
import { TopicStudyStore } from "../topic-learning/study-store";
import { objectDigest } from "../papers/identity";
import { readAnswerExcerpt } from "../learning/answer-excerpts";
import { readExcerptSnapshot } from "../annotations/excerpt-library";
import type { AnswerRef } from "../learning/answer-snapshot";
import type { DraftMaterial } from "../curation/draft";

export { FileSourceStorage } from "../sources/storage";
export interface StorageCheck { key: string; kind: string; files: string[]; status: "valid" | "invalid"; normalizedInMemory?: boolean; }
export interface StorageEdge { from: string; target: string; kind: "record" | "node" | "vault" | "external-code"; nodeId?: string; planned?: boolean; }
export interface StorageAudit {
	version: 1; checks: StorageCheck[]; edges: StorageEdge[]; issues: { key: string; code: string }[];
	boundary: "candidate-records-and-answer-excerpts"; migrationExecutable: false;
	summary: { files: number; records: number; valid: number; invalid: number; edges: number; issues: number };
}
const id = "[a-f0-9-]{36}", hash = "[a-f0-9]{64}";
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Production validators over immutable bytes. No service.load(), native host, task recovery or writes. */
export async function validateStorageSnapshot(files: ReadonlyMap<string, Uint8Array>, inbound: ReadonlyMap<string, Uint8Array> = new Map()): Promise<StorageAudit> {
	const result: StorageAudit = { version: 1, checks: [], edges: [], issues: [], boundary: "candidate-records-and-answer-excerpts", migrationExecutable: false, summary: { files: files.size, records: 0, valid: 0, invalid: 0, edges: 0, issues: 0 } };
	const names = [...files.keys()].sort(), handled = new Set<string>(), owners = new Map<string, string>();
	const sessions = new Map<string, ReadingSession>(), reviews = new Map<string, CurationReview>(), revisions = new Map<string, CurationRevision>();
	const topics = new Map<string, TopicHistory>(), nodes = new Map<string, Set<string>>();
	const raw = (p: string): unknown => { const b = files.get(p); if (!b) throw Error("missing"); return JSON.parse(decode(b)); };
	const issue = (key: string, code: string) => result.issues.push({ key, code });
	const edge = (from: string, target: string, kind: StorageEdge["kind"] = "record", nodeId?: string, planned?: boolean) => { if (target) result.edges.push({ from, target, kind, ...(nodeId ? { nodeId } : {}), ...(planned ? { planned } : {}) }); };
	const vault = (from: string, p: string, planned = false) => edge(from, p, "vault", undefined, planned);
	const sessionKey = (sessionId: string) => "session:" + sessionId;
	const topicKey = (topicId: string, route: string) => `topic:${topicId}/${route}`;
	const answer = (from: string, ref: AnswerRef) => edge(from, ref.kind === "reading" ? sessionKey(ref.sessionId) : topicKey(ref.topicId, ref.route), "node", ref.nodeId);
	const material = (from: string, m: DraftMaterial | null) => {
		if (!m) return;
		vault(from, m.path);
		if (m.kind === "answer") answer(from, readAnswerExcerpt(m.raw, m.path).record.answer.ref);
		else vault(from, readExcerptSnapshot(m.raw, { annotationPath: m.path, id: m.excerptId }).record.sourcePath);
	};
	const check = async (key: string, kind: string, paths: string[], run: (c: StorageCheck) => Promise<void> | void) => {
		const c: StorageCheck = { key, kind, files: paths, status: "valid" };
		result.checks.push(c); paths.forEach(p => { handled.add(p); owners.set(p, key); });
		try { await run(c); } catch { c.status = "invalid"; issue(key, "PRODUCTION_VALIDATION_FAILED"); }
	};
	let budget = 256 * 1024 * 1024;
	const io: SourceStorage = {
		async read(p, limit = 256 * 1024) { const b = files.get(p); if (!b) return null; if (b.length > limit || (budget -= b.length) < 0) throw Error("budget"); return b.slice(); },
		async list(p) { const found = new Map<string, boolean>(); for (const n of names) if (n.startsWith(p + "/")) { const rel = n.slice(p.length + 1), first = rel.split("/")[0]; found.set(first, !!found.get(first) || rel.includes("/")); } return [...found].map(([name, directory]) => ({ name, directory })); },
		async mkdir() { throw Error("read-only audit"); }, async create() { throw Error("read-only audit"); }
	};
	const families = (pattern: RegExp) => [...new Set(names.filter(p => pattern.test(p)).map(p => p.split("/")[1]))].sort();
	for (const p of names.filter(p => new RegExp(`^(reading-sessions|code-reading-sessions)/r-${id}\\.json$`).test(p))) await check(p, "reading", [p], c => {
		const value = raw(p), s = validateReadingSession(structuredClone(value));
		if (p.split("/").pop() !== s.id + ".json" || p.startsWith("code-") && s.source.kind !== "code" || sessions.has(s.id)) throw Error("identity");
		c.normalizedInMemory = objectDigest(value) !== objectDigest(s); sessions.set(s.id, s); owners.set(sessionKey(s.id), p); nodes.set(sessionKey(s.id), new Set(s.nodes.map(n => n.id)));
		if (!(s.demo === true || s.purpose === "demo") || s.source.path !== "demo://reading") vault(p, s.source.path);
		for (const n of s.nodes) for (const e of n.evidence) edge(p, e.path, e.kind === "code" ? "external-code" : "vault");
	});
	for (const paperId of families(new RegExp(`^paper-records/p-${id}/`))) {
		const root = "paper-records/" + paperId;
		await check(root, "paper-history", names.filter(p => p.startsWith(root + "/")), async () => {
			const h = await readPaperRecord(io, paperId); if (h.errors.length || h.pending.length || !h.current) throw Error("history");
			for (const r of h.revisions) if (r.record.primaryNoteId) vault(root, r.record.primaryNoteId);
		});
	}
	for (const topicId of families(new RegExp(`^topic-learning-sessions/t-${id}/`))) {
		const root = "topic-learning-sessions/" + topicId;
		await check(root, "topic-history", names.filter(p => p.startsWith(root + "/")), async () => {
			const h = await new TopicSessionStore(io).read(topicId); if (h.errors.length || h.pending.length || !h.current) throw Error("history"); topics.set(topicId, h);
		});
	}
	for (const root of [...new Set(names.filter(p => new RegExp(`^topic-learning-dialogues/t-${id}/${hash}/`).test(p)).map(p => p.split("/").slice(0, 3).join("/")))].sort()) {
		await check(root, "topic-dialogue", names.filter(p => p.startsWith(root + "/")), async () => {
			const [, topicId, route] = root.split("/"), h = await new TopicStudyStore(io).read(topicId, route);
			if (h.errors.length || h.pending.length || !h.study) throw Error("history");
			const s = h.study, saved = topics.get(topicId)?.revisions.find(r => r.digest === s.revision);
			if (!saved || objectDigest(saved.session) !== objectDigest(s.session)) throw Error("topic version missing");
			owners.set(topicKey(topicId, route), root); nodes.set(topicKey(topicId, route), new Set(s.nodes.map(n => n.id))); edge(root, "topic-learning-sessions/" + topicId);
		});
	}
	for (const p of names.filter(p => new RegExp(`^reading-assistant-runs/a-${id}\\.json$`).test(p))) await check(p, "assistant", [p], () => {
		const r = validateAssistantRun(raw(p)); if (p.split("/").pop() !== r.id + ".json") throw Error("identity");
		edge(p, sessionKey(r.sessionId), "node", r.nodeId);
		for (const s of r.sources) vault(p, s.path);
		for (const a of r.actions) { for (const n of a.nodeIds) edge(p, sessionKey(r.sessionId), "node", n); if (a.execution?.reviewId) edge(p, `knowledge-reviews/reviews/${a.execution.reviewId}.json`); if (a.execution?.path) vault(p, a.execution.path); }
	});
	for (const p of names.filter(p => new RegExp(`^knowledge-reviews/reviews/c-${id}\\.json$`).test(p))) await check(p, "curation-review", [p], c => {
		const value = raw(p), r = validatedReview(value); if (p.split("/").pop() !== r.id + ".json") throw Error("identity");
		c.normalizedInMemory = objectDigest(value) !== objectDigest(r); reviews.set(r.id, r);
		const ctx = r.context;
		if (ctx.sessionId) { edge(p, sessionKey(ctx.sessionId)); ctx.nodeIds.forEach(n => edge(p, sessionKey(ctx.sessionId), "node", n)); }
		if (ctx.answerExcerpt) { vault(p, ctx.answerExcerpt.snapshot.path); answer(p, ctx.answerExcerpt.snapshot.record.answer.ref); }
		if (ctx.excerpt) vault(p, ctx.excerpt.snapshot.record.annotationPath);
		vault(p, ctx.source.path); vault(p, ctx.target.path); ctx.evidence.forEach(e => vault(p, e.path));
	});
	const revisionPaths = names.filter(p => new RegExp(`^knowledge-reviews/revisions/c-${id}\\.json$`).test(p));
	for (const p of revisionPaths) { try { const r = raw(p) as CurationRevision; if (p.split("/").pop() === r?.id + ".json") revisions.set(r.id, r); } catch { /* The individual check reports failure. */ } }
	for (const p of revisionPaths) await check(p, "curation-revision", [p], () => {
		const r = raw(p) as CurationRevision;
		if (p.split("/").pop() !== r?.id + ".json" || !["prepared", "applying", "applied", "recovery"].includes(r.state)) throw Error("identity/state");
		validateCurationRevision(r, reviews, revisions); edge(p, `knowledge-reviews/reviews/${r.reviewId}.json`);
		if (r.undoOf) edge(p, `knowledge-reviews/revisions/${r.undoOf}.json`);
		r.writes.forEach(w => vault(p, w.path, w.before === null));
		if (r.state !== "applied") issue(p, "UNFINISHED_CURATION_RETAINED");
	});
	const drafts = new KnowledgeDraftStore(io);
	for (const draftId of families(new RegExp(`^knowledge-drafts/d-${id}/`))) {
		const root = "knowledge-drafts/" + draftId;
		await check(root, "draft-history", names.filter(p => p.startsWith(root + "/")), async () => {
			const h = await drafts.read(draftId); if (h.issues.length || h.pending.length || !h.current) throw Error("history");
			for (const r of h.revisions) material(root, r.draft.material);
		});
	}
	for (const p of names.filter(p => new RegExp(`^knowledge-pages/d-${id}\\.json$`).test(p))) {
		const markerPath = p.slice(0, -5) + ".complete", paths = [p, ...(files.has(markerPath) ? [markerPath] : [])];
		await check(p, "page-plan", paths, async () => {
			const plan = validatePagePlan(raw(p)); if (p.split("/").pop() !== plan.draft.draft.id + ".json") throw Error("identity");
			const marker = files.get(markerPath); if (marker && decode(marker) !== objectDigest(plan)) throw Error("marker");
			const draftPath = `knowledge-drafts/${plan.draft.draft.id}/${plan.draft.digest}.json`;
			if (objectDigest(raw(draftPath)) !== objectDigest(plan.draft)) throw Error("draft mismatch");
			edge(p, draftPath); material(p, plan.draft.draft.material); plan.writes.forEach(w => vault(p, w.path, w.before === null));
			if (!marker) issue(p, "UNFINISHED_PAGE_RETAINED");
		});
	}
	for (const p of names) if (!handled.has(p)) { await check(p, "unsupported", [p], () => { throw Error("unsupported"); }); }
	for (const [p, bytes] of [...inbound].sort(([a], [b]) => a.localeCompare(b))) await check("vault:" + p, "answer-excerpt", [], () => {
		const r = readAnswerExcerpt(decode(bytes), p); answer("vault:" + p, r.record.answer.ref);
	});
	const byKey = new Map(result.checks.map(c => [c.key, c]));
	for (const e of result.edges) if (e.kind === "record" || e.kind === "node") {
		const owner = owners.get(e.target) || e.target, c = byKey.get(owner);
		if (!c || c.status !== "valid") issue(e.from, "RECORD_DEPENDENCY_UNAVAILABLE");
		else if (e.kind === "node" && !nodes.get(e.target)?.has(e.nodeId!)) issue(e.from, "ANSWER_NODE_MISSING");
	}
	// Stable, redacted output: no model responses, note bodies or exception messages in audit reports.
	result.edges = [...new Map(result.edges.map(e => [JSON.stringify(e), e])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	result.issues = [...new Map(result.issues.map(i => [JSON.stringify(i), i])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	result.checks.sort((a, b) => a.key.localeCompare(b.key));
	result.summary = { files: files.size, records: result.checks.length, valid: result.checks.filter(c => c.status === "valid").length, invalid: result.checks.filter(c => c.status === "invalid").length, edges: result.edges.length, issues: result.issues.length };
	return result;
}
