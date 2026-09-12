import * as fs from "node:fs";
import * as path from "node:path";

/** Electron's executable may route -e to the app CLI even with ELECTRON_RUN_AS_NODE. */
export function resolveNodeExecutable(runtime = {
	execPath: process.execPath,
	electron: Boolean(process.versions.electron),
	searchPath: process.env.PATH || process.env.Path || "",
}): string {
	const name = process.platform === "win32" ? "node.exe" : "node";
	const candidates = !runtime.electron && /^node(?:\.exe)?$/i.test(path.basename(runtime.execPath)) ? [runtime.execPath] : [];
	for (const directory of runtime.searchPath.split(path.delimiter)) {
		const clean = directory.trim().replace(/^"(.*)"$/, "$1");
		// An empty/relative PATH entry must never select a program from the Vault.
		if (path.isAbsolute(clean)) candidates.push(path.join(clean, name));
	}
	for (const candidate of new Set(candidates)) {
		try {
			const resolved = fs.realpathSync(candidate);
			if (fs.statSync(resolved).isFile()) return resolved;
		} catch { /* Keep looking through configured absolute PATH entries. */ }
	}
	throw new Error("创建笔记需要可用的 Node.js，请将 Node.js 加入系统 PATH 后重启 Obsidian；原文已保留");
}
