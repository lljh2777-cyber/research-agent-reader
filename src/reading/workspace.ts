import type { App } from "obsidian";
import { ReadingDocumentLoader, type ReadingDocument } from "./document";
import { FileReadingStorage, ReadingRepository, RoutedReadingStorage } from "./store";
import { matchingReading, readingCategory } from "./catalog";
import { addReadingBranch, addReadingNode, createReadingSession, readingNode } from "./session";
import type { AnnotationOrigin, ReadingNode, ReadingQuote, ReadingSession, ReadingSource } from "./types";
import { answerHash } from "./quality";
import { codeQuote } from "../code-reading/quote";

const DOCUMENT_OPEN_DISPOSE_TIMEOUT_MS = 5_000;
const QUEUED_OPEN = Symbol("queued document open");

export class ReadingWorkspaceService {
	readonly repository: ReadingRepository;
	readonly loader: ReadingDocumentLoader;
	private documents = new Map<string, ReadingDocument>();
	private readonly loadingDocuments = new Map<string, Promise<ReadingDocument>>();
	private readonly pendingOpens = new Map<string | symbol, string>();
	private closingError?: Error;
	private disposal?: Promise<void>;
	get closeReason(): Error | undefined { return this.closingError; }
	private initialization: Promise<void> | null = null;
	private tasks = new Map<Promise<unknown>, string | symbol>();
	private openings: Promise<unknown> = Promise.resolve();
	generateHandler?: (sessionId: string, nodeId: string) => Promise<void>;
	stopHandler?: (sessionId: string, nodeId: string) => void;
	disposeHandler?: () => void;
	constructor(app: App, vaultRoot: string, pluginDirectory: string) {
		this.repository = new ReadingRepository(new RoutedReadingStorage(new FileReadingStorage(pluginDirectory), new FileReadingStorage(pluginDirectory, "reading-test-sessions"), new FileReadingStorage(pluginDirectory, "code-reading-sessions")));
		this.loader = new ReadingDocumentLoader(app, vaultRoot);
	}
	async ready(): Promise<void> { if (!this.initialization) this.initialization = this.repository.load(); return this.initialization; }
	private assertOpen(): void {
		if (this.closingError) throw this.closingError;
	}
	private async track<T>(operation: Promise<T>, openKey: string | symbol): Promise<T> {
		this.tasks.set(operation, openKey);
		try { return await operation; }
		finally { this.tasks.delete(operation); }
	}
	private async openDocument(kind: ReadingSource["kind"], filename: string, openKey: string | symbol, sessionId?: string): Promise<ReadingDocument> {
		this.assertOpen();
		this.pendingOpens.set(openKey, sessionId ?? filename);
		let document: ReadingDocument;
		try { document = await this.loader.open(kind, filename); }
		finally { this.pendingOpens.delete(openKey); }
		if (this.closingError) {
			await document.destroy();
			throw this.closingError;
		}
		return document;
	}
	async create(kind: ReadingSource["kind"], filename: string, backend: string, model: string): Promise<string> {
		this.assertOpen();
		await this.ready();
		const openKey = Symbol(filename);
		return this.track(this.openDocument(kind, filename, openKey).then(document =>
			this.saveNewSession(document, createReadingSession(document.source, backend, model))), openKey);
	}
	private async saveNewSession(document: ReadingDocument, session: ReadingSession): Promise<string> {
		try {
			this.assertOpen();
			await this.repository.add(session);
			this.assertOpen();
			this.documents.set(session.id, document);
			return session.id;
		} catch (error) { await document.destroy(); throw error; }
	}
	async open(kind: ReadingSource["kind"], filename: string, backend: string, model: string, forceNew = false): Promise<{ id: string; created: boolean }> {
		this.assertOpen();
		const operation = this.openings.then(async () => {
			await this.ready(); const document = await this.openDocument(kind, filename, QUEUED_OPEN);
			const sessions = [...this.repository.sessions.values()];
			const samePaper = kind === "code" ? [] : sessions.filter(s => !s.demo && readingCategory(s) === "reading" &&
				s.source.kind === document.source.kind && s.source.path === document.source.path);
			const sameVersion = samePaper.filter(s => s.source.fingerprint === document.source.fingerprint)
				.sort((a,b) => Number(a.archived || false) - Number(b.archived || false) || Number(!!b.paperSpace) - Number(!!a.paperSpace) || b.updatedAt.localeCompare(a.updatedAt));
			// Reopen an older version for historical viewing only. A writable session must match the document.
			const existing = sameVersion[0] || (!forceNew || kind !== "code" ? matchingReading(sessions, document.source) : undefined) || samePaper[0];
			if (existing) {
				await document.destroy();
				this.assertOpen();
				if (kind !== "code" && existing.source.fingerprint === document.source.fingerprint && (!existing.paperSpace || existing.archived)) await this.repository.transact(existing.id, s => { s.paperSpace = true; s.archived = false; });
				return { id: existing.id, created: false };
			}
			const session = createReadingSession(document.source, backend, model);
			if (kind !== "code") session.paperSpace = true;
			return { id: await this.saveNewSession(document, session), created: true };
		}); this.openings = operation.catch(() => undefined); return operation;
	}
	document(sessionId: string): Promise<ReadingDocument> {
		let session: ReadingSession;
		try {
			this.assertOpen();
			session = this.repository.get(sessionId);
			if (session.demo) throw new Error("演示会话不读取论文或调用模型");
		} catch (error) { return Promise.reject(error); }
		const cached = this.documents.get(sessionId);
		if (cached) return Promise.resolve(cached);
		const pending = this.loadingDocuments.get(sessionId);
		if (pending) return pending;
		const loading = this.loadSessionDocument(session).finally(() => this.loadingDocuments.delete(sessionId));
		this.loadingDocuments.set(sessionId, loading);
		return loading;
	}
	private async loadSessionDocument(session: ReadingSession): Promise<ReadingDocument> {
		const { source } = session;
		const loaded = await this.openDocument(source.kind, source.path, session.id, session.id);
		try {
			this.assertOpen();
			if (loaded.source.fingerprint !== source.fingerprint) throw new Error("来源版本已变化，历史回答已保留；请核对原文版本后继续");
			this.documents.set(session.id, loaded);
			return loaded;
		} catch (error) { await loaded.destroy(); throw error; }
	}
	async relocate(sessionId: string, filename: string): Promise<void> {
		this.assertOpen();
		const original = structuredClone(this.repository.get(sessionId));
		if (original.demo) throw new Error("演示会话无需重新定位原文");
		const openKey = Symbol(original.id);
		return this.track(this.relocateDocument(original, filename, openKey), openKey);
	}
	private async relocateDocument(original: ReadingSession, filename: string, openKey: symbol): Promise<void> {
		const sessionId = original.id;
		const document = await this.openDocument(original.source.kind, filename, openKey, sessionId);
		try {
			if (document.source.fingerprint !== original.source.fingerprint) throw new Error("文件内容不同，请创建新会话，旧证据不能重新绑定");
			await document.verify();
			await this.repository.transact(sessionId, session => {
				this.assertOpen();
				if (session.source.path !== original.source.path || session.source.fingerprint !== original.source.fingerprint || session.nodes.some(n => n.status === "running" || n.status === "pending")) throw new Error("来源已变化或正在生成，请稍后重新定位");
				for (const node of session.nodes) for (const e of node.evidence.filter(e => e.kind === "paper" || e.kind === "code")) {
					const match = document.evidence.find(item => item.id === e.id); if (!match) throw new Error("新位置无法匹配既有证据"); e.path = match.path; e.asset = match.asset;
				}
				(session.sourceRelocations ||= []).push({ from: session.source.path, to: document.source.path, date: new Date().toISOString(), fingerprint: original.source.fingerprint });
				session.source.path = document.source.path;
				if (document.source.code) session.source.code = document.source.code;
			});
			this.assertOpen();
		} catch (error) { await document.destroy(); throw error; }
		const previous = this.documents.get(sessionId); this.documents.set(sessionId, document); await previous?.destroy();
	}
	async correct(sessionId: string, originalId: string, reason: string, quote?: ReadingQuote): Promise<string> {
		this.assertOpen();
		if (!reason.trim() || reason.length > 4000) throw new Error("请用 4000 字符以内描述要核对的问题"); let id = "";
		await this.repository.transact(sessionId, session => {
			const original = readingNode(session, originalId); const branch = addReadingBranch(session, original.id);
			const node = addReadingNode(session, branch.id, "核对并重新解释：" + reason.trim(), quote);
			node.correction = { of: originalId, originalHash: answerHash(original.content), reason: reason.trim() }; id = node.id;
		});
		await this.generatePrepared(sessionId, id, "background"); return id;
	}
	async demo(purpose: "demo" | "test" = "demo"): Promise<string> {
		await this.ready();
		const session = createReadingSession({ kind: "pdf", path: "demo://reading", fingerprint: "0".repeat(64), title: "交互演示（示例内容）" }); session.demo = true; session.purpose = purpose;
		const titles = ["研究问题是什么", "为什么这样设计实验", "图表如何支持结论"];
		for (const title of titles) {
			const node = addReadingNode(session, null); node.title = title; node.content = "这是用于验证阅读界面的示例内容，不代表任何论文结论。\n\n可以选择这段文字建立追问；导图节点单击选中，双击打开小窗查看回答。"; node.status = "done";
		}
		const branch = addReadingBranch(session, session.mainIds[1]);
		const node = addReadingNode(session, branch.id, "为什么需要对照组？"); node.status = "done"; node.content = "这是一条示例支线。你可以继续追问、拖动窗口，或将窗口固定后查看其他节点。";
		await this.repository.add(session); return session.id;
	}
	async advance(sessionId: string, tracking?: { expectedParentId: string | undefined; prepared(nodeId: string): Promise<void> }): Promise<void> {
		this.assertOpen();
		let id = "";
		await this.repository.transact(sessionId, (session) => {
			if (tracking && session.mainIds[session.mainIds.length - 1] !== tracking.expectedParentId) throw new Error("主线起点已变化，请重新准备操作");
			id = addReadingNode(session, null).id;
		});
		try { await tracking?.prepared(id); }
		catch (error) { await this.repository.transact(sessionId, session => { const node = readingNode(session, id); node.status = "failed"; node.error = "助手执行关联保存失败，尚未调用模型，可在此节点重试：" + String(error); }); throw error; }
		await this.generatePrepared(sessionId, id, "foreground");
	}
	async attachAnnotation(path: string, origin: AnnotationOrigin, signal: AbortSignal, profileId?: string) {
		const kind = /^papers\/[^/]+--jats--[^/]+\/article\.md$/.test(path) ? "structured" : "article";
		const { id } = await this.open(kind, path, profileId || "", "");
		const doc = await this.document(id);
		await doc.verify();
		// For validated MinerU packages the fingerprint also includes the package manifest.
		if (!/^papers\/[^/]+\/article\.md$/.test(path) && doc.source.fingerprint !== origin.englishDigest) throw new Error("批注英文来源已变化，请重新核对");
		let nodeId = "", created = false;
		await this.repository.transact(id, session => {
			signal.throwIfAborted();
			const existing = session.branches.find(b => b.annotation?.id === origin.id);
			if (existing) nodeId = existing.nodeIds[existing.nodeIds.length - 1];
			else {
				if (profileId) { session.backend = profileId; session.model = ""; }
				const branch = addReadingBranch(session, null, origin);
				nodeId = addReadingNode(session, branch.id, origin.question || origin.note || "如何理解这段话？").id;
				created = true;
			}
			session.ui.hideMap = false;
			session.ui.selectedId = nodeId;
		});
		if (created) await this.generatePrepared(id, nodeId, "background");
		return { sessionId: id, nodeId };
	}
	async ask(sessionId: string, parentId: string, question: string, branchId?: string, quote?: ReadingQuote, requestWeb = false, target?: ReadingNode["paperTarget"]): Promise<string> {
		this.assertOpen();
		if (!question.trim()) throw new Error("请输入问题");
		let id = "";
		await this.repository.transact(sessionId, (session) => {
			const branch = branchId ? session.branches.find((item) => item.id === branchId) : addReadingBranch(session, parentId);
			if (!branch) throw new Error("支线不存在");
			if (session.source.kind !== "code" && branchId && branch.nodeIds[branch.nodeIds.length-1] !== parentId) throw new Error("分支末轮已变化，请重新打开当前回答");
			id = addReadingNode(session, branch.id, question.trim(), quote).id;
			if (target) readingNode(session, id).paperTarget = target;
			if (requestWeb) readingNode(session, id).requestWeb = true;
		});
		await this.generatePrepared(sessionId, id, "background");
		return id;
	}
	private async generatePrepared(sessionId: string, id: string, delivery: "foreground" | "background"): Promise<void> {
		// The node may already be on disk when unloading wins the race with preparation.
		if (this.closingError) {
			await this.repository.saveGenerationFailure(sessionId, id, true, this.closingError);
			throw this.closingError;
		}
		const task = this.generate(sessionId, id, delivery);
		if (delivery === "foreground") await task;
	}
	async generate(sessionId: string, id: string, delivery: "foreground" | "background" = "foreground"): Promise<void> {
		this.assertOpen();
		const generation = this.runGeneration(sessionId, id);
		const reported = delivery === "background" ? generation.catch(error => this.repository.reportGenerationError(sessionId, id, error, this.closeReason)) : generation;
		return this.track(reported, sessionId);
	}
	/** start/end are relative to the catalog block. The host binds the immutable quote. */
	async askCode(sessionId: string, parentId: string, evidenceId: string, start: number, end: number, question: string): Promise<string> {
		if (!question.trim() || question.length > 4000) throw new Error("请用 4000 字符以内输入问题");
		const document = await this.document(sessionId); await document.verify();
		const evidence = document.evidence.find(e => e.id === evidenceId);
		if (!evidence || document.source.kind !== "code") throw new Error("源码选区不属于此会话");
		const quote = codeQuote(evidence, start, end); let id = "";
		await this.repository.transact(sessionId, session => {
			if (session.source.fingerprint !== document.source.fingerprint) throw new Error("源码版本已变化");
			const node = addReadingNode(session, addReadingBranch(session, parentId).id, question.trim());
			node.codeQuote = quote; node.evidence = [structuredClone(evidence)]; id = node.id;
		});
		await this.generatePrepared(sessionId, id, "background"); return id;
	}
	private async runGeneration(sessionId: string, id: string): Promise<void> {
		if (this.repository.get(sessionId).demo) {
			await this.repository.transact(sessionId, (session) => {
				const node = readingNode(session, id); node.status = "done"; node.title = node.question.slice(0, 24) || "下一步示例讲解";
				node.content = "【交互演示】\n\n" + (node.question ? "已记录你的问题：" + node.question : "点击箭头会继续主线讲解。") + "\n\n此内容仅用于验证交互，没有调用模型或分析真实论文。";
			}); return;
		}
		if (!this.generateHandler) {
			await this.repository.transact(sessionId, (session) => { const node = readingNode(session, id); node.status = "failed"; node.error = "模型讲解正在接入；可先使用交互演示验证界面"; }); return;
		}
		await this.generateHandler(sessionId, id);
	}
	stop(sessionId: string, id: string): void { this.stopHandler?.(sessionId, id); }
	close(): void {
		this.closingError ??= new Error("阅读工作区已关闭");
	}
	dispose(): Promise<void> {
		if (!this.disposal) {
			// Publish the promise before the synchronous unload callback can reenter dispose().
			let settle!: (draining: Promise<void>) => void;
			this.disposal = new Promise<void>(resolve => { settle = resolve; }).finally(() => this.repository.closeStorage());
			settle(this.drainBeforeClose());
		}
		return this.disposal;
	}
	private async drainBeforeClose(): Promise<void> {
		this.close();
		this.disposeHandler?.();
		const tasks = new Map(this.tasks);
		tasks.set(this.openings, QUEUED_OPEN);
		for (const [sessionId, loading] of this.loadingDocuments) tasks.set(loading, sessionId);
		const settled = Promise.allSettled(tasks.keys());
		if (this.pendingOpens.size) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, DOCUMENT_OPEN_DISPOSE_TIMEOUT_MS); });
			try { await Promise.race([settled, deadline]); }
			finally { clearTimeout(timer); }
		}
		if (this.pendingOpens.size) {
			console.warn("阅读工作区卸载等待文档打开超时，仍在加载：" + [...new Set(this.pendingOpens.values())].join("、"));
			// Tasks using an already open document must finish before the cache is destroyed.
			const remaining = [...tasks].filter(([, openKey]) => !this.pendingOpens.has(openKey));
			await Promise.allSettled(remaining.map(([task]) => task));
		} else {
			await settled;
		}
		await this.repository.flush();
		await Promise.allSettled([...this.documents.values()].map((document) => document.destroy())); this.documents.clear();
	}
}
