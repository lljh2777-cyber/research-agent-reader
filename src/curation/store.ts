import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CurationRecordStore, CurationReview, CurationRevision } from "./types";

const ID = /^c-[a-f0-9-]{36}$/;
/** One atomic file per review/revision. No retention deletion; failed pending writes remain. */
export class FileCurationStore implements CurationRecordStore {
	private root: string; private queue: Promise<unknown> = Promise.resolve();
	constructor(pluginDirectory: string) { this.root = path.resolve(pluginDirectory, "knowledge-reviews"); }
	private async directory(kind: "reviews" | "revisions"): Promise<string> {
		if (!["reviews", "revisions"].includes(kind)) throw new Error("整理存储类别无效");
		for (const folder of [this.root, path.join(this.root, kind)]) { await fs.mkdir(folder, { recursive: true }); if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error("整理目录不能是符号链接"); }
		return path.join(this.root, kind);
	}
	async list(kind: "reviews" | "revisions"): Promise<string[]> { return (await fs.readdir(await this.directory(kind))).filter(name => name.endsWith(".json") && ID.test(name.slice(0, -5))).map(name => name.slice(0, -5)); }
	async read(kind: "reviews" | "revisions", id: string): Promise<unknown> {
		if (!ID.test(id)) throw new Error("整理记录标识无效"); const file = path.join(await this.directory(kind), id + ".json"); const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("整理记录文件无效或过大"); return JSON.parse(await fs.readFile(file, "utf8"));
	}
	write(kind: "reviews" | "revisions", record: CurationReview | CurationRevision): Promise<void> {
		const snapshot = JSON.stringify(record); const id = record.id;
		const task = this.queue.then(async () => {
			if (!ID.test(id) || Buffer.byteLength(snapshot) > 8 * 1024 * 1024) throw new Error("整理记录无效或过大");
			const file = path.join(await this.directory(kind), id + ".json");
			for (const target of [file, file + ".pending"]) { try { const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("整理存储路径无效"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
			const handle = await fs.open(file + ".pending", "w", 0o600); try { await handle.writeFile(snapshot, "utf8"); await handle.sync(); } finally { await handle.close(); }
			await fs.rename(file + ".pending", file);
		}); this.queue = task.catch(() => undefined); return task;
	}
}
