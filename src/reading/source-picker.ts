import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ReadingSource } from "./types";

export type SourceKind = ReadingSource["kind"];
export interface SourceEntry { path: string; name: string; directory: boolean; }
export interface SourceDialogOptions { title: string; defaultPath: string; properties: string[]; filters?: { name: string; extensions: string[] }[]; }
export type SourceDialog = (options: SourceDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
export function acceptsSourceFile(kind: SourceKind, filename: string): boolean {
	const name = filename.replace(/\\/g, "/").split("/").slice(-1)[0].toLowerCase();
	return kind === "pdf" ? name.endsWith(".pdf") : kind === "article" ? name === "article.md" : /\.(py|r)$/.test(name);
}
export function sourceDialogOptions(kind: SourceKind, directory: boolean, current: string, vaultRoot: string): SourceDialogOptions {
	if (directory && kind !== "code") throw new Error("当前来源需要选择文件");
	const value = current.trim().replace(/^"|"$/g, "");
	return { title: directory ? "选择代码项目文件夹" : kind === "code" ? "选择 Python/R 文件" : kind === "pdf" ? "选择 PDF" : "选择 MinerU article.md",
		defaultPath: value ? path.resolve(vaultRoot, value) : vaultRoot, properties: [directory ? "openDirectory" : "openFile"],
		...(directory ? {} : { filters: [{ name: kind === "pdf" ? "PDF" : kind === "article" ? "MinerU article.md" : "Python / R", extensions: kind === "pdf" ? ["pdf"] : kind === "article" ? ["md"] : ["py", "r", "R"] }] }) };
}
export const systemSourceDialog: SourceDialog = async options => {
	try {
		const electron = require("electron"); const remote = electron.remote || require("@electron/remote");
		if (!remote?.dialog?.showOpenDialog) throw new Error("系统窗口接口不可用");
		return await remote.dialog.showOpenDialog(remote.getCurrentWindow(), options);
	} catch { throw new Error("当前环境无法打开系统选择窗口，请使用 Vault 选择或手动输入"); }
};
export async function chooseSystemSource(kind: SourceKind, directory: boolean, current: string, vaultRoot: string, dialog: SourceDialog = systemSourceDialog): Promise<string | undefined> {
	const result = await dialog(sourceDialogOptions(kind, directory, current, vaultRoot));
	if (result.canceled || !result.filePaths.length) return;
	const chosen = result.filePaths[0];
	if (!path.isAbsolute(chosen) || !directory && !acceptsSourceFile(kind, chosen)) throw new Error(kind === "article" ? "请选择名为 article.md 的文件；打开时会验证 MinerU 包" : "所选文件与原文类型不匹配");
	return chosen;
}

const inside = (root: string, candidate: string): boolean => { const rel = path.relative(root, candidate); return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel); };
export function vaultSourcePath(root: string, relative: string): string {
	if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(p => p === ".." || p === "." || /[:\x00-\x1f]/.test(p))) throw new Error("Vault 目录路径无效");
	const absolute = path.resolve(root, relative); if (!inside(root, absolute)) throw new Error("目录超出 Vault"); return absolute;
}
/** List one expanded directory only. Never read file contents or follow a link outside the vault. */
export async function listVaultSources(root: string, relative: string, kind: SourceKind): Promise<SourceEntry[]> {
	const directory = vaultSourcePath(root, relative); const canonicalRoot = await fs.realpath(root), canonical = await fs.realpath(directory);
	if (!inside(canonicalRoot, canonical)) throw new Error("该目录链接指向 Vault 外部，请使用本机选择");
	const result: SourceEntry[] = []; let count = 0; const stream = await fs.opendir(directory);
	for await (const item of stream) {
		if (++count > 5000) throw new Error("此目录项目过多，请使用本机选择窗口定位来源");
		if (item.name.startsWith(".") || item.isSymbolicLink() || !item.isDirectory() && !item.isFile()) continue;
		if (!item.isDirectory() && !acceptsSourceFile(kind, item.name)) continue;
		result.push({ name: item.name, path: (relative ? relative + "/" : "") + item.name, directory: item.isDirectory() });
	}
	return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}
