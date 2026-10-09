/** Keep ordinary-Markdown figure discovery and reader projection on one token grammar. */
export function markdownImagePattern(): RegExp {
	return /!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
}

export function isStandaloneImageToken(markdown: string, start: number, end: number): boolean {
	const lineStart = markdown.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const newline = markdown.indexOf("\n", end);
	const lineEnd = newline < 0 ? markdown.length : newline;
	return !markdown.slice(lineStart, start).trim() && !markdown.slice(end, lineEnd).trim();
}
