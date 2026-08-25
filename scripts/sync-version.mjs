import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const writeJson = (name, value) => {
	fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, "\t")}\n`, "utf8");
};

const pkg = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
manifest.version = pkg.version;
versions[pkg.version] = manifest.minAppVersion;
writeJson("manifest.json", manifest);
writeJson("versions.json", versions);
