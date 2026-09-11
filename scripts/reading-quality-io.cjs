"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const inside = (file, root) => { const rel = path.relative(root, file); return !rel || rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel); };
function privateTarget(target, protectedRoots = []) {
	const resolved = path.resolve(target), parent = fs.realpathSync(path.dirname(resolved));
	const canonical = path.join(parent, path.basename(resolved));
	if ([ROOT, ...protectedRoots].some(root => inside(canonical, fs.realpathSync(root)))) throw new Error("Output must be outside repository, sources and input plan");
	for (let directory = parent; ; directory = path.dirname(directory)) {
		if (fs.existsSync(path.join(directory, ".obsidian"))) throw new Error("Output must be outside Obsidian Vaults");
		if (path.dirname(directory) === directory) break;
	}
	return canonical;
}
function readFile(root, relative, limit = 16 * 1024 * 1024) {
	const parts = relative.split("/");
	if (parts.some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(p) || p.includes(".."))) throw new Error("Invalid record path");
	let file = fs.realpathSync(root);
	for (const part of parts) { file = path.join(file, part); if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Record links are not supported"); }
	const handle = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(handle); if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error("Record size invalid");
		const data = Buffer.alloc(stat.size + 1); let count = 0;
		while (count < data.length) { const n = fs.readSync(handle, data, count, data.length - count, null); if (!n) break; count += n; }
		if (count !== stat.size) throw new Error("Record changed during read"); return data.subarray(0, count);
	} finally { fs.closeSync(handle); }
}
function save(root, name, value, raw = false) {
	const data = raw ? value : JSON.stringify(value, null, 2) + "\n";
	fs.writeFileSync(path.join(root, name), data, { flag: "wx", encoding: "utf8", mode: 0o600 });
	return sha(data);
}
module.exports = { ROOT, sha, inside, privateTarget, readFile, save };
