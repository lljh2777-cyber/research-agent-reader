import { randomUUID } from "node:crypto";
import { decodeInput } from "../fulltext/contracts";
import { objectDigest, safeCitekey } from "../papers/identity";
import type { SourceStorage } from "../sources/storage";
import type { LibraryRecordObject } from "./types";

/** Location is supplied by the caller's storage root; no Vault migration or dual writes. */
export const PAPER_RECORD_DIRECTORY = "paper-records";
export type PaperRecordReader = Pick<SourceStorage, "read" | "list">;
export interface PaperRecordRevision {
	schemaVersion: 1;
	revisionId: string;
	parents: string[];
	savedAt: string;
	record: LibraryRecordObject;
	digest: string;
}
export interface PaperRecordState {
	paperId: string;
	heads: string[];
	revisions: PaperRecordRevision[];
	current?: PaperRecordRevision;
	pending: string[];
	errors: string[];
}
export interface PaperRecordStatus { paperId: string; heads: string[]; pending: string[]; blocked: boolean; }
export interface PaperRecordStore {
	read(paperId: string): Promise<PaperRecordState>;
	append(record: LibraryRecordObject, expectedHeads: readonly string[]): Promise<PaperRecordRevision>;
}
const PAPER_ID = /^p-[a-f0-9-]{36}$/;
const REVISION_ID = /^v-[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ["unmarked", "not_started", "reading", "completed", "revisit"];
const LIMIT = 32 * 1024;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const same = (a: unknown, b: unknown) => objectDigest(a) === objectDigest(b);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const recordIdentity = ({ paperId, title, identifiers, citekey }: LibraryRecordObject) => ({ paperId, title, identifiers, citekey });

export function validatePaperRecord(raw: unknown): LibraryRecordObject {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("文献人工记录格式无效");
	const record = raw as LibraryRecordObject;
	if (!exactKeys(raw as Record<string, unknown>, ["kind", "id", "paperId", "title", "identifiers", "citekey", "readingState", "primaryNoteId"])
		|| record.kind !== "record" || !PAPER_ID.test(record.paperId) || record.id !== record.paperId
		|| typeof record.title !== "string" || !record.title.trim() || record.title.length > 2000
		|| !record.identifiers || typeof record.identifiers !== "object" || Array.isArray(record.identifiers)
		|| !exactKeys(record.identifiers, ["doi", "pmid", "pmcid"]) || !STATES.includes(record.readingState || "")) throw new Error("文献人工记录字段无效");
	for (const kind of ["doi", "pmid", "pmcid"] as const) if (record.identifiers[kind] !== undefined) decodeInput({ kind, value: record.identifiers[kind] });
	if (record.citekey !== undefined && !safeCitekey(record.citekey)) throw new Error("文献人工记录 citekey 无效");
	if (record.primaryNoteId !== undefined && (typeof record.primaryNoteId !== "string" || record.primaryNoteId.length > 600
		|| !/^wiki\/sources\/[^/\\<>:"|?*\x00-\x1f]+\.md$/.test(record.primaryNoteId))) throw new Error("主要笔记必须是当前 Wiki 的论文笔记");
	return structuredClone(record);
}
function validateRevision(raw: unknown, paperId: string, revisionId: string): PaperRecordRevision {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("文献修订格式无效");
	const value = raw as PaperRecordRevision;
	if (!exactKeys(raw as Record<string, unknown>, ["schemaVersion", "revisionId", "parents", "savedAt", "record", "digest"])
		|| value.schemaVersion !== 1 || value.revisionId !== revisionId || !REVISION_ID.test(value.revisionId)
		|| !Array.isArray(value.parents) || value.parents.length > 1024 || value.parents.some(hash => typeof hash !== "string" || !HASH.test(hash))
		|| new Set(value.parents).size !== value.parents.length || !same(value.parents, [...value.parents].sort())
		|| typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt)) || !HASH.test(value.digest)) throw new Error("文献修订字段无效");
	const record = validatePaperRecord(value.record), { digest, ...payload } = value;
	if (record.paperId !== paperId || objectDigest(payload) !== digest) throw new Error("文献修订内容或所属文献不一致");
	return structuredClone(value);
}

/** Read committed revisions only. Incomplete attempts remain visible but never become state. */
export async function readPaperRecord(storage: PaperRecordReader, paperId: string): Promise<PaperRecordState> {
	if (!PAPER_ID.test(paperId)) throw new Error("文献 paperId 无效");
	const result: PaperRecordState = { paperId, heads: [], revisions: [], pending: [], errors: [] };
	const root = `${PAPER_RECORD_DIRECTORY}/${paperId}`;
	try {
		const entries = await storage.list(root), attempts = new Set<string>(), names = new Set(entries.map(entry => entry.name));
		if (entries.length > 2048) throw new Error("单篇文献修订超过读取上限");
		for (const entry of entries) {
			const match = /^(v-[a-f0-9-]{36})\.(json|ready)$/.exec(entry.name);
			if (entry.directory || !match) { result.errors.push("记录目录含未识别条目：" + entry.name); continue; }
			attempts.add(match[1]);
		}
		for (const id of [...attempts].sort()) {
			if (!names.has(id + ".ready")) { result.pending.push(id); continue; }
			try {
				const bytes = await storage.read(root + "/" + id + ".json", LIMIT), marker = await storage.read(root + "/" + id + ".ready", 64);
				if (!bytes || !marker || bytes.length > LIMIT || marker.length !== 64) throw new Error("文献提交文件或标记缺失");
				const revision = validateRevision(JSON.parse(decode(bytes)), paperId, id);
				if (decode(marker) !== revision.digest) throw new Error("文献提交标记与内容不一致");
				result.revisions.push(revision);
			} catch (error) { result.errors.push(id + "：" + errorText(error)); }
		}
		const byHash = new Map(result.revisions.map(revision => [revision.digest, revision])), children = new Set<string>();
		for (const revision of result.revisions) {
			if (revision.parents.some(parent => !byHash.has(parent) || parent === revision.digest)) result.errors.push("文献修订的前置版本缺失或自引用");
			for (const parent of revision.parents) children.add(parent);
			if (!same(recordIdentity(revision.record), recordIdentity(result.revisions[0].record))) result.errors.push("文献修订含不同的身份快照");
		}
		// Topological traversal rejects cycles without recursion, even in hand-edited journals.
		const processed = new Set<string>();
		for (;;) {
			const ready = result.revisions.filter(revision => !processed.has(revision.digest) && revision.parents.every(parent => processed.has(parent)));
			if (!ready.length) break;
			for (const revision of ready) processed.add(revision.digest);
		}
		if (processed.size !== result.revisions.length) result.errors.push("文献修订历史不完整或存在循环");
		result.heads = result.revisions.filter(revision => !children.has(revision.digest)).map(revision => revision.digest).sort();
		if (!result.errors.length && result.heads.length === 1) result.current = byHash.get(result.heads[0]);
	} catch (error) { result.errors.push(errorText(error)); }
	result.errors = [...new Set(result.errors)];
	return result;
}

export async function listPaperRecordIds(storage: PaperRecordReader): Promise<string[]> {
	const entries = await storage.list(PAPER_RECORD_DIRECTORY);
	if (entries.length > 4096 || entries.some(entry => !entry.directory || !PAPER_ID.test(entry.name))) throw new Error("文献记录目录含未识别条目或超过读取上限");
	return entries.map(entry => entry.name).sort();
}

/** Intake reuses stored identities even if the last source package is no longer present. */
export async function readPaperRecordIdentities(storage: PaperRecordReader): Promise<LibraryRecordObject[]> {
	let bytesRead = 0;
	const bounded: PaperRecordReader = { list: name => storage.list(name), async read(name, limit = LIMIT) {
		if (bytesRead >= 8 * 1024 * 1024) throw new Error("文献身份记录超过读取预算");
		const bytes = await storage.read(name, Math.min(limit, 8 * 1024 * 1024 - bytesRead));
		bytesRead += bytes?.length || 0; return bytes;
	} };
	const records: LibraryRecordObject[] = [];
	for (const id of await listPaperRecordIds(bounded)) {
		const state = await readPaperRecord(bounded, id);
		if (state.errors.length) throw new Error("文献身份记录无法核验：" + id);
		// All committed revisions have the same frozen identity, including conflicting decisions.
		if (state.revisions.length) records.push(state.revisions[0].record);
	}
	return records;
}

/** Append-only journal: no replace, delete, lock eviction, startup repair or time-based winner. */
export class JournalPaperRecordStore implements PaperRecordStore {
	constructor(private readonly storage: SourceStorage) {}
	read(paperId: string): Promise<PaperRecordState> { return readPaperRecord(this.storage, paperId); }
	async append(raw: LibraryRecordObject, expectedHeads: readonly string[]): Promise<PaperRecordRevision> {
		const record = validatePaperRecord(raw), parents = [...expectedHeads].sort();
		if (parents.length > 1024 || new Set(parents).size !== parents.length || parents.some(hash => !HASH.test(hash))) throw new Error("文献编辑版本凭据无效");
		const before = await this.read(record.paperId);
		if (before.errors.length) throw new Error("文献历史损坏，保留文件并停止保存：" + before.errors.join("；"));
		if (!same(before.heads, parents)) throw new Error("文献状态已变化，请重新读取后保存");
		if (before.revisions.some(revision => !same(recordIdentity(revision.record), recordIdentity(record)))) throw new Error("人工状态保存不能改写文献身份快照");
		if (before.current && same(before.current.record, record)) return before.current;
		if (before.revisions.length + before.pending.length >= 1024) throw new Error("单篇文献修订超过保存上限");
		const payload = { schemaVersion: 1 as const, revisionId: "v-" + randomUUID(), parents, savedAt: new Date().toISOString(), record };
		const revision: PaperRecordRevision = { ...payload, digest: objectDigest(payload) };
		const bytes = Buffer.from(JSON.stringify(revision)); if (bytes.length > LIMIT) throw new Error("文献人工记录超过保存上限");
		const root = `${PAPER_RECORD_DIRECTORY}/${record.paperId}`;
		await this.storage.mkdir(PAPER_RECORD_DIRECTORY); await this.storage.mkdir(root);
		// A competing process may commit after the first check; detect it before publishing.
		const latest = await this.read(record.paperId);
		if (latest.errors.length || !same(latest.heads, parents)) throw new Error("文献状态已变化，请重新读取后保存");
		await this.storage.create(root + "/" + revision.revisionId + ".json", bytes);
		await this.storage.create(root + "/" + revision.revisionId + ".ready", Buffer.from(revision.digest));
		const after = await this.read(record.paperId);
		if (after.errors.length || after.heads.length !== 1 || after.heads[0] !== revision.digest) throw new Error("检测到文献并发修订冲突，已保留各版本，请重新读取并选择");
		return structuredClone(revision);
	}
}
