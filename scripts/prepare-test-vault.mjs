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
3. Open \`Clippings/Web Clipper sample.md\`; it should remain a normal Markdown tab. Use its file context menu or More options → 选择阅读方式… → 正文＋图片与图注 to open the research reader explicitly.
4. Confirm that the left pane contains body text without the image or caption.
5. Confirm that the right pane shows the image, inferred label \`Fig. 1\`, and its caption.
6. Open \`papers/Plain Markdown paper.md\`; it should also remain a normal tab until you explicitly choose a reading mode.
7. Select a sentence in the reading pane: a floating 批注 chip should appear next to the selection (the pane header also has a 批注 button). Open it, type a short note, and save without an AI backend. Confirm \`wiki/annotations/\` contains the note and the original Markdown remains unchanged. Regular Wiki editing keeps its existing inline annotation behavior; a hotkey can be assigned to 批注所选文字.
8. Run **Knowledge base health check**; it should work without Python or a toolkit path.
9. Open Research Agent Reader settings. Core features should be described as available and the optional toolkit as unconfigured.
10. Try an advanced AI action. It should show an actionable missing-toolkit message without breaking the reader.
11. Right-click \`Manual/English sample.md\` → 选择阅读方式… → current file as English, then choose \`Manual/中文样本.md\`. Confirm one tab contains English on the left and Chinese on the right, each with file name, annotation and one-shot sync controls. The pair has no translation metadata: synchronization must say reading progress, and Chinese AI contrast must stop before any provider call.
12. Toggle linked scrolling, resize the divider, save independent excerpts and reload the plugin. Confirm both selected paths and saved state return; canceling a file replacement must retain the pair. Add a local PDF if you also want to exercise Markdown＋PDF; this generated fixture does not include one.

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

Ordinary Markdown can be opened explicitly in the reader, without configuring a folder.

This fixture intentionally contains no cross-root links.
`);
writeUtf8("Manual/English sample.md", `# Manual reading sample

A manual reading pair keeps both source files unchanged.

Matching reading progress does not verify scientific conclusions or translation accuracy.
`);
writeUtf8("Manual/中文样本.md", `# 手动阅读样本

手动配对阅读保持两份来源文件不变。

相同阅读进度不代表科学结论或翻译准确性已经核验。
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
	"Manual/English sample.md",
	"Manual/中文样本.md",
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
