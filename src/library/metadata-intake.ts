import { decodeIdentity, parseAcquisitionInput } from "../fulltext/contracts";
import type { IdentityResolver } from "../fulltext/identity-resolver";
import type { SourceCatalog, CatalogPlan } from "../papers/catalog";
import type { ResolvedIdentity } from "../papers/identity";
import type { PaperRecordStore } from "./record-store";
import type { SourcePackageManifest } from "../sources/package";
import { objectDigest } from "../papers/identity";
import { randomUUID } from "node:crypto";
import { manualPaperFields, type ManualPaperInput } from "./manual-record";
import type { LibraryRecordObject, LibraryObjectSummary } from "./types";

export interface MetadataPreview {
	identity: ResolvedIdentity;
	existing: boolean;
	warnings: string[];
	sources: MetadataSource[];
}
export interface MetadataSaved { paperId: string; reused: boolean; }
export interface ManualMetadataPreview { title: string; manualBibliography: NonNullable<LibraryRecordObject["manualBibliography"]>; }
export interface MetadataSource { packageKey: string; paperId: string; path: string; label: string; manifestDigest: string; }
export interface PaperIntakeContext { identity: ResolvedIdentity; paperId: string; }
const sourceView = (m: SourcePackageManifest): MetadataSource => ({ packageKey: m.packageKey, paperId: m.paperId,
	path: `papers/${m.packageKey}/${m.packageKind === "pdf-source" ? "source.pdf" : "article.md"}`, manifestDigest: m.digest,
	label: `${m.packageKind === "pdf-source" ? m.schemaVersion === 2 ? "本地 PDF" : "在线 PDF" : "JATS"} · ${m.version === "unknown" ? "版本未核验" : (m.packageKind === "pdf-source" && m.schemaVersion === 2 ? "用户声明的" : "") + (m.version === "version_of_record" ? "出版版本" : "作者接受稿")} · ${m.packageKind === "pdf-source" && m.schemaVersion === 2 ? "保存于 " + m.createdAt.slice(0, 10) : m.sourceVersionId}` });

