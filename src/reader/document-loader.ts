import { App, TFile, normalizePath } from "obsidian";

import { MineruPackageLoader } from "../mineru/package-loader";
import type { MineruReaderPackage } from "../mineru/types";
import { buildMarkdownReaderPackage } from "./clipping-markdown";
import { FileSourceStorage } from "../sources/storage";
import { loadJatsDocument } from "./jats-document";
import { adaptReaderDocument } from "./document";

const MAX_MARKDOWN_BYTES = 64 * 1024 * 1024;

export class ReaderDocumentLoader {
	private readonly mineruLoader: MineruPackageLoader;

	constructor(private readonly app: App) {
		this.mineruLoader = new MineruPackageLoader(app);
	}

	async load(rawArticlePath: string): Promise<MineruReaderPackage> {
		const articlePath = normalizePath(rawArticlePath.trim());
		const sourceRoot=/^(papers\/[^/]+)\//i.exec(articlePath)?.[1];
		if(sourceRoot&&await this.app.vault.adapter.exists(sourceRoot+"/_source",true)){
			if(!/--jats--/.test(sourceRoot)||articlePath!==sourceRoot+"/article.md")throw new Error("PDF 原文包尚无 Markdown 投影，或结构化包入口无效");
			const adapter=this.app.vault.adapter as typeof this.app.vault.adapter&{getBasePath?():string};if(!adapter.getBasePath)throw new Error("JATS 读取需要桌面文件系统");return loadJatsDocument(new FileSourceStorage(adapter.getBasePath()),sourceRoot.split("/")[1]);
		}
		if (/^papers\/[^/]+\/article\.md$/i.test(articlePath)) {
			return adaptReaderDocument(await this.mineruLoader.load(articlePath));
		}
		const file = this.app.vault.getAbstractFileByPath(articlePath);
		if (!(file instanceof TFile) || file.extension !== "md") {
			throw new Error(`未找到 Markdown 文档：${articlePath}`);
		}
		if (file.stat.size > MAX_MARKDOWN_BYTES) {
			throw new Error(`Markdown 文档超过阅读器安全上限（64 MiB）：${articlePath}`);
		}
		return adaptReaderDocument(buildMarkdownReaderPackage(await this.app.vault.cachedRead(file), articlePath));
	}
}
