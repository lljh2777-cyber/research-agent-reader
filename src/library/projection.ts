import { decodeInput } from "../fulltext/contracts";
import { identityRelation, objectDigest, safeCitekey } from "../papers/identity";
import { readingCategory } from "../reading/catalog";
import type { ReadingSession } from "../reading/types";
import type {
	LibraryDiagnostic, LibraryDiagnosticCode, LibraryIdentifiers, LibraryObject, LibraryObjectRef,
	LibraryObjectSummary, LibraryPaper, LibraryProjection, LibraryReadingProgress,
	LibraryRecordObject, LibrarySourceCapabilities, LibrarySourceDescription,
} from "./types";

const ID_KINDS = ["doi", "pmid", "pmcid"] as const;
const ref = (item: LibraryObjectRef): LibraryObjectRef => ({ kind: item.kind, id: item.id });
const refKey = (item: LibraryObjectRef): string => JSON.stringify([item.kind, item.id]);
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const priority = { record: 0, source: 1, note: 2, session: 3, annotation: 4, acquisition: 5 };
const assignIdentifiers = (target: LibraryIdentifiers, source: LibraryIdentifiers): void => {
	for (const kind of ID_KINDS) if (source[kind] !== undefined) target[kind] = source[kind];
};

/** Adapter boundary: canonical metadata only. Damaged source files use verification.state. */
function checkObject(item: LibraryObject): void {
	if (!item || !Object.prototype.hasOwnProperty.call(priority, item.kind) || typeof item.id !== "string" || !item.id || item.id.length > 2048
		|| /[\u0000-\u001f]/.test(item.id) || typeof item.title !== "string" || !item.identifiers) throw new Error("文献聚合对象格式无效");
	for (const kind of ID_KINDS) if (item.identifiers[kind] !== undefined) decodeInput({ kind, value: item.identifiers[kind] });
	if (item.paperId !== undefined && !/^p-[a-f0-9-]{36}$/.test(item.paperId)) throw new Error("文献聚合 paperId 无效");
	if (item.citekey !== undefined && !safeCitekey(item.citekey)) throw new Error("文献聚合 citekey 无效");
	if (item.kind === "record" && (!item.paperId || item.id !== item.paperId)) throw new Error("文献记录必须使用已有 paperId");
	if (item.kind === "record" && item.readingState !== undefined && !["unmarked", "not_started", "reading", "completed", "revisit"].includes(item.readingState)) throw new Error("文献人工阅读状态无效");
	if (item.kind === "note" && (!/^[a-f0-9]{64}$/.test(item.contentHash) || item.review && (!/^[a-f0-9]{64}$/.test(item.review.reviewedHash) || !Number.isFinite(Date.parse(item.review.reviewedAt))))) throw new Error("论文笔记审阅记录缺少有效内容指纹或时间");
	if (item.kind === "session" && item.id !== item.session.id) throw new Error("阅读会话引用不一致");
}

/** No IO here. The action owner must revalidate the source immediately before opening it. */
export function librarySourceCapabilities(source: LibrarySourceDescription): LibrarySourceCapabilities {
	if (!["pdf", "mineru", "jats", "markdown", "unknown"].includes(source.format) || source.format === "unknown" && source.verification.state === "verified") throw new Error("文献来源格式无效");
	const blocked = (reason: string) => ({ available: false, reason });
	const available = () => ({ available: true, reason: "" });
	if (source.verification.state !== "verified") {
		const reason = source.verification.reason || "原文尚未通过核验";
		return { openOriginal: blocked(reason), interactiveReading: blocked(reason), pageNavigation: blocked(reason), structuredNavigation: blocked(reason) };
	}
	if (!/^[a-f0-9]{64}$/.test(source.verification.fingerprint)) throw new Error("已核验来源缺少内容指纹");
	return {
		openOriginal: available(),
		interactiveReading: source.format === "markdown" ? blocked("普通 Markdown 尚未接入交互深读") : available(),
		pageNavigation: source.format === "pdf" || source.format === "mineru" ? available() : blocked("此来源不提供 PDF 页码定位"),
		structuredNavigation: source.format === "jats" ? available() : blocked("此来源不提供 JATS 正文块定位"),
	};
}

