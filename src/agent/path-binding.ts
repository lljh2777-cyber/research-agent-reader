import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Canonical real filesystem path for containment comparisons: symlinks
 * resolved, separators/case folded on case-insensitive platforms only.
 * Returns "" when the path cannot be resolved.
 */
export function canonicalRealPath(value: string): string {
	try {
		const resolved = fs.realpathSync.native(path.resolve(value));
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	} catch {
		return "";
	}
}

/** True when both paths resolve to the same real directory. */
export function isSameRealPath(a: string, b: string): boolean {
	const left = canonicalRealPath(a);
	const right = canonicalRealPath(b);
	return Boolean(left) && left === right;
}
