import { decodeJob, decodeSnapshot, type AcquisitionJob, type AcquisitionMode, type AcquisitionSnapshot } from "./contracts";

export interface AcquisitionStorage {
	listJobs(): Promise<string[]>;
	readJob(id: string): Promise<unknown>;
	writeJob(job: AcquisitionJob): Promise<void>;
	readSnapshot(id: string): Promise<unknown>;
	writeSnapshot(snapshot: AcquisitionSnapshot): Promise<void>;
}
/** No retention or deletion. Only publish in memory after the storage write succeeds. */
export class AcquisitionRepository {
	readonly jobs = new Map<string, AcquisitionJob>();
	readonly errors: string[] = [];
	private loaded?: Promise<void>;
	constructor(readonly storage: AcquisitionStorage, readonly mode: AcquisitionMode) {}
	load(): Promise<void> { return this.loaded ||= this.readAll(); }
	private async readAll(): Promise<void> {
		const ids = await this.storage.listJobs();
		if (ids.length > 2000) throw new Error("获取记录超过 2000 条，请先整理记录");
		for (const id of ids) {
			try { const job = decodeJob(await this.storage.readJob(id), this.mode); if (job.id !== id) throw new Error("任务与文件标识不一致"); this.jobs.set(id, job); }
			catch { this.errors.push("获取记录无法恢复：" + id); }
		}
	}
	get(id: string): AcquisitionJob { const job = this.jobs.get(id); if (!job) throw new Error("全文获取任务不存在"); return structuredClone(job); }
	async save(job: AcquisitionJob): Promise<void> {
		const copy = decodeJob(job, this.mode); await this.storage.writeJob(copy); this.jobs.set(copy.id, copy);
	}
	async snapshot(id: string): Promise<AcquisitionSnapshot> { const result = decodeSnapshot(await this.storage.readSnapshot(id)); if (result.id !== id) throw new Error("快照与文件标识不一致"); return result; }
	async saveSnapshot(snapshot: AcquisitionSnapshot): Promise<void> { if (this.mode !== "demo") throw new Error("正式存储不接受演示快照"); await this.storage.writeSnapshot(decodeSnapshot(snapshot)); }
}
