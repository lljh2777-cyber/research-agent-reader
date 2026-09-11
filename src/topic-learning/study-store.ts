import { randomUUID } from "node:crypto";
import type { SourceStorage } from "../sources/storage";
import { TOPIC_HASH, TOPIC_ID, topicDigest } from "./contracts";
import { projectStudy, STUDY_COMMIT_ID, validateStudyCommit, validateStudyEvent, type TopicStudy, type TopicStudyCommit, type TopicStudyEvent } from "./study";

export const TOPIC_STUDY_DIRECTORY = "topic-learning-dialogues";
const LIMIT = 512 * 1024, MAX_COMMITS = 512;
export interface TopicStudyHistory { commits: TopicStudyCommit[]; study?: TopicStudy; errors: string[]; pending: string[]; }
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Small immutable events avoid repeatedly rewriting a growing conversation into route revisions. */
export class TopicStudyStore {
	constructor(readonly storage: SourceStorage) {}
	private root(topicId: string, route: string): string {
		if (!TOPIC_ID.test(topicId) || !TOPIC_HASH.test(route)) throw new Error("主题学习记录标识无效"); return `${TOPIC_STUDY_DIRECTORY}/${topicId}/${route}`;
	}
	async list(topicId: string): Promise<string[]> {
		if (!TOPIC_ID.test(topicId)) throw new Error("主题标识无效");
		const entries = await this.storage.list(`${TOPIC_STUDY_DIRECTORY}/${topicId}`);
		if (entries.some(e => !e.directory || !TOPIC_HASH.test(e.name))) throw new Error("主题学习目录含无法识别的记录");
		return entries.map(e => e.name).sort();
	}
	async read(topicId: string, route: string): Promise<TopicStudyHistory> {
		const root = this.root(topicId, route), h: TopicStudyHistory = { commits: [], errors: [], pending: [] };
		try {
			const entries = await this.storage.list(root); if (entries.length > MAX_COMMITS * 2) throw new Error("主题学习记录超过 512 次事件上限");
			const names = new Set(entries.map(e => e.name)), ids = new Set<string>();
			for (const entry of entries) {
				const id = entry.name.replace(/\.(json|ready)$/, "");
				if (entry.directory || !/\.(json|ready)$/.test(entry.name) || !STUDY_COMMIT_ID.test(id)) h.errors.push("无法识别的学习记录：" + entry.name); else ids.add(id);
			}
			for (const id of [...ids].sort()) {
				if (!names.has(id + ".ready")) { h.pending.push(id); continue; }
				try {
					const bytes = await this.storage.read(`${root}/${id}.json`, LIMIT), marker = await this.storage.read(`${root}/${id}.ready`, 64);
					if (!bytes || !marker || bytes.length > LIMIT || marker.length !== 64) throw new Error("提交正文或标记缺失／超限");
					const commit = validateStudyCommit(JSON.parse(decode(bytes)), id); if (decode(marker) !== commit.digest) throw new Error("提交标记与正文不一致"); h.commits.push(commit);
				} catch (e) { h.errors.push(id + "：" + String(e)); }
			}
			if (!h.commits.length || h.errors.length) return h;
			const ordered: TopicStudyCommit[] = [], children = new Map<string | null, TopicStudyCommit[]>();
			for (const c of h.commits) children.set(c.parent, [...(children.get(c.parent) || []), c]);
			if ([...children.values()].some(c => c.length !== 1)) throw new Error("主题学习存在并发版本，已保留各版本并停止写入");
			let parent: string | null = null;
			while (children.has(parent)) {
				const next: TopicStudyCommit = children.get(parent)![0]; if (ordered.some(c => c.digest === next.digest)) throw new Error("学习历史存在循环");
				if (ordered.length && ordered.slice(-1)[0]!.date > next.date) throw new Error("学习历史时间顺序无效"); ordered.push(next); parent = next.digest;
			}
			if (ordered.length !== h.commits.length) throw new Error("学习历史缺少前置事件");
			const study = projectStudy(ordered); if (study.session.id !== topicId || study.routeDigest !== route) throw new Error("学习记录所属主题或路线不一致");
			h.commits = ordered; h.study = study;
		} catch (error) { h.errors.push(String(error)); }
		return h;
	}
	async append(topicId: string, route: string, expected: string | null, event: TopicStudyEvent, signal?: AbortSignal): Promise<TopicStudyCommit> {
		const root = this.root(topicId, route); signal?.throwIfAborted();
		const before = await this.read(topicId, route); this.check(before, expected);
		if (before.commits.length + before.pending.length >= MAX_COMMITS) throw new Error("主题学习记录达到 512 次事件上限，已有内容已保留");
		const date = new Date(Math.max(Date.now(), Date.parse(before.commits.slice(-1)[0]?.date || "1970-01-01"))).toISOString();
		const payload = { version: 1 as const, id: "e-" + randomUUID(), parent: expected, date, event: validateStudyEvent(event) };
		const commit: TopicStudyCommit = { ...payload, digest: topicDigest(payload) };
		const projection = projectStudy([...before.commits, commit]);
		if (projection.session.id !== topicId || projection.routeDigest !== route) throw new Error("学习事件不能跨主题或路线保存");
		const bytes = Buffer.from(JSON.stringify(commit)); if (bytes.length > LIMIT) throw new Error("学习事件超过 512 KiB 上限");
		await this.storage.mkdir(TOPIC_STUDY_DIRECTORY); await this.storage.mkdir(`${TOPIC_STUDY_DIRECTORY}/${topicId}`); await this.storage.mkdir(root);
		this.check(await this.read(topicId, route), expected); signal?.throwIfAborted();
		await this.storage.create(`${root}/${commit.id}.json`, bytes); signal?.throwIfAborted();
		await this.storage.create(`${root}/${commit.id}.ready`, Buffer.from(commit.digest));
		const after = await this.read(topicId, route);
		if (after.errors.length || after.study?.head !== commit.digest) throw new Error("学习记录保存后检测到并发或读取问题，已保留事件，请重新读取");
		return commit;
	}
	private check(h: TopicStudyHistory, expected: string | null): void {
		if (h.errors.length) throw new Error("学习历史无法核验：" + h.errors.join("；"));
		if ((h.study?.head || null) !== expected) throw new Error("学习记录已变化，请重新读取后操作");
	}
}
