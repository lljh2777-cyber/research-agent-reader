import { randomUUID } from "node:crypto";
import type { SourceStorage } from "../sources/storage";
import { TOPIC_HASH, TOPIC_ID, topicDigest, topicObject, validateTopicSession } from "./contracts";
import type { TopicSession } from "./types";

export const TOPIC_DIRECTORY = "topic-learning-sessions";
const REVISION_ID = /^v-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMIT = 128 * 1024;
export interface TopicRevision { version: 1; id: string; parent: string | null; session: TopicSession; digest: string; }
export interface TopicHistory { revisions: TopicRevision[]; current?: TopicRevision; pending: string[]; errors: string[]; }
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function validateRevision(raw: unknown, sessionId: string, revisionId: string): TopicRevision {
	const value = topicObject(raw, ["version", "id", "parent", "session", "digest"]);
	if (value.version !== 1 || value.id !== revisionId || !REVISION_ID.test(revisionId)
		|| (value.parent !== null && (typeof value.parent !== "string" || !TOPIC_HASH.test(value.parent)))
		|| typeof value.digest !== "string" || !TOPIC_HASH.test(value.digest)) throw new Error("主题学习修订格式无效");
	const session = validateTopicSession(value.session);
	const payload = { version: 1 as const, id: revisionId, parent: value.parent as string | null, session };
	if (session.id !== sessionId || topicDigest(payload) !== value.digest) throw new Error("主题学习修订所属会话或内容摘要不一致");
	return { ...payload, digest: value.digest };
}

/** Reuses fixed-root create-only IO, not paper identity/storage semantics. No startup writes. */
export class TopicSessionStore {
	constructor(private readonly storage: SourceStorage) {}
	async list(): Promise<string[]> {
		const entries = await this.storage.list(TOPIC_DIRECTORY);
		if (entries.length > 4096 || entries.some(entry => !entry.directory || !TOPIC_ID.test(entry.name))) throw new Error("主题学习目录包含无效条目或超过上限");
		return entries.map(entry => entry.name).sort();
	}
	async read(id: string): Promise<TopicHistory> {
		if (!TOPIC_ID.test(id)) throw new Error("主题会话标识无效");
		const history: TopicHistory = { revisions: [], pending: [], errors: [] }, root = `${TOPIC_DIRECTORY}/${id}`;
		try {
			const entries = await this.storage.list(root);
			if (entries.length > 256) throw new Error("主题路线历史超过 128 次保存上限");
			const names = new Set(entries.map(entry => entry.name)), attempts = new Set<string>();
			for (const entry of entries) {
				const revisionId = entry.name.replace(/\.(json|ready)$/, "");
				if (entry.directory || !/\.(json|ready)$/.test(entry.name) || !REVISION_ID.test(revisionId)) history.errors.push("无法识别的主题历史条目：" + entry.name);
				else attempts.add(revisionId);
			}
			for (const revisionId of [...attempts].sort()) {
				if (!names.has(revisionId + ".ready")) { history.pending.push(revisionId); continue; }
				try {
					const bytes = await this.storage.read(root + "/" + revisionId + ".json", LIMIT), marker = await this.storage.read(root + "/" + revisionId + ".ready", 64);
					if (!bytes || !marker || bytes.length > LIMIT || marker.length !== 64) throw new Error("主题提交正文或标记缺失／无效");
					const revision = validateRevision(JSON.parse(decode(bytes)), id, revisionId);
					if (decode(marker) !== revision.digest) throw new Error("主题提交标记不一致");
					history.revisions.push(revision);
				} catch (error) { history.errors.push(revisionId + "：" + String(error)); }
			}
			const byDigest = new Map(history.revisions.map(revision => [revision.digest, revision])), parents = new Set<string>();
			const processed = new Set<string>();
			for (const revision of history.revisions) {
				if (revision.parent === null) continue;
				parents.add(revision.parent);
				const parent = byDigest.get(revision.parent);
				if (!parent || parent.session.createdAt !== revision.session.createdAt || parent.session.updatedAt > revision.session.updatedAt) history.errors.push("主题历史前置版本缺失或时间不一致");
			}
			for (;;) {
				const ready = history.revisions.filter(revision => !processed.has(revision.digest) && (revision.parent === null || processed.has(revision.parent)));
				if (!ready.length) break;
				ready.forEach(revision => processed.add(revision.digest));
			}
			if (processed.size !== history.revisions.length) history.errors.push("主题历史不完整或存在循环");
			const heads = history.revisions.filter(revision => !parents.has(revision.digest));
			if (heads.length > 1) history.errors.push("主题历史存在并发版本，请保留历史并处理冲突");
			if (!history.errors.length && heads.length === 1) history.current = heads[0];
		} catch (error) { history.errors.push(String(error)); }
		history.errors = [...new Set(history.errors)];
		return history;
	}

	async append(raw: TopicSession, expected: string | null, signal?: AbortSignal): Promise<TopicRevision> {
		signal?.throwIfAborted();
		const session = validateTopicSession(raw);
		if (expected !== null && !TOPIC_HASH.test(expected)) throw new Error("主题编辑版本凭据无效");
		const before = await this.read(session.id);
		this.check(before, expected);
		if (before.current && (before.current.session.createdAt !== session.createdAt || before.current.session.updatedAt > session.updatedAt)) throw new Error("主题会话创建时间或更新时间不一致");
		if (before.current && topicDigest(before.current.session) === topicDigest(session)) return before.current;
		if (before.revisions.length + before.pending.length >= 128) throw new Error("主题路线历史已达 128 次保存上限，历史已保留");
		const payload = { version: 1 as const, id: "v-" + randomUUID(), parent: expected, session };
		const revision = { ...payload, digest: topicDigest(payload) }, bytes = Buffer.from(JSON.stringify(revision));
		if (bytes.length > LIMIT) throw new Error("主题会话超过保存上限");
		const root = `${TOPIC_DIRECTORY}/${session.id}`;
		await this.storage.mkdir(TOPIC_DIRECTORY); await this.storage.mkdir(root);
		this.check(await this.read(session.id), expected);
		signal?.throwIfAborted();
		await this.storage.create(root + "/" + revision.id + ".json", bytes);
		signal?.throwIfAborted();
		// Publication starts here. Cancellation after this point cannot undo a committed revision.
		await this.storage.create(root + "/" + revision.id + ".ready", Buffer.from(revision.digest));
		const after = await this.read(session.id);
		if (after.errors.length || after.current?.digest !== revision.digest) throw new Error("主题保存后检测到并发或读取问题，已保留各版本，请重新读取");
		return structuredClone(revision);
	}
	private check(history: TopicHistory, expected: string | null): void {
		if (history.errors.length) throw new Error("主题历史无法核验，停止写入：" + history.errors.join("；"));
		if ((history.current?.digest || null) !== expected) throw new Error("主题会话已变化，请重新读取后保存");
	}
}
