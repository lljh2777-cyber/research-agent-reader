import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "node_modules"]);
const textExtensions = new Set([
	".css",
	".js",
	".json",
	".md",
	".mjs",
	".ts",
	".txt",
	".yaml",
	".yml",
]);
const extensionlessTextFiles = new Set([".editorconfig", ".gitattributes", ".gitignore", "LICENSE"]);

function visit(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const absolutePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			visit(absolutePath);
			continue;
		}
		if (!entry.isFile() || entry.name === "main.js") continue;
		if (!textExtensions.has(path.extname(entry.name)) && !extensionlessTextFiles.has(entry.name)) continue;
		const source = fs.readFileSync(absolutePath, "utf8");
		const normalized = `${source
			.replace(/\r\n?/g, "\n")
			.replace(/[\t ]+$/gm, "")
			.replace(/\n*$/, "")}\n`;
		if (normalized !== source) fs.writeFileSync(absolutePath, normalized, "utf8");
	}
}

visit(root);
