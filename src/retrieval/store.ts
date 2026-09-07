import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DIMENSIONS, EMBEDDING_MODEL, INDEX_VERSION, type VectorSnapshot, type VectorStorage } from "./types";

const MAGIC = "RARBGE01"; const MAX_BYTES = 100 * 1024 * 1024; const MAX_VECTORS = 20000;
export function encodeIndex(index: VectorSnapshot): Buffer {
	const keys = [...index.vectors.keys()]; if (keys.length > MAX_VECTORS) throw new Error("向量索引超过 20,000 个片段上限");
	const metadata = Buffer.from(JSON.stringify({ version: INDEX_VERSION, model: EMBEDDING_MODEL, updated: index.updated, documentHashes: index.documentHashes, keys }), "utf8");
	const output = Buffer.alloc(12 + metadata.length + keys.length * DIMENSIONS * 4); if (output.length > MAX_BYTES) throw new Error("向量索引超过存储容量");
	output.write(MAGIC); output.writeUInt32LE(metadata.length, 8); metadata.copy(output, 12); let offset = 12 + metadata.length;
	for (const key of keys) { const vector = index.vectors.get(key)!; if (vector.length !== DIMENSIONS) throw new Error("向量维度无效"); for (const value of vector) { if (!Number.isFinite(value)) throw new Error("向量数值无效"); output.writeFloatLE(value, offset); offset += 4; } }
	return output;
}
export function decodeIndex(bytes: Buffer): VectorSnapshot {
	if (bytes.length < 12 || bytes.length > MAX_BYTES || bytes.toString("utf8", 0, 8) !== MAGIC) throw new Error("索引文件无效，请更新索引");
	const size = bytes.readUInt32LE(8); if (size > 8 * 1024 * 1024 || 12 + size > bytes.length) throw new Error("索引头部无效");
	const raw = JSON.parse(bytes.toString("utf8", 12, 12 + size));
	if (raw.version !== INDEX_VERSION || raw.model !== EMBEDDING_MODEL || !Array.isArray(raw.keys) || raw.keys.length > MAX_VECTORS ||
		new Set(raw.keys).size !== raw.keys.length || raw.keys.some((key: unknown) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) ||
		!raw.documentHashes || typeof raw.documentHashes !== "object" || Array.isArray(raw.documentHashes) ||
		Object.values(raw.documentHashes).some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) ||
		bytes.length !== 12 + size + raw.keys.length * DIMENSIONS * 4) throw new Error("索引版本或结构不兼容，请更新索引");
	const vectors = new Map<string, Float32Array>(); let offset = 12 + size;
	for (const key of raw.keys) {
		const vector = new Float32Array(DIMENSIONS); let norm = 0;
		for (let i = 0; i < DIMENSIONS; i++) { const value = bytes.readFloatLE(offset); offset += 4; if (!Number.isFinite(value)) throw new Error("索引向量损坏"); vector[i] = value; norm += value * value; }
		if (Math.abs(norm - 1) > 0.01) throw new Error("索引向量未归一化"); vectors.set(key, vector);
	}
	return { version: raw.version, model: raw.model, updated: String(raw.updated || ""), documentHashes: raw.documentHashes, vectors };
}
/** Derived cache only. Atomic replacement; never deletes source or history files. */
export class FileVectorStorage implements VectorStorage {
	private root: string;
	constructor(pluginDirectory: string) { this.root = path.resolve(pluginDirectory, "retrieval-index"); }
	private async prepare(): Promise<string> {
		await fs.mkdir(this.root, { recursive: true });
		if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("索引目录不能是符号链接");
		const target = path.join(this.root, "bge-v1.bin");
		for (const file of [target, target + ".pending"]) { try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("索引路径无效"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
		return target;
	}
	async read(): Promise<VectorSnapshot | null> {
		const target = await this.prepare();
		try { if ((await fs.stat(target)).size > MAX_BYTES) throw new Error("索引过大"); return decodeIndex(await fs.readFile(target)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	}
	async write(snapshot: VectorSnapshot): Promise<void> {
		const target = await this.prepare(); const bytes = encodeIndex(snapshot); const file = await fs.open(target + ".pending", "w", 0o600);
		try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
		await fs.rename(target + ".pending", target);
	}
}
