import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeReadingSession, readingNode, validateReadingSession } from "./session";
import type { ReadingSession } from "./types";

export interface ReadingStorage {
	list(): Promise<string[]>;
	read(id: string): Promise<string>;
	readFile(id: string): Promise<{ text: string; mtime: Date }>;
	write(id: string, text: string): Promise<void>;
}
const ID = /^r-[a-f0-9-]{36}$/;
/** No retention or cleanup: interrupted pending files and all histories stay on disk. */
export class FileReadingStorage implements ReadingStorage {
	private readonly root: string;
	constructor(pluginDirectory: string, directory: "reading-sessions" | "reading-test-sessions" | "code-reading-sessions" = "reading-sessions") { this.root = path.resolve(pluginDirectory, directory); }
	private async prepare(): Promise<void> {
		await fs.mkdir(this.root, { recursive: true });
		if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("阅读存储目录不能是符号链接");
	}
	private filename(id: string): string {
		if (!ID.test(id)) throw new Error("阅读会话标识无效");
		return path.join(this.root, id + ".json");
	}
	async list(): Promise<string[]> {
		await this.prepare();
		return (await fs.readdir(this.root)).filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
	}
	async read(id: string): Promise<string> { return (await this.readFile(id)).text; }
	async readFile(id: string): Promise<{ text: string; mtime: Date }> {
		await this.prepare();
		const filename = this.filename(id);
		const stat = await fs.lstat(filename);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("阅读会话文件无效或过大");
		return { text: await fs.readFile(filename, "utf8"), mtime: stat.mtime };
	}
	async write(id: string, text: string): Promise<void> {
		await this.prepare();
		const filename = this.filename(id);
		const pending = filename + ".pending";
		for (const candidate of [filename, pending]) {
			try { if ((await fs.lstat(candidate)).isSymbolicLink()) throw new Error("阅读存储文件不能是符号链接"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error("阅读会话超过存储上限，历史已保留");
		const handle = await fs.open(pending, "w", 0o600);
		try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
		await fs.rename(pending, filename);
	}
}
/** Keep legacy files in place; new explicit test sessions have their own storage root. */
export class RoutedReadingStorage implements ReadingStorage {
	private locations = new Map<string, ReadingStorage>();
	constructor(private readonly regular: ReadingStorage, private readonly tests: ReadingStorage, private readonly code?: ReadingStorage) {}
	async list(): Promise<string[]> {
		for (const storage of [this.regular, this.tests, ...(this.code ? [this.code] : [])]) for (const id of await storage.list()) if (!this.locations.has(id)) this.locations.set(id, storage);
		return [...this.locations.keys()];
	}
	read(id: string): Promise<string> { return (this.locations.get(id) || this.regular).read(id); }
	readFile(id: string): Promise<{ text: string; mtime: Date }> { return (this.locations.get(id) || this.regular).readFile(id); }
	async write(id: string, text: string): Promise<void> {
		const session = JSON.parse(text);
		const storage = this.locations.get(id) || (session.purpose === "test" ? this.tests : session.source?.kind === "code" && this.code ? this.code : this.regular);
		await storage.write(id, text); this.locations.set(id, storage);
	}
}
function serializeReadingSession(session: ReadingSession): string {
	const nodes = session.nodes.map(node => {
		if (!node.quoteIssue) return node;
		const { quoteIssue, ...stored } = node;
		return stored;
	});
	return JSON.stringify({ ...session, nodes });
}

type GenerationFailure = { nodeId: string; error: unknown };
type ReadingChangeListener = (sessionId: string, failure?: GenerationFailure) => void;

export class ReadingRepository {
	readonly sessions = new Map<string, ReadingSession>();
	readonly loadIssues = new Map<string, { kind: "unreadable" | "interruption-save"; reason: string }>();
	get errors(): string[] { return Array.from(this.loadIssues, ([id, issue]) => id + ".json：" + issue.reason); }
	private queue: Promise<unknown> = Promise.resolve();
	readonly unsavedGenerationErrors = new Map<string, Map<string, string>>();
	private listeners = new Set<ReadingChangeListener>();
	constructor(private readonly storage: ReadingStorage) {}
	subscribe(listener: ReadingChangeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private emit(id: string, failure?: GenerationFailure): void { this.listeners.forEach((listener) => { try { listener(id, failure); } catch (error) { console.error("Reading view update failed", error); } }); }
	async reportGenerationError(id: string, nodeId: string, error: unknown): Promise<void> {
		const { status } = readingNode(this.get(id), nodeId);
		if (status === "interrupted") return;
		if (status === "pending" || status === "running") {
			try { await this.saveGenerationFailure(id, nodeId, false, error); }
			catch (saveError) { error = saveError; }
		}
		this.emit(id, { nodeId, error });
	}
	async load(): Promise<void> {
		for (const id of await this.storage.list()) {
			try {
				const file = await this.storage.readFile(id);
				const { session, repairedTimes } = decodeReadingSession(file.text, file.mtime);
				if (session.id !== id) throw new Error("会话标识与文件不一致");
				this.loadIssues.delete(id);
				let interrupted = false;
				for (const node of session.nodes) for (const entry of node.usage || []) if (entry.state === "running") { entry.state = "interrupted"; interrupted = true; }
				for (const node of session.nodes) if (node.status === "running" || node.status === "pending") {
					node.status = "interrupted"; node.error = "上次生成已中断，可重试"; interrupted = true;
				}
				if (interrupted && !repairedTimes) await this.storage.write(id, serializeReadingSession(session)).catch(error => {
					this.loadIssues.set(id, { kind: "interruption-save", reason: "已加载，但中断状态未能保存：" + String(error) });
				});
				this.sessions.set(id, session);
			} catch (error) {
				this.sessions.delete(id);
				this.loadIssues.set(id, { kind: "unreadable", reason: "无法加载：" + String(error) });
			}
		}
	}
	get(id: string): ReadingSession { const session = this.sessions.get(id); if (!session) throw new Error("阅读会话不存在"); return session; }
	async add(session: ReadingSession): Promise<void> {
		return this.serial(async () => {
			if (this.sessions.has(session.id)) throw new Error("阅读会话已存在");
			validateReadingSession(session);
			await this.storage.write(session.id, serializeReadingSession(session));
			this.sessions.set(session.id, structuredClone(session)); this.emit(session.id);
		});
	}
	saveGenerationFailure(id: string, nodeId: string, interrupted: boolean, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const reason = interrupted ? "生成已停止或超时，可重试。" + message : message;
		return this.editSession(id, draft => {
			const node = readingNode(draft, nodeId);
			node.status = interrupted ? "interrupted" : "failed";
			node.error = reason;
		}, (draft, saveError) => {
			const warning = "节点终态尚未保存：" + String(saveError);
			const warnings = this.unsavedGenerationErrors.get(id) ?? new Map<string, string>();
			warnings.set(nodeId, warning);
			this.unsavedGenerationErrors.set(id, warnings);
			this.sessions.set(id, draft); this.emit(id);
			throw Object.assign(new Error(reason + "\n" + warning), { cause: error, saveError });
		});
	}
	transact<T>(id: string, edit: (session: ReadingSession) => T): Promise<T> {
		return this.editSession(id, edit);
	}
	private editSession<T>(id: string, edit: (session: ReadingSession) => T, writeFailed?: (draft: ReadingSession, error: unknown) => never): Promise<T> {
		return this.serial(async () => {
			const draft = structuredClone(this.get(id));
			const result = edit(draft); draft.updatedAt = new Date().toISOString(); validateReadingSession(draft);
			const text = serializeReadingSession(draft);
			try { await this.storage.write(id, text); }
			catch (error) { writeFailed?.(draft, error); throw error; }
			this.loadIssues.delete(id);
			this.unsavedGenerationErrors.delete(id);
			this.sessions.set(id, draft); this.emit(id); return result;
		});
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
	}
	async flush(): Promise<void> { await this.queue; }
}
