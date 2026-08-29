import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const explicitOutput = outputIndex >= 0 ? String(args[outputIndex + 1] || "").trim() : "";
if (outputIndex >= 0 && !explicitOutput) {
	throw new Error("--output requires an explicit empty or disposable Vault path.");
}

const vaultRoot = explicitOutput
	? path.resolve(explicitOutput)
	: fs.mkdtempSync(path.join(os.tmpdir(), "research-agent-reader-test-vault-"));
const pluginInstallRoot = path.join(vaultRoot, ".obsidian", "plugins", "research-agent-reader");

function writeUtf8(relativePath, content) {
	const target = path.join(vaultRoot, ...relativePath.split("/"));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf8");
}

for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
	const source = path.join(pluginRoot, artifact);
	if (!fs.existsSync(source)) {
		throw new Error(`Missing ${artifact}. Run pnpm build before preparing a test Vault.`);
	}
	fs.mkdirSync(pluginInstallRoot, { recursive: true });
	fs.copyFileSync(source, path.join(pluginInstallRoot, artifact));
}

writeUtf8(".obsidian/community-plugins.json", `${JSON.stringify(["research-agent-reader"], null, 2)}\n`);
writeUtf8(".obsidian/app.json", `${JSON.stringify({ showUnsupportedFiles: true }, null, 2)}\n`);
writeUtf8("README - Research Agent Reader QA.md", `# Research Agent Reader clean-Vault QA

This disposable Vault was generated from the standalone repository. It contains no Research Vault Toolkit, Python configuration, Agent CLI configuration, or private paper data.

## Manual smoke flow

1. Open this folder as a Vault in Obsidian Desktop.
2. Enable community plugins, then enable **Research Agent Reader**.
3. Open \`Clippings/Web Clipper sample.md\`; it should open in the research reader automatically.
4. Confirm that the left pane contains body text without the image or caption.
5. Confirm that the right pane shows the image, inferred label \`Fig. 1\`, and its caption.
6. Open \`papers/Plain Markdown paper.md\`; it should also use the reader.
7. Select a sentence in the reading pane: a floating 批注 chip should appear next to the selection (the pane header also has a 批注 button). Open it, type a short note, and save — this works without any AI backend. Confirm the source text gains an annotation link and \`wiki/annotations/\` contains the note. Wiki notes support the same flow in both editing (Live Preview) and reading mode; a custom hotkey (e.g. Shift+S) can be bound to the 批注所选文字 command under Settings → Hotkeys.
8. Run **Knowledge base health check**; it should work without Python or a toolkit path.
9. Open Research Agent Reader settings. Core features should be described as available and the optional toolkit as unconfigured.
10. Try an advanced AI action. It should show an actionable missing-toolkit message without breaking the reader.

Do not use this generated Vault for real notes.
`);
writeUtf8("Clippings/Web Clipper sample.md", `---
title: "Web Clipper sample"
source: "https://example.com/research-paper"
---
# Web Clipper sample

This paragraph remains in the left reading pane.

![](assets/figure.png)

Genes looped to metastasis-specific enhancers are associated with disease progression. This caption intentionally has no figure number so the reader must infer Fig. 1.

The article body continues after the figure caption.
`);
writeUtf8("papers/Plain Markdown paper.md", `---
title: "Plain Markdown paper"
---
# Plain Markdown paper

The configured papers folder also opens ordinary Markdown in the two-pane reader.

This fixture intentionally contains no cross-root links.
`);
writeUtf8("wiki/index.md", `---
type: moc
---
# Test knowledge index

This page exists so the built-in health check has an authored Wiki scope.
`);
const tinyPng = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAZB7rLkAAAAASUVORK5CYII=",
	"base64",
);
const imagePath = path.join(vaultRoot, "Clippings", "assets", "figure.png");
fs.mkdirSync(path.dirname(imagePath), { recursive: true });
fs.writeFileSync(imagePath, tinyPng);

const requiredFiles = [
	".obsidian/plugins/research-agent-reader/main.js",
	".obsidian/plugins/research-agent-reader/manifest.json",
	".obsidian/plugins/research-agent-reader/styles.css",
	"Clippings/Web Clipper sample.md",
	"papers/Plain Markdown paper.md",
	"wiki/index.md",
];
for (const relativePath of requiredFiles) {
	if (!fs.existsSync(path.join(vaultRoot, ...relativePath.split("/")))) {
		throw new Error(`Test Vault is incomplete: ${relativePath}`);
	}
}

process.stdout.write(`${JSON.stringify({
	vaultRoot,
	pluginInstallRoot,
	requiredFiles,
	launchedObsidian: false,
}, null, 2)}\n`);