export function libraryReadingProgress(session: ReadingSession): LibraryReadingProgress {
	const nodes = new Map(session.nodes.map(node => [node.id, node]));
	const learning: LibraryReadingProgress["learning"] = { unmarked: 0, understood: 0, revisit: 0, question: 0 };
	for (const node of session.nodes) if (node.status === "done") learning[node.learningState || "unmarked"]++;
	const marked = learning.understood + learning.revisit + learning.question;
	return {
		sessionId: session.id,
		source: { kind: session.source.kind, path: session.source.path, fingerprint: session.source.fingerprint },
		archived: Boolean(session.archived),
		explanation: { generated: session.mainIds.filter(id => nodes.get(id)?.status === "done").length, planned: session.outline.length || null, mainCompleted: session.completed },
		learning, questionCount: marked ? learning.question : null, questionScope: "marked_completed_nodes",
	};
}

function summarize(item: LibraryObject): LibraryObjectSummary {
	const result: LibraryObjectSummary = { ...ref(item), title: item.title, identifiers: { ...item.identifiers },
		...(item.paperId ? { paperId: item.paperId } : {}), ...(item.citekey ? { citekey: item.citekey } : {}) };
	if (item.kind === "source") { result.source = structuredClone(item.source); result.capabilities = librarySourceCapabilities(item.source); }
	if (item.kind === "session") result.reading = libraryReadingProgress(item.session);
	if (item.kind === "note") result.noteReview = item.review
		? { state: item.review.reviewedHash === item.contentHash ? "reviewed" : "stale", reviewedAt: item.review.reviewedAt }
		: { state: "unreviewed" };
	if (item.kind === "annotation" && item.roles) result.roles = [...item.roles];
	if (item.kind === "acquisition") result.acquisitionPhase = item.phase;
	if ((item.kind === "session" || item.kind === "annotation") && item.binding) result.binding = { ...item.binding };
	return result;
}

function diagnostic(code: LibraryDiagnosticCode, message: string, items: LibraryObject[]): LibraryDiagnostic {
	const value = { code, message, objects: items.map(ref).sort((a, b) => order(refKey(a), refKey(b))) };
	return { id: "issue-" + objectDigest(value), ...value };
}

function paper(items: LibraryObject[], conflicts: LibraryDiagnostic[], issues: Map<string, LibraryDiagnostic>): LibraryPaper {
	const sorted = [...items].sort((a, b) => order(refKey(a), refKey(b)));
	const identifiers: LibraryIdentifiers = {};
	for (const item of sorted) assignIdentifiers(identifiers, item.identifiers);
	const paperId = sorted.find(item => item.paperId)?.paperId;
	const citekey = sorted.find(item => item.citekey)?.citekey;
	const record = sorted.find((item): item is LibraryRecordObject => item.kind === "record");
	const primary = record?.primaryNoteId;
	const hasPrimary = primary && sorted.some(item => item.kind === "note" && item.id === primary);
	const diagnostics = [...conflicts];
	for (const item of sorted) if (item.kind === "source" && item.source.verification.state !== "verified") {
		diagnostics.push(diagnostic("source_unavailable", item.source.verification.reason || "原文尚未通过核验", [item]));
	}
	for (const item of sorted) if ((item.kind === "session" || item.kind === "annotation") && item.binding && item.binding.state !== "matched") diagnostics.push(diagnostic("source_binding", item.binding.reason, [item]));
	if (primary && !hasPrimary) diagnostics.push(diagnostic("primary_note_missing", "主要论文笔记尚未关联或需要重新核对", [record]));
	for (const issue of diagnostics) issues.set(issue.id, issue);
	return {
		key: "row-" + objectDigest(sorted.map(ref)),
		association: conflicts.length ? "conflict" : paperId || ID_KINDS.some(kind => identifiers[kind]) ? "identified" : "unidentified",
		...(paperId ? { paperId } : {}), ...(citekey ? { citekey } : {}),
		title: [...sorted].sort((a, b) => priority[a.kind] - priority[b.kind] || order(refKey(a), refKey(b))).find(item => item.title.trim())?.title || "未命名文献",
		identifiers, objects: sorted.map(summarize), readingState: record?.readingState || "unmarked",
		...(hasPrimary ? { primaryNoteId: primary } : {}), diagnosticIds: diagnostics.map(issue => issue.id),
	};
}

/**
 * Pure local read projection: no repositories, clocks, identity allocation or write callbacks.
 * Exact-ID indexes form candidate components. Any contradiction rejects the whole component,
 * including ambiguous bridges; its objects remain separate and retain their own metadata.
 */
