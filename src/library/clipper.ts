import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { FileSourceStorage } from "../sources/storage";
import type { LibrarySourceObject } from "./types";

export const CLIPPER_PREFIX = "@paper-clipper/";
const articleLimit = 16 * 1024 * 1024;
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const isClipperPath = (name: string): boolean => /^@paper-clipper\/[a-f0-9]{64}\//.test(name);
export interface ClippedPaper { key: string; folder: string; title: string; doi: string; englishDigest: string; bilingual: boolean; }
export interface ClipScan { papers: ClippedPaper[]; issues: string[]; }
const providers = new WeakMap<object, ClipperDirectory>();
export function setClipperDirectory(app: object, root: string): void {
	if (root.trim() && !path.isAbsolute(root.trim())) throw new Error("请选择外部文献目录的绝对路径");
	if (root.trim()) providers.set(app, new ClipperDirectory(path.resolve(root.trim())));
	else providers.delete(app);
}
export function clipperDirectory(app: object): ClipperDirectory | undefined { return providers.get(app); }
export function requireClipper(app: object): ClipperDirectory {
	const directory = providers.get(app);
	if (!directory) throw new Error("请在阅读器设置中指定 Paper Clipper 文献目录");
	return directory;
}
export function clipSource(p: ClippedPaper): LibrarySourceObject {
	const location = CLIPPER_PREFIX + p.key + "/paper.md";
	return { kind: "source", id: location, title: p.title, identifiers: p.doi ? { doi: p.doi } : {},
		source: { path: location, bilingual: p.bilingual, format: "markdown", saved: true, verification: { state: "verified", fingerprint: p.englishDigest } } };
}

/** Only the immediate paper packages are indexed. Every file read uses link-checked, bounded IO. */
export class ClipperDirectory {
	private readonly storage: FileSourceStorage;
	private entries = new Map<string, ClippedPaper>();
	constructor(readonly root: string) { this.storage = new FileSourceStorage(root); }
	async scan(signal?: AbortSignal): Promise<ClipScan> {
		const entries = await fs.readdir(this.root, { withFileTypes: true }), papers: ClippedPaper[] = [], issues: string[] = [];
		const seen = new Set<string>(), duplicates = new Set<string>();
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (!entry.isDirectory() || /^[._]/.test(entry.name)) continue;
			try {
				const paper = await this.inspect(entry.name);
				if (!paper) continue;
				if (seen.has(paper.key)) { duplicates.add(paper.key); issues.push("多个文件夹对应同一剪藏来源，请核对：" + entry.name); }
				seen.add(paper.key); papers.push(paper);
			} catch (error) { issues.push(entry.name + " · " + (error instanceof Error ? error.message : String(error))); }
		}
		signal?.throwIfAborted();
		const unique = papers.filter(paper => !duplicates.has(paper.key));
		this.entries = new Map(unique.map(paper => [paper.key, paper]));
		return { papers: unique, issues };
	}
	private async inspect(folder: string): Promise<ClippedPaper | undefined> {
		const bytes = await this.storage.read(folder + "/paper.md", articleLimit);
		if (!bytes) return;
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)?.[1] || "";
		const field = (key: string) => new RegExp("^" + key + ":\\s*(.+)$", "m").exec(frontmatter)?.[1].trim().replace(/^["']|["']$/g, "") || "";
		const manifest = await this.storage.read(folder + "/translation.json", 256 * 1024);
		let meta: Record<string, unknown> = {};
		if (manifest) { try { meta = JSON.parse(new TextDecoder().decode(manifest)) || {}; } catch { /* English stays readable. */ } }
		const title = field("title") || (typeof meta.title === "string" && meta.title) || /^#\s+(.+)$/m.exec(raw)?.[1] || folder;
		const source = field("source") || field("url");
		const doi = (field("doi") || (typeof meta.doi === "string" ? meta.doi : "")).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
		const englishDigest = digest(bytes), key = digest(source || doi || englishDigest);
		const files = await this.storage.list(folder);
		return { key, folder, title, doi, englishDigest, bilingual: !!manifest && files.some(f => !f.directory && f.name === "paper.zh-CN.md") };
	}
	async sourceForFile(filename: string): Promise<string | undefined> {
		const relative = path.relative(this.root, filename);
		const parts = relative.split(path.sep);
		if (parts.length !== 2 || parts[0].startsWith(".") || parts[1] !== "paper.md") return;
		const paper = await this.inspect(parts[0]);
		if (!paper) return;
		const current = await this.paper(paper.key);
		if (current.folder !== parts[0]) throw new Error("文献目录有相同来源，请核对文件夹");
		return CLIPPER_PREFIX + paper.key + "/paper.md";
	}
	async paper(key: string): Promise<ClippedPaper> {
		const cached = this.entries.get(key);
		if (cached) { const current = await this.inspect(cached.folder); if (current?.key === key) return current; }
		const match = (await this.scan()).papers.find(p => p.key === key);
		if (!match) throw new Error("当前目录找不到这篇论文，或有多个文件夹对应同一来源");
		return match;
	}
	async read(virtualPath: string, limit?: number): Promise<Uint8Array | null> {
		const parts = virtualPath.split("/");
		if (!isClipperPath(virtualPath) || !/^(?:paper(?:\.zh-CN)?\.md|translation\.json|images\/[^:]+)$/i.test(parts.slice(2).join("/"))) throw new Error("外部文献资源路径无效");
		const cached = this.entries.get(parts[1]) || await this.paper(parts[1]);
		return this.storage.read(cached.folder + "/" + parts.slice(2).join("/"), limit);
	}
	async text(virtualPath: string): Promise<string> {
		await this.paper(virtualPath.split("/")[1]);
		const bytes = await this.read(virtualPath, articleLimit);
		if (!bytes) throw new Error("外部原文已移动或缺失，请刷新文献库");
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	}
}
