import { App, TFile, normalizePath } from "obsidian";

import { MineruPackageLoader } from "../mineru/package-loader";
import type { MineruReaderPackage } from "../mineru/types";
import { buildMarkdownReaderPackage } from "./clipping-markdown";

const MAX_MARKDOWN_BYTES = 64 * 1024 * 1024;

export class ReaderDocumentLoader {
	private readonly mineruLoader: MineruPackageLoader;

	constructor(private readonly app: App) {
		this.mineruLoader = new MineruPackageLoader(app);
	}

	async load(rawArticlePath: string): Promise<MineruReaderPackage> {
		const articlePath = normalizePath(rawArticlePath.trim());
		if (/^papers\/[^/]+\/article\.md$/i.test(articlePath)) {
			return this.mineruLoader.load(articlePath);
		}
		const file = this.app.vault.getAbstractFileByPath(articlePath);
		if (!(file instanceof TFile) || file.extension !== "md") {
			throw new Error(`未找到 Markdown 文档：${articlePath}`);
		}
		if (file.stat.size > MAX_MARKDOWN_BYTES) {
			throw new Error(`Markdown 文档超过阅读器安全上限（64 MiB）：${articlePath}`);
		}
		return buildMarkdownReaderPackage(await this.app.vault.cachedRead(file), articlePath);
	}
}
