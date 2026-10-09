import { TFile, FileSystemAdapter, type App } from "obsidian";
import { FileSourceStorage } from "../sources/storage";
import { PAGE_FOLDERS, type PageFiles, type PageWrite } from "./page";

/** Fresh bounded disk reads plus Obsidian's create/process API for visible Markdown updates. */
export class VaultPageFiles implements PageFiles {
	private io: FileSourceStorage;
	constructor(private app: App) {
		if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error("新知识页保存需要桌面文件系统");
		this.io = new FileSourceStorage(app.vault.adapter.getBasePath());
	}
	async read(path: string): Promise<string | null> { const bytes = await this.io.read(path, 1024 * 1024); return bytes === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	async list(): Promise<string[]> {
		const out: string[] = [], directories: string[] = Object.values(PAGE_FOLDERS); let seen = 0;
		while (directories.length) {
			const dir = directories.pop()!; if (++seen > 500) throw new Error("知识目录超过 500 个，无法完成查重");
			for (const entry of await this.io.list(dir)) { const path = dir + "/" + entry.name; out.push(path); if (out.length > 5000) throw new Error("知识目录超过 5,000 项，无法完成查重"); if (entry.directory && !entry.name.startsWith(".")) directories.push(path); }
		} return out;
	}
	async directory(path: string): Promise<boolean> {
		const stat = await this.app.vault.adapter.stat(path); if (!stat) return false;
		if (stat.type !== "folder") throw new Error("目标父路径不是目录：" + path);
		await this.io.list(path); return true;
	}
	async mkdir(path: string): Promise<void> {
		if (await this.directory(path)) return;
		try { await this.app.vault.createFolder(path); } catch (error) { if (!await this.directory(path)) throw error; }
		if (!await this.directory(path)) throw new Error("目录创建失败：" + path);
	}
	async write(w: PageWrite, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted(); const current = await this.read(w.path); signal?.throwIfAborted();
		if (current === w.after) return;
		if (current !== w.before) throw new Error("写入前文件已变化：" + w.path);
		if (w.before === null) {
			try { await this.app.vault.create(w.path, w.after); } catch (error) { if (await this.read(w.path) !== w.after) throw error; }
		} else {
			const file = this.app.vault.getAbstractFileByPath(w.path); if (!(file instanceof TFile)) throw new Error("待更新文件缺失：" + w.path);
			await this.app.vault.process(file, text => { signal?.throwIfAborted(); if (file.path !== w.path || this.app.vault.getAbstractFileByPath(w.path) !== file || text !== w.before && text !== w.after) throw new Error("写入期间文件变化：" + w.path); return w.after; });
		}
		if (await this.read(w.path) !== w.after) throw new Error("写入后文件无法核对：" + w.path);
	}
}
