import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import { acquisitionActive, acquisitionRetryable, decodeCandidates, decodeIdentity, decodePdfValidation, decodeRequest, requestKey, type AcquisitionCandidate, type AcquisitionJob, type AcquisitionMode, type AcquisitionRequest, type AcquisitionSnapshot, type ResolvedIdentity, type PdfArtifact, type PdfValidation, type PdfSnapshot } from "./contracts";
import { AcquisitionRepository } from "./repository";
import { sourceFailure, SourceError } from "./errors";
import { decodeJatsBundle,decodeJatsValidation,type JatsBundle,type JatsValidation,type JatsSnapshot } from "../jats/contracts";
import type { JatsProjection } from "../jats/projection";
import { objectDigest } from "../papers/identity";

export interface DownloadContext { jobId: string; attemptId: string; request: AcquisitionRequest; identity?: ResolvedIdentity; budget?: {received:number;limit:number}; }
export interface AcquisitionBackend {
	readonly mode: AcquisitionMode;
	readonly unpaywallEnabled?: boolean;
	resolve(request: AcquisitionRequest, signal: AbortSignal): Promise<void | ResolvedIdentity>;
	discover(request: AcquisitionRequest, signal: AbortSignal, identity?: ResolvedIdentity): Promise<AcquisitionCandidate[]>;
	download(candidate: AcquisitionCandidate, signal: AbortSignal, progress: (received: number, total?: number) => void, context?: DownloadContext): Promise<void | PdfArtifact>;
	verify(request: AcquisitionRequest, signal: AbortSignal, artifact?: PdfArtifact, identity?: ResolvedIdentity): Promise<"valid" | "conflict" | PdfValidation>;
	validateSnapshot?(snapshot: PdfSnapshot): Promise<void>;
	readSnapshot?(snapshot: PdfSnapshot): Promise<Uint8Array>;
	pathSnapshot?(snapshot:PdfSnapshot):Promise<string>;
	discoverFallback?(request:AcquisitionRequest,signal:AbortSignal,identity:ResolvedIdentity):Promise<AcquisitionCandidate[]>;
	downloadJats?(candidate:AcquisitionCandidate,signal:AbortSignal,progress:(n:number)=>void,context:DownloadContext):Promise<{artifact:JatsBundle;validation:JatsValidation}>;
	readJatsSnapshot?(snapshot:JatsSnapshot):Promise<{content:Map<string,Uint8Array>;projection:JatsProjection;validation:JatsValidation}>;
}
interface Attempt { id: string; controller: AbortController; committing: boolean; timer?: ReturnType<typeof setTimeout>; budget:{received:number;limit:number}; remainingMs:number; timedAt?:number; }
export class AcquisitionService {
	private readonly attempts = new Map<string, Attempt>();
	private readonly volatile = new Map<string, AcquisitionJob>();
	private readonly listeners = new Set<(progressOnly?: boolean) => void>();
	private queue: Promise<unknown> = Promise.resolve();
	private loading?: Promise<void>;
	private disposed = false;
	constructor(readonly repository: AcquisitionRepository, readonly deviceId: string, private backend?: AcquisitionBackend) {
		if (backend && backend.mode !== repository.mode) throw new Error("演示来源不能用于正式获取");
	}
	get mode(): AcquisitionMode { return this.repository.mode; }
	get available(): boolean { return !!this.backend; }
	get unpaywallEnabled():boolean {return this.backend?.unpaywallEnabled===true;}
	get diagnostics(): readonly string[] { return this.repository.errors; }
	list(): AcquisitionJob[] { return [...this.repository.jobs.keys()].map(id => this.get(id)!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
	get(id: string): AcquisitionJob | undefined { const job = this.volatile.get(id) || this.repository.jobs.get(id); return job && structuredClone(job); }
	owned(job: AcquisitionJob | undefined): boolean { return job?.deviceId === this.deviceId; }
	subscribe(listener: (progressOnly?: boolean) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private emit(progressOnly = false): void { for (const listener of this.listeners) { try { listener(progressOnly); } catch { /* A closed view must not break task persistence. */ } } }
	private release(id: string): void { const attempt = this.attempts.get(id); if (attempt?.timer) clearTimeout(attempt.timer); this.attempts.delete(id); }
	private pauseDeadline(attempt:Attempt):void { if(attempt.timer)clearTimeout(attempt.timer); if(attempt.timedAt!==undefined)attempt.remainingMs-=Math.max(0,Date.now()-attempt.timedAt);attempt.timedAt=undefined; }
	private deadline(id: string, attempt: Attempt, ms: number): void {
		this.pauseDeadline(attempt);
		if (this.mode !== "production") return;
		attempt.timedAt=Date.now();
		attempt.timer = setTimeout(() => {
			if (!this.current(id, attempt) || attempt.committing) return;
			attempt.controller.abort(new SourceError("timeout", "获取阶段超时"));
			void this.serial(async () => { if (this.attempts.get(id) !== attempt) return; this.release(id); await this.persist({ ...this.get(id)!, phase: "failed", errorCode: "timeout", error: "获取阶段超时，请检查直连网络或存储后重试", detail: "已写文件保留在插件目录" }); });
		}, Math.max(0,Math.min(ms,attempt.remainingMs)));
	}
	private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work); this.queue = result.catch(() => undefined); return result; }
	ready(): Promise<void> { return this.loading ||= this.recover(); }
	private async recover(): Promise<void> {
		await this.repository.load();
		for (const stored of this.repository.jobs.values()) {
			if (!this.owned(stored)) continue;
			let completed = false;
			if (stored.snapshotId && (stored.phase === "verifying" || stored.phase === "acquired")) {
				try { const snapshot = await this.repository.snapshot(stored.snapshotId); completed = this.matches(stored, snapshot); if (completed && snapshot.mode === "production") { if(snapshot.schemaVersion===3){if(!this.backend?.readJatsSnapshot)completed=false;else await this.backend.readJatsSnapshot(snapshot);}else if (!this.backend?.validateSnapshot) completed = false; else await this.backend.validateSnapshot(snapshot); } } catch { completed = false; }
			}
			if (completed && stored.phase !== "acquired") { const snapshot = await this.repository.snapshot(stored.snapshotId!); await this.persist({ ...stored, phase: "acquired", identityCheck: snapshot.mode === "production" ? snapshot.validation.identityCheck : undefined, detail: this.mode === "demo" ? "已恢复完整演示记录" : "已恢复校验完整的本地全文快照", error: "", errorCode: undefined }); }
			else if (acquisitionActive(stored.phase) || (stored.phase === "acquired" && !completed)) await this.persist({ ...stored, phase: "interrupted", detail: "请重试以重新执行；不会自动连接来源", error: stored.phase === "acquired" ? "完成记录的快照缺失或不匹配" : "" });
		}
		this.emit();
	}
	private matches(job: AcquisitionJob, snapshot: AcquisitionSnapshot): boolean {
		const selected=job.candidates.find(c=>c.id===job.selectedId);
		const kindMatches=snapshot.schemaVersion===3?job.request.goal==="jats"&&snapshot.artifact.includeFigures===job.request.includeFigures:job.request.goal==="pdf";
		return kindMatches && job.mode === snapshot.mode && snapshot.id === job.snapshotId && snapshot.jobId === job.id && snapshot.attemptId === job.attemptId && snapshot.candidateId === job.selectedId && objectDigest(snapshot.input) === objectDigest(job.request.input) && (snapshot.mode === "demo" || (!!job.identity&&!!selected&&objectDigest(snapshot.identity) === objectDigest(job.identity) && objectDigest(snapshot.candidate) === objectDigest(selected)));
	}
	private async persist(job: AcquisitionJob): Promise<boolean> {
		const saved = this.repository.jobs.get(job.id);
		const next = { ...job, revision: Math.max(job.revision, saved?.revision || 0) + 1, updatedAt: new Date().toISOString(), storageWarning: undefined };
		try { await this.repository.save(next); this.volatile.delete(job.id); this.emit(); return true; }
		catch {
			this.volatile.set(job.id, { ...next, phase: "failed", error: "记录保存失败", storageWarning: "本次状态未保存。请检查存储后重试；重启后将核验已有快照。" });
			this.attempts.get(job.id)?.controller.abort(); this.release(job.id); this.emit(); return false;
		}
	}
	start(request:AcquisitionRequest):Promise<AcquisitionJob>{return this.startRequest(request,false);}
	/** Explicit refresh keeps the previous immutable snapshot and starts a separate acquisition. */
	async refreshJats(id:string):Promise<AcquisitionJob>{await this.ready();const job=this.get(id);if(!job||!this.owned(job)||job.request.goal!=="jats"||job.phase!=="acquired")throw new Error("此 JATS 记录不能重新查询");return this.startRequest(job.request,true);}
	private async startRequest(request: AcquisitionRequest,fresh:boolean): Promise<AcquisitionJob> {
		await this.ready();
		return this.serial(async () => {
			if (this.disposed) throw new Error("全文获取服务已关闭");
			const normalized = decodeRequest(this.mode==="production"&&request.goal==="pdf"?{...request,useUnpaywall:request.useUnpaywall ?? this.unpaywallEnabled}:request, this.mode);
			const duplicate = this.list().find(job => this.owned(job) && acquisitionActive(job.phase) && requestKey(job.request) === requestKey(normalized));
			if (duplicate) return duplicate;
			if (!fresh && this.mode === "production" && this.backend && (normalized.goal==="jats"?this.backend.readJatsSnapshot:this.backend.validateSnapshot)) {
				for (const cached of this.list().filter(job => this.owned(job) && job.phase === "acquired" && job.request.goal===normalized.goal && job.request.includeFigures===normalized.includeFigures && job.request.versionPolicy === normalized.versionPolicy && job.identity?.identifiers[normalized.input.kind] === normalized.input.value)) {
					try { const snapshot = await this.repository.snapshot(cached.snapshotId!); if (snapshot.mode !== "production" || !this.matches(cached, snapshot)) throw new Error("invalid");if(snapshot.schemaVersion===3){if(!this.backend.readJatsSnapshot)throw new Error("JATS unavailable");await this.backend.readJatsSnapshot(snapshot);}else await this.backend.validateSnapshot!(snapshot); return cached; }
					catch { await this.persist({ ...cached, phase: "interrupted", error: "已有全文快照校验失败，本次将重新查询来源", detail: "原文件保留，未覆盖" }); }
				}
			}
			const now = new Date().toISOString();
			const job: AcquisitionJob = { schemaVersion: 1, id: "a-" + randomUUID(), attemptId: "a-" + randomUUID(), revision: 1, mode: this.mode, deviceId: this.deviceId, request: normalized, phase: this.backend ? "queued" : "needs_configuration", createdAt: now, updatedAt: now, detail: this.backend ? this.mode === "demo" ? "准备开始演示" : "准备查询论文身份与 PMC 来源" : "全文来源不可用", error: "", candidates: [] };
			// Initial write failures reject before any backend work or visible task is created.
			try { await this.repository.save(job); } catch { throw new Error("无法保存新任务，请检查插件存储目录"); }
			this.emit(); if (this.backend) this.launch(job); return this.get(job.id)!;
		});
	}
	async retry(id: string): Promise<void> {
		await this.ready(); await this.serial(async () => {
			const job = this.get(id); if (this.disposed || !this.backend || !job || !this.owned(job) || !acquisitionRetryable(job.phase)) throw new Error("此任务当前不能重试");
			const next: AcquisitionJob = { ...job, attemptId: "a-" + randomUUID(), phase: "queued", candidates: [], selectedId: undefined, snapshotId: undefined, receivedBytes: undefined, totalBytes: undefined, identity: undefined, identityCheck: undefined, errorCode: undefined, error: "", detail: "准备重新执行" };
			if (await this.persist(next)) this.launch(this.get(id)!);
		});
	}
	async choose(id: string, candidateId: string): Promise<void> {
		await this.ready(); await this.serial(async () => {
			const job = this.get(id), attempt = this.attempts.get(id);
			if (!job || !attempt || !this.current(id, attempt) || !this.owned(job) || job.phase !== "awaiting_selection" || !job.candidates.some(c => c.id === candidateId)) throw new Error("候选已失效，请重新查看任务");
			if (await this.persist({ ...job, phase: "downloading", selectedId: candidateId, detail: this.mode === "demo" ? "演示获取进度" : "重新核验来源清单并获取 "+(job.request.goal==="jats"?"XML 与所选图片":"PDF") })) { this.deadline(id, attempt, job.request.useUnpaywall?300000:180000); void this.runSelected(id, attempt); }
		});
	}
	stop(id: string): boolean {
		const job = this.get(id), attempt = this.attempts.get(id);
		if (!job || !this.owned(job) || !attempt || attempt.committing || !acquisitionActive(job.phase)) return false;
		attempt.controller.abort();
		void this.serial(async () => {
			if (this.attempts.get(id) !== attempt) return;
			this.release(id); await this.persist({ ...this.get(id)!, phase: "cancelled", detail: this.mode === "demo" ? "已停止演示" : "已停止获取；已写文件保留在插件目录", error: "" });
		}); return true;
	}
	private current(id: string, attempt: Attempt): boolean { return !this.disposed && this.attempts.get(id) === attempt && !attempt.controller.signal.aborted; }
	private launch(job: AcquisitionJob): void {
		const attempt: Attempt = { id: job.attemptId, controller: new AbortController(), committing: false, budget:{received:0,limit:128*1024*1024}, remainingMs:300000 };
		this.attempts.set(job.id, attempt); this.deadline(job.id, attempt, 20000); void this.run(job.id, attempt);
	}
	private async stage(id: string, attempt: Attempt, changes: Partial<AcquisitionJob>): Promise<boolean> {
		return this.serial(async () => { if (!this.current(id, attempt)) return false; if (changes.phase && (changes.phase === "awaiting_selection" || !acquisitionActive(changes.phase))) this.pauseDeadline(attempt); return this.persist({ ...this.get(id)!, ...changes }); });
	}
	private async fail(id: string, attempt: Attempt, error?: unknown): Promise<void> {
		const failure = sourceFailure(error);
		await this.stage(id, attempt, { phase: this.mode === "demo" ? "failed" : failure.outcome, errorCode: failure.code, error: this.mode === "demo" ? "演示来源返回失败，可以重试" : failure.message, detail: this.mode === "demo" ? "本次未产生可用文件" : "本次未生成可用全文快照；已写文件保留在插件目录" });
		if (this.attempts.get(id) === attempt && !attempt.controller.signal.aborted) this.release(id);
	}
	private async run(id: string, attempt: Attempt): Promise<void> {
		try {
			if (!await this.stage(id, attempt, { phase: "resolving", detail: this.mode === "demo" ? "识别虚构论文" : "查询 Europe PMC 精确标识与 Crossref 元数据" })) return;
			const request = this.get(id)!.request, signal = attempt.controller.signal;
			const resolved = await this.backend!.resolve(request, signal);
			const identity = this.mode === "production" ? decodeIdentity(resolved) : undefined;
			if (identity && identity.identifiers[request.input.kind] !== request.input.value) throw new SourceError("identity_mismatch", "解析记录不包含输入标识", "conflict");
			if (!await this.stage(id, attempt, { phase: "discovering", identity, detail: this.mode === "demo" ? "查找模拟来源" : "查询 PMC 可用版本与文件清单" })) return;
			const candidates = decodeCandidates(await this.backend!.discover(request, signal, identity));
			const selection = candidates.length > 0 && (this.mode === "production" || candidates.length > 1);
			if (!await this.stage(id, attempt, { candidates, phase: selection ? "awaiting_selection" : candidates.length ? "downloading" : "no_match", selectedId: !selection && candidates.length === 1 ? candidates[0].id : undefined, detail: selection ? this.mode === "production" ? "核对论文与版本后，选择获取全文" : "请选择一个模拟来源" : candidates.length ? "演示获取进度" : "没有符合本次请求的全文候选" })) return;
			if (candidates.length === 1 && !selection) await this.runSelected(id, attempt);
			else if (!candidates.length) this.release(id);
		} catch (error) { await this.fail(id, attempt, error); }
	}
	private async runSelected(id: string, attempt: Attempt): Promise<void> {
		const fileAttemptId=attempt.id;
		try {
			if (!this.current(id, attempt)) return;
			const job = this.get(id)!, candidate = job.candidates.find(c => c.id === job.selectedId)!;
			if(job.request.goal==="jats"){await this.runJatsSelected(job,candidate,attempt);return;}
			let lastEmit = 0;
			const artifact = await this.backend!.download(candidate, attempt.controller.signal, (received, total) => {
				if (!this.current(id, attempt) || attempt.id!==fileAttemptId) return;
				const latest = this.get(id)!;
				if (latest.phase !== "downloading" || !Number.isSafeInteger(received) || received < (latest.receivedBytes || 0) || (total !== undefined && (!Number.isSafeInteger(total) || total <= 0 || received > total)) || (latest.totalBytes !== undefined && total !== latest.totalBytes)) return;
				this.volatile.set(id, { ...latest, receivedBytes: received, totalBytes: total });
				if (Date.now() - lastEmit >= 250 || received === total) { lastEmit = Date.now(); this.emit(true); }
			}, { jobId: id, attemptId: fileAttemptId, request: job.request, identity: job.identity, budget:attempt.budget });
			const snapshotId = "s-" + randomUUID();
			if (!await this.stage(id, attempt, { phase: "verifying", snapshotId, detail: this.mode === "demo" ? "校验模拟结果并保存演示回执" : "核验 PDF 格式、页面、身份线索和文件哈希" })) return;
			const verdict = await this.backend!.verify(job.request, attempt.controller.signal, artifact || undefined, job.identity);
			if (verdict === "conflict") { await this.stage(id, attempt, { phase: "conflict", error: "身份冲突，已停止后续操作", detail: "需要核对论文身份" }); if (this.attempts.get(id) === attempt) this.release(id); return; }
			const validation = this.mode === "production" ? decodePdfValidation(verdict) : undefined;
			await this.serial(async () => {
				if (!this.current(id, attempt)) return;
				attempt.committing = true;
				if (attempt.timer) clearTimeout(attempt.timer);
				const latest = this.get(id)!;
				const base = { id: snapshotId, jobId: id, attemptId: attempt.id, input: latest.request.input, candidateId: candidate.id, createdAt: new Date().toISOString() };
				const snapshot: AcquisitionSnapshot = this.mode === "demo" ? { ...base, schemaVersion: 1, mode: "demo", simulated: true } : { ...base, schemaVersion: 2, mode: "production", identity: latest.identity!, candidate, artifact: artifact!, validation: validation! };
				try { await this.repository.saveSnapshot(snapshot); }
				catch { await this.persist({ ...latest, phase: "failed", error: this.mode === "demo" ? "演示快照保存失败，请检查存储后重试" : "PDF 快照记录保存失败，请检查存储后重试", detail: "未完成保存" }); this.release(id); return; }
				await this.persist({ ...latest, phase: "acquired", identityCheck: validation?.identityCheck, detail: this.mode === "demo" ? "演示回执已保存；没有下载 PDF，也未入库" : validation?.identityCheck === "verified" ? "文件已获取，首页身份线索匹配；尚未入库或进行全文深读" : "文件已获取，身份待核对；可预览原文，尚未入库", error: "", errorCode: undefined }); this.release(id);
			});
		} catch (error) {
			if (this.mode==="production" && this.current(id,attempt) && error instanceof SourceError && error.outcome==="failed" && !["total_size_limit","timeout"].includes(error.code)) {
				const job=this.get(id)!, index=job.candidates.findIndex(c=>c.id===job.selectedId), next=job.candidates[index+1];
				if(next) { attempt.id="a-"+randomUUID(); if(await this.stage(id,attempt,{attemptId:attempt.id,selectedId:next.id,snapshotId:undefined,receivedBytes:undefined,totalBytes:undefined,phase:"downloading",detail:`上一候选未完成（${error.code}），正在尝试下一全文来源`,error:"",errorCode:undefined})) await this.runSelected(id,attempt); return; }
				if(job.request.useUnpaywall && job.candidates.every(c=>!!c.pmc) && this.backend?.discoverFallback) {
					try { if(!await this.stage(id,attempt,{phase:"discovering",detail:"PMC 候选未能完成，正在查询开放 PDF 回退"}))return;
						const candidates=decodeCandidates(await this.backend.discoverFallback(job.request,attempt.controller.signal,job.identity!));
						attempt.id="a-"+randomUUID();
						await this.stage(id,attempt,{attemptId:attempt.id,candidates,selectedId:undefined,snapshotId:undefined,receivedBytes:undefined,totalBytes:undefined,phase:"awaiting_selection",detail:"已找到新的开放来源，请核对稿件类型后选择 PDF"}); return;
					} catch(fallbackError) { await this.fail(id,attempt,fallbackError);return; }
				}
			}
			await this.fail(id, attempt, error);
		}
	}
	async intakeSource(id:string):Promise<{snapshot:PdfSnapshot;path:string}> {
		const {snapshot}=await this.preview(id); if(!this.backend?.pathSnapshot)throw new Error("此来源没有可用于入库的本地文件");
		return {snapshot,path:await this.backend.pathSnapshot(snapshot)};
	}
	async linkIntake(id:string,snapshotId:string,runId:string):Promise<void> {
		await this.ready(); await this.serial(async()=>{
			const job=this.get(id);if(!job || !this.owned(job) || job.phase!=="acquired" || job.snapshotId!==snapshotId)throw new Error("获取快照已变化，请重新打开入库");
			if(job.intakeRunIds?.includes(runId))return;
			// Association failure must not invalidate the completed acquisition.
			await this.repository.save({...job,revision:job.revision+1,updatedAt:new Date().toISOString(),intakeRunIds:[...(job.intakeRunIds||[]),runId]});this.volatile.delete(id);this.emit();
		});
	}
	async linkSourcePackage(id:string,packageKey:string):Promise<void> {
		await this.ready();await this.serial(async()=>{const job=this.get(id);if(!job||!this.owned(job)||job.phase!=="acquired")throw new Error("获取记录不可关联原文包");if(job.sourcePackages?.includes(packageKey))return;
			await this.repository.save({...job,revision:job.revision+1,updatedAt:new Date().toISOString(),sourcePackages:[...(job.sourcePackages||[]),packageKey]});this.volatile.delete(id);this.emit();});
	}
	async preview(id: string): Promise<{ snapshot: PdfSnapshot; bytes: Uint8Array }> {
		await this.ready(); const job = this.get(id);
		if (!job ||job.request.goal!=="pdf"|| !this.owned(job) || job.phase !== "acquired" || !job.snapshotId || !this.backend?.readSnapshot) throw new SourceError("not_acquired", "此任务没有可预览的本地 PDF");
		try { const snapshot = await this.repository.snapshot(job.snapshotId); if (snapshot.schemaVersion !== 2 || !this.matches(job, snapshot)) throw new Error("snapshot binding"); return { snapshot, bytes: await this.backend.readSnapshot(snapshot) }; }
		catch { await this.serial(() => this.persist({ ...job, phase: "interrupted", error: "PDF 快照缺失或已变化，请重新获取", detail: "原文件保留，未打开未经验证的内容" })); throw new SourceError("snapshot_changed", "本地 PDF 校验失败，请重新获取"); }
	}
	async settled(): Promise<void> { await this.queue; }
	private async runJatsSelected(job:AcquisitionJob,candidate:AcquisitionCandidate,attempt:Attempt):Promise<void> {
		if(!this.backend?.downloadJats)throw new Error("JATS 获取服务不可用");let lastEmit=0;
		const result=await this.backend.downloadJats(candidate,attempt.controller.signal,n=>{if(!this.current(job.id,attempt))return;const current=this.get(job.id)!;if(n<(current.receivedBytes||0))return;this.volatile.set(job.id,{...current,receivedBytes:n,totalBytes:undefined});if(Date.now()-lastEmit>250){lastEmit=Date.now();this.emit(true);}},{jobId:job.id,attemptId:attempt.id,request:job.request,identity:job.identity,budget:attempt.budget});
		const snapshotId="s-"+randomUUID();if(!await this.stage(job.id,attempt,{phase:"verifying",snapshotId,detail:"XML 主文章、结构与同版本图片校验完成，正在保存快照"}))return;
		await this.serial(async()=>{if(!this.current(job.id,attempt))return;attempt.committing=true;if(attempt.timer)clearTimeout(attempt.timer);const latest=this.get(job.id)!;
			const snapshot:JatsSnapshot={schemaVersion:3,mode:"production",id:snapshotId,jobId:job.id,attemptId:attempt.id,input:job.request.input,candidateId:candidate.id,createdAt:new Date().toISOString(),identity:job.identity!,candidate,artifact:decodeJatsBundle(result.artifact),validation:decodeJatsValidation(result.validation)};
			try{await this.repository.saveSnapshot(snapshot);}catch{await this.persist({...latest,phase:"failed",error:"JATS 快照保存失败，已写文件保留",detail:"未完成保存"});this.release(job.id);return;}
			await this.persist({...latest,phase:"acquired",identityCheck:"verified",detail:snapshot.validation.requestSatisfaction==="partial"?"XML 已获取，图片或内容存在缺口；保存前需要明确接受部分结果":"XML 文件已获取并校验，可无模型保存图文原文",error:"",errorCode:undefined});this.release(job.id);
		});
	}
	async previewJats(id:string) {
		await this.ready();const job=this.get(id);if(!job||!this.owned(job)||job.request.goal!=="jats"||job.phase!=="acquired"||!job.snapshotId||!this.backend?.readJatsSnapshot)throw new Error("此任务没有可读的 JATS 快照");
		try{const snapshot=await this.repository.snapshot(job.snapshotId);if(snapshot.schemaVersion!==3||!this.matches(job,snapshot))throw new Error("JATS 快照绑定不一致");return {snapshot,...await this.backend.readJatsSnapshot(snapshot)};}
		catch{await this.serial(()=>this.persist({...job,phase:"interrupted",error:"JATS 快照缺失或已变化，请重新获取",detail:"原文件保留，未打开未经验证的内容"}));throw new SourceError("snapshot_changed","本地 JATS 校验失败，请重新获取");}
	}
	async dispose(): Promise<void> {
		this.disposed = true; for (const attempt of this.attempts.values()) { if (attempt.timer) clearTimeout(attempt.timer); attempt.controller.abort(); }
		await this.loading?.catch(() => undefined);
		await this.serial(async () => {
			for (const [id] of this.attempts) { const job = this.get(id); if (job && acquisitionActive(job.phase)) await this.persist({ ...job, phase: "interrupted", detail: "插件已关闭，可在重新打开后重试" }); }
			this.attempts.clear(); this.listeners.clear();
		});
	}
}
