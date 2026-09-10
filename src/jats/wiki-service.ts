import { randomUUID } from "node:crypto";
import { parseYaml } from "obsidian";
import { objectDigest, identityRelation } from "../papers/identity";
import { canonicalTitle } from "../fulltext/identity-resolver";
import { SourceCatalog } from "../papers/catalog";
import { loadJatsSource, jatsKey } from "../sources/jats-package";
import type { SourceStorage } from "../sources/storage";
import { prepareSourceNote, type SourceNoteFields } from "../agent/tools";
import type { AgentLoopResult, AgentTool } from "../agent/types";
import type { TaskRun } from "../types/contracts";
import { boundJatsWikiReader, jatsWikiPrompt, validateJatsWikiDraft, jatsEvidenceMetadata, type JatsWikiDraft, type JatsWikiEvidence, type JatsWikiSource } from "./wiki-evidence";

interface WikiRequest { version: 1; id: string; packageKey: string; manifestDigest: string; profileId: string; notes: string; created: string; digest: string; }
interface WikiDraftRecord { version: 1; requestDigest: string; draft: JatsWikiDraft; evidence: JatsWikiEvidence[]; receipts: AgentLoopResult["toolCalls"]; overview: boolean; content: string; digest: string; }
export interface JatsWikiRecord { request: WikiRequest; draft?: WikiDraftRecord; phase: "generating" | "draft" | "saving" | "saved" | "failed" | "interrupted"; detail: string; error: string; notePath?: string; }
export interface JatsWikiDeps {
	catalog: SourceCatalog; journal: SourceStorage;
	readNote(path: string): Promise<string | null>;
	commit(citekey: string, fields: SourceNoteFields, content: string, created: string, verify: () => Promise<void>): Promise<void>;
	run(request: { profileId: string; system: string; user: string; tools: AgentTool[]; signal: AbortSignal; progress(detail: string): void }): Promise<AgentLoopResult>;
}
const requestId = (v: unknown): v is string => typeof v === "string" && /^jw-[a-f0-9-]{36}$/.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const seal = <T extends object>(value: T): T & { digest: string } => ({ ...value, digest: objectDigest(value) });
function checked<T extends { digest: string }>(value: unknown): T {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JATS Wiki 记录格式无效");
	const { digest, ...rest } = value as T;
	if (!sha(digest) || objectDigest(rest) !== digest) throw new Error("JATS Wiki 记录摘要不一致");
	return value as T;
}
function fieldsFor(source: JatsWikiSource, draft: JatsWikiDraft, evidence: JatsWikiEvidence[]): SourceNoteFields {
	const m = source.manifest;
	return { ...draft, title: m.identity.title, authors: m.identity.authors.join("; "), year: m.identity.year, doi: m.identity.identifiers.doi || "", notes: [],
		sourcePath: `papers/${m.packageKey}/article.md`, sourceKind: "jats",
		evidenceGaps: [draft.evidenceGaps, "本笔记为摘要级初读，图像、表格与完整方法尚未逐项核验。", ...source.snapshot.validation.issues].filter(Boolean).join("\n\n"),
		jatsSource: { manifestDigest: m.digest, projectionId: m.projectionId, xmlSha256: source.projection.xmlSha256, identityDigest: objectDigest(m.identity), sourceVersionId: m.sourceVersionId,
			evidence: jatsEvidenceMetadata(evidence.filter(e => draft.evidenceIds.includes(e.id))) } };
}

