import type { App } from "obsidian";
import { MineruPackageLoader } from "../mineru/package-loader";
import type { LibraryReadStorage } from "./reader";

/** Uses the same full loader as the reader; no workspace recovery, external source or writer. */
export function libraryMineruVerifier(app: App, signal?: AbortSignal) {
	return async (articlePath: string, storage: LibraryReadStorage): Promise<void> => {
		await new MineruPackageLoader(app, { signal, readFile: async (_app, name, limit) => {
			const bytes = await storage.read(name, limit);
			if (!bytes) throw new Error("MinerU 核验文件已不存在：" + name);
			return bytes;
		} }).load(articlePath);
	};
}
