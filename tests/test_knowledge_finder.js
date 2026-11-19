"use strict";
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");

async function main() {
	const directory = { async scan() { throw new Error("offline"); } };
	const { KnowledgeFinder } = loadReading("views/knowledge-finder.ts", {
		obsidian: { ItemView: class {}, Modal: class {}, PluginSettingTab: class {} },
		"../annotations/annotation-service": {},
		"../library/clipper": { clipperDirectory: () => directory },
	});
	const view = new KnowledgeFinder({}, {
		getReadingWorkspace: () => ({ ready: async () => {}, repository: { sessions: new Map() } }),
	});
	const file = { path: "wiki/linux/awk.md", basename: "awk" };
	view.app = { vault: { getMarkdownFiles: () => [file], cachedRead: async () => "awk extracts columns" } };
	const warnings = [];
	const hits = await view.find("awk", new AbortController().signal, warnings);
	assert.deepEqual(hits.map(hit => hit.path), [file.path]);
	assert.match(warnings.join(" "), /offline/);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(view.find("awk", cancelled.signal), { name: "AbortError" });
	console.log("OK offline paper directory preserves vault hits and respects cancellation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
