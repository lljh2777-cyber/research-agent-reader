import { splitFilePath } from "./manual-split";

export type ReadingFileNode = { kind: "file"; path: string; name: string } | { kind: "folder"; path: string; name: string; children: ReadingFileNode[] };
export type ReadingLanguage = "en" | "zh-CN";

export function readingFileTree(paths: string[], extension: "md" | "pdf", exclude: string, query = ""): ReadingFileNode[] {
	const roots: ReadingFileNode[] = [], folders = new Map<string, Extract<ReadingFileNode, { kind: "folder" }>>();
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	for (const path of new Set(paths)) {
		if (path === exclude || !splitFilePath(path, extension) || !terms.every(term => path.toLocaleLowerCase().includes(term))) continue;
		const parts = path.split("/"); let children = roots;
		for (let i = 0; i < parts.length - 1; i++) {
			const folderPath = parts.slice(0, i + 1).join("/");
			let folder = folders.get(folderPath);
			if (!folder) { folder = { kind: "folder", path: folderPath, name: parts[i], children: [] }; folders.set(folderPath, folder); children.push(folder); }
			children = folder.children;
		}
		children.push({ kind: "file", path, name: parts[parts.length - 1] });
	}
	const sort = (nodes: ReadingFileNode[]): void => {
		nodes.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path));
		for (const node of nodes) if (node.kind === "folder") sort(node.children);
	};
	sort(roots); return roots;
}

export function readingFolderAncestors(path: string): string[] {
	const parts = path.split("/"); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

// Filename hints only prefill the visible role control; they never establish translation evidence.
export function readingLanguageHint(path: string): ReadingLanguage | undefined {
	const name = path.split("/").pop()!.replace(/\.md$/i, "");
	const chinese = /(?:^|[. _-])zh(?:-cn|-hans)?(?:$|[. _-])|中文|译文/i.test(name);
	const english = /(?:^|[. _-])en(?:-us|-gb)?(?:$|[. _-])|english|英文/i.test(name);
	return chinese === english ? undefined : chinese ? "zh-CN" : "en";
}

export function bilingualFileOrder(current: string, second: string, currentLanguage: ReadingLanguage): { left: string; right: string } {
	if (!splitFilePath(current, "md") || !splitFilePath(second, "md") || current === second || !["en", "zh-CN"].includes(currentLanguage)) throw new Error("请确认两份不同的 Markdown 文件及当前文件语言");
	return currentLanguage === "en" ? { left: current, right: second } : { left: second, right: current };
}