/** Read-only preview followed by explicit, serialized create. No acquisition job or model. */
export class MetadataIntakeService {
	private previews = new WeakMap<MetadataPreview, { identity: ResolvedIdentity; plan: CatalogPlan }>();
	private manualPreviews = new WeakMap<ManualMetadataPreview, LibraryRecordObject>();
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	constructor(private readonly resolver: Pick<IdentityResolver, "resolve">, private readonly catalog: SourceCatalog, private readonly store: PaperRecordStore) {}
	private available(signal: AbortSignal): void { signal.throwIfAborted(); if (this.closed) throw new Error("插件已关闭，文献信息操作已停止"); }
	prepareManual(input: ManualPaperInput): ManualMetadataPreview {
		if (this.closed) throw new Error("插件已关闭，手工登记已停止");
		const fields = manualPaperFields(input), paperId = "p-" + randomUUID();
		const preview = { title: fields.title, manualBibliography: fields.manualBibliography! };
		this.manualPreviews.set(preview, { kind: "record", id: paperId, paperId, identifiers: {}, readingState: "unmarked", ...structuredClone(fields) });
		return preview;
	}
	saveManual(preview: ManualMetadataPreview, signal: AbortSignal): Promise<MetadataSaved> {
		const record = this.manualPreviews.get(preview);
		if (!record) return Promise.reject(new Error("手工预览已失效，请重新核对"));
		const operation = this.queue.then(async () => {
			this.available(signal); const state = await this.store.read(record.paperId); this.available(signal);
			if (state.errors.length || state.heads.length > 1) throw new Error("手工记录无法唯一核验，保留历史并停止保存");
			if (state.revisions.length) {
				if (!state.current || objectDigest(state.current.record) !== objectDigest(record)) throw new Error("手工记录已变化，请在文献库核对");
				return { paperId: record.paperId, reused: true };
			}
			await this.store.append(structuredClone(record), []);
			return { paperId: record.paperId, reused: false };
		});
		this.queue = operation.catch(() => undefined); return operation;
	}
	async manualReference(expected: LibraryObjectSummary, signal: AbortSignal): Promise<{ title: string; reference: string }> {
		const item = structuredClone(expected); this.available(signal);
		if (item.kind !== "record" || !item.paperId || !item.manualBibliography) throw new Error("请选择已保存的人工条目");
		const state = await this.store.read(item.paperId); this.available(signal);
		if (state.errors.length || !state.current?.record.manualBibliography || state.heads.length !== 1 || state.current.record.title !== item.title
			|| objectDigest(state.current.record.manualBibliography) !== objectDigest(item.manualBibliography)) throw new Error("人工条目已变化或无法核验，请刷新后重选");
		return { title: state.current.record.title, reference: state.current.record.manualBibliography!.reference };
	}
	async prepare(raw: string, signal: AbortSignal): Promise<MetadataPreview> {
		this.available(signal);
		const input = parseAcquisitionInput(raw);
		const resolved = await this.resolver.resolve(input, signal);
		this.available(signal);
		if (!resolved) throw new Error("未找到可核对的书目信息，请检查标识后重新查询");
		const identity = decodeIdentity(resolved);
		if (identity.identifiers[input.kind] !== input.value) throw new Error("查询结果与输入标识不一致，未保存");
		const plan = await this.catalog.associate(identity); this.available(signal);
		const preview = { identity: structuredClone(identity), existing: Boolean(plan.existingPaperId), warnings: [...plan.warnings], sources: plan.packages.map(sourceView) };
		this.previews.set(preview, { identity, plan }); return preview;
	}
	save(preview: MetadataPreview, signal: AbortSignal): Promise<MetadataSaved> {
		const prepared = this.previews.get(preview);
		if (!prepared) return Promise.reject(new Error("查询预览已失效，请重新查询"));
		const operation = this.queue.then(async () => {
			this.available(signal);
			// Repeat exact-ID association to observe records saved since the preview.
			const latest = await this.catalog.associate(prepared.identity); this.available(signal);
			const paperId = latest.existingPaperId || prepared.plan.paperId;
			if (prepared.plan.existingPaperId && latest.existingPaperId !== prepared.plan.existingPaperId) throw new Error("关联文献已变化，请重新查询核对");
			const state = await this.store.read(paperId); this.available(signal);
			if (state.errors.length) throw new Error("文献记录无法核验：" + state.errors.join("；"));
			// A committed record owns its metadata and human decisions, including conflicts.
			if (state.revisions.length) return { paperId, reused: true };
			const bibliography = structuredClone(prepared.identity);
			await this.store.append({ kind: "record", id: paperId, paperId, title: bibliography.title,
				identifiers: { ...bibliography.identifiers }, bibliography, citekey: latest.citekey, readingState: "unmarked" }, []);
			// Other devices/services do not share this queue. Retain competing records and
			// expose association conflicts instead of silently merging their identities.
			const published = await this.catalog.associate(bibliography);
			if (published.existingPaperId !== paperId) throw new Error("书目信息已提交，但文献关联已变化，请重新核对");
			return { paperId, reused: false };
		});
		this.queue = operation.catch(() => undefined); return operation;
	}
	/** Read the persisted bibliography again; preparing a continuation never writes a record. */
	async savedContext(context: PaperIntakeContext, signal: AbortSignal): Promise<PaperIntakeContext> {
		const expected = structuredClone(context); this.available(signal);
		const state = await this.store.read(expected.paperId); this.available(signal);
		if (state.errors.length || !state.current?.record.bibliography || state.heads.length !== 1) throw new Error("已保存书目信息无法唯一核验，请重新核对记录");
		const identity = decodeIdentity(state.current.record.bibliography);
		if (objectDigest(identity) !== objectDigest(expected.identity)) throw new Error("已保存书目信息发生变化，请刷新文献库");
		const plan = await this.catalog.associate(identity); this.available(signal);
		if (plan.existingPaperId !== expected.paperId) throw new Error("文献关联已变化，请重新核对");
		return { identity, paperId: expected.paperId };
	}
	/** Recheck the private query result, never trust mutated UI metadata or a guessed paperId. */
	async context(preview: MetadataPreview, signal: AbortSignal, savedPaperId?: string): Promise<PaperIntakeContext> {
		this.available(signal); const prepared = this.previews.get(preview);
		if (!prepared) throw new Error("查询预览已失效，请重新查询");
		const latest = await this.catalog.associate(prepared.identity); this.available(signal);
		if (!latest.existingPaperId) throw new Error("请先保存书目信息后继续");
		if (savedPaperId && latest.existingPaperId !== savedPaperId || prepared.plan.existingPaperId && latest.existingPaperId !== prepared.plan.existingPaperId) throw new Error("文献关联已变化，请重新查询核对");
		return { identity: structuredClone(prepared.identity), paperId: latest.existingPaperId };
	}
	async source(preview: MetadataPreview, packageKey: string, signal: AbortSignal): Promise<MetadataSource> {
		this.available(signal); const prepared = this.previews.get(preview), original = prepared?.plan.packages.find(p => p.packageKey === packageKey);
		if (!prepared || !original) throw new Error("所选来源不属于本次查询预览");
		const latest = await this.catalog.associate(prepared.identity); this.available(signal);
		const current = latest.packages.find(p => p.packageKey === packageKey);
		if (!current || current.digest !== original.digest || latest.existingPaperId !== original.paperId) throw new Error("原文或文献关联已变化，请重新查询");
		return sourceView(current);
	}
	async dispose(): Promise<void> { this.closed = true; await this.queue; }
}
