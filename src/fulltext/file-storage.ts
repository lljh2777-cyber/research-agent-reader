import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { acquisitionId, decodeArtifact, PDF_MAX_BYTES, type PdfArtifact, type AcquisitionJob, type AcquisitionMode, type AcquisitionSnapshot } from "./contracts";
import type { AcquisitionStorage } from "./repository";

/** Immutable journal records; .ready markers exclude torn writes. Never deletes files or directories. */
export class FileAcquisitionStorage implements AcquisitionStorage {
	private root: string;
	constructor(private pluginDirectory: string, private mode: AcquisitionMode) { this.root = path.resolve(pluginDirectory, "fulltext", mode); }
	private async directory(write: boolean): Promise<boolean> {
		const base = path.resolve(this.pluginDirectory);
		for (const dir of [base, path.join(base, "fulltext"), this.root]) {
			try { const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("获取存储目录必须是普通目录"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (!write) return false; await fs.mkdir(dir); }
		}
		if (await fs.realpath(this.root) !== path.join(await fs.realpath(base), "fulltext", path.basename(this.root))) throw new Error("获取存储目录解析不一致");
		return true;
	}
	private async read(filename: string): Promise<string> {
		const handle = await fs.open(path.join(this.root, filename), "r");
		try { const stat = await handle.stat(); const node = await fs.lstat(path.join(this.root, filename)); if (!stat.isFile() || node.isSymbolicLink() || stat.size > 256 * 1024 || stat.ino !== node.ino || stat.dev !== node.dev) throw new Error("获取存储文件无效");
			const text = await handle.readFile("utf8"); if (Buffer.byteLength(text) > 256 * 1024) throw new Error("获取记录过大"); return text;
		} finally { await handle.close(); }
	}
	private async names(): Promise<string[]> {
		if (!await this.directory(false)) return [];
		const names: string[] = [], handle = await fs.opendir(this.root);
		try { for (;;) { const entry = await handle.read(); if (!entry) break; if (names.length >= 20000) throw new Error("获取存储目录过大，请先整理记录"); names.push(entry.name); } }
		finally { await handle.close(); } return names;
	}
	async listJobs(): Promise<string[]> {
		const names = await this.names();
		return [...new Set(names.filter(n => /^a-[a-f0-9-]{36}\.\d+\.[a-f0-9-]{36}\.json\.ready$/.test(n)).map(n => n.slice(0, 38)))];
	}
	async readJob(id: string): Promise<unknown> {
		if (!acquisitionId(id) || id[0] !== "a") throw new Error("任务标识无效");
		const names = (await this.names()).filter(n => n.startsWith(id + ".") && /^a-[a-f0-9-]{36}\.\d+\.[a-f0-9-]{36}\.json\.ready$/.test(n));
		names.sort((a, b) => Number(b.split(".")[1]) - Number(a.split(".")[1]));
		if (!names.length) throw new Error("获取记录不存在");
		if (names.length > 1 && names[0].split(".")[1] === names[1].split(".")[1]) throw new Error("获取记录存在并发修订冲突");
		const revision = Number(names[0].split(".")[1]);
		if (!Number.isSafeInteger(revision) || revision < 1 || await this.read(names[0]) !== "ready") throw new Error("获取提交标记无效");
		const job = JSON.parse(await this.read(names[0].slice(0, -6)));
		if (job.id !== id || job.revision !== revision) throw new Error("获取修订与文件名不一致"); return job;
	}
	private async write(filename: string, value: unknown): Promise<void> {
		await this.directory(true);
		const bytes = Buffer.from(JSON.stringify(value), "utf8"); if (bytes.length > 256 * 1024) throw new Error("获取记录超过保存上限");
		const handle = await fs.open(path.join(this.root, filename), "wx", 0o600);
		try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
		if (!await this.directory(false)) throw new Error("获取存储目录已移走");
		const marker = await fs.open(path.join(this.root, filename + ".ready"), "wx", 0o600);
		try { await marker.writeFile("ready"); await marker.sync(); } finally { await marker.close(); }
	}
	async writeJob(job: AcquisitionJob): Promise<void> { if (!acquisitionId(job.id) || !Number.isSafeInteger(job.revision) || job.revision < 1) throw new Error("获取记录标识无效"); await this.write(`${job.id}.${job.revision}.${randomUUID()}.json`, job); }
	async readSnapshot(id: string): Promise<unknown> {
		if (!acquisitionId(id) || id[0] !== "s" || !await this.directory(false)) throw new Error("获取快照不存在");
		if (await this.read(id + ".json.ready") !== "ready") throw new Error("快照提交标记无效"); return JSON.parse(await this.read(id + ".json"));
	}
	async writeSnapshot(snapshot: AcquisitionSnapshot): Promise<void> {
		if (!acquisitionId(snapshot.id) || snapshot.id[0] !== "s") throw new Error("获取快照标识无效"); await this.write(snapshot.id + ".json", snapshot);
	}
	async beginArtifact(attemptId: string): Promise<ArtifactWriter> {
		if (this.mode !== "production" || !acquisitionId(attemptId) || attemptId[0] !== "a") throw new Error("PDF 尝试标识无效");
		await this.directory(true);
		const filename = attemptId + ".pdf", handle = await fs.open(path.join(this.root, filename), "wx", 0o600);
		let size = 0, closed = false, finished = false;
		const sha = createHash("sha256"), md5 = createHash("md5");
		return {
			write: async bytes => { if (closed || finished || size + bytes.length > PDF_MAX_BYTES) throw new Error("PDF 文件已关闭或超过 64 MiB"); await handle.writeFile(bytes); size += bytes.length; sha.update(bytes); md5.update(bytes); },
			finish: async () => { if (closed || finished) throw new Error("PDF 文件已经结束写入"); await handle.sync(); finished = true; return decodeArtifact({ filename, byteLength: size, sha256: sha.digest("hex"), md5: md5.digest("hex") }); },
			close: async () => { if (!closed) { closed = true; await handle.close(); } },
		};
	}
	async readArtifact(raw: PdfArtifact): Promise<Uint8Array> {
		const artifact = decodeArtifact(raw);
		if (this.mode !== "production" || !await this.directory(false)) throw new Error("PDF 快照存储不可用");
		const file = path.join(this.root, artifact.filename), handle = await fs.open(file, "r");
		try {
			const stat = await handle.stat(), node = await fs.lstat(file);
			if (!stat.isFile() || node.isSymbolicLink() || stat.ino !== node.ino || stat.dev !== node.dev || stat.size !== artifact.byteLength || stat.size > PDF_MAX_BYTES) throw new Error("PDF 快照文件已变化");
			// A file may grow after stat. Bound the read itself, not only the initial size check.
			const buffer = Buffer.alloc(artifact.byteLength + 1); let received = 0;
			while (received < buffer.length) { const { bytesRead } = await handle.read(buffer, received, buffer.length - received, received); if (!bytesRead) break; received += bytesRead; }
			const bytes = buffer.subarray(0, received);
			if (bytes.length !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256 || createHash("md5").update(bytes).digest("hex") !== artifact.md5) throw new Error("PDF 快照内容校验失败");
			return new Uint8Array(bytes);
		} finally { await handle.close(); }
	}
	async artifactPath(artifact:PdfArtifact):Promise<string> { await this.readArtifact(artifact); return path.join(this.root,artifact.filename); }
}

export interface ArtifactWriter { write(bytes: Uint8Array): Promise<void>; finish(): Promise<PdfArtifact>; close(): Promise<void>; }
export interface PdfArtifactStore { beginArtifact(attemptId: string): Promise<ArtifactWriter>; readArtifact(artifact: PdfArtifact): Promise<Uint8Array>; artifactPath?(artifact:PdfArtifact):Promise<string>; }
