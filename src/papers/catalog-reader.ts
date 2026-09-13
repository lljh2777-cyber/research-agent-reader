import { decodePackageManifest, type SourcePackageManifest } from "../sources/package";
import type { SourceStorage } from "../sources/storage";

export interface SourceInventoryEntry { path: string; manifest?: SourcePackageManifest; error?: string; }
export interface SourceInventory { packages: SourceInventoryEntry[]; legacyArticles: string[]; }
/** Manifest inventory only. No association decisions, identity allocation, mkdir or repair. */
export async function inspectSourcePackages(storage: Pick<SourceStorage, "read" | "list">): Promise<SourceInventory> {
	const packages: SourceInventoryEntry[] = [], legacyArticles: string[] = [];
	for (const entry of await storage.list("papers")) {
		if (!entry.directory || entry.name === "_translations" || entry.name.startsWith(".")) continue;
		const root = "papers/" + entry.name;
		try {
			const children = await storage.list(root);
			if (!children.some(child => child.name === "_source")) {
				if (children.some(child => child.name === "article.md" && !child.directory)) legacyArticles.push(root + "/article.md");
				continue;
			}
			const bytes = await storage.read(root + "/_source/manifest.json");
			if (!bytes) throw new Error("原文包尚未提交清单");
			const manifest = decodePackageManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
			if (manifest.packageKey !== entry.name) throw new Error("原文包目录与清单不一致");
			packages.push({ path: root, manifest });
		} catch (error) { packages.push({ path: root, error: error instanceof Error ? error.message : "原文包读取失败" }); }
	}
	return { packages, legacyArticles };
}
