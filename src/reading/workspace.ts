import type { App } from "obsidian";
import { ReadingDocumentLoader, type ReadingDocument } from "./document";
import { FileReadingStorage, ReadingRepository } from "./store";
import { addReadingBranch, addReadingNode, createReadingSession, readingNode } from "./session";
import type { ReadingNode, ReadingQuote, ReadingSession, ReadingSource } from "./types";

export class ReadingWorkspaceService {
	readonly repository: ReadingRepository;
	readonly loader: ReadingDocumentLoader;
	private documents = new Map<string, ReadingDocument>();
	private initialization: Promise<void> | null = null;
	private tasks = new Set<Promise<void>>();
	generateHandler?: (sessionId: string, nodeId: string) => Promise<void>;
	stopHandler?: (sessionId: string, nodeId: string) => void;
	disposeHandler?: () => void;
	constructor(app: App, vaultRoot: string, pluginDirectory: string) {
		this.repository = new ReadingRepository(new FileReadingStorage(pluginDirectory));
		this.loader = new ReadingDocumentLoader(app, vaultRoot);
	}
	async ready(): Promise<void> { if (!this.initialization) this.initialization = this.repository.load(); return this.initialization; }
	async create(kind: ReadingSource["kind"], filename: string, backend: string, model: string): Promise<string> {
		await this.ready(); const document = await this.loader.open(kind, filename);
		const session = createReadingSession(document.source, backend, model);
		try { await this.repository.add(session); this.documents.set(session.id, document); return session.id; }
		catch (error) { await document.destroy(); throw error; }
	}
	async document(sessionId: string): Promise<ReadingDocument> {
		const session = this.repository.get(sessionId);
		if (session.demo) throw new Error("演示会话不读取论文或调用模型");
		let loaded = this.documents.get(sessionId);
		if (!loaded) {
			loaded = await this.loader.open(session.source.kind, session.source.path);
			if (loaded.source.fingerprint !== session.source.fingerprint) { await loaded.destroy(); throw new Error("来源已变化，请重新选择来源创建会话"); }
			this.documents.set(sessionId, loaded);
		}
		return loaded;
	}
	async demo(): Promise<string> {
		await this.ready();
		const session = createReadingSession({ kind: "pdf", path: "demo://reading", fingerprint: "0".repeat(64), title: "交互演示（示例内容）" }); session.demo = true;
		const titles = ["研究问题是什么", "为什么这样设计实验", "图表如何支持结论"];
		for (const title of titles) {
			const node = addReadingNode(session, null); node.title = title; node.content = "这是用于验证阅读界面的示例内容，不代表任何论文结论。\n\n可以选择这段文字建立追问，或点击右侧节点查看对应的回答。"; node.status = "done";
		}
		const branch = addReadingBranch(session, session.mainIds[1]);
		const node = addReadingNode(session, branch.id, "为什么需要对照组？"); node.status = "done"; node.content = "这是一条示例支线。你可以继续追问、拖动窗口，或将窗口固定后查看其他节点。";
		await this.repository.add(session); return session.id;
	}
	async advance(sessionId: string): Promise<void> {
		let id = "";
		await this.repository.transact(sessionId, (session) => { id = addReadingNode(session, null).id; });
		await this.generate(sessionId, id);
	}
	async ask(sessionId: string, parentId: string, question: string, branchId?: string, quote?: ReadingQuote): Promise<string> {
		if (!question.trim()) throw new Error("请输入问题");
		let id = "";
		await this.repository.transact(sessionId, (session) => {
			const branch = branchId ? session.branches.find((item) => item.id === branchId) : addReadingBranch(session, parentId);
			if (!branch) throw new Error("支线不存在");
			id = addReadingNode(session, branch.id, question.trim(), quote).id;
		});
		void this.generate(sessionId, id).catch(() => undefined);
		return id;
	}
	generate(sessionId: string, id: string): Promise<void> {
		const task = this.runGeneration(sessionId, id); this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
		return task;
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
	async dispose(): Promise<void> {
		this.disposeHandler?.(); await Promise.allSettled([...this.tasks]); await this.repository.flush();
		await Promise.allSettled([...this.documents.values()].map((document) => document.destroy())); this.documents.clear();
	}
}
