"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
Module._load = function loadWithObsidianStub(request, parent, isMain) {
	if (request === "obsidian") {
		class Base {}
		return {
			Component: Base,
			FileSystemAdapter: Base,
			ItemView: Base,
			MarkdownRenderer: { render: async () => {} },
			Menu: class {
				addItem() { return this; }
				showAtMouseEvent() {}
			},
			Modal: Base,
			Notice: class {},
			Plugin: Base,
			PluginSettingTab: Base,
			SecretComponent: Base,
			Setting: Base,
			TFile: Base,
			normalizePath: (value) => value,
			requestUrl: async () => ({ status: 200, text: "", json: null, headers: {} }),
			setIcon: () => {},
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const pluginRoot = path.resolve(__dirname, "..");
const AgentDashboardPlugin = require(path.join(pluginRoot, "main.js"));
Module._load = originalLoad;

const source = (relativePath) => fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
const pluginSource = source("src/plugin.ts");
const serviceSource = source("src/annotations/annotation-service.ts");
const popoverSource = source("src/annotations/annotation-popover.ts");
const settingsSource = source("src/settings/settings-tab.ts");
const runtimeSettingsSource = source("src/runtime/settings.ts");
const actionsSource = source("src/actions.ts");
const styles = source("styles.css");

assert.match(actionsSource, /id:\s*"annotation-explain"/);
assert.match(actionsSource, /showInRail:\s*false/);
assert.match(pluginSource, /id:\s*"annotate-selected-text"/);
assert.doesNotMatch(pluginSource, /hotkeys:\s*\[/);
assert.match(pluginSource, /event\.ctrlKey\s*\|\|\s*event\.metaKey/);
assert.match(pluginSource, /event\.shiftKey/);
assert.match(pluginSource, /"mouseover"/);
assert.match(
	pluginSource,
	/a\.internal-link\[data-href\^="wiki\/annotations\/"\]\[data-href\*="#\^ann-"\]/,
);
assert.match(serviceSource, /wiki\/annotations/);
assert.match(serviceSource, /#\^\$\{record\.id\}/);
assert.match(serviceSource, /isTableCell:\s*block\.matches\("td, th"\)/);
assert.ok(
	serviceSource.includes('selection.isTableCell ? "\\\\|" : "|"'),
	"table-cell annotations should escape the wikilink alias separator",
);
assert.match(serviceSource, /settings\.annotationBackendId/);
assert.match(serviceSource, /settings\.annotationMaxTokens/);
assert.match(serviceSource, /settings\.annotationCodexModel/);
assert.match(serviceSource, /settings\.annotationCodexReasoningEffort/);
assert.match(serviceSource, /settings\.annotationCodexServiceTier/);
assert.match(serviceSource, /settings\.annotationClaudeModel/);
assert.match(serviceSource, /settings\.annotationClaudeReasoningEffort/);
assert.match(serviceSource, /settings\.annotationWebSearchEnabled/);
assert.match(serviceSource, /settings\.annotationWebSearchTimeoutSeconds/);
assert.match(serviceSource, /最多围绕 2 个检索问题/);
assert.match(serviceSource, /executionConfig\.retrievalMode\s*=\s*webSearchEnabled/);
assert.match(serviceSource, /const directProfile = webSearchEnabled \? null : selectedDirectProfile/);
assert.match(serviceSource, /resolveCliActionExecutionConfig/);
assert.match(serviceSource, /getCliBackendLabel/);
assert.match(settingsSource, /title:\s*"批注 AI"/);
assert.match(settingsSource, /renderAnnotationSettings/);
assert.match(settingsSource, /划选批注入口/);
assert.match(settingsSource, /打开快捷键设置/);
assert.match(settingsSource, /openTabById\?\.\("hotkeys"\)/);
assert.match(settingsSource, /浅层联网解释/);
assert.match(settingsSource, /联网时间上限/);
assert.match(settingsSource, /浅层（固定）/);
assert.match(settingsSource, /Direct API · \$\{profile\.name\}/);
assert.match(settingsSource, /Direct API 不联网，批注后端已切换为 Codex CLI/);
assert.match(settingsSource, /最大输出 Token/);
assert.match(runtimeSettingsSource, /annotationMaxTokens:\s*900/);
assert.match(runtimeSettingsSource, /annotationWebSearchEnabled:\s*false/);
assert.match(runtimeSettingsSource, /annotationWebSearchTimeoutSeconds:\s*30/);
assert.match(runtimeSettingsSource, /claudeConfigSource:\s*"official"/);
assert.match(runtimeSettingsSource, /codexConfigSource:\s*"official"/);
assert.match(pluginSource, /archiveStatus:\s*"pending"/);
assert.match(popoverSource, /保留并存档/);
assert.match(popoverSource, /手动批注/);
assert.match(popoverSource, /AI 解释/);
assert.match(popoverSource, /MarkdownRenderer\.render/);
assert.match(popoverSource, /cancel\.addEventListener\("click", \(\) => this\.renderChooser\(\)\)/);
assert.match(popoverSource, /data-agent-drag-handle/);
assert.match(popoverSource, /header\.addEventListener\("pointerdown"/);
assert.match(popoverSource, /document\.addEventListener\("pointermove"/);
assert.match(popoverSource, /private clampPosition/);
assert.match(popoverSource, /if \(this\.manualPosition\)/);
assert.doesNotMatch(popoverSource, /text:\s*"关闭"/);
assert.match(styles, /a\.internal-link\[data-href\^="wiki\/annotations\/"\]/);
assert.match(styles, /\.agent-annotation-header[\s\S]*cursor:\s*grab/);
assert.match(styles, /\.agent-annotation-popover\.is-dragging[\s\S]*cursor:\s*grabbing/);

// The reader keeps an always-visible header button; the floating selection
// chip lives at plugin level so it also covers wiki notes in Live Preview.
const readerSource = source("src/views/mineru-reader.ts");
assert.match(readerSource, /agent-dashboard-mineru-annotate-button/);
assert.match(readerSource, /openSelectionAnnotation/);
assert.doesNotMatch(readerSource, /setupAnnotationChip/);
assert.match(pluginSource, /\tasync openSelectionAnnotation\(\): Promise<void> \{/);
assert.doesNotMatch(pluginSource, /\tprivate async openSelectionAnnotation/);
assert.match(pluginSource, /showAnnotationChip/);
assert.match(pluginSource, /editorSelectionRect/);
assert.match(pluginSource, /\.markdown-source-view, \.markdown-reading-view/);
assert.match(serviceSource, /canCaptureEditorSelection/);
assert.match(serviceSource, /captureFromEditor/);
assert.match(serviceSource, /posToOffset/);
assert.match(serviceSource, /coordsAtPos/);
assert.match(serviceSource, /getActiveViewOfType\(MarkdownView\)/);
assert.match(styles, /\.agent-dashboard-mineru-annotate-chip \{[\s\S]*?position: fixed;/);
assert.match(styles, /\.agent-dashboard-mineru-annotate-button/);
assert.match(
	source("scripts/prepare-test-vault.mjs"),
	/a floating 批注 chip should appear next to the selection/,
);

const plugin = new AgentDashboardPlugin();
const targets = plugin.parseAnnotationArchiveTargets(
	'完成。\nANNOTATION_ARCHIVE_TARGETS: ["wiki/methods/hi-c", "knowledge-base/wiki/concepts/spatial-proximity.md"]',
);
assert.deepStrictEqual(targets, [
	"wiki/methods/hi-c",
	"wiki/concepts/spatial-proximity",
]);
assert.deepStrictEqual(
	plugin.parseAnnotationArchiveTargets(
		'ANNOTATION_ARCHIVE_TARGETS: ["wiki/sources/not-allowed", "../outside"]',
	),
	[],
);

console.log("DASHBOARD_ANNOTATIONS_TEST_OK");
