import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const CODE_LIMITS = { files: 160, entries: 10_000, depth: 16, fileBytes: 512 * 1024, totalBytes: 4 * 1024 * 1024, blockChars: 8000, blockLines: 80 };
export type CodeLanguage = "python" | "r" | "text";
export interface CodeFile { path: string; hash: string; bytes: number; language: CodeLanguage; lines: number; }
export interface CodeSnapshot { version: 1; scope: "file" | "project"; root: string; files: CodeFile[]; }
export interface CodeEvidence {
	id: string; kind: "code"; path: string; label: string; text: string; sourceHash: string;
	start: number; end: number; startLine: number; endLine: number; language: CodeLanguage;
}
export interface CodeSourceIO {
	stat(filename: string): Promise<{ file: boolean; directory: boolean; link: boolean; size: number }>;
	realpath(filename: string): Promise<string>;
	list(directory: string): Promise<string[]>;
	read(filename: string, limit: number): Promise<Uint8Array>;
}
export const nativeCodeIO: CodeSourceIO = {
	async stat(filename) { const s = await fs.lstat(filename); return { file: s.isFile(), directory: s.isDirectory(), link: s.isSymbolicLink(), size: s.size }; },
	realpath: filename => fs.realpath(filename), list: directory => fs.readdir(directory),
	async read(filename, limit) {
		const file = await fs.open(filename, "r");
		try {
			if (!(await file.stat()).isFile()) throw new Error("代码来源不是普通文件");
			const bytes = Buffer.alloc(limit + 1); let used = 0;
			while (used < bytes.length) { const result = await file.read(bytes, used, bytes.length - used, used); if (!result.bytesRead) break; used += result.bytesRead; }
			if (used > limit) throw new Error("代码文件超过读取上限"); return bytes.subarray(0, used);
		} finally { await file.close(); }
	},
};
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const excluded = new Set(["node_modules", "venv", "env", "renv", "packrat", "__pycache__", "dist", "build", "site-packages"]);
function language(filename: string): CodeLanguage | undefined {
	const name = path.basename(filename).toLowerCase();
	if (name.startsWith(".")) return undefined;
	if (name.endsWith(".py")) return "python";
	if (name.endsWith(".r")) return "r";
	if (/^readme(?:\.(?:md|txt|rst))?$/.test(name) || /^requirements(?:[-_.][\w-]+)?\.txt$/.test(name)
		|| ["pyproject.toml", "setup.cfg", "description", "environment.yml", "environment.yaml"].includes(name)) return "text";
	return undefined;
}
function relativeFile(value: string): boolean { return Boolean(value) && !path.isAbsolute(value) && !value.includes("\\") && !value.split("/").some(p => !p || p === "." || p === ".." || /[:\x00-\x1f]/.test(p)); }
function lineRanges(text: string): Array<{ start: number; end: number }> {
	const result: Array<{ start: number; end: number }> = []; let start = 0;
	for (const match of text.matchAll(/\r\n|\n|\r/g)) { const end = match.index! + match[0].length; result.push({ start, end }); start = end; }
	if (start < text.length) result.push({ start, end: text.length }); return result;
}
export function codeFingerprint(snapshot: CodeSnapshot): string {
	return hash(JSON.stringify([snapshot.version, snapshot.scope, snapshot.files.map(f => [f.path, f.hash])]));
}
export function validateCodeSnapshot(value: unknown): CodeSnapshot {
	const s = value as CodeSnapshot;
	if (!s || s.version !== 1 || !["file", "project"].includes(s.scope) || typeof s.root !== "string" || !path.isAbsolute(s.root)
		|| !Array.isArray(s.files) || !s.files.length || s.files.length > CODE_LIMITS.files) throw new Error("代码来源快照无效");
	const seen = new Set<string>(); let size = 0;
	for (const f of s.files) {
		if (!f || typeof f.path !== "string" || !relativeFile(f.path) || seen.has(f.path) || !/^[a-f0-9]{64}$/.test(f.hash)
			|| !Number.isInteger(f.bytes) || f.bytes < 0 || f.bytes > CODE_LIMITS.fileBytes || !Number.isInteger(f.lines) || f.lines < 0
			|| language(f.path) !== f.language || !f.language) throw new Error("代码文件清单无效");
		seen.add(f.path); size += f.bytes;
	}
	if (size > CODE_LIMITS.totalBytes || s.scope === "file" && (s.files.length !== 1 || s.files[0].language === "text")) throw new Error("代码来源范围无效");
	return s;
}
export interface CodeProjectDocument {
	source: { kind: "code"; path: string; fingerprint: string; title: string; code: CodeSnapshot };
	evidence: CodeEvidence[]; catalog: string; skipped: number;
	readRange(relativePath: string, startLine: number, endLine: number): CodeEvidence;
	verify(): Promise<void>;
	image(): Promise<null>; destroy(): Promise<void>;
}
/** Reads a bounded source set, never imports/executes project code or follows links. */
export async function openCodeProject(rawPath: string, io: CodeSourceIO = nativeCodeIO, signal?: AbortSignal): Promise<CodeProjectDocument> {
	if (!rawPath.trim() || /[\x00-\x1f]/.test(rawPath)) throw new Error("请选择 Python/R 文件或项目目录");
	const input = path.resolve(rawPath); const inputStat = await io.stat(input);
	if (inputStat.link || !inputStat.file && !inputStat.directory) throw new Error("代码来源不能是链接或特殊文件");
	if (inputStat.file && !["python", "r"].includes(language(input) || "")) throw new Error("单文件阅读仅支持 .py 和 .R；Notebook 与 R Markdown 暂未支持");
	const canonicalInput = await io.realpath(input); const root = inputStat.directory ? canonicalInput : path.dirname(canonicalInput);
	const files: CodeFile[] = []; const contents = new Map<string, string>(); let total = 0; let entries = 0; let skipped = 0;
	const scan = async (filename: string, depth: number): Promise<void> => {
		signal?.throwIfAborted(); if (++entries > CODE_LIMITS.entries || depth > CODE_LIMITS.depth) throw new Error("项目目录过大或过深，请选择具体子目录");
		const stat = await io.stat(filename); if (stat.link) { skipped++; return; }
		const resolved = await io.realpath(filename); const relative = path.relative(root, resolved);
		if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative) || path.relative(filename, resolved)) throw new Error("代码路径已变化或超出所选目录");
		if (stat.directory) {
			for (const name of (await io.list(filename)).sort()) {
				if (name !== path.basename(name) || name === "." || name === "..") throw new Error("项目目录包含无效路径");
				if (name.startsWith(".") || excluded.has(name.toLowerCase())) { skipped++; continue; }
				await scan(path.join(filename, name), depth + 1);
			} return;
		}
		const lang = language(filename); if (!stat.file || !lang) { skipped++; return; }
		if (files.length >= CODE_LIMITS.files || stat.size > CODE_LIMITS.fileBytes) throw new Error("源码文件过多或单文件超过 512 KiB，请缩小阅读范围");
		const bytes = await io.read(filename, CODE_LIMITS.fileBytes); total += bytes.byteLength;
		if (bytes.byteLength > CODE_LIMITS.fileBytes || total > CODE_LIMITS.totalBytes) throw new Error("源码总量超过 4 MiB，请选择更小的项目范围");
		let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("代码文件不是有效 UTF-8：" + relative); }
		if (text.includes("\0")) throw new Error("源码文件包含二进制内容：" + relative);
		const ranges = lineRanges(text); if (ranges.some(r => r.end - r.start > CODE_LIMITS.blockChars)) throw new Error("源码包含过长单行，请选择其他文件：" + relative);
		const rel = relative.split(path.sep).join("/"); if (!relativeFile(rel)) throw new Error("源码相对路径无效");
		files.push({ path: rel, hash: hash(bytes), bytes: bytes.byteLength, language: lang, lines: ranges.length }); contents.set(rel, text);
	};
	await scan(canonicalInput, 0); signal?.throwIfAborted();
	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	if (!files.some(f => f.language !== "text" && f.lines)) throw new Error("所选范围没有可读取的 Python/R 源码");
	const snapshot = validateCodeSnapshot({ version: 1, scope: inputStat.directory ? "project" : "file", root, files });
	const fingerprint = codeFingerprint(snapshot);
	const readRange = (relativePath: string, startLine: number, endLine: number): CodeEvidence => {
		const file = files.find(f => f.path === relativePath); const text = contents.get(relativePath);
		if (!file || text === undefined || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > file.lines
			|| endLine - startLine >= CODE_LIMITS.blockLines) throw new Error("代码引用的文件或行号超出所选范围");
		const ranges = lineRanges(text); const start = ranges[startLine - 1].start; const end = ranges[endLine - 1].end;
		if (end - start > CODE_LIMITS.blockChars) throw new Error("代码引用过长，请缩小行号范围");
		return { id: "code-" + hash(relativePath + "|" + file.hash).slice(0, 20) + "-" + startLine + "-" + endLine, kind: "code", path: relativePath,
			label: relativePath + ":" + startLine + "–" + endLine, text: text.slice(start, end), sourceHash: file.hash, start, end, startLine, endLine, language: file.language };
	};
	const evidence: CodeEvidence[] = [];
	for (const file of files) {
		const text = contents.get(file.path)!; const ranges = lineRanges(text); let start = 0;
		while (start < ranges.length) {
			let end = start;
			while (end + 1 < ranges.length && end + 1 - start < CODE_LIMITS.blockLines && ranges[end + 1].end - ranges[start].start <= CODE_LIMITS.blockChars) end++;
			const item = readRange(file.path, start + 1, end + 1); if (item.text.trim()) evidence.push(item); start = end + 1;
		}
	}
	const headings = evidence.map(e => e.id + " " + e.label);
	const room = 48_000 - headings.join("\n").length - evidence.length;
	if (room < 0) throw new Error("代码索引超过本轮支持范围，请选择具体脚本或子目录");
	const preview = Math.min(240, Math.floor(room / Math.max(1, evidence.length)));
	const catalog = evidence.map((e, i) => headings[i] + " " + e.text.replace(/\s+/g, " ").slice(0, preview)).join("\n");
	return { source: { kind: "code", path: canonicalInput, fingerprint, title: path.basename(canonicalInput), code: snapshot }, evidence, catalog, skipped, readRange,
		image: async () => null, destroy: async () => { contents.clear(); },
		async verify() { const current = await openCodeProject(canonicalInput, io, signal); try { if (current.source.fingerprint !== fingerprint) throw new Error("源码已变化，请创建新版本阅读会话；旧回答与依据保留"); } finally { await current.destroy(); } },
	};
}
