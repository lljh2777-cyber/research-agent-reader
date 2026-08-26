import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const json = (relativePath) => JSON.parse(read(relativePath));
const manifest = json("manifest.json");
const pkg = json("package.json");
const versions = json("versions.json");
const failures = [];
const pass = [];

function check(condition, message) {
	(condition ? pass : failures).push(message);
}

check(/^[a-z0-9-]+$/.test(manifest.id), "Manifest ID uses community-safe characters");
check(!manifest.id.includes("obsidian"), "Manifest ID does not contain the reserved word obsidian");
check(/^\d+\.\d+\.\d+$/.test(manifest.version), "Manifest version is strict SemVer x.y.z");
check(manifest.version === pkg.version, "package.json and manifest.json versions match");
check(versions[manifest.version] === manifest.minAppVersion, "versions.json contains the current compatibility entry");
check(manifest.isDesktopOnly === true, "Desktop-only boundary is declared for Node.js process access");
check(String(manifest.description || "").length <= 250, "Manifest description is at most 250 characters");
check(String(manifest.description || "").endsWith("."), "Manifest description ends with a period");
check(Boolean(manifest.author) && Boolean(manifest.authorUrl), "Author and author URL are present");
check(manifest.id === "research-agent-reader", "Manifest uses the confirmed permanent plugin ID");
check(manifest.name === "Research Agent Reader", "Manifest uses the confirmed public display name");

for (const relativePath of ["README.md", "LICENSE", "SECURITY.md", "manifest.json", "versions.json", "main.js", "styles.css"]) {
	check(fs.existsSync(path.join(root, relativePath)), `${relativePath} exists`);
}

const readme = read("README.md");
check(/no client-side telemetry/i.test(readme), "README discloses the telemetry policy");
check(/outside the vault/i.test(readme), "README discloses access outside the Vault");
check(/upload a selected document/i.test(readme), "README discloses optional remote document upload");
check(/does not download, install, or update/i.test(readme), "README discloses the optional dependency boundary");

const sourceFiles = execFileSync("git", [
	"ls-files",
	"--cached",
	"--others",
	"--exclude-standard",
	"--",
	"src",
	"scripts",
	"README.md",
	"docs",
], {
	cwd: root,
	encoding: "utf8",
}).split(/\r?\n/).filter(Boolean);
const sourceText = sourceFiles
	.filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
	.map((relativePath) => read(relativePath))
	.join("\n");
const privateMarkers = ["Thomas" + " Wade", "THOMAS" + "~1", "paper-" + "knowledge-base"];
check(!privateMarkers.some((marker) => sourceText.toLowerCase().includes(marker.toLowerCase())), "Public sources contain no private workspace identity or path");
check(!/shell\s*:\s*true/.test(sourceText), "Process launches do not enable shell mode");
check(!/child_process[^\n]*\.exec\s*\(/.test(sourceText), "Public sources do not use string-based child_process.exec");

const tracked = execFileSync("git", ["ls-files", "main.js", "data.json"], {
	cwd: root,
	encoding: "utf8",
}).trim();
check(!tracked, "Generated main.js and private data.json are not tracked");

for (const message of pass) process.stdout.write(`PASS  ${message}\n`);
if (failures.length) {
	for (const message of failures) process.stderr.write(`FAIL  ${message}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`PUBLIC_RELEASE_AUDIT_OK (${pass.length} checks)\n`);
}