export function projectLibrary(input: readonly LibraryObject[]): LibraryProjection {
	if (input.length > 10000) throw new Error("文献聚合超过 10000 个对象，请缩小范围");
	const seen = new Set<string>(), excluded: LibraryObjectRef[] = [], items: LibraryObject[] = [];
	for (const item of input) {
		checkObject(item);
		const key = refKey(item); if (seen.has(key)) throw new Error("文献聚合包含重复对象引用"); seen.add(key);
		if (item.kind === "session" && (readingCategory(item.session) !== "reading" || item.session.source.kind === "code")) excluded.push(ref(item));
		else items.push(item);
	}
	items.sort((a, b) => order(refKey(a), refKey(b)));
	const parents = items.map((_, i) => i);
	const root = (i: number): number => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
	const index = new Map<string, number>();
	items.forEach((item, i) => {
		const keys = ID_KINDS.filter(kind => item.identifiers[kind]).map(kind => JSON.stringify([kind, item.identifiers[kind]]));
		if (item.paperId) keys.push(JSON.stringify(["paperId", item.paperId]));
		for (const key of keys) { const previous = index.get(key); if (previous === undefined) index.set(key, i); else parents[root(i)] = root(previous); }
	});
	const sources = new Map(items.map((item, i) => [refKey(item), { item, i }]));
	for (let i = 0; i < items.length; i++) {
		const item = items[i]; if (item.kind !== "session" || item.binding?.state !== "matched") continue;
		const target = sources.get(refKey({ kind: "source", id: item.binding.sourceId || "" }));
		if (!target || target.item.kind !== "source" || target.item.source.verification.state !== "verified"
			|| target.item.source.verification.fingerprint !== item.session.source.fingerprint || item.binding.fingerprint !== item.session.source.fingerprint
			|| ({ pdf: "pdf", mineru: "article", jats: "structured", markdown: "markdown", unknown: "unknown" }[target.item.source.format]) !== item.session.source.kind) throw new Error("阅读会话与已核验来源绑定不一致");
		parents[root(i)] = root(target.i);
	}
	const groups = new Map<number, LibraryObject[]>();
	items.forEach((item, i) => { const key = root(i); if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(item); });
	const citekeys = new Map<string, { groups: Set<number>; items: LibraryObject[] }>();
	for (const [group, members] of groups) for (const item of members) if (item.citekey) {
		if (!citekeys.has(item.citekey)) citekeys.set(item.citekey, { groups: new Set(), items: [] });
		const entry = citekeys.get(item.citekey)!; entry.groups.add(group); entry.items.push(item);
	}
	const collisions = new Map<string, LibraryDiagnostic>();
	for (const [key, entry] of citekeys) if (entry.groups.size > 1) collisions.set(key, diagnostic("citekey_collision", "citekey 被未关联的文献使用，未按文件名合并", entry.items));
	const issues = new Map<string, LibraryDiagnostic>();
	const papers: LibraryPaper[] = [];
	for (const members of groups.values()) {
		const conflicts: LibraryDiagnostic[] = [];
		// Compare each item's jointly present IDs against the accumulated identity. This also
		// rejects disjoint conflicting IDs connected only through an existing paperId.
		const merged: LibraryIdentifiers = {};
		let identifierConflict = false;
		for (const item of members) {
			if (identityRelation(merged, item.identifiers) === "conflict" || ID_KINDS.some(kind => merged[kind] && item.identifiers[kind] && merged[kind] !== item.identifiers[kind])) identifierConflict = true;
			assignIdentifiers(merged, item.identifiers);
		}
		if (identifierConflict) conflicts.push(diagnostic("identifier_conflict", "关联记录的 DOI、PMID 或 PMCID 存在冲突，未合并", members));
		if (new Set(members.map(item => item.paperId).filter(Boolean)).size > 1) conflicts.push(diagnostic("paper_id_conflict", "精确标识关联多个 paperId，需先核对", members));
		const keys = [...new Set(members.map(item => item.citekey).filter((key): key is string => Boolean(key)))].sort(order);
		if (keys.length > 1) conflicts.push(diagnostic("citekey_conflict", "同一组精确标识关联不同 citekey，未合并", members));
		if (keys.some(key => collisions.has(key))) conflicts.push(diagnostic("citekey_collision", "本组含被其他文献使用的 citekey，需核对关联", members));
		if (conflicts.length) for (const item of members) {
			const collision = item.citekey && collisions.get(item.citekey);
			papers.push(paper([item], collision ? [...conflicts, collision] : conflicts, issues));
		}
		else papers.push(paper(members, [], issues));
	}
	return { papers: papers.sort((a, b) => order(a.key, b.key)), diagnostics: [...issues.values()].sort((a, b) => order(a.id, b.id)), excluded: excluded.sort((a, b) => order(refKey(a), refKey(b))) };
}
