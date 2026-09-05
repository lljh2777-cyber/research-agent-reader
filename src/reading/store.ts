import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateReadingSession } from "./session";
import type { ReadingSession } from "./types";

export interface ReadingStorage {
	list(): Promise<string[]>;
	read(id: string): Promise<string>;
	write(id: string, text: string): Promise<void>;
}
const ID = /^r-[a-f0-9-]{36}$/;
/** No retention or cleanup: interrupted pending files and all histories stay on disk. */
export class FileReadingStorage implements ReadingStorage {
	private readonly root: string;
	constructor(pluginDirectory: string) { this.root = path.resolve(pluginDirectory, "reading-sessions"); }
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
	async read(id: string): Promise<string> {
		await this.prepare();
		const filename = this.filename(id);
		const stat = await fs.lstat(filename);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("阅读会话文件无效或过大");
		return fs.readFile(filename, "utf8");
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
export class ReadingRepository {
	readonly sessions = new Map<string, ReadingSession>();
	readonly errors: string[] = [];
	private queue: Promise<unknown> = Promise.resolve();
	private listeners = new Set<(id: string) => void>();
	constructor(private readonly storage: ReadingStorage) {}
	subscribe(listener: (id: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private emit(id: string): void { this.listeners.forEach((listener) => listener(id)); }
	async load(): Promise<void> {
		for (const id of await this.storage.list()) {
			try {
				const session = validateReadingSession(JSON.parse(await this.storage.read(id)));
				if (session.id !== id) throw new Error("会话标识与文件不一致");
				let interrupted = false;
				for (const node of session.nodes) if (node.status === "running" || node.status === "pending") {
					node.status = "interrupted"; node.error = "上次生成已中断，可重试"; interrupted = true;
				}
				if (interrupted) await this.storage.write(id, JSON.stringify(session));
				this.sessions.set(id, session);
			} catch (error) { this.errors.push(id + ": " + String(error)); }
		}
	}
	get(id: string): ReadingSession { const session = this.sessions.get(id); if (!session) throw new Error("阅读会话不存在"); return session; }
	async add(session: ReadingSession): Promise<void> {
		return this.serial(async () => {
			if (this.sessions.has(session.id)) throw new Error("阅读会话已存在");
			validateReadingSession(session);
			await this.storage.write(session.id, JSON.stringify(session));
			this.sessions.set(session.id, structuredClone(session)); this.emit(session.id);
		});
	}
	async transact<T>(id: string, edit: (session: ReadingSession) => T): Promise<T> {
		return this.serial(async () => {
			const draft = structuredClone(this.get(id));
			const result = edit(draft); draft.updatedAt = new Date().toISOString(); validateReadingSession(draft);
			await this.storage.write(id, JSON.stringify(draft));
			this.sessions.set(id, draft); this.emit(id); return result;
		});
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
	}
	async flush(): Promise<void> { await this.queue; }
}
