const MAX_RECONCILE_ENTRIES = 10_000;
const MAX_RECONCILE_DEPTH = 16;

interface ListedVaultTree {
	files: string[];
	folders: string[];
}

export interface ReconcileCapableVaultAdapter {
	list(path: string): Promise<ListedVaultTree>;
	/**
	 * Desktop FileSystemAdapter hook used internally after its own writes.
	 * It is intentionally feature-detected and isolated in this module because
	 * Obsidian does not expose a public external-filesystem refresh API.
	 */
	reconcileInternalFile?(path: string): void | Promise<void>;
}

export interface VaultTreeReconcileResult {
	supported: boolean;
	reconciledEntries: number;
	articleIndexed: boolean;
}

function normalizePackageRoot(rawPath: string): string {
	const value = String(rawPath || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!/^papers\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) {
		throw new Error(`拒绝刷新非标准原文包目录：${rawPath}`);
	}
	return value;
}

function normalizeListedPath(rawPath: string, packageRoot: string): string {
	const value = String(rawPath || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const segments = value.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`Vault 刷新清单包含无效路径：${rawPath}`);
	}
	if (value !== packageRoot && !value.startsWith(`${packageRoot}/`)) {
		throw new Error(`Vault 刷新清单越出原文包：${rawPath}`);
	}
	if (segments.length - packageRoot.split("/").length > MAX_RECONCILE_DEPTH) {
		throw new Error(`Vault 刷新清单深度超过 ${MAX_RECONCILE_DEPTH}`);
	}
	return value;
}

/**
 * Reconcile a package created through an atomic native directory rename with
 * Obsidian's in-memory Vault index. Native bytes remain untouched.
 */
export async function reconcilePublishedVaultTree(
	adapter: ReconcileCapableVaultAdapter,
	rawPackageRoot: string,
	articleIndexed: () => boolean,
): Promise<VaultTreeReconcileResult> {
	const packageRoot = normalizePackageRoot(rawPackageRoot);
	const reconcile = adapter.reconcileInternalFile;
	if (typeof reconcile !== "function") {
		return { supported: false, reconciledEntries: 0, articleIndexed: articleIndexed() };
	}

	const folders = [packageRoot];
	const files: string[] = [];
	const seenFolders = new Set(folders);
	const seenFiles = new Set<string>();
	for (let cursor = 0; cursor < folders.length; cursor += 1) {
		const listed = await adapter.list(folders[cursor]);
		for (const rawFolder of listed.folders || []) {
			const folder = normalizeListedPath(rawFolder, packageRoot);
			if (seenFolders.has(folder)) continue;
			seenFolders.add(folder);
			folders.push(folder);
		}
		for (const rawFile of listed.files || []) {
			const file = normalizeListedPath(rawFile, packageRoot);
			if (seenFiles.has(file)) continue;
			seenFiles.add(file);
			files.push(file);
		}
		if (seenFolders.size + seenFiles.size > MAX_RECONCILE_ENTRIES) {
			throw new Error(`Vault 刷新清单条目超过 ${MAX_RECONCILE_ENTRIES}`);
		}
	}

	const orderedFolders = folders.sort((left, right) => {
		const depth = left.split("/").length - right.split("/").length;
		return depth || left.localeCompare(right);
	});
	const orderedFiles = files.sort((left, right) => left.localeCompare(right));
	for (const entry of [...orderedFolders, ...orderedFiles]) {
		await Promise.resolve(reconcile.call(adapter, entry));
	}
	for (let attempt = 0; attempt < 20 && !articleIndexed(); attempt += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	return {
		supported: true,
		reconciledEntries: orderedFolders.length + orderedFiles.length,
		articleIndexed: articleIndexed(),
	};
}