/** Independent source-bound drafts. All journal artifacts are create-only, including commit intent. */
export class JatsWikiService {
	private records = new Map<string, JatsWikiRecord>();
	private active = new Map<string, { id: string; controller: AbortController; promise: Promise<JatsWikiRecord> }>();
	private saving: Promise<unknown> = Promise.resolve(); private initialization?: Promise<void>; private closed = false;
	private listeners = new Set<() => void>(); readonly errors: string[] = [];
	constructor(readonly deps: JatsWikiDeps) {}
	subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
	private emit(): void { for (const fn of this.listeners) { try { fn(); } catch { /* Observer failures do not change durable state. */ } } }
	list(key?: string): JatsWikiRecord[] { return structuredClone([...this.records.values()].filter(r => !key || r.request.packageKey === key).sort((a, b) => b.request.created.localeCompare(a.request.created))); }
	get(id: string): JatsWikiRecord | undefined { const row = this.records.get(id); return row && structuredClone(row); }
	private root(key: string, id: string): string { if (!jatsKey(key) || !requestId(id)) throw new Error("JATS Wiki 请求位置无效"); return `jats-wiki/${key}/${id}`; }
	private async read<T>(root: string, name: string): Promise<T | null> { const bytes = await this.deps.journal.read(`${root}/${name}.json`, 2 * 1024 * 1024); return bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) as T : null; }
	private async write(root: string, name: string, value: unknown): Promise<void> {
		const bytes = Buffer.from(JSON.stringify(value), "utf8"); if (bytes.length > 2 * 1024 * 1024) throw new Error("JATS Wiki 记录超过大小限制");
		await this.deps.journal.create(`${root}/${name}.json`, bytes);
	}
	ready(): Promise<void> {
		return this.initialization ||= (async () => {
			for (const key of await this.deps.journal.list("jats-wiki")) {
				if (!key.directory || !jatsKey(key.name)) continue;
				for (const entry of await this.deps.journal.list("jats-wiki/" + key.name)) {
					if (!entry.directory || !requestId(entry.name)) continue;
					try {
						const root = this.root(key.name, entry.name), request = checked<WikiRequest>(await this.read(root, "request"));
						if (request.version !== 1 || request.id !== entry.name || request.packageKey !== key.name || !sha(request.manifestDigest)
							|| typeof request.profileId !== "string" || request.profileId.length > 200 || typeof request.notes !== "string" || request.notes.length > 4000 || !Number.isFinite(Date.parse(request.created))) throw new Error("请求绑定无效");
						const raw = await this.read(root, "draft"), draft = raw ? checked<WikiDraftRecord>(raw) : undefined;
						if (draft && (draft.version !== 1 || draft.requestDigest !== request.digest || !Array.isArray(draft.evidence) || draft.evidence.length > 40 || !Array.isArray(draft.receipts) || draft.receipts.length > 20 || typeof draft.content !== "string")) throw new Error("草稿与请求不一致");
						const saved = await this.read<{ requestDigest: string; draftDigest: string; contentDigest: string; notePath: string; digest: string }>(root, "saved"), failure = await this.read<{ error: string; requestDigest: string; digest: string }>(root, "failure");
						if (saved) checked(saved); if (failure) checked(failure);
						if (saved && (!draft || saved.requestDigest !== request.digest || saved.draftDigest !== draft.digest || saved.contentDigest !== objectDigest(draft.content) || !/^wiki\/sources\/[A-Za-z0-9._-]+\.md$/.test(saved.notePath))) throw new Error("保存回执与草稿不一致");
						if (failure && (failure.requestDigest !== request.digest || typeof failure.error !== "string" || failure.error.length > 1000)) throw new Error("失败记录无效");
						this.records.set(request.id, { request, draft, phase: saved ? "saved" : draft ? "draft" : failure ? "failed" : "interrupted", notePath: saved?.notePath,
							detail: saved ? "文章 Wiki 已保存，可继续登记" : draft ? "草稿已保存，可核对后继续写入" : "生成未完成；重新生成会保留本次记录", error: failure?.error || "" });
					} catch { this.errors.push("保留无法读取的 JATS Wiki 记录：" + entry.name); }
				}
			}
			this.emit();
		})();
	}
	async inspect(key: string): Promise<{ source: JatsWikiSource; existing?: { path: string; text: string }; warnings: string[] }> {
		if (this.closed) throw new Error("JATS Wiki 服务已关闭");
		const source = await loadJatsSource(this.deps.catalog.storage, key), m = source.manifest, association = await this.deps.catalog.associate(m.identity);
		if (association.paperId !== m.paperId || association.citekey !== m.citekey) throw new Error("论文目录关联已变化，请核对来源");
		const paths = new Set(association.legacy.filter(p => p.kind === "wiki").map(p => p.path));
		const canonical = `wiki/sources/${m.citekey}.md`; if (await this.deps.readNote(canonical) !== null) paths.add(canonical);
		if (paths.size > 1) throw new Error("同论文存在多个 Wiki，请先人工核对");
		const existingPath = [...paths][0]; let existing: { path: string; text: string } | undefined;
		if (existingPath) {
			if (!/^wiki\/sources\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md$/.test(existingPath)) throw new Error("既有 Wiki 路径不符合安全写入范围");
			const text = await this.deps.readNote(existingPath); if (!text) throw new Error("既有 Wiki 无法读取");
			const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text), meta = match && parseYaml(match[1]);
			if (!meta || canonicalTitle(String(meta.title || "")) !== canonicalTitle(m.identity.title)
				|| !(meta.source_identity_digest === objectDigest(m.identity) || identityRelation(m.identity.identifiers, { doi: String(meta.doi || "").replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").toLowerCase() }) === "same")) throw new Error("既有 Wiki 与当前论文身份不一致；未覆盖文件");
			existing = { path: existingPath, text };
		}
		return { source, existing, warnings: [...association.warnings, ...source.snapshot.validation.issues] };
	}
	private async verify(request: WikiRequest): Promise<JatsWikiSource> {
		const source = await loadJatsSource(this.deps.catalog.storage, request.packageKey);
		if (source.manifest.digest !== request.manifestDigest) throw new Error("原文版本已变化，请重新核对并生成草稿"); return source;
	}
	generate(key: string, expectedManifest: string, profileId: string, notes = ""): Promise<JatsWikiRecord> {
		if (this.closed) return Promise.reject(new Error("JATS Wiki 服务已关闭"));
		const running = this.active.get(key); if (running) return running.promise;
		const id = "jw-" + randomUUID(), controller = new AbortController();
		const operation = (async () => {
			await this.ready(); if (this.closed) throw new Error("JATS Wiki 服务已关闭");
			const context = await this.inspect(key), source = context.source;
			if (source.manifest.digest !== expectedManifest) throw new Error("原文与界面预览不一致，请刷新");
			if (context.existing) throw new Error("同论文 Wiki 已存在，请打开既有笔记或继续登记");
			if (!profileId || profileId.length > 200 || notes.length > 4000) throw new Error("模型或任务说明无效");
			controller.signal.throwIfAborted();
			const request = seal({ version: 1 as const, id, packageKey: key, manifestDigest: expectedManifest, profileId, notes, created: new Date().toISOString() });
			const root = this.root(key, id); await this.deps.journal.mkdir("jats-wiki"); await this.deps.journal.mkdir("jats-wiki/" + key); await this.deps.journal.mkdir(root, true); await this.write(root, "request", request);
			const row: JatsWikiRecord = { request, phase: "generating", detail: "正在读取固定 JATS 原文并生成草稿", error: "" }; this.records.set(id, row); this.emit();
			try {
				const reader = boundJatsWikiReader(source, async () => { await this.verify(request); });
				const result = await this.deps.run({ profileId, system: jatsWikiPrompt(source), user: "请整理摘要级文章 Wiki。以下任务说明不改变来源和输出边界：\n" + notes, tools: [reader.tool], signal: controller.signal,
					progress: detail => { row.detail = detail.slice(0, 500); this.emit(); } });
				controller.signal.throwIfAborted();
				if (result.status !== "completed") throw new Error(result.error || "模型未完成草稿，未创建 Wiki");
				const evidence = reader.evidence(), draft = validateJatsWikiDraft(result.final, source, evidence, reader.overview(), result.toolCalls);
				await this.verify(request); controller.signal.throwIfAborted();
				const content = prepareSourceNote(source.manifest.citekey, fieldsFor(source, draft, evidence), "", request.created.slice(0, 10)).content;
				const record = seal({ version: 1 as const, requestDigest: request.digest, draft, evidence, receipts: result.toolCalls, overview: reader.overview(), content });
				await this.write(root, "draft", record); row.draft = record; row.phase = "draft"; row.detail = "草稿已保存，请核对译名和正文后保存文章 Wiki";
			} catch (error) {
				row.phase = controller.signal.aborted ? "interrupted" : "failed"; row.error = (controller.signal.aborted ? "生成已停止，原文与已有记录保留" : error instanceof Error ? error.message : String(error)).slice(0, 1000);
				await this.write(root, "failure", seal({ requestDigest: request.digest, error: row.error })).catch(() => { row.error += "；失败状态未能写入，重载后按中断处理"; });
			}
			this.emit(); return structuredClone(row);
		})();
		this.active.set(key, { id, controller, promise: operation });
		void operation.finally(() => { this.active.delete(key); this.emit(); }).catch(() => undefined); return operation;
	}
	async preview(id: string): Promise<{ record: JatsWikiRecord; fields: SourceNoteFields; content: string; notePath: string }> {
		await this.ready(); const record = this.get(id); if (!record?.draft) throw new Error("没有可恢复的有效草稿");
		const source = await this.verify(record.request), d = record.draft;
		const draft = validateJatsWikiDraft(d.draft as unknown as Record<string, unknown>, source, d.evidence, d.overview, d.receipts);
		const fields = fieldsFor(source, draft, d.evidence), prepared = prepareSourceNote(source.manifest.citekey, fields, "", record.request.created.slice(0, 10));
		if (prepared.content !== d.content || record.notePath && record.notePath !== prepared.path) throw new Error("已保存草稿与固定原文或预览不一致");
		return { record, fields, content: prepared.content, notePath: prepared.path };
	}
	save(id: string, expectedDigest: string): Promise<JatsWikiRecord> {
		const operation = this.saving.then(async () => {
			if (this.closed) throw new Error("JATS Wiki 服务已关闭");
			const preview = await this.preview(id), row = this.records.get(id)!, request = row.request;
			if (row.draft!.digest !== expectedDigest) throw new Error("草稿与已查看的版本不一致");
			const root = this.root(request.packageKey, id), context = await this.inspect(request.packageKey);
			if (row.phase === "saved") { if (!context.existing || context.existing.path !== preview.notePath) throw new Error("已保存的 Wiki 缺失或已移动，请核对"); return structuredClone(row); }
			const intent = seal({ requestDigest: request.digest, draftDigest: expectedDigest, notePath: preview.notePath, contentDigest: objectDigest(preview.content) });
			const previous = await this.read(root, "intent"); if (previous && objectDigest(previous) !== objectDigest(intent)) throw new Error("原有写入意图与草稿不一致");
			if (context.existing && (!previous || context.existing.path !== preview.notePath || context.existing.text !== preview.content)) throw new Error("Wiki 已存在或已被编辑；不会覆盖");
			if (!previous) await this.write(root, "intent", intent);
			row.phase = "saving"; row.error = ""; this.emit();
			try {
				if (!context.existing) await this.deps.commit(context.source.manifest.citekey, preview.fields, preview.content, request.created.slice(0, 10), async () => {
					if (this.closed) throw new Error("插件已关闭，未写入 Wiki"); await this.verify(request);
					if ((await this.inspect(request.packageKey)).existing) throw new Error("保存前 Wiki 已出现，未覆盖");
				});
				if (await this.deps.readNote(preview.notePath) !== preview.content) throw new Error("Wiki 回读不一致，请检查文件");
				await this.verify(request);
				await this.write(root, "saved", intent); row.phase = "saved"; row.notePath = preview.notePath; row.detail = "文章 Wiki 已保存，可预览索引与书目登记";
			} catch (error) { row.phase = "draft"; row.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000); throw error; }
			finally { this.emit(); }
			return structuredClone(row);
		}); this.saving = operation.catch(() => undefined); return operation;
	}
	stop(id: string): boolean { const active = [...this.active.values()].find(a => a.id === id); active?.controller.abort(); return !!active; }
	taskRuns(): TaskRun[] { return this.list().map(r => ({ id: r.request.id, actionId: "jats-wiki", label: "JATS 文章 Wiki", agent: "jats-wiki-service", summary: r.request.packageKey,
		status: r.phase === "generating" || r.phase === "saving" ? "running" : r.phase === "draft" || r.phase === "saved" ? "done" : r.phase === "interrupted" ? "interrupted" : "failed",
		startedAt: r.request.created, finishedAt: "", exitCode: null, executionConfig: null,
		output: r.detail + (r.notePath ? "\n" + r.notePath : ""), error: r.error })); }
	async dispose(): Promise<void> { this.closed = true; for (const a of this.active.values()) a.controller.abort(); await Promise.allSettled([...this.active.values()].map(a => a.promise)); await this.saving; this.listeners.clear(); }
}
