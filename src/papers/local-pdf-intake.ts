import * as path from "node:path";
import { decodeIdentity, parseAcquisitionInput } from "../fulltext/contracts";
import type { IdentityResolver } from "../fulltext/identity-resolver";
import type { PdfLoader } from "../fulltext/file-validator";
import { decodeLocalPdfSnapshot, type LocalPdfSnapshot } from "../sources/pdf-snapshot";
import { canonicalJson, objectDigest, type ResolvedIdentity } from "./identity";
import { prepareLocalPdf, rereadLocalPdf, type readLocalPdfFile } from "./local-pdf";
import { SourceIntakeService, type SourceIntakeDeps, type SourceSavePlan } from "./source-intake";

interface LocalOperation { schemaVersion: 1; deviceId: string; path: string; snapshot: LocalPdfSnapshot; }
interface Completion { schemaVersion: 1; operationDigest: string; packageKey: string; paperId: string; }
export interface LocalPdfHistory { id: string; title: string; fileName: string; createdAt: string; state: "pending" | "saved" | "unavailable"; error: string; }
export interface LocalPdfIntakeDeps extends Omit<SourceIntakeDeps, "readSource"> {
	resolver: Pick<IdentityResolver, "resolve">;
	read?: typeof readLocalPdfFile;
	pdfLoader?: PdfLoader;
}
const root = "local-pdf-intake", idPattern = /^s-[a-f0-9-]{36}$/;
const encode = (value: unknown) => Buffer.from(canonicalJson(value), "utf8");
const exact = (raw: unknown, keys: string[]) => raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === keys.length && Object.keys(raw).every(k => keys.includes(k));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Device-bound, create-only local operation records. No PDF copy or journal write until Save. */
export class LocalPdfIntakeService {
	private source: SourceIntakeService;
	private entries = new Map<string, { operation: LocalOperation; path: string; controller: AbortController; plan?: SourceSavePlan; digest?: string; closing?: boolean }>();
	private requests = new Set<AbortController>();
	private saving = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	constructor(private readonly deps: LocalPdfIntakeDeps) {
		this.source = new SourceIntakeService({ ...deps, readSource: async id => {
			const entry = this.entries.get(id); if (!entry) throw new Error("本地 PDF 选择已关闭");
			return rereadLocalPdf(entry.path, entry.operation.snapshot, entry.controller.signal, deps.read);
		} });
	}
	private available(signal?: AbortSignal): void { signal?.throwIfAborted(); if (this.closed) throw new Error("插件已关闭，本地 PDF 操作已停止"); }
	private decode(raw: unknown, id: string): LocalOperation {
		const r = raw as LocalOperation;
		if (!idPattern.test(id) || !exact(r, ["schemaVersion", "deviceId", "path", "snapshot"]) || r.schemaVersion !== 1
			|| r.deviceId !== this.deps.deviceId || typeof r.path !== "string" || r.path.length > 4096 || /[\x00-\x1f]/.test(r.path)
			|| !path.isAbsolute(r.path) || path.extname(r.path).toLowerCase() !== ".pdf") throw new Error("记录损坏或属于另一设备，未接管");
		const snapshot = decodeLocalPdfSnapshot(r.snapshot);
		if (snapshot.id !== id || snapshot.origin.fileName !== path.basename(r.path)) throw new Error("本地记录与文件快照不一致");
		return { ...r, snapshot };
	}
	private async readOperation(id: string): Promise<LocalOperation> {
		if (!idPattern.test(id)) throw new Error("本地记录标识无效");
		const bytes = await this.deps.journal.read(`${root}/${id}.json`);
		if (!bytes) throw new Error("本地 PDF 添加记录不存在");
		return this.decode(JSON.parse(Buffer.from(bytes).toString("utf8")), id);
	}
	private completion(raw: unknown, operation: LocalOperation): Completion {
		const c = raw as Completion;
		if (!exact(c, ["schemaVersion", "operationDigest", "packageKey", "paperId"]) || c.schemaVersion !== 1 || c.operationDigest !== objectDigest(operation)
			|| typeof c.packageKey !== "string" || !/^[a-z0-9_-]+--pdf--[a-f0-9]{24,64}$/.test(c.packageKey) || !/^p-[a-f0-9-]{36}$/.test(c.paperId)) throw new Error("完成记录无法核验");
		return c;
	}
	async history(): Promise<LocalPdfHistory[]> {
		this.available(); const files = await this.deps.journal.list(root);
		const records = files.filter(f => !f.directory && /^s-[a-f0-9-]{36}\.json$/.test(f.name));
		if (records.length > 200) throw new Error("本地 PDF 添加记录超过 200 条，请先整理");
		const result: LocalPdfHistory[] = [];
		for (const file of records) {
			this.available(); const id = file.name.slice(0, -5);
			try {
				const operation = await this.readOperation(id), bytes = await this.deps.journal.read(`${root}/${id}.saved.json`);
				if (bytes) this.completion(JSON.parse(Buffer.from(bytes).toString("utf8")), operation);
				result.push({ id, title: operation.snapshot.identity.title, fileName: operation.snapshot.origin.fileName, createdAt: operation.snapshot.createdAt, state: bytes ? "saved" : "pending", error: "" });
			} catch (error) { result.push({ id, title: "无法读取的本地记录", fileName: "", createdAt: "", state: "unavailable", error: message(error) }); }
		}
		this.available(); return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
	}
	private async request<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		this.available(signal); const controller = new AbortController(), abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true }); this.requests.add(controller);
		try { return await run(controller.signal); } finally { signal.removeEventListener("abort", abort); this.requests.delete(controller); }
	}
	async prepare(filePath: string, raw: string, version: LocalPdfSnapshot["version"], signal: AbortSignal): Promise<SourceSavePlan> {
		return this.request(signal, async current => {
			const input = parseAcquisitionInput(raw), resolved = await this.deps.resolver.resolve(input, current); this.available(current);
			if (!resolved) throw new Error("未找到书目信息，请检查文献标识");
			const identity = decodeIdentity(resolved); if (identity.identifiers[input.kind] !== input.value) throw new Error("查询结果与输入标识不一致");
			const selected = await prepareLocalPdf(filePath, identity, current, { version, read: this.deps.read, pdfLoader: this.deps.pdfLoader }); this.available(current);
			return this.activate(this.decode({ schemaVersion: 1, deviceId: this.deps.deviceId, path: filePath, snapshot: selected.snapshot }, selected.snapshot.id), filePath, current);
		});
	}
	async resume(id: string, signal: AbortSignal, selectedPath?: string): Promise<SourceSavePlan> {
		return this.request(signal, async current => {
			const operation = await this.readOperation(id); this.available(current);
			return this.activate(operation, selectedPath || operation.path, current);
		});
	}
	/** Continue a saved paper without a second metadata request; the catalog still owns association. */
	async prepareForPaper(filePath: string, context: { identity: ResolvedIdentity; paperId: string }, version: LocalPdfSnapshot["version"], signal: AbortSignal): Promise<SourceSavePlan> {
		const identity = decodeIdentity(context.identity), paperId = context.paperId;
		if (!/^p-[a-f0-9-]{36}$/.test(paperId)) throw new Error("已确认文献标识无效");
		return this.request(signal, async current => {
			const selected = await prepareLocalPdf(filePath, identity, current, { version, read: this.deps.read, pdfLoader: this.deps.pdfLoader }); this.available(current);
			const plan = await this.activate(this.decode({ schemaVersion: 1, deviceId: this.deps.deviceId, path: filePath, snapshot: selected.snapshot }, selected.snapshot.id), filePath, current);
			if (plan.paperId !== paperId) { this.cancel(plan.requestId); throw new Error("文献关联已变化，请返回添加文献重新核对"); }
			return plan;
		});
	}
	private async activate(operation: LocalOperation, filePath: string, signal: AbortSignal): Promise<SourceSavePlan> {
		const id = operation.snapshot.id, previous = this.entries.get(id);
		if (this.saving.has(id) || previous?.plan) throw new Error("此记录正在另一个窗口核对，请先关闭该窗口");
		if (this.entries.size >= 100 && !previous) throw new Error("本次打开的本地计划过多，请重新加载插件");
		const entry = { operation, path: filePath, controller: new AbortController(), plan: undefined as SourceSavePlan | undefined };
		this.entries.set(id, entry); const abort = () => entry.controller.abort(); signal.addEventListener("abort", abort, { once: true });
		try {
			const plan = await this.source.prepare(id); entry.plan = plan; this.available(signal); return plan;
		} catch (error) { if (entry.plan) this.source.cancel(entry.plan.requestId); entry.controller.abort(); entry.plan = undefined; throw error; }
		finally { signal.removeEventListener("abort", abort); }
	}
	get(requestId: string): SourceSavePlan { return this.source.get(requestId); }
	async present(requestId: string, page = 1): Promise<{ dataUrl: string; digest: string }> {
		this.available(); const entry = this.entries.get(this.source.get(requestId).jobId)!; entry.digest = undefined;
		const shown = await this.source.present(requestId, page); entry.digest = shown.digest; return shown;
	}
	save(requestId: string, digest: string): Promise<SourceSavePlan> {
		const plan = this.source.get(requestId), entry = this.entries.get(plan.jobId);
		if (!entry || entry.plan?.requestId !== requestId || this.saving.has(plan.jobId)) return Promise.reject(new Error("本地 PDF 保存计划已失效或正在保存"));
		if (!plan.existing && (!entry.digest || entry.digest !== digest)) return Promise.reject(new Error("请先核对当前展示的 PDF 页面"));
		this.saving.add(plan.jobId);
		const task = this.queue.then(async () => {
			this.available(entry.controller.signal);
			// Record the exact snapshot before any shared publication; preview/cancellation never mkdir.
			const name = `${root}/${plan.jobId}.json`, bytes = encode(entry.operation), old = await this.deps.journal.read(name);
			if (old && !Buffer.from(old).equals(bytes)) throw new Error("本地添加记录已变化，未覆盖");
			if (!old) {
				if ((await this.history()).length >= 200) throw new Error("本地 PDF 添加记录已满 200 条，请先整理");
				this.available(entry.controller.signal); await this.deps.journal.mkdir(root); await this.deps.journal.create(name, bytes);
			}
			this.available(entry.controller.signal); const saved = await this.source.save(requestId, digest);
			if (saved.phase === "saved") {
				const completion: Completion = { schemaVersion: 1, operationDigest: objectDigest(entry.operation), packageKey: saved.packageKey, paperId: saved.paperId };
				const receipt = `${root}/${plan.jobId}.saved.json`, before = await this.deps.journal.read(receipt);
				if (before) { if (objectDigest(this.completion(JSON.parse(Buffer.from(before).toString("utf8")), entry.operation)) !== objectDigest(completion)) throw new Error("本地完成记录已变化，未覆盖"); }
				else await this.deps.journal.create(receipt, encode(completion));
			}
			return saved;
		}).finally(() => { this.saving.delete(plan.jobId); if (entry.closing) { entry.controller.abort(); entry.plan = undefined; } });
		this.queue = task.catch(() => undefined); return task;
	}
	cancel(requestId: string): void {
		const plan = this.source.get(requestId), entry = this.entries.get(plan.jobId);
		if (entry) entry.closing = true;
		if (this.source.cancel(requestId) || plan.phase === "saved") { if (entry) { entry.controller.abort(); entry.plan = undefined; } }
	}
	async dispose(): Promise<void> {
		this.closed = true; for (const request of this.requests) request.abort();
		for (const entry of this.entries.values()) if (entry.plan) this.cancel(entry.plan.requestId);
		await this.queue; await this.source.dispose(); this.entries.clear();
	}
}
