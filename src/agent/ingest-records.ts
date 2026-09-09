import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { PaperIngestFlowOptions } from "./paper-ingest-flow";
import { decodeIntakeRef } from "../fulltext/contracts";

export interface IngestRequest { version: 1; runId: string; profileId: string; options: PaperIngestFlowOptions; }
export function validateIngestRequest(value: unknown, runId: string): IngestRequest {
	const r = value as IngestRequest; const o = r?.options;
	if (r?.version !== 1 || r.runId !== runId || typeof r.profileId !== "string" || !o) throw new Error("没有可恢复的入库参数");
	for (const field of ["sourcePdfPath", "requestNotes", "identityCandidateTitle", "identityCandidateDoi", "mineruLanguage", "mineruPages"] as const)
		if (typeof o[field] !== "string" || o[field].length > 16000) throw new Error("入库参数无效");
	for (const field of ["createArticleMarkdown", "createArticleWiki", "mineruOcr", "mineruFormula", "mineruTable", "mineruIncludeSourcePdf", "remoteUploadConfirmed"] as const)
		if (typeof o[field] !== "boolean") throw new Error("入库选项无效");
	if (!/\.pdf$/i.test(o.sourcePdfPath) || !["auto", "pdf", "article"].includes(o.articleWikiSource) || !["auto", "vlm", "pipeline", "html"].includes(o.mineruModel)
		|| !Number.isFinite(o.mineruTimeoutSeconds) || o.mineruTimeoutSeconds < 60 || o.mineruTimeoutSeconds > 1800) throw new Error("入库来源或解析参数无效");
	const copy=structuredClone(r); if(o.acquisitionSource!==undefined)copy.options.acquisitionSource=decodeIntakeRef(o.acquisitionSource); return copy;
}

/** Private request and write journals; neither credentials nor model-supplied paths. */
export class IngestRecords {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private pluginDirectory: string) {}
	private async file(kind: "request" | "registration", id: string): Promise<string> {
		const root = path.join(this.pluginDirectory, "ingest-records"); await fs.mkdir(root, { recursive: true });
		if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("入库记录目录不能是符号链接");
		return path.join(root, kind + "-" + createHash("sha256").update(id).digest("hex") + ".json");
	}
	async read(kind: "request" | "registration", id: string): Promise<unknown | null> {
		const file = await this.file(kind, id);
		try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("入库记录无效或过大"); return JSON.parse(await fs.readFile(file, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	}
	write(kind: "request" | "registration", id: string, value: unknown): Promise<void> {
		const text = JSON.stringify(value); const task = this.queue.then(async () => {
			if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("入库记录过大"); const file = await this.file(kind, id);
			for (const target of [file, file + ".pending"]) { try { const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("记录路径无效"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
			const handle = await fs.open(file + ".pending", "w", 0o600); try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
			await fs.rename(file + ".pending", file);
		}); this.queue = task.catch(() => undefined); return task;
	}
}
