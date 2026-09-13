import type { SourceStorage } from "../sources/storage";
import { objectDigest } from "../papers/identity";
import { DRAFT_HASH, DRAFT_ID, draftObject, validateKnowledgeDraft, type KnowledgeDraft } from "./draft";

export const KNOWLEDGE_DRAFT_ROOT = "knowledge-drafts";
const FILE_LIMIT = 4 * 1024 * 1024, READ_LIMIT = 16 * 1024 * 1024, SAVE_LIMIT = 64;
export interface DraftRevision { version: 1; parent: string | null; draft: KnowledgeDraft; digest: string; }
export interface DraftHistory { revisions: DraftRevision[]; pending: DraftRevision[]; current?: DraftRevision; issues: string[]; }
export interface DraftSummary { id: string; title: string; updated: string; revision: string; saves: number; pending: number; issues: string[]; }
export function draftRevision(draft: KnowledgeDraft, parent: string | null): DraftRevision {
	if (parent !== null && !DRAFT_HASH.test(parent)) throw new Error("草稿前置版本无效");
	const payload = { version: 1 as const, parent, draft: validateKnowledgeDraft(draft) }; return { ...payload, digest: objectDigest(payload) };
}
function validateRevision(raw: unknown, id: string, digest: string): DraftRevision {
	const v = draftObject(raw, ["version", "parent", "draft", "digest"]), revision = draftRevision(v.draft as KnowledgeDraft, v.parent as string | null);
	if (v.version !== 1 || v.digest !== digest || revision.digest !== digest || revision.draft.id !== id) throw new Error("草稿修订身份或内容不一致");
	return revision;
}
/** Create-only revisions and commit markers reuse SourceStorage. Reads never initialize directories or repair records. */
export class KnowledgeDraftStore {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly io: SourceStorage) {}
	async list(signal?: AbortSignal): Promise<{ ids: string[]; issues: string[] }> {
		signal?.throwIfAborted(); const entries = await this.io.list(KNOWLEDGE_DRAFT_ROOT); signal?.throwIfAborted();
		const good = entries.filter(e => e.directory && DRAFT_ID.test(e.name));
		return { ids: good.map(e => e.name).sort().slice(0, 100), issues: [...(entries.length !== good.length ? ["草稿目录有无法识别的条目，原文件保留。"] : []), ...(good.length > 100 ? ["只显示前 100 份草稿；可通过草稿 ID 打开其余记录。"] : [])] };
	}
	async read(id: string, signal?: AbortSignal): Promise<DraftHistory> {
		if (!DRAFT_ID.test(id)) throw new Error("草稿标识无效"); signal?.throwIfAborted();
		const out: DraftHistory = { revisions: [], pending: [], issues: [] }, root = `${KNOWLEDGE_DRAFT_ROOT}/${id}`;
		let budget = READ_LIMIT;
		try {
			const entries = await this.io.list(root); signal?.throwIfAborted();
			if (entries.length > SAVE_LIMIT * 2) throw new Error("草稿历史超过 64 次保存上限");
			const names = new Set(entries.map(e => e.name)); if (names.size !== entries.length) throw new Error("草稿目录有重复条目");
			for (const entry of entries) if (entry.directory || !/^[a-f0-9]{64}\.(json|ready)$/.test(entry.name)) out.issues.push("无法识别的草稿文件：" + entry.name);
			const digests = new Set(entries.filter(e => /^[a-f0-9]{64}\.(json|ready)$/.test(e.name)).map(e => e.name.split(".")[0]));
			for (const digest of digests) {
				signal?.throwIfAborted();
				try {
					const bytes = await this.io.read(`${root}/${digest}.json`, Math.min(FILE_LIMIT, budget)); signal?.throwIfAborted();
					if (!bytes || bytes.length > FILE_LIMIT || (budget -= bytes.length) < 0) throw new Error("草稿正文缺失或超出读取预算");
					const revision = validateRevision(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), id, digest);
					if (!names.has(digest + ".ready")) { out.pending.push(revision); continue; }
					const marker = await this.io.read(`${root}/${digest}.ready`, 64); signal?.throwIfAborted();
					if (!marker || marker.length !== 64 || new TextDecoder().decode(marker) !== digest) throw new Error("草稿提交标记不一致");
					out.revisions.push(revision);
				} catch (error) { signal?.throwIfAborted(); out.issues.push(digest + "：" + String(error)); }
			}
			const byDigest = new Map(out.revisions.map(r => [r.digest, r])), parents = new Set<string>(), done = new Set<string>();
			for (const r of [...out.revisions, ...out.pending]) if (r.parent !== null) {
				const parent = byDigest.get(r.parent);
				if (!parent || parent.draft.created !== r.draft.created || parent.draft.updated > r.draft.updated || objectDigest(parent.draft.material) !== objectDigest(r.draft.material)) out.issues.push("草稿前置版本缺失、时间或附带材料不一致");
			}
			for (const r of out.revisions) if (r.parent) parents.add(r.parent);
			for (;;) { const ready = out.revisions.filter(r => !done.has(r.digest) && (r.parent === null || done.has(r.parent))); if (!ready.length) break; ready.forEach(r => done.add(r.digest)); }
			if (done.size !== out.revisions.length) out.issues.push("草稿版本链不完整");
			const heads = out.revisions.filter(r => !parents.has(r.digest));
			if (heads.length > 1) out.issues.push("存在并发草稿版本，请查看各版本并另存为新草稿；原记录保留。");
			if (!out.issues.length && heads.length === 1) out.current = heads[0];
		} catch (error) { signal?.throwIfAborted(); out.issues.push(String(error)); }
		out.revisions.sort((a, b) => b.draft.updated.localeCompare(a.draft.updated) || a.digest.localeCompare(b.digest));
		out.pending.sort((a, b) => b.draft.updated.localeCompare(a.draft.updated) || a.digest.localeCompare(b.digest));
		out.issues = [...new Set(out.issues)].sort(); return out;
	}
	async summaries(signal?: AbortSignal): Promise<{ entries: DraftSummary[]; issues: string[] }> {
		const list = await this.list(signal), entries: DraftSummary[] = [], issues = [...list.issues]; let budget = 32 * 1024 * 1024;
		for (const id of list.ids) {
			const h = await this.read(id, signal); budget -= Buffer.byteLength(JSON.stringify(h));
			if (budget < 0) { issues.push("草稿列表超过读取预算，其余记录可按 ID 打开。"); break; }
			const r = h.current || h.pending[0] || h.revisions[0];
			entries.push({ id, title: r?.draft.title || id, updated: r?.draft.updated || "", revision: objectDigest(h), saves: h.revisions.length, pending: h.pending.length, issues: h.issues });
		}
		entries.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)); return { entries, issues };
	}
	save(input: KnowledgeDraft, expected: string | null, signal?: AbortSignal): Promise<DraftRevision> {
		const next = draftRevision(input, expected); const operation = this.queue.then(() => this.commit(next, signal)); this.queue = operation.catch(() => undefined); return operation;
	}
	resume(input: DraftRevision, signal?: AbortSignal): Promise<DraftRevision> {
		const r = validateRevision(input, input.draft.id, input.digest); return this.save(r.draft, r.parent, signal);
	}
	private async commit(next: DraftRevision, signal?: AbortSignal): Promise<DraftRevision> {
		const { draft, parent, digest } = next, root = `${KNOWLEDGE_DRAFT_ROOT}/${draft.id}`, bytes = Buffer.from(JSON.stringify(next));
		if (bytes.length > FILE_LIMIT) throw new Error("草稿记录超过 4 MiB 上限"); signal?.throwIfAborted();
		const check = (h: DraftHistory) => {
			if (h.issues.length) throw new Error("草稿历史需要核对，停止写入：" + h.issues.join("；"));
			if (h.current?.digest === digest) return;
			if ((h.current?.digest || null) !== parent) throw new Error("草稿已被其他窗口修改，请重新读取并核对；当前输入保留。");
			if (h.pending.some(r => r.digest !== digest)) throw new Error("有未完成保存，请先预览并恢复，或另存为新草稿。");
			if (h.current && (h.current.draft.created !== draft.created || h.current.draft.updated > draft.updated || objectDigest(h.current.draft.material) !== objectDigest(draft.material))) throw new Error("草稿身份或附带材料变化，请另存新草稿");
			if (!h.pending.some(r => r.digest === digest) && h.revisions.length >= SAVE_LIMIT) throw new Error("草稿已达 64 次保存上限，可另存新草稿。");
		};
		let history = await this.read(draft.id, signal); check(history); if (history.current?.digest === digest) return structuredClone(history.current);
		await this.io.mkdir(KNOWLEDGE_DRAFT_ROOT); signal?.throwIfAborted(); await this.io.mkdir(root); signal?.throwIfAborted();
		history = await this.read(draft.id, signal); check(history);
		// A failed response can leave a complete body or commit marker. Accept only these exact immutable bytes.
		const create = async (name: string, content: Uint8Array) => {
			try { await this.io.create(`${root}/${name}`, content); }
			catch (error) { const saved = await this.io.read(`${root}/${name}`, content.length); if (!saved || !Buffer.from(saved).equals(Buffer.from(content))) throw error; }
		};
		await create(digest + ".json", bytes); signal?.throwIfAborted();
		// Recheck competing commits before publishing. Later concurrent branches remain visible and block further writes.
		check(await this.read(draft.id, signal)); signal?.throwIfAborted();
		await create(digest + ".ready", Buffer.from(digest));
		const after = await this.read(draft.id);
		if (after.issues.length || after.current?.digest !== digest) throw new Error("草稿保存后发现并发或读取问题，请重读；各版本已保留。");
		return structuredClone(next);
	}
}
